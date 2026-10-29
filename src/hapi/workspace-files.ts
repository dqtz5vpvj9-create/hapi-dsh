import { legacyWorkbenchSource } from '../shared/source-access.ts'
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
/** A source root is the Runner's own working directory, never a serving-Host path. */
type SourceRoot = { readonly root: string; readonly paths: typeof posix }
type FileInfo = { size: number; modified?: number }

/**
 * Public Cordis provider replacement: official lookup, Remote schemas and Client
 * provider are retained. Native session paths never enter the Host filesystem.
 * Read authority is HAPI's own split: document reads follow the Runner's
 * machine browse-root policy (including inactive chats and authorized files
 * outside the chat cwd), directory listings and mutations keep their separate
 * session-workspace restrictions, and an impossible document read may fall
 * back only to HAPI's artifact route, which authorizes one session's uploads.
 */

/** Only path arithmetic occurs on the Host. Every filesystem operation belongs to the source Runner. */
function pathsFor(root: string): typeof posix {
  if (posix.isAbsolute(root)) return posix
  if (win32.isAbsolute(root)) return win32
  throw new RemoteError('gateway/bad-request', 'The source workspace must have an absolute path', {})
}
function assertPath(path: string): void {
  if (!path || path.length > 8192 || path.includes('\0')) throw new RemoteError('gateway/bad-request', 'A valid workspace path is required', {})
}
/** Whether `absolute` is the root itself or one of its descendants, by path arithmetic only. */
function contained(paths: typeof posix, root: string, absolute: string): boolean {
  const relative = paths.relative(root, absolute)
  return relative === '' || relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
}
/**
 * The official Client Scope carries the retained Session header's cwd. The
 * Runner's verified working directory is the authority for path arithmetic;
 * the header may still hold the path a display generation was created with
 * (for example an empty path before the source metadata arrived, or a path the
 * source has since replaced). A path under the stale header root is rebased
 * onto the verified root, so the Runner receives an absolute path inside its
 * own working directory instead of one it must reject as outside it.
 */
function sourceRootFor(cwd: string): SourceRoot {
  const paths = pathsFor(cwd)
  const root = paths.resolve(cwd)
  const relative = paths.relative(cwd, root)
  if (relative !== '') throw new RemoteError('gateway/bad-request', 'The source workspace must be a normalized absolute path', {})
  return { root, paths }
}
function declaredRootOf(source: SourceRoot, workspaceRoot: string): string | undefined {
  let paths: typeof posix
  try { paths = pathsFor(workspaceRoot) } catch { return undefined }
  if (paths !== source.paths) return undefined
  const declared = paths.resolve(workspaceRoot)
  return declared === source.root ? undefined : declared
}
/**
 * Resolve an authored path for the source Runner.
 *
 * Workspace-relative paths are resolved against the verified source cwd.
 * Absolute paths inside it are passed through; absolute paths under the stale
 * declared root are rebased onto the verified root. `confine` keeps directory
 * listings and observations workspace-scoped, exactly like the official
 * service. Unconfined outside paths are returned as-is for the Runner's own
 * document/artifact authority to decide; they are never resolved against the
 * Hub filesystem.
 */
function resolveSourcePath(source: SourceRoot, declared: string | undefined, path: string, confine = false): string {
  assertPath(path)
  const { paths } = source
  const lexical = paths.isAbsolute(path) ? paths.resolve(path) : paths.resolve(source.root, path)
  if (contained(paths, source.root, lexical)) return lexical
  if (paths.isAbsolute(path) && declared !== undefined && contained(paths, declared, lexical)) {
    return paths.join(source.root, paths.relative(declared, lexical))
  }
  if (confine) throw new RemoteError('workspace-file/outside-workspace', 'This directory is outside the source workspace', { path })
  return lexical
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
function textPage(path: string, entry: SourceDocumentRead, offset: number, limit: number, maxBytes: number): WorkspaceFileText {
  const bytes = entry.data
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new RemoteError('workspace-file/not-text', 'The source file is not UTF-8 text', { path }) }
  const all = text === '' ? [] : text.split('\n')
  if (text.endsWith('\n')) all.pop()
  const lines = all.slice(offset - 1, offset - 1 + limit)
  const page = lines.join('\n')
  if (page.includes('\0')) throw new RemoteError('workspace-file/not-text', 'The source file contains NUL bytes', { path })
  if (Buffer.byteLength(page, 'utf8') > maxBytes) throw tooLarge(path, maxBytes)
  return { ...fileStat(entry), offset, text: page, lines: lines.length, eof: offset - 1 + lines.length >= all.length }
}

