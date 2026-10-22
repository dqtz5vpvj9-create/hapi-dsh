import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HapiRequestError, type HapiEvent, type HapiSession, type HapiTransport } from '../codex/contracts.js'
import { bindingFor, canonicalJson, record } from '../codex/native.js'
import { observedBinding } from '../hapi-agent/identity.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { sourceQueuedEditRequestSchema, sourceQueuedEditReadSchema, sourceQueuedEditReceiptSchema,
  type SourceQueuedEditCandidate, type SourceQueuedEditReceipt, type SourceQueuedEditRequest, type SourceQueuedEditRead } from '../codex/queued-edit-types.js'

export interface SourceQueuedEditAgent {
  readonly id: string
  readonly logicalSessionId: string
  readonly sourceSession: HapiSession
  queuedEditCandidate(localId: string): SourceQueuedEditCandidate | undefined
  refreshSettings(): Promise<void>
  refresh(history?: boolean): Promise<void>
}
export interface SourceQueuedEditSessions { get(id: string): SourceQueuedEditAgent | undefined }
const identitySchema = z.object({ hubId: z.string(), sourceId: z.string(), namespace: z.string(),
  engine: z.string(), nativeId: z.string().nullable(), machineId: z.string().nullable(), home: z.string().nullable(), homeId: z.string().nullable() })
