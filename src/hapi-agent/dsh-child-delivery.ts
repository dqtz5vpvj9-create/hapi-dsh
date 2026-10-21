import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { HapiRequestError } from '../codex/contracts.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { canonicalJson, record } from '../codex/native.js'
import type { HapiObservedTransport } from './agent.js'
import { sourceDshChildBindingSchema, sourceDshChildCommandIdSchema, sourceDshChildReceiptSchema, type SourceDshChildBinding, type SourceDshChildReceipt } from './dsh-child-types.js'
import { SourceDshChildUnavailable, sourceDshChildPath } from './dsh-child-protocol.js'

const entrySchema = z.object({ receipt: sourceDshChildReceiptSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
type Entry = z.infer<typeof entrySchema>
const savedSchema = z.object({ version: z.literal(1), binding: sourceDshChildBindingSchema, entries: z.array(entrySchema) })
const explanation = (error: unknown) => (error instanceof Error ? error.message : 'The original DSH child did not return a confirmed receipt').slice(0, 4096)
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')

/**
 * A local submission journal, never a second queue or retry drainer. HAPI's
 * requestId cache lasts five minutes and is not a durable query protocol. Once
 * a POST may have crossed the source boundary, every subsequent read is read-only.
 */
export class SourceDshChildDelivery {
  private readonly file: string
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Map<string, Promise<void>>()
  private storageFault: string | null = null
  constructor(directory: string, readonly binding: SourceDshChildBinding, private readonly transport: Pick<HapiObservedTransport, 'request'>,
    private readonly validate: () => Promise<void>, private readonly changed: () => void) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, `dsh-child-delivery-${hash(binding).slice(0, 32)}.json`)
    try {
      const saved = savedSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
      if (canonicalJson(saved.binding) !== canonicalJson(binding)) throw new Error('A DSH child delivery journal belongs to a different source owner')
      for (const entry of saved.entries) {
        if (this.entries.has(entry.receipt.operationId)) throw new Error('The DSH child journal contains a duplicate operation identity')
        if (entry.fingerprint !== this.fingerprint(entry.receipt)) throw new Error('The DSH child journal input identity is inconsistent')
        if (entry.receipt.status === 'dispatching') {
          entry.receipt.status = 'unknown'; entry.receipt.error = 'The workspace restarted without a source reply. This original operation will not be sent again.'
        } else if (entry.receipt.status === 'prepared') {
          entry.receipt.status = 'rejected'; entry.receipt.error = 'This durable intent did not cross the source submission boundary before the workspace restarted.'
        }
        this.entries.set(entry.receipt.operationId, entry)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }
  get error(): string | null { return this.storageFault }
  list(): SourceDshChildReceipt[] { return [...this.entries.values()].map(entry => structuredClone(entry.receipt)).sort((a, b) => a.createdAt - b.createdAt) }
  byMessageId(messageId: string): SourceDshChildReceipt | undefined {
    const entry = [...this.entries.values()].find(value => value.receipt.displayMessageId === messageId)
    return entry ? structuredClone(entry.receipt) : undefined
  }
  read(operationId: string): SourceDshChildReceipt | undefined {
    const entry = this.entries.get(operationId); return entry ? structuredClone(entry.receipt) : undefined
  }
  prompt(message: UserMessage, delivery: 'queue' | 'steer'): SourceDshChildReceipt {
    if (message.content.some(block => block.type !== 'text')) throw new SourceDshChildUnavailable('The original DSH child prompt API accepts text only; retain the attachments instead of silently dropping them')
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    if (!text.trim() || text.length > 100_000) throw new SourceDshChildUnavailable('The original DSH child prompt requires 1–100000 characters of text')
    const operationId = `prompt:${hash(String(message.id)).slice(0, 48)}`
    const command = sourceDshChildCommandIdSchema.safeParse(message.source?.kind === 'user' && 'rpcId' in message.source ? message.source.rpcId : undefined)
    return this.prepare({ operationId, kind: 'prompt', requestId: `hapi-dsh-child:${hash([this.binding, String(message.id)]).slice(0, 48)}`,
      displayMessageId: message.id, ...(command.success ? { clientRequestId: command.data } : {}), text, delivery })
  }
  interrupt(operationId: string): SourceDshChildReceipt {
    if (!operationId.trim() || operationId.length > 128) throw new SourceDshChildUnavailable('A child interrupt requires a stable operation identity of at most 128 characters')
    return this.prepare({ operationId, kind: 'interrupt', requestId: null, displayMessageId: null, text: null, delivery: null })
  }
  private fingerprint(receipt: Pick<SourceDshChildReceipt, 'operationId' | 'kind' | 'requestId' | 'displayMessageId' | 'text' | 'delivery'>): string {
    return hash([this.binding, receipt.operationId, receipt.kind, receipt.requestId, receipt.displayMessageId, receipt.text, receipt.delivery])
  }
  private prepare(input: Pick<SourceDshChildReceipt, 'operationId' | 'kind' | 'requestId' | 'displayMessageId' | 'clientRequestId' | 'text' | 'delivery'>): SourceDshChildReceipt {
    const fingerprint = this.fingerprint(input), previous = this.entries.get(input.operationId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new SourceDshChildUnavailable('This DSH child operation already belongs to different immutable input')
      return structuredClone(previous.receipt)
    }
    if (this.storageFault) throw new SourceDshChildUnavailable(this.storageFault)
    const now = Date.now(), entry: Entry = { fingerprint, receipt: { ...input, status: 'prepared',
      sourceMessageId: null, createdAt: now, updatedAt: now, error: null } }
    this.entries.set(input.operationId, entry)
    try { this.persist() } catch (error) { this.entries.delete(input.operationId); throw error }
    this.changed()
    const flight = Promise.resolve().then(() => this.dispatch(entry))
    this.flights.set(input.operationId, flight)
    void flight.finally(() => { if (this.flights.get(input.operationId) === flight) this.flights.delete(input.operationId) }).catch(() => {})
    return structuredClone(entry.receipt)
  }
  private async dispatch(entry: Entry): Promise<void> {
    let sourceBoundary = false
    try {
      await this.validate()
      entry.receipt.status = 'dispatching'; entry.receipt.updatedAt = Date.now(); this.persist(); this.changed()
      sourceBoundary = true
      if (entry.receipt.kind === 'prompt') {
        const response = z.object({ messageId: z.string().optional() }).parse(await this.transport.request(sourceDshChildPath(this.binding, 'prompt'), {
          method: 'POST', body: { text: entry.receipt.text, delivery: entry.receipt.delivery, requestId: entry.receipt.requestId }, timeoutMs: 30_000,
        }))
        entry.receipt.sourceMessageId = response.messageId ?? null; entry.receipt.status = 'accepted'
      } else {
        const response = z.object({ accepted: z.boolean() }).parse(await this.transport.request(sourceDshChildPath(this.binding, 'interrupt'), { method: 'POST', timeoutMs: 30_000 }))
        entry.receipt.status = response.accepted ? 'accepted' : 'rejected'
        if (!response.accepted) entry.receipt.error = 'The original DSH owner did not accept this child interrupt'
      }
    } catch (error) {
      // In particular, do not downgrade an indeterminate 401 or a source 409
      // to rejection. Either can conceal a mutation that already took effect.
      const knownRejected = !sourceBoundary || error instanceof HapiRequestError
        && error.outcome === 'rejected' && error.status !== undefined && [400, 403, 404].includes(error.status)
      entry.receipt.status = knownRejected ? 'rejected' : 'unknown'; entry.receipt.error = explanation(error)
    }
    entry.receipt.updatedAt = Date.now()
    try { this.persist() } catch (error) {
      this.storageFault = `The child receipt could not be saved: ${explanation(error)}. Read the original source before making another submission.`
      if (sourceBoundary) { entry.receipt.status = 'unknown'; entry.receipt.error = this.storageFault }
    }
    this.changed()
  }
  private persist(): void {
    try { writeDurableJson(this.file, { version: 1, binding: this.binding, entries: [...this.entries.values()] }) }
    catch (error) { this.storageFault = `The DSH child intent journal is unavailable: ${explanation(error)}`; throw error }
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }
}
