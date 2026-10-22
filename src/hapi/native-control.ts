import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableJson } from '../codex/durable-file.ts'
import { z } from 'zod'
import { HapiRequestError, type HapiSession } from '../codex/contracts.ts'
import { assertBinding, canonicalJson, nativeSessionId, record, type NativeBinding } from '../codex/native.ts'
import {
  nativeApplySettingSchema, nativeForkCloseRequestSchema, nativeForkOperationRequestSchema, nativeForkReceiptSchema,
  nativeForkRequestSchema, nativeForkSourceResponseSchema, nativeForkSourceSchema, nativeForkViewSchema,
  nativeSettingReceiptSchema, type NativeApplySetting, type NativeForkCloseRequest, type NativeForkCloseResult,
  type NativeForkOperationRequest, type NativeForkReceipt, type NativeForkRequest, type NativeForkSource,
  type NativeForkState, type NativeForkView, type NativeSettingChange, type NativeSettingReceipt, type NativeSettings,
  type NativeSettingsValues, type NativeForkBoundary,
} from '../codex/control-types.ts'

export interface NativeControlTransport {
  readonly hubId: string
  request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>
}
export interface NativeControlAgent {
  readonly id: string
  readonly logicalSessionId: string
  readonly binding: NativeBinding
  readonly sourceSession: HapiSession
  readonly projection: { readOnly: boolean }
  refresh(history?: boolean): Promise<void>
  refreshSettings(): Promise<void>
  resolveForkBoundary(messageId: string): NativeForkBoundary | undefined
}
export interface NativeControlSessions {
  get(sessionId: string): NativeControlAgent | undefined
  attach(sourceId: string): Promise<NativeControlAgent | undefined>
}

const bindingSchema = z.object({
  hubId: z.string(), hapiSessionId: z.string(), threadId: z.string(), home: z.string().nullable(),
  homeId: z.string().nullable(), machineId: z.string().nullable(),
})
const settingsSnapshotSchema = z.object({
  model: z.string().nullish(), modelReasoningEffort: z.string().nullish(), permissionMode: z.string().nullish(),
  collaborationMode: z.enum(['default', 'plan']).nullish(), serviceTier: z.string().nullish(),
})
const modelsSchema = z.object({ success: z.boolean(), error: z.string().optional(), models: z.array(z.object({
  id: z.string().min(1), displayName: z.string(), isDefault: z.boolean(), defaultReasoningEffort: z.string().nullish(),
  supportedReasoningEfforts: z.array(z.string()).optional(), serviceTiers: z.array(z.string()).optional(),
})).optional() })
const settingEntrySchema = z.object({ binding: bindingSchema, receipt: nativeSettingReceiptSchema, expected: z.string().nullable() })
type SettingEntry = z.infer<typeof settingEntrySchema>
const forkEntrySchema = z.object({
  binding: bindingSchema, request: nativeForkRequestSchema.nullable(), view: nativeForkViewSchema,
})
type ForkEntry = z.infer<typeof forkEntrySchema>
const journalSchema = z.object({ version: z.literal(1), settings: z.array(settingEntrySchema), forks: z.array(forkEntrySchema) })
const closeResponseSchema = z.object({
  operation: nativeForkReceiptSchema, sourceState: nativeForkSourceSchema,
  closure: z.enum(['closed', 'already_admitted', 'already_resolved', 'unavailable']), message: z.string().optional(),
}).refine(value => value.closure !== 'closed' || value.operation.status === 'rejected'
  && value.operation.rejectionProof === 'not_dispatched' && value.operation.code === 'fork_closed_unadmitted', 'Missing exact no-dispatch closure proof')
  .refine(value => value.closure !== 'already_admitted' || value.operation.status !== 'rejected', 'An admitted operation cannot be rejected')
  .refine(value => value.closure !== 'already_resolved' || value.operation.status === 'rejected'
    && value.operation.code !== 'fork_closed_unadmitted', 'An already resolved operation requires its original no-dispatch proof')

