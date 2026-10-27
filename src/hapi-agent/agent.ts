import { withSourceAgentServices } from '../shared/source-agent-services.ts'
import { sessionHeaderCwd } from '../hapi/session-header-cwd.ts'
import { checkedQueueMessage } from '../hapi/queue-receipt.ts'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type AgentCancelCause, type AgentEventDispatch, type AgentOptions, type AgentStatus, type Inbox, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord, Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import { SourceStatePublisher } from '../shared/source-state-publisher.ts'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { NativeApprovals } from '../codex/approvals.js'
import { DeliveryJournal } from '../codex/delivery.js'
import { readNativeHistory, readNativeHistoryForward, readNativeHistorySnapshot, readNativeHistoryTail } from '../codex/history.js'
import { NativeHistoryCache } from '../codex/history-cache.js'
import { HistoryReadInvalidatedError, SourceHistoryJournal, SourceHistoryOrder, sourceHistoryKey, type HistoryCheckpoint } from '../codex/history-journal.js'
import { SourceHistorySync } from '../codex/history-sync.js'
import { NativeHistoryChangedError } from '../codex/projector.js'
import { NativeHistoryEpochChangedError } from '../codex/history.js'
import { HapiRequestError, type HapiApprovalAnswer, type HapiAttachment, type HapiEvent, type HapiMessage, type HapiSession, type HapiTransport } from '../codex/contracts.js'
import { DISPLAY_TURN_BASE, isSourceTurnStart, sourcePosition, sourceTurnKey, type HistoryWindowAnchor, type RenderedHistoryPage } from '../codex/source-window.js'
import { compareNativeMessages } from '../codex/native.js'
import type { DeliveryView } from '../codex/projection-types.js'
import { readHistoryRevision, resumedSessionNotice, resumeAwareTransport } from '../codex/agent.js'
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
import { queuedAttachments, queuedEditCandidate as readQueuedEditCandidate } from '../codex/queued-edit-candidate.js'

/** Bounded opening contract: three recent source pages plus one epoch check.
 * Older history is a source-window page, never part of the first seed. */
const OPENING_TAIL_PAGES = 3

