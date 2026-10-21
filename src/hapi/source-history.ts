import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HapiRequestError, type HapiSession } from '../codex/contracts.js'
import { canonicalJson, nativeSessionId, record, type NativeBinding } from '../codex/native.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { observedNativeId, type ObservedBinding } from '../hapi-agent/identity.js'
import { codexMigrationOutcomeSchema, cursorMigrationOutcomeSchema, piHistoryEntrySchema, piImportStateSchema,
  sourceHistoryHomeSchema, sourceHistoryOperationSchema, sourceHistoryPiSchema, sourceHistoryReadSchema,
  sourceHistoryReceiptSchema, sourceMigrationProgressSchema,
  type SourceHistoryOperation, type SourceHistoryPi, type SourceHistoryPiResult, type SourceHistoryRead,
  type SourceHistoryReceipt, type SourceHistoryTools } from '../hapi-agent/history-types.js'

export interface SourceHistoryTransport {
  readonly hubId: string
  readonly isConnected?: boolean
  getSession(sourceId: string): Promise<HapiSession>
  request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>
}
export interface SourceHistoryAgent {
  readonly id: string
  readonly logicalSessionId: string
  readonly binding: NativeBinding | ObservedBinding
  readonly sourceSession: HapiSession
  readonly projection: { readOnly: boolean }
  refresh(history?: boolean): Promise<void>
}
export interface SourceHistorySessions {
  get(id: string): SourceHistoryAgent | undefined
  byHapiSession(id: string): SourceHistoryAgent | undefined
  /** Chooses the actual native or observed owner from the current source metadata. */
  reconcileSource(sourceId: string): Promise<SourceHistoryAgent | undefined>
}

const sourceId = z.string().min(1)
const bindingSchema = z.object({ hubId: z.string(), sourceSessionId: sourceId, logicalSessionId: sourceId,
  machineId: z.string().nullable(), flavor: z.string(), nativeId: z.string().nullable(), sourceHome: z.string().nullable(),
  homeId: z.string().nullable(), nativeCodex: z.boolean() })
