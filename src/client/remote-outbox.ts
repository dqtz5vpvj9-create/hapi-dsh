/** Clicked text submissions belong to the account/Host, not to a mounted Pane. */
import { RemoteOperationLedger, type OperationTransactions } from './remote-operation-ledger.ts'
import { operationSchema } from '../hhpi-api.ts'
import type { SourceEntry, SourceOperation, SourceReceipt, SourceSession } from '../remote/protocol.ts'
import { operationRefusal } from '../shared/source-operation-policy.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import type { SourceStorage } from './remote-storage.ts'
import { SOURCE_IMAGE_BASE64_LIMIT, SOURCE_IMAGE_COUNT_LIMIT } from '../shared/source-image-limits.ts'

export type DeliveryState = 'queued' | 'sending' | 'confirming' | 'accepted' | 'rejected' | 'owner-accepted'
export interface SourceDelivery {
  readonly operation: Readonly<SourceOperation>
  readonly createdAt: number
  readonly state: DeliveryState
  readonly message: string
  readonly attempts: number
  readonly retryAt: number
  readonly receipt?: SourceReceipt
}
export interface SourceDeliveryStore {
  getSnapshot(): readonly SourceDelivery[]
  subscribe(listener: () => void): () => void
}
interface StoredDelivery extends SourceDelivery { version: 1 }
interface PayloadReference { version: 2; operationId: string; sessionId: string }
const MAX_ENTRIES = 256
const MAX_BYTES = 4 * 1024 * 1024
const MAX_OWNER_RECEIPTS = 128
const EMPTY: readonly SourceDelivery[] = Object.freeze([])
const prefixOf = (scope: string): string => `hhpi:outbox:v1:${scope}:`
const fingerprint = (operation: SourceOperation): string => JSON.stringify([operation.sessionId, operation.operationId, operation.kind,
  operation.text ?? null, operation.turnId ?? null, operation.requestId ?? null, operation.decision ?? null, ...(operation.response === undefined ? [] : [operation.response]), ...(operation.images === undefined ? [] : [operation.images]), ...(operation.files === undefined ? [] : [operation.files])])

function assertOperation(operation: SourceOperation): void {
  const parsed = operationSchema.safeParse(operation)
  if (parsed.success) return
  if (operation.images && (operation.images.length > SOURCE_IMAGE_COUNT_LIMIT
    || operation.images.reduce((size, image) => size + (typeof image.data === 'string' ? image.data.length : 0), 0) > SOURCE_IMAGE_BASE64_LIMIT)) {
    throw new Error('Image attachments exceed the HHPI limit: at most 10 images and 6 MiB in total before base64 encoding. Your draft and attachments have been kept.')
  }
  const fields = parsed.error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')
  throw new Error(`The message could not be submitted (${fields}). Your draft and attachments have been kept.`)
}

function decode(value: string | null | undefined): StoredDelivery | undefined {
  if (!value) return undefined
  try {
    const candidate = JSON.parse(value) as StoredDelivery
    const operation = operationSchema.safeParse(candidate.operation)
    if (candidate.version !== 1 || !operation.success || (['send', 'steer'].includes(operation.data.kind) && !operation.data.text?.trim() && !operation.data.images?.length && !operation.data.files?.length)
      || !Number.isSafeInteger(candidate.createdAt) || candidate.createdAt < 0
      || !['queued', 'sending', 'confirming', 'accepted', 'rejected', 'owner-accepted'].includes(candidate.state)
      || typeof candidate.message !== 'string' || !Number.isSafeInteger(candidate.attempts) || candidate.attempts < 0
      || !Number.isFinite(candidate.retryAt)) return undefined
    if (candidate.receipt && (candidate.receipt.operationId !== operation.data.operationId || candidate.receipt.sessionId !== operation.data.sessionId)) return undefined
    if (candidate.state === 'owner-accepted' && (candidate.receipt?.status !== 'accepted'
      || candidate.receipt.ownerAdmission?.localId !== operation.data.operationId
      || !['queued', 'dispatching', 'indeterminate', 'consumed'].includes(candidate.receipt.ownerAdmission.state))) return undefined
    return Object.freeze({ ...candidate, operation: Object.freeze(operation.data) })
  } catch { return undefined }
}

