import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type AgentCancelCause, type AgentEventDispatch, type AgentOptions, type AgentStatus, type Inbox, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord, SessionId, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { NativeApprovals } from '../codex/approvals.js'
import { DeliveryJournal } from '../codex/delivery.js'
import { readNativeHistory } from '../codex/history.js'
import { NativeHistoryCache } from '../codex/history-cache.js'
import { NativeHistoryChangedError } from '../codex/projector.js'
import type { HapiApprovalAnswer, HapiAttachment, HapiEvent, HapiMessage, HapiSession, HapiTransport } from '../codex/contracts.js'
import type { DeliveryView } from '../codex/projection-types.js'
import { ObservedContent, type ObservedContentOptions } from './content.js'
import { observedBinding, observedCapabilities, observedSessionId, sameObservedIdentity, type ObservedBinding } from './identity.js'
import { parseObservedHistory, parseObservedMessage, type ObservedItem } from './parser.js'
import { ObservedProjector } from './projector.js'
import { bindObservedCommands } from './commands.js'
import type { HapiObservedProjection, ObservedNotice, ObservedUsage } from './projection-types.js'
import { observedStateDirectory } from './state-directory.js'
import { ObservedScopeIndex } from './scopes.js'
import { ObservedChildren } from './children.js'
import { SourceDshChildren } from './dsh-children.js'
import { sourceTeamProjection, acceptSourceStructuredState } from '../source-collaboration-types.js'
import { queuedEditCandidate as readQueuedEditCandidate } from '../codex/queued-edit-candidate.js'

export interface HapiObservedTransport extends HapiTransport {
  readonly isConnected?: boolean
  request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>
}
export interface HapiObservedOptions extends ObservedContentOptions {
  stateDirectory: string
  displayRevision?: number
  resolveAttachments?: (sourceId: string, message: UserMessage) => Promise<HapiAttachment[]>
  onHistoryChanged?: (agent: HapiObservedAgent, rows: HapiMessage[]) => Promise<void>
}

class ObservedInbox implements Inbox {
  private turn: readonly UserMessage[] = []
  private step: readonly UserMessage[] = []
  constructor(private readonly owner: HapiObservedAgent) {}
  get nextTurn() { return this.turn }
  get nextStep() { return this.step }
  append(target: InboxTarget, message: UserMessage): void { this.owner.send(message, target, true) }
  prepend(_target: InboxTarget, _message: UserMessage): void { this.unsupported() }
  clear(): void { this.unsupported() }
  replace(_id: MessageId, _message: UserMessage): boolean { return this.unsupported() }
  remove(_id: MessageId): boolean { return this.unsupported() }
  splice(_target: InboxTarget, _start: number, _count: number, _inserted: UserMessage[]): UserMessage[] { return this.unsupported() }
  private unsupported(): never { throw new Error('Source-owned queue changes require asynchronous HAPI controls') }
  sync(turn: readonly UserMessage[], step: readonly UserMessage[]): void {
    for (const [target, next] of [['next-turn', turn], ['next-step', step]] as const) {
      const previous = target === 'next-turn' ? this.turn : this.step
      if (JSON.stringify(previous) === JSON.stringify(next)) continue
      this.owner.session.append('agent/inbox/spliced', { target, start: 0, removedCount: previous.length, inserted: [...next] })
      if (target === 'next-turn') this.turn = next; else this.step = next
      const seen = new Set(previous.map(message => message.id))
      for (const message of next) if (!seen.has(message.id)) this.owner.dispatch.emit('agent/inbox/inserted', { message })
    }
  }
}

/** A public Agent observer. HAPI's original engine owns every execution and mutation. */
export class HapiObservedAgent implements Agent {
  readonly id: SessionId
  readonly logicalSessionId: SessionId
  readonly displayRevision: number
  readonly ctx: Context
  readonly inbox: ObservedInbox
  readonly dispatch: AgentEventDispatch
  readonly journal: DeliveryJournal
  private source: HapiSession
  private bound: ObservedBinding
  private currentSession: Session
  private readonly scope: Scope
  private readonly projector: ObservedProjector
  private readonly cache: NativeHistoryCache
  private readonly content: ObservedContent
  private readonly sourceScopes = new ObservedScopeIndex()
  private readonly children: ObservedChildren
  private readonly dshChildren: SourceDshChildren
  private readonly approvals: NativeApprovals
  private readonly queued = new Map<string, { item: ObservedItem & { kind: 'user' }; row: HapiMessage }>()
  private readonly notices = new Map<string, ObservedNotice>()
  private usage: ObservedUsage | null = null
  private readonly idleWaiters = new Set<{ resolve(): void; reject(error: Error): void }>()
  private detachAgent: (() => void) | undefined
  private detachSession: (() => void) | undefined
  private disposed = false
  private initializing = true
  private connected: boolean
  private fault: string | null = null
  private fingerprint = ''
  private lastSelection = ''
  private lastTitle: { title: string; seq: SessionSeq } | undefined
  private pendingRefresh: Promise<void> | undefined
  private lastActivity = false