type Binding = z.infer<typeof bindingSchema>
const entrySchema = z.object({ input: sourceHistoryOperationSchema, receipt: sourceHistoryReceiptSchema,
  binding: bindingSchema.nullable(), selected: z.array(piHistoryEntrySchema), target: sourceHistoryHomeSchema.nullable(),
  importSent: z.boolean(), importAcknowledged: z.boolean(), connectSent: z.boolean(), migrationSent: z.boolean(),
})
type Entry = z.infer<typeof entrySchema>
const savedSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) })
const piListResponse = z.object({ success: z.boolean(), sessions: z.array(piHistoryEntrySchema), machineId: z.string().optional(), error: z.string().optional() })
const piImportResponse = z.object({ success: z.boolean(), machineId: z.string().optional(), error: z.string().optional(), results: z.array(z.object({
  piSessionId: sourceId, hapiSessionId: z.string().optional(), action: z.enum(['created', 'updated', 'unchanged']).optional(),
  appended: z.number().int().nonnegative().optional(), error: z.object({ code: z.string(), message: z.string() }).optional(),
})) })
const homesResponse = z.object({ success: z.boolean(), homes: z.array(sourceHistoryHomeSchema).optional(), error: z.string().optional() })
const reconnectResponse = z.object({ ok: z.literal(true), sessionId: sourceId, resumed: z.boolean().optional() })
const sourcePath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`
const message = (value: unknown) => value instanceof Error ? value.message : 'The original source did not confirm this history operation'
const refused = (value: string) => new HapiRequestError(value, 'rejected', 409, 'source_history_unavailable')
const pending = (receipt: SourceHistoryReceipt) => ['submitting', 'submitted', 'ready-to-connect', 'indeterminate'].includes(receipt.status)

function sourceBinding(agent: SourceHistoryAgent): Binding {
  const binding = agent.binding, native = 'threadId' in binding
  return { hubId: binding.hubId, sourceSessionId: binding.hapiSessionId, logicalSessionId: agent.logicalSessionId,
    machineId: binding.machineId, flavor: native ? 'codex' : binding.flavor, nativeId: native ? binding.threadId : binding.nativeId,
    sourceHome: native ? binding.home ?? agent.sourceSession.metadata?.codexStoreId ?? null
      : agent.sourceSession.metadata?.codexHome ?? agent.sourceSession.metadata?.codexStoreId ?? null,
    homeId: native ? binding.homeId : agent.sourceSession.metadata?.codexHomeId ?? null, nativeCodex: native }
}
function matchingSource(binding: Binding, source: HapiSession): boolean {
  return source.id === binding.sourceSessionId && (source.metadata?.flavor || 'claude') === binding.flavor
    && (source.metadata?.machineId ?? null) === binding.machineId
    && observedNativeId(binding.flavor, source.metadata) === binding.nativeId
    && (source.metadata?.codexNativeSession === true) === binding.nativeCodex
}

/** Durable adapters for existing HAPI history/migration routes; no migration or resume is implemented locally. */
export class SourceHistory {
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Map<string, Promise<SourceHistoryReceipt>>()
  private readonly filename: string
  constructor(private readonly client: SourceHistoryTransport, private readonly sessions: SourceHistorySessions, directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${nativeSessionId(client.hubId, 'source-history')}.json`)
    try {
      for (const entry of savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8'))).entries) {
        if (entry.binding && entry.binding.hubId !== client.hubId || canonicalJson(entry.input.action) !== canonicalJson(entry.receipt.action)
          || entry.input.operationId !== entry.receipt.operationId) throw new Error('Stored history operation identity is inconsistent')
        if (entry.receipt.status === 'submitting') {
          entry.receipt.status = entry.importSent || entry.connectSent || entry.migrationSent ? 'indeterminate' : 'rejected'
          entry.receipt.message = entry.receipt.status === 'indeterminate'
            ? 'The workspace restarted before the source response. Only read the original operation; it will not be sent again.'
            : 'The workspace stopped before dispatching this operation.'
        }
        entry.receipt.canContinue = false; entry.receipt.sessionId = null
        for (const item of entry.receipt.items) item.sessionId = null
        if (entry.receipt.observation) entry.receipt.observation.sessionId = null
        this.entries.set(entry.input.operationId, entry)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }
  private persist(): void { writeDurableJson(this.filename, { version: 1, entries: [...this.entries.values()] }) }
  private save(entry: Entry): void { entry.receipt.updatedAt = Date.now(); this.persist() }
  private agent(id: string, exact = false): SourceHistoryAgent {
    const agent = this.sessions.get(id)
    if (!agent || agent.binding.hubId !== this.client.hubId || exact && agent.id !== id) throw refused('Open the current original source display before changing its native history')
    return agent
  }
  private async listPi(input: SourceHistoryPi) {
    const params = new URLSearchParams({ machineId: input.machineId })
    if (input.cwd?.trim()) params.set('cwd', input.cwd.trim())
    const value = piListResponse.parse(await this.client.request(`/api/pi/sessions?${params}`, { timeoutMs: 45_000 }))
    if (!value.success) throw refused(value.error ?? 'Pi history is unavailable on this Runner')
    if (value.machineId !== input.machineId) throw new HapiRequestError('The Pi history catalog belongs to another Runner', 'indeterminate')
    return value.sessions
  }
  async pi(input: SourceHistoryPi): Promise<SourceHistoryPiResult> {
    const request = sourceHistoryPiSchema.parse(input)
    const sessions = (await this.listPi(request)).map(row => {
      const agent = row.hapiSessionId ? this.sessions.byHapiSession(row.hapiSessionId) : undefined
      const binding = agent ? sourceBinding(agent) : undefined
      return { ...row, displaySessionId: binding?.flavor === 'pi' && binding.nativeId === row.id && binding.machineId === request.machineId ? agent!.id : null }
    })
    return { machineId: request.machineId, sessions, operations: this.operations(entry => entry.input.action.kind === 'pi-import' && entry.input.action.machineId === request.machineId) }
  }
  private async homes(machineId: string) {
    const response = homesResponse.parse(await this.client.request(`/api/machines/${encodeURIComponent(machineId)}/codex-homes`))
    if (!response.success) throw refused(response.error ?? 'The original Runner did not return its Codex homes')
    return response.homes ?? []
  }
  private operations(select: (entry: Entry) => boolean): SourceHistoryReceipt[] {
    return [...this.entries.values()].filter(select).map(entry => structuredClone(entry.receipt)).sort((a, b) => b.createdAt - a.createdAt)
  }
  async tools(sessionId: string): Promise<SourceHistoryTools> {
    let agent = this.agent(sessionId)
    try { await agent.refresh(); agent = this.agent(sessionId) }
    catch (error) {
      // A source migration may have changed its home before its response was
      // delivered. The old Agent correctly refuses that binding; reading this
      // panel must still be able to acquire the source's current generation.
      const current = await this.sessions.reconcileSource(agent.binding.hapiSessionId)
      if (!current) throw error
      agent = current
    }
    const binding = sourceBinding(agent), source = agent.sourceSession, metadata = record(source.metadata)
    const progress = sourceMigrationProgressSchema.safeParse(metadata?.migrationInProgress)
    const pi = piImportStateSchema.safeParse(metadata?.piImportState)
    const protocol = metadata?.cursorSessionProtocol === 'acp' || metadata?.cursorSessionProtocol === 'stream-json' ? metadata.cursorSessionProtocol : null
    const cursorState = metadata?.cursorMigrationState === 'in_progress' || metadata?.cursorMigrationState === 'ambiguous' ? metadata.cursorMigrationState : null
    const connected = this.client.isConnected !== false
    return { sessionId: agent.id, sourceSessionId: binding.sourceSessionId, machineId: binding.machineId, flavor: binding.flavor,
      nativeId: binding.nativeId, active: source.active,
      pi: binding.flavor === 'pi' ? { canSync: connected && !source.active && !!binding.machineId && !!binding.nativeId, importState: pi.success ? pi.data : null } : null,
      codex: binding.flavor === 'codex' ? { sourceHome: binding.sourceHome,
        canMigrate: connected && !!binding.machineId && !!binding.sourceHome && !!binding.nativeId && !progress.success,
        homes: binding.machineId ? await this.homes(binding.machineId) : [], migrationInProgress: progress.success ? progress.data : null } : null,
      cursor: binding.flavor === 'cursor' ? { canMigrate: connected && !!binding.nativeId && protocol !== 'acp' && cursorState !== 'in_progress',
        protocol, state: cursorState, hubLocalOnly: true } : null,
      operations: this.operations(entry => entry.binding?.sourceSessionId === binding.sourceSessionId
        || entry.receipt.items.some(item => item.sourceSessionId === binding.sourceSessionId)),
    }
  }

  operation(input: SourceHistoryOperation): Promise<SourceHistoryReceipt> {
    const request = sourceHistoryOperationSchema.parse(input), previous = this.entries.get(request.operationId)
    if (previous) {
      if (canonicalJson(previous.input) !== canonicalJson(request)) return Promise.reject(refused('This history operation ID belongs to different immutable input'))
      return this.read({ operationId: request.operationId }).then(value => { if (!value) throw new Error('Stored history operation disappeared'); return value })
    }
    const action = request.action
    const binding = action.kind === 'pi-import' ? null : sourceBinding(this.agent(action.sessionId, true))
    const scope = binding ? binding.logicalSessionId : `pi-machine:${action.kind === 'pi-import' ? action.machineId : ''}`
    const blocking = [...this.entries.values()].find(entry => pending(entry.receipt) && (binding
      ? entry.binding?.sourceSessionId === binding.sourceSessionId
      : entry.input.action.kind === 'pi-import' && action.kind === 'pi-import' && entry.input.action.machineId === action.machineId
        && entry.input.action.piSessionIds.some(id => action.piSessionIds.includes(id))))
    if (blocking) return Promise.reject(refused(`Read the unresolved original operation ${blocking.input.operationId} before requesting another mutation of this source`))
    const now = Date.now()
    const entry: Entry = { input: request, binding, selected: [], target: null, importSent: false, importAcknowledged: false, connectSent: false, migrationSent: false,
      receipt: { operationId: request.operationId, action, scope, status: 'submitting', phase: 'preflight',
        sourceSessionId: binding?.sourceSessionId ?? null, sessionId: null, createdAt: now, updatedAt: now, message: null,
        canContinue: false, items: [], cursorResult: null, codexResult: null, observation: null } }
    this.entries.set(request.operationId, entry)
    try { this.persist() } catch (error) { this.entries.delete(request.operationId); return Promise.reject(error) }
    return this.run(entry, () => this.dispatch(entry))
  }
  async read(input: SourceHistoryRead): Promise<SourceHistoryReceipt | null> {
    const { operationId } = sourceHistoryReadSchema.parse(input), flight = this.flights.get(operationId)
    if (flight) return flight
    const entry = this.entries.get(operationId)
    if (!entry) return null
    await this.observe(entry); return structuredClone(entry.receipt)
  }
  continue(input: SourceHistoryRead): Promise<SourceHistoryReceipt> {
    const { operationId } = sourceHistoryReadSchema.parse(input), entry = this.entries.get(operationId)
    const flight = this.flights.get(operationId); if (flight) return flight
    if (!entry || entry.input.action.kind !== 'pi-import' || !entry.input.action.connect) return Promise.reject(refused('This operation does not continue an imported Pi history'))
    return this.run(entry, async () => {
      await this.observePi(entry)
      if (entry.receipt.status === 'confirmed') return
      if (!entry.receipt.canContinue || entry.connectSent) throw refused('The original Pi reconnect is unknown, already dispatched, or its imported identity is not ready')
      await this.connectPi(entry)
    })
  }
  private run(entry: Entry, operation: () => Promise<void>): Promise<SourceHistoryReceipt> {
    const work = Promise.resolve().then(async () => {
      try { await operation() }
      catch (error) {
        const sent = entry.importSent || entry.connectSent || entry.migrationSent
        if (!['confirmed', 'failed'].includes(entry.receipt.status)) {
          entry.receipt.status = !sent || error instanceof HapiRequestError && error.outcome === 'rejected' && [400, 403, 404, 422].includes(error.status ?? 0)
            ? sent && entry.importAcknowledged ? 'failed' : 'rejected' : 'indeterminate'
        }
        entry.receipt.canContinue = false; entry.receipt.message = message(error)
        // A lost mutation reply can follow a completed source rebind. Observe
        // the same operation immediately so its retired display cannot block
        // recovery. Observation never proves the original migration result.
        if (entry.migrationSent) await this.observe(entry)
      }
      this.save(entry); return structuredClone(entry.receipt)
    })
    this.flights.set(entry.input.operationId, work)
    void work.finally(() => { if (this.flights.get(entry.input.operationId) === work) this.flights.delete(entry.input.operationId) }).catch(() => {})
    return work
  }
  private async dispatch(entry: Entry): Promise<void> {
    if (this.client.isConnected === false) throw refused('The original HAPI connection is unavailable')
    const action = entry.input.action
    if (action.kind === 'pi-import') {
      if (new Set(action.piSessionIds).size !== action.piSessionIds.length) throw refused('Select each native Pi history only once')
      const listed = await this.listPi({ machineId: action.machineId, ...(action.cwd === undefined ? {} : { cwd: action.cwd }) })
      entry.selected = action.piSessionIds.map(id => { const found = listed.find(row => row.id === id); if (!found) throw refused(`The original Pi history is not listed on this Runner: ${id}`); return found })
      entry.receipt.items = entry.selected.map(row => ({ piSessionId: row.id, sourceSessionId: row.hapiSessionId ?? null, sessionId: null,
        action: null, appended: null, importState: null, active: false, confirmation: 'none', error: null }))
      entry.receipt.phase = 'import'; entry.importSent = true; this.save(entry)
      const response = piImportResponse.parse(await this.client.request('/api/pi/import-sessions', { method: 'POST',
        body: { sessionIds: action.piSessionIds, machineId: action.machineId, ...(action.cwd === undefined ? {} : { cwd: action.cwd }) }, timeoutMs: 180_000 }))
      if (response.machineId && response.machineId !== action.machineId) throw new HapiRequestError('Pi import acknowledged another Runner', 'indeterminate')
      if (response.results.length !== action.piSessionIds.length || new Set(response.results.map(row => row.piSessionId)).size !== response.results.length
        || response.results.some(row => !action.piSessionIds.includes(row.piSessionId))) throw new HapiRequestError('Pi import returned a different selected-history set', 'indeterminate')
      entry.importAcknowledged = true
      for (const item of entry.receipt.items) {
        const result = response.results.find(row => row.piSessionId === item.piSessionId)!
        item.sourceSessionId = result.hapiSessionId ?? item.sourceSessionId; item.action = result.action ?? null; item.appended = result.appended ?? null
        item.error = result.error ?? null; item.confirmation = result.error ? 'none' : 'response'
        if (!result.error && !item.sourceSessionId) throw new HapiRequestError('Pi import omitted its original HAPI session identity', 'indeterminate')
      }
      entry.receipt.status = response.success && entry.receipt.items.every(item => !item.error) ? action.connect ? 'submitted' : 'confirmed' : 'failed'
      entry.receipt.message = response.error ?? entry.receipt.items.find(item => item.error)?.error?.message ?? null
      if (!action.connect && entry.receipt.status === 'confirmed') entry.receipt.phase = 'complete'
      this.save(entry); await this.observePi(entry)
      if (action.connect && entry.receipt.canContinue) await this.connectPi(entry)
      return
    }
    const agent = this.agent(action.sessionId, true); await agent.refresh()
    const current = sourceBinding(agent), binding = entry.binding
    if (!binding || canonicalJson(current) !== canonicalJson(binding)) throw refused('The original native history binding changed before migration')
    if (action.kind === 'codex-home') {
      if (binding.flavor !== 'codex' || !binding.machineId || !binding.nativeId || !binding.sourceHome) throw refused('A machine, original Codex thread and source home are required')
      if (agent.sourceSession.metadata?.migrationInProgress) throw refused('A source Codex migration is already in progress')
      const homes = await this.homes(binding.machineId)
      const target = homes.find(home => home.id === action.targetHomeId)
      if (!target || target.path === binding.sourceHome) throw refused('Choose another Codex home from this original Runner')
      entry.target = target; entry.receipt.phase = 'migration'; entry.migrationSent = true; this.save(entry)
      let result: z.infer<typeof codexMigrationOutcomeSchema>
      try { result = codexMigrationOutcomeSchema.parse(await this.client.request(`/api/machines/${encodeURIComponent(binding.machineId)}/codex-thread-migrate`, {
        method: 'POST', body: { sourceHome: binding.sourceHome, targetHome: target.path, threadId: binding.nativeId,
          sessionId: binding.sourceSessionId, stopSource: true, targetHomeId: target.id,
          ...(action.targetProvider === undefined ? {} : { targetProvider: action.targetProvider }),
          ...(action.targetModel === undefined ? {} : { targetModel: action.targetModel }) }, timeoutMs: 180_000,
      })) } catch (error) {
        const parsed = error instanceof HapiRequestError && error.status !== 401 ? codexMigrationOutcomeSchema.safeParse(error.responseBody) : undefined
        if (!parsed?.success) throw error
        result = parsed.data
      }
      if (result.threadId && result.threadId !== binding.nativeId) throw new HapiRequestError('Codex migration returned another original thread', 'indeterminate')
      entry.receipt.codexResult = result; entry.receipt.status = result.success ? 'confirmed' : 'failed'
      entry.receipt.phase = result.success ? 'complete' : 'migration'; entry.receipt.message = result.error ?? null
    } else {
      if (binding.flavor !== 'cursor' || !binding.nativeId) throw refused('An original Cursor session identity is required')
      const metadata = agent.sourceSession.metadata
      if (metadata?.cursorSessionProtocol === 'acp') throw refused('The original Cursor session already uses ACP')
      if ((agent.sourceSession.active || ['running', 'idle'].includes(metadata?.lifecycleState ?? '')) && !action.forceArchiveRunning) {
        throw refused('The Cursor source is active. Archive it first or explicitly allow this migration to archive it.')
      }
      entry.receipt.phase = 'migration'; entry.migrationSent = true; this.save(entry)
      let result: z.infer<typeof cursorMigrationOutcomeSchema>
      try { result = cursorMigrationOutcomeSchema.parse(await this.client.request(`${sourcePath(binding.sourceSessionId)}/migrate-to-acp`, {
        method: 'POST', body: { keepSource: action.keepSource, forceArchiveRunning: action.forceArchiveRunning, skipVerify: action.skipVerify }, timeoutMs: 180_000,
      })) } catch (error) {
        const parsed = error instanceof HapiRequestError && error.status !== 401 ? cursorMigrationOutcomeSchema.safeParse(error.responseBody) : undefined
        if (!parsed?.success) throw error
        result = parsed.data
      }
      if (result.sessionId !== binding.sourceSessionId || result.ok && result.acpSessionId !== binding.nativeId) throw new HapiRequestError('Cursor migration returned another native session identity', 'indeterminate')
      entry.receipt.cursorResult = result; entry.receipt.status = result.ok ? 'confirmed' : 'failed'
      entry.receipt.phase = result.ok ? 'complete' : 'migration'; entry.receipt.message = result.ok ? null : `${result.reason}: ${result.message}`
    }
    this.save(entry); await this.observeMigration(entry)
  }

  private async attach(source: HapiSession): Promise<string | null> {
    try {
      let display = await this.sessions.reconcileSource(source.id)
      if (!display || display.binding.hubId !== this.client.hubId || display.binding.hapiSessionId !== source.id) return null
      await display.refresh(true); display = this.sessions.byHapiSession(source.id)
      if (!display || !matchingSource(sourceBinding(display), source)) return null
      if (source.metadata?.flavor === 'codex' && (sourceBinding(display).sourceHome !== (source.metadata.codexHome ?? source.metadata.codexStoreId ?? null)
        || sourceBinding(display).homeId !== (source.metadata.codexHomeId ?? null))) return null
      return display.id
    } catch { return null }
  }
  private async observe(entry: Entry): Promise<void> {
    try { if (entry.input.action.kind === 'pi-import') await this.observePi(entry); else await this.observeMigration(entry) }
    catch (error) { entry.receipt.canContinue = false; entry.receipt.message = `The original operation remains recorded: ${message(error)}`; this.save(entry) }
  }
  private async observePi(entry: Entry): Promise<void> {
    const action = entry.input.action
    if (action.kind !== 'pi-import' || !entry.importSent) return
    let listed: z.infer<typeof piHistoryEntrySchema>[] | undefined
    entry.receipt.canContinue = false
    for (const item of entry.receipt.items) {
      item.sessionId = null; item.active = false; item.importState = null
      if (item.confirmation === 'metadata') item.confirmation = 'none'
      try {
        if (!item.sourceSessionId) {
          listed ??= await this.listPi({ machineId: action.machineId, ...(action.cwd === undefined ? {} : { cwd: action.cwd }) })
          item.sourceSessionId = listed.find(row => row.id === item.piSessionId)?.hapiSessionId ?? null
        }
        if (!item.sourceSessionId) continue
        const source = await this.client.getSession(item.sourceSessionId)
        if (source.id !== item.sourceSessionId || source.metadata?.flavor !== 'pi' || source.metadata.machineId !== action.machineId
          || source.metadata.piSessionId !== item.piSessionId) throw refused('The imported Pi source identity does not match its selected Runner and native history')
        item.active = source.active
        const state = piImportStateSchema.safeParse(record(source.metadata)?.piImportState)
        const selected = entry.selected.find(row => row.id === item.piSessionId)
        if (state.success && state.data.machineId === action.machineId && state.data.piSessionId === item.piSessionId
          && state.data.sourceFile === selected?.file) {
          item.importState = state.data
          if (!item.error && (state.data.state === 'failed' || state.data.state === 'diverged')) item.error = {
            code: state.data.state === 'diverged' ? 'transcript_diverged' : 'import_failed', message: state.data.error ?? 'Pi import needs source review',
          }
          // A matching source marker can establish that the selected branch is
          // present, but it never invents appended counts or a POST receipt.
          if (item.confirmation === 'none' && !item.error && state.data.state === 'complete'
            && (state.data.leafEntryId ?? null) === (selected?.leafEntryId ?? null)) item.confirmation = 'metadata'
        }
        if (item.confirmation !== 'none' && !item.error) item.sessionId = await this.attach(source)
      } catch (error) { entry.receipt.message = message(error) }
    }
    const only = entry.receipt.items.length === 1 ? entry.receipt.items[0] : undefined
    entry.receipt.sourceSessionId = only?.sourceSessionId ?? null; entry.receipt.sessionId = only?.sessionId ?? null
    const selected = only && entry.selected.find(row => row.id === only.piSessionId)
    if (action.connect && only && !only.error && only.confirmation !== 'none' && only.importState?.state === 'complete'
      && (only.importState.leafEntryId ?? null) === (selected?.leafEntryId ?? null)) {
      if (entry.connectSent && only.active) { entry.receipt.status = 'confirmed'; entry.receipt.phase = 'complete'; entry.receipt.message = null }
      else if (!entry.connectSent && entry.receipt.status !== 'failed' && entry.receipt.status !== 'rejected') {
        entry.receipt.canContinue = !!only.sessionId && this.client.isConnected !== false
        if (entry.receipt.canContinue) { entry.receipt.status = 'ready-to-connect'; entry.receipt.message = 'The original Pi history is imported. Continue this same operation to reopen it once.' }
      }
    }
    if (!entry.importAcknowledged && entry.receipt.status === 'indeterminate' && entry.receipt.items.some(item => item.confirmation === 'metadata')) {
      entry.receipt.message = 'Matching imported Pi history is visible. The original import response, action and appended count remain unknown; it has not been re-sent.'
    }
    this.save(entry)
  }
  private async connectPi(entry: Entry): Promise<void> {
    const action = entry.input.action, item = entry.receipt.items[0]
    if (action.kind !== 'pi-import' || !action.connect || entry.connectSent || !entry.receipt.canContinue || !item?.sourceSessionId) throw refused('The original imported Pi history is not ready for a first reconnect')
    const source = await this.client.getSession(item.sourceSessionId)
    if (source.id !== item.sourceSessionId || source.metadata?.flavor !== 'pi' || source.metadata.machineId !== action.machineId
      || source.metadata.piSessionId !== item.piSessionId) throw refused('The Pi source binding changed before reconnect')
    const marker = piImportStateSchema.safeParse(record(source.metadata)?.piImportState), selected = entry.selected.find(row => row.id === item.piSessionId)
    if (!marker.success || marker.data.state !== 'complete' || marker.data.machineId !== action.machineId
      || marker.data.piSessionId !== item.piSessionId || marker.data.sourceFile !== selected?.file
      || (marker.data.leafEntryId ?? null) !== (selected?.leafEntryId ?? null)) throw refused('The selected Pi history branch changed before reconnect')
    if (record(source.metadata)?.piResumeAttempt) throw refused('The original Pi resume is already in progress or quarantined; read its source state before another attempt')
    if (source.active) {
      entry.receipt.status = 'confirmed'; entry.receipt.phase = 'complete'; entry.receipt.canContinue = false
      entry.receipt.sessionId = item.sessionId = await this.attach(source); entry.receipt.message = null; this.save(entry); return
    }
    entry.connectSent = true; entry.receipt.canContinue = false; entry.receipt.phase = 'connect'; entry.receipt.status = 'submitting'; this.save(entry)
    const response = reconnectResponse.parse(await this.client.request(`${sourcePath(item.sourceSessionId)}/reopen`, { method: 'POST', body: {}, timeoutMs: 180_000 }))
    const target = await this.client.getSession(response.sessionId)
    if (target.id !== response.sessionId || target.metadata?.flavor !== 'pi' || target.metadata.machineId !== action.machineId
      || target.metadata.piSessionId !== item.piSessionId) throw new HapiRequestError('Pi reopen returned a different native session', 'indeterminate')
    item.sourceSessionId = target.id; entry.receipt.sourceSessionId = target.id
    entry.receipt.status = 'submitted'; entry.receipt.message = 'The original Runner acknowledged Pi reopen; waiting for its source registration.'
    this.save(entry); await this.observePi(entry)
  }
  private async observeMigration(entry: Entry): Promise<void> {
    const binding = entry.binding, action = entry.input.action
    if (!binding || action.kind === 'pi-import') return
    entry.receipt.sessionId = null; entry.receipt.observation = null
    const source = await this.client.getSession(binding.sourceSessionId)
    if (!matchingSource(binding, source)) {
      entry.receipt.sessionId = null; entry.receipt.message = 'The source native identity changed. This operation cannot target a replacement thread.'; this.save(entry); return
    }
    const home = source.metadata?.codexHome ?? source.metadata?.codexStoreId ?? null
    const protocol = source.metadata?.cursorSessionProtocol ?? null
    const targetObserved = action.kind === 'codex-home' ? home === entry.target?.path : protocol === 'acp'
    const progress = sourceMigrationProgressSchema.safeParse(record(source.metadata)?.migrationInProgress)
    const sessionId = targetObserved ? await this.attach(source) : this.sessions.byHapiSession(source.id)?.id ?? null
    entry.receipt.sessionId = sessionId
    entry.receipt.observation = { sourceSessionId: source.id, sessionId, nativeId: binding.nativeId, active: source.active,
      codexHome: home, cursorProtocol: protocol, migrationInProgress: progress.success ? progress.data : null, targetObserved }
    if (entry.receipt.status === 'indeterminate' && targetObserved) entry.receipt.message = action.kind === 'codex-home'
      ? 'The source now points to the target Codex home. The original migration response and file-verification outcome remain unknown; no migration was replayed.'
      : 'The source now advertises ACP. The original verification, replay count and legacy-file cleanup result remain unknown; no migration was replayed.'
    this.save(entry)
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }
}
