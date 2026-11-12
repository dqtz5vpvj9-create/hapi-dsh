/** Explicit source reads for MCP connections and Codex-owned background processes. */
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import { boundedSourceRead } from './remote-read-recovery.ts'

export type NativeServiceSection = 'mcp' | 'background'
export type NativeServiceIssue = 'unsupported' | 'offline' | 'denied' | 'invalid' | 'unavailable'
export interface NativeMcpServer {
  name: string
  title: string | null
  runtimeStatus: string | null
  authStatus: string
  toolCount: number
  toolsUnavailable: boolean
}
export interface NativeBackgroundProcess {
  processId: string
  itemId: string
  command: string
  cwd: string
  osPid: number | null
  cpuPercent: number | null
  rssKb: number | null
}
export interface NativeServicePage<T> {
  rows: readonly T[]
  loaded: boolean
  loading: boolean
  nextCursor: string | null
  issue: NativeServiceIssue | null
}
export interface NativeServicesSnapshot {
  current: boolean
  mcp: NativeServicePage<NativeMcpServer>
  background: NativeServicePage<NativeBackgroundProcess>
}
export interface NativeServicesAccess { signal: AbortSignal; assertCurrent(): void }
const empty = <T>(): NativeServicePage<T> => ({ rows: [], loaded: false, loading: false, nextCursor: null, issue: null })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const mcpStates = new Set(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'])
const authStates = new Set(['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'])
const methods = { mcp: 'mcpServerStatus/list', background: 'thread/backgroundTerminals/list' } as const
class ServiceFailure extends Error { constructor(readonly issue: NativeServiceIssue) { super(issue) } }
function failure(error: unknown): NativeServiceIssue {
  if (error instanceof ServiceFailure) return error.issue
  if (object(error) && error.code === 'remote-access/denied') return 'denied'
  if (object(error) && (error.code === 'TARGET_UNAVAILABLE' || error.code === 'gateway/cancelled'
    || object(error.details) && error.details.sourceCode === 'TARGET_UNAVAILABLE')) return 'offline'
  return 'unavailable'
}
function mcpServer(value: unknown): NativeMcpServer {
  if (!object(value) || !text(value.name) || !authStates.has(String(value.authStatus)) || !object(value.tools)
    || value.runtimeStatus != null && !mcpStates.has(String(value.runtimeStatus))) throw new ServiceFailure('invalid')
  return { name: value.name, title: object(value.serverInfo) && typeof value.serverInfo.title === 'string' ? value.serverInfo.title : null,
    runtimeStatus: typeof value.runtimeStatus === 'string' ? value.runtimeStatus : null, authStatus: String(value.authStatus),
    toolCount: Object.keys(value.tools).length, toolsUnavailable: typeof value.toolsError === 'string' && !!value.toolsError }
}
function backgroundProcess(value: unknown): NativeBackgroundProcess {
  if (!object(value) || !text(value.processId) || !text(value.itemId) || typeof value.command !== 'string' || typeof value.cwd !== 'string') throw new ServiceFailure('invalid')
  return { processId: value.processId, itemId: value.itemId, command: value.command, cwd: value.cwd,
    osPid: number(value.osPid), cpuPercent: number(value.cpuPercent), rssKb: number(value.rssKb) }
}

export class RemoteNativeServices {
  private snapshot: NativeServicesSnapshot = { current: true, mcp: empty(), background: empty() }
  private readonly lifetime = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly flights = new Map<NativeServiceSection, Promise<void>>()
  private readonly cursors = { mcp: new Set<string>(), background: new Set<string>() }
  private readonly assertAuthorization: () => void
  private readonly stops: Array<() => void>
  private readonly sessionId: string
  constructor(private readonly session: RemoteSourceSession, private readonly api: Pick<HhpiRemoteApi, 'nativeCall'>,
    captureAccess: () => NativeServicesAccess) {
    this.sessionId = session.sessionId
    let access: NativeServicesAccess
    try {
      access = captureAccess(); access.assertCurrent(); access.signal.throwIfAborted()
      this.assertAuthorization = () => { access.signal.throwIfAborted(); access.assertCurrent() }
    } catch {
      this.assertAuthorization = () => { throw new ServiceFailure('denied') }
      this.snapshot = { current: false, mcp: empty(), background: empty() }; this.stops = []; this.lifetime.abort(); return
    }
    const changed = (): void => { if (!this.current()) this.invalidate() }
    access.signal.addEventListener('abort', changed, { once: true })
    this.stops = [() => access.signal.removeEventListener('abort', changed), session.metadata.subscribe(changed)]
  }
  readonly getSnapshot = (): NativeServicesSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private current(): boolean {
    try { this.lifetime.signal.throwIfAborted(); this.assertAuthorization(); return this.session.metadata.getSnapshot().id === this.sessionId }
    catch { return false }
  }
  private invalidate(): void {
    if (!this.snapshot.current) return
    this.lifetime.abort()
    this.snapshot = { current: false, mcp: empty(), background: empty() }
    for (const listener of this.listeners) listener()
  }
  private publish<K extends NativeServiceSection>(section: K, patch: Partial<NativeServicesSnapshot[K]>): void {
    if (!this.current()) { this.invalidate(); return }
    this.snapshot = { ...this.snapshot, [section]: { ...this.snapshot[section], ...patch } }
    for (const listener of this.listeners) listener()
  }
  /** One explicit page, coalesced per section. Neither mount nor refresh dispatches a write. */
  read(section: NativeServiceSection, more = false): Promise<void> {
    const running = this.flights.get(section)
    if (running) return running
    if (!this.current()) { this.invalidate(); return Promise.resolve() }
    const cursor = more ? this.snapshot[section].nextCursor : null
    if (more && !cursor) return Promise.resolve()
    const work = Promise.resolve().then(async () => {
      this.publish(section, { loading: true, issue: null })
      try {
        const metadata = this.session.metadata.getSnapshot()
        if (sourceIsOffline(metadata)) throw new ServiceFailure('offline')
        const directory = this.session.sourceDirectory()
        const capability = directory ? await boundedSourceRead(signal => directory.capabilities(signal), this.lifetime.signal) : undefined
        if (!this.current()) { this.invalidate(); return }
        if (!capability || !this.api.nativeCall) throw new ServiceFailure('unavailable')
        if (capability.methods[methods[section]] !== 'read') throw new ServiceFailure('unsupported')
        const response = await boundedSourceRead(signal => this.api.nativeCall!({ sourceId: metadata.sourceId, method: methods[section],
          params: { threadId: metadata.nativeId, cursor, limit: 50, ...(section === 'mcp' ? { detail: 'toolsAndAuthOnly' } : {}) } }, signal), this.lifetime.signal)
        if (!this.current()) { this.invalidate(); return }
        if (!response.ok) throw response.error
        const result = response.value
        if (result.status !== 'accepted') throw new ServiceFailure(result.error?.code === -32601 ? 'unsupported' : 'unavailable')
        const page = result.result
        if (!object(page) || !Array.isArray(page.data) || page.nextCursor != null && !text(page.nextCursor)) throw new ServiceFailure('invalid')
        const nextCursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
        if (nextCursor && (nextCursor === cursor || more && this.cursors[section].has(nextCursor))) throw new ServiceFailure('invalid')
        if (!more) this.cursors[section].clear()
        if (cursor) this.cursors[section].add(cursor)
        if (section === 'mcp') {
          const rows = page.data.map(mcpServer)
          this.publish('mcp', { rows: [...new Map([...(more ? this.snapshot.mcp.rows : []), ...rows].map(row => [row.name, row])).values()], loaded: true, nextCursor })
        } else {
          const rows = page.data.map(backgroundProcess)
          this.publish('background', { rows: [...new Map([...(more ? this.snapshot.background.rows : []), ...rows].map(row => [row.processId, row])).values()], loaded: true, nextCursor })
        }
      } catch (error) {
        if (this.current()) {
          const issue = failure(error)
          this.publish(section, { issue, ...(issue === 'denied' || issue === 'unsupported' ? { rows: [], loaded: false, nextCursor: null } : {}) })
        } else this.invalidate()
      } finally { if (this.current()) this.publish(section, { loading: false }) }
    }).finally(() => { if (this.flights.get(section) === work) this.flights.delete(section) })
    this.flights.set(section, work)
    return work
  }
  refresh = async (): Promise<void> => { await Promise.all([this.read('mcp'), this.read('background')]) }
  dispose(): void { this.lifetime.abort(); for (const stop of this.stops) stop(); this.listeners.clear() }
}