function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The native operation could not be confirmed' }
function pathFor(agent: NativeControlAgent): string { return `/api/sessions/${encodeURIComponent(agent.binding.hapiSessionId)}` }
function matchingBinding(left: NativeBinding, right: NativeBinding): boolean { return canonicalJson(left) === canonicalJson(right) }
function valuesOf(source: HapiSession): NativeSettingsValues {
  const value = settingsSnapshotSchema.parse(source)
  return { model: value.model ?? source.metadata?.codexModel ?? null, reasoningEffort: value.modelReasoningEffort ?? null,
    permissionMode: value.permissionMode ?? null, collaborationMode: value.collaborationMode ?? null, serviceTier: value.serviceTier ?? null }
}

/** Evidence is monotonic; wall clocks do not order native receipt finality. */
export function mergeNativeForkReceipt(previous: NativeForkReceipt, next: NativeForkReceipt): NativeForkReceipt {
  for (const key of ['operationId', 'sourceSessionId', 'childSessionId', 'sourceRevision', 'duplicateRiskOf'] as const) {
    if (previous[key] !== next[key]) throw new HapiRequestError('Native fork receipt identity changed', 'indeterminate', undefined, 'fork_identity_mismatch')
  }
  if (previous.status === 'created') {
    if (next.status !== 'created') return previous
    if (previous.nativeThreadId !== next.nativeThreadId) throw new HapiRequestError('Native fork child identity changed', 'indeterminate', undefined, 'fork_identity_mismatch')
    if (previous.binding === 'ready' && next.binding !== 'ready') return previous
    if (next.updatedAt < previous.updatedAt && next.binding !== 'ready') return previous
  }
  if (previous.status === 'rejected') return previous
  if (previous.status === 'indeterminate' && next.status === 'running') return previous
  if (next.status === previous.status && next.updatedAt < previous.updatedAt && next.status !== 'created') return previous
  return next
}

/**
 * Native settings and durable fork operation controls. The local journal stores
 * submission identity before the network boundary; only HAPI receipts establish
 * native creation or no-dispatch. No read, reconnect, or retry calls /fork again.
 */
export class NativeControl {
  private readonly filename: string
  private readonly settingsJournal = new Map<string, SettingEntry>()
  private readonly forks = new Map<string, ForkEntry>()
  private readonly settingFlights = new Map<string, Promise<NativeSettingReceipt>>()
  private readonly forkFlights = new Map<string, Promise<NativeForkView>>()
  private readonly modelCatalogs = new Map<string, { models: NativeSettings['models']; expires: number }>()
  private readonly modelFlights = new Map<string, Promise<NativeSettings['models']>>()