type Identity = z.infer<typeof identitySchema>
const entrySchema = z.object({ request: sourceQueuedEditRequestSchema, identity: identitySchema, receipt: sourceQueuedEditReceiptSchema })
type Entry = z.infer<typeof entrySchema>
const savedSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) })
const message = (error: unknown) => (error instanceof Error ? error.message : 'The source did not confirm queue cancellation').slice(0, 4096)
function identity(hubId: string, source: HapiSession): Identity {
  if (source.metadata?.codexNativeSession) {
    const value = bindingFor(hubId, source)
    return { hubId, sourceId: source.id, namespace: source.namespace, engine: 'codex-native', nativeId: value.threadId,
      machineId: value.machineId, home: value.home, homeId: value.homeId }
  }
  const value = observedBinding(hubId, source)
  return { hubId, sourceId: source.id, namespace: source.namespace, engine: value.flavor, nativeId: value.nativeId,
    machineId: value.machineId, home: null, homeId: null }
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
const unresolved = (value: SourceQueuedEditReceipt) => value.status === 'submitting' || value.status === 'unknown'

/** Durable cancel→restore preparation. It never edits source rows or sends replacement input. */
export class SourceQueuedEdits {
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Map<string, Promise<SourceQueuedEditReceipt>>()
  private readonly filename: string
  private readonly stop: () => void
  private storageFault: string | null = null
  constructor(private readonly client: HapiTransport, private readonly sessions: SourceQueuedEditSessions, directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `queued-edit-${createHash('sha256').update(client.hubId).digest('hex').slice(0, 32)}.json`)
    try {
      for (const entry of savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8'))).entries) {
        if (entry.identity.hubId !== client.hubId) throw new Error('The queued edit journal belongs to another source Hub')
        if (entry.receipt.status === 'submitting') { entry.receipt.status = 'unknown'; entry.receipt.error = 'The workspace restarted before the cancellation reply was recorded. The cancellation will not be repeated.' }
        this.entries.set(entry.request.operationId, entry)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
    this.stop = client.subscribe(event => { this.observe(event) })
  }
  private persist(): void {
    try { writeDurableJson(this.filename, { version: 1, entries: [...this.entries.values()] }) }
    catch (error) { this.storageFault = `Queued edit recovery storage is unavailable: ${message(error)}`; throw error }
  }
  private agent(id: string, exact = false): SourceQueuedEditAgent {
    const agent = this.sessions.get(id)
    if (!agent || exact && agent.id !== id) throw new HapiRequestError('Acquire the current original source session before editing queued input', 'rejected', 404)
    return agent
  }
  private matches(entry: Entry, agent: SourceQueuedEditAgent): boolean {
    return entry.receipt.logicalSessionId === agent.logicalSessionId && equal(entry.identity, identity(this.client.hubId, agent.sourceSession))
  }
  list(sessionId: string): SourceQueuedEditReceipt[] {
    const agent = this.agent(sessionId)
    return [...this.entries.values()].filter(entry => this.matches(entry, agent)).map(entry => structuredClone(entry.receipt)).sort((a, b) => b.createdAt - a.createdAt)
  }
  async execute(input: SourceQueuedEditRequest): Promise<SourceQueuedEditReceipt> {
    const request = sourceQueuedEditRequestSchema.parse(input), old = this.entries.get(request.operationId)
    if (old) {
      if (!equal(old.request, request)) throw new HapiRequestError('This edit operation already belongs to different immutable input', 'rejected', 400)
      return this.flights.get(request.operationId) ?? structuredClone(old.receipt)
    }
    if (this.storageFault) throw new HapiRequestError(this.storageFault, 'rejected', 503)
    const agent = this.agent(request.sessionId, true), originalIdentity = identity(this.client.hubId, agent.sourceSession)
    await agent.refreshSettings()
    if (this.agent(request.sessionId, true) !== agent || !equal(identity(this.client.hubId, agent.sourceSession), originalIdentity)) throw new HapiRequestError('The source identity changed before queue editing', 'rejected', 409)
    const candidate = agent.queuedEditCandidate(request.localId)
    if (!candidate) throw new HapiRequestError('This input is not a confirmed, editable original queue row. A live dispatch or local echo cannot be edited.', 'rejected', 409)
    // Only a source-owned queue row qualifies. The payload is immutable while
    // queued; a subsequent invocation race is decided by the original DELETE.
    const state = await this.client.getQueuedState(originalIdentity.sourceId, [candidate.localId])
    if (!state.queuedLocalIds.includes(candidate.localId) && !state.indeterminateLocalIds?.includes(candidate.localId)
      || state.dispatchingLocalIds?.includes(candidate.localId) || state.invokedLocalMessages.some(row => row.localId === candidate.localId)) {
      throw new HapiRequestError('The source no longer reports this message as editable queued input', 'rejected', 409)
    }
    const now = Date.now(), entry: Entry = { request, identity: originalIdentity, receipt: {
      operationId: request.operationId, sessionId: agent.id, logicalSessionId: agent.logicalSessionId,
      hubId: this.client.hubId, sourceSessionId: originalIdentity.sourceId, candidate: structuredClone(candidate),
      status: 'submitting', proof: null, createdAt: now, updatedAt: now, error: null,
    } }
    // Another concurrent request may have finished the read-only preparation.
    const existing = this.entries.get(request.operationId)
    if (existing) {
      if (!equal(existing.request, request)) throw new HapiRequestError('This operation ID was claimed by different input', 'rejected', 400)
      return this.flights.get(request.operationId) ?? structuredClone(existing.receipt)
    }
    if ([...this.entries.values()].some(value => this.matches(value, agent) && unresolved(value.receipt))) throw new HapiRequestError('An earlier queued edit has an unresolved cancellation. Read its retained original payload first.', 'rejected', 409)
    this.entries.set(request.operationId, entry)
    try { this.persist() } catch (error) { this.entries.delete(request.operationId); throw error }
    const task = this.dispatch(entry, agent)
    this.flights.set(request.operationId, task)
    void task.finally(() => { if (this.flights.get(request.operationId) === task) this.flights.delete(request.operationId) }).catch(() => {})
    return task
  }
  private async dispatch(entry: Entry, agent: SourceQueuedEditAgent): Promise<SourceQueuedEditReceipt> {
    let sent = false
    try {
      const latest = await this.client.getSession(entry.identity.sourceId)
      if (this.agent(entry.request.sessionId, true) !== agent || !equal(identity(this.client.hubId, latest), entry.identity)) throw new Error('The source owner changed before queue cancellation')
      sent = true
      const result = await this.client.cancelQueuedMessage(entry.identity.sourceId, entry.receipt.candidate.messageId)
      if (result.status === 'cancelled') {
        if (result.localId !== null && result.localId !== entry.receipt.candidate.localId) throw new Error('The cancellation receipt identifies another source queue row')
        this.settle(entry, 'cancelled', 'source-reply', null)
      } else if (result.status === 'invoked') {
        if (result.message.localId !== entry.receipt.candidate.localId && result.message.id !== entry.receipt.candidate.messageId) throw new Error('The invocation receipt identifies another source message')
        this.settle(entry, 'invoked', 'source-reply', 'The original engine already consumed this input; it must not be restored as a new draft.')
      } else {
        if (result.localId !== entry.receipt.candidate.localId) throw new Error('The busy receipt identifies another source queue row')
        this.settle(entry, 'busy', 'source-reply', 'The original queue did not confirm cancellation. The message may still be delivered; its original payload is retained.')
      }
    } catch (error) {
      // An authoritative cancellation event can arrive before an HTTP reply
      // is lost. Never downgrade that exact source fact to unknown.
      if (entry.receipt.status === 'submitting') {
        const rejected = !sent || error instanceof HapiRequestError && error.outcome === 'rejected'
          && error.status !== undefined && [400, 403, 404].includes(error.status)
        this.settle(entry, rejected ? 'rejected' : 'unknown', null, message(error))
      }
    }
    // Source facts above remain valid even if a later observation fails.
    try { await agent.refresh(true) } catch { /* The retained receipt exposes the source outcome independently. */ }
    return structuredClone(entry.receipt)
  }
  private settle(entry: Entry, status: SourceQueuedEditReceipt['status'], proof: SourceQueuedEditReceipt['proof'], error: string | null): void {
    if (entry.receipt.status === 'invoked') return
    entry.receipt.status = status; entry.receipt.proof = proof; entry.receipt.error = error; entry.receipt.updatedAt = Date.now()
    try { this.persist() } catch (failure) {
      entry.receipt.status = 'unknown'; entry.receipt.proof = null; entry.receipt.error = this.storageFault ?? message(failure)
    }
  }
  private observe(event: HapiEvent): void {
    if (event.type !== 'message-cancelled' && event.type !== 'messages-consumed') return
    for (const entry of this.entries.values()) {
      if (entry.identity.sourceId !== event.sessionId) continue
      const agent = this.sessions.get(entry.request.sessionId)
      if (!agent || !this.matches(entry, agent)) continue
      if (event.type === 'message-cancelled' && unresolved(entry.receipt) && (event.localId === entry.receipt.candidate.localId || event.messageId === entry.receipt.candidate.messageId)) {
        this.settle(entry, 'cancelled', 'source-event', null)
      } else if (event.type === 'messages-consumed' && event.localIds.includes(entry.receipt.candidate.localId)) {
        this.settle(entry, 'invoked', 'source-event', 'The original engine consumed this input. The retained payload must not be resent as an edit.')
      }
    }
  }
  async read(input: SourceQueuedEditRead): Promise<SourceQueuedEditReceipt | null> {
    const request = sourceQueuedEditReadSchema.parse(input), entry = this.entries.get(request.operationId)
    if (!entry) return null
    const agent = this.agent(request.sessionId)
    if (!this.matches(entry, agent)) throw new HapiRequestError('The queued edit belongs to another original source identity', 'rejected', 409)
    if (unresolved(entry.receipt)) {
      const latest = await this.client.getSession(entry.identity.sourceId)
      if (!equal(identity(this.client.hubId, latest), entry.identity)) throw new HapiRequestError('The original source identity changed; the retained cancellation is still unresolved', 'rejected', 409)
      const state = await this.client.getQueuedState(entry.identity.sourceId, [entry.receipt.candidate.localId])
      if (state.invokedLocalMessages.some(row => row.localId === entry.receipt.candidate.localId)) this.settle(entry, 'invoked', 'source-invoked-read', 'The source confirmed that the message was consumed. It must not be restored as a new draft.')
      // An absent row does not distinguish cancellation from a lost source
      // fact. Reading never repeats DELETE or creates replacement input.
    }
    return structuredClone(entry.receipt)
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }
  async dispose(): Promise<void> { await this.settled(); this.stop() }
}
