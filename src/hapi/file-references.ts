/** Source-aware discovery behind the unchanged official `fileReferences/list` Remote. */
import { posix, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import FileReferenceService, { type FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'
import LocalFileReferenceService, {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES, DEFAULT_FILE_SEARCH_MAX_ENTRIES, DEFAULT_FILE_SEARCH_MAX_RESULTS,
  type Config,
} from '@deepseek-ai/dsh-file-reference-local'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { HapiRequestError } from '../codex/contracts.ts'
import type { WorkbenchSource, WorkbenchResponse } from '../workbench-types.ts'
import type {} from '../index.ts'
import { officialProviderConfig, officialProviderContext, officialProviderScope } from '../shared/official-provider.ts'

type SourceRoot = { cwd: string; paths: typeof posix }
type Limits = { maxResults: number; maxEntries: number; excluded: ReadonlySet<string> }
const sourceDisplay = (id: string): boolean => id.startsWith('hapi-codex-') || id.startsWith('hapi-observed-')
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function rootFor(cwd: string): SourceRoot {
  // Path arithmetic follows the source platform, never the Hub's process cwd.
  const paths = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') ? win32 : posix
  if (!paths.isAbsolute(cwd) || /[\u0000-\u001f\u007f]/.test(cwd)) {
    throw new HapiRequestError('The source has no usable absolute working directory', 'rejected', 409, 'source_unavailable')
  }
  return { cwd: paths.normalize(cwd), paths }
}
function within(root: SourceRoot, path: string): { absolute: string; relative: string } | undefined {
  const absolute = root.paths.resolve(root.cwd, path || '.')
  const relative = root.paths.relative(root.cwd, absolute)
  if (relative === '..' || relative.startsWith(`..${root.paths.sep}`) || root.paths.isAbsolute(relative)) return undefined
  return { absolute, relative: root.paths === win32 ? relative.replaceAll('\\', '/') : relative }
}
function validName(name: string, root: SourceRoot): boolean {
  return name !== '' && name !== '.' && name !== '..' && name.length <= 8192
    && !/[\u0000-\u001f\u007f/]/.test(name) && (root.paths !== win32 || !name.includes('\\'))
}
function visible(path: string, kind: FileReferenceCandidate['kind'], query: string, limits: Limits): boolean {
  const segments = path.split('/')
  const directories = kind === 'directory' ? segments : segments.slice(0, -1)
  if (directories.some(segment => limits.excluded.has(segment))) return false
  return query.startsWith('.') || query.includes('/.') || !segments.some(segment => segment.startsWith('.'))
}
function requireSuccess(value: { success: boolean }): void {
  // Do not pass arbitrary upstream error bodies into a completion tooltip.
  if (!value.success) throw new HapiRequestError('The owning Runner could not list file references', 'rejected', 409, 'source_unavailable')
}
function sourceFailure(error: unknown): never {
  if (error instanceof HapiRequestError) throw new RemoteError('hapi/request', error.message, {
    outcome: error.outcome, ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === undefined ? {} : { sourceCode: error.code }),
  })
  throw error
}
/** Stable completion ordering; source global matching still belongs to HAPI's ripgrep endpoint. */
function rank(values: Iterable<FileReferenceCandidate>, query: string, limit: number): FileReferenceCandidate[] {
  const needle = query.toLocaleLowerCase('en-US')
  const priority = (candidate: FileReferenceCandidate): number => {
    const name = candidate.path.slice(candidate.path.lastIndexOf('/') + 1).toLocaleLowerCase('en-US')
    return name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3
  }
  return [...values].sort((a, b) => priority(a) - priority(b)
    || (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1)
    || compare(a.path, b.path)).slice(0, limit)
}

/**
 * This replaces only the public discovery capability. The original package root
 * stays active in its private Cordis realm, owning its prompts, configuration
 * and ordinary DSH search cache. No filesystem or workingDirectory capability
 * is consulted for a source Agent.
 */
export class SourceAwareFileReferences extends FileReferenceService {
  static inject = ['loader', 'agents', 'hapi']

  constructor(ctx: Context) { super(ctx) }

  private get ordinary(): FileReferenceService {
    const original = officialProviderContext(this.ctx, 'file-reference-local').get('fileReferences')
    if (!original) throw new Error('The official file-reference delegate is not active')
    return original
  }
  private get limits(): Limits {
    const config = LocalFileReferenceService.Config(officialProviderConfig(this.ctx, 'file-reference-local') as Config)
    return { maxResults: config.maxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS,
      maxEntries: config.maxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
      excluded: new Set(config.excludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES) }
  }
  private currentSource(agent: Agent, expected?: WorkbenchSource): WorkbenchSource {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new RemoteError('hapi/request', 'This source Agent is unavailable or has been replaced', { outcome: 'rejected', status: 409 })
    }
    const source = this.ctx.hapi.workbenchSource(agent.id)
    if (!source || expected && (source.sourceSessionId !== expected.sourceSessionId
      || source.sourceHubId !== expected.sourceHubId || source.machineId !== expected.machineId)) {
      throw new RemoteError('hapi/request', 'The file-reference source is no longer current', { outcome: 'rejected', status: 409 })
    }
    return source
  }

  override async list(agent: Agent, rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    // Leave ordinary callers, their exact query and their Invocation untouched.
    if (!sourceDisplay(agent.id)) return this.ordinary.list(agent, rawQuery, signal)
    try {
      signal.throwIfAborted()
      const source = this.currentSource(agent)
      if (rawQuery.length > 8192 || /[\u0000-\u001f\u007f]/.test(rawQuery)) {
        throw new RemoteError('gateway/bad-request', 'The file-reference query is not a valid path fragment', {})
      }
      const reader = this.ctx.hapi.nativeWorkbench
      const session = await reader.resolveSource(source)
      signal.throwIfAborted()
      const root = rootFor(session.metadata!.path)
      const query = root.paths === win32 ? rawQuery.replaceAll('\\', '/') : rawQuery
      const limits = this.limits
      const slash = query.lastIndexOf('/')
      let candidates: FileReferenceCandidate[]
      if (query === '' || slash >= 0) {
        const directory = slash < 0 ? '' : query.slice(0, slash + 1)
        const fragment = slash < 0 ? '' : query.slice(slash + 1)
        const selected = within(root, directory)
        if (!selected || selected.relative.split('/').some(segment => limits.excluded.has(segment))) return []
        const listing = await reader.nativeDirectory({ source, path: selected.absolute }, signal)
        this.verifyListing(listing, root, source)
        candidates = rank(this.directoryCandidates(listing, root, directory, fragment, limits), fragment, limits.maxResults)
      } else {
        // Native global discovery uses the original source's bounded ripgrep
        // query (including its ignore rules). It never builds a Host-side index.
        // A live root listing also offers empty top-level directories.
        const [listing, search] = await Promise.all([
          reader.nativeDirectory({ source, path: root.cwd }, signal),
          reader.nativeFileSearch({ source, query, limit: Math.min(500, limits.maxEntries) }, signal),
        ])
        this.verifyListing(listing, root, source)
        requireSuccess(search)
        const selected = new Map<string, FileReferenceCandidate>()
        for (const candidate of this.directoryCandidates(listing, root, '', query, limits)) {
          selected.set(`${candidate.kind}:${candidate.path}`, candidate)
        }
        for (const entry of search.files.slice(0, Math.min(500, limits.maxEntries))) {
          signal.throwIfAborted()
          if (entry.fullPath.length > 8192 || /[\u0000-\u001f\u007f]/.test(entry.fullPath)) {
            throw new HapiRequestError('The source returned an incompatible file-reference path', 'indeterminate', 502, 'protocol_mismatch')
          }
          const path = within(root, entry.fullPath)
          if (!path || path.relative === '') {
            throw new HapiRequestError('The source returned a file reference outside its workspace', 'indeterminate', 502, 'protocol_mismatch')
          }
          const kind = entry.fileType === 'folder' ? 'directory' : 'file'
          if (!visible(path.relative, kind, query, limits)) continue
          selected.set(`${kind}:${path.relative}`, { path: path.relative, kind })
          // A returned file proves its parent path exists on that source; it
          // does not grant a new source or turn an opaque artifact into a path.
          const segments = path.relative.split('/')
          for (let depth = 1; depth < segments.length; depth++) {
            const parent = segments.slice(0, depth).join('/')
            if (parent.toLocaleLowerCase('en-US').includes(query.toLocaleLowerCase('en-US')) && visible(parent, 'directory', query, limits)) {
              selected.set(`directory:${parent}`, { path: parent, kind: 'directory' })
            }
          }
        }
        candidates = rank(selected.values(), query, limits.maxResults)
      }
      signal.throwIfAborted()
      this.currentSource(agent, source)
      return candidates
    } catch (error) { return sourceFailure(error) }
  }

  private verifyListing(listing: WorkbenchResponse<'nativeDirectory'>, root: SourceRoot, source: WorkbenchSource): void {
    requireSuccess(listing)
    if (root.paths.normalize(listing.cwd) !== root.cwd || source.machineId !== undefined && listing.machineId !== source.machineId) {
      throw new HapiRequestError('The source workspace changed while listing file references', 'rejected', 409, 'source_mismatch')
    }
  }
  private directoryCandidates(listing: WorkbenchResponse<'nativeDirectory'>, root: SourceRoot, prefix: string, fragment: string, limits: Limits): FileReferenceCandidate[] {
    const needle = fragment.toLocaleLowerCase('en-US')
    return listing.entries.flatMap(entry => {
      if (!validName(entry.name, root) || entry.isSymbolicLink || entry.type === 'other'
        || !entry.name.toLocaleLowerCase('en-US').includes(needle)
        || entry.name.startsWith('.') && !fragment.startsWith('.')
        || entry.type === 'directory' && limits.excluded.has(entry.name)) return []
      return [{ path: `${prefix}${entry.name}`, kind: entry.type }]
    })
  }
}

