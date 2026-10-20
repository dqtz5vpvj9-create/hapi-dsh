import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableJson } from './durable-file.ts'
import { z } from 'zod'
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { HapiRequestError, type HapiAttachment, type HapiQueuedState, type HapiTransport } from './contracts.js'
import { deliveryViewSchema, type DeliveryState, type DeliveryView } from './projection-types.js'
import { record } from './native.js'

function isUserMessage(value: unknown): value is UserMessage {
  const data = record(value)
  const source = record(data?.source)
  return data?.role === 'user' && typeof data.id === 'string' && source?.kind === 'user'
    && (source.rpcId === undefined || typeof source.rpcId === 'string')
    && Array.isArray(data.content) && data.content.every(value => {
      const block = record(value)
      if (block?.type === 'text') return typeof block.text === 'string'
      const ref = record(block?.attachment)
      if (!ref || typeof ref.attachmentId !== 'string' || typeof ref.bytes !== 'number' || ref.bytes < 0) return false
      if (block?.type === 'file') return typeof ref.name === 'string'
      return block?.type === 'image' && typeof ref.mediaType === 'string'
        && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
        && typeof ref.width === 'number' && ref.width > 0 && typeof ref.height === 'number' && ref.height > 0
    })
}

const entrySchema = deliveryViewSchema.extend({
  message: z.custom<UserMessage>(isUserMessage, 'An identified user message with durable attachment references is required'),
})
const journalSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) })
export type DeliveryEntry = z.infer<typeof entrySchema>

/** A local receipt journal, never a consumer or executor of Codex's native queue. */
export class DeliveryJournal {
  private readonly entries = new Map<string, DeliveryEntry>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly filename: string

