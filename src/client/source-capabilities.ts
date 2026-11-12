/** One source directory per authenticated Host generation, shared by all its Pane views. */
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { CodexCapabilities } from '../remote/codex-access.ts'
import type { SourceSession } from '../remote/protocol.ts'
import { sourceDirectoryKey, sourceRoute } from '../shared/source-capability.ts'

type DirectoryApi = Pick<HhpiRemoteApi, 'nativeCall' | 'nativeCapabilities'>
const directoryMethods = new Set(['model/list', 'permissionProfile/list', 'skills/list', 'plugin/list', 'plugin/installed', 'mcpServerStatus/list'])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Cancelling a menu read must not cancel the shared read used by another Pane. */
function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export class SourceDirectory {
  private readonly lifetime = new AbortController()
  private capabilityRead: Promise<CodexCapabilities> | undefined
  private readonly reads = new Map<string, Promise<unknown>>()
  constructor(private readonly api: DirectoryApi, readonly sourceId: string) {}

  capabilities(signal?: AbortSignal): Promise<CodexCapabilities> {
    this.lifetime.signal.throwIfAborted()
    if (!this.capabilityRead) {
      const read = (async () => {
        if (!this.api.nativeCapabilities) throw new Error('Native source capability discovery is not connected.')
        const response = await this.api.nativeCapabilities({ sourceId: this.sourceId }, this.lifetime.signal)
        this.lifetime.signal.throwIfAborted()
        if (!response.ok) throw response.error
        return response.value
      })()
      this.capabilityRead = read
      void read.catch(() => { if (this.capabilityRead === read) this.capabilityRead = undefined })
    }
    return waitFor(this.capabilityRead, signal)
  }

  /** Only directory reads are cached. Thread content and all writes stay outside this owner. */
  read(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    this.lifetime.signal.throwIfAborted()
    if (!directoryMethods.has(method)) return Promise.reject(new Error('This method is not a source directory read.'))
    const key = JSON.stringify([method, params])
    let work = this.reads.get(key)
    if (!work) {
      work = (async () => {
        const capability = await this.capabilities()
        if (capability.methods[method] !== 'read') throw new Error(capability.unavailable[method] ?? 'The source does not expose this directory.')
        if (!this.api.nativeCall) throw new Error('The native source directory is not connected.')
        const response = await this.api.nativeCall({ sourceId: this.sourceId, method, params }, this.lifetime.signal)
        this.lifetime.signal.throwIfAborted()
        if (!response.ok) throw response.error
        if (response.value.status !== 'accepted') throw new Error(response.value.message)
        return response.value.result
      })()
      this.reads.set(key, work)
      const active = work
      void work.catch(() => { if (this.reads.get(key) === active) this.reads.delete(key) })
    }
    return waitFor(work, signal)
  }

  async list(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<readonly unknown[]> {
    const rows: unknown[] = [], cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const page = await this.read(method, { ...params, cursor, limit: 100 }, signal)
      if (!record(page) || !Array.isArray(page.data)) throw new Error('The source returned an invalid directory page.')
      rows.push(...page.data)
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
      if (cursor && cursors.has(cursor)) throw new Error('The source directory cursor did not advance.')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return rows
  }

  dispose(): void {
    this.lifetime.abort(new DOMException('The source directory generation was released.', 'AbortError'))
    this.capabilityRead = undefined
    this.reads.clear()
  }
}

export class SourceDirectories {
  private readonly directories = new Map<string, SourceDirectory>()
  constructor(private readonly api: DirectoryApi, private readonly hostId: string,
    private scope: string, private generation: number) {}

  forSession(session: SourceSession): SourceDirectory {
    const route = sourceRoute(this.hostId, session.id, this.hostId)
    const key = sourceDirectoryKey(this.scope, this.generation, route)
    let directory = this.directories.get(key)
    if (!directory) {
      directory = new SourceDirectory(this.api, session.sourceId)
      this.directories.set(key, directory)
    }
    return directory
  }
  /** Account/connection replacement invalidates old callbacks instead of republishing them. */
  reset(scope: string, generation: number): void {
    if (this.scope === scope && this.generation === generation) return
    this.dispose(); this.scope = scope; this.generation = generation
  }
  invalidate(sourceId: string): void {
    for (const [key, directory] of this.directories) if (directory.sourceId === sourceId) {
      directory.dispose(); this.directories.delete(key)
    }
  }
  dispose(): void { for (const directory of this.directories.values()) directory.dispose(); this.directories.clear() }
}
