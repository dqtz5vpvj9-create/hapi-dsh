import type { Context } from '@deepseek-ai/cordis'
import {
  agentEvents, type Agent, type AgentCancelCause, type AgentEventDispatch, type AgentOptions, type AgentStatus,
  type Inbox, type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord, SessionId, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  HapiApprovalAnswer, HapiAttachment, HapiCancelResult, HapiEvent, HapiMessage, HapiNativeRuntime,
  HapiRetryResult, HapiSession, HapiSteerResult, HapiTransport,
} from './contracts.js'
import { NativeApprovals } from './approvals.js'
import { DeliveryJournal } from './delivery.js'
import { readNativeHistory } from './history.js'
import { NativeHistoryCache } from './history-cache.js'
import { NativeContent, type NativeArtifactImporter } from './content.js'
import { assertBinding, bindingFor, nativeSessionId, parseNativeRow, type NativeBinding, type NativeRow } from './native.js'
import { NativeHistoryChangedError, NativeProjector } from './projector.js'
import type { DeliveryView, HapiProjection } from './projection-types.js'

export interface NativeCodexOptions {
  stateDirectory: string
  displayRevision?: number
  resolveAttachments?: (hapiSessionId: string, message: UserMessage) => Promise<HapiAttachment[]>
  importArtifact?: NativeArtifactImporter
  /** Allows the service to replace a display generation after authoritative native rewind. */
  onHistoryChanged?: (agent: NativeCodexAgent, rows: HapiMessage[]) => Promise<void>
}

/** Native pending input is mirrored for official DSH queue display only. */
class NativeInbox implements Inbox {
  private turn: readonly UserMessage[] = []
  private step: readonly UserMessage[] = []
  constructor(private readonly owner: NativeCodexAgent) {}
  get nextTurn(): readonly UserMessage[] { return this.turn }
  get nextStep(): readonly UserMessage[] { return this.step }
  append(target: InboxTarget, message: UserMessage): void { this.owner.send(message, target, true) }
  prepend(_target: InboxTarget, _message: UserMessage): void { this.unsupported() }
  clear(): void { this.unsupported() }
  replace(_messageId: MessageId, _message: UserMessage): boolean { return this.unsupported() }
  remove(_messageId: MessageId): boolean { return this.unsupported() }
  splice(_target: InboxTarget, _start: number, _deleteCount: number, _inserted: UserMessage[]): UserMessage[] { return this.unsupported() }
  private unsupported(): never {
    throw new Error('Native Codex queue changes require the asynchronous HAPI native queue controls')
  }
  sync(turn: readonly UserMessage[], step: readonly UserMessage[]): void {
    for (const [target, values] of [['next-turn', turn], ['next-step', step]] as const) {
      const previous = target === 'next-turn' ? this.turn : this.step
      if (JSON.stringify(previous) === JSON.stringify(values)) continue
      this.owner.session.append('agent/inbox/spliced', { target, start: 0, removedCount: previous.length, inserted: [...values] })
      if (target === 'next-turn') this.turn = values
      else this.step = values
      const previousIds = new Set(previous.map(message => message.id))
      for (const message of values) if (!previousIds.has(message.id)) this.owner.dispatch.emit('agent/inbox/inserted', { message })
    }
  }
}

/**
 * A public DSH Agent that observes an existing native Codex thread. This class
 * never creates an AgentLoop or owns the native app-server process.
 */
export class NativeCodexAgent implements Agent {
  readonly id: SessionId
  readonly logicalSessionId: SessionId
  readonly displayRevision: number
  readonly ctx: Context
  private currentSession: Session
  readonly inbox: NativeInbox
  readonly dispatch: AgentEventDispatch
  readonly binding: NativeBinding
  readonly journal: DeliveryJournal
  private readonly approvals: NativeApprovals
  private readonly scope: Scope
  private readonly projector: NativeProjector
  private readonly cache: NativeHistoryCache
  private readonly content: NativeContent
  private source: HapiSession
  private readonly queued = new Map<string, { row: NativeRow & { kind: 'user' }; raw: HapiMessage }>()
  private readonly idleWaiters = new Set<{ resolve(): void; reject(error: Error): void }>()
  private detachAgent: (() => void) | undefined
  private detachSession: (() => void) | undefined
  private disposed = false
  private initializing = true
  private connected = true
  private fault: string | null = null
  private projectionFingerprint = ''
  private sourceRunning = false
  private lastTitle: string | undefined
  private lastTitleEvent: { title: string; seq: SessionSeq } | undefined
  private lastModelSelection = ''
  private pendingRefresh: Promise<void> | undefined