  constructor(private readonly transport: NativeControlTransport, private readonly sessions: NativeControlSessions, directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${nativeSessionId(transport.hubId, 'native-controls')}.json`)
    try {
      const saved = journalSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const entry of saved.settings) {
        if (entry.receipt.status === 'submitting') entry.receipt = { ...entry.receipt, status: 'indeterminate', message: 'The observer restarted before the native settings reply was recorded' }
        this.settingsJournal.set(entry.receipt.operationId, entry)
      }
      for (const entry of saved.forks) {
        if (entry.view.submission === 'submitting') entry.view = { ...entry.view, submission: 'indeterminate', message: 'The observer restarted before a native fork receipt was recorded' }
        // Display generations are looked up again after startup.
        entry.view.sessionId = null
        this.forks.set(entry.view.operationId, entry)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }

  private agent(sessionId: string, writable = false): NativeControlAgent {
    const agent = this.sessions.get(sessionId)
    if (!agent) throw new HapiRequestError('The native conversation is unavailable; refresh the workspace', 'rejected', 404)
    if (agent.binding.hubId !== this.transport.hubId) throw new HapiRequestError('The native conversation belongs to another Hub', 'rejected')
    assertBinding(agent.binding, agent.sourceSession)
    if (writable && agent.projection.readOnly) throw new HapiRequestError('Reconnect the original native Codex owner before changing this conversation', 'rejected')
    return agent
  }

  async settings(sessionId: string): Promise<NativeSettings> {
    const agent = this.agent(sessionId)
    const warnings: string[] = []
    // A model catalog read and a small settings snapshot are independent of
    // each other and of the much larger transcript synchronization.
    const [, models] = await Promise.all([agent.refreshSettings(), this.models(agent).catch(error => {
      warnings.push(errorText(error)); return [] as NativeSettings['models']
    })])
    const values = valuesOf(agent.sourceSession)
    this.reconcileSettings(agent, values)
    return { values, models, readOnly: agent.projection.readOnly, warnings,
      operations: [...this.settingsJournal.values()].filter(entry => matchingBinding(entry.binding, agent.binding)).map(entry => entry.receipt).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50) }
  }

  private models(agent: NativeControlAgent, fresh = false): Promise<NativeSettings['models']> {
    const { hubId, machineId, homeId, home, hapiSessionId } = agent.binding
    // Models belong to an engine account/home, not a pane or display generation.
    // An unknown home remains source-specific; never borrow another account.
    const key = JSON.stringify([hubId, machineId, homeId, home, machineId && (homeId || home) ? null : hapiSessionId])
    const cached = this.modelCatalogs.get(key)
    if (!fresh && cached && cached.expires > Date.now()) return Promise.resolve(cached.models)
    const pending = this.modelFlights.get(key)
    if (pending) return pending
    const work = this.readModels(agent).then(models => {
      this.modelCatalogs.set(key, { models, expires: Date.now() + 60_000 })
      return models
    }).finally(() => { this.modelFlights.delete(key) })
    this.modelFlights.set(key, work)
    return work
  }

  private async readModels(agent: NativeControlAgent): Promise<NativeSettings['models']> {
    const result = modelsSchema.parse(await this.transport.request(`${pathFor(agent)}/codex-models`))
    if (!result.success) throw new HapiRequestError(result.error ?? 'The native model catalog is unavailable', 'rejected')
    return (result.models ?? []).map(model => ({ id: model.id, name: model.displayName, isDefault: model.isDefault,
      reasoningEfforts: model.supportedReasoningEfforts ?? [], defaultReasoningEffort: model.defaultReasoningEffort ?? null,
      serviceTiers: model.serviceTiers ?? [] }))
  }

  async applySetting(input: NativeApplySetting): Promise<NativeSettingReceipt> {
    const request = nativeApplySettingSchema.parse(input)
    const agent = this.agent(request.sessionId)
    const previous = this.settingsJournal.get(request.operationId)
    if (previous) {
      if (!matchingBinding(previous.binding, agent.binding) || canonicalJson(previous.receipt.change) !== canonicalJson(request.change)) {
        throw new HapiRequestError('A native settings operation ID cannot be reused for different input', 'rejected')
      }
      const pending = this.settingFlights.get(request.operationId)
      if (pending) return pending
      await agent.refreshSettings()
      this.reconcileSettings(agent, valuesOf(agent.sourceSession))
      return previous.receipt
    }
    this.agent(request.sessionId, true)
    if ([...this.settingFlights.keys()].some(id => this.settingsJournal.get(id)?.binding.hapiSessionId === agent.binding.hapiSessionId)) {
      throw new HapiRequestError('A native settings change is still being submitted; wait for its result', 'rejected')
    }
    const entry: SettingEntry = { binding: agent.binding, expected: request.change.value, receipt: {
      operationId: request.operationId, change: request.change, createdAt: Date.now(), status: 'submitting', message: null, observed: null,
    } }
    this.settingsJournal.set(request.operationId, entry)
    try { this.persist() } catch (error) { this.settingsJournal.delete(request.operationId); throw error }
    const work = this.dispatchSetting(agent, entry)
    this.settingFlights.set(request.operationId, work)
    try { return await work } finally { this.settingFlights.delete(request.operationId) }
  }

  private async dispatchSetting(agent: NativeControlAgent, entry: SettingEntry): Promise<NativeSettingReceipt> {
    if (entry.receipt.change.kind === 'reasoningEffort' && entry.expected === null) {
      // The durable intent and flight reservation exist before this await, so
      // concurrent default-effort requests cannot both cross the send boundary.
      try {
        const current = valuesOf(agent.sourceSession).model
        entry.expected = (await this.models(agent, true)).find(model => model.id === current)?.defaultReasoningEffort ?? null
        if (!entry.expected) throw new Error('Codex did not advertise a default reasoning effort; choose an explicit effort')
        this.persist()
      } catch (error) {
        entry.receipt = { ...entry.receipt, status: 'rejected', message: errorText(error) }
        this.persist()
        return entry.receipt
      }
    }
    const route: Record<NativeSettingChange['kind'], { suffix: string; key: string }> = {
      model: { suffix: 'model', key: 'model' }, reasoningEffort: { suffix: 'model-reasoning-effort', key: 'modelReasoningEffort' },
      permissionMode: { suffix: 'permission-mode', key: 'mode' }, collaborationMode: { suffix: 'collaboration-mode', key: 'mode' },
      serviceTier: { suffix: 'service-tier', key: 'serviceTier' },
    }
    const target = route[entry.receipt.change.kind]
    try { this.agent(agent.id, true) } catch (error) {
      entry.receipt = { ...entry.receipt, status: 'rejected', message: errorText(error) }
      this.persist()
      return entry.receipt
    }
    try {
      z.object({ ok: z.literal(true) }).parse(await this.transport.request(`${pathFor(agent)}/${target.suffix}`, {
        method: 'POST', body: { [target.key]: entry.expected }, timeoutMs: 45_000,
      }))
      // Pinned HAPI waits for a matching native settings notification before
      // answering ok:true; a plain submitted candidate cannot reach this state.
      entry.receipt = { ...entry.receipt, status: 'confirmed', message: null }
    } catch (error) {
      // HAPI reports native settings timeouts as HTTP 409 too. That is not a
      // no-dispatch proof and must never be labeled rejected or auto-replayed.
      const rejected = error instanceof HapiRequestError && error.outcome === 'rejected' && [400, 403, 404].includes(error.status ?? 0)
      entry.receipt = { ...entry.receipt, status: rejected ? 'rejected' : 'indeterminate', message: errorText(error) }
    }
    this.persist()
    try {
      await agent.refreshSettings()
      this.reconcileSettings(agent, valuesOf(agent.sourceSession))
    } catch (error) {
      entry.receipt = { ...entry.receipt, message: `${entry.receipt.message ?? ''} Current settings are unavailable: ${errorText(error)}`.trim() }
      this.persist()
    }
    return entry.receipt
  }

  private reconcileSettings(agent: NativeControlAgent, values: NativeSettingsValues): void {
    let changed = false
    for (const entry of this.settingsJournal.values()) {
      if (!matchingBinding(entry.binding, agent.binding)) continue
      if (entry.receipt.status === 'indeterminate' && entry.expected !== null && values[entry.receipt.change.kind] === entry.expected) {
        entry.receipt = { ...entry.receipt, status: 'observed', message: 'The source now reports the requested setting', observed: values }
        changed = true
      } else if (entry.receipt.status === 'confirmed' && canonicalJson(entry.receipt.observed) !== canonicalJson(values)) {
        entry.receipt = { ...entry.receipt, observed: values }
        changed = true
      }
    }
    if (changed) this.persist()
  }

  async forkState(sessionId: string): Promise<NativeForkState> {
    const agent = this.agent(sessionId)
    const source = nativeForkSourceSchema.parse(await this.transport.request(`${pathFor(agent)}/fork-operations`))
    if (source.operation) await this.acceptReceipt(agent, source.operation)
    return this.stateView(agent, source)
  }

  private stateView(agent: NativeControlAgent, source: NativeForkSource): NativeForkState {
    return { revision: source.revision, blockingSourceSessionId: source.blockingSourceSessionId ?? null, message: source.message ?? null,
      operations: [...this.forks.values()].filter(entry => matchingBinding(entry.binding, agent.binding)).map(entry => entry.view)
        .sort((left, right) => (right.operation?.sourceRevision ?? 0) - (left.operation?.sourceRevision ?? 0)) }
  }

  async fork(input: NativeForkRequest): Promise<NativeForkView> {
    const request = nativeForkRequestSchema.parse(input)
    const agent = this.agent(request.sessionId)
    if (request.nativeBoundary && request.nativeBoundary.threadId !== agent.binding.threadId) throw new HapiRequestError('The fork boundary belongs to another native thread', 'rejected')
    const previous = this.forks.get(request.operationId)
    if (previous) {
      const canonical = { ...request, sessionId: agent.logicalSessionId }
      if (!matchingBinding(previous.binding, agent.binding) || previous.request && canonicalJson(previous.request) !== canonicalJson(canonical)) {
        throw new HapiRequestError('A native fork operation ID cannot be reused for another source or boundary', 'rejected')
      }
      const pending = this.forkFlights.get(request.operationId)
      if (pending) return pending
      // A transport retry of this control is always observation, never /fork.
      return this.forkOperation({ sessionId: agent.id, operationId: request.operationId, action: 'read' })
    }
    this.agent(request.sessionId, true)
    const boundary = request.displayMessageId === undefined ? request.nativeBoundary : agent.resolveForkBoundary(request.displayMessageId)
    if (request.displayMessageId !== undefined && !boundary) throw new HapiRequestError('The displayed message has no committed source-native fork boundary; refresh the conversation', 'rejected')
    if (boundary && boundary.threadId !== agent.binding.threadId) throw new HapiRequestError('The displayed fork boundary belongs to another native thread', 'rejected')
    const entry: ForkEntry = { binding: agent.binding, request: { ...request, sessionId: agent.logicalSessionId }, view: {
      operationId: request.operationId, submission: 'submitting', operation: null, sessionId: null, message: null,
    } }
    this.forks.set(request.operationId, entry)
    try { this.persist() } catch (error) { this.forks.delete(request.operationId); throw error }
    const work = (async () => {
      try {
        const { sessionId: _display, displayMessageId: _message, ...body } = request
        if (boundary) body.nativeBoundary = boundary
        const result = nativeForkSourceResponseSchema.parse(await this.transport.request(`${pathFor(agent)}/fork`, { method: 'POST', body, timeoutMs: 120_000 }))
        await this.acceptReceipt(agent, result.operation, entry)
      } catch (error) {
        entry.view = { ...entry.view, submission: error instanceof HapiRequestError && error.outcome === 'rejected' && [400, 403, 404].includes(error.status ?? 0) ? 'rejected' : 'indeterminate', message: errorText(error) }
        this.persist()
        try { await this.readFork(agent, request.operationId, 'read') } catch { /* Receipt remains unknown, not absent. */ }
      }
      return entry.view
    })()
    this.forkFlights.set(request.operationId, work)
    try { return await work } finally { this.forkFlights.delete(request.operationId) }
  }

  async forkOperation(input: NativeForkOperationRequest): Promise<NativeForkView> {
    const request = nativeForkOperationRequestSchema.parse(input)
    const agent = this.agent(request.sessionId)
    try { return await this.readFork(agent, request.operationId, request.action) } catch (error) {
      const entry = this.forks.get(request.operationId)
      if (!entry || !matchingBinding(entry.binding, agent.binding)) throw error
      entry.view = { ...entry.view, message: `Native receipt observation is unavailable: ${errorText(error)}` }
      this.persist()
      return entry.view
    }
  }

  private async readFork(agent: NativeControlAgent, operationId: string, action: 'read' | 'reconcile'): Promise<NativeForkView> {
    const base = `${pathFor(agent)}/fork-operations/${encodeURIComponent(operationId)}`
    const result = nativeForkSourceResponseSchema.parse(await this.transport.request(action === 'reconcile' ? `${base}/reconcile` : base,
      action === 'reconcile' ? { method: 'POST', body: {}, timeoutMs: 120_000 } : {}))
    if (result.operation.operationId !== operationId) throw new HapiRequestError('The Hub returned another fork operation', 'indeterminate')
    return this.acceptReceipt(agent, result.operation)
  }

  private async acceptReceipt(agent: NativeControlAgent, receipt: NativeForkReceipt, saved?: ForkEntry): Promise<NativeForkView> {
    if (receipt.sourceSessionId !== agent.binding.hapiSessionId) throw new HapiRequestError('Native fork receipt belongs to another source', 'indeterminate')
    const previous = saved ?? this.forks.get(receipt.operationId)
    if (previous && !matchingBinding(previous.binding, agent.binding)) throw new HapiRequestError('Native fork source identity changed', 'indeterminate')
    if (previous?.request && (receipt.operationId !== previous.request.operationId
      || receipt.sourceRevision !== previous.request.expectedForkRevision + 1 || receipt.duplicateRiskOf !== previous.request.duplicateRiskOf)) {
      throw new HapiRequestError('Native fork receipt does not match the submitted revision', 'indeterminate')
    }
    const operation = previous?.view.operation ? mergeNativeForkReceipt(previous.view.operation, receipt) : receipt
    const entry: ForkEntry = previous ?? { binding: agent.binding, request: null, view: {
      operationId: receipt.operationId, submission: 'acknowledged', operation: null, sessionId: null, message: null,
    } }
    entry.view = { ...entry.view, submission: 'acknowledged', operation, message: null }
    this.forks.set(operation.operationId, entry)
    // A known native child is durable before attaching any DSH display can fail.
    this.persist()
    if (operation.status === 'created' && operation.binding === 'ready') {
      try {
        const child = await this.sessions.attach(operation.childSessionId)
        if (!child || child.binding.threadId !== operation.nativeThreadId || child.binding.threadId === agent.binding.threadId
          || child.binding.machineId !== agent.binding.machineId || child.binding.home !== agent.binding.home || child.binding.homeId !== agent.binding.homeId) {
          throw new Error('The child display did not match the source-verified native fork identity')
        }
        entry.view = { ...entry.view, sessionId: child.id }
      } catch (error) {
        entry.view = { ...entry.view, sessionId: null, message: `The native child exists; its display could not be attached: ${errorText(error)}` }
      }
      this.persist()
    }
    return entry.view
  }

  async forkClose(input: NativeForkCloseRequest): Promise<NativeForkCloseResult> {
    const request = nativeForkCloseRequestSchema.parse(input)
    const agent = this.agent(request.sessionId)
    const response = closeResponseSchema.parse(await this.transport.request(
      `${pathFor(agent)}/fork-operations/${encodeURIComponent(request.operationId)}/close-unadmitted`,
      { method: 'POST', body: { expectedForkRevision: request.expectedForkRevision }, timeoutMs: 120_000 },
    ))
    if (response.operation.operationId !== request.operationId) throw new HapiRequestError('The Hub closed another fork operation', 'indeterminate')
    const view = await this.acceptReceipt(agent, response.operation)
    return { view, source: this.stateView(agent, response.sourceState), closure: response.closure, message: response.message ?? null }
  }

  async settled(): Promise<void> { await Promise.allSettled([...this.settingFlights.values(), ...this.forkFlights.values()]) }

  private persist(): void {
    writeDurableJson(this.filename, { version: 1, settings: [...this.settingsJournal.values()], forks: [...this.forks.values()] })
  }
}
