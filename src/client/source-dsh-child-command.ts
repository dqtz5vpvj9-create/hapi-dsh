import { randomId } from './random-id.ts'
import { z } from 'zod'
import { remoteValue } from '../client-api.ts'
import { sourceDshChildCommandIdSchema, sourceDshChildStateSchema, type SourceDshChildState } from '../hapi-agent/dsh-child-types.ts'
import type { SourceDshChildApi, SourceDshChildStorage } from './source-dsh-child-state.ts'

export interface SourceChildCommandRequest {
  requestId: string; childSessionId: string; parentSessionId: string; text: string; delivery: 'queue' | 'steer'
}
export type SourceChildCommandReply = { ok: true; messageId: string } | { ok: false; code: string; message: string }
export type SourceChildCommandSubmit = (request: SourceChildCommandRequest) => Promise<SourceChildCommandReply>
const intentSchema = z.object({ requestId: sourceDshChildCommandIdSchema, text: z.string().min(1).max(100_000),
  delivery: z.enum(['queue', 'steer']), status: z.enum(['sending', 'unknown', 'admitted', 'rejected']), createdAt: z.number() })
export type SourceChildCommandIntent = z.infer<typeof intentSchema>
const savedSchema = z.object({ version: z.literal(1), pending: intentSchema.nullable() })
interface Snapshot { pending: SourceChildCommandIntent | null; busy: boolean; error: string | null }
const explanation = (error: unknown) => error instanceof Error ? error.message : 'The original child acknowledgement was not received'
const knownRefusals = new Set(['gateway/bad-request', 'subagent/attachment-invalid', 'subagent/invalid-time-zone',
  'subagent/not-resumable', 'subagent/unauthorized', 'subagent/delivery-unavailable', 'subagent/parent-unavailable'])

/**
 * Explicit /child command admission. It never enters the official default
 * composer sink, whose echo cannot correlate HAPI's neutral child transcript.
 * A lost browser reply is read by the exact local command id, never replayed.
 */
