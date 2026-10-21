import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentAdmissionPart } from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { NativeCodexAgent } from '../codex/agent.js'
import { HapiRequestError } from '../codex/contracts.js'
import { deliveryMessageSchema, type DeliveryEntry } from '../codex/delivery.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { canonicalJson, record } from '../codex/native.js'
import type { HapiObservedAgent } from '../hapi-agent/agent.js'
import { sourceInitialTaskSchema, sourceInitialTaskReadSchema, sourceInitialTasksSchema, sourceInitialTaskReceiptSchema,
  type SourceInitialTask, type SourceInitialTaskRead, type SourceInitialTaskReceipt,
  type SourceInitialTasks as InitialTaskQuery } from '../hapi-agent/initial-task-types.js'

export type SourceInitialTaskAgent = NativeCodexAgent | HapiObservedAgent
export interface SourceInitialTaskSessions {
  get(id: string): SourceInitialTaskAgent | undefined
  byHapiSession(id: string): SourceInitialTaskAgent | undefined
}
/** Reads an existing launch receipt; implementations must never spawn or reconcile a lost spawn response. */
export type SourceInitialTaskCreationLookup = (kind: 'native' | 'source', requestId: string) => Promise<{
  requestId: string; status: string; sourceSessionId: string | null; sessionId: string | null
} | undefined>
export interface SourceInitialTaskOptions { stateDirectory: string; hubId: string }

const bindingSchema = z.object({
  hubId: z.string(), kind: z.enum(['native', 'source']), sourceSessionId: z.string(), logicalSessionId: z.string(),
  flavor: z.string(), machineId: z.string().nullable(), nativeId: z.string().nullable(),
  home: z.string().nullable(), homeId: z.string().nullable(),
})
type Binding = z.infer<typeof bindingSchema>
const entrySchema = z.object({
  receipt: sourceInitialTaskReceiptSchema, binding: bindingSchema, initialSessionId: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), message: deliveryMessageSchema,
})
type Entry = z.infer<typeof entrySchema>
const savedSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) })
const explanation = (error: unknown) => error instanceof Error ? error.message : 'The first task could not be confirmed'
const conflict = (message: string) => new HapiRequestError(message, 'rejected', 409, 'initial_task_conflict')

function bindingFor(agent: SourceInitialTaskAgent): Binding {
  const source = agent.binding
  if ('threadId' in source) return {
    hubId: source.hubId, kind: 'native', sourceSessionId: source.hapiSessionId, logicalSessionId: agent.logicalSessionId,
    flavor: 'codex', machineId: source.machineId, nativeId: source.threadId, home: source.home, homeId: source.homeId,
  }
  return { hubId: source.hubId, kind: 'source', sourceSessionId: source.hapiSessionId, logicalSessionId: agent.logicalSessionId,
    flavor: source.flavor, machineId: source.machineId, nativeId: source.nativeId, home: null, homeId: null }
}

function sameBinding(saved: Binding, current: Binding): boolean {
  return saved.hubId === current.hubId && saved.kind === current.kind && saved.sourceSessionId === current.sourceSessionId
    && saved.logicalSessionId === current.logicalSessionId && saved.flavor === current.flavor && saved.machineId === current.machineId
    && saved.home === current.home && saved.homeId === current.homeId
    && (saved.kind === 'source' && saved.nativeId === null || saved.nativeId === current.nativeId)
}

/**
 * One initial message belongs to one already-ready launch. The original Agent's
 * durable journal still owns delivery, and the HAPI Runner still owns its queue.
 * This service admits files once and stores their immutable DSH references before
 * invoking that Agent; it neither spawns an engine nor drains a native queue.
 */
export class SourceInitialTasks {
  private readonly filename: string
  private readonly entries = new Map<string, Entry>()
  private readonly creationOwners = new Map<string, string>()
  private readonly readFailures = new Map<string, string>()
  private readonly flights = new Map<string, { fingerprint: string; promise: Promise<SourceInitialTaskReceipt> }>()
  private readonly observations = new Set<Promise<void>>()

