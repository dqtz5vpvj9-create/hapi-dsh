/** Decode and prepare source images on the submitting device, before any upload begins. */
import type { SourceOperation } from '../remote/protocol.ts'
import { SOURCE_IMAGE_BASE64_LIMIT, SOURCE_INPUT_IMAGE_LIMITS } from '../shared/source-image-limits.ts'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'

type Image = NonNullable<SourceOperation['images']>[number]
export type SourceImageEncoder = (image: Image, base64Budget: number, signal?: AbortSignal) => Promise<Image>

/** Legacy inline images retain the HHPI v1 aggregate budget; every image is inspected. */
export async function prepareSourceImages(images: readonly Image[], signal?: AbortSignal, encode: SourceImageEncoder = encodeOnDevice): Promise<Image[]> {
  signal?.throwIfAborted()
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
    prepared.push(await encode(image, budgets[index]!, signal))
  }
  signal?.throwIfAborted()
  return prepared
}
export interface PreparedSourceImage { blob: Blob; width: number; height: number; mediaType: Image['mediaType'] }
/** Only our explicitly sRGB canvas output is eligible. Original file profiles
 * are never stripped. WebP without ICCP is sRGB; keep its image/alpha chunks.
 * https://developers.google.com/speed/webp/docs/riff_container */
async function canvasSrgbWebp(blob: Blob): Promise<Blob> {
  if (blob.type !== 'image/webp') return blob
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) return blob
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let header: Uint8Array<ArrayBuffer> | undefined, profiles = 0, images = 0
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return blob
    const kind = tag(offset), size = view.getUint32(offset + 4, true), end = offset + 8 + size + (size & 1)
    if (end > bytes.length || !['VP8X', 'ICCP', 'ALPH', 'VP8 ', 'VP8L'].includes(kind)) return blob
    if (kind === 'VP8X') {
      if (header || offset !== 12 || size !== 10 || bytes[offset + 8]! & ~0x30
        || bytes[offset + 9] || bytes[offset + 10] || bytes[offset + 11]) return blob
      header = bytes.slice(offset, end); chunks.push(header)
    } else if (kind === 'ICCP') {
      if (++profiles !== 1) return blob
    } else {
      if (kind === 'VP8 ' || kind === 'VP8L') images++
      chunks.push(bytes.slice(offset, end))
    }
    offset = end
  }
  if (!header || profiles !== 1 || !(header[8]! & 0x20) || images !== 1) return blob
  header[8] = header[8]! & ~0x20
  const riff = bytes.slice(0, 12), length = 12 + chunks.reduce((size, chunk) => size + chunk.length, 0)
  new DataView(riff.buffer).setUint32(4, length - 8, true)
  return new Blob([riff, ...chunks], { type: 'image/webp' })
}
/** Binary attachment uploads do not make a base64 copy of the selected file. */
export async function prepareSourceImageBlob(input: Blob, signal?: AbortSignal, byteBudget = 2 * 1024 * 1024): Promise<PreparedSourceImage> {
  signal?.throwIfAborted()
  const bitmap = await createImageBitmap(input)
  try {
    signal?.throwIfAborted()
    const scale = Math.min(1, SOURCE_INPUT_IMAGE_LIMITS.maxImageDimension / Math.max(bitmap.width, bitmap.height), Math.sqrt(SOURCE_INPUT_IMAGE_LIMITS.maxImagePixels / (bitmap.width * bitmap.height)))
    if (scale === 1 && input.size <= byteBudget && SOURCE_INPUT_IMAGE_LIMITS.mediaTypes.includes(input.type as Image['mediaType'])) {
      return { blob: input, width: bitmap.width, height: bitmap.height, mediaType: input.type as Image['mediaType'] }
    }
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { colorSpace: 'srgb' })
    if (!context) throw new Error('This browser could not prepare the image. Your original attachment has been kept.')
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale)); canvas.height = Math.max(1, Math.floor(bitmap.height * scale))
    const render = () => { context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height) }
    const encode = (type: string, quality?: number): Promise<Blob> => new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be prepared on this device. Your original attachment has been kept.')), type, quality)
    })
    render()
    // Oversized originals need preparation even when a lossless PNG happens to
    // fit the ceiling. Prefer the existing high-quality WebP encoder directly:
    // keeping all pixels must not require several times the network bytes.
    const compact = input.size > byteBudget
    let blob = await encode(compact ? 'image/webp' : 'image/png', compact ? 0.92 : undefined)
    if (blob.size > byteBudget && !compact) blob = await encode('image/webp', 0.92)
    while (blob.size > byteBudget) {
      signal?.throwIfAborted()
      const ratio = Math.min(0.85, Math.sqrt(byteBudget / blob.size) * 0.92)
      if (canvas.width === 1 && canvas.height === 1) throw new Error('The image could not be prepared. Your original attachment has been kept.')
      canvas.width = Math.max(1, Math.floor(canvas.width * ratio)); canvas.height = Math.max(1, Math.floor(canvas.height * ratio)); render()
      blob = await encode('image/webp', 0.92)
    }
    blob = await canvasSrgbWebp(blob)
    signal?.throwIfAborted()
    return { blob, width: canvas.width, height: canvas.height, mediaType: blob.type as Image['mediaType'] }
  } finally { bitmap.close() }
}
async function encodeOnDevice(image: Image, budget: number, signal?: AbortSignal): Promise<Image> {
  const bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0)), original = new Blob([bytes], { type: image.mediaType })
  const prepared = await prepareSourceImageBlob(original, signal, Math.floor(budget / 4) * 3)
  if (prepared.blob === original) return image
  const data = bytesToBase64(new Uint8Array(await prepared.blob.arrayBuffer()))
  signal?.throwIfAborted()
  return { mediaType: prepared.mediaType, data }
}
