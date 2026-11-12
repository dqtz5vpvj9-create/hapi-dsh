/** One durable native creation intent, separate from any mounted creation form. */
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { parseSourceSessionId, sourceSessionId, type SourceCatalog, type SourceCreateRequest, type SourceCreationReceipt, type SourceIdentity, type SourceSession } from '../remote/protocol.ts'
import { randomId } from './random-id.ts'
import { RemoteOperationLedger, type OperationTransactions } from './remote-operation-ledger.ts'
import { onSourceStorageClear, type SourceStorage } from './remote-storage.ts'

type CreationSource = SourceCatalog['sources'][number]
export interface RemoteCreationRecord {
  version: 1
  source: Pick<CreationSource, 'id' | 'machineId' | 'engine'>
  request: SourceCreateRequest
  phase: 'prepared' | 'dispatching' | 'confirming' | 'accepted' | 'rejected'
  message: string
  target?: SourceIdentity & { id: string }
}
export interface RemoteCreationState { record: RemoteCreationRecord | null; busy: boolean; loading: boolean; error: string | null }
interface CreationOptions { intent?: string; createLedger?: (access: SourceStorage) => OperationTransactions; operationId?: () => string }
export const creationStoragePrefix = (scope: string): string => `hhpi:creation:v1:${scope}:`
const validTarget = (source: RemoteCreationRecord['source'], target: SourceIdentity & { id: string }): boolean => target.sourceId === source.id
  && target.machineId === source.machineId && target.engine === source.engine && target.id === sourceSessionId(target)
