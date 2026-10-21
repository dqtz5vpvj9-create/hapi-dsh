/** Source routing for the unchanged official file resource and document plugins. */
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceFiles, type Config, type WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type {
  WorkspaceByteReadOptions, WorkspaceDirectoryListing, WorkspaceFileBytes, WorkspaceFileRange,
  WorkspaceFileStat, WorkspaceFileText, WorkspaceFileWatchFrame,
} from '@deepseek-ai/dsh-api-workspace-files/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { HapiRequestError } from '../codex/contracts.ts'
import { MAX_DOCUMENT_BYTES, type WorkbenchSource, type WorkbenchResponse } from '../workbench-types.ts'
import type { NativeWorkbench, SourceDocumentRead } from './workbench.ts'
import type {} from '../index.ts'
import { officialProviderConfig, officialProviderContext } from '../shared/official-provider.ts'

type Entry = NonNullable<WorkbenchResponse<'nativeFileInspect'>['entry']>
type Observation = { absolutePath: string; version: string; fingerprint?: string } | { absolutePath: string; absent: true }

/** Only path arithmetic occurs on the Host. Every filesystem operation belongs to the source Runner. */
function pathsFor(root: string): typeof posix {
  if (posix.isAbsolute(root)) return posix
  if (win32.isAbsolute(root)) return win32
  throw new RemoteError('gateway/bad-request', 'The source workspace must have an absolute path', {})
}
function requestedPath(scope: WorkspaceFileScope, path: string, confine = false): string {
  if (!path || path.length > 8192 || path.includes('\0')) throw new RemoteError('gateway/bad-request', 'A valid workspace path is required', {})
  const paths = pathsFor(scope.workspaceRoot)
  const absolute = paths.resolve(scope.workspaceRoot, path)
  const relative = paths.relative(scope.workspaceRoot, absolute)
  if (confine && (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))) {
    throw new RemoteError('workspace-file/outside-workspace', 'This directory is outside the source workspace', { path })
  }
  return absolute
}
function integer(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RemoteError('gateway/bad-request', `${name} must be a safe integer of at least ${minimum}`, {})
  return value
}
function tooLarge(path: string, limit: number): RemoteError<'workspace-file/too-large'> {
  return new RemoteError('workspace-file/too-large', `The source read exceeds its ${limit} byte limit`, { path, limit })
}
function sourceFailure(error: unknown): never {
  if (error instanceof HapiRequestError) throw new RemoteError('hapi/request', error.message, {
    outcome: error.outcome, ...(error.status === undefined ? {} : { status: error.status }), ...(error.code === undefined ? {} : { sourceCode: error.code }),
  })
  throw error
}
function requireSuccess(result: WorkbenchResponse<'nativeFileInspect'>, path: string): Entry {
  if (!result.success || !result.entry) {
    if (result.code === 'not-found') throw new RemoteError('workspace-file/not-found', 'The source path no longer exists', { path })
    throw new HapiRequestError(result.error || 'The source could not inspect this path', 'rejected', undefined, result.code ?? 'source_unavailable')
  }
  return result.entry
}
function fileStat(entry: SourceDocumentRead): WorkspaceFileStat {
  return { absolutePath: entry.absolutePath, version: entry.version, bytes: entry.data.byteLength }
}

/**
 * Public Cordis provider replacement: official lookup, Remote schemas and Client
 * provider are retained. Native session paths never enter the Host filesystem.
 * HAPI's read authority is deliberately preserved, including its 64 MiB transfer
 * cap. Document reads follow its machine browse-root policy; directory and
 * mutation operations retain their separate session-workspace restrictions.
 */
export class NativeAwareWorkspaceFiles extends TypertRemoteService {
  static inject = ['loader', 'hapi']
  static Config = WorkspaceFiles.Config
  private readonly pollIntervalMs: number
  private readonly documents = new Map<string, { expiresAt: number; document: SourceDocumentRead }>()
  private documentBytes = 0

  constructor(ctx: Context, _config: Config, internals: { pollIntervalMs?: number } = {}) {
    super(ctx, 'workspaceFiles')
    this.pollIntervalMs = internals.pollIntervalMs ?? 2000
    ctx.effect(() => () => { this.documents.clear(); this.documentBytes = 0 })
  }

  private get ordinary(): WorkspaceFiles {
    const original = officialProviderContext(this.ctx, 'workspace-files').get('workspaceFiles')
    if (!original) throw new Error('The official WorkspaceFiles delegate is not active')
    return original
  }
  private get limits(): Config { return WorkspaceFiles.Config(officialProviderConfig(this.ctx, 'workspace-files') as Config) }