/** Wait on public Loader/isolate readiness; row order is not an activation contract. */
export default {
  inject: SourceAwareFileReferences.inject,
  apply(ctx: Context): void {
    let armed = false
    const arm = () => {
      if (armed) return
      const rows = [...ctx.loader.entries()].filter(entry => entry.options.id === 'file-reference-local'
        && entry.options.name === '@deepseek-ai/dsh-file-reference-local')
      const entry = rows[0]
      if (rows.length !== 1 || !entry || entry.disabled || entry.options.isolate?.fileReferences !== true) {
        throw new Error('The original file-reference-local package root must remain enabled in its own service isolate')
      }
      if (!entry.realm) return
      armed = true
      officialProviderScope(ctx, 'file-reference-local').inject(['fileReferences'], (ready: Context) => {
        const publicLabel = ctx[Context.isolate].fileReferences
        if (publicLabel === undefined) throw new Error('The public file-reference service scope is unavailable')
        // Own the provider in a public-scope fiber. Constructing it directly
        // on the private dependency waiter publishes into the public table,
        // but its ACTIVE notification still follows the waiter's private
        // label, leaving earlier official SessionFileReferences consumers
        // pending. A child plugin preserves both notification and teardown.
        ready.isolate('fileReferences', publicLabel).plugin(SourceAwareFileReferences)
      })
    }
    ctx.on('loader/patch-context', (entry, next) => {
      next()
      if (entry.options.id === 'file-reference-local') arm()
    }, { global: true })
    arm()
  },
}