  private constructor(parent: Context, readonly transport: HapiObservedTransport, source: HapiSession, private readonly config: HapiObservedOptions) {
    this.source = source; this.bound = observedBinding(transport.hubId, source)
    this.logicalSessionId = observedSessionId(transport.hubId, source.id)
    this.displayRevision = config.displayRevision ?? 0
    this.id = this.displayRevision ? SessionId(`${this.logicalSessionId}-r${this.displayRevision}`) : this.logicalSessionId
    this.scope = createScope(parent, this); this.ctx = this.scope.ctx
    this.connected = transport.isConnected ?? true
    this.currentSession = this.ctx.sessions.prepare(this.id, { meta: this.meta() })
    this.dispatch = agentEvents(this.ctx, this); this.inbox = new ObservedInbox(this)
    const directory = observedStateDirectory(config.stateDirectory, this.logicalSessionId, this.bound)
    this.cache = new NativeHistoryCache(directory, this.logicalSessionId)
    this.content = new ObservedContent(directory, this.logicalSessionId, source.id, config)
    this.children = new ObservedChildren({ agent: this, logicalSessionId: this.logicalSessionId, displayRevision: this.displayRevision,
      content: item => this.content.get(item), state: () => ({
        hubId: this.bound.hubId, hapiSessionId: this.bound.hapiSessionId, flavor: this.bound.flavor,
        machineId: this.bound.machineId, machineName: this.source.metadata?.host ?? this.bound.machineId,
        path: this.source.metadata?.path ?? '/', active: this.source.active, connection: this.connected ? 'connected' : 'disconnected',
        model: this.source.model ?? null, effort: this.source.effort ?? this.source.modelReasoningEffort ?? null,
        permissionMode: this.source.permissionMode ?? null, error: this.fault,
      }) })
    this.dshChildren = new SourceDshChildren({ agent: this, logicalSessionId: this.logicalSessionId, displayRevision: this.displayRevision,
      source: () => this.source, isCurrent: () => !this.disposed, changed: () => this.publish(),
      historyChanged: async () => {
        if (this.disposed) return
        const rows = await readNativeHistory(this.transport, this.bound.hapiSessionId)
        if (!this.config.onHistoryChanged) throw new NativeHistoryChangedError('The original DSH child history changed; reacquire the source display')
        await this.config.onHistoryChanged(this, rows)
      },
      state: () => ({ hubId: this.bound.hubId, hapiSessionId: this.bound.hapiSessionId, flavor: this.bound.flavor,
        machineId: this.bound.machineId, machineName: this.source.metadata?.host ?? this.bound.machineId,
        path: this.source.metadata?.path ?? '/', active: this.source.active, connection: this.connected ? 'connected' : 'disconnected',
        model: this.source.model ?? null, effort: this.source.effort ?? this.source.modelReasoningEffort ?? null,
        permissionMode: this.source.permissionMode ?? null, error: this.fault }),
    }, transport, directory)
    this.journal = new DeliveryJournal(directory, this.logicalSessionId, source.id, transport, () => {
      if (!this.initializing && !this.disposed) { this.syncInbox(); this.publish() }
    }, config.resolveAttachments)
    this.approvals = new NativeApprovals(directory, this.logicalSessionId, source.id, transport, () => {
      if (!this.initializing && !this.disposed) this.publish()
    })
    this.projector = new ObservedProjector(this.session, { model: () => this.options.model ?? this.bound.flavor,
      submittedMessage: id => this.journal.get(id)?.message, content: item => this.content.get(item),
      stream: frame => this.dispatch.emit('agent/assistant-stream', { frame }) })
  }
  private meta() { return { cwd: this.source.metadata?.path ?? '/', createdAt: this.source.createdAt, agentPreset: 'hapi-observed' } }
  static async create(ctx: Context, transport: HapiObservedTransport, source: HapiSession, config: HapiObservedOptions, initialRows?: readonly HapiMessage[]): Promise<HapiObservedAgent> {
    const agent = new HapiObservedAgent(ctx, transport, source, config)
    try {
      let rows = initialRows
      if (!rows) {
        try { rows = await readNativeHistory(transport, source.id); agent.cache.write(rows) }
        catch (error) { rows = agent.cache.read() ?? []; agent.fault = error instanceof Error ? error.message : 'Source history is unavailable' }
      }
      agent.projector.beginHistorySeed(); await agent.applyRows(rows, true)
      agent.currentSession = agent.ctx.sessions.prepare(agent.id, { seed: agent.projector.historySeed(), meta: agent.meta() })
      agent.projector.finishHistorySeed(agent.session)
      agent.initializing = false; agent.observe(source)
      if (!agent.fault) await agent.journal.reconcileSource()
      agent.syncInbox(); agent.publish()
      agent.detachSession = agent.ctx.sessions.enter(agent.session)
      agent.detachAgent = agent.ctx.agents.enter(agent, undefined)
      bindObservedCommands(agent)
      agent.ctx.sessions.announce(agent.session); await agent.ctx.agents.announce(agent, 'startup')
      await agent.children.mount()
      await agent.dshChildren.mount()
      return agent
    } catch (error) { await agent.dispose(); throw error }
  }