  private constructor(
    parent: Context,
    readonly transport: HapiTransport,
    source: HapiSession,
    private readonly config: NativeCodexOptions,
  ) {
    this.source = source
    this.binding = bindingFor(transport.hubId, source)
    this.logicalSessionId = nativeSessionId(transport.hubId, source.id)
    this.displayRevision = config.displayRevision ?? 0
    this.id = this.displayRevision === 0 ? this.logicalSessionId : SessionId(`${this.logicalSessionId}-r${this.displayRevision}`)
    this.scope = createScope(parent, this)
    this.ctx = this.scope.ctx
    this.currentSession = this.ctx.sessions.prepare(this.id, {
      meta: { cwd: source.metadata?.path ?? '/', agentPreset: 'hapi-codex-native', createdAt: source.createdAt },
    })
    this.dispatch = agentEvents(this.ctx, this)
    this.inbox = new NativeInbox(this)
    this.cache = new NativeHistoryCache(config.stateDirectory, this.logicalSessionId)
    this.content = new NativeContent(config.stateDirectory, this.logicalSessionId, source.id, config.importArtifact)
    this.journal = new DeliveryJournal(config.stateDirectory, this.logicalSessionId, source.id, transport, () => {
      if (!this.disposed && !this.initializing) { this.syncInbox(); this.publishProjection() }
    }, config.resolveAttachments)
    this.approvals = new NativeApprovals(config.stateDirectory, this.logicalSessionId, source.id, transport, () => {
      if (!this.disposed && !this.initializing) this.publishProjection()
    })
    this.projector = new NativeProjector(this.session, {
      model: () => this.options.model ?? 'codex-native', provider: () => this.options.provider ?? 'codex-native',
      submittedMessage: localId => this.journal.get(localId)?.message,
      content: row => this.content.get(row),
      stream: frame => this.dispatch.emit('agent/assistant-stream', { frame }),
    })
  }

  static async create(
    ctx: Context, transport: HapiTransport, source: HapiSession, options: NativeCodexOptions,
    initialRows?: readonly HapiMessage[],
  ): Promise<NativeCodexAgent> {
    const agent = new NativeCodexAgent(ctx, transport, source, options)
    try {
      let rows = initialRows
      if (!rows) {
        try {
          rows = await readNativeHistory(transport, source.id)
          agent.cache.write(rows)
        } catch (error) {
          rows = agent.cache.read() ?? []
          agent.fault = error instanceof Error ? error.message : 'Native history is unavailable'
        }
      }
      agent.projector.beginHistorySeed()
      await agent.applyRows(rows, true)
      agent.currentSession = agent.ctx.sessions.prepare(agent.id, {
        seed: agent.projector.historySeed(),
        meta: { cwd: source.metadata?.path ?? '/', agentPreset: 'hapi-codex-native', createdAt: source.createdAt },
      })
      agent.projector.finishHistorySeed(agent.session)
      agent.initializing = false
      agent.observe(source)
      if (agent.fault === null) await agent.journal.reconcileSource()
      agent.syncInbox()
      agent.publishProjection()
      agent.detachSession = agent.ctx.sessions.enter(agent.session)
      agent.detachAgent = agent.ctx.agents.enter(agent, undefined)
      agent.ctx.sessions.announce(agent.session)
      await agent.ctx.agents.announce(agent, 'startup')
      return agent
    } catch (error) { await agent.dispose(); throw error }
  }

  get options(): AgentOptions {
    return {
      provider: 'hapi-codex-native',
      model: this.source.model ?? this.source.metadata?.codexModel ?? 'codex-native',
      ...(this.source.modelReasoningEffort ? { reasoningEffort: ReasoningEffortId(this.source.modelReasoningEffort) } : {}),
    }
  }
  get session(): Session { return this.currentSession }
  get status(): AgentStatus { return this.sourceRunning ? 'running' : 'idle' }
  get sourceSession(): HapiSession { return this.source }
  get titleEvent(): { title: string; seq: SessionSeq } | undefined { return this.lastTitleEvent }

