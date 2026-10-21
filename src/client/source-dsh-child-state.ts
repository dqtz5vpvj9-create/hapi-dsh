import { z } from 'zod'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { sourceDshChildStateSchema, type SourceDshChildState } from '../hapi-agent/dsh-child-types.ts'

export type SourceDshChildApi = Pick<HapiRemoteApi, 'sourceDshChild' | 'sourceDshChildRefresh' | 'sourceDshChildInterrupt'>
export interface SourceDshChildStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
interface Snapshot { data: SourceDshChildState | null; pendingInterrupt: string | null; busy: boolean; reading: boolean; error: string | null }
const pendingSchema = z.object({ version: z.literal(1), operationId: z.string().min(1).max(128) })
const explanation = (error: unknown) => error instanceof Error ? error.message : 'The original child operation could not be confirmed'

/** Browser recovery retains the interrupt identity; only the explicit button can POST. */
export class SourceDshChildController {
  private snapshot: Snapshot = { data: null, pendingInterrupt: null, busy: false, reading: false, error: null }
  private readonly listeners = new Set<() => void>()
  private reading: Promise<void> | undefined
  private storageKey: string | undefined
  private recoveryFault: string | null = null
  private readonly nextId: () => string
  constructor(private readonly api: SourceDshChildApi, readonly sessionId: string,
    private readonly storage: SourceDshChildStorage | undefined, nextId?: () => string) { this.nextId = nextId ?? (() => crypto.randomUUID()) }
  getSnapshot = (): Snapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(change: Partial<Snapshot>): void { this.snapshot = { ...this.snapshot, ...change }; for (const listener of this.listeners) listener() }
  observe(input: SourceDshChildState): void {
    const data = sourceDshChildStateSchema.parse(input)
    if (data.sessionId !== this.sessionId) throw new Error('The child response belongs to a different display generation')
    const key = `hapi-dsh:child-interrupt:v1:${encodeURIComponent(JSON.stringify([data.hubId, data.sourceSessionId, data.parentDshSessionId, data.childDshSessionId, data.machineId, data.descriptor.createdAt]))}`
    if (this.storageKey && this.storageKey !== key) throw new Error('The source child owner changed; this local intent must not be retargeted')
    let pendingInterrupt = this.snapshot.pendingInterrupt
    if (!this.storageKey) {
      this.storageKey = key
      try { const saved = this.storage?.getItem(key); if (saved) pendingInterrupt = pendingSchema.parse(JSON.parse(saved)).operationId }
      catch (error) { this.recoveryFault = `The original interrupt recovery record could not be read: ${explanation(error)}`; this.publish({ error: this.recoveryFault }) }
    }
    const receipt = pendingInterrupt ? data.receipts.find(value => value.operationId === pendingInterrupt) : undefined
    if (receipt?.status === 'accepted' || receipt?.status === 'rejected') {
      pendingInterrupt = null
      try { this.storage?.removeItem(key) } catch { /* A later read can clear this already acknowledged local intent. */ }
    }
    if (JSON.stringify(data) !== JSON.stringify(this.snapshot.data) || pendingInterrupt !== this.snapshot.pendingInterrupt) this.publish({ data, pendingInterrupt })
  }
  refresh = (source = true): Promise<void> => {
    if (this.reading) return this.reading
    this.publish({ reading: true })
    const task = (async () => {
      try {
        this.observe(remoteValue(await (source ? this.api.sourceDshChildRefresh({ sessionId: this.sessionId }) : this.api.sourceDshChild({ sessionId: this.sessionId }))))
        this.publish({ error: this.recoveryFault })
      } catch (error) { this.publish({ error: explanation(error) }) }
      finally { this.reading = undefined; this.publish({ reading: false }) }
    })()
    this.reading = task; return task
  }
  interrupt = async (): Promise<void> => {
    const state = this.snapshot
    if (!state.data || state.data.readOnly || state.data.descriptor.activity !== 'running' || state.busy || state.pendingInterrupt || this.recoveryFault) return
    const operationId = this.nextId()
    try {
      if (!this.storage || !this.storageKey) throw new Error('Browser recovery storage is unavailable; the child interrupt was not sent')
      this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, operationId }))
    } catch (error) { this.publish({ error: explanation(error) }); return }
    this.publish({ pendingInterrupt: operationId, busy: true, error: null })
    try { this.observe(remoteValue(await this.api.sourceDshChildInterrupt({ sessionId: this.sessionId, operationId }))) }
    catch (error) { this.publish({ error: explanation(error) }) }
    finally { this.publish({ busy: false }) }
  }
  /** Closing local waiting never changes an unknown source receipt or sends again. */
  closeInactiveIntent = (): void => {
    if (!this.snapshot.pendingInterrupt || this.snapshot.busy || this.snapshot.data?.descriptor.activity !== 'inactive' || !this.storageKey) return
    try { this.storage?.removeItem(this.storageKey); this.publish({ pendingInterrupt: null }) }
    catch (error) { this.publish({ error: explanation(error) }) }
  }
}
