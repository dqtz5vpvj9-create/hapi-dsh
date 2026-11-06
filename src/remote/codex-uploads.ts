import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
/** Session-scoped receipts for files stored by the original Codex filesystem. */
import { mkdir, readFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/types'
import type { CodexAccessBridge } from './codex-access-bridge.ts'
import type { SourceSession, SourceUploadRequest } from './protocol.ts'
import { SourceError } from './errors.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
interface Stored { sessionId: string; path: string; name: string; bytes: number; image?: boolean }
/** Classify supported raster containers without changing or recompressing uploaded bytes. */
function isRaster(data: Buffer): boolean {
  return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    || data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    || ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
}
export class CodexUploads {
  constructor(private readonly directory: string, private readonly native: CodexAccessBridge) {}
  async upload(session: SourceSession, request: SourceUploadRequest, signal?: AbortSignal): Promise<FileUploadValue> {
    if (!uuid.test(request.operationId) || request.data.length > 8 * 1024 * 1024 || Buffer.from(request.data, 'base64').toString('base64') !== request.data) throw new SourceError('INVALID_REQUEST', 'Invalid upload identity or file data.')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    return withFileLock(join(this.directory, request.operationId), async () => {
      let existing: Stored | undefined
      try { existing = JSON.parse(await readFile(join(this.directory, `${request.operationId}.json`), 'utf8')) as Stored }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (existing && existing.sessionId !== session.id) throw new SourceError('INVALID_REQUEST', 'The upload identity belongs to another source session.')
      return this.store(session, request, signal)
    }, { waitMs: 65_000 })
  }
  private async store(session: SourceSession, request: SourceUploadRequest, signal?: AbortSignal): Promise<FileUploadValue> {
    const path = /^[A-Za-z]:[\\/]|^\\\\/.test(session.cwd) ? win32 : posix
    if (!path.isAbsolute(session.cwd)) throw new SourceError('UNSUPPORTED', 'The source has no absolute working directory for uploads.')
    const name = (request.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'attachment')
    const directory = path.join(session.cwd, '.hhpi', 'uploads', request.operationId)
    const target = path.join(directory, `attachment-${name}`)
    for (const [suffix, method, params] of [
      ['directory', 'fs/createDirectory', { path: directory, recursive: true }],
      ['file', 'fs/writeFile', { path: target, dataBase64: request.data }],
    ] as const) {
      signal?.throwIfAborted()
      const result = await this.native.call({ sourceId: session.sourceId, operationId: `upload:${request.operationId}:${suffix}`, method, params }, false, signal)
      if (result.status !== 'accepted') throw new SourceError(result.status === 'indeterminate' ? 'OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE', result.message)
    }
    const stored: Stored = { sessionId: session.id, path: target, name, bytes: Buffer.from(request.data, 'base64').length, image: isRaster(Buffer.from(request.data, 'base64')) }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await writeFileAtomic(join(this.directory, `${request.operationId}.json`), JSON.stringify(stored), { mode: 0o600 })
    return { receiptId: request.operationId as FileUploadValue['receiptId'], file: { attachmentId: request.operationId as FileUploadValue['file']['attachmentId'], name, bytes: stored.bytes } }
  }
  async inputs(sessionId: string, receipts: readonly string[]): Promise<Array<{ type: 'text'; text: string; text_elements: never[] } | { type: 'localImage'; path: string }>> {
    return Promise.all(receipts.map(async receipt => {
      if (!uuid.test(receipt)) throw new SourceError('INVALID_REQUEST', 'Invalid file upload receipt.')
      let stored: Stored
      try { stored = JSON.parse(await readFile(join(this.directory, `${receipt}.json`), 'utf8')) as Stored }
      catch { throw new SourceError('INVALID_REQUEST', 'The file upload receipt is unavailable. Upload the file again.') }
      if (stored.sessionId !== sessionId || typeof stored.path !== 'string' || typeof stored.name !== 'string') throw new SourceError('INVALID_REQUEST', 'The file upload belongs to another source session.')
      if (stored.image) return { type: 'localImage' as const, path: stored.path }
      return { type: 'text' as const, text: `Attached file ${JSON.stringify(stored.name)}: ${JSON.stringify(stored.path)}`, text_elements: [] }
    }))
  }
}