  @Remote
  async read(scope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal): Promise<WorkspaceFileText> {
    const source = this.ctx.hapi.workbenchSource(scope.sessionId)
    if (source === undefined) return this.ordinary.read(scope, path, range, signal)
    try {
      const offset = integer(range.offset ?? 1, 1, 'offset')
      const limit = integer(range.limit ?? this.limits.maxLines, 1, 'limit')
      if (limit > this.limits.maxLines || !Number.isSafeInteger(offset + limit)) throw new RemoteError('gateway/bad-request', 'The requested line window exceeds the configured bounds', {})
      const entry = await this.nativeFile(source, scope, path, signal)
      const bytes = entry.data
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { throw new RemoteError('workspace-file/not-text', 'The source file is not UTF-8 text', { path }) }
      const all = text === '' ? [] : text.split('\n')
      if (text.endsWith('\n')) all.pop()
      const lines = all.slice(offset - 1, offset - 1 + limit)
      const page = lines.join('\n')
      if (page.includes('\0')) throw new RemoteError('workspace-file/not-text', 'The source file contains NUL bytes', { path })
      if (Buffer.byteLength(page, 'utf8') > this.limits.maxBytes) throw tooLarge(path, this.limits.maxBytes)
      return { ...fileStat(entry), offset, text: page, lines: lines.length, eof: offset - 1 + lines.length >= all.length }
    } catch (error) { return sourceFailure(error) }
  }

  @Remote
  async readBytes(scope: WorkspaceFileScope, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal): Promise<WorkspaceFileBytes> {
    const source = this.ctx.hapi.workbenchSource(scope.sessionId)
    if (source === undefined) return this.ordinary.readBytes(scope, path, options, signal)
    try {
      let resolved = path
      if (options.baseFile !== undefined) {
        const relative = path.replace(/\\/g, '/')
        if (!relative || relative.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(relative) || relative.includes('\0')) {
          throw new RemoteError('gateway/bad-request', 'path must be relative when baseFile is provided', {})
        }
        const base = await this.nativeFile(source, scope, options.baseFile, signal)
        const paths = pathsFor(base.absolutePath)
        resolved = paths.resolve(paths.dirname(base.absolutePath), relative)
      }
      const offset = options.range === undefined ? 0 : integer(options.range.offset ?? 0, 0, 'offset')
      const length = options.range === undefined ? undefined : integer(options.range.length ?? this.limits.maxBytes, 1, 'length')
      if (length !== undefined && !Number.isSafeInteger(offset + length)) throw new RemoteError('gateway/bad-request', 'offset plus length must stay a safe integer', {})
      if (length !== undefined && length > this.limits.maxBytes) throw tooLarge(path, this.limits.maxBytes)
      const limit = length === undefined ? Math.min(this.limits.maxFileBytes, MAX_DOCUMENT_BYTES) : MAX_DOCUMENT_BYTES
      const entry = await this.nativeFile(source, scope, resolved, signal, false, limit)
      if (offset >= entry.data.byteLength) return { ...fileStat(entry), offset, data: new Uint8Array(), eof: true }
      // The original HAPI document read does not implement byte ranges. Decode
      // its bounded response once, then return the requested official window.
      const bytes = entry.data
      const data = length === undefined ? bytes : bytes.slice(offset, offset + length)
      return { ...fileStat(entry), offset, data, eof: offset + data.byteLength >= bytes.byteLength }
    } catch (error) { return sourceFailure(error) }
  }