  resolveForkBoundary(messageId: string) { return this.projector.forkBoundary(messageId) }

  get projection(): NonNullable<HapiProjection> {
    return {
      engine: 'codex', hubId: this.binding.hubId, hapiSessionId: this.binding.hapiSessionId,
      logicalSessionId: this.logicalSessionId, displayRevision: this.displayRevision,
      machineId: this.binding.machineId, machineName: this.source.metadata?.host ?? this.binding.machineId,
      nativeId: this.binding.threadId, nativeHome: this.binding.home,
      nativeConnection: !this.connected || !this.source.active ? 'disconnected'
        : this.source.metadata?.codexNativeConnection ?? 'history',
      readOnly: !this.connected || !this.source.active || this.source.metadata?.codexNativeConnection !== 'attached'
        || this.source.metadata?.migrationInProgress !== undefined || this.fault !== null,
      model: this.source.model ?? this.source.metadata?.codexModel ?? null,
      reasoningEffort: this.source.modelReasoningEffort ?? null,
      planId: typeof this.source.agentState?.codexPlanProposalId === 'string' ? this.source.agentState.codexPlanProposalId : null,
      execution: this.source.execution ?? null,
      pendingRequests: this.approvals.pending(), resolvedRequests: this.approvals.resolved(),
      delivery: this.deliveries(), error: this.fault,
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.assertWritable()
    if (!wakeup) throw new Error('Native Codex does not expose silent model-context injection through HAPI')
    this.journal.submit(message, target === 'next-step' ? 'steer' : 'queue')
  }
  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(_message: UserMessage): void { throw new Error('Native Codex does not expose silent model-context injection through HAPI') }
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void {
    if (cause.kind === 'disposed') return
    this.assertWritable()
    void this.abort(options?.keepInbox === true).catch(error => this.reportError(error))
  }
  async abort(keepInbox = true): Promise<void> {
    this.assertWritable()
    if (!keepInbox) await Promise.all(this.deliveries().map(delivery => this.cancelQueued(delivery.localId)))
    await this.transport.abortSession(this.binding.hapiSessionId)
    // Cancellation acknowledgement is not an observed native terminal event.
    await this.refresh()
  }
  whenIdle(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The native Codex observation was detached'))
    if (!this.connected || this.source.execution?.status === 'disconnected' || this.source.execution?.status === 'systemError') {
      return Promise.reject(new Error('Native Codex activity is unknown until its owner reconnects'))
    }
    if (!this.sourceRunning) return Promise.resolve()
    return new Promise((resolve, reject) => { this.idleWaiters.add({ resolve, reject }) })
  }
  runMaintenance<T>(_task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    throw new Error('The native Codex runtime owns maintenance; use its HAPI native controls')
  }

  async cancelQueued(localId: string): Promise<HapiCancelResult> {
    this.assertWritable()
    const result = await this.transport.cancelQueuedMessage(this.binding.hapiSessionId, localId)
    if (result.status === 'cancelled') {
      this.journal.update(localId, 'cancelled')
      this.queued.delete(localId)
    } else if (result.status === 'invoked') await this.applyRows([result.message])
    this.syncInbox(); this.publishProjection()
    return result
  }
  async steerQueued(localId: string): Promise<HapiSteerResult> {
    this.assertWritable()
    const result = await this.transport.steerQueuedMessage(this.binding.hapiSessionId, localId)
    if (result.status === 'invoked') await this.applyRows([result.message])
    // 'steered' is an acknowledgement; messages-consumed or queued-state owns retirement.
    if (result.status === 'failed') this.journal.update(localId, 'indeterminate', result.error)
    await this.journal.reconcileSource()
    return result
  }
  async retryIndeterminate(localId: string): Promise<HapiRetryResult> {
    this.assertWritable()
    const result = await this.transport.retryIndeterminateMessage(this.binding.hapiSessionId, localId)
    if (result.status === 'invoked') await this.applyRows([result.message])
    else if (result.status === 'retried' || result.status === 'already-queued') this.journal.update(localId, 'queued')
    return result
  }
  async answerApproval(requestId: string, answer: HapiApprovalAnswer, deny = false): Promise<{ stage: 'submitted' | 'resolved' }> {
    this.assertWritable()
    const result = await this.approvals.answer(requestId, answer, deny)
    await this.refresh()
    return result
  }

  async handleEvent(event: HapiEvent): Promise<void> {
    if (this.disposed) return
    if (event.type === 'connection-changed') {
      this.connected = event.data?.status === 'connected'
      if (this.connected) await this.refresh(true)
      else {
        this.rejectIdleWaiters('Native Codex activity is unknown until its owner reconnects')
        this.publishProjection()
      }
      return
    }
    if (event.sessionId !== this.binding.hapiSessionId) return
    switch (event.type) {
      case 'message-received': await this.applyRows([event.message]); break
      case 'messages-consumed':
        for (const id of event.localIds) { this.journal.update(id, 'invoked'); this.queued.delete(id) }
        this.syncInbox(); this.publishProjection();
        // Read actual native user items for original TUI/web transcript convergence.
        await this.refresh(true)
        break
      case 'messages-dispatching': case 'messages-indeterminate': case 'messages-requeued':
        for (const id of event.localIds) this.journal.update(id, event.type === 'messages-dispatching' ? 'dispatching'
          : event.type === 'messages-indeterminate' ? 'indeterminate' : 'queued')
        await this.refresh(true)
        break
      case 'message-cancelled':
        if (event.localId) { this.journal.update(event.localId, 'cancelled'); this.queued.delete(event.localId) }
        this.syncInbox(); this.publishProjection()
        break
      case 'messages-invalidated': case 'message-updated': case 'scheduled-matured': await this.refresh(true); break
      case 'session-updated': case 'session-added': case 'session-ended': await this.refresh(); break
      case 'session-removed': this.connected = false; this.publishProjection(); break
    }
  }

  async refresh(history = false): Promise<void> {
    if (this.pendingRefresh) { await this.pendingRefresh; if (history && !this.disposed) return this.refresh(true); return }
    const work = (async () => {
      if (this.disposed) return
      const snapshot = await this.transport.getSession(this.binding.hapiSessionId)
      this.observe(snapshot)
      if (history) {
        const rows = await readNativeHistory(this.transport, this.binding.hapiSessionId)
        this.cache.write(rows)
        try { await this.applyRows(rows, true) } catch (error) {
          if (error instanceof NativeHistoryChangedError && this.config.onHistoryChanged) {
            await this.config.onHistoryChanged(this, rows)
            return
          }
          throw error
        }
      }
      await this.journal.reconcileSource()
      this.fault = null
      this.syncInbox(); this.publishProjection()
    })()
    this.pendingRefresh = work
    try { await work } finally { if (this.pendingRefresh === work) this.pendingRefresh = undefined }
  }

  private observe(snapshot: HapiSession): void {
    const previous = this.source
    const execution = acceptExecution(previous, snapshot)
    const source = {
      ...snapshot,
      metadata: snapshot.metadataVersion >= previous.metadataVersion ? snapshot.metadata : previous.metadata,
      metadataVersion: Math.max(snapshot.metadataVersion, previous.metadataVersion),
      agentState: snapshot.agentStateVersion >= previous.agentStateVersion ? snapshot.agentState : previous.agentState,
      agentStateVersion: Math.max(snapshot.agentStateVersion, previous.agentStateVersion),
      ...(execution === undefined ? {} : { execution }),
      executionVersion: Math.max(snapshot.executionVersion ?? 0, previous.executionVersion ?? 0),
    }
    // Metadata versions are independent of transport response order. A stale
    // snapshot cannot retarget (or falsely detach) an already bound thread.
    assertBinding(this.binding, source)
    this.source = source
    this.approvals?.observe(this.source.agentState)
    const status = this.source.execution?.status
    const running = status === 'active' ? true : status === 'idle' || status === 'notLoaded' ? false : this.sourceRunning
    if (running !== this.sourceRunning) {
      this.sourceRunning = running
      this.dispatch.emit('agent/status', { status: this.status })
      if (!running) { for (const waiter of this.idleWaiters) waiter.resolve(); this.idleWaiters.clear() }
    }
    if (status === 'disconnected' || status === 'systemError') {
      this.rejectIdleWaiters('Native Codex activity is unknown until its owner reconnects')
    }
    const title = this.source.metadata?.name ?? this.source.metadata?.summary?.text
    if (title?.trim() && title !== this.lastTitle) {
      const event = this.session.append('session/title', { title: title.trim(), messageSeqs: [], source: { kind: 'user' } })
      this.lastTitleEvent = { title: title.trim(), seq: event.seq }
      this.lastTitle = title
    }
    const selected = { provider: 'hapi-codex-native', model: this.options.model ?? 'codex-native',
      ...(this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort }) }
    const selectionKey = JSON.stringify(selected)
    if (selectionKey !== this.lastModelSelection) {
      // The official prompt controller reads this public projection for image
      // admission. It reflects source-native configuration, never a local
      // request/header or an invented DSH model execution.
      this.session.append('model/selection', selected)
      this.lastModelSelection = selectionKey
    }
  }

