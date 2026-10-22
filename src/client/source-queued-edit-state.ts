import { randomId } from './random-id.ts'
import { z } from 'zod'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { sourceQueuedEditReceiptSchema, sourceQueuedEditRequestSchema, type SourceQueuedEditReceipt, type SourceQueuedEditRequest } from '../codex/queued-edit-types.ts'
import type { ScheduleDraftCapture, ScheduleStorage } from './schedule-draft.ts'

export interface QueuedEditComposer { viewId: string; draft: string; draftRev: number; attachmentIds: readonly string[]; phase: string }
export interface QueuedEditCapture { composer: QueuedEditComposer; schedule: ScheduleDraftCapture }
export function queuedEditComposerMatches(before: QueuedEditComposer, current: QueuedEditComposer): boolean {
  return before.viewId === current.viewId && before.phase === 'plain' && current.phase === 'plain'
    && before.draft === current.draft && before.draftRev === current.draftRev
    && before.attachmentIds.length === current.attachmentIds.length && before.attachmentIds.every((id, index) => id === current.attachmentIds[index])
}
type Api = Pick<HapiRemoteApi, 'sourceQueuedEdit' | 'sourceQueuedEditRead' | 'sourceQueuedEdits'>
export interface QueuedEditTarget {
  capture(messageId?: string): QueuedEditCapture
  restore(receipt: SourceQueuedEditReceipt, before: QueuedEditCapture, mode?: 'empty' | 'append'): { ok: true } | { ok: false; reason: string }
}
/** Automatic restoration must never overwrite an existing draft. A separate
 * explicit Append action can preserve it and add the cancelled text. */
export function queuedEditRestoreDraft(current: Pick<QueuedEditComposer, 'draft' | 'attachmentIds' | 'phase'> & Partial<Pick<InputState, 'occurrences'>>, text: string, mode: 'empty' | 'append' = 'empty'): { ok: true; text: string } | { ok: false; reason: string } {
  if (current.phase !== 'plain') return { ok: false, reason: 'Finish the current submission before recovering a cancelled message. Your draft was kept.' }
  if (mode === 'empty' && (current.draft.length > 0 || current.attachmentIds.length > 0 || current.occurrences?.length)) return { ok: false,
    reason: 'Your existing draft, references and attachments were kept. Clear the composer to restore, or explicitly append the cancelled message below.' }
  return { ok: true, text: mode === 'append' && current.draft ? `${current.draft}\n\n${text}` : text }
}
/** The public insertion face preserves reference identities and attachment
 * ownership. setDraft would turn existing chips into plain clipboard text. */
export function queuedEditInsertDraft(
  current: Pick<InputState, 'draft' | 'draftRev' | 'attachmentIds' | 'phase' | 'occurrences' | 'claim'>,
  text: string,
  actions: Pick<InputActions, 'captureInsertion' | 'insertText' | 'persistDraft'>,
  mode: 'empty' | 'append' = 'empty',
): { ok: true } | { ok: false; reason: string } {
  const restored = queuedEditRestoreDraft(current, text, mode)
  if (!restored.ok) return restored
  const captured = actions.captureInsertion()
  const refused = { ok: false as const, reason: 'The composer changed or is locked. Your draft, references and attachments were kept; the cancelled message remains below for explicit recovery.' }
  if (captured.draftRev !== current.draftRev) return refused
  // InputState uses clipboard offsets; public edit spans use one detect cell
  // per chip. Append must ignore an existing selection, including one over a
  // reference, and insert a zero-width span after the complete document.
  const end = current.draft.length - current.occurrences.reduce((sum, reference) => sum + reference.length - 1, 0)
    - (current.claim ? current.claim.token.trimEnd().length - 1 : 0)
  if (!actions.insertText(restored.text.slice(current.draft.length), { start: end, end, draftRev: captured.draftRev })) return refused
  actions.persistDraft()
  return { ok: true }
}
const captureSchema = z.object({ composer: z.object({ viewId: z.string(), draft: z.string().max(2_000_000), draftRev: z.number(), attachmentIds: z.array(z.string()), phase: z.string() }),
  schedule: z.object({ key: z.string(), raw: z.string().nullable(), replaceIntentMessageId: z.string().nullable() }) })