  get binding(): ObservedBinding { return this.bound }
  get childSessions() { return [...this.children.list(), ...this.dshChildren.list()] }
  dshChild(sessionId: string) { return this.dshChildren.get(sessionId) }
  get sourceSession(): HapiSession { return this.source }
  get session(): Session { return this.currentSession }
  get status(): AgentStatus { return this.source.thinking ? 'running' : 'idle' }
  get titleEvent(): { title: string; seq: SessionSeq } | undefined { return this.lastTitle }
  get options(): AgentOptions { return { provider: 'hapi-observed', model: this.source.model ?? this.source.metadata?.codexModel ?? this.bound.flavor,
    ...((this.source.effort ?? this.source.modelReasoningEffort) ? { reasoningEffort: ReasoningEffortId((this.source.effort ?? this.source.modelReasoningEffort)!) } : {}) } }
  get projection(): NonNullable<HapiObservedProjection> {
    const capabilities = observedCapabilities(this.source)
    return { engine: 'hapi', ownership: 'hapi-runner', flavor: this.bound.flavor,
      hubId: this.bound.hubId, hapiSessionId: this.bound.hapiSessionId, logicalSessionId: this.logicalSessionId,
      displayRevision: this.displayRevision, machineId: this.bound.machineId,
      machineName: this.source.metadata?.host ?? this.bound.machineId, nativeId: this.bound.nativeId,
      path: this.source.metadata?.path ?? '/', active: this.source.active, thinking: this.source.thinking,
      controlledByUser: capabilities.switchToRemote, connection: this.connected ? 'connected' : 'disconnected',
      readOnly: !this.connected || !this.source.active || this.fault !== null || capabilities.switchToRemote,
      model: this.source.model ?? null, effort: this.source.effort ?? this.source.modelReasoningEffort ?? null,
      permissionMode: this.source.permissionMode ?? null, capabilities,
      pendingRequests: this.approvals.pending(), resolvedRequests: this.approvals.resolved(), delivery: this.deliveries(),
      notices: [...this.notices.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200), usage: this.usage,
      sidechains: [...this.children.summaries, ...this.dshChildren.summaries], error: this.fault, ...sourceTeamProjection(this.source) }
  }
  resolveRewindLocalId(id: string) { return this.projector.rewindLocalId(id) }
  resolveRewindLocalIdAtSeq(seq: number) { return this.projector.rewindLocalIdAtSeq(seq) }
  resolveSourceMessageDisplaySeq(id: string) { return this.projector.sourceMessageDisplaySeq(id) }
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.assertWritable()
    if (!wakeup) throw new Error('The original HAPI engine does not expose silent context injection')
    if (target === 'next-step' && !this.projection.capabilities.steer) throw new Error('This source engine does not support live steering')
    if (!this.projection.capabilities.images && message.content.some(block => block.type === 'image')) throw new Error('The source runtime does not advertise image input')
    this.journal.submit(message, target === 'next-step' ? 'steer' : 'queue')
  }
  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(_message: UserMessage): void { throw new Error('The original HAPI engine owns context injection') }
  scheduleText(input: { operationId: string; text: string; scheduledAt: number }): DeliveryView {
    this.assertWritable()
    if (!input.operationId.trim() || !input.text.trim()) throw new Error('Scheduled source messages require a stable operation id and nonempty text')
    const { message: _message, ...value } = this.journal.submit(freezeMessage({
      id: MessageId(`hapi-schedule:${input.operationId}`), role: 'user', source: { kind: 'user', rpcId: `scheduled:${input.operationId}` },
      content: [{ type: 'text', text: input.text }],
    }), 'queue', input.scheduledAt)
    return value
  }
  /** Inspect the same durable source delivery even while the source is offline. */
  scheduleReceipt(operationId: string): DeliveryView | null {
    const entry = this.journal.findByMessageId(`hapi-schedule:${operationId}`)
    if (!entry) return null
    const { message: _message, ...view } = entry
    return view
  }
  retryRejectedDelivery(localId: string): DeliveryView {
    this.assertWritable()
    const entry = this.journal.get(localId), capabilities = this.projection.capabilities
    if (entry?.mode === 'steer' && !capabilities.steer) throw new Error('The source no longer accepts live steering')
    if (entry?.message.content.some(block => block.type === 'image') && !capabilities.images) throw new Error('The source runtime does not advertise image input')
    const { message: _message, ...view } = this.journal.retryRejected(localId)
    return view
  }
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void {
    if (cause.kind === 'disposed') return
    this.assertWritable(); void this.abort(options?.keepInbox === true).catch(error => this.reportError(error))
  }
  async abort(keepInbox = true): Promise<void> {
    this.assertWritable()
    if (!keepInbox) await Promise.all(this.deliveries().filter(entry => !entry.scheduledAt).map(entry => this.cancelQueued(entry.localId)))
    await this.transport.abortSession(this.bound.hapiSessionId); await this.refresh()
  }
  whenIdle(): Promise<void> {
    if (this.disposed || !this.connected || !this.source.active) return Promise.reject(new Error('Source activity is unavailable until its owner reconnects'))
    if (!this.source.thinking) return Promise.resolve()
    return new Promise((resolve, reject) => { this.idleWaiters.add({ resolve, reject }) })
  }
  runMaintenance<T>(_task: (signal: AbortSignal) => Promise<T>): Promise<T> { throw new Error('The original HAPI engine owns maintenance') }
  async cancelQueued(localId: string) {
    this.assertWritable()
    const result = await this.transport.cancelQueuedMessage(this.bound.hapiSessionId, localId)
    if (result.status === 'cancelled') { this.journal.update(localId, 'cancelled'); this.queued.delete(localId) }
    else if (result.status === 'invoked') await this.applyRows([result.message])
    this.syncInbox(); this.publish(); return result
  }
  queuedEditCandidate(localId: string) {
    const value = this.queued.get(localId)
    return value ? readQueuedEditCandidate(value.row, value.item.text) : undefined
  }
  async steerQueued(localId: string) {
    this.assertWritable()
    if (!this.projection.capabilities.steer) throw new Error('This source engine does not support live steering')
    if (this.deliveries().some(entry => entry.localId === localId && entry.scheduledAt && entry.scheduledAt > Date.now())) throw new Error('A scheduled source message cannot be steered before it matures')
    const result = await this.transport.steerQueuedMessage(this.bound.hapiSessionId, localId)
    if (result.status === 'invoked') await this.applyRows([result.message])
    if (result.status === 'failed') this.journal.update(localId, 'indeterminate', result.error)
    await this.journal.reconcileSource(); return result
  }
  async retryIndeterminate(localId: string) {
    this.assertWritable()
    const result = await this.transport.retryIndeterminateMessage(this.bound.hapiSessionId, localId)
    if (result.status === 'invoked') await this.applyRows([result.message])
    else if (result.status === 'retried' || result.status === 'already-queued') this.journal.update(localId, 'queued')
    return result
  }
  async answerApproval(requestId: string, answer: HapiApprovalAnswer, deny = false) {
    this.assertWritable(); const value = await this.approvals.answer(requestId, answer, deny); await this.refresh(); return value
  }
  async rename(title: string): Promise<{ title: string; seq: SessionSeq }> {
    if (this.disposed) throw new Error('This source observation was detached')
    if (!title.trim()) throw new Error('The source session title cannot be empty')
    await this.transport.request(`/api/sessions/${encodeURIComponent(this.bound.hapiSessionId)}`, { method: 'PATCH', body: { name: title } })
    await this.refresh()
    if (!this.lastTitle || this.lastTitle.title !== title.trim()) throw new Error('The source has not confirmed the requested title')
    return this.lastTitle
  }
  async handleEvent(event: HapiEvent): Promise<void> {
    if (this.disposed || event.type === 'toast') return
    if (event.type === 'connection-changed') {
      this.connected = event.data?.status === 'connected'
      if (this.connected) await this.refresh(true)
      else { this.rejectWaiters('Source activity is unavailable until its owner reconnects'); this.publish() }
      return
    }
    if (event.sessionId !== this.bound.hapiSessionId) return
    if (event.type === 'message-received') await this.applyRows([event.message])
    else if (event.type === 'messages-consumed') {
      for (const id of event.localIds) { this.journal.update(id, 'invoked'); this.queued.delete(id) }
      await this.refresh(true)
    } else if (['messages-dispatching', 'messages-indeterminate', 'messages-requeued'].includes(event.type) && 'localIds' in event) {
      for (const id of event.localIds) this.journal.update(id, event.type === 'messages-dispatching' ? 'dispatching' : event.type === 'messages-indeterminate' ? 'indeterminate' : 'queued')
      await this.refresh(true)
    } else if (event.type === 'message-cancelled') {
      if (event.localId) { this.journal.update(event.localId, 'cancelled'); this.queued.delete(event.localId) }
      this.syncInbox(); this.publish()
    } else if (['messages-invalidated', 'message-updated', 'scheduled-matured'].includes(event.type)) await this.refresh(true)
    else if (event.type === 'session-removed') { this.connected = false; this.publish() }
    else await this.refresh()
  }
  async refresh(history = false): Promise<void> {
    if (this.pendingRefresh) { await this.pendingRefresh; if (history && !this.disposed) return this.refresh(true); return }
    const work = (async () => {
      if (this.disposed) return
      this.observe(await this.transport.getSession(this.bound.hapiSessionId))
      let rows: HapiMessage[] | undefined
      try {
        if (history) {
          rows = await readNativeHistory(this.transport, this.bound.hapiSessionId); this.cache.write(rows)
          await this.applyRows(rows, true)
        }
        await this.dshChildren.refresh(history)
      } catch (error) {
        if (error instanceof NativeHistoryChangedError && this.config.onHistoryChanged) {
          await this.config.onHistoryChanged(this, rows ?? await readNativeHistory(this.transport, this.bound.hapiSessionId)); return
        }
        throw error
      }
      await this.journal.reconcileSource(); this.fault = null; this.syncInbox(); this.publish()
    })()
    this.pendingRefresh = work
    try { await work } finally { if (this.pendingRefresh === work) this.pendingRefresh = undefined }
  }
  private observe(snapshot: HapiSession): void {
    const previous = this.source
    const source: HapiSession = { ...snapshot,
      ...acceptSourceStructuredState(previous, snapshot),
      metadata: snapshot.metadataVersion >= previous.metadataVersion ? snapshot.metadata : previous.metadata,
      metadataVersion: Math.max(snapshot.metadataVersion, previous.metadataVersion),
      agentState: snapshot.agentStateVersion >= previous.agentStateVersion ? snapshot.agentState : previous.agentState,
      agentStateVersion: Math.max(snapshot.agentStateVersion, previous.agentStateVersion),
      ...(snapshot.thinkingAt < previous.thinkingAt ? { thinking: previous.thinking, thinkingAt: previous.thinkingAt } : {}),
    }
    const next = observedBinding(this.bound.hubId, source)
    if (!sameObservedIdentity(this.bound, next)) throw new Error('The source engine identity changed; acquire its current display generation before sending')
    if (this.bound.nativeId === null && next.nativeId !== null) {
      observedStateDirectory(this.config.stateDirectory, this.logicalSessionId, next); this.bound = next
    }
    this.source = source; this.approvals.observe(source.agentState)
    if (source.thinking !== this.lastActivity) {
      this.lastActivity = source.thinking; this.dispatch.emit('agent/status', { status: this.status })
      if (!source.thinking) { for (const waiter of this.idleWaiters) waiter.resolve(); this.idleWaiters.clear() }
    }
    const title = source.metadata?.name ?? source.metadata?.summary?.text
    if (title?.trim() && this.lastTitle?.title !== title.trim()) {
      const event = this.session.append('session/title', { title: title.trim(), messageSeqs: [], source: { kind: 'user' } })
      this.lastTitle = { title: title.trim(), seq: event.seq }
    }
    const selection = { provider: 'hapi-observed', model: this.options.model ?? this.bound.flavor,
      ...(this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort }) }
    const selectionKey = JSON.stringify(selection)
    if (selectionKey !== this.lastSelection) { this.session.append('model/selection', selection); this.lastSelection = selectionKey }
  }
  private async applyRows(rows: readonly HapiMessage[], authoritative = false): Promise<void> {
    this.sourceScopes.update(rows, authoritative)
    const items = authoritative ? parseObservedHistory(rows, this.sourceScopes) : rows.flatMap(row => parseObservedMessage(row, this.sourceScopes))
    await this.content.prepare(items)
    if (this.disposed) return
    if (authoritative) {
      const observed = new Set(items.filter(item => item.scopeId === null).map(item => item.key))
      for (const key of this.projector.projectedKeys) if (!observed.has(key)) throw new NativeHistoryChangedError('The original HAPI history was truncated or replaced')
      this.queued.clear()
    }
    this.projector.apply(items)
    await this.children.apply(items, this.sourceScopes.scopes(), authoritative)
    const sourceRows = new Map(rows.map(row => [row.id, row]))
    for (const item of items) {
      if (item.kind === 'notice' && item.scopeId === null) this.notices.set(item.key, item.notice)
      else if (item.kind === 'usage' && item.scopeId === null && (!this.usage || item.createdAt >= this.usage.createdAt)) this.usage = item.usage
      else if (item.kind === 'user' && item.localId && item.scopeId === null) {
        if (item.invoked) { this.journal.update(item.localId, 'invoked'); this.queued.delete(item.localId) }
        else {
          const row = sourceRows.get(item.rowId)
          if (row) { this.queued.set(item.localId, { item, row }); this.journal.update(item.localId, row.deliveryState ?? 'queued') }
        }
      }
    }
    if (!this.initializing) { this.syncInbox(); this.publish() }
  }
  private deliveries(): DeliveryView[] {
    const values = new Map(this.journal.view().map(value => [value.localId, value]))
    for (const [localId, { item, row }] of this.queued) if (!values.has(localId)) values.set(localId, {
      localId, messageId: row.id, text: item.text, mode: item.mode, createdAt: row.createdAt,
      state: row.deliveryState ?? 'queued', scheduledAt: row.scheduledAt ?? null, error: null,
    })
    return [...values.values()].map(entry => ({ ...entry, editable: this.queuedEditCandidate(entry.localId) !== undefined }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  private syncInbox(): void {
    const turn: UserMessage[] = [], step: UserMessage[] = []
    for (const delivery of this.deliveries()) {
      const queued = this.queued.get(delivery.localId)
      const message = this.journal.get(delivery.localId)?.message ?? freezeMessage({ id: MessageId(`hapi-observed:${delivery.localId}`),
        role: 'user', source: { kind: 'user' }, content: queued ? this.content.get(queued.item) ?? [{ type: 'text', text: delivery.text }] : [{ type: 'text', text: delivery.text }] })
      ;(delivery.mode === 'steer' ? step : turn).push(message)
    }
    this.inbox.sync(turn, step)
  }
  private publish(): void {
    if (this.disposed || !this.approvals) return
    this.children.publishOwner()
    this.dshChildren.publishOwner()
    const value = this.projection, key = JSON.stringify(value)
    if (key !== this.fingerprint) { appendPluginRecord(this.session, 'plugin:hapi-dsh-observed/state', value); this.fingerprint = key }
  }
  private assertWritable(): void {
    if (this.disposed) throw new Error('The source observation was detached')
    if (this.projection.readOnly) throw new Error(this.fault ?? (this.projection.controlledByUser
      ? 'The source is controlled by its local terminal; switch it to remote control first' : 'The HAPI source runner is unavailable'))
  }
  reportError(error: unknown): void { this.fault = error instanceof Error ? error.message : 'The HAPI source could not be synchronized'; this.publish() }
  private rejectWaiters(message: string): void { for (const waiter of this.idleWaiters) waiter.reject(new Error(message)); this.idleWaiters.clear() }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.rejectWaiters('The source observation was detached'); this.projector?.abandonStream()
    await this.children?.dispose()
    await this.dshChildren?.dispose()
    this.detachAgent?.(); this.detachSession?.(); await this.journal?.settled(); await this.scope.dispose()
  }
}