/**
 * Public Cordis provider replacement: document reads use HAPI's original read
 * endpoint, so the owning Runner enforces its browse roots and inactive chats
 * stay readable. Directory listings and mutations remain session-confined. The
 * serving Hub filesystem is never consulted for a source session.
 */
export class NativeAwareWorkspaceFiles extends TypertRemoteService {
  static inject = ['loader']
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
    const source = legacyWorkbenchSource(this.ctx, scope.sessionId)
    if (source === undefined) return this.ordinary.read(scope, path, range, signal)
    try {
      const offset = integer(range.offset ?? 1, 1, 'offset')
      const limit = integer(range.limit ?? this.limits.maxLines, 1, 'limit')
      if (limit > this.limits.maxLines || !Number.isSafeInteger(offset + limit)) throw new RemoteError('gateway/bad-request', 'The requested line window exceeds the configured bounds', {})
      const entry = await this.documentRead(source, scope, path, signal)
      return textPage(path, entry, offset, limit, this.limits.maxBytes)
    } catch (error) { return sourceFailure(error) }
  }

  @Remote
  async readBytes(scope: WorkspaceFileScope, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal): Promise<WorkspaceFileBytes> {
    const source = legacyWorkbenchSource(this.ctx, scope.sessionId)
    if (source === undefined) return this.ordinary.readBytes(scope, path, options, signal)
    try {
      let resolved = path
      if (options.baseFile !== undefined) {
        const relative = path.replace(/\\/g, '/')
        if (!relative || relative.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(relative) || relative.includes('\0')) {
          throw new RemoteError('gateway/bad-request', 'path must be relative when baseFile is provided', {})
        }
        const base = await this.documentRead(source, scope, options.baseFile, signal)
        const paths = pathsFor(base.absolutePath)
        resolved = paths.resolve(paths.dirname(base.absolutePath), relative)
      }
      const offset = options.range === undefined ? 0 : integer(options.range.offset ?? 0, 0, 'offset')
      const length = options.range === undefined ? undefined : integer(options.range.length ?? this.limits.maxBytes, 1, 'length')
      if (length !== undefined && !Number.isSafeInteger(offset + length)) throw new RemoteError('gateway/bad-request', 'offset plus length must stay a safe integer', {})
      if (length !== undefined && length > this.limits.maxBytes) throw tooLarge(path, this.limits.maxBytes)
      const limit = length === undefined ? Math.min(this.limits.maxFileBytes, MAX_DOCUMENT_BYTES) : MAX_DOCUMENT_BYTES
      const entry = await this.documentRead(source, scope, resolved, signal, { maxBytes: limit })
      if (offset >= entry.data.byteLength) return { ...fileStat(entry), offset, data: new Uint8Array(), eof: true }
      // The original HAPI document read does not implement byte ranges. Decode
      // its bounded response once, then return the requested official window.
      const data = length === undefined ? entry.data : entry.data.slice(offset, offset + length)
      return { ...fileStat(entry), offset, data, eof: offset + data.byteLength >= entry.data.byteLength }
    } catch (error) { return sourceFailure(error) }
  }

  @Remote
  async stat(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat> {
    const source = legacyWorkbenchSource(this.ctx, scope.sessionId)
    if (source === undefined) return this.ordinary.stat(scope, path, signal)
    try { return fileStat(await this.documentRead(source, scope, path, signal)) }
    catch (error) { return sourceFailure(error) }
  }

  @Remote
  async list(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> {
    const source = legacyWorkbenchSource(this.ctx, scope.sessionId)
    if (source === undefined) return this.ordinary.list(scope, path, signal)
    try {
      // Workspace confinement is decided before any Runner management call, so
      // an outside listing stays an explicit outside error for an inactive chat
      // too; the directory service itself still requires the chat to be active.
      const root = await this.sourceRoot(source, true)
      const absolute = resolveSourcePath(root, declaredRootOf(root, scope.workspaceRoot), path, true)
      const result = await this.reader.nativeDirectory({ source, path: absolute }, signal)
      if (!result.success) {
        const entry = requireSuccess(await this.reader.nativeFileInspect({ source, path: absolute }, signal), path)
        if (entry.type !== 'directory') throw new RemoteError('workspace-file/not-directory', 'The source path is not a directory', { path, kind: entry.type })
        throw new HapiRequestError(result.error || 'The source directory could not be listed', 'rejected')
      }
      const children = [...result.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      return {
        path: root.paths.relative(root.root, absolute).replace(/\\/g, '/'),
        entries: children.slice(0, this.limits.maxEntries).map(entry => ({ name: entry.name, type: entry.type,
          ...(entry.type === 'file' && entry.size !== undefined ? { size: entry.size } : {}) })),
        truncated: children.length > this.limits.maxEntries,
      }
    } catch (error) { return sourceFailure(error) }
  }

  @Remote({ mode: 'stream' })
  changes(scope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    const source = legacyWorkbenchSource(this.ctx, scope.sessionId)
    if (source === undefined) return this.ordinary.changes(scope, path, signal)
    return this.sourceChanges(source, scope, path, signal)
  }

  private get reader(): NativeWorkbench { return this.ctx.hapi.nativeWorkbench }

  /** The verified source Session; document reads also work while its chat is inactive. */
  private async sourceSession(source: WorkbenchSource, allowInactive = false) {
    return this.reader.resolveSource(source, undefined, allowInactive ? { allowInactive: true } : {})
  }
  private async sourceRoot(source: WorkbenchSource, allowInactive = false): Promise<SourceRoot> {
    const session = await this.sourceSession(source, allowInactive)
    const cwd = session.metadata?.path
    if (!cwd) throw new HapiRequestError('The source session has no verified working directory', 'rejected', 409, 'source_unavailable')
    return sourceRootFor(cwd)
  }

  private documentKey(source: WorkbenchSource, path: string): string { return JSON.stringify([source.sourceHubId, source.sourceSessionId, source.machineId, path]) }

  private forgetDocument(key: string): void {
    const old = this.documents.get(key)
    if (old) this.documentBytes -= old.document.data.byteLength
    this.documents.delete(key)
  }

  private rememberDocument(key: string, document: SourceDocumentRead): void {
    // Cache only small completed reads: stat + readBytes then do not duplicate
    // a JSON transfer, while a large PDF read cannot retain Host memory.
    const budget = 16 * 1024 * 1024
    if (document.data.byteLength > budget) return
    this.forgetDocument(key)
    while (this.documents.size && (this.documents.size >= 8 || this.documentBytes + document.data.byteLength > budget)) {
      this.forgetDocument(this.documents.keys().next().value!)
    }
    this.documents.set(key, { expiresAt: Date.now() + 1000, document })
    this.documentBytes += document.data.byteLength
  }

  /** One source upload through HAPI's original artifact authority, never the Hub filesystem. */
  private async artifactDocument(source: WorkbenchSource, absolutePath: string, signal: AbortSignal, maxBytes: number): Promise<SourceDocumentRead> {
    const bytes = await this.reader.readSourceArtifactBytes(source, absolutePath, signal, maxBytes)
    if (bytes.byteLength > maxBytes) throw tooLarge(absolutePath, maxBytes)
    return { absolutePath, version: createHash('sha256').update(bytes).digest('hex'), data: bytes, writable: false }
  }

  /**
   * Read one source document with HAPI's own read authority.
   *
   * The path is resolved against the verified Runner cwd first. The document
   * read then follows the Runner's machine browse-root policy, which also
   * authors files outside the chat cwd and inactive chats. When that authority
   * denies an outside path, the only other original authority is HAPI's
   * `session-file:` artifact route (a session's own uploads); the Runner still
   * decides there, and a management denial is never retried through a
   * different owner.
   */
  private async documentRead(source: WorkbenchSource, scope: WorkspaceFileScope, path: string, signal: AbortSignal,
    options: { fresh?: boolean; maxBytes?: number } = {}): Promise<SourceDocumentRead> {
    const { fresh = false, maxBytes = MAX_DOCUMENT_BYTES } = options
    signal.throwIfAborted()
    const root = await this.sourceRoot(source, true)
    signal.throwIfAborted()
    const absolutePath = resolveSourcePath(root, declaredRootOf(root, scope.workspaceRoot), path)
    const key = this.documentKey(source, absolutePath)
    const cached = this.documents.get(key)
    if (!fresh && cached && cached.expiresAt > Date.now()) {
      if (cached.document.data.byteLength > maxBytes) throw tooLarge(path, maxBytes)
      return cached.document
    }
    this.forgetDocument(key)
    const outside = !contained(root.paths, root.root, absolutePath)
    let document: SourceDocumentRead | undefined
    try {
      const info: FileInfo | null = await this.reader.sourceDocumentInfo(source, absolutePath, signal)
      if (info === null) {
        if (!outside) throw new RemoteError('workspace-file/not-found', 'The source path no longer exists', { path })
      } else {
        if (info.size > maxBytes) throw tooLarge(path, maxBytes)
        document = await this.reader.readSourceDocument(source, absolutePath, signal, maxBytes)
      }
    } catch (error) {
      if (!outside || !(error instanceof HapiRequestError)) throw error
      // HAPI's document authority rejected an outside path; its artifact route
      // is the remaining original authority for this session's uploads.
    }
    document ??= await this.artifactDocument(source, absolutePath, signal, maxBytes)
    if (document.data.byteLength > maxBytes) throw tooLarge(path, maxBytes)
    this.rememberDocument(key, document)
    return document
  }

  /** Read-only metadata for a watch, under the same split read authority. */
  private async documentInfo(source: WorkbenchSource, absolutePath: string, signal: AbortSignal, outside: boolean): Promise<FileInfo | null | undefined> {
    try { return await this.reader.sourceDocumentInfo(source, absolutePath, signal) }
    catch (error) {
      if (!outside || !(error instanceof HapiRequestError)) throw error
      // Undefined means the document authority denied this outside path; the
      // caller may still try the session's own upload authority once.
      return undefined
    }
  }

  private async observation(source: WorkbenchSource, scope: WorkspaceFileScope, path: string, signal: AbortSignal, previous?: Observation): Promise<Observation> {
    const session = await this.sourceSession(source, true)
    const cwd = session.metadata?.path
    if (!cwd) throw new HapiRequestError('The source session has no verified working directory', 'rejected', 409, 'source_unavailable')
    const root = sourceRootFor(cwd)
    const declared = declaredRootOf(root, scope.workspaceRoot)
    const absolutePath = resolveSourcePath(root, declared, path)
    // Direct listings avoid recursively scanning whole source repositories for
    // each tree watch. File revisions remain the source's opaque CAS revision.
    let directory: WorkbenchResponse<'nativeDirectory'> | undefined
    try {
      const confined = resolveSourcePath(root, declared, path, true)
      if (session.active) directory = await this.reader.nativeDirectory({ source, path: confined }, signal)
    } catch (error) { if (!(error instanceof RemoteError && error.code === 'workspace-file/outside-workspace')) throw error }
    if (directory?.success) {
      const children = [...directory.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      const version = createHash('sha256').update(JSON.stringify(children)).digest('hex')
      return { absolutePath, version: `hapi-directory:${version}` }
    }
    const outside = !contained(root.paths, root.root, absolutePath)
    const info = await this.documentInfo(source, absolutePath, signal, outside)
    if (info === undefined) {
      // The document authority denied this outside path; the session upload
      // authority is the only original successor. Its explicit failure stands.
      const artifact = await this.artifactDocument(source, absolutePath, signal, MAX_DOCUMENT_BYTES)
      this.rememberDocument(this.documentKey(source, absolutePath), artifact)
      if (previous && 'version' in previous && previous.version === artifact.version && previous.absolutePath === artifact.absolutePath) return previous
      return { absolutePath: artifact.absolutePath, version: artifact.version }
    }
    if (info === null) {
      if (outside) {
        const artifact = await this.artifactDocument(source, absolutePath, signal, MAX_DOCUMENT_BYTES)
        this.rememberDocument(this.documentKey(source, absolutePath), artifact)
        if (previous && 'version' in previous && previous.version === artifact.version && previous.absolutePath === artifact.absolutePath) return previous
        return { absolutePath: artifact.absolutePath, version: artifact.version }
      }
      this.forgetDocument(this.documentKey(source, absolutePath))
      return { absolutePath: previous?.absolutePath ?? absolutePath, absent: true }
    }
    const fingerprint = info.modified === undefined ? undefined : JSON.stringify([info.size, info.modified])
    if (fingerprint !== undefined && previous && 'version' in previous && previous.fingerprint === fingerprint) return previous
    const entry = await this.documentRead(source, scope, path, signal, { fresh: true })
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
