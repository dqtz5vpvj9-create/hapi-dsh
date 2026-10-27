import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HapiRequestError, type HapiSession } from '../codex/contracts.js'
import { canonicalJson, record } from '../codex/native.js'
import { writeDurableJson } from '../codex/durable-file.js'
import { nativeForkSourceResponseSchema, nativeForkSourceSchema, type NativeForkReceipt } from '../codex/control-types.js'
import { mergeNativeForkReceipt } from './native-control.js'
import { observedBinding, observedSessionId, sameObservedIdentity, type ObservedBinding } from '../hapi-agent/identity.js'
import type { HapiObservedProjection } from '../hapi-agent/projection-types.js'
import { sourceOperationSchema, sourceOperationReadSchema, sourceOperationReceiptSchema,
  type SourceAction, type SourceOperation, type SourceOperationRead, type SourceOperationReceipt, type SourceSessionTools } from '../hapi-agent/lifecycle-types.js'
import { SOURCE_CREATION_FLAVORS, SOURCE_LAUNCH_PERMISSION_MODES } from '../hapi-agent/creation-types.js'

export interface SourceLifecycleTransport {
  readonly hubId: string
  readonly isConnected?: boolean
  getSession(sourceId: string): Promise<HapiSession>
  request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>
}
export interface SourceLifecycleAgent {
  readonly id: string
  readonly logicalSessionId: string
  readonly binding: ObservedBinding
  readonly sourceSession: HapiSession
  readonly projection: Pick<NonNullable<HapiObservedProjection>, 'readOnly' | 'connection' | 'delivery' | 'capabilities'>
  refresh(history?: boolean): Promise<void>
  resolveRewindLocalId(messageId: string): string | undefined
  resolveRewindLocalIdAtSeq(seq: number): string | undefined
}
export interface SourceLifecycleSessions {
  get(id: string): SourceLifecycleAgent | undefined
  /** Resolve a display seq, including a paged historical row. */
  resolveRewind?(sessionId: string, seq: number): string | undefined
  reconcileSource(sourceId: string): Promise<SourceLifecycleAgent | undefined>
  detachSource(sourceId: string): Promise<void>
}

const bindingSchema = z.object({ hubId: z.string(), hapiSessionId: z.string(), flavor: z.string(), nativeId: z.string().nullable(), machineId: z.string().nullable() })
const entrySchema = z.object({ input: sourceOperationSchema, binding: bindingSchema, receipt: sourceOperationReceiptSchema,
  fork: z.object({ tracked: z.boolean(), expectedRevision: z.number().int().nonnegative().nullable(),
    messageLocalId: z.string().nullable(), duplicateRiskOf: z.string().uuid().nullable() }).nullable() })