  constructor(private readonly ctx: Context, private readonly sessions: SourceInitialTaskSessions,
    private readonly creationLookup: SourceInitialTaskCreationLookup, private readonly options: SourceInitialTaskOptions) {
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
    const hub = createHash('sha256').update(options.hubId).digest('hex').slice(0, 32)
    this.filename = join(options.stateDirectory, `initial-tasks-${hub}.json`)
    try {
      const saved = savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const entry of saved.entries) {
        this.validateEntry(entry)
        const owner = this.creationOwners.get(entry.receipt.creationRequestId)
        if (owner && owner !== entry.receipt.operationId) throw new Error('A stored launch has conflicting initial tasks')
        if (this.entries.has(entry.receipt.operationId)) throw new Error('A stored initial task operation is duplicated')
        if (entry.receipt.status === 'dispatching') {
          entry.receipt.status = 'indeterminate'
          entry.receipt.message = 'The workspace restarted before delivery was confirmed. Read the original receipt; do not submit a new task.'
          if (entry.receipt.delivery) entry.receipt.delivery.state = 'indeterminate'
        }
        entry.receipt.sessionId = null; entry.receipt.sourceAvailable = false; entry.receipt.canRetry = false
        entry.message = freezeMessage(entry.message)
        this.entries.set(entry.receipt.operationId, entry)
        this.creationOwners.set(entry.receipt.creationRequestId, entry.receipt.operationId)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }

  submit(input: SourceInitialTask): Promise<SourceInitialTaskReceipt> {
    const request = sourceInitialTaskSchema.parse(input)
    const fingerprint = createHash('sha256').update(canonicalJson(request)).digest('hex')
    const previous = this.entries.get(request.operationId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(conflict('This first-task operation already belongs to different input'))
      return this.readExisting(previous)
    }
    const flight = this.flights.get(request.operationId)
    if (flight) return flight.fingerprint === fingerprint ? flight.promise
      : Promise.reject(conflict('This first-task operation is already admitting different input'))
    const owner = this.creationOwners.get(request.creationRequestId)
    if (owner && owner !== request.operationId) return Promise.reject(conflict('This launch already has an initial task. Read that original operation instead of creating another one.'))
    this.creationOwners.set(request.creationRequestId, request.operationId)
    return this.run(request.operationId, fingerprint, async () => {
      try { return await this.prepare(request, fingerprint) }
      finally {
        if (!this.entries.has(request.operationId) && this.creationOwners.get(request.creationRequestId) === request.operationId) {
          this.creationOwners.delete(request.creationRequestId)
        }
      }
    })
  }

  async read(input: SourceInitialTaskRead): Promise<SourceInitialTaskReceipt | null> {
    const { operationId } = sourceInitialTaskReadSchema.parse(input)
    const pending = this.flights.get(operationId)
    if (pending) return pending.promise
    const entry = this.entries.get(operationId)
    return entry ? this.readExisting(entry) : null
  }

  /** Local recovery inventory: reading the list never submits or re-admits anything. */
  list(input: InitialTaskQuery = {}): SourceInitialTaskReceipt[] {
    const query = sourceInitialTasksSchema.parse(input)
    return [...this.entries.values()].filter(entry => query.creationRequestId === undefined || entry.receipt.creationRequestId === query.creationRequestId)
      .map(entry => {
        this.sync(entry)
        return structuredClone(entry.receipt)
      }).sort((left, right) => right.createdAt - left.createdAt)
  }

  retry(input: SourceInitialTaskRead): Promise<SourceInitialTaskReceipt> {
    const { operationId } = sourceInitialTaskReadSchema.parse(input)
    const pending = this.flights.get(operationId)
    if (pending) return pending.promise
    const entry = this.entries.get(operationId)
    if (!entry) return Promise.reject(conflict('The original first-task operation is unknown'))
    return this.run(operationId, entry.fingerprint, async () => {
      await this.readExisting(entry)
      const agent = this.current(entry)
      if (!agent || !entry.receipt.canRetry) throw conflict('Only an unsubmitted or confirmed rejected first task can retry on its original writable source')
      const delivery = this.delivery(entry, agent)
      if (delivery?.state === 'rejected') {
        agent.retryRejectedDelivery(entry.receipt.localId)
        this.track(entry, agent)
      } else if (!delivery && entry.receipt.status === 'prepared') this.dispatch(entry, agent)
      else throw conflict('The original first task has an unresolved or already admitted delivery; retry is not allowed')
      this.sync(entry); return structuredClone(entry.receipt)
    })
  }

  private run(operationId: string, fingerprint: string, operation: () => Promise<SourceInitialTaskReceipt>): Promise<SourceInitialTaskReceipt> {
    // Defer the first asynchronous operation until the immutable claim is visible
    // to concurrent callers, including image admission and creation lookup.
    const promise = Promise.resolve().then(operation)
    this.flights.set(operationId, { fingerprint, promise })
    void promise.finally(() => {
      if (this.flights.get(operationId)?.promise === promise) this.flights.delete(operationId)
    }).catch(() => {})
    return promise
  }

  private async prepare(request: SourceInitialTask, fingerprint: string): Promise<SourceInitialTaskReceipt> {
    const agent = this.sessions.get(request.sessionId)
    if (!agent || agent.id !== request.sessionId || agent.session.header.origin === 'subagent') throw conflict('Upload and send the first task to the exact ready source display')
    await agent.refresh()
    const binding = bindingFor(agent)
    if (binding.hubId !== this.options.hubId || this.sessions.byHapiSession(binding.sourceSessionId) !== agent) throw conflict('The original source display changed before initial task admission')
    const creation = await this.creationLookup(binding.kind, request.creationRequestId)
    if (!creation || creation.requestId !== request.creationRequestId || creation.status !== 'ready'
      || creation.sourceSessionId !== binding.sourceSessionId || creation.sessionId !== agent.id) {
      throw conflict('This first task needs the matching ready receipt for its original launch')
    }
    if (agent.projection.readOnly) throw conflict('The original source is not currently writable; retain this task and check the same launch again')
    const parts: AttachmentAdmissionPart[] = request.text ? [{ type: 'text', text: request.text }] : []
    const fileReceipts: FileUploadReceiptId[] = []
    for (const attachment of request.attachments) {
      if (attachment.type === 'file') {
        const receiptId = attachment.receiptId as FileUploadReceiptId
        const file = this.ctx.fileUploads.resolve(agent, receiptId)
        if (!file) throw conflict('An attachment upload is not staged for this exact source display')
        fileReceipts.push(receiptId); parts.push({ type: 'file', attachment: file })
      } else parts.push({ type: 'image', mediaType: attachment.mediaType, data: attachment.data,
        ...(attachment.name === undefined ? {} : { name: attachment.name }) })
    }
    const content = await this.ctx.attachments.admitPromptContent(parts)
    if (this.sessions.get(agent.id) !== agent || this.sessions.byHapiSession(binding.sourceSessionId) !== agent
      || !sameBinding(binding, bindingFor(agent))) throw conflict('The source changed while attachments were being admitted; the task was not sent')
    const operationId = request.operationId, rpcId = `initial-task:${operationId}`
    const message: UserMessage = freezeMessage({ id: MessageId(`hapi-initial-task:${operationId}`), role: 'user', source: { kind: 'user', rpcId }, content })
    const now = Date.now()
    const entry: Entry = { binding, initialSessionId: agent.id, fingerprint, message, receipt: {
      operationId, creationRequestId: request.creationRequestId, sourceSessionId: binding.sourceSessionId,
      logicalSessionId: binding.logicalSessionId, sessionId: agent.id, flavor: binding.flavor, nativeId: binding.nativeId,
      localId: `dsh:${rpcId}`, messageId: message.id, status: 'prepared', text: request.text,
      attachments: content.flatMap(part => part.type === 'text' ? [] : [{ type: part.type, name: part.attachment.name
        ?? `image-${part.attachment.attachmentId}`, bytes: part.attachment.bytes,
        ...(part.type === 'image' ? { mediaType: part.attachment.mediaType } : {}) }]),
      delivery: null, sourceConfirmed: false, sourceAvailable: !agent.projection.readOnly, canRetry: !agent.projection.readOnly,
      createdAt: now, updatedAt: now, message: null,
    } }
    // File authorities are checked before the durable delivery boundary. Recovery
    // uses these admitted references, never an expired Session upload receipt.
    using uploadBinding = this.ctx.fileUploads.bindPrompt(agent, [...new Set(fileReceipts)], rpcId)
    this.entries.set(operationId, entry)
    try { this.persist() } catch (error) { this.entries.delete(operationId); throw error }
    this.dispatch(entry, agent)
    if (this.delivery(entry, agent)) uploadBinding.commit()
    this.sync(entry)
    return structuredClone(entry.receipt)
  }

  private dispatch(entry: Entry, agent: SourceInitialTaskAgent): void {
    try { agent.followup(entry.message) }
    catch (error) {
      // A synchronous Agent rejection without a journal entry crossed no source
      // delivery boundary. The original admitted message remains retryable.
      entry.receipt.message = explanation(error)
      if (!this.delivery(entry, agent)) entry.receipt.status = 'prepared'
    }
    this.sync(entry)
    if (this.delivery(entry, agent)) this.track(entry, agent)
  }

  private track(entry: Entry, agent: SourceInitialTaskAgent): void {
    const observation = agent.journal.settled().then(() => {
      this.sync(entry, agent)
    })
    this.observations.add(observation)
    void observation.finally(() => { this.observations.delete(observation) }).catch(() => {})
  }

  private async readExisting(entry: Entry): Promise<SourceInitialTaskReceipt> {
    const agent = this.current(entry)
    if (agent) {
      try { await agent.refresh(); this.readFailures.delete(entry.receipt.operationId) }
      catch (error) { this.readFailures.set(entry.receipt.operationId, explanation(error)) }
    }
    this.sync(entry)
    return structuredClone(entry.receipt)
  }

  private current(entry: Entry): SourceInitialTaskAgent | undefined {
    const agent = this.sessions.byHapiSession(entry.binding.sourceSessionId)
    if (!agent || agent.session.header.origin === 'subagent' || !sameBinding(entry.binding, bindingFor(agent))) return undefined
    return agent
  }

  private delivery(entry: Entry, agent: SourceInitialTaskAgent): DeliveryEntry | undefined {
    const delivery = agent.journal.get(entry.receipt.localId)
    if (delivery && (delivery.messageId !== entry.message.id || delivery.mode !== 'queue' || delivery.scheduledAt !== null
      || canonicalJson(delivery.message) !== canonicalJson(entry.message))) throw conflict('The original first-task delivery identity belongs to different content')
    return delivery
  }

  private sync(entry: Entry, observed?: SourceInitialTaskAgent): void {
    const before = canonicalJson(entry)
    const agent = this.current(entry)
    // An in-flight old display may finish after it was retired. Its receipt is
    // still evidence for this exact original binding, never authority to send.
    const receiptAgent = observed && sameBinding(entry.binding, bindingFor(observed)) ? observed : agent
    const delivery = receiptAgent ? this.delivery(entry, receiptAgent) : undefined
    if (delivery && (entry.receipt.status !== 'invoked' || delivery.state === 'invoked')) {
      const { message: _message, ...view } = delivery
      entry.receipt.delivery = structuredClone(view); entry.receipt.status = delivery.state
      entry.receipt.message = delivery.error
    }
    if (agent && entry.binding.kind === 'source' && entry.binding.nativeId === null && agent.binding && 'nativeId' in agent.binding) {
      entry.binding.nativeId = agent.binding.nativeId; entry.receipt.nativeId = agent.binding.nativeId
    }
    entry.receipt.sessionId = agent?.id ?? null
    const readFailure = this.readFailures.get(entry.receipt.operationId)
    entry.receipt.sourceAvailable = !!agent && !agent.projection.readOnly && readFailure === undefined
    entry.receipt.sourceConfirmed = ['queued', 'invoked'].includes(entry.receipt.status)
    entry.receipt.canRetry = entry.receipt.sourceAvailable && ['prepared', 'rejected'].includes(entry.receipt.status)
    if (readFailure) entry.receipt.message = `The original source could not be checked: ${readFailure}`
    else if (!agent) entry.receipt.message = 'The original source identity is not attached. This receipt cannot target a replacement thread or Runner.'
    else if (agent.projection.readOnly && !entry.receipt.message) entry.receipt.message = 'The original source is currently read-only. Keep this task and its delivery identity.'
    if (canonicalJson(entry) !== before) { entry.receipt.updatedAt = Date.now(); this.persist() }
  }

  private validateEntry(entry: Entry): void {
    const receipt = entry.receipt, binding = entry.binding
    if (binding.hubId !== this.options.hubId || binding.sourceSessionId !== receipt.sourceSessionId || binding.logicalSessionId !== receipt.logicalSessionId
      || binding.flavor !== receipt.flavor || binding.nativeId !== receipt.nativeId || receipt.localId !== `dsh:initial-task:${receipt.operationId}`
      || receipt.messageId !== `hapi-initial-task:${receipt.operationId}` || entry.message.id !== receipt.messageId
      || entry.message.source.kind !== 'user' || !('rpcId' in entry.message.source) || entry.message.source.rpcId !== `initial-task:${receipt.operationId}`) {
      throw new Error('Stored initial task identity is inconsistent')
    }
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.flights.values()].map(flight => flight.promise))
    await Promise.allSettled([...this.observations])
  }
  private persist(): void { writeDurableJson(this.filename, { version: 1, entries: [...this.entries.values()] }) }
}