export class SourceDshChildCommand {
  private snapshot: Snapshot = { pending: null, busy: false, error: null }
  private readonly listeners = new Set<() => void>()
  private source: SourceDshChildState | undefined
  private key: string | undefined
  private savedRaw: string | null = null
  private fault: string | null = null
  constructor(readonly sessionId: string, private readonly api: Pick<SourceDshChildApi, 'sourceDshChildRefresh'>,
    private readonly send: SourceChildCommandSubmit, private readonly storage: SourceDshChildStorage | undefined,
    private readonly newId: () => string = () => randomId()) {}
  getSnapshot = (): Snapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: Partial<Snapshot>): void { this.snapshot = { ...this.snapshot, ...value }; for (const listener of this.listeners) listener() }
  observe(input: SourceDshChildState): void {
    const source = sourceDshChildStateSchema.parse(input)
    if (source.sessionId !== this.sessionId) throw new Error('The original child display generation changed')
    const key = `hapi-dsh:child-command:v1:${encodeURIComponent(JSON.stringify([source.hubId, source.sourceSessionId,
      source.parentDshSessionId, source.childDshSessionId, source.machineId, source.descriptor.createdAt]))}`
    if (this.key && this.key !== key) throw new Error('The original child owner changed; the retained command cannot be retargeted')
    this.source = source
    if (!this.key) {
      this.key = key
      try {
        this.savedRaw = this.storage?.getItem(key) ?? null
        const pending = this.savedRaw ? savedSchema.parse(JSON.parse(this.savedRaw)).pending : null
        this.publish({ pending: pending?.status === 'sending' ? { ...pending, status: 'unknown' } : pending })
      } catch (error) { this.fault = `The original child command recovery record is unreadable: ${explanation(error)}`; this.publish({ error: this.fault }) }
    }
    const pending = this.snapshot.pending
    if (pending && source.receipts.some(receipt => receipt.clientRequestId === pending.requestId
      && receipt.kind === 'prompt' && receipt.text === pending.text && receipt.delivery === pending.delivery)) {
      // A local durable receipt exists, even if the source's result is unknown
      // or rejected. This says nothing about execution or transcript identity.
      if (pending.status !== 'admitted') this.write({ ...pending, status: 'admitted' })
    }
  }
  private write(pending: SourceChildCommandIntent | null): boolean {
    try {
      if (this.fault) throw new Error(this.fault)
      if (!this.storage || !this.key) throw new Error('Browser recovery storage is unavailable; nothing has been sent')
      if (this.storage.getItem(this.key) !== this.savedRaw) throw new Error('Another view changed this original child command. Reopen the child to read its retained intent.')
      const raw = JSON.stringify({ version: 1, pending })
      this.storage.setItem(this.key, raw)
      if (this.storage.getItem(this.key) !== raw) throw new Error('The original child command identity could not be retained')
      this.savedRaw = raw; this.publish({ pending }); return true
    } catch (error) { this.fault = explanation(error); this.publish({ error: this.fault }); return false }
  }
  inspect = async (): Promise<void> => {
    try { this.observe(remoteValue(await this.api.sourceDshChildRefresh({ sessionId: this.sessionId }))) }
    catch (error) { this.publish({ error: explanation(error) }) }
  }
  async submit(text: string, delivery: 'queue' | 'steer'): Promise<{ kind: 'success' | 'error'; text?: string }> {
    const failure = (message: string) => { this.publish({ error: message }); return { kind: 'error' as const, text: message } }
    if (this.snapshot.busy) return failure('An original child command is already being submitted')
    if (!text.trim() || text.length > 100_000) return failure('Enter 1–100000 characters for the original child')
    if (this.fault) return failure(this.fault)
    if (this.snapshot.pending) {
      await this.inspect()
      const pending = this.snapshot.pending
      if (pending && (pending.text !== text || pending.delivery !== delivery)) return failure('A different child command is retained. Read it or explicitly close its local waiting before starting a new task.')
      if (pending?.status === 'admitted') {
        if (!this.write(null)) return failure(this.snapshot.error ?? 'The retained command could not be settled locally')
        return { kind: 'success', text: 'The original command is already recorded by this Host. Its source receipt remains visible; it was not sent again.' }
      }
      if (pending && pending.status !== 'rejected') return failure('The command result is unknown. This action only checked its original identity and did not send again. Read the original receipt or explicitly close local waiting.')
    }
    const source = this.source
    if (!source || source.readOnly || source.descriptor.mode !== 'continuable') return failure(source?.unavailableReason ?? 'The original child is not currently writable')
    const pending: SourceChildCommandIntent = { requestId: sourceDshChildCommandIdSchema.parse(`hapi-source-child:${this.newId()}`),
      text, delivery, status: 'sending', createdAt: Date.now() }
    if (!this.write(pending)) return failure(this.snapshot.error ?? 'The original command identity could not be saved')
    this.publish({ busy: true, error: null })
    try {
      const result = await this.send({ requestId: pending.requestId, childSessionId: this.sessionId, parentSessionId: source.parentSessionId, text, delivery })
      if (result.ok) {
        if (!this.write(null)) return failure(this.snapshot.error ?? 'The Host retained this command; local settlement is unavailable')
        void this.inspect()
        return { kind: 'success', text: 'The Host saved this original child command. Source acceptance and completion are shown separately in its receipts.' }
      }
      this.write({ ...pending, status: knownRefusals.has(result.code) ? 'rejected' : 'unknown' })
      return failure(result.message)
    } catch (error) {
      this.write({ ...pending, status: 'unknown' }); await this.inspect()
      if (this.snapshot.pending?.status === 'admitted') {
        if (!this.write(null)) return failure(this.snapshot.error ?? 'The retained command could not be settled locally')
        return { kind: 'success', text: 'The lost acknowledgement was recovered from the original durable command receipt. Nothing was sent again.' }
      }
      return failure(`${explanation(error)}. The original identity is retained; further checks only read and will not resend it.`)
    } finally { this.publish({ busy: false }) }
  }
  /** Explicit local abandonment is not source cancellation or proof of failure. */
  closeWaiting = (): void => { if (!this.snapshot.busy) { if (this.write(null)) this.publish({ error: null }) } }
}
