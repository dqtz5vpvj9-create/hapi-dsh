/** Clicked text submissions belong to the account/Host, not to a mounted Pane. */
import { operationSchema } from '../hhpi-api.ts'
import type { SourceEntry, SourceOperation, SourceReceipt, SourceSession } from '../remote/protocol.ts'
import type { SourceStorage } from './remote-storage.ts'

export type DeliveryState = 'queued' | 'sending' | 'confirming' | 'accepted' | 'rejected'
export interface SourceDelivery {
  readonly operation: Readonly<SourceOperation>
  readonly createdAt: number
  readonly state: DeliveryState
  readonly message: string
  readonly attempts: number
  readonly retryAt: number
}
export interface SourceDeliveryStore {
  getSnapshot(): readonly SourceDelivery[]
  subscribe(listener: () => void): () => void
}
interface StoredDelivery extends SourceDelivery { version: 1 }
const MAX_ENTRIES = 256
const MAX_BYTES = 4 * 1024 * 1024
const EMPTY: readonly SourceDelivery[] = Object.freeze([])
const prefixOf = (scope: string): string => `hhpi:outbox:v1:${scope}:`
const fingerprint = (operation: SourceOperation): string => JSON.stringify([operation.sessionId, operation.operationId, operation.kind,
  operation.text ?? null, operation.turnId ?? null, operation.requestId ?? null, operation.decision ?? null])
const offline = (session: SourceSession): boolean => session.status === 'offline'
  || (session as SourceSession & { connection?: { state: string } }).connection?.state === 'offline'

function decode(value: string | null): StoredDelivery | undefined {
  if (!value) return undefined
  try {
    const candidate = JSON.parse(value) as StoredDelivery
    const operation = operationSchema.safeParse(candidate.operation)
    if (candidate.version !== 1 || !operation.success || operation.data.kind !== 'send' || !operation.data.text?.trim()
      || !Number.isSafeInteger(candidate.createdAt) || candidate.createdAt < 0
      || !['queued', 'sending', 'confirming', 'accepted', 'rejected'].includes(candidate.state)
      || typeof candidate.message !== 'string' || !Number.isSafeInteger(candidate.attempts) || candidate.attempts < 0
      || !Number.isFinite(candidate.retryAt)) return undefined
    return Object.freeze({ ...candidate, operation: Object.freeze(operation.data) })
  } catch { return undefined }
}