type Entry = z.infer<typeof entrySchema>
const journalSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) })
const sourcePath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`
const ackSchema = z.object({ ok: z.literal(true) })
const sourceIdSchema = z.object({ sessionId: z.string().min(1) })
const json = (value: unknown): z.infer<ReturnType<typeof z.json>> => z.json().parse(JSON.parse(JSON.stringify(value)))
const text = (error: unknown): string => error instanceof Error ? error.message : 'The original owner did not confirm the operation'
const unresolved = (receipt: SourceOperationReceipt) => ['submitting', 'submitted', 'indeterminate'].includes(receipt.status)
const sharedCodex = (source: HapiSession) => source.metadata?.flavor === 'codex' && source.metadata.capabilities?.concurrentClients === true
const forkPending = (receipt: NativeForkReceipt) => receipt.status === 'running' || receipt.status === 'indeterminate'
  || receipt.status === 'created' && receipt.binding !== 'ready'

/** Existing engine lifecycle and history remain with the original HAPI source. */
export class SourceLifecycle {
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Map<string, Promise<SourceOperationReceipt>>()
  private readonly filename: string
  constructor(private readonly client: SourceLifecycleTransport, private readonly sessions: SourceLifecycleSessions, directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${observedSessionId(client.hubId, 'source-lifecycle')}.json`)
    try {
      for (const entry of journalSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8'))).entries) {
        if (entry.receipt.status === 'submitting') {
          entry.receipt.status = 'indeterminate'
          entry.receipt.message = 'The workspace restarted before the original owner reply was recorded. This operation will not be sent again.'
        }
        this.entries.set(entry.receipt.operationId, entry)
      }
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }
  private persist(): void { writeDurableJson(this.filename, { version: 1, entries: [...this.entries.values()] }) }
  private agent(id: string, write = false): SourceLifecycleAgent {
    const agent = this.sessions.get(id)
    if (!agent || agent.binding.hubId !== this.client.hubId || write && agent.id !== id) {
      throw new HapiRequestError('Acquire the current source display before changing this HAPI session', 'rejected', 404, 'source_display_changed')
    }
    if (agent.sourceSession.metadata?.codexNativeSession) throw new HapiRequestError('Native Codex uses its native source controls', 'rejected', 400)
    return agent
  }
  private capabilities(agent: SourceLifecycleAgent): SourceSessionTools['capabilities'] {
    const source = agent.sourceSession, lifecycle = source.metadata?.lifecycleState
    const connected = agent.projection.connection === 'connected' && this.client.isConnected !== false
    const historyIdle = connected && !agent.projection.readOnly && !source.thinking && !source.metadata?.conversationHistoryDiverged
      && !agent.projection.delivery.some(value => !['invoked', 'cancelled', 'rejected'].includes(value.state))
    const launchable = (SOURCE_CREATION_FLAVORS as readonly string[]).includes(agent.binding.flavor) || agent.binding.flavor === 'codex'
    const restorable = launchable && Boolean(source.metadata?.path)
    return { archive: connected && (source.active || ['running', 'idle', 'archived'].includes(lifecycle ?? '')),
      reopen: connected && !source.active && restorable, resume: connected && !source.active && restorable && lifecycle !== 'archived',
      restart: connected && source.active, delete: connected && !source.active,
      // The pinned /clear implementation validates a shared Codex child; a
      // generic concurrentClients flag from another engine is not sufficient.
      clear: connected && sharedCodex(source), summary: connected, pin: connected,
      forkCurrent: historyIdle && agent.projection.capabilities.forkCurrent,
      forkAtMessage: historyIdle && agent.projection.capabilities.forkAtMessage,
      rewind: historyIdle && agent.projection.capabilities.rewindToMessage }
  }
  async sessionTools(id: string): Promise<SourceSessionTools> {
    let agent = this.agent(id)
    await agent.refresh(); agent = this.agent(id)
    const source = agent.sourceSession, capabilities = this.capabilities(agent)
    const warnings: string[] = []
    let forkSource: SourceSessionTools['forkSource'] = null
    if (sharedCodex(source)) {
      try { forkSource = nativeForkSourceSchema.parse(await this.client.request(`${sourcePath(source.id)}/fork-operations`)) }
      catch (error) { warnings.push(`Source fork receipt state is unavailable: ${text(error)}`); capabilities.forkCurrent = false; capabilities.forkAtMessage = false }
    }
    const operations = [...this.entries.values()].filter(entry => sameObservedIdentity(entry.binding, agent.binding))
      .map(entry => entry.receipt).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
    if (operations.some(value => value.action.kind === 'fork' && unresolved(value))) warnings.push(
      'A previous fork is unresolved. Read its original receipt. A new fork requires an explicit duplicate-risk intent.')
    return { sessionId: agent.id, sourceSessionId: source.id, nativeId: agent.binding.nativeId, flavor: agent.binding.flavor,
      active: source.active, readOnly: agent.projection.readOnly, lifecycleState: source.metadata?.lifecycleState ?? null,
      summary: source.metadata?.summary?.text ?? '', pinMode: source.globalPinned ? 'global' : source.pinned ? 'project' : 'none',
      capabilities, forkSource, warnings, operations: structuredClone(operations) }
  }
  async operate(input: SourceOperation): Promise<SourceOperationReceipt> {
    const request = sourceOperationSchema.parse(input), previous = this.entries.get(request.operationId)
    if (previous) {
      if (canonicalJson(previous.input) !== canonicalJson(request)) throw new HapiRequestError('This operation ID belongs to another immutable source action', 'rejected', 400)
      return this.flights.get(request.operationId) ?? structuredClone(previous.receipt)
    }
    const agent = this.agent(request.sessionId, true), now = Date.now()
    const entry: Entry = { input: request, binding: structuredClone(agent.binding), fork: null,
      receipt: { operationId: request.operationId, sourceSessionId: agent.binding.hapiSessionId,
        logicalSessionId: agent.logicalSessionId, flavor: agent.binding.flavor, action: request.action,
        status: 'submitting', createdAt: now, updatedAt: now, message: null, sourceCode: null,
        result: null, canReconcile: false, sourceFork: null } }
    this.entries.set(request.operationId, entry)
    try { this.persist() } catch (error) { this.entries.delete(request.operationId); throw error }
    return this.track(entry, () => this.dispatch(entry, agent))
  }
  private track(entry: Entry, run: () => Promise<void>): Promise<SourceOperationReceipt> {
    const found = this.flights.get(entry.receipt.operationId)
    if (found) return found
    const task = (async () => { await run(); return structuredClone(entry.receipt) })()
    this.flights.set(entry.receipt.operationId, task)
    void task.finally(() => { if (this.flights.get(entry.receipt.operationId) === task) this.flights.delete(entry.receipt.operationId) }).catch(() => {})
    return task
  }
  private async dispatch(entry: Entry, agent: SourceLifecycleAgent): Promise<void> {
    let sent = false
    try {
      const action = entry.input.action
      await agent.refresh(action.kind === 'rewind' || action.kind === 'fork')
      if (this.agent(entry.input.sessionId, true) !== agent || !sameObservedIdentity(entry.binding, agent.binding)) throw new Error('The source identity changed before dispatch')
      entry.binding = structuredClone(agent.binding)
      const capabilities = this.capabilities(agent)
      const hasBoundary = (action.kind === 'rewind' || action.kind === 'fork') && (action.displayMessageId !== undefined || action.displayMessageSeq !== undefined)
      const enabled = action.kind === 'fork' ? hasBoundary ? capabilities.forkAtMessage : capabilities.forkCurrent : capabilities[action.kind]
      if (!enabled) throw new Error(`The original source does not currently permit ${action.kind}`)
      const boundary = hasBoundary && (action.kind === 'rewind' || action.kind === 'fork')
        ? action.displayMessageId === undefined
          ? (() => { const seq = (action as { displayMessageSeq?: number }).displayMessageSeq!
            return this.sessions.resolveRewind?.(agent.id, seq) ?? agent.resolveRewindLocalIdAtSeq(seq) })()
          : agent.resolveRewindLocalId(action.displayMessageId) : undefined
      if (hasBoundary && !boundary) throw new Error('Only an invoked original user message can be a source history boundary')
      if (action.kind === 'resume' && action.permissionMode !== undefined) {
        const modes: readonly string[] = agent.binding.flavor === 'codex' ? ['default', 'read-only', 'safe-yolo', 'yolo']
          : SOURCE_LAUNCH_PERMISSION_MODES[agent.binding.flavor as keyof typeof SOURCE_LAUNCH_PERMISSION_MODES] ?? []
        if (!modes.includes(action.permissionMode)) throw new Error('This source does not support the requested resume permission mode')
      }
      const path = sourcePath(entry.binding.hapiSessionId)
      let suffix = `/${action.kind}`, method = 'POST', body: unknown = {}
      if (action.kind === 'pin') { method = 'PUT'; body = { mode: action.mode } }
      else if (action.kind === 'summary') { method = 'PATCH'; body = { text: action.text } }
      else if (action.kind === 'delete') { method = 'DELETE'; suffix = '' }
      else if (action.kind === 'resume') body = action.permissionMode === undefined ? {} : { permissionMode: action.permissionMode }
      else if (action.kind === 'rewind') body = { messageLocalId: boundary }
      else if (action.kind === 'fork') body = await this.prepareFork(entry, agent, boundary)
      this.persist()
      sent = true
      const response = await this.client.request(`${path}${suffix}`, { method, body, timeoutMs: action.kind === 'fork' ? 180_000 : 120_000 })
      if (action.kind === 'fork' && entry.fork?.tracked) await this.acceptFork(entry, nativeForkSourceResponseSchema.parse(response).operation)
      else if (['fork', 'clear', 'resume', 'reopen'].includes(action.kind)) {
        const target = sourceIdSchema.parse(response).sessionId
        this.confirm(entry, { sourceSessionId: target, sessionId: null, displayReady: false })
        await this.attachResult(entry, target)
      } else {
        if (action.kind === 'rewind') z.object({ success: z.literal(true) }).parse(response)
        else ackSchema.parse(response)
        this.confirm(entry, { ok: true })
        if (action.kind === 'delete') await this.sessions.detachSource(entry.binding.hapiSessionId)
        else {
          try {
            const display = await this.sessions.reconcileSource(entry.binding.hapiSessionId)
            if (action.kind === 'rewind') entry.receipt.result = json({ ok: true, sourceSessionId: entry.binding.hapiSessionId,
              sessionId: display?.id ?? null, displayReady: Boolean(display) })
          } catch { /* The source response already confirmed the mutation. */ }
          if (action.kind === 'restart') entry.receipt.message = 'The source acknowledged restart. Its next input resumes the session through the original Runner.'
        }
      }
    } catch (error) {
      if (entry.receipt.status !== 'confirmed' && !entry.receipt.sourceFork) {
        const rejected = !sent || error instanceof HapiRequestError && error.outcome === 'rejected' && [400, 403, 404, 422].includes(error.status ?? 0)
        entry.receipt.status = rejected ? 'rejected' : 'indeterminate'
        entry.receipt.message = text(error)
        entry.receipt.sourceCode = error instanceof HapiRequestError ? error.code ?? null : null
      } else if (entry.receipt.status !== 'confirmed') entry.receipt.message = text(error)
    }
    entry.receipt.updatedAt = Date.now(); this.persist()
  }
  private async prepareFork(entry: Entry, agent: SourceLifecycleAgent, boundary: string | undefined): Promise<unknown> {
    const action = entry.input.action
    if (action.kind !== 'fork') throw new Error('Fork request required')
    const blocking = [...this.entries.values()].find(value => value !== entry && value.input.action.kind === 'fork'
      && sameObservedIdentity(value.binding, entry.binding) && unresolved(value.receipt))
    if (blocking && (action.duplicateRiskOf !== blocking.receipt.operationId || blocking.receipt.status !== 'indeterminate')) {
      throw new Error('A source fork is unresolved. Read its receipt before explicitly accepting the risk of another fork')
    }
    if (action.duplicateRiskOf) {
      const prior = this.entries.get(action.duplicateRiskOf)
      if (!prior || prior.input.action.kind !== 'fork' || !sameObservedIdentity(prior.binding, entry.binding)
        || prior.receipt.status !== 'indeterminate') throw new Error('The acknowledged duplicate risk must identify this source’s original indeterminate fork')
    }
    const tracked = sharedCodex(agent.sourceSession)
    let revision: number | null = null
    if (tracked) {
      const state = nativeForkSourceSchema.parse(await this.client.request(`${sourcePath(entry.binding.hapiSessionId)}/fork-operations`))
      if (state.blockingSourceSessionId) throw new Error('A fork of this original thread is unresolved through another source session')
      if (state.operation && forkPending(state.operation) && action.duplicateRiskOf !== state.operation.operationId) throw new Error('The source already has an unresolved native fork receipt')
      if (action.duplicateRiskOf && boundary) throw new Error('A shared-Codex duplicate-risk fork inherits its original source boundary')
      revision = state.revision
    }
    entry.fork = { tracked, expectedRevision: revision, messageLocalId: boundary ?? null, duplicateRiskOf: action.duplicateRiskOf ?? null }
    entry.receipt.canReconcile = tracked
    return { ...(tracked ? { operationId: entry.receipt.operationId, expectedForkRevision: revision,
      ...(action.duplicateRiskOf ? { duplicateRiskOf: action.duplicateRiskOf } : {}) } : {}),
      ...(boundary ? { messageLocalId: boundary } : {}) }
  }
  private confirm(entry: Entry, result: unknown, message: string | null = null): void {
    entry.receipt.status = 'confirmed'; entry.receipt.message = message; entry.receipt.sourceCode = null
    entry.receipt.result = json(result); entry.receipt.updatedAt = Date.now(); this.persist()
  }
  private async attachResult(entry: Entry, sourceId: string): Promise<void> {
    try {
      const source = await this.client.getSession(sourceId)
      if (source.metadata?.flavor !== entry.binding.flavor) throw new Error('The returned source belongs to another engine')
      if (entry.input.action.kind === 'fork' && (sourceId === entry.binding.hapiSessionId
        || source.metadata?.machineId !== entry.binding.machineId || source.metadata?.forkedFrom !== entry.binding.hapiSessionId)) throw new Error('The fork display does not match the original source lineage and Runner')
      if (entry.receipt.sourceFork?.status === 'created' && source.metadata?.codexSessionId !== entry.receipt.sourceFork.nativeThreadId) throw new Error('The child display does not match the source fork receipt')
      const display = await this.sessions.reconcileSource(sourceId)
      entry.receipt.result = json({ sourceSessionId: sourceId, sessionId: display?.id ?? null,
        displayReady: Boolean(display), nativeId: display?.binding.nativeId ?? null })
      if (!display) entry.receipt.message = 'The source confirmed the operation; its display is not attached yet. Read this receipt again.'
      else entry.receipt.message = null
    } catch (error) { entry.receipt.message = `The source confirmed the operation; its matching display is pending: ${text(error)}` }
  }
  private async acceptFork(entry: Entry, next: NativeForkReceipt): Promise<void> {
    if (next.operationId !== entry.receipt.operationId || next.sourceSessionId !== entry.binding.hapiSessionId
      || next.duplicateRiskOf !== (entry.fork?.duplicateRiskOf ?? undefined)
      || next.sourceRevision !== (entry.fork?.expectedRevision ?? -1) + 1) throw new Error('The source fork receipt does not match the immutable operation')
    const value = entry.receipt.sourceFork ? mergeNativeForkReceipt(entry.receipt.sourceFork, next) : next
    entry.receipt.sourceFork = value; entry.receipt.message = value.message; entry.receipt.sourceCode = value.code ?? null
    entry.receipt.status = value.status === 'rejected' ? 'rejected' : value.status === 'indeterminate' ? 'indeterminate'
      : value.status === 'created' && value.binding === 'ready' ? 'confirmed' : 'submitted'
    entry.receipt.updatedAt = Date.now(); this.persist()
    if (value.status === 'created') {
      entry.receipt.result = json({ sourceSessionId: value.childSessionId, sessionId: null, displayReady: false, nativeId: value.nativeThreadId })
      if (value.binding === 'ready') await this.attachResult(entry, value.childSessionId)
    }
  }
  async read(input: SourceOperationRead): Promise<SourceOperationReceipt> {
    const request = sourceOperationReadSchema.parse(input), entry = this.entries.get(request.operationId)
    if (!entry) throw new HapiRequestError('The source operation receipt is not known to this workspace', 'rejected', 404)
    return this.track(entry, async () => {
      if (entry.receipt.status === 'rejected') return
      try {
        if (entry.fork?.tracked) {
          const path = `${sourcePath(entry.binding.hapiSessionId)}/fork-operations/${encodeURIComponent(entry.receipt.operationId)}`
          const result = nativeForkSourceResponseSchema.parse(await this.client.request(request.action === 'reconcile' ? `${path}/reconcile` : path,
            request.action === 'reconcile' ? { method: 'POST', body: {}, timeoutMs: 120_000 } : {}))
          await this.acceptFork(entry, result.operation)
        } else if (request.action === 'reconcile') {
          throw new Error('This source operation has no native reconciliation endpoint. Read can observe state, but never sends the action again')
        } else {
          const target = record(entry.receipt.result)?.sourceSessionId
          if (entry.receipt.status === 'confirmed' && typeof target === 'string') await this.attachResult(entry, target)
          else if (unresolved(entry.receipt)) await this.observeOutcome(entry)
        }
      } catch (error) {
        if (entry.receipt.status !== 'confirmed') entry.receipt.message = `The original operation remains recorded: ${text(error)}`
      }
      entry.receipt.updatedAt = Date.now(); this.persist()
    })
  }
  private async observeOutcome(entry: Entry): Promise<void> {
    const action = entry.input.action
    let source: HapiSession
    try { source = await this.client.getSession(entry.binding.hapiSessionId) }
    catch (error) {
      if (action.kind === 'delete' && error instanceof HapiRequestError && error.status === 404 && error.outcome === 'rejected') {
        this.confirm(entry, { ok: true }, 'The original source is confirmed absent')
        await this.sessions.detachSource(entry.binding.hapiSessionId); return
      }
      throw error
    }
    if (!sameObservedIdentity(entry.binding, observedBinding(this.client.hubId, source))) throw new Error('The original source binding changed; this action will not be replayed')
    const applied = action.kind === 'summary' && source.metadata?.summary?.text === action.text
      || action.kind === 'pin' && (source.globalPinned ? 'global' : source.pinned ? 'project' : 'none') === action.mode
      || action.kind === 'archive' && !source.active && source.metadata?.lifecycleState === 'archived'
      || (action.kind === 'resume' || action.kind === 'reopen') && source.active && source.metadata?.lifecycleState !== 'archived'
    if (applied) {
      this.confirm(entry, { ok: true }, 'Confirmed by the original source state')
      if (action.kind === 'resume' || action.kind === 'reopen') await this.attachResult(entry, source.id)
      else { try { await this.sessions.reconcileSource(source.id) } catch { /* Source effect already observed. */ } }
    } else if (action.kind === 'fork') entry.receipt.message = 'This engine has no durable fork receipt API. The result is unknown; inspect the original source and its branches. Reading will not create another branch.'
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }
}
