/** Route the official attachment button to the selected source Session. */
import type { Context } from '@deepseek-ai/cordis'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
import { prepareSourceImages } from './source-image-preparation.ts'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'

const MAX_BYTES = 6 * 1024 * 1024
export function installRemoteFileUpload(ctx: Context, api: HhpiRemoteApi): () => void {
  const register = ctx.fileUpload.registerProvider
  if (!register || !api.upload) return () => {}
  return ctx.fileUpload.registerProvider!({
    matches: isSourceSessionId,
    async uploadImage(sessionId, data, mediaType, name = 'image', signal, onProgress) {
      signal?.throwIfAborted()
      // This promise owns preprocessing and upload; native DSH owns when it starts.
      const [image] = await prepareSourceImages([{ mediaType, data: bytesToBase64(new Uint8Array(await data.arrayBuffer())) }], signal)
      signal?.throwIfAborted()
      const bytes = Uint8Array.from(atob(image!.data), char => char.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: image!.mediaType }))
      const { width, height } = bitmap
      bitmap.close()
      signal?.throwIfAborted()
      const uploaded = await api.upload!({ sessionId, operationId: crypto.randomUUID(), name, data: image!.data }, signal)
      signal?.throwIfAborted()
      if (!uploaded.ok) return uploaded
      onProgress?.({ loaded: bytes.length, total: bytes.length })
      return { ok: true, value: { receiptId: uploaded.value.receiptId, image: {
        attachmentId: uploaded.value.file.attachmentId, mediaType: image!.mediaType, bytes: bytes.length,
        width, height, name: uploaded.value.file.name,
      } } }
    },
    async upload(sessionId, data, name = 'attachment', signal, onProgress) {
      signal?.throwIfAborted()
      const chunks: Uint8Array[] = []
      let size = 0
      const append = (chunk: Uint8Array) => {
        size += chunk.byteLength
        if (size > MAX_BYTES) throw new Error('File exceeds the 6 MiB native upload limit. Your draft is retained.')
        chunks.push(chunk); onProgress?.({ loaded: size })
      }
      if (data instanceof Uint8Array) append(data)
      else if (data instanceof Blob) {
        if (data.size > MAX_BYTES) throw new Error('File exceeds the 6 MiB native upload limit. Your draft is retained.')
        append(new Uint8Array(await data.arrayBuffer()))
      } else {
        const reader = data.getReader()
        const abort = () => { void reader.cancel(signal?.reason) }
        signal?.addEventListener('abort', abort, { once: true })
        try { while (true) { signal?.throwIfAborted(); const next = await reader.read(); if (next.done) break; append(next.value) } }
        catch (error) { await reader.cancel(error); throw error }
        finally { signal?.removeEventListener('abort', abort); reader.releaseLock() }
      }
      signal?.throwIfAborted()
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const result = await api.upload!({ sessionId, operationId: crypto.randomUUID(), name, data: bytesToBase64(bytes) }, signal)
      signal?.throwIfAborted()
      return result
    },
  })
}