/** No UI disposal, transport rejection or receipt ACK removes an unobserved message. */
export class RemoteOutbox {
  private access: SourceStorage | undefined
  private readonly entries = new Map<string, StoredDelivery>()
  private readonly sessions = new Map<string, SourceSession>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly snapshots = new Map<string, readonly SourceDelivery[]>()
  private readonly retireListeners = new Set<(id: string, observed: boolean) => void>()
  private readonly sending = new Set<string>()
  private readonly staged = new Set<string>()
  private readonly stopWake: () => void
  private generation = 0
  private ready = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly send: (operation: SourceOperation) => Promise<SourceReceipt>) {
    const wake = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      for (const [id, entry] of this.entries) if (entry.state === 'confirming' || entry.state === 'queued') this.entries.set(id, Object.freeze({ ...entry, retryAt: 0 }))
      this.publish(); this.kick()
    }
    const pause = (): void => { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
    if (typeof window === 'undefined') this.stopWake = () => {}
    else {
      window.addEventListener('online', wake); window.addEventListener('offline', pause); window.addEventListener('pageshow', wake)
      document.addEventListener('visibilitychange', wake)
      this.stopWake = () => {
        window.removeEventListener('online', wake); window.removeEventListener('offline', pause); window.removeEventListener('pageshow', wake)
        document.removeEventListener('visibilitychange', wake)
      }
    }
  }

  setStorage(access: SourceStorage | undefined): void {
    if (access?.scope === this.access?.scope && access?.storage === this.access?.storage) return
    ++this.generation; this.ready = false; this.sending.clear()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined; this.entries.clear(); this.staged.clear(); this.sessions.clear(); this.access = access
    if (access) {
      const prefix = prefixOf(access.scope)
      try {
        for (let index = 0; index < access.storage.length; index++) {
          const key = access.storage.key(index)
          if (!key?.startsWith(prefix)) continue
          const entry = decode(access.storage.getItem(key))
          if (entry && key === this.key(entry.operation.operationId)) this.entries.set(entry.operation.operationId,
            entry.state === 'sending' ? Object.freeze({ ...entry, state: 'confirming', retryAt: 0 }) : entry)
        }
      } catch { /* Reads remain available; a new submission still requires a successful durable write. */ }
    }
    this.publish()
  }

  /** A successful authenticated catalog, not cached metadata, admits dispatch. */
  acceptCatalog(sessions: readonly SourceSession[]): void {
    if (this.disposed) return
    if (!this.ready) {
      for (const [id, entry] of this.entries) if (entry.state === 'confirming') this.entries.set(id, Object.freeze({ ...entry, retryAt: 0 }))
      this.publish()
    }
    this.ready = true; this.sessions.clear()
    for (const session of sessions) this.sessions.set(session.id, session)
    this.kick()
  }
  updateSession(session: SourceSession): void {
    if (!this.sessions.has(session.id)) return
    this.sessions.set(session.id, session); this.kick()
  }
  view(sessionId: string): SourceDeliveryStore {
    return { getSnapshot: () => this.snapshots.get(sessionId) ?? EMPTY, subscribe: listener => {
      let group = this.listeners.get(sessionId)
      if (!group) { group = new Set(); this.listeners.set(sessionId, group) }
      group.add(listener)
      return () => { group.delete(listener); if (!group.size) this.listeners.delete(sessionId) }
    } }
  }
  onRetire(listener: (id: string, observed: boolean) => void): () => void {
    this.retireListeners.add(listener); return () => { this.retireListeners.delete(listener) }
  }
  get(operationId: string): SourceDelivery | undefined { return this.entries.get(operationId) }

  /** Must finish before the official input commits its draft. No network work occurs here. */
  enqueue(operation: SourceOperation): SourceDelivery {
    if (this.disposed || !this.access) throw new Error('This message could not be saved on this device. Your draft has been kept.')
    if (operation.kind !== 'send' || !operation.text?.trim() || !operationSchema.safeParse(operation).success) throw new Error('Only a nonempty text message can be queued for this source.')
    const existing = this.entries.get(operation.operationId)
    if (existing) {
      if (fingerprint(existing.operation) !== fingerprint(operation)) throw new Error('An operation ID was reused with different arguments.')
      return existing
    }
    const createdAt = Math.max(Date.now(), ...[...this.entries.values()].map(entry => entry.createdAt + 1))
    const entry: StoredDelivery = Object.freeze({ version: 1, operation: Object.freeze({ ...operation }), createdAt,
      state: 'queued', message: 'Saved on this device. Waiting to send.', attempts: 0, retryAt: 0 })
    const serialized = JSON.stringify(entry)
    const bytes = [...this.entries.values()].reduce((size, value) => size + JSON.stringify(value).length * 2, serialized.length * 2)
    if (this.entries.size >= MAX_ENTRIES || bytes > MAX_BYTES) throw new Error('The saved-message queue is full. Your draft has been kept.')
    try { this.access.storage.setItem(this.key(operation.operationId), serialized) }
    catch { throw new Error('This message could not be saved on this device. Your draft has been kept.') }
    this.entries.set(operation.operationId, entry); this.staged.add(operation.operationId); this.publish()
    return entry
  }
  start(operationId: string): void {
    if (!this.entries.has(operationId)) throw new Error('The saved submission is no longer available.')
    this.staged.delete(operationId)
    this.kick()
  }
  /** Explicitly abandoning preparation may only remove work that has never left this device. */
  abandon(operationId: string): void {
    const entry = this.entries.get(operationId)
    if (entry?.state === 'queued' && entry.attempts === 0) this.remove(operationId, false)
  }
  discard(operationId: string): void {
    const entry = this.entries.get(operationId)
    if (entry?.state === 'rejected') this.remove(operationId, false)
  }
  /** Only accepted source history is evidence that the transcript owns this echo. */
  observe(sessionId: string, entries: readonly SourceEntry[]): void {
    for (const { event } of entries) {
      if (event.type !== 'user/message') continue
      const source = (event.data as { source?: { rpcId?: string } }).source
      if (typeof source?.rpcId !== 'string') continue
      const entry = this.entries.get(source.rpcId)
      if (entry?.operation.sessionId === sessionId) this.remove(source.rpcId, true)
    }
    this.kick()
  }
  revokeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    for (const entry of this.entries.values()) if (entry.operation.sessionId === sessionId) this.remove(entry.operation.operationId, false, true)
  }
  clear(): void {
    ++this.generation; this.ready = false; this.sending.clear()
    for (const id of [...this.entries.keys()]) this.remove(id, false, true)
    this.sessions.clear()
  }
  dispose(): void {
    this.disposed = true; ++this.generation
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.listeners.clear(); this.retireListeners.clear(); this.sending.clear(); this.stopWake()
  }
  private key(id: string): string { return `${prefixOf(this.access!.scope)}${encodeURIComponent(id)}` }
  private remove(id: string, observed: boolean, revoked = false): void {
    if (!this.entries.has(id)) return
    try { this.access?.storage.removeItem(this.key(id)) } catch { if (!revoked) return }
    this.entries.delete(id); this.staged.delete(id); this.publish()
    for (const listener of this.retireListeners) listener(id, observed)
  }
  private publish(): void {
    const sessions = new Set([...this.snapshots.keys(), ...this.listeners.keys(), ...[...this.entries.values()].map(value => value.operation.sessionId)])
    for (const session of sessions) {
      const next = [...this.entries.values()].filter(entry => entry.operation.sessionId === session)
        .sort((a, b) => a.createdAt - b.createdAt || a.operation.operationId.localeCompare(b.operation.operationId))
      this.snapshots.set(session, next.length ? Object.freeze(next) : EMPTY)
      for (const listener of this.listeners.get(session) ?? []) listener()
    }
  }
  private write(entry: StoredDelivery): boolean {
    try { this.access!.storage.setItem(this.key(entry.operation.operationId), JSON.stringify(entry)) }
    catch { return false }
    this.entries.set(entry.operation.operationId, Object.freeze(entry)); this.publish(); return true
  }
  private kick(): void {
    if (!this.ready || !this.access || this.disposed || typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    let next = Infinity
    for (const [sessionId, rows] of this.snapshots) {
      if (this.sending.has(sessionId)) continue
      const session = this.sessions.get(sessionId)
      if (!session || offline(session)) continue
      const entry = rows.find(value => value.state !== 'accepted' && value.state !== 'rejected') as StoredDelivery | undefined
      if (!entry) continue
      if (this.staged.has(entry.operation.operationId)) continue
      if (!session.capabilities.send) {
        // A pending/unknown operation is queried using its original identity.
        // Capability loss only rejects a message proven not yet dispatched.
        if (entry.state === 'queued' && entry.attempts === 0) this.write({ ...entry, state: 'rejected', message: 'This source no longer permits sending. The saved message is retained.' })
        else next = Math.min(next, Date.now() + 5000)
        continue
      }
      if (entry.retryAt > Date.now()) { next = Math.min(next, entry.retryAt); continue }
      const generation = this.generation
      this.sending.add(sessionId)
      void this.dispatch(entry, generation).finally(() => {
        if (generation !== this.generation) return
        this.sending.delete(sessionId); this.kick()
      })
    }
    if (Number.isFinite(next)) this.timer = setTimeout(() => { this.timer = undefined; this.kick() }, Math.max(50, next - Date.now()))
  }
  private async dispatch(entry: StoredDelivery, generation: number): Promise<void> {
    const attempt = entry.attempts + 1
    // A durable marker precedes the RPC. Reload must query this exact identity.
    if (!this.write({ ...entry, state: 'sending', attempts: attempt, message: 'Sending the saved message.' })) {
      this.entries.set(entry.operation.operationId, Object.freeze({ ...entry, retryAt: Date.now() + 5000, message: 'Waiting for device storage before sending.' }))
      this.publish(); return
    }
    let state: DeliveryState, message: string
    try {
      const receipt = await this.send(entry.operation)
      if (receipt.operationId !== entry.operation.operationId || receipt.sessionId !== entry.operation.sessionId) throw new Error('The source returned an unrelated acknowledgement.')
      state = receipt.status === 'indeterminate' ? 'confirming' : receipt.status
      message = receipt.message
    } catch (error) {
      const details = error && typeof error === 'object' && 'details' in error ? (error as { details?: { sourceCode?: string; outcome?: string } }).details : undefined
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined
      const unauthorized = code === 'gateway/internal' && error instanceof Error
        && /^client api: hhpi\/(?:operate|receipt) failed: /.test(error.message) && /HTTP (?:401|403)\b/.test(error.message)
      if (unauthorized) this.ready = false
      const permanent = code === 'remote-access/denied' || details?.outcome === 'rejected' && ['UNSUPPORTED', 'INVALID_REQUEST', 'FORBIDDEN', 'unsupported'].includes(details.sourceCode ?? '')
      state = permanent ? 'rejected' : 'confirming'
      message = unauthorized ? 'Waiting for authenticated access. The saved message keeps its original identity.'
        : permanent && error instanceof Error ? error.message : 'Waiting to confirm delivery. The saved message will keep the same identity.'
    }
    if (generation !== this.generation || this.disposed || !this.entries.has(entry.operation.operationId)) return
    const retryAt = state === 'confirming' ? Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)) + Math.floor(Math.random() * 250) : 0
    // If storage filled after dispatch, keep the original durable uncertainty
    // marker. A later retry/reload reconciles it; no new identity is invented.
    if (!this.write({ ...entry, attempts: attempt, state, message, retryAt })) {
      this.entries.set(entry.operation.operationId, Object.freeze({ ...entry, attempts: attempt, state: 'confirming', message: 'Delivery is waiting for confirmation; device storage is full.', retryAt: Date.now() + 5000 }))
      this.publish()
    }
  }
}
