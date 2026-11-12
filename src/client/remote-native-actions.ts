/** Account-owned native intents survive Pane disposal without acquiring a new writer. */
import { QUEUED_STEER_METHOD, type CodexCall, type CodexCallResult } from '../remote/codex-access.ts'
import { codexMethods, type CodexMethod } from '../remote/codex-methods.ts'
import { randomId } from './random-id.ts'
import { RemoteOperationLedger, type OperationTransactions } from './remote-operation-ledger.ts'
import { nativeActionStoragePrefix, onSourceStorageClear, type SourceStorage } from './remote-storage.ts'
import { assertNativeActionTarget, claimNativeAction, confirmedNativeArchive, nativeActionKey, settleNativeAction,
  type NativeActionKind, type NativeActionRecord } from './remote-operation-contracts.ts'

export interface NativeActionTransport {
  call(request: CodexCall, sessionId: string): Promise<CodexCallResult>
  receipt(request: CodexCall, sessionId: string): Promise<CodexCallResult>
}
export interface NativeActionInput {
  sessionId: string
  intent: string
  kind: NativeActionKind
  request: CodexCall
  /** Only an explicit new user action can replace an already settled intent. */
  replaceSettled?: boolean
  newAttempt?: boolean
}
export interface NativeActionStore {
  getSnapshot(): readonly NativeActionRecord[]
  subscribe(listener: () => void): () => void
}
interface ActionPointer { version: 1; sessionId: string; intent: string }
interface OwnerOptions {
  createLedger?: (access: SourceStorage) => OperationTransactions
  operationId?: () => string
  now?: () => number
}
const EMPTY: readonly NativeActionRecord[] = Object.freeze([])
const phases = new Set(['prepared', 'dispatching', 'confirming', 'accepted', 'rejected'])
const settled = (record: NativeActionRecord): boolean => record.phase === 'accepted' || record.phase === 'rejected'
const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value
const payload = (record: { kind: NativeActionKind; request: CodexCall }): string => JSON.stringify(normalize([record.kind, record.request.sourceId, record.request.method, record.request.params]))
function decode(raw: string): NativeActionRecord {
  const record = JSON.parse(raw) as NativeActionRecord
  if (record.version !== 1 || typeof record.intent !== 'string' || !record.intent || !record.request?.operationId
    || !phases.has(record.phase) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
    throw new Error('The saved native action cannot be read. Nothing was sent.')
  }
  assertNativeActionTarget(record)
  return Object.freeze(record)
}