  constructor(
    stateDirectory: string,
    sessionId: string,
    private readonly sourceSessionId: string,
    private readonly transport: HapiTransport,
    private readonly changed: () => void,
    private readonly resolveAttachments?: (hapiSessionId: string, message: UserMessage) => Promise<HapiAttachment[]>,
  ) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
    this.filename = join(stateDirectory, `${sessionId}.delivery.json`)
    let saved: string
    try { saved = readFileSync(this.filename, 'utf8') } catch (error) {
      if (record(error)?.code === 'ENOENT') return
      throw error
    }
    const parsed = journalSchema.parse(JSON.parse(saved))
    for (const entry of parsed.entries) {
      // A crash between dispatch and acknowledgement cannot authorize replay.
      const restored = entry.state === 'dispatching'
        ? { ...entry, state: 'indeterminate' as const, error: 'The host restarted before native delivery was confirmed' }
        : entry
      this.entries.set(entry.localId, { ...restored, message: freezeMessage(restored.message) })
    }
    this.persist()
  }

  values(): readonly DeliveryEntry[] { return [...this.entries.values()] }
  get(localId: string): DeliveryEntry | undefined { return this.entries.get(localId) }

  view(): DeliveryView[] {
    return this.values().filter(entry => !['invoked', 'cancelled'].includes(entry.state))
      .map(({ message: _message, ...view }) => view)
  }

  findByMessageId(id: string): DeliveryEntry | undefined {
    return this.values().find(entry => entry.message.id === id)
  }

  /**
   * Records dispatch synchronously for DSH's synchronous Agent API. The actual
   * send is attempted once. Returning here never marks the prompt invoked.
   */
  submit(message: UserMessage, mode: 'queue' | 'steer'): DeliveryEntry {
    if (!isUserMessage(message)) throw new Error('Native Codex delivery requires identified human input')
    if (message.content.some(block => block.type !== 'text') && !this.resolveAttachments) {
      throw new Error('Native Codex attachment upload is not configured')
    }
    const source = record(message.source)
    const requestId = typeof source?.rpcId === 'string' ? source.rpcId : message.id
    // A retried DSH prompt request is the same delivery even if DSH reminted a message id.
    const localId = `dsh:${requestId}`
    const previous = this.entries.get(localId)
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    if (previous) {
      if (JSON.stringify(previous.message.content) !== JSON.stringify(message.content) || previous.mode !== mode) {
        throw new Error('A native delivery identity cannot be reused for different input')
      }
      return previous
    }
    const entry: DeliveryEntry = {
      localId, messageId: message.id, text, mode, state: 'dispatching',
      createdAt: Date.now(), error: null, message: freezeMessage(message),
    }
    this.entries.set(localId, entry)
    // A failed fsync rejects the DSH synchronous acceptance, before network I/O.
    try { this.persist() } catch (error) { this.entries.delete(localId); throw error }
    this.changed()
    const dispatch = this.dispatch(entry)
    this.inFlight.set(localId, dispatch)
    void dispatch.then(() => { this.inFlight.delete(localId) }, () => { this.inFlight.delete(localId) })
    return entry
  }

  private async dispatch(entry: DeliveryEntry): Promise<void> {
    let sendStarted = false
    try {
      const attachments = entry.message.content.some(block => block.type !== 'text')
        ? await this.resolveAttachments?.(this.sourceSessionId, entry.message) : undefined
      sendStarted = true
      await this.transport.sendMessage(this.sourceSessionId, {
        text: entry.text, localId: entry.localId, deliveryMode: entry.mode,
        ...(attachments?.length ? { attachments } : {}),
      })
      const current = this.entries.get(entry.localId)
      // Source facts can arrive over SSE before the HTTP acknowledgement.
      if (current?.state === 'dispatching' || current?.state === 'indeterminate') {
        this.update(entry.localId, 'accepted')
      }
    } catch (error) {
      const current = this.entries.get(entry.localId)
      if (current && (current.state === 'invoked' || current.state === 'queued' || current.state === 'cancelled')) return
      this.update(entry.localId,
        !sendStarted || error instanceof HapiRequestError && error.outcome === 'rejected' ? 'rejected' : 'indeterminate',
        error instanceof Error ? error.message : 'Native delivery outcome is unknown')
    }
  }

  update(localId: string, state: DeliveryState, error: string | null = null): void {
    const previous = this.entries.get(localId)
    if (!previous || (previous.state === state && previous.error === error)) return
    // Consumed native input is irreversible; older queue/HTTP facts cannot undo it.
    if (previous.state === 'invoked' && state !== 'invoked') return
    this.entries.set(localId, { ...previous, state, error })
    this.persist()
    this.changed()
  }

  reconcile(state: HapiQueuedState): void {
    const invoked = new Set(state.invokedLocalMessages.map(message => message.localId))
    const queued = new Set(state.queuedLocalIds)
    const dispatching = new Set(state.dispatchingLocalIds ?? [])
    const indeterminate = new Set(state.indeterminateLocalIds ?? [])
    for (const entry of this.entries.values()) {
      if (invoked.has(entry.localId)) this.update(entry.localId, 'invoked')
      else if (indeterminate.has(entry.localId)) this.update(entry.localId, 'indeterminate', 'The native engine has not confirmed this delivery')
      else if (dispatching.has(entry.localId)) this.update(entry.localId, 'dispatching')
      else if (queued.has(entry.localId)) this.update(entry.localId, 'queued')
      // Absence is not evidence of rejection, consumption, or safe retry.
    }
  }

  async reconcileSource(): Promise<void> {
    const unresolved = this.values().filter(entry => !['invoked', 'cancelled', 'rejected'].includes(entry.state))
    for (let index = 0; index < unresolved.length; index += 1000) {
      this.reconcile(await this.transport.getQueuedState(this.sourceSessionId,
        unresolved.slice(index, index + 1000).map(entry => entry.localId)))
    }
  }

  async settled(): Promise<void> { await Promise.allSettled([...this.inFlight.values()]) }

  private persist(): void {
    writeDurableJson(this.filename, { version: 1, entries: this.values() })
  }
}
