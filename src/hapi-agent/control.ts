import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HapiRequestError, type HapiSession } from '../codex/contracts.js'
import { canonicalJson, record } from '../codex/native.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { observedSessionId, type ObservedBinding } from './identity.js'
import type { HapiObservedAgent, HapiObservedTransport } from './agent.js'
import type { HapiAgentService } from './service.js'
import { observedApplySettingSchema, observedSettingReadSchema, observedSettingReceiptSchema,
  type ObservedApplySetting, type ObservedSettingChange, type ObservedSettingRead, type ObservedSettingReceipt, type ObservedSettings } from './control-types.js'

const permissions: Record<string, readonly string[]> = {
  claude: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
  codex: ['default', 'read-only', 'safe-yolo', 'yolo'], gemini: ['default', 'read-only', 'safe-yolo', 'yolo'],
  kimi: ['default', 'read-only', 'safe-yolo', 'yolo'], copilot: ['default', 'read-only', 'safe-yolo', 'yolo'],
  grok: ['default', 'auto', 'plan', 'bypassPermissions'], opencode: ['default', 'plan', 'yolo'],
  cursor: ['default', 'plan', 'ask', 'debug', 'autoReview', 'yolo'], qoder: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  dsh: ['default', 'read-only', 'yolo'], agy: ['request-review', 'always-proceed'], pi: [],
}
// Pinned HAPI shared/src/models.ts and effort.ts: source aliases, not a claim
// that a particular remote account has these models installed.
const claudeModels = ['sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'fable', 'fable[1m]']
const geminiModels = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
const optionSchema = z.object({ value: z.string(), name: z.string().optional() })
const listSchema = z.object({ success: z.boolean(), error: z.string().optional(),
  availableModels: z.array(z.object({ modelId: z.string().min(1), name: z.string().optional(), provider: z.string().optional(),
    reasoning: z.boolean().optional(), thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
    reasoningEfforts: z.array(optionSchema).optional() })).optional(),
  cliModelSkus: z.array(z.object({ modelId: z.string().min(1), name: z.string().optional() })).optional(),
  autoPermissionModeSupported: z.boolean().optional(),
})
const codexModelsSchema = z.object({ success: z.boolean(), error: z.string().optional(), models: z.array(z.object({
  id: z.string().min(1), displayName: z.string(), supportedReasoningEfforts: z.array(z.string()).optional(), serviceTiers: z.array(z.string()).optional(),
})).optional() })
const effortsSchema = z.object({ success: z.boolean(), error: z.string().optional(), options: z.array(optionSchema).optional(),
  currentModelId: z.string().nullish(), targetModelId: z.string().nullish() })
const entrySchema = z.object({ binding: z.object({ hubId: z.string(), hapiSessionId: z.string(), flavor: z.string(), nativeId: z.string().nullable(), machineId: z.string().nullable() }), receipt: observedSettingReceiptSchema })
type Entry = z.infer<typeof entrySchema>
const journalSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) })