function decode(raw: string): RemoteCreationRecord {
  const value = JSON.parse(raw) as RemoteCreationRecord
  if (value.version !== 1 || !value.request.operationId || value.request.sourceId !== value.source.id
    || !['prepared', 'dispatching', 'confirming', 'accepted', 'rejected'].includes(value.phase)
    || value.target && !validTarget(value.source, value.target)) throw new Error('The saved native creation cannot be restored. Nothing was sent.')
  return value
}
export class RemoteCreationController {
  private state: RemoteCreationState = { record: null, busy: false, loading: true, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly ledger: OperationTransactions | undefined
  private readonly id: string
  private readonly key: string | undefined
  private readonly restored: Promise<void>
  private readonly stop: () => void
  private generation = 0
  private disposed = false
  constructor(private readonly api: Pick<HhpiRemoteApi, 'create' | 'catalog' | 'resolve'>, private readonly access: SourceStorage | undefined,
    private readonly options: CreationOptions = {}) {
    this.id = JSON.stringify(['source-creation', options.intent ?? 'create'])
    this.key = access ? creationStoragePrefix(access.scope) + encodeURIComponent(this.id) : undefined
    this.ledger = access ? options.createLedger?.(access) ?? new RemoteOperationLedger(access) : undefined
    this.stop = access ? onSourceStorageClear(access.storage, () => this.dispose()) : () => {}
    this.restored = this.restore()
    void this.restored.catch(() => {})
  }
  getSnapshot = (): RemoteCreationState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(patch: Partial<RemoteCreationState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener()
  }
  async ready(): Promise<void> { await this.restored }
  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) throw new Error('The authenticated creation scope changed. Its original request was not resent.')
  }
  private async restore(): Promise<void> {
    const generation = this.generation
    try {
      if (!this.access || !this.ledger) throw new Error('Authenticated native creation storage is not connected.')
      const raw = await this.ledger.read(this.id)
      this.assertCurrent(generation)
      this.publish({ record: raw ? decode(raw) : null, loading: false, error: null })
    } catch (error) { this.publish({ loading: false, error: error instanceof Error ? error.message : 'Creation storage is unavailable.' }) }
  }
  private mirror = (value: string | null): void => {
    if (!this.access || !this.key) throw new Error('Authenticated creation storage is unavailable. Nothing was sent.')
    if (value === null) this.access.storage.removeItem(this.key)
    else this.access.storage.setItem(this.key, JSON.stringify({ version: 1, id: this.id }))
  }
  async start(source: CreationSource, cwd: string, newAttempt = false): Promise<RemoteCreationRecord | null> {
    await this.ready()
    if (this.state.busy || this.disposed) return null
    const generation = this.generation
    this.publish({ busy: true, error: null })
    try {
      if (!this.ledger || !source.create || !source.online) throw new Error('Choose an online source that supports native creation.')
      if (!cwd.trim()) throw new Error('Enter a working directory on the selected source.')
      const candidate: RemoteCreationRecord = { version: 1, source: { id: source.id, machineId: source.machineId, engine: source.engine },
        request: { sourceId: source.id, cwd: cwd.trim(), operationId: this.options.operationId?.() ?? randomId() }, phase: 'prepared', message: 'Saved on this device.' }
      const prepared = await this.ledger.transition(this.id, (raw, terminal) => {
        this.assertCurrent(generation)
        // A cleared account disposes this instance. A fresh authenticated form
        // may admit a new explicit user request with a new operation identity.
        if (terminal) return JSON.stringify(candidate)
        if (raw) {
          const previous = decode(raw)
          if (!['accepted', 'rejected'].includes(previous.phase) || !newAttempt) {
            if (previous.source.id !== source.id || previous.source.machineId !== source.machineId || previous.source.engine !== source.engine || previous.request.cwd !== candidate.request.cwd) {
              throw new Error('Confirm the original creation before changing its source or directory.')
            }
            return raw
          }
          if (previous.request.operationId === candidate.request.operationId) throw new Error('A new creation attempt requires a new operation identity.')
        }
        return JSON.stringify(candidate)
      }, this.mirror)
      this.assertCurrent(generation)
      if (!prepared) return null
      let claimed = false
      const raw = await this.ledger.transition(this.id, (value, terminal) => {
        this.assertCurrent(generation)
        if (!value || terminal) return null
        const current = decode(value)
        claimed = current.phase === 'prepared'
        return claimed ? JSON.stringify({ ...current, phase: 'dispatching', message: 'Creating the native conversation.' }) : value
      }, this.mirror)
      this.assertCurrent(generation)
      if (!raw) return null
      const record = decode(raw); this.publish({ record })
      return claimed ? await this.callOriginal(record, generation) : record
    } catch (error) { this.publish({ error: error instanceof Error ? error.message : 'The native creation could not be submitted.' }); return null }
    finally { this.publish({ busy: false }) }
  }
  /** v1 has one creation carrier: explicit recovery repeats the exact original
   * request to the source ledger, which must not run an uncertain native start. */
  async recover(): Promise<RemoteCreationRecord | null> {
    await this.ready()
    if (this.state.busy || this.disposed || !this.ledger) return null
    const generation = this.generation
    this.publish({ busy: true, error: null })
    try {
      const raw = await this.ledger.read(this.id)
      this.assertCurrent(generation)
      if (!raw) return null
      const record = decode(raw); this.publish({ record })
      if (record.phase === 'prepared' || record.phase === 'accepted' || record.phase === 'rejected') return record
      return await this.callOriginal(record, generation)
    } catch (error) { this.publish({ error: error instanceof Error ? error.message : 'The original creation receipt is unavailable.' }); return null }
    finally { this.publish({ busy: false }) }
  }
  private async callOriginal(original: RemoteCreationRecord, generation: number): Promise<RemoteCreationRecord | null> {
    this.assertCurrent(generation)
    let response: SourceCreationReceipt
    try {
      const result = await this.api.create(original.request)
      if (!result.ok) throw result.error
      response = result.value
    } catch { response = { sourceId: original.request.sourceId, operationId: original.request.operationId, status: 'indeterminate', message: 'The creation result is unknown. Check the original request; no replacement conversation will be started.' } }
    this.assertCurrent(generation)
    if (response.sourceId !== original.request.sourceId || response.operationId !== original.request.operationId) throw new Error('The source returned a different creation receipt. The original request remains unconfirmed.')
    const session = response.session
    const target = session ? { ...parseSourceSessionId(session.id), id: session.id } : undefined
    if (target && !validTarget(original.source, target)) throw new Error('The source returned a creation target on another machine. The original request remains unconfirmed.')
    const record: RemoteCreationRecord = { ...original, phase: response.status === 'indeterminate' || response.status === 'accepted' && !target ? 'confirming' : response.status,
      message: response.message, ...(target ? { target } : {}) }
    const raw = await this.ledger!.transition(this.id, (value, terminal) => {
      this.assertCurrent(generation)
      if (terminal || !value) return null
      const current = decode(value)
      return current.request.operationId !== original.request.operationId || ['accepted', 'rejected'].includes(current.phase) ? value : JSON.stringify(record)
    }, this.mirror)
    this.assertCurrent(generation)
    if (!raw) return null
    const saved = decode(raw); this.publish({ record: saved }); return saved
  }
  /** Resolves the exact returned identity, never a title/cwd match. No create call occurs here. */
  async resolveTarget(): Promise<SourceSession> {
    await this.ready()
    const generation = this.generation, target = this.state.record?.target
    if (!target || this.state.record?.phase !== 'accepted') throw new Error('The original creation has no confirmed target yet.')
    const response = this.api.resolve ? await this.api.resolve({ sessionId: target.id }) : await this.api.catalog()
    this.assertCurrent(generation)
    if (!response.ok) throw new Error(response.error.message)
    const value = response.value
    const session = 'sessions' in value ? value.sessions.find(row => row.id === target.id) : value
    if (!session || session.id !== target.id || sourceSessionId(session) !== target.id) throw new Error('The created conversation is not readable at its exact source yet. Its original receipt has been kept.')
    return session
  }
  dispose(): void { this.disposed = true; ++this.generation; this.stop(); this.listeners.clear() }
}