const attemptSchema = z.object({ request: sourceQueuedEditRequestSchema, capture: captureSchema, restored: z.boolean() })
type Attempt = z.infer<typeof attemptSchema>
const savedSchema = z.object({ version: z.literal(1), attempts: z.array(attemptSchema) })
interface Snapshot { receipts: readonly SourceQueuedEditReceipt[]; pending: readonly SourceQueuedEditRequest[]; restored: readonly string[]; busy: boolean; loaded: boolean; error: string | null }
export interface QueuedEditOwner { hubId: string; sourceSessionId: string; logicalSessionId: string }
const describe = (error: unknown): string => error instanceof Error ? error.message : 'The original queue edit could not be confirmed'

/** One explicit cancellation, then source-proof plus editor CAS. No replacement send. */
export class SourceQueuedEditController {
  private snapshot: Snapshot = { receipts: [], pending: [], restored: [], busy: false, loaded: false, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly automatic = new Set<string>()
  private readonly receipts = new Map<string, SourceQueuedEditReceipt>()
  private storageFault: string | null = null
  private savedRaw: string | null = null
  constructor(private readonly api: Api, readonly sessionId: string, private readonly storage: ScheduleStorage | undefined,
    private readonly key: string, private readonly target: QueuedEditTarget, private readonly nextId: () => string = () => randomId(),
    private readonly owner?: QueuedEditOwner) {
    try {
      this.savedRaw = storage?.getItem(key) ?? null
      if (this.savedRaw) for (const value of savedSchema.parse(JSON.parse(this.savedRaw)).attempts) {
        if (value.request.sessionId !== sessionId) throw new Error('The saved queue edit belongs to a different display generation')
        this.attempts.set(value.request.operationId, value)
      }
    } catch (error) { this.storageFault = `Queue edit recovery could not be read: ${describe(error)}` }
    this.publish({ error: this.storageFault })
  }
  getSnapshot = (): Snapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: Partial<Snapshot> = {}): void {
    this.snapshot = { ...this.snapshot, receipts: [...this.receipts.values()].sort((a, b) => b.createdAt - a.createdAt),
      pending: [...this.attempts.values()].filter(value => !this.receipts.has(value.request.operationId)).map(value => value.request),
      restored: [...this.attempts.values()].filter(value => value.restored).map(value => value.request.operationId), ...value }
    for (const listener of this.listeners) listener()
  }
  private persist(): void {
    if (this.storageFault) throw new Error(this.storageFault)
    if (!this.storage) throw new Error('Browser recovery storage is unavailable. The original queue has not been changed.')
    if (this.storage.getItem(this.key) !== this.savedRaw) throw new Error('Another view changed the saved queue edit. Reopen this view to read its original intent.')
    const raw = JSON.stringify({ version: 1, attempts: [...this.attempts.values()] })
    this.storage.setItem(this.key, raw)
    if (this.storage.getItem(this.key) !== raw) throw new Error('The original edit identity could not be saved')
    this.savedRaw = raw
  }
  private observe(input: SourceQueuedEditReceipt): SourceQueuedEditReceipt {
    const receipt = sourceQueuedEditReceiptSchema.parse(input)
    if (this.owner && (receipt.hubId !== this.owner.hubId || receipt.sourceSessionId !== this.owner.sourceSessionId || receipt.logicalSessionId !== this.owner.logicalSessionId)) {
      throw new Error('The original edit receipt belongs to another source owner')
    }
    if (receipt.sessionId !== this.sessionId && !this.owner) throw new Error('The original edit receipt belongs to a different display generation')
    const previous = this.receipts.get(receipt.operationId)
    if (previous && (previous.status === 'invoked' && receipt.status !== 'invoked'
      || receipt.status !== 'invoked' && receipt.updatedAt < previous.updatedAt
      || previous.proof !== null && ['unknown', 'submitting'].includes(receipt.status))) return previous
    this.receipts.set(receipt.operationId, receipt); this.publish(); return receipt
  }
  load = async (): Promise<void> => {
    try {
      for (const value of remoteValue(await this.api.sourceQueuedEdits({ sessionId: this.sessionId }))) this.observe(value)
      for (const value of this.attempts.values()) if (!this.receipts.has(value.request.operationId)) await this.read(value.request.operationId, false)
      this.publish({ loaded: true })
    } catch (error) { this.publish({ loaded: true, error: describe(error) }) }
  }
  start = async (localId: string, messageId?: string): Promise<void> => {
    if (this.snapshot.busy) return
    this.publish({ busy: true, error: null })
    let attempt: Attempt | undefined
    try {
      if (this.storageFault) throw new Error(this.storageFault)
      const unresolved = [...this.attempts.values()].find(value => value.request.localId === localId && !value.restored
        && (!this.receipts.has(value.request.operationId) || ['submitting', 'unknown'].includes(this.receipts.get(value.request.operationId)!.status)))
      if (unresolved) { await this.read(unresolved.request.operationId); return }
      const request = sourceQueuedEditRequestSchema.parse({ sessionId: this.sessionId, operationId: this.nextId(), localId })
      attempt = { request, capture: captureSchema.parse(this.target.capture(messageId)), restored: false }
      this.attempts.set(request.operationId, attempt)
      try { this.persist() } catch (error) { this.attempts.delete(request.operationId); throw error }
      this.automatic.add(request.operationId); this.publish()
      try { this.observe(remoteValue(await this.api.sourceQueuedEdit(request))) }
      catch (error) { this.publish({ error: `${describe(error)}. The same edit identity is retained; further checks only read.` }); await this.read(request.operationId, false) }
      this.restoreIfCurrent(request.operationId)
    } catch (error) { this.publish({ error: describe(error) }) }
    finally { this.publish({ busy: false }) }
  }
  read = async (operationId: string, allowAutomatic = true): Promise<void> => {
    try {
      const value = remoteValue(await this.api.sourceQueuedEditRead({ sessionId: this.sessionId, operationId }))
      if (value) { this.observe(value); if (allowAutomatic) this.restoreIfCurrent(operationId) }
      else this.publish({ error: 'No durable Host receipt is visible yet. The cancellation may still be in flight; it has not been repeated.' })
    } catch (error) { this.publish({ error: describe(error) }) }
  }
  private restoreIfCurrent(operationId: string): void {
    const attempt = this.attempts.get(operationId), receipt = this.receipts.get(operationId)
    if (!attempt || attempt.restored || !this.automatic.has(operationId) || receipt?.sessionId !== this.sessionId || receipt.status !== 'cancelled' || receipt.proof === null) return
    this.restore(receipt, attempt.capture)
  }
  restoreNow = async (operationId: string, mode: 'empty' | 'append' = 'empty'): Promise<void> => {
    if (this.snapshot.busy) return
    this.publish({ busy: true, error: null })
    try {
      const before = this.target.capture(this.attempts.get(operationId)?.capture.schedule.replaceIntentMessageId ?? undefined)
      const received = remoteValue(await this.api.sourceQueuedEditRead({ sessionId: this.sessionId, operationId }))
      if (!received) throw new Error('The Host did not return the original cancellation receipt; the current draft was kept')
      const receipt = this.observe(received)
      // observe() already checks the original Hub, source Session and logical
      // identity. An explicit recovery may cross display generations; the
      // automatic path above remains bound to its original editor occurrence.
      if (receipt?.status === 'cancelled' && receipt.proof !== null) this.restore(receipt, before, mode)
    } catch (error) { this.publish({ error: describe(error) }) }
    finally { this.publish({ busy: false }) }
  }
  private restore(receipt: SourceQueuedEditReceipt, before: QueuedEditCapture, mode: 'empty' | 'append' = 'empty'): void {
    const result = this.target.restore(receipt, before, mode)
    if (!result.ok) { this.publish({ error: result.reason }); return }
    const previous = this.attempts.get(receipt.operationId)
    this.attempts.set(receipt.operationId, { request: { sessionId: this.sessionId, operationId: receipt.operationId, localId: receipt.candidate.localId },
      capture: previous?.capture ?? captureSchema.parse(before), restored: true })
    this.automatic.delete(receipt.operationId)
    try { this.persist(); this.publish({ error: null }) }
    catch (error) { this.storageFault = `The edit was restored, but its local marker could not be saved: ${describe(error)}`; this.publish({ error: this.storageFault }) }
  }
}