function values(source: HapiSession): ObservedSettings['values'] {
  const pi = source.metadata?.flavor === 'pi' ? source.metadata.piSelectedModel : undefined
  return { model: pi ?? source.model ?? null, effort: source.effort ?? source.modelReasoningEffort ?? null,
    permission: source.permissionMode ?? null, collaboration: source.collaborationMode ?? null,
    serviceTier: source.serviceTier ?? null, copilotMode: source.copilotAgentMode ?? null,
    control: source.agentState?.controlledByUser === true && source.metadata?.capabilities?.concurrentClients !== true ? 'local' : 'remote' }
}
function sameBinding(a: ObservedBinding, b: ObservedBinding): boolean { return canonicalJson(a) === canonicalJson(b) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The source operation could not be confirmed' }

/** Per-engine settings remain with their source owner. Reads cannot replay uncertain mutations. */
export class HapiObservedControl {
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Map<string, Promise<ObservedSettingReceipt>>()
  private readonly filename: string
  constructor(private readonly transport: HapiObservedTransport, private readonly sessions: HapiAgentService, directory: string) {
    this.filename = join(directory, `${observedSessionId(transport.hubId, 'controls')}.json`)
    try {
      const saved = journalSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const entry of saved.entries) {
        if (entry.receipt.status === 'submitting') entry.receipt = { ...entry.receipt, status: 'indeterminate', message: 'The host restarted before the source reply was recorded' }
        this.entries.set(entry.receipt.operationId, entry)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }
  private agent(id: string, write = false): HapiObservedAgent {
    const agent = this.sessions.get(id)
    if (!agent || write && agent.id !== id) throw new HapiRequestError('Acquire the current HAPI source display before changing it', 'rejected', undefined, 'source_display_changed')
    return agent
  }
  private persist(): void { writeDurableJson(this.filename, { version: 1, entries: [...this.entries.values()] }) }
  async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }
  private reconcile(agent: HapiObservedAgent): void {
    const current = values(agent.sourceSession)
    let changed = false
    for (const entry of this.entries.values()) {
      if (!sameBinding(entry.binding, agent.binding) || ['applied', 'rejected'].includes(entry.receipt.status)) continue
      const desired = entry.receipt.change
      if (canonicalJson(current[desired.kind]) !== canonicalJson(desired.value)) continue
      entry.receipt = { ...entry.receipt, status: 'applied', updatedAt: Date.now(), message: 'Confirmed by the original HAPI source state' }; changed = true
    }
    if (changed) this.persist()
  }
  async settings(request: { sessionId: string }): Promise<ObservedSettings> {
    const agent = this.agent(request.sessionId)
    await agent.refreshSettings(); this.reconcile(agent)
    const source = agent.sourceSession, flavor = agent.binding.flavor, value = values(source)
    const connected = agent.projection.connection === 'connected', remote = value.control === 'remote'
    const capable = agent.projection.capabilities
    const enabled = connected && source.active && agent.projection.error === null
    const result: ObservedSettings = {
      sessionId: agent.id, sourceSessionId: source.id, flavor, nativeId: agent.binding.nativeId, readOnly: agent.projection.readOnly,
      values: value,
      editable: { model: enabled && capable.model, effort: enabled && capable.effort,
        permission: connected && capable.permissions && agent.projection.error === null,
        collaboration: enabled && remote && flavor === 'codex', serviceTier: enabled && remote && flavor === 'codex',
        copilotMode: enabled && remote && flavor === 'copilot', control: enabled && !remote && source.metadata?.capabilities?.concurrentClients !== true },
      models: [], efforts: [], permissions: [...(permissions[flavor] ?? [])], serviceTiers: flavor === 'codex' ? ['standard'] : [],
      warnings: [], receipts: [...this.entries.values()].filter(entry => sameBinding(entry.binding, agent.binding)).map(entry => entry.receipt),
    }
    const addModel = (model: ObservedSettings['models'][number]): void => {
      if (!result.models.some(option => canonicalJson(option.value) === canonicalJson(model.value))) result.models.push(model)
    }
    const addEffort = (effort: string | null, label = effort ?? 'Default'): void => {
      if (!result.efforts.some(option => option.value === effort)) result.efforts.push({ value: effort, label })
    }
    const path = `/api/sessions/${encodeURIComponent(source.id)}`
    if (flavor === 'claude' || flavor === 'gemini') {
      addModel({ value: null, label: 'Default', provider: null })
      for (const model of flavor === 'claude' ? claudeModels : geminiModels) addModel({ value: model, label: model, provider: null })
      if (flavor === 'claude') { addEffort(null); for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) addEffort(effort) }
    } else if (flavor === 'dsh' || flavor === 'qoder') {
      const options = (flavor === 'dsh' ? source.metadata?.dshConfigOptions : source.metadata?.qoderConfigOptions) ?? []
      const model = flavor === 'qoder' ? options.find(option => option.id === 'model') ?? options.find(option => option.category === 'model' && option.id !== 'reasoning_effort')
        : options.find(option => option.category === 'model')
      const effort = flavor === 'qoder' ? options.find(option => option.id === 'reasoning_effort') ?? options.find(option => option.category === 'thought_level')
        : options.find(option => option.category === 'thought_level')
      for (const option of model?.options ?? []) addModel({ value: option.value, label: option.name ?? option.value, provider: null })
      for (const option of effort?.options ?? []) addEffort(option.value || null, option.name ?? (option.value || 'Default'))
      result.editable.model &&= Boolean(model?.options.length); result.editable.effort &&= Boolean(effort?.options.length)
    } else if (flavor === 'codex') {
      try {
        const data = codexModelsSchema.parse(await this.transport.request(`${path}/codex-models`))
        if (!data.success) throw new Error(data.error ?? 'The source model catalog is unavailable')
        for (const model of data.models ?? []) addModel({ value: model.id, label: model.displayName, provider: null })
        const selected = data.models?.find(model => model.id === source.model)
        for (const effort of selected?.supportedReasoningEfforts ?? []) addEffort(effort)
        if (selected?.serviceTiers?.includes('fast')) result.serviceTiers.push('fast')
      } catch (error) { result.warnings.push(errorText(error)) }
    } else if (['pi', 'cursor', 'opencode', 'grok', 'kimi', 'copilot', 'agy'].includes(flavor)) {
      let models: z.infer<typeof listSchema>['availableModels']
      try {
        const route = flavor === 'agy' && source.metadata?.machineId ? `/api/machines/${encodeURIComponent(source.metadata.machineId)}/agy-models` : `${path}/${flavor}-models`
        const data = listSchema.parse(await this.transport.request(route, { timeoutMs: 120_000 }))
        if (!data.success) throw new Error(data.error ?? 'The source model catalog is unavailable')
        models = data.availableModels
        if (flavor === 'cursor') models = [...(models ?? []), ...(data.cliModelSkus ?? [])]
        if (flavor === 'grok' && data.autoPermissionModeSupported !== true) result.permissions = result.permissions.filter(mode => mode !== 'auto')
      } catch (error) {
        result.warnings.push(errorText(error))
        if (flavor === 'pi') models = source.metadata?.piAvailableModels
      }
      for (const model of models ?? []) {
        if (flavor === 'pi' && !model.provider) continue
        addModel({ value: flavor === 'pi' ? { provider: model.provider!, modelId: model.modelId } : model.modelId,
          label: model.name ?? model.modelId, provider: flavor === 'pi' ? model.provider! : null })
      }
      if (flavor === 'pi') {
        const selected = models?.find(model => typeof value.model === 'object' && value.model !== null
          ? model.provider === value.model.provider && model.modelId === value.model.modelId : model.modelId === value.model)
        addEffort(null)
        if (selected?.reasoning !== false) for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
          if (selected?.thinkingLevelMap?.[level] === null || ['xhigh', 'max'].includes(level) && selected?.thinkingLevelMap?.[level] === undefined) continue
          addEffort(level)
        }
      } else if (flavor === 'opencode' || flavor === 'grok') {
        try {
          const data = effortsSchema.parse(await this.transport.request(`${path}/${flavor}-reasoning-effort-options`))
          if (!data.success) throw new Error(data.error ?? 'The source effort catalog is unavailable')
          if (data.targetModelId && data.currentModelId && data.targetModelId !== data.currentModelId) {
            result.warnings.push('The source model switch is pending; effort options belong to its previous model'); result.editable.effort = false
          } else for (const option of data.options ?? []) addEffort(option.value || null, option.name ?? option.value)
        } catch (error) { result.warnings.push(errorText(error)); result.editable.effort = false }
      }
    }
    if (value.model !== null) addModel({ value: value.model, label: typeof value.model === 'string' ? value.model : value.model.modelId,
      provider: typeof value.model === 'object' ? value.model.provider : null })
    return result
  }
  applySetting(input: ObservedApplySetting): Promise<ObservedSettingReceipt> {
    const request = observedApplySettingSchema.parse(input), agent = this.agent(request.sessionId, true)
    const prior = this.entries.get(request.operationId)
    if (prior) {
      if (!sameBinding(prior.binding, agent.binding) || canonicalJson(prior.receipt.change) !== canonicalJson(request.change)) {
        return Promise.reject(new HapiRequestError('A source operation id cannot be reused for a different binding or setting', 'rejected'))
      }
      return this.flights.get(request.operationId) ?? Promise.resolve(prior.receipt)
    }
    const now = Date.now()
    const entry: Entry = { binding: { ...agent.binding }, receipt: { operationId: request.operationId, sourceSessionId: agent.binding.hapiSessionId,
      logicalSessionId: agent.logicalSessionId, change: request.change, status: 'submitting', createdAt: now, updatedAt: now, message: null } }
    this.entries.set(request.operationId, entry)
    try { this.persist() } catch (error) { this.entries.delete(request.operationId); return Promise.reject(error) }
    const task = this.dispatch(agent, entry)
    this.flights.set(request.operationId, task)
    void task.finally(() => this.flights.delete(request.operationId)).catch(() => {})
    return task
  }
  private async dispatch(agent: HapiObservedAgent, entry: Entry): Promise<ObservedSettingReceipt> {
    let sent = false
    try {
      const settings = await this.settings({ sessionId: agent.id })
      const change = entry.receipt.change
      if (!sameBinding(entry.binding, agent.binding)) throw new Error('The source engine identity changed before dispatch')
      if (!settings.editable[change.kind]) throw new Error(`The source does not currently allow ${change.kind} changes`)
      if (change.kind === 'permission' && !settings.permissions.includes(change.value)) throw new Error('The permission mode is not available for this source engine')
      if (change.kind === 'effort' && !settings.efforts.some(option => option.value === change.value)) throw new Error('The effort value is not advertised for the current source model')
      if (change.kind === 'serviceTier' && !settings.serviceTiers.includes(change.value)) throw new Error('The service tier is not advertised for the current source model')
      if (change.kind === 'model') {
        if (agent.binding.flavor === 'pi' && (change.value === null || typeof change.value !== 'object')) throw new Error('Pi model selection requires the provider and model id')
        if (typeof change.value === 'object' && change.value !== null && agent.binding.flavor !== 'pi') throw new Error('Provider-qualified object selection is only available for Pi')
        if (['pi', 'dsh', 'qoder', 'cursor'].includes(agent.binding.flavor)
          && !settings.models.some(option => canonicalJson(option.value) === canonicalJson(change.value))) throw new Error('The selected model is not in the current source catalog')
      }
      if (entry.receipt.status === 'applied') return entry.receipt
      const { suffix, body } = mutation(agent, change)
      sent = true
      const response = await this.transport.request(`/api/sessions/${encodeURIComponent(agent.binding.hapiSessionId)}/${suffix}`, { method: 'POST', body })
      if (!z.object({ ok: z.literal(true) }).safeParse(response).success) throw new Error('The source did not return a valid setting acknowledgement')
      entry.receipt = { ...entry.receipt, status: 'submitted', updatedAt: Date.now(), message: 'Source acknowledged the setting; awaiting its observed value' }
      this.persist()
      try { await agent.refresh(); this.reconcile(agent) } catch { /* Read failure cannot reject an accepted mutation. */ }
    } catch (error) {
      if (entry.receipt.status !== 'applied') {
        const rejected = !sent || error instanceof HapiRequestError && error.outcome === 'rejected' && [400, 403, 404].includes(error.status ?? 0)
        entry.receipt = { ...entry.receipt, status: rejected ? 'rejected' : 'indeterminate', updatedAt: Date.now(), message: errorText(error) }
        this.persist()
      }
    }
    return entry.receipt
  }
  async readSetting(input: ObservedSettingRead): Promise<ObservedSettingReceipt> {
    const request = observedSettingReadSchema.parse(input), agent = this.agent(request.sessionId)
    const entry = this.entries.get(request.operationId)
    if (!entry || !sameBinding(entry.binding, agent.binding)) throw new HapiRequestError('The source setting receipt does not belong to this engine binding', 'rejected', 404)
    await agent.refresh(); this.reconcile(agent); return entry.receipt
  }
}

function mutation(agent: HapiObservedAgent, change: ObservedSettingChange): { suffix: string; body: unknown } {
  switch (change.kind) {
    case 'model': return { suffix: 'model', body: { model: change.value } }
    case 'effort': return ['codex', 'opencode'].includes(agent.binding.flavor)
      ? { suffix: 'model-reasoning-effort', body: { modelReasoningEffort: change.value } }
      : { suffix: 'effort', body: { effort: change.value } }
    case 'permission': return { suffix: 'permission-mode', body: { mode: change.value } }
    case 'collaboration': return { suffix: 'collaboration-mode', body: { mode: change.value } }
    case 'serviceTier': return { suffix: 'service-tier', body: { serviceTier: change.value } }
    case 'copilotMode': return { suffix: 'copilot-agent-mode', body: { mode: change.value } }
    case 'control': return { suffix: 'switch', body: {} }
  }
}