  private async applyRows(messages: readonly HapiMessage[], authoritative = false): Promise<void> {
    const parsed = messages.flatMap(message => {
      const row = parseNativeRow(message, this.binding)
      return row ? [{ row, message }] : []
    })
    await this.content.prepare(parsed.map(item => item.row))
    if (this.disposed) return
    if (authoritative) {
      const observed = new Set(parsed.map(item => item.row.key))
      for (const key of this.projector.projectedKeys) if (!observed.has(key)) {
        throw new NativeHistoryChangedError('The native Codex history was rewound or replaced')
      }
      this.queued.clear()
    }
    // Project the transcript before retiring optimistic/native pending input.
    this.projector.apply(parsed.map(item => item.row))
    for (const { row, message } of parsed) {
      if (row.kind !== 'user' || !row.localId) continue
      if (row.invoked) { this.journal.update(row.localId, 'invoked'); this.queued.delete(row.localId) }
      else {
        this.queued.set(row.localId, { row, raw: message })
        this.journal.update(row.localId, message.deliveryState ?? 'queued')
      }
    }
    if (!this.initializing) { this.syncInbox(); this.publishProjection() }
  }

  private deliveries(): DeliveryView[] {
    const entries = new Map(this.journal.view().map(entry => [entry.localId, entry]))
    for (const [localId, { row, raw }] of this.queued) if (!entries.has(localId)) entries.set(localId, {
      localId, messageId: raw.id, text: row.text, mode: row.mode, createdAt: raw.createdAt,
      state: raw.deliveryState ?? 'queued', error: null,
    })
    return [...entries.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  private syncInbox(): void {
    const turn: UserMessage[] = []
    const step: UserMessage[] = []
    for (const delivery of this.deliveries()) {
      const message = this.journal.get(delivery.localId)?.message ?? freezeMessage({
        id: MessageId(`hapi:${delivery.localId}`), role: 'user', content: [{ type: 'text', text: delivery.text }], source: { kind: 'user' },
      })
      ;(delivery.mode === 'steer' ? step : turn).push(message)
    }
    this.inbox.sync(turn, step)
  }

  private publishProjection(): void {
    if (this.disposed || !this.approvals) return
    const value = this.projection
    const fingerprint = JSON.stringify(value)
    if (fingerprint === this.projectionFingerprint) return
    appendPluginRecord(this.session, 'plugin:hapi-dsh/state', value)
    this.projectionFingerprint = fingerprint
  }
  private assertWritable(): void {
    if (this.disposed) throw new Error('The native Codex observation was detached')
    if (this.projection.readOnly) throw new Error(this.fault ?? 'Native Codex is not attached to an available HAPI runner')
  }
  reportError(error: unknown): void {
    this.fault = error instanceof Error ? error.message : 'The native Codex observation failed'
    this.publishProjection()
  }

  private rejectIdleWaiters(message: string): void {
    for (const waiter of this.idleWaiters) waiter.reject(new Error(message))
    this.idleWaiters.clear()
  }

  /** Only detach the view and its registrations; do not stop native execution. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.rejectIdleWaiters('The native Codex observation was detached')
    this.projector?.abandonStream()
    this.detachAgent?.()
    this.detachSession?.()
    await this.journal?.settled()
    await this.scope.dispose()
    // Native lifetime is independent; no abortSession, queue drain, or turn/end here.
  }
}

function acceptExecution(previous: HapiSession, next: HapiSession): HapiNativeRuntime | null | undefined {
  if ((next.executionVersion ?? 0) < (previous.executionVersion ?? 0)) return previous.execution
  const current = previous.execution
  const candidate = next.execution
  if (current && candidate && current.owner === candidate.owner && current.generation === candidate.generation
    && candidate.sequence < current.sequence) return current
  return candidate
}
