/** The native attachment button starts local preparation immediately, then streams to its exact source. */
import type { Context } from '@deepseek-ai/cordis'
import type { FileUploadValue, ImageUploadValue } from '@deepseek-ai/dsh-client-file-upload/types'
import type { WorkspaceUploadTransfer } from '../workspace/service-types.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
import { prepareSourceImageBlob } from './source-image-preparation.ts'
import { sourceFileAccess, type SourceFileClient } from './source-workspace-provider.ts'
import { sourceUploadIntent, registerSourceUploadCancellation } from './source-upload-intent.ts'

type Data = Blob | Uint8Array | ReadableStream<Uint8Array>
interface Intent { operationId: string; prepared?: Blob; transfer?: WorkspaceUploadTransfer }
const STREAM_LIMIT = 64 * 1024 * 1024
async function inputBlob(data: Data, type: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  if (data instanceof Blob) return data.type === type ? data : data.slice(0, data.size, type)
  if (data instanceof Uint8Array) return new Blob([new Uint8Array(data)], { type })
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0
  const reader = data.getReader(), abort = () => { void reader.cancel(signal?.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted(); const next = await reader.read(); if (next.done) break
      size += next.value.length
      if (size > STREAM_LIMIT) throw new Error('This file exceeds the source transfer limit. The original file is kept.')
      chunks.push(new Uint8Array(next.value))
    }
  } catch (error) { await reader.cancel(error); throw error }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock() }
  return new Blob(chunks, { type })
}
export function installRemoteFileUpload(ctx: Context, client: SourceFileClient,
  checkpoint?: (sessionId: string, data: object, signal: AbortSignal) => Promise<void>): () => void {
  const intents = new WeakMap<Data, Map<string, Intent>>()
  const upload = async (sessionId: string, data: Data, name: string, mediaType: string, image: boolean,
    signal?: AbortSignal, progress?: (value: { loaded: number; total?: number }) => void): Promise<FileUploadValue | ImageUploadValue> => {
    signal?.throwIfAborted()
    let stage = 'source-and-image-preparation'
    try {
      const saved = sourceUploadIntent(data, sessionId)
      // Decoding local bytes does not depend on a source address. Resolve the
      // authenticated owner alongside it; neither can admit an upload until both
      // have completed and the exact prepared-byte checkpoint has committed.
      const preparation = saved.prepared ? Promise.resolve(saved.prepared) : inputBlob(data, mediaType, signal)
        .then(async original => image ? (await prepareSourceImageBlob(original, signal)).blob : original)
        .catch(error => { stage = 'image-preparation'; throw error })
      const [source, prepared] = await Promise.all([client.resolve(sessionId, signal ?? new AbortController().signal)
        .catch(error => { stage = 'source-resolution'; throw error }), preparation])
      const services = source.services
      if (!services.uploads) throw new Error('File upload is not available on this source. Your draft and attachment are kept.')
      const access = sourceFileAccess(source.owner, signal ?? new AbortController().signal)
      const key = JSON.stringify([source.owner.scope, source.owner.binding, name, mediaType, image])
      let perFile = intents.get(data)
      if (!perFile) { perFile = new Map(); intents.set(data, perFile) }
      let intent = perFile.get(key)
      if (!intent || intent.operationId !== saved.operationId) { intent = { ...saved }; perFile.set(key, intent) }
      if (!intent.prepared) {
        intent.prepared = prepared
        saved.prepared = intent.prepared
      }
      if (saved.removed) throw new Error('This attachment was removed. Select it again to upload it.')
      // Persist the exact prepared bytes with their original composer operation
      // before admitting any source transfer. A refresh must not re-encode an
      // image after a durable prefix has already reached its source.
      stage = 'draft-checkpoint'
      await checkpoint?.(sessionId, data, signal ?? access.signal)
      if (saved.removed) throw new Error('This attachment was removed. Select it again to upload it.')
      signal?.throwIfAborted()
      const blob = intent.prepared
      stage = 'upload-begin'
      intent.transfer ??= await services.uploads.begin({ target: services.binding.target, operationId: intent.operationId,
        destination: { kind: 'attachment', name }, bytes: blob.size, mimeType: blob.type || mediaType }, access)
      const request = { target: services.binding.target, uploadId: intent.transfer.uploadId }
      registerSourceUploadCancellation(data, sessionId, saved, async () => {
        const current = await client.resolve(sessionId, new AbortController().signal)
        if (JSON.stringify(current.owner) !== JSON.stringify(source.owner)) return
        return current.services.uploads?.cancel({ target: current.services.binding.target, uploadId: request.uploadId },
          sourceFileAccess(current.owner, new AbortController().signal))
      })
      if (saved.removed) throw new Error('This attachment was removed. Its uncommitted source upload was cancelled.')
      signal?.throwIfAborted()
      stage = 'upload-status'
      const status = await services.uploads.status(request, access)
      let result
      if (status.state === 'cancelled') throw new Error('This upload was cancelled. Select the attachment again.')
      if (status.state === 'finished') result = status.result
      else {
        let offset = status.transfer.receivedBytes
        progress?.({ loaded: offset, total: blob.size })
        while (offset < blob.size) {
          signal?.throwIfAborted()
          const bytes = new Uint8Array(await blob.slice(offset, offset + status.transfer.chunkBytes).arrayBuffer())
          stage = 'upload-chunk'
          const next = await services.uploads.append({ ...request, offset, data: bytes }, access)
          offset = next.receivedBytes; progress?.({ loaded: offset, total: blob.size })
        }
        stage = 'upload-finish'
        result = await services.uploads.finish(request, access)
      }
      signal?.throwIfAborted()
      stage = 'upload-receipt'
      if (result.status !== 'applied') throw new Error(result.status === 'rejected' ? result.message
        : 'The source has not confirmed this attachment. Retry to check its original receipt; your draft is kept.')
      if (result.value.kind !== 'attachment') throw new Error('The source returned a different upload result.')
      if (image && !('image' in result.value.value)) throw new Error('The source did not return an image receipt.')
      if (!image && !('file' in result.value.value)) throw new Error('The source did not return a file receipt.')
      stage = 'completed-progress'
      progress?.({ loaded: blob.size, total: blob.size })
      return result.value.value
    } catch (error) {
      const label = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_/-]{0,79}$/.test(value) ? value : 'unknown'
      if (!signal?.aborted) ctx.logger?.warn('Source attachment upload failed at %s (%s/%s)', stage,
        label(error instanceof Error ? error.name : undefined),
        label(error && typeof error === 'object' && 'code' in error ? error.code : undefined))
      // Ending the input owner (refresh/Pane close) only stops this transport.
      // The explicit removal callback owns cancellation of uncommitted bytes.
      throw error
    }
  }
  return ctx.fileUpload.registerProvider!({
    matches: isSourceSessionId,
    async uploadImage(sessionId, data, mediaType, name = 'image', signal, onProgress) {
      const value = await upload(sessionId, data, name, mediaType, true, signal, onProgress)
      if (!('image' in value)) throw new Error('The source did not return an image receipt.')
      return { ok: true, value }
    },
    async upload(sessionId, data, name = 'attachment', signal, onProgress) {
      const value = await upload(sessionId, data, name, 'application/octet-stream', false, signal, onProgress)
      if (!('file' in value)) throw new Error('The source did not return a file receipt.')
      return { ok: true, value }
    },
  })
}