export interface HapiObservedTransport extends HapiTransport {
  readonly isConnected?: boolean
  request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>
}
export interface HapiObservedOptions extends ObservedContentOptions {
  stateDirectory: string
  displayRevision?: number
  resolveAttachments?: (sourceId: string, message: UserMessage) => Promise<HapiAttachment[]>
  onHistoryChanged?: (agent: HapiObservedAgent, rows: HapiMessage[], checkpoint: HistoryCheckpoint, epoch?: number) => Promise<void>
  historyEpoch?: number
  /**
   * HAPI resume for an inactive original session. Only an explicit
   * `session_inactive` (HTTP 409) delivery rejection may use it, once.
   */
  resumeSession?: (hapiSessionId: string) => Promise<string>
  /** Service-owned receive journal, captured before asynchronous event work. */
  historyJournal?: SourceHistoryJournal
  historyCheckpoint?: HistoryCheckpoint
  /** Service lifecycle guard; removed sources cannot register after async preparation. */
  assertSourceCurrent?: () => void
  /** Opt-in until client draft/attachment/scroll transfer across reseeds is verified. */
  fastHistorySeed?: boolean
  /** The service already merged these rows with its live journal. */
  initialRowsMerged?: boolean
  /** Opening a display must not wait for child/subagent registration. */
  deferChildren?: boolean
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
  /** Settles after child/subagent sessions have registered in the background. */
  childrenReady: Promise<void> = Promise.resolve()
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
  private historyReadFault = false
  private readonly projectionPublisher = new SourceStatePublisher<NonNullable<HapiObservedProjection>>({
    initial: value => { appendPluginRecord(this.session, 'plugin:hapi-dsh-observed/state', value) },
    status: value => { appendPluginRecord(this.session, 'plugin:hapi-dsh-observed/status', value) },
    notices: value => { appendPluginRecord(this.session, 'plugin:hapi-dsh-observed/notices', value) },
  })
  private lastSelection = ''
  private lastTitle: { title: string; seq: SessionSeq } | undefined
  private pendingRefresh: Promise<void> | undefined
  private lastActivity = false
  private readonly historyJournal: SourceHistoryJournal
  private readonly historyOrder = new SourceHistoryOrder()
  private readonly historySync: SourceHistorySync
  private historyEpoch: number | undefined
  private historyAnchor: HistoryWindowAnchor | undefined
  private structuralResetPending = false
  private historyFallback = false
  private historyPageId = 0
  private historyStale = false
  private rowWork: Promise<void> = Promise.resolve()
  private constructor(parent: Context, readonly transport: HapiObservedTransport, source: HapiSession, private readonly config: HapiObservedOptions) {
    this.source = source; this.bound = observedBinding(transport.hubId, source)
    this.historyJournal = config.historyJournal ?? new SourceHistoryJournal()
    this.historySync = new SourceHistorySync(history => this.refresh(history), error => this.reportError(error))
    this.logicalSessionId = observedSessionId(transport.hubId, source.id)
    this.displayRevision = config.displayRevision ?? 0
    this.id = this.displayRevision ? SessionId(`${this.logicalSessionId}-r${this.displayRevision}`) : this.logicalSessionId
    this.scope = createScope(parent, this); this.ctx = withSourceAgentServices(this.scope.ctx, parent)
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
        const checkpoint = this.historyJournal.checkpoint()
        const rows = await readNativeHistory(this.transport, this.bound.hapiSessionId)
        if (!this.config.onHistoryChanged) throw new NativeHistoryChangedError('The original DSH child history changed; reacquire the source display')
        await this.config.onHistoryChanged(this, this.historyJournal.merge(rows, checkpoint), checkpoint)
      },
      state: () => ({ hubId: this.bound.hubId, hapiSessionId: this.bound.hapiSessionId, flavor: this.bound.flavor,
        machineId: this.bound.machineId, machineName: this.source.metadata?.host ?? this.bound.machineId,
        path: this.source.metadata?.path ?? '/', active: this.source.active, connection: this.connected ? 'connected' : 'disconnected',
        model: this.source.model ?? null, effort: this.source.effort ?? this.source.modelReasoningEffort ?? null,
        permissionMode: this.source.permissionMode ?? null, error: this.fault }),
    }, transport, directory)
    const deliveryTransport = config.resumeSession
      ? resumeAwareTransport(transport, {
          sessionId: () => this.bound.hapiSessionId,
          state: () => ({ active: this.source.active }),
          resume: config.resumeSession,
          verify: async resumedSessionId => {
            const resumed = await transport.getSession(resumedSessionId)
            if (!sameObservedIdentity(this.bound, observedBinding(transport.hubId, resumed))) {
              throw new HapiRequestError('The resumed session has a different original engine identity; the message was not delivered', 'rejected', 409, 'source_identity_mismatch')
            }
          },
          onRebind: (localId, from, to, phase) => {
            this.journal.update(localId, phase === 'before' ? 'dispatching' : 'accepted', resumedSessionNotice(from, to))
          },
        })
      : transport
    this.journal = new DeliveryJournal(directory, this.logicalSessionId, source.id, deliveryTransport, () => {
      if (!this.initializing && !this.disposed) { this.syncInbox(); this.publish() }
    }, config.resolveAttachments)
    this.approvals = new NativeApprovals(directory, this.logicalSessionId, source.id, transport, () => {
      if (!this.initializing && !this.disposed) this.publish()
    })
    this.projector = new ObservedProjector(this.session, { model: () => this.options.model ?? this.bound.flavor,
      turnBase: DISPLAY_TURN_BASE,
      submittedMessage: id => this.journal.get(id)?.message, content: item => this.content.get(item),
      stream: frame => this.dispatch.emit('agent/assistant-stream', { frame }) })
  }
  private meta() { return { cwd: sessionHeaderCwd(this.source.metadata?.path), createdAt: this.source.createdAt } }
  static async create(ctx: Context, transport: HapiObservedTransport, source: HapiSession, config: HapiObservedOptions, initialRows?: readonly HapiMessage[]): Promise<HapiObservedAgent> {
    const agent = new HapiObservedAgent(ctx, transport, source, config)
    try {
      let rows = initialRows
      let checkpoint = config.historyCheckpoint ?? agent.historyJournal.checkpoint()
      if (!rows) {
        const cached = config.fastHistorySeed ? agent.cache.snapshot(true) : undefined
        // A persisted preview can precede ordinary appends. Read the current
        // bounded tail first; reserve the cache for source read failures.
        try {
          checkpoint = agent.historyJournal.checkpoint()
          const tail = config.fastHistorySeed ? await readNativeHistoryTail(transport, source.id, OPENING_TAIL_PAGES)
            : { ...await readNativeHistorySnapshot(transport, source.id), complete: true }
          agent.historyEpoch = tail.epoch
          rows = agent.historyJournal.merge(tail.rows, checkpoint)
          if (config.fastHistorySeed) {
            const aligned = alignObservedHistoryRows(rows, !tail.complete, ('epoch' in tail ? tail.epoch : undefined) ?? 0, 'before' in tail ? tail.before : undefined)
            rows = aligned.rows
            agent.historyAnchor = aligned.anchor ?? completeObservedHistoryAnchor([], agent.historyEpoch ?? 0)
            agent.historyStale = false
          } else {
            agent.historyAnchor = completeObservedHistoryAnchor(rows, agent.historyEpoch ?? 0)
            agent.historyStale = !tail.complete
          }
        } catch (error) {
          config.assertSourceCurrent?.()
          if (error instanceof HistoryReadInvalidatedError) throw error
          checkpoint = agent.historyJournal.checkpoint()
          const fallback = (cached ?? agent.cache.snapshot())?.rows ?? []
          rows = agent.historyJournal.overlayCache(fallback)
          agent.historyEpoch = cached?.epoch
          agent.historyAnchor = rows.length
            ? { epoch: cached?.epoch ?? 0, before: sourcePosition(rows[0]!), firstTurn: DISPLAY_TURN_BASE + 1, hasOlder: true,
              oldest: { id: rows[0]!.id, ...sourcePosition(rows[0]!) } }
            : completeObservedHistoryAnchor([], 0)
          agent.historyFallback = rows.length > 0
          agent.historyStale = true
          agent.historyReadFault = true
          agent.fault = `${error instanceof Error ? error.message : 'Source history is unavailable'}; cached history is stale and is being reconciled`
        }
      } else if (config.initialRowsMerged !== true) {
        rows = agent.historyJournal.merge(rows, checkpoint)
      }
      if (!rows) rows = []
      if (initialRows) {
        if (config.historyEpoch !== undefined) agent.historyEpoch = config.historyEpoch
        agent.historyAnchor = completeObservedHistoryAnchor(rows, agent.historyEpoch ?? 0)
        agent.historyStale = false
      }
      agent.projector.beginHistorySeed(); await agent.applyRows(rows, true, checkpoint)
      agent.currentSession = agent.ctx.sessions.prepare(agent.id, { seed: agent.projector.historySeed(), meta: agent.meta() })
      agent.projector.finishHistorySeed(agent.session)
      agent.initializing = false; agent.observe(source)
      if (!agent.fault) await agent.journal.reconcileSource()
      agent.syncInbox(); agent.publish()
      config.assertSourceCurrent?.()
      agent.historyJournal.assertCurrent(checkpoint)
      // A fast opening seed is a bounded window, never a complete archive.
      if (config.fastHistorySeed && !initialRows) agent.cache.writeOpening(rows, false)
      else agent.cache.write(rows, !agent.historyStale)
      agent.detachSession = agent.ctx.sessions.enter(agent.session)
      agent.detachAgent = agent.ctx.agents.enter(agent, undefined)
      bindObservedCommands(agent)
      agent.ctx.sessions.announce(agent.session)
      // Profile plugins may attach local prompt/team tooling in a startup
      // listener. A source-owned Agent only mirrors remote execution, so a
      // listener that cannot run here must not fail opening the session.
      try { await agent.ctx.agents.announce(agent, 'startup') }
      catch (error) {
        console.warn('[hapi-dsh] agent startup listener failed; continuing with the source-owned agent:', error instanceof Error ? error.message : String(error))
      }
      const mountChildren = async (): Promise<void> => {
        await agent.children.mount()
        await agent.dshChildren.mount()
      }
      if (config.deferChildren === true) {
        agent.childrenReady = mountChildren().catch(error => {
          console.warn('[hapi-dsh] background child registration failed; the parent display stays usable', error instanceof Error ? error.message : String(error))
        })
      } else await mountChildren()
      return agent
    } catch (error) { await agent.dispose(); throw error }
  }

  /** Start only after the service has published this Agent in its registry. */
  startHistorySync(): void { if (this.historyStale) this.historySync.request(true) }
  requestHistorySync(): void { this.historyStale = true; this.historySync.request(true) }
  async settled(): Promise<void> { await this.historySync.settled(); await this.rowWork }

  historyWindowAnchor(): HistoryWindowAnchor | undefined { return this.historyAnchor }

  /** Render one older source page in a detached Session; no live log changes. */
  async renderHistoryPage(rows: readonly HapiMessage[]): Promise<RenderedHistoryPage> {
    const detached = Session.create(SessionId(`hapi-observed-history-${this.logicalSessionId}-${++this.historyPageId}`))
    const items = parseObservedHistory(rows, new ObservedScopeIndex()).filter(item => item.scopeId === null)
    await this.content.prepare(items)
    const history = new ObservedProjector(detached, {
      scopeId: null, model: () => this.options.model ?? this.bound.flavor,
      turnBase: 0, submittedMessage: () => undefined, content: item => this.content.get(item), stream: () => {},
    })
    if (!rows.length || !isSourceTurnStart(rows[0]!)) history.setSuppressFirstTurnStart()
    history.beginHistorySeed()
    history.apply(items)
    return {
      events: history.historySeed(), lastTurn: history.lastTurn,
      sources: history.sourceSeqEntries(), rewinds: history.rewindSeqEntries(), forks: new Map(),
      turnAnchors: history.turnAnchorEntries(), stepAnchors: history.stepAnchorEntries(),
    }
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
      // `readOnly` keeps its operation-permission meaning (approvals, settings,
      // source edits). Message input is admitted separately: an inactive
      // original session is resumed before delivery, while only the original
      // engine owning local input blocks sending.
      readOnly: !this.connected || !this.source.active || this.fault !== null || capabilities.switchToRemote,
      readOnlyReason: capabilities.switchToRemote ? 'engine-owned'
        : !this.connected || !this.source.active ? 'unavailable' : this.fault !== null ? 'fault' : null,
      model: this.source.model ?? null, effort: this.source.effort ?? this.source.modelReasoningEffort ?? null,
      permissionMode: this.source.permissionMode ?? null, capabilities,
      serviceTier: this.source.serviceTier ?? null, collaborationMode: this.source.collaborationMode ?? null,
      pendingRequests: this.approvals.pending(), resolvedRequests: this.approvals.resolved(), delivery: this.deliveries(),
      notices: [...this.notices.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200), usage: this.usage,
      sidechains: [...this.children.summaries, ...this.dshChildren.summaries], error: this.fault, ...sourceTeamProjection(this.source) }
  }
  resolveRewindLocalId(id: string) { return this.projector.rewindLocalId(id) }
  resolveRewindLocalIdAtSeq(seq: number) { return this.projector.rewindLocalIdAtSeq(seq) }
  resolveSourceMessageDisplaySeq(id: string) { return this.projector.sourceMessageDisplaySeq(id) }
  sourceMessageAtDisplaySeq(seq: number): string | undefined { return this.projector.sourceMessageAtDisplaySeq(seq) }
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
  recoverDelivery(localId: string, action: 'retry' | 'discard', operationId: string): DeliveryView {
    if (action === 'retry') {
      this.assertWritable()
      const entry = this.journal.get(localId), capabilities = this.projection.capabilities
      if (entry?.mode === 'steer' && !capabilities.steer) throw new Error('The source no longer accepts live steering')
      if (entry?.message.content.some(block => block.type === 'image') && !capabilities.images) throw new Error('The source runtime does not advertise image input')
    }
    const { message: _message, recoveries: _recoveries, ...view } = this.journal.recoverRejected(localId, action, operationId)
    return view
  }
  async checkDelivery(localId: string): Promise<DeliveryView | null> {
    const state = await this.transport.getQueuedState(this.bound.hapiSessionId, [localId])
    this.journal.reconcile(state)
    const pending = this.queued.get(localId)
    if (pending) {
      const row = checkedQueueMessage(pending.row, state)
      if (row) this.queued.set(localId, { ...pending, row })
      else this.queued.delete(localId)
    }
    this.syncInbox(); this.publish()
    return this.deliveries().find(entry => entry.localId === localId) ?? null
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
  async steerInbox(itemId: string) {
    const delivery = this.deliveries().find(row =>
      (this.journal.get(row.localId)?.message?.id ?? `hapi-observed:${row.localId}`) === itemId)
    if (!delivery || delivery.state !== 'queued') throw new Error('Source queue item is no longer confirmed queued; refresh its receipt before steering')
    return this.steerQueued(delivery.localId)
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
  async handleEvent(event: HapiEvent, checkpoint = this.historyJournal.checkpoint()): Promise<void> {
    if (this.disposed || event.type === 'toast') return
    if (event.type === 'connection-changed') {
      this.connected = event.data?.status === 'connected'
      if (this.connected) { this.historyStale = true; this.historySync.request(true) }
      else { this.rejectWaiters('Source activity is unavailable until its owner reconnects'); this.publish() }
      return
    }
    if (event.sessionId !== this.bound.hapiSessionId) return
    if (event.type === 'message-received') await this.applyRows([event.message], false, checkpoint)
    else if (event.type === 'messages-consumed') {
      for (const id of event.localIds) { this.journal.update(id, 'invoked'); this.queued.delete(id) }
      this.historySync.request(true)
    } else if (['messages-dispatching', 'messages-indeterminate', 'messages-requeued'].includes(event.type) && 'localIds' in event) {
      for (const id of event.localIds) this.journal.update(id, event.type === 'messages-dispatching' ? 'dispatching' : event.type === 'messages-indeterminate' ? 'indeterminate' : 'queued')
      this.historySync.request(true)
    } else if (event.type === 'message-cancelled') {
      if (event.localId) { this.journal.update(event.localId, 'cancelled'); this.queued.delete(event.localId) }
      this.syncInbox(); this.publish()
    } else if (['messages-invalidated', 'message-updated', 'scheduled-matured'].includes(event.type)) {
      if (event.type === 'messages-invalidated' && event.reason !== 'native-history') this.structuralResetPending = true
      this.historyStale = true; this.historySync.request(true)
    }
    else if (event.type === 'session-removed') { this.connected = false; this.publish() }
    else this.historySync.request(false)
  }
  /** Refresh only source settings; history and child discovery keep their own lifecycle. */
  async refreshSettings(source?: HapiSession): Promise<void> {
    if (this.disposed) throw new Error('The HAPI source observation was detached')
    this.config.assertSourceCurrent?.()
    const snapshot = source ?? await this.transport.getSession(this.bound.hapiSessionId)
    if (this.disposed) throw new Error('The HAPI source observation was detached')
    this.config.assertSourceCurrent?.()
    this.observe(snapshot)
    if (this.historyReadFault) { this.fault = null; this.historyReadFault = false }
    this.publish()
  }

  async refresh(history = false): Promise<void> {
    if (this.pendingRefresh) { await this.pendingRefresh; if (history && !this.disposed) return this.refresh(true); return }
    const work = (async () => {
      if (this.disposed) return
      const snapshot = await this.transport.getSession(this.bound.hapiSessionId)
      if (this.disposed) return
      this.observe(snapshot)
      let rows: HapiMessage[] | undefined
      let checkpoint: HistoryCheckpoint | undefined
      try {
        if (history || this.historyStale) {
          if (this.config.fastHistorySeed) await this.refreshBounded()
          else {
            checkpoint = this.historyJournal.checkpoint()
            rows = await readNativeHistory(this.transport, this.bound.hapiSessionId)
            if (this.disposed) return
            rows = this.historyJournal.merge(rows, checkpoint)
            await this.applyRows(rows, true, checkpoint, true)
          }
        }
        await this.dshChildren.refresh(history)
      } catch (error) {
        if (error instanceof NativeHistoryChangedError && this.config.onHistoryChanged) {
          checkpoint ??= this.historyJournal.checkpoint()
          // `rows` below is already merged on this path; only a read that was
          // never merged (the error happened before assignment) needs the
          // journal overlay here.
          const replacement = rows ?? this.historyJournal.merge(await readNativeHistory(this.transport, this.bound.hapiSessionId), checkpoint)
          await this.config.onHistoryChanged(this, replacement, checkpoint); return
        }
        throw error
      }
      await this.journal.reconcileSource()
      if (this.disposed) return
      this.fault = null; this.historyReadFault = false; this.syncInbox(); this.publish()
    })()
    this.pendingRefresh = work
    try { await work } finally { if (this.pendingRefresh === work) this.pendingRefresh = undefined }
  }
  /** Bounded normal catch-up; only a proved structural change replaces the display. */
  private async refreshBounded(): Promise<void> {
    if (this.disposed) return
    if (this.structuralResetPending) { this.structuralResetPending = false; await this.replaceForStructuralChange(); return }
    if (this.historyFallback) {
      // Live activity is never held behind a source page. A delayed older page
      // is applied after the live row; source annotations preserve source order
      // for the history window. Snapshot revisions require boundary validation.
      this.historyFallback = false
      try {
        const latestRow = this.historyOrder.latestRow()
        const latest = this.historyOrder.latestPosition()
        const checkpoint = this.historyJournal.checkpoint()
        const page = await this.transport.readMessages(this.bound.hapiSessionId, { limit: 32, bounded: true })
        if (this.disposed) return
        if (page.page.reset) { await this.refreshRevision(latestRow, checkpoint); return }
        if (this.historyEpoch === undefined || page.page.epoch !== this.historyEpoch) {
          await this.refreshRevision(latestRow, checkpoint); return
        }
        const overlaps = !latestRow || page.messages.some(row => sourceHistoryKey(row) === sourceHistoryKey(latestRow))
        if (overlaps) {
          await this.applyRows(page.messages, false, checkpoint)
          this.historyEpoch = page.page.epoch; this.historyStale = false
          if (this.historyAnchor) this.historyAnchor = { ...this.historyAnchor, epoch: page.page.epoch }
          this.fault = null; this.historyReadFault = false
          this.syncInbox(); this.publish()
          return
        }
        this.historyJournal.assertCurrent(checkpoint)
        let forward: Awaited<ReturnType<typeof readNativeHistoryForward>>
        try {
          forward = await readNativeHistoryForward(this.transport, this.bound.hapiSessionId, this.historyEpoch, latest!, 12)
        } catch (error) {
          if (error instanceof NativeHistoryEpochChangedError) { await this.refreshRevision(latestRow, checkpoint); return }
          throw error
        }
        if (this.disposed) return
        await this.applyRows(forward.rows, false, this.historyJournal.checkpoint())
        this.historyStale = forward.hasMore
        this.fault = null; this.historyReadFault = false
        this.syncInbox(); this.publish()
        if (forward.hasMore) this.historySync.request(true)
        return
      } catch (error) {
        if (this.disposed) return
        this.historyFallback = true; throw error
      }
    }
    if (this.historyEpoch === undefined) {
      const checkpoint = this.historyJournal.checkpoint()
      const tail = await readNativeHistoryTail(this.transport, this.bound.hapiSessionId, OPENING_TAIL_PAGES)
      if (this.disposed) return
      const merged = this.historyJournal.merge(tail.rows, checkpoint)
      const aligned = alignObservedHistoryRows(merged, !tail.complete, ('epoch' in tail ? tail.epoch : undefined) ?? 0, 'before' in tail ? tail.before : undefined)
      await this.applyRows(aligned.rows, false, checkpoint)
      this.historyEpoch = tail.epoch
      this.historyAnchor = aligned.anchor ?? completeObservedHistoryAnchor(aligned.rows, this.historyEpoch ?? 0)
      this.historyStale = false
      this.fault = null; this.historyReadFault = false
      this.cache.writeOpening(aligned.rows, false, this.historyEpoch)
      this.syncInbox(); this.publish()
      return
    }
    const latest = this.historyOrder.latestPosition()
    if (!latest) {
      const tail = await readNativeHistoryTail(this.transport, this.bound.hapiSessionId, OPENING_TAIL_PAGES)
      if (this.disposed) return
      const checkpoint = this.historyJournal.checkpoint()
      const merged = this.historyJournal.merge(tail.rows, checkpoint)
      await this.applyRows(merged, false, checkpoint)
      this.historyEpoch = tail.epoch
      this.historyAnchor = alignObservedHistoryRows(merged, !tail.complete, tail.epoch ?? 0, tail.before).anchor ?? completeObservedHistoryAnchor(merged, tail.epoch ?? 0)
      this.historyStale = false
      this.fault = null; this.historyReadFault = false
      this.syncInbox(); this.publish()
      return
    }
    const checkpoint = this.historyJournal.checkpoint()
    const latestRow = this.historyOrder.latestRow()
    let forward: Awaited<ReturnType<typeof readNativeHistoryForward>>
    try {
      forward = await readNativeHistoryForward(this.transport, this.bound.hapiSessionId, this.historyEpoch, latest, 12)
    } catch (error) {
      if (error instanceof NativeHistoryEpochChangedError) { await this.refreshRevision(latestRow, checkpoint); return }
      throw error
    }
    if (this.disposed) return
    await this.applyRows(forward.rows, false, this.historyJournal.checkpoint())
    this.historyStale = forward.hasMore
    this.fault = null; this.historyReadFault = false
    this.syncInbox(); this.publish()
    if (forward.hasMore) this.historySync.request(true)
  }

  private async refreshRevision(latest: HapiMessage | undefined, checkpoint: HistoryCheckpoint): Promise<void> {
    const revision = await readHistoryRevision(this.transport, this.bound.hapiSessionId,
      latest, this.historyAnchor)
    if (this.disposed) return
    this.historyJournal.assertCurrent(checkpoint)
    if (!revision) {
      this.historyJournal.capture({ type: 'messages-invalidated', sessionId: this.bound.hapiSessionId, reason: 'rewind' })
      await this.replaceForStructuralChange(); return
    }
    await this.applyRows(revision.rows, false, checkpoint)
    this.historyEpoch = revision.epoch
    if (this.historyAnchor) this.historyAnchor = { ...this.historyAnchor, epoch: revision.epoch }
    this.historyStale = revision.hasMore
    this.fault = null; this.historyReadFault = false
    this.syncInbox(); this.publish()
    if (revision.hasMore) this.historySync.request(true)
  }

  private async replaceForStructuralChange(): Promise<void> {
    const checkpoint = this.historyJournal.checkpoint()
    const snapshot = await readNativeHistorySnapshot(this.transport, this.bound.hapiSessionId)
    if (this.disposed) return
    if (!this.config.onHistoryChanged) throw new NativeHistoryChangedError('The original source history changed structurally')
    this.historyAnchor = undefined
    await this.config.onHistoryChanged(this, this.historyJournal.merge(snapshot.rows, checkpoint), checkpoint, snapshot.epoch)
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
  private applyRows(rows: readonly HapiMessage[], authoritative = false, checkpoint = this.historyJournal.checkpoint(), prepared = false): Promise<void> {
    const work = this.rowWork.then(async () => {
      if (this.disposed) return
      this.historyJournal.assertCurrent(checkpoint)
      const merged = prepared ? rows : authoritative ? this.historyJournal.merge(rows, checkpoint, !this.historyStale) : rows
      if (!this.initializing && authoritative && !this.config.fastHistorySeed && this.historyOrder.needsReseed(merged)) {
        throw new NativeHistoryChangedError('Earlier source history is ready; acquiring its complete display generation')
      }
      await this.applyRowsNow(merged, authoritative, checkpoint)
      if (this.disposed) return
      this.historyJournal.assertCurrent(checkpoint)
      this.historyOrder.accept(merged, authoritative)
      if (authoritative && !this.initializing) { this.cache.write(merged); this.historyStale = false }
    })
    this.rowWork = work.catch(() => {})
    return work
  }

  private async applyRowsNow(rows: readonly HapiMessage[], authoritative: boolean, checkpoint: HistoryCheckpoint): Promise<void> {
    this.sourceScopes.update(rows, authoritative)
    const items = authoritative ? parseObservedHistory(rows, this.sourceScopes) : rows.flatMap(row => parseObservedMessage(row, this.sourceScopes))
    await this.content.prepare(items)
    if (this.disposed) return
    this.config.assertSourceCurrent?.()
    this.historyJournal.assertCurrent(checkpoint)
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
    return [...values.values()].map(entry => {
      const candidate = this.queuedEditCandidate(entry.localId)
      return { ...entry, attachments: queuedAttachments(this.queued.get(entry.localId)?.row), attachmentNames: candidate?.attachmentNames ?? [], editable: candidate !== undefined, cancelable: entry.state === 'queued' }
    })
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
    this.projectionPublisher.publish(this.projection)
  }
  private assertWritable(): void {
    // Inactive/history/disconnected/fault sessions still accept a durable
    // journal submission; only the original engine owning local input is a
    // real read-only owner, and a detached observation cannot own new input.
    if (this.disposed) throw new Error('The source observation was detached')
    this.config.assertSourceCurrent?.()
    if (this.projection.controlledByUser) throw new Error('The source is controlled by its local terminal; switch it to remote control first')
  }
  reportError(error: unknown): void {
    const historyRead = error instanceof HistoryReadInvalidatedError
    if (historyRead && this.fault !== null && !this.historyReadFault) return
    this.historyReadFault = historyRead
    this.fault = error instanceof Error ? error.message : 'The HAPI source could not be synchronized'
    this.publish()
  }
  private rejectWaiters(message: string): void { for (const waiter of this.idleWaiters) waiter.reject(new Error(message)); this.idleWaiters.clear() }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.rejectWaiters('The source observation was detached'); this.projector?.abandonStream()
    this.historySync.dispose()
    await this.children?.dispose()
    await this.dshChildren?.dispose()
    this.detachAgent?.(); this.detachSession?.(); await this.journal?.settled(); await this.scope.dispose()
  }
}


function completeObservedHistoryAnchor(rows: readonly HapiMessage[], epoch: number): HistoryWindowAnchor {
  const sorted = rows.length ? [...rows].sort(compareNativeMessages) : []
  // Unpositioned queued prompts are appended to HAPI pages with old creation
  // times. They are not transcript positions and must not define the anchor.
  const first = sorted.find(row => typeof row.seq === 'number') ?? sorted[0]
  const position = first ? sourcePosition(first) : { at: 0, seq: 0 }
  return { epoch, before: position, firstTurn: DISPLAY_TURN_BASE + 1, hasOlder: false,
    ...(first ? { oldest: { id: first.id, at: position.at, seq: position.seq },
      partial: !isSourceTurnStart(first) } : {}) }
}

function alignObservedHistoryRows(rows: readonly HapiMessage[], sourceHasOlder: boolean, epoch: number,
  authoritativeBefore?: { at: number; seq: number }): {
  rows: HapiMessage[]; anchor: HistoryWindowAnchor | undefined
} {
  const sorted = [...rows].sort(compareNativeMessages)
  if (!sorted.length) return { rows: [], anchor: sourceHasOlder ? undefined : completeObservedHistoryAnchor([], epoch) }
  const starts = sorted.flatMap((row, index) => isSourceTurnStart(row) ? [index] : [])
  const firstPositioned = sorted.findIndex(row => typeof row.seq === 'number')
  const oldest = firstPositioned >= 0 ? sorted[firstPositioned]! : sorted[0]!
  if (authoritativeBefore) {
    const partial = starts[0] !== firstPositioned
    const oldestPosition = sourcePosition(oldest)
    return { rows: sorted, anchor: { epoch, before: authoritativeBefore, firstTurn: DISPLAY_TURN_BASE + 1,
      hasOlder: sourceHasOlder || partial, partial,
      oldest: { id: oldest.id, at: oldestPosition.at, seq: oldestPosition.seq } } }
  }
  const cut = starts.length ? starts[0]! : 0
  const aligned = sorted.slice(cut)
  if (!aligned.length) return { rows: [], anchor: undefined }
  return {
    rows: aligned,
    anchor: { epoch, before: sourcePosition(aligned[0]!),
      firstTurn: DISPLAY_TURN_BASE + 1, hasOlder: sourceHasOlder || cut > 0, partial: false,
      oldest: { id: aligned[0]!.id, at: sourcePosition(aligned[0]!).at, seq: sourcePosition(aligned[0]!).seq } },
  }
}