export class NativeActionOwner {
  private access: SourceStorage | undefined
  private ledger: OperationTransactions | undefined
  private readonly entries = new Map<string, NativeActionRecord>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly changes = new Set<() => void>()
  private readonly snapshots = new Map<string, readonly NativeActionRecord[]>()
  private readonly flights = new Map<string, Promise<NativeActionRecord>>()
  private readonly revocations = new Map<string, number>()
  private generation = 0
  private restoreRevision = 0
  private restoring: Promise<void> = Promise.resolve()
  private restoreError: unknown
  private disposed = false
  private stopRevocation: (() => void) | undefined
  private readonly stop: () => void
  constructor(private readonly transport: NativeActionTransport, private readonly options: OwnerOptions = {}) {
    const changed = (): void => { void this.restore().catch(() => {}) }
    if (typeof window === 'undefined') this.stop = () => {}
    else {
      window.addEventListener('storage', changed)
      this.stop = () => window.removeEventListener('storage', changed)
    }
  }
  setStorage(access: SourceStorage | undefined): void {
    if (this.disposed || access?.scope === this.access?.scope && access?.storage === this.access?.storage) return
    ++this.generation
    this.stopRevocation?.()
    this.access = access
    this.ledger = access ? (this.options.createLedger?.(access) ?? new RemoteOperationLedger(access)) : undefined
    this.stopRevocation = access ? onSourceStorageClear(access.storage, () => this.setStorage(undefined)) : undefined
    this.entries.clear(); this.flights.clear(); this.revocations.clear(); this.restoreError = undefined
    this.publish()
    this.restoring = this.restore()
    void this.restoring.catch(() => {})
  }
  /** Local reads only. A restored prepared/unknown action is never sent on mount or reconnect. */
  async restore(): Promise<void> {
    const access = this.access, ledger = this.ledger, generation = this.generation, revision = ++this.restoreRevision
    const revocations = new Map(this.revocations)
    if (!access || !ledger || this.disposed) return
    const prefix = nativeActionStoragePrefix(access.scope), restored = new Map<string, NativeActionRecord>()
    const work = (async () => {
      const pointers: Array<{ id: string; pointer: ActionPointer }> = []
      for (let index = 0; index < access.storage.length; index++) {
        const key = access.storage.key(index)
        if (!key?.startsWith(prefix)) continue
        const pointer = JSON.parse(access.storage.getItem(key)!) as ActionPointer
        const id = nativeActionKey(pointer.sessionId, pointer.intent)
        if (pointer.version !== 1 || key !== prefix + encodeURIComponent(id)) throw new Error('The saved native action index cannot be read.')
        pointers.push({ id, pointer })
      }
      for (const { id, pointer } of pointers) {
        const raw = await ledger.read(id)
        if (raw === null) continue
        if (raw === undefined) throw new Error('The saved native action is unavailable. Nothing was sent.')
        const record = decode(raw)
        if (record.sessionId !== pointer.sessionId || record.intent !== pointer.intent) throw new Error('The saved native action belongs to another conversation.')
        if (this.revocations.get(record.sessionId) !== revocations.get(record.sessionId)) continue
        restored.set(id, record)
      }
      if (!this.current(generation) || revision !== this.restoreRevision) return
      this.entries.clear()
      for (const [id, record] of restored) this.entries.set(id, record)
      this.restoreError = undefined; this.publish()
    })().catch(error => {
      if (this.current(generation) && revision === this.restoreRevision) this.restoreError = error
      throw error
    })
    this.restoring = work
    return work
  }
  /** One owner-level notification after restore or one transaction settles. */
  subscribe(listener: () => void): () => void {
    this.changes.add(listener)
    return () => { this.changes.delete(listener) }
  }
  view(sessionId: string): NativeActionStore {
    return { getSnapshot: () => this.snapshots.get(sessionId) ?? EMPTY, subscribe: listener => {
      let listeners = this.listeners.get(sessionId)
      if (!listeners) { listeners = new Set(); this.listeners.set(sessionId, listeners) }
      listeners.add(listener)
      return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(sessionId) }
    } }
  }
  get(sessionId: string, intent: string): NativeActionRecord | undefined { return this.entries.get(nativeActionKey(sessionId, intent)) }
  /** Pin account/source authorization while a caller resolves native input before admission. */
  captureAuthorization(sessionId: string): () => void {
    const generation = this.generation, revocation = this.revocations.get(sessionId)
    const assert = (): void => this.assertTarget(generation, sessionId, revocation)
    assert()
    return assert
  }
  submit(input: NativeActionInput): Promise<NativeActionRecord> {
    const id = nativeActionKey(input.sessionId, input.intent)
    const active = this.flights.get(id)
    if (active) return active.then(record => {
      if (payload(record) !== payload(input)) throw new Error('This intent already has another native action. Confirm its original result first.')
      return record
    })
    const generation = this.generation
    const work = this.submitOnce(input, generation).finally(() => { if (this.flights.get(id) === work) this.flights.delete(id) })
    this.flights.set(id, work)
    return work
  }
  private async submitOnce(input: NativeActionInput, generation: number): Promise<NativeActionRecord> {
    const access = this.access, ledger = this.ledger
    const revocation = this.revocations.get(input.sessionId)
    await this.restoring
    const assertTarget = (): void => this.assertTarget(generation, input.sessionId, revocation)
    assertTarget()
    if (!access || !ledger || this.restoreError) throw new Error('Native action storage is unavailable. Nothing was sent.')
    if (!input.intent.trim() || (codexMethods[input.request.method as CodexMethod] !== 'write' && input.request.method !== QUEUED_STEER_METHOD)) throw new Error('A native write and a stable user intent are required.')
    const now = this.options.now?.() ?? Date.now()
    const record: NativeActionRecord = { version: 1, sessionId: input.sessionId, intent: input.intent, kind: input.kind,
      request: JSON.parse(JSON.stringify({ ...input.request, operationId: input.request.operationId ?? this.options.operationId?.() ?? randomId() })) as NativeActionRecord['request'],
      phase: 'prepared', createdAt: now, updatedAt: now }
    assertNativeActionTarget(record)
    const id = nativeActionKey(record.sessionId, record.intent)
    const mirror = (value: string | null): void => this.mirror(access, id, value)
    const prepared = await ledger.transition(id, (raw, terminal) => {
      assertTarget()
      if (terminal && !(input.replaceSettled || input.newAttempt)) throw new Error('This native action was revoked. A newly authorized user action requires an explicit new attempt.')
      if (raw) {
        const previous = decode(raw)
        if (!settled(previous) || !(input.replaceSettled || input.newAttempt)) {
          if (payload(previous) !== payload(record) || input.request.operationId && previous.request.operationId !== input.request.operationId) {
            throw new Error('This intent already has another native action. Confirm its original result before starting a new attempt.')
          }
          return raw
        }
        if (previous.request.operationId === record.request.operationId) throw new Error('A new attempt requires a new operation identity.')
        const archive = confirmedNativeArchive(previous)
        if (archive && record.kind === 'archive') return JSON.stringify({ ...record, previousAcceptedArchive: archive })
      }
      return JSON.stringify(record)
    }, mirror)
    assertTarget()
    if (!prepared) throw new Error('This native action was revoked. Nothing was sent.')
    this.accept(id, prepared, generation)
    let claimed = false
    const raw = await ledger.transition(id, (value, terminal) => {
      assertTarget()
      if (terminal || !value) return null
      const previous = decode(value), next = claimNativeAction(previous, this.options.now?.() ?? Date.now())
      claimed = !!next
      return next ? JSON.stringify(next) : value
    }, mirror)
    assertTarget()
    if (!raw) throw new Error('This native action was revoked. Nothing was sent.')
    const dispatched = this.accept(id, raw, generation)
    if (!claimed) return dispatched
    let response: CodexCallResult
    try { response = await this.transport.call(dispatched.request, dispatched.sessionId) }
    catch { response = { status: 'indeterminate', message: 'The native outcome is unknown. Check the original receipt; this action will not be resent.' } }
    return this.settle(id, dispatched, response, access, ledger, generation, revocation)
  }
  /** Explicit reconciliation queries the original immutable request, including operationId. */
  async recover(sessionId: string, intent: string): Promise<NativeActionRecord | undefined> {
    const access = this.access, ledger = this.ledger, generation = this.generation
    const revocation = this.revocations.get(sessionId)
    await this.restoring
    this.assertTarget(generation, sessionId, revocation)
    if (!access || !ledger || this.restoreError) throw new Error('Native action storage is unavailable.')
    const id = nativeActionKey(sessionId, intent), raw = await ledger.read(id)
    this.assertTarget(generation, sessionId, revocation)
    if (!raw) return undefined
    const record = this.accept(id, raw, generation)
    if (record.phase === 'prepared' || settled(record)) return record
    let response: CodexCallResult
    try { response = await this.transport.receipt(record.request, record.sessionId) }
    catch { response = { status: 'indeterminate', message: 'The original native receipt is unavailable. The action remains unconfirmed and will not be resent.' } }
    return this.settle(id, record, response, access, ledger, generation, revocation)
  }
  /** Explicit source revocation is separate from a temporarily missing catalog row. */
  async revokeSession(sessionId: string): Promise<void> {
    const access = this.access, ledger = this.ledger
    // A target revocation must not discard another conversation's in-flight restore.
    // restore() checks each target against the captured revocation generation.
    this.revocations.set(sessionId, (this.revocations.get(sessionId) ?? 0) + 1)
    for (const [id, record] of this.entries) if (record.sessionId === sessionId) this.entries.delete(id)
    for (const id of this.flights.keys()) if ((JSON.parse(id) as string[])[1] === sessionId) this.flights.delete(id)
    this.publish()
    if (!access || !ledger) return
    const keys: Array<{ key: string; id: string }> = [], prefix = nativeActionStoragePrefix(access.scope)
    for (let index = 0; index < access.storage.length; index++) {
      const key = access.storage.key(index)
      if (!key?.startsWith(prefix)) continue
      const pointer = JSON.parse(access.storage.getItem(key)!) as ActionPointer
      if (pointer.sessionId === sessionId) keys.push({ key, id: nativeActionKey(sessionId, pointer.intent) })
    }
    for (const { key } of keys) access.storage.removeItem(key)
    await Promise.all(keys.map(({ key, id }) => ledger.transition(id, () => null, () => access.storage.removeItem(key))))
  }
  private async settle(id: string, original: NativeActionRecord, response: CodexCallResult, access: SourceStorage, ledger: OperationTransactions, generation: number, revocation: number | undefined): Promise<NativeActionRecord> {
    this.assertTarget(generation, original.sessionId, revocation)
    const raw = await ledger.transition(id, (value, terminal) => {
      this.assertTarget(generation, original.sessionId, revocation)
      if (terminal || !value) return null
      const current = decode(value)
      // A delayed old read cannot overwrite a newer attempt or a terminal receipt.
      if (current.request.operationId !== original.request.operationId || settled(current)) return value
      return JSON.stringify(settleNativeAction(current, response, this.options.now?.() ?? Date.now()))
    }, value => this.mirror(access, id, value))
    this.assertTarget(generation, original.sessionId, revocation)
    if (!raw) { this.entries.delete(id); this.publish(); throw new Error('This native action was revoked.') }
    return this.accept(id, raw, generation)
  }
  private mirror(access: SourceStorage, id: string, raw: string | null): void {
    const prefix = nativeActionStoragePrefix(access.scope), key = prefix + encodeURIComponent(id)
    if (raw === null) { access.storage.removeItem(key); return }
    if (!access.storage.getItem(key)) {
      let count = 0
      for (let i = 0; i < access.storage.length; i++) if (access.storage.key(i)?.startsWith(prefix)) count++
      if (count >= 256) throw new Error('The saved native action index is full. Existing actions have been kept; nothing new was sent.')
    }
    const record = decode(raw)
    access.storage.setItem(key, JSON.stringify({ version: 1, sessionId: record.sessionId, intent: record.intent } satisfies ActionPointer))
  }
  private accept(id: string, raw: string, generation: number): NativeActionRecord {
    this.assertCurrent(generation)
    ++this.restoreRevision
    const record = decode(raw)
    this.entries.set(id, record); this.publish(); return record
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation }
  private assertCurrent(generation: number): void { if (!this.current(generation)) throw new Error('The authenticated native action scope changed. Its original action was not resent.') }
  private assertTarget(generation: number, sessionId: string, revocation: number | undefined): void {
    this.assertCurrent(generation)
    if (this.revocations.has(sessionId) || this.revocations.get(sessionId) !== revocation) throw new Error('This source conversation was revoked. Its original action was not resent.')
  }
  private publish(): void {
    const sessions = new Set([...this.snapshots.keys(), ...this.listeners.keys(), ...[...this.entries.values()].map(record => record.sessionId)])
    for (const sessionId of sessions) {
      const records = [...this.entries.values()].filter(record => record.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt)
      this.snapshots.set(sessionId, records.length ? Object.freeze(records) : EMPTY)
      for (const listener of this.listeners.get(sessionId) ?? []) listener()
    }
    for (const listener of this.changes) listener()
  }
  dispose(): void {
    this.disposed = true; ++this.generation; this.stop(); this.stopRevocation?.(); this.entries.clear(); this.flights.clear(); this.publish(); this.listeners.clear(); this.changes.clear()
  }
}
export { NativeActionOwner as RemoteNativeActions }