/** The canonical transaction retains image bytes. localStorage only indexes them. */
function imageReference(entry: StoredDelivery): string {
  return JSON.stringify({ version: 2, operationId: entry.operation.operationId, sessionId: entry.operation.sessionId,
    state: entry.state, attempts: entry.attempts, retryAt: entry.retryAt, message: entry.message })
}
function reference(value: string | null): PayloadReference | undefined {
  try {
    const parsed = JSON.parse(value ?? '') as PayloadReference
    return parsed.version === 2 && typeof parsed.operationId === 'string' && typeof parsed.sessionId === 'string' ? parsed : undefined
  } catch { return undefined }
}
function journalValue(value: string): string {
  const entry = decode(value)
  return entry?.operation.images?.length ? imageReference(entry) : value
}

/** View disposal and transport loss never discard local work. Native history or
 * an exact durable owner admission can transfer responsibility for its echo. */
export class RemoteOutbox {
  private access: SourceStorage | undefined
  private ledger: OperationTransactions | undefined
  private readonly entries = new Map<string, StoredDelivery>()
  private readonly sessions = new Map<string, SourceSession>()
  private readonly sourceRevocations = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly snapshots = new Map<string, readonly SourceDelivery[]>()
  private readonly retireListeners = new Set<(id: string, observed: boolean) => void>()
  private readonly sending = new Set<string>()
  private readonly ownerChecks = new Map<string, Promise<void>>()
  private readonly staged = new Set<string>()
  private readonly stopWake: () => void
  private generation = 0
  private ready = false
  private disposed = false
  private restoring: Promise<void> | undefined
  private restoreFailure: unknown
  private storageRevision = 0
  private imageAdmissions: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly send: (operation: SourceOperation) => Promise<SourceReceipt>,
    private readonly lookup?: (operation: SourceOperation) => Promise<SourceReceipt | null>,
    private readonly readAccepted?: (operation: SourceOperation, receipt: SourceReceipt) => Promise<readonly SourceEntry[]>,
    private readonly createLedger: (access: SourceStorage) => OperationTransactions = access => new RemoteOperationLedger(access)) {
    const wake = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (this.restoreFailure) this.restoreStorage()
      for (const [id, entry] of this.entries) if (entry.state === 'confirming' || entry.state === 'queued' || entry.state === 'accepted') this.entries.set(id, Object.freeze({ ...entry, retryAt: 0 }))
      this.publish(); this.kick()
    }
    const storageChanged = (): void => {
      if (!this.access || this.disposed) return
      this.restoreStorage()
    }
    const pause = (): void => { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
    if (typeof window === 'undefined') this.stopWake = () => {}
    else {
      window.addEventListener('storage', storageChanged); window.addEventListener('online', wake); window.addEventListener('offline', pause); window.addEventListener('pageshow', wake)
      document.addEventListener('visibilitychange', wake)
      this.stopWake = () => {
        window.removeEventListener('storage', storageChanged); window.removeEventListener('online', wake); window.removeEventListener('offline', pause); window.removeEventListener('pageshow', wake)
        document.removeEventListener('visibilitychange', wake)
      }
    }
  }

  setStorage(access: SourceStorage | undefined): void {
    if (access?.scope === this.access?.scope && access?.storage === this.access?.storage) return
    ++this.generation; this.ready = false; this.sending.clear()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined; this.entries.clear(); this.staged.clear(); this.sessions.clear(); this.access = access; this.ledger = access ? this.createLedger(access) : undefined
    this.restoring = undefined; this.restoreFailure = undefined; this.sourceRevocations.clear(); ++this.storageRevision
    if (access) this.restoreStorage(true)
    this.publish()
  }

  private restoreStorage(initial = false): void {
    const access = this.access!, ledger = this.ledger!, generation = this.generation, revision = ++this.storageRevision
    const current = new Map<string, StoredDelivery>(), loads: Promise<void>[] = [], prefix = prefixOf(access.scope)
    const mirror = (id: string, value: string | null): void => {
      const key = `${prefix}${encodeURIComponent(id)}`
      if (value === null) access.storage.removeItem(key); else access.storage.setItem(key, journalValue(value))
    }
    const accept = (entry: StoredDelivery): void => {
      if (initial && entry.state === 'sending') entry = Object.freeze({ ...entry, state: 'confirming', retryAt: 0 })
      current.set(entry.operation.operationId, entry)
    }
    try {
      for (let index = 0; index < access.storage.length; index++) {
        const key = access.storage.key(index)
        if (!key?.startsWith(prefix)) continue
        const value = access.storage.getItem(key), entry = decode(value), pointer = reference(value)
        if (entry && key === `${prefix}${encodeURIComponent(entry.operation.operationId)}`) {
          if (!entry.operation.images?.length) accept(entry)
          else loads.push(ledger.transition(entry.operation.operationId, (saved, terminal) => terminal ? null : saved ?? JSON.stringify(entry),
            saved => mirror(entry.operation.operationId, saved)).then(saved => { if (saved) { const canonical = decode(saved); if (!canonical) throw new Error('The saved image message is invalid.'); accept(canonical) } }))
        } else if (pointer && key === `${prefix}${encodeURIComponent(pointer.operationId)}`) {
          loads.push(ledger.read(pointer.operationId).then(saved => {
            if (saved === null) { mirror(pointer.operationId, null); return }
            const canonical = decode(saved)
            if (!canonical || canonical.operation.sessionId !== pointer.sessionId || canonical.operation.operationId !== pointer.operationId) throw new Error('The saved image message could not be restored. No operation was sent.')
            accept(canonical)
          }))
        }
      }
    } catch (error) { this.restoreFailure = error; return }
    const apply = (): void => {
      if (this.disposed || generation !== this.generation || revision !== this.storageRevision) return
      for (const id of this.entries.keys()) if (!current.has(id)) { this.entries.delete(id); this.staged.delete(id) }
      for (const [id, entry] of current) {
        if (entry.operation.kind !== 'send' && entry.attempts === 0 && !this.entries.has(id)) this.staged.add(id)
        this.entries.set(id, entry)
      }
      this.restoreFailure = undefined; this.publish()
    }
    if (!loads.length) { this.restoring = undefined; apply(); this.kick(); return }
    const work = Promise.all(loads).then(apply).catch(error => {
      if (generation === this.generation && revision === this.storageRevision) this.restoreFailure = error
    }).finally(() => { if (this.restoring === work) { this.restoring = undefined; this.publish(); this.kick() } })
    this.restoring = work
  }

  /** A successful authenticated catalog, not cached metadata, admits dispatch. */
  acceptCatalog(sessions: readonly SourceSession[]): void {
    if (this.disposed) return
    if (!this.ready) {
      for (const [id, entry] of this.entries) if (entry.state === 'confirming' || entry.state === 'accepted') this.entries.set(id, Object.freeze({ ...entry, retryAt: 0 }))
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

  /** One restored admission may locate its already-consumed body, never dispatch again. */
  checkOwnerAdmission(operationId: string): Promise<void> {
    const active = this.ownerChecks.get(operationId)
    if (active) return active
    const entry = this.entries.get(operationId), generation = this.generation
    if (!entry || entry.state !== 'owner-accepted' || !this.lookup) return Promise.resolve()
    const work = this.lookup(entry.operation).then(receipt => {
      if (!this.owns(entry, generation) || receipt?.status !== 'accepted' || !receipt.observed
        || receipt.operationId !== operationId || receipt.sessionId !== entry.operation.sessionId) return
      const ownerAdmission = receipt.ownerAdmission ?? entry.receipt?.ownerAdmission
      this.write({ ...this.entries.get(operationId)!, receipt: { ...receipt, ...(ownerAdmission ? { ownerAdmission } : {}) } })
    }).catch(() => { /* Missing proof leaves the exact original pending content intact. */ })
      .finally(() => { if (this.ownerChecks.get(operationId) === work) this.ownerChecks.delete(operationId) })
    this.ownerChecks.set(operationId, work)
    return work
  }
  /** Only the same source's confirmed consumed position can retire an old admission. */
  settleOwnerAdmission(operationId: string): void {
    const entry = this.entries.get(operationId)
    if (entry?.state === 'owner-accepted' && entry.receipt?.status === 'accepted' && entry.receipt.observed) this.remove(operationId, true)
  }

  /** Must finish before the official input commits its draft. No network work occurs here. */
  enqueue(operation: SourceOperation): SourceDelivery {
    if (this.disposed || !this.access) throw new Error('This message could not be saved on this device. Your draft has been kept.')
    if (this.restoring || this.restoreFailure) throw new Error('Saved image messages are still being restored. Your draft has been kept.')
    if (operation.images?.length) throw new Error('Image messages require transactional admission.')
    assertOperation(operation)
    if (['send', 'steer'].includes(operation.kind) && !operation.text?.trim() && !operation.files?.length) throw new Error('Add text or an attachment before sending. Your draft has been kept.')
    const existing = this.entries.get(operation.operationId)
    if (existing) {
      if (fingerprint(existing.operation) !== fingerprint(operation)) throw new Error('An operation ID was reused with different arguments.')
      return existing
    }
    const createdAt = Math.max(Date.now(), ...[...this.entries.values()].map(entry => entry.createdAt + 1))
    const entry: StoredDelivery = Object.freeze({ version: 1, operation: Object.freeze({ ...operation }), createdAt,
      state: 'queued', message: 'Saved on this device. Waiting to send.', attempts: 0, retryAt: 0 })
    const serialized = JSON.stringify(entry)
    const active = [...this.entries.values()].filter(value => value.state !== 'owner-accepted')
    const bytes = active.reduce((size, value) => size + (value.operation.images?.length ? imageReference(value) : JSON.stringify(value)).length * 2, serialized.length * 2)
    if (active.length >= MAX_ENTRIES || bytes > MAX_BYTES) throw new Error('The saved-message queue is full. Your draft has been kept.')
    try { this.persist(operation.operationId, serialized) }
    catch { throw new Error('This message could not be saved on this device. Your draft has been kept.') }
    this.entries.set(operation.operationId, entry); this.staged.add(operation.operationId); this.publish()
    return entry
  }

  /** Image serialization is already asynchronous in the official composer.
   * Finish the existing IndexedDB transaction before accepting its draft. */
  async admit(operation: SourceOperation): Promise<SourceDelivery> {
    if (!operation.images?.length) return this.enqueue(operation)
    const generation = this.generation, access = this.access, ledger = this.ledger
    const sourceRevocation = this.sourceRevocations.get(operation.sessionId)
    const work = this.imageAdmissions.then(async () => {
      await this.restoring
      if (this.disposed || !access || !ledger || generation !== this.generation || sourceRevocation !== this.sourceRevocations.get(operation.sessionId) || this.restoreFailure) throw new Error('The image message could not be saved on this device. Your draft has been kept.')
      assertOperation(operation)
      const existing = this.entries.get(operation.operationId)
      if (existing) {
        if (fingerprint(existing.operation) !== fingerprint(operation)) throw new Error('An operation ID was reused with different arguments.')
        return existing
      }
      const key = this.key(operation.operationId)
      let entry: StoredDelivery
      const saved = await ledger.transition(operation.operationId, (value, terminal) => {
        if (this.disposed || generation !== this.generation || sourceRevocation !== this.sourceRevocations.get(operation.sessionId)) throw new Error('The source was released before this image was saved. Your draft has been kept.')
        if (terminal) throw new Error('This image submission has already been retired.')
        const canonical = decode(value)
        if (canonical) {
          if (fingerprint(canonical.operation) !== fingerprint(operation)) throw new Error('An operation ID was reused with different arguments.')
          entry = canonical
        } else entry = Object.freeze({ version: 1, operation: Object.freeze({ ...operation }),
          createdAt: Math.max(Date.now(), ...[...this.entries.values()].map(value => value.createdAt + 1)),
          state: 'queued', message: 'Saved on this device. Waiting to send.', attempts: 0, retryAt: 0 })
        const active = [...this.entries.values()].filter(value => value.state !== 'owner-accepted')
        const bytes = active.reduce((size, value) => size + (value.operation.images?.length ? imageReference(value) : JSON.stringify(value)).length * 2, imageReference(entry).length * 2)
        if (active.length >= MAX_ENTRIES || bytes > MAX_BYTES) throw new Error('The saved-message queue is full. Your draft has been kept.')
        return JSON.stringify(entry)
      }, value => { if (value === null) access.storage.removeItem(key); else this.persistImageJournal(access, key, value) })
      // A concurrent storage event may have read its snapshot before admission.
      // Apply that snapshot first, then publish this newly committed operation.
      await this.restoring
      if (this.disposed || generation !== this.generation || sourceRevocation !== this.sourceRevocations.get(operation.sessionId)) {
        await ledger.transition(operation.operationId, () => null, () => access.storage.removeItem(key))
        throw new Error('The source account changed before this image was accepted. Your draft has been kept.')
      }
      if (!saved) throw new Error('The image message could not be saved. Your draft has been kept.')
      this.entries.set(operation.operationId, entry!); this.staged.add(operation.operationId); this.publish()
      return entry!
    })
    this.imageAdmissions = work.catch(() => {})
    return work
  }
  /** Explicit operations share the same durable evidence as queued text. */
  async submit(operation: SourceOperation): Promise<SourceReceipt> {
    await this.admit(operation)
    const saved = this.get(operation.operationId)
    if (saved?.receipt && saved.receipt.status !== 'indeterminate' && saved.receipt.retryable !== true) return Promise.resolve(saved.receipt)
    return new Promise((resolve, reject) => {
      const view = this.view(operation.sessionId)
      const check = (): void => {
        const entry = this.get(operation.operationId)
        if (entry && fingerprint(entry.operation) !== fingerprint(operation)) { stop(); reject(new Error('The original operation identity already belongs to different arguments.')); return }
        if (entry?.receipt) { stop(); resolve(entry.receipt) }
        else if (!entry) { stop(); reject(new Error('The saved operation is no longer available.')) }
        else if (entry.state === 'confirming' || entry.operation.kind !== 'send' && entry.state === 'queued' && this.staged.has(entry.operation.operationId)) {
          stop(); resolve({ operationId: operation.operationId, sessionId: operation.sessionId,
            status: 'indeterminate', message: entry.message })
        }
      }
      const stop = view.subscribe(check)
      this.start(operation.operationId); check()
    })
  }
  start(operationId: string): void {
    if (!this.entries.has(operationId)) throw new Error('The saved submission is no longer available.')
    const entry = this.entries.get(operationId)!
    if (entry.operation.kind !== 'send' && entry.attempts === 0 && !this.maySend(entry)) { this.publish(); return }
    this.staged.delete(operationId)
    this.kick()
  }
  retry(operationId: string): void {
    const entry = this.entries.get(operationId)
    if (!entry || entry.state === 'rejected' || entry.state === 'owner-accepted') return
    this.entries.set(operationId, Object.freeze({ ...entry, retryAt: 0 }))
    this.start(operationId)
  }
  /** Explicitly abandoning preparation may only remove work that has never left this device. */
  abandon(operationId: string): void {
    const entry = this.entries.get(operationId)
    if (entry?.state === 'queued' && entry.attempts === 0) this.retireConditional(entry, value => value.attempts === 0)
  }
  discard(operationId: string): void {
    const entry = this.entries.get(operationId)
    if (entry?.state === 'queued' && entry.operation.kind !== 'send' && entry.attempts === 0) { this.abandon(operationId); return }
    if (entry?.state === 'rejected') this.retireConditional(entry, value => value.state === 'rejected' && value.receipt?.retryable !== true)
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
    this.sourceRevocations.set(sessionId, (this.sourceRevocations.get(sessionId) ?? 0) + 1)
    this.sessions.delete(sessionId)
    for (const entry of this.entries.values()) if (entry.operation.sessionId === sessionId) this.remove(entry.operation.operationId, false, true)
    this.retireIndexed(sessionId)
    if (this.restoring) this.restoreStorage()
  }
  clear(): void {
    ++this.generation; this.ready = false; this.sending.clear()
    for (const id of [...this.entries.keys()]) this.remove(id, false, true)
    this.retireIndexed()
    ++this.storageRevision; this.restoring = undefined; this.restoreFailure = undefined
    this.sessions.clear()
  }
  dispose(): void {
    this.disposed = true; ++this.generation
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.listeners.clear(); this.retireListeners.clear(); this.sending.clear(); this.stopWake()
  }
  private key(id: string): string { return `${prefixOf(this.access!.scope)}${encodeURIComponent(id)}` }
  /** Revocation also owns references whose asynchronous payload read is in flight. */
  private retireIndexed(sessionId?: string): void {
    const access = this.access, ledger = this.ledger
    if (!access || !ledger) return
    const keys = Array.from({ length: access.storage.length }, (_, index) => access.storage.key(index))
    for (const key of keys) {
      if (!key?.startsWith(prefixOf(access.scope))) continue
      const raw = access.storage.getItem(key), entry = decode(raw), pointer = reference(raw)
      const id = entry?.operation.operationId ?? pointer?.operationId, owner = entry?.operation.sessionId ?? pointer?.sessionId
      if (!id || sessionId !== undefined && owner !== sessionId) continue
      access.storage.removeItem(key)
      void ledger.transition(id, () => null, () => access.storage.removeItem(key)).catch(() => { console.error('HHPI could not retire a saved image operation.') })
    }
  }
  private remove(id: string, observed: boolean, revoked = false): void {
    if (!this.entries.has(id)) return
    try { this.access?.storage.removeItem(this.key(id)) } catch { if (!revoked) return }
    const access = this.access, key = access ? this.key(id) : undefined
    void this.ledger?.transition(id, () => null, () => { if (access && key) access.storage.removeItem(key) }).catch(() => {})
    this.entries.delete(id); this.staged.delete(id); this.publish()
    for (const listener of this.retireListeners) listener(id, observed)
  }
  private retireConditional(entry: StoredDelivery, eligible: (value: StoredDelivery) => boolean): void {
    const generation = this.generation, access = this.access!, key = this.key(entry.operation.operationId)
    void this.ledger!.transition(entry.operation.operationId, (value, terminal) => {
      if (terminal) return null
      const current = decode(value) ?? entry
      return eligible(current) ? null : JSON.stringify(current)
    }, value => { if (value === null) access.storage.removeItem(key); else this.persistImageJournal(access, key, value) }).then(value => {
      if (generation !== this.generation || this.disposed) return
      if (value === null) {
        this.entries.delete(entry.operation.operationId); this.staged.delete(entry.operation.operationId)
        for (const listener of this.retireListeners) listener(entry.operation.operationId, false)
      } else this.entries.set(entry.operation.operationId, decode(value)!)
      this.publish()
    }).catch(() => { /* Failed storage cannot prove that an admitted intent was abandoned. */ })
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
    try { this.persist(entry.operation.operationId, JSON.stringify(entry)) }
    catch { return false }
    this.entries.set(entry.operation.operationId, Object.freeze(entry)); this.publish(); return true
  }
  private persist(id: string, value: string): void {
    const journal = journalValue(value)
    try { this.access!.storage.setItem(this.key(id), journal); return } catch { /* Reclaim only data whose original owner has accepted durable responsibility. */ }
    for (const receipt of [...this.entries.values()].filter(entry => entry.state === 'owner-accepted').sort((a, b) => a.createdAt - b.createdAt)) this.remove(receipt.operation.operationId, true)
    this.access!.storage.setItem(this.key(id), journal)
  }
  private persistImageJournal(access: SourceStorage, key: string, value: string): void { access.storage.setItem(key, journalValue(value)) }
  private handoff(entry: StoredDelivery, receipt: SourceReceipt): boolean {
    const current = this.entries.get(entry.operation.operationId)
    if (!current || current.createdAt !== entry.createdAt || fingerprint(current.operation) !== fingerprint(entry.operation)
      || receipt.ownerAdmission?.localId !== entry.operation.operationId || receipt.status !== 'accepted') return false
    if (!this.write({ ...entry, state: 'owner-accepted', receipt, message: 'The original execution owner has saved this message. Native execution is reported separately.', retryAt: 0 })) return false
    for (const listener of this.retireListeners) listener(entry.operation.operationId, true)
    // These are viewable receipts for messages owned by the source, not pending
    // local writes. Their independent bounded retention can never evict work
    // whose delivery is still unknown. One maximum-sized submitted text fits.
    const receipts = [...this.entries.values()].filter(value => value.state === 'owner-accepted').sort((a, b) => b.createdAt - a.createdAt)
    let bytes = 0
    for (let index = 0; index < receipts.length; index++) {
      const value = receipts[index]!; bytes += JSON.stringify(value).length * 2
      if (index >= MAX_OWNER_RECEIPTS || index > 0 && bytes > MAX_BYTES) this.remove(value.operation.operationId, true)
    }
    return true
  }
  private owns(entry: StoredDelivery, generation: number): boolean {
    const current = this.entries.get(entry.operation.operationId)
    return generation === this.generation && !this.disposed && current?.createdAt === entry.createdAt && fingerprint(current.operation) === fingerprint(entry.operation)
  }
  private maySend(entry: StoredDelivery): boolean {
    const current = this.sessions.get(entry.operation.sessionId)
    return this.ready && operationRefusal(current, entry.operation) === undefined
  }
  private kick(): void {
    if (!this.ready || !this.access || this.disposed || this.restoring || this.restoreFailure || typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    let next = Infinity
    for (const [sessionId, rows] of this.snapshots) {
      if (this.sending.has(sessionId)) continue
      const session = this.sessions.get(sessionId)
      if (!session) continue
      const entry = (rows.find(value => value.state !== 'accepted' && value.state !== 'rejected' && value.state !== 'owner-accepted')
        ?? (this.readAccepted ? rows.find(value => ['send', 'steer'].includes(value.operation.kind) && value.state === 'accepted' && value.retryAt <= Date.now()) : undefined)) as StoredDelivery | undefined
      if (!entry && this.readAccepted) for (const value of rows) if (['send', 'steer'].includes(value.operation.kind) && value.state === 'accepted') next = Math.min(next, value.retryAt)
      if (!entry) continue
      if (this.staged.has(entry.operation.operationId)) continue
      // Native execution can be offline while the Host still serves its local
      // receipt/history. Only new writes require that execution connection.
      if (sourceIsOffline(session) && entry.attempts === 0) continue
      if (!this.maySend(entry) && entry.state === 'queued' && entry.attempts === 0) {
        this.write({ ...entry, state: 'rejected', message: 'This source no longer permits sending. The saved message is retained.' })
        continue
      }
      if (entry.retryAt > Date.now()) { next = Math.min(next, entry.retryAt); continue }
      const generation = this.generation
      this.sending.add(sessionId)
      void this.dispatch(entry, generation).catch(() => {
        if (this.owns(entry, generation)) this.entries.set(entry.operation.operationId, Object.freeze({ ...entry, retryAt: Date.now() + 5000 }))
      }).finally(() => {
        if (generation !== this.generation) return
        this.sending.delete(sessionId); this.kick()
      })
    }
    if (Number.isFinite(next)) this.timer = setTimeout(() => { this.timer = undefined; this.kick() }, Math.max(50, next - Date.now()))
  }
  private async dispatch(entry: StoredDelivery, generation: number): Promise<void> {
    const ledger = this.ledger!, access = this.access!, key = this.key(entry.operation.operationId)
    let attempt = entry.attempts + 1, firstDispatch = false, conflicting = false
    let claimed = entry
    try {
      // Import the synchronous admission journal and claim dispatch in one
      // transaction. Other tabs may only reconcile an existing attempt.
      const saved = await ledger.transition(entry.operation.operationId, (value, terminal) => {
        if (terminal) return null
        const current = decode(value) ?? entry
        if (fingerprint(current.operation) !== fingerprint(entry.operation)) { conflicting = true; return JSON.stringify(current) }
        firstDispatch = current.attempts === 0; claimed = current; attempt = current.attempts + 1
        return JSON.stringify({ ...current, state: ['accepted', 'owner-accepted', 'rejected'].includes(current.state) ? current.state : firstDispatch ? 'sending' : 'confirming',
          attempts: attempt, message: ['accepted', 'owner-accepted', 'rejected'].includes(current.state) ? current.message : firstDispatch ? 'Sending the saved operation.' : 'Confirming the saved operation.' })
      }, value => { if (value === null) access.storage.removeItem(key); else this.persistImageJournal(access, key, value) })
      if (generation !== this.generation || this.disposed || !this.entries.has(entry.operation.operationId)) return
      if (!saved) { this.entries.delete(entry.operation.operationId); this.publish(); return }
      entry = claimed
      this.entries.set(entry.operation.operationId, decode(saved)!); this.publish()
      if (conflicting || claimed.state === 'owner-accepted' || claimed.state === 'rejected') return
    } catch {
      if (this.owns(entry, generation)) {
        this.entries.set(entry.operation.operationId, Object.freeze({ ...entry, retryAt: Date.now() + 5000,
          message: 'Waiting for device storage before sending.' })); this.publish()
      }
      return
    }
    let state: DeliveryState, message: string, receipt: SourceReceipt | undefined = entry.receipt
    let phase: 'write' | 'lookup' | 'history' = 'lookup'
    try {
      if (!this.owns(entry, generation)) return
      if (!firstDispatch && this.lookup) {
        receipt = await this.lookup(entry.operation) ?? (entry.state === 'accepted' ? entry.receipt : undefined)
      } else if (firstDispatch && entry.state !== 'accepted' && this.maySend(entry)) { phase = 'write'; receipt = await this.send(entry.operation) }
      if (!this.owns(entry, generation)) return
      if (!receipt) {
        state = 'confirming'; message = 'Waiting for a readable receipt. No new native operation was dispatched.'
      } else {
        if (receipt.operationId !== entry.operation.operationId || receipt.sessionId !== entry.operation.sessionId) throw new Error('The source returned an unrelated acknowledgement.')
        if (receipt.status === 'rejected' && receipt.retryable === true && this.maySend(entry) && entry.attempts > 0) { phase = 'write'; receipt = await this.send(entry.operation) }
        if (!this.owns(entry, generation)) return
        if (receipt.operationId !== entry.operation.operationId || receipt.sessionId !== entry.operation.sessionId) throw new Error('The source returned an unrelated acknowledgement.')
        state = receipt.status === 'indeterminate' || receipt.retryable === true ? 'confirming' : receipt.status
        message = receipt.message
        if (receipt.status === 'accepted' && receipt.ownerAdmission?.localId === entry.operation.operationId) {
          const acknowledged: StoredDelivery = { ...entry, attempts: attempt, receipt, state: 'owner-accepted', retryAt: 0 }
          const durable = await ledger.transition(entry.operation.operationId, (_, terminal) => terminal ? null : JSON.stringify(acknowledged), value => { if (value === null) access.storage.removeItem(key); else this.handoff(acknowledged, receipt!) })
          if (!durable || !this.owns(entry, generation)) return
          return
        }
        if (receipt.status === 'accepted' && ['send', 'steer'].includes(entry.operation.kind) && this.readAccepted) {
          phase = 'history'
          const entries = await this.readAccepted(entry.operation, receipt)
          if (this.owns(entry, generation)) this.observe(entry.operation.sessionId, entries)
        }
      }
    } catch (error) {
      const details = error && typeof error === 'object' && 'details' in error ? (error as { details?: { sourceCode?: string; outcome?: string } }).details : undefined
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined
      const unauthorized = code === 'gateway/internal' && error instanceof Error
        && /^client api: hhpi\/(?:operate|receipt|read) failed: /.test(error.message) && /HTTP (?:401|403)\b/.test(error.message)
      if (unauthorized && generation === this.generation) this.ready = false
      const permanent = code === 'remote-access/denied' || details?.outcome === 'rejected' && ['UNSUPPORTED', 'INVALID_REQUEST', 'FORBIDDEN', 'unsupported'].includes(details.sourceCode ?? '')
      if (permanent && phase !== 'write' && generation === this.generation) this.ready = false
      state = entry.state === 'accepted' || receipt?.status === 'accepted' ? 'accepted' : permanent && phase === 'write' ? 'rejected' : 'confirming'
      message = unauthorized ? 'Waiting for authenticated access. The saved message keeps its original identity.'
        : permanent && phase !== 'write' ? 'Receipt access is not available. The original message is retained for confirmation.'
          : permanent && error instanceof Error ? error.message : 'Waiting to confirm delivery. The saved message will keep the same identity.'
    }
    if (!this.owns(entry, generation)) return
    const retryAt = state === 'confirming' || state === 'accepted' ? Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)) + Math.floor(Math.random() * 250) : 0
    // If storage filled after dispatch, keep the original durable uncertainty
    // marker. A later retry/reload reconciles it; no new identity is invented.
    try {
      const saved = await ledger.transition(entry.operation.operationId, (value, terminal) => {
        if (terminal) return null
        const prior = decode(value)
        if (prior && (prior.state === 'owner-accepted' || prior.receipt?.status === 'accepted' && receipt?.status !== 'accepted')) return JSON.stringify(prior)
        return JSON.stringify({ ...entry, attempts: Math.max(attempt, prior?.attempts ?? 0), state, message, retryAt, ...(receipt ? { receipt } : {}) })
      }, value => {
        if (value === null) access.storage.removeItem(key); else this.persistImageJournal(access, key, value)
      })
      if (!this.owns(entry, generation)) return
      if (saved) this.entries.set(entry.operation.operationId, decode(saved)!)
      else this.entries.delete(entry.operation.operationId)
      this.publish()
    } catch {
      if (this.owns(entry, generation)) {
        this.entries.set(entry.operation.operationId, Object.freeze({ ...entry, attempts: attempt, state: 'confirming',
          message: 'Delivery is waiting for confirmation; device storage is full.', retryAt: Date.now() + 5000 })); this.publish()
      }
    }
  }
}