  @Remote
  async stat(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat> {
    const source = this.ctx.hapi.workbenchSource(scope.sessionId)
    if (source === undefined) return this.ordinary.stat(scope, path, signal)
    try { return fileStat(await this.nativeFile(source, scope, path, signal)) }
    catch (error) { return sourceFailure(error) }
  }

  @Remote
  async list(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> {
    const source = this.ctx.hapi.workbenchSource(scope.sessionId)
    if (source === undefined) return this.ordinary.list(scope, path, signal)
    try {
      const absolute = requestedPath(scope, path, true)
      const result = await this.reader.nativeDirectory({ source, path: absolute }, signal)
      if (!result.success) {
        const entry = requireSuccess(await this.reader.nativeFileInspect({ source, path: absolute }, signal), path)
        if (entry.type !== 'directory') throw new RemoteError('workspace-file/not-directory', 'The source path is not a directory', { path, kind: entry.type })
        throw new HapiRequestError(result.error || 'The source directory could not be listed', 'rejected')
      }
      const children = [...result.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      return {
        path: pathsFor(scope.workspaceRoot).relative(scope.workspaceRoot, absolute).replace(/\\/g, '/'),
        entries: children.slice(0, this.limits.maxEntries).map(entry => ({ name: entry.name, type: entry.type,
          ...(entry.type === 'file' && entry.size !== undefined ? { size: entry.size } : {}) })),
        truncated: children.length > this.limits.maxEntries,
      }
    } catch (error) { return sourceFailure(error) }
  }

  @Remote({ mode: 'stream' })
  changes(scope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    const source = this.ctx.hapi.workbenchSource(scope.sessionId)
    if (source === undefined) return this.ordinary.changes(scope, path, signal)
    return this.sourceChanges(source, scope, path, signal)
  }

  private get reader(): NativeWorkbench { return this.ctx.hapi.nativeWorkbench }

  private documentKey(source: WorkbenchSource, path: string): string { return JSON.stringify([source.sourceHubId, source.sourceSessionId, source.machineId, path]) }

  private forgetDocument(key: string): void {
    const old = this.documents.get(key)
    if (old) this.documentBytes -= old.document.data.byteLength
    this.documents.delete(key)
  }

  private async nativeFile(source: WorkbenchSource, scope: WorkspaceFileScope, path: string, signal: AbortSignal, fresh = false, maxBytes = MAX_DOCUMENT_BYTES): Promise<SourceDocumentRead> {
    signal.throwIfAborted()
    // The source owner is checked even on a short-lived byte-cache hit. Cache
    // only small completed reads, so stat + readBytes do not duplicate a JSON
    // transfer while large PDF reads cannot retain unbounded Host memory.
    await this.reader.resolveSource(source, undefined, { allowInactive: true })
    signal.throwIfAborted()
    const absolute = requestedPath(scope, path)
    const key = this.documentKey(source, absolute)
    const cached = this.documents.get(key)
    if (!fresh && cached && cached.expiresAt > Date.now()) {
      if (cached.document.data.byteLength > maxBytes) throw tooLarge(path, maxBytes)
      return cached.document
    }
    this.forgetDocument(key)
    const info = await this.reader.sourceDocumentInfo(source, absolute, signal)
    if (!info) throw new RemoteError('workspace-file/not-found', 'The source path no longer exists', { path })
    if (info.size > maxBytes) throw tooLarge(path, maxBytes)
    const entry = await this.reader.readSourceDocument(source, absolute, signal, maxBytes)
    const budget = 16 * 1024 * 1024
    if (entry.data.byteLength <= budget) {
      this.forgetDocument(key)
      while (this.documents.size && (this.documents.size >= 8 || this.documentBytes + entry.data.byteLength > budget)) this.forgetDocument(this.documents.keys().next().value!)
      this.documents.set(key, { expiresAt: Date.now() + 1000, document: entry })
      this.documentBytes += entry.data.byteLength
    }
    return entry
  }

  private async observation(source: WorkbenchSource, scope: WorkspaceFileScope, path: string, signal: AbortSignal, previous?: Observation): Promise<Observation> {
    const absolutePath = requestedPath(scope, path)
    // Direct listings avoid recursively scanning whole source repositories for
    // each tree watch. File revisions remain the source's opaque CAS revision.
    const session = await this.reader.resolveSource(source, undefined, { allowInactive: true })
    let directory: WorkbenchResponse<'nativeDirectory'> | undefined
    try { requestedPath(scope, path, true); if (session.active) directory = await this.reader.nativeDirectory({ source, path: absolutePath }, signal) }
    catch (error) { if (!(error instanceof RemoteError && error.code === 'workspace-file/outside-workspace')) throw error }
    if (directory?.success) {
      const children = [...directory.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      const version = createHash('sha256').update(JSON.stringify(children)).digest('hex')
      return { absolutePath, version: `hapi-directory:${version}` }
    }
    const info = await this.reader.sourceDocumentInfo(source, absolutePath, signal)
    if (!info) { this.forgetDocument(this.documentKey(source, absolutePath)); return { absolutePath: previous?.absolutePath ?? absolutePath, absent: true } }
    const fingerprint = info.modified === undefined ? undefined : JSON.stringify([info.size, info.modified])
    if (fingerprint !== undefined && previous && 'version' in previous && previous.fingerprint === fingerprint) return previous
    const entry = await this.nativeFile(source, scope, path, signal, true)
    return { absolutePath: entry.absolutePath, version: entry.version, ...(fingerprint === undefined ? {} : { fingerprint }) }
  }

  private async *sourceChanges(source: WorkbenchSource, scope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    try {
      let current = await this.observation(source, scope, path, signal)
      signal.throwIfAborted()
      yield { kind: 'ready' }
      while (!signal.aborted) {
        await delay(this.pollIntervalMs, undefined, { signal })
        const next = await this.observation(source, scope, path, signal, current)
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          current = next
          const { fingerprint: _fingerprint, ...change } = 'version' in next ? next : { ...next, fingerprint: undefined }
          yield { kind: 'change', change }
        }
      }
    } catch (error) {
      if (signal.aborted) return
      sourceFailure(error)
    }
  }
}

export default NativeAwareWorkspaceFiles
