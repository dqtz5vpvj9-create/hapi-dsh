/** Prepare oversized source images entirely on the submitting device before durable admission. */
import type { SourceOperation } from '../remote/protocol.ts'
import { SOURCE_IMAGE_BASE64_LIMIT, SOURCE_INPUT_IMAGE_LIMITS } from '../shared/source-image-limits.ts'

type Image = NonNullable<SourceOperation['images']>[number]
export type SourceImageEncoder = (image: Image, base64Budget: number, signal?: AbortSignal) => Promise<Image>

/** Keep small originals; distribute the existing wire budget across larger images. */
export async function prepareSourceImages(images: readonly Image[], signal?: AbortSignal, encode: SourceImageEncoder = encodeOnDevice): Promise<Image[]> {
  signal?.throwIfAborted()
  if (images.reduce((size, image) => size + image.data.length, 0) <= SOURCE_IMAGE_BASE64_LIMIT) return [...images]
  const budgets: number[] = []
  let remaining = SOURCE_IMAGE_BASE64_LIMIT
  const sorted = images.map((image, index) => ({ image, index })).sort((a, b) => a.image.data.length - b.image.data.length)
  for (const [rank, { image, index }] of sorted.entries()) {
    const budget = Math.min(image.data.length, Math.floor(remaining / (sorted.length - rank) / 4) * 4)
    budgets[index] = budget; remaining -= budget
  }
  const prepared: Image[] = []
  for (const [index, image] of images.entries()) {
    signal?.throwIfAborted()
    const budget = budgets[index]!
    prepared.push(image.data.length <= budget ? image : await encode(image, budget, signal))
  }
  signal?.throwIfAborted()
  return prepared
}

async function encodeOnDevice(image: Image, budget: number, signal?: AbortSignal): Promise<Image> {
  const bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mediaType }))
  try {
    signal?.throwIfAborted()
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not prepare the image. Your draft and attachments have been kept.')
    const scale = Math.min(1, SOURCE_INPUT_IMAGE_LIMITS.maxImageDimension / Math.max(bitmap.width, bitmap.height), Math.sqrt(SOURCE_INPUT_IMAGE_LIMITS.maxImagePixels / (bitmap.width * bitmap.height)))
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale)); canvas.height = Math.max(1, Math.floor(bitmap.height * scale))
    const render = () => { context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height) }
    const encode = (type: string, quality?: number): Promise<Blob> => new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be prepared on this device. Your draft and attachments have been kept.')), type, quality)
    })
    render()
    // Lossless first: screenshots often shrink without changing a single visible pixel.
    let blob = await encode('image/png')
    if (4 * Math.ceil(blob.size / 3) > budget) {
      for (;;) {
        signal?.throwIfAborted()
        blob = await encode('image/webp', 0.92)
        if (4 * Math.ceil(blob.size / 3) <= budget) break
        // Reduce dimensions rather than repeatedly discarding text detail through lower quality.
        const ratio = Math.min(0.85, Math.sqrt((budget / 4 * 3) / blob.size) * 0.92)
        if (canvas.width === 1 && canvas.height === 1) throw new Error('The image could not be prepared. Your draft and attachments have been kept.')
        canvas.width = Math.max(1, Math.floor(canvas.width * ratio)); canvas.height = Math.max(1, Math.floor(canvas.height * ratio)); render()
      }
    }
    signal?.throwIfAborted()
    return await new Promise<Image>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ mediaType: blob.type as Image['mediaType'], data: String(reader.result).split(',', 2)[1]! })
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } finally { bitmap.close() }
}
