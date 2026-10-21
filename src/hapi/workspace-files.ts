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
import type { NativeWorkbench } from './workbench.ts'
import type {} from '../index.ts'
import { officialProviderConfig, officialProviderContext } from '../shared/official-provider.ts'

type Entry = NonNullable<WorkbenchResponse<'nativeFileInspect'>['entry']>
type Observation = { absolutePath: string; version: string } | { absolutePath: string; absent: true }

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
function fileStat(entry: Entry): WorkspaceFileStat {
  return { absolutePath: entry.path, version: entry.revision, bytes: entry.size }
}

/**
 * Public Cordis provider replacement: official lookup, Remote schemas and Client
 * provider are retained. Native session paths never enter the Host filesystem.
 * HAPI's read authority is deliberately preserved, including its 64 MiB transfer
 * cap and refusal to traverse symlinks below the source workspace.
 */
export class NativeAwareWorkspaceFiles extends TypertRemoteService {
  static inject = ['loader', 'hapi']
  static Config = WorkspaceFiles.Config
  private readonly pollIntervalMs: number

  constructor(ctx: Context, _config: Config, internals: { pollIntervalMs?: number } = {}) {
    super(ctx, 'workspaceFiles')
    this.pollIntervalMs = internals.pollIntervalMs ?? 2000
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
      if (entry.size > MAX_DOCUMENT_BYTES) throw tooLarge(path, MAX_DOCUMENT_BYTES)
      const bytes = await this.reader.readSourceFile(source, entry.path, signal, MAX_DOCUMENT_BYTES)
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
        const paths = pathsFor(base.path)
        resolved = paths.resolve(paths.dirname(base.path), relative)
      }
      const offset = options.range === undefined ? 0 : integer(options.range.offset ?? 0, 0, 'offset')
      const length = options.range === undefined ? undefined : integer(options.range.length ?? this.limits.maxBytes, 1, 'length')
      if (length !== undefined && !Number.isSafeInteger(offset + length)) throw new RemoteError('gateway/bad-request', 'offset plus length must stay a safe integer', {})
      if (length !== undefined && length > this.limits.maxBytes) throw tooLarge(path, this.limits.maxBytes)
      const entry = await this.nativeFile(source, scope, resolved, signal)
      const limit = length === undefined ? Math.min(this.limits.maxFileBytes, MAX_DOCUMENT_BYTES) : MAX_DOCUMENT_BYTES
      if (entry.size > limit) throw tooLarge(path, limit)
      if (offset >= entry.size) return { ...fileStat(entry), offset, data: new Uint8Array(), eof: true }
      // The original HAPI download route does not implement byte ranges. Read
      // its bounded binary body once, then return the requested official window.
      const bytes = await this.reader.readSourceFile(source, entry.path, signal, limit)
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

  private async nativeFile(source: WorkbenchSource, scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<Entry> {
    signal.throwIfAborted()
    const entry = requireSuccess(await this.reader.nativeFileInspect({ source, path: requestedPath(scope, path) }, signal), path)
    if (entry.type !== 'file') throw new RemoteError('workspace-file/not-regular-file', 'The source path is not a regular file', { path, kind: entry.type })
    return entry
  }

  private async observation(source: WorkbenchSource, scope: WorkspaceFileScope, path: string, signal: AbortSignal, previous?: Observation): Promise<Observation> {
    const absolutePath = requestedPath(scope, path, true)
    // Direct listings avoid recursively scanning whole source repositories for
    // each tree watch. File revisions remain the source's opaque CAS revision.
    const directory = await this.reader.nativeDirectory({ source, path: absolutePath }, signal)
    if (directory.success) {
      const children = [...directory.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      const version = createHash('sha256').update(JSON.stringify(children)).digest('hex')
      return { absolutePath, version: `hapi-directory:${version}` }
    }
    const inspected = await this.reader.nativeFileInspect({ source, path: absolutePath }, signal)
    if (!inspected.success && inspected.code === 'not-found') return { absolutePath: previous?.absolutePath ?? absolutePath, absent: true }
    const entry = requireSuccess(inspected, path)
    if (entry.type === 'symlink') throw new RemoteError('workspace-file/watch-unsupported', 'The source does not follow symbolic links', { path })
    if (entry.type === 'directory') throw new HapiRequestError(directory.error || 'The source directory could not be watched', 'rejected')
    return { absolutePath: entry.path, version: entry.revision }
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
          yield { kind: 'change', change: next }
        }
      }
    } catch (error) {
      if (signal.aborted) return
      sourceFailure(error)
    }
  }
}

export default NativeAwareWorkspaceFiles
