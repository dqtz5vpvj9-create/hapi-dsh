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
import {
  HapiRequestError,
  type HapiApprovalAnswer, type HapiAttachment, type HapiCancelResult, type HapiEvent, type HapiMessage,
  type HapiNativeRuntime, type HapiRetryResult, type HapiSession, type HapiSteerResult, type HapiTransport,
} from './contracts.js'
import { NativeApprovals } from './approvals.js'
import { DeliveryJournal } from './delivery.js'
import { readNativeHistory, readNativeHistoryTail } from './history.js'
import { NativeHistoryCache } from './history-cache.js'
import { HistoryReadInvalidatedError, SourceHistoryJournal, SourceHistoryOrder, type HistoryCheckpoint } from './history-journal.js'
import { SourceHistorySync } from './history-sync.js'
import { NativeContent, type NativeArtifactImporter } from './content.js'
import { assertBinding, bindingFor, nativeSessionId, parseNativeRow, type NativeBinding, type NativeRow } from './native.js'
import { NativeHistoryChangedError, NativeProjector } from './projector.js'
import type { DeliveryView, HapiProjection } from './projection-types.js'
import { NativeObservations } from './observations.js'
import { nativeThreadGoalSchema } from './observation-types.js'
import { bindNativeCommands } from './commands.js'
import { nativeStateDirectory } from './state-directory.js'
import { ObservedContent } from '../hapi-agent/content.js'
import { ObservedChildren } from '../hapi-agent/children.js'
import { ObservedScopeIndex } from '../hapi-agent/scopes.js'
import { parseObservedHistory, parseObservedMessage } from '../hapi-agent/parser.js'
import { sourceTeamProjection, acceptSourceStructuredState } from '../source-collaboration-types.js'
import { queuedEditCandidate as readQueuedEditCandidate } from './queued-edit-candidate.js'

export interface NativeCodexOptions {
  stateDirectory: string
  displayRevision?: number
  resolveAttachments?: (hapiSessionId: string, message: UserMessage) => Promise<HapiAttachment[]>
  importArtifact?: NativeArtifactImporter
  /** Allows the service to replace a display generation after authoritative native rewind. */
  onHistoryChanged?: (agent: NativeCodexAgent, rows: HapiMessage[], checkpoint: HistoryCheckpoint) => Promise<void>
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
}

/** The original-source facts a delivery needs before it may dispatch. */
export interface ResumableDeliveryTarget {
  /** The session id deliveries target right now. */
  sessionId(): string
  /** Known original-source lifecycle; only a confirmed inactive session is pre-resolved. */
  state(): { active: boolean }
  /** HAPI resume of the original session (single-flight). */
  resume(hapiSessionId: string): Promise<string>
  /** Confirm the resumed display still belongs to this exact native/source identity before delivery. */
  verify?(resumedSessionId: string): Promise<void>
  /** Persist the explicit user-visible rebind notice before dispatch and after acceptance. */
  onRebind?(localId: string, from: string, to: string, phase: 'before' | 'after'): void
}

/** Only the Hub's explicit, structured rejection authorizes an automatic resume. */
export function isInactiveSessionError(error: unknown): boolean {
  return error instanceof HapiRequestError && error.outcome === 'rejected' && error.code === 'session_inactive'
}

export function resumedSessionNotice(from: string, to: string): string {
  return `The original session was resumed as a new session (${to}). This message was delivered to the resumed session; reopen it from the sidebar to continue there. The previous display (${from}) was not claimed as its owner.`
}

/**
 * A delivery-only transport implementing HAPI's resolve-before-send ordering.
 *
 * - A known inactive original session is resumed and its native/source identity
 *   verified before the first dispatch; the resumed id is rebound first and the
 *   user is told about a different id after it accepts the message.
 * - A confirmed `session_inactive` HTTP 409 rejection (race with the source
 *   going inactive) does the same resolve once and retries the same durable
 *   localId exactly once.
 * - Transport errors, timeouts and lost acknowledgements are indeterminate:
 *   this transport never resumes, retries or swaps ids for them.
 *
 * `DeliveryJournal` still persists the dispatch before network I/O; a resume
 * failure leaves the message in its journal entry for an explicit retry.
 */
export function resumeAwareTransport(transport: HapiTransport, target: ResumableDeliveryTarget): HapiTransport {
  let current = target.sessionId()
  let resumed = false
  let resuming: Promise<string> | undefined
  const resolveOnce = async (): Promise<string> => {
    const cached = resuming
    if (cached) return cached
    if (resumed) return current
    const from = current
    resuming = target.resume(from).then(async next => {
      const id = next || from
      await target.verify?.(id)
      current = id
      resumed = true
      return id
    }).finally(() => { resuming = undefined })
    return resuming
  }
  const deliver = async (message: Parameters<HapiTransport['sendMessage']>[1]): Promise<void> => {
    const deliverTo = async (to: string, from: string): Promise<void> => {
      const rebound = to !== from
      // The rebound target and the user notice are persisted before any
      // network I/O; a crash between them restores as an unknown delivery.
      if (rebound) target.onRebind?.(message.localId, from, to, 'before')
      await transport.sendMessage(to, message)
      if (rebound) target.onRebind?.(message.localId, from, to, 'after')
    }
    const from = current
    if (target.state().active === false) {
      await deliverTo(await resolveOnce(), from)
      return
    }
    try { await transport.sendMessage(from, message) }
    catch (error) {
      if (!isInactiveSessionError(error)) throw error
      await deliverTo(await resolveOnce(), from)
    }
  }
  return {
    get hubId() { return transport.hubId },
    listSessions: () => transport.listSessions(),
    getSession: id => transport.getSession(id),
    readMessages: (id, query) => transport.readMessages(id, query),
    ...(transport.listSlashCommands ? { listSlashCommands: (id: string) => transport.listSlashCommands!(id) } : {}),
    sendMessage: (_sessionId, message) => deliver(message),
    getQueuedState: (id, localIds) => transport.getQueuedState(id, localIds),
    cancelQueuedMessage: (id, messageId) => transport.cancelQueuedMessage(id, messageId),
    steerQueuedMessage: (id, messageId) => transport.steerQueuedMessage(id, messageId),
    retryIndeterminateMessage: (id, messageId) => transport.retryIndeterminateMessage(id, messageId),
    abortSession: id => transport.abortSession(id),
    approve: (id, requestId, answer) => transport.approve(id, requestId, answer),
    deny: (id, requestId, answer) => transport.deny(id, requestId, answer),
    subscribe: listener => transport.subscribe(listener),
  }
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
  private readonly observations: NativeObservations
  private readonly childContent: ObservedContent
  private readonly childScopes = new ObservedScopeIndex()
  private readonly children: ObservedChildren
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
  private readonly historyJournal: SourceHistoryJournal
  private readonly historyOrder = new SourceHistoryOrder()
  private readonly historySync: SourceHistorySync
  private historyStale = false
  private rowWork: Promise<void> = Promise.resolve()

  private constructor(
    parent: Context,
    readonly transport: HapiTransport,
    source: HapiSession,
    private readonly config: NativeCodexOptions,
  ) {
    this.source = source
    this.historyJournal = config.historyJournal ?? new SourceHistoryJournal()
    this.historySync = new SourceHistorySync(history => this.refresh(history), error => this.reportError(error))
    this.binding = bindingFor(transport.hubId, source)
    this.logicalSessionId = nativeSessionId(transport.hubId, source.id)
    this.displayRevision = config.displayRevision ?? 0
    this.id = this.displayRevision === 0 ? this.logicalSessionId : SessionId(`${this.logicalSessionId}-r${this.displayRevision}`)
    this.scope = createScope(parent, this)
    this.ctx = this.scope.ctx
    this.currentSession = this.ctx.sessions.prepare(this.id, {
      meta: { cwd: source.metadata?.path ?? '/', createdAt: source.createdAt },
    })
    this.dispatch = agentEvents(this.ctx, this)
    this.inbox = new NativeInbox(this)
    const stateDirectory = nativeStateDirectory(config.stateDirectory, this.logicalSessionId, this.binding)
    this.cache = new NativeHistoryCache(stateDirectory, this.logicalSessionId)
    this.content = new NativeContent(stateDirectory, this.logicalSessionId, source.id, config.importArtifact)
    this.observations = new NativeObservations(stateDirectory, this.logicalSessionId, this.binding)
    this.childContent = new ObservedContent(stateDirectory, this.logicalSessionId, source.id, config)
    this.children = new ObservedChildren({ agent: this, logicalSessionId: this.logicalSessionId, displayRevision: this.displayRevision,
      content: item => this.childContent.get(item), state: () => ({
        hubId: this.binding.hubId, hapiSessionId: this.binding.hapiSessionId, flavor: 'codex',
        machineId: this.binding.machineId, machineName: this.source.metadata?.host ?? this.binding.machineId,
        path: this.source.metadata?.path ?? '/', active: this.source.active, connection: this.connected ? 'connected' : 'disconnected',
        model: this.source.model ?? this.source.metadata?.codexModel ?? null, effort: this.source.modelReasoningEffort ?? null,
        permissionMode: this.source.permissionMode ?? null, error: this.fault,
      }) })
    const deliveryTransport = config.resumeSession
      ? resumeAwareTransport(transport, {
          sessionId: () => this.binding.hapiSessionId,
          state: () => ({ active: this.source.active }),
          resume: config.resumeSession,
          verify: async resumedSessionId => {
            const resumed = await transport.getSession(resumedSessionId)
            if (resumed.metadata?.codexNativeSession !== true || resumed.metadata?.codexSessionId !== this.binding.threadId) {
              throw new HapiRequestError('The resumed session belongs to a different native Codex thread; the message was not delivered', 'rejected', 409, 'source_identity_mismatch')
            }
          },
          onRebind: (localId, from, to, phase) => {
            this.journal.update(localId, phase === 'before' ? 'dispatching' : 'accepted', resumedSessionNotice(from, to))
          },
        })
      : transport
    this.journal = new DeliveryJournal(stateDirectory, this.logicalSessionId, source.id, deliveryTransport, () => {
      if (!this.disposed && !this.initializing) { this.syncInbox(); this.publishProjection() }
    }, config.resolveAttachments)
    this.approvals = new NativeApprovals(stateDirectory, this.logicalSessionId, source.id, transport, () => {
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
      let checkpoint = options.historyCheckpoint ?? agent.historyJournal.checkpoint()
      if (!rows) {
        const cached = options.fastHistorySeed ? agent.cache.snapshot() : undefined
        if (cached) {
          rows = agent.historyJournal.overlayCache(cached.rows)
          agent.historyStale = true
          agent.fault = 'Cached source history is stale; reconciling with the live source'
        } else try {
          checkpoint = agent.historyJournal.checkpoint()
          const tail = options.fastHistorySeed ? await readNativeHistoryTail(transport, source.id)
            : { rows: await readNativeHistory(transport, source.id), complete: true }
          rows = agent.historyJournal.merge(tail.rows, checkpoint)
          agent.historyStale = !tail.complete
          if (!tail.complete) agent.fault = 'The initial source history tail is incomplete; reconciling earlier history'
        } catch (error) {
          options.assertSourceCurrent?.()
          if (error instanceof HistoryReadInvalidatedError) throw error
          checkpoint = agent.historyJournal.checkpoint()
          rows = agent.historyJournal.overlayCache((cached ?? agent.cache.snapshot())?.rows ?? [])
          agent.historyStale = true
          agent.fault = `${error instanceof Error ? error.message : 'Source history is unavailable'}; cached history is stale and is being reconciled`
        }
      } else {
        rows = agent.historyJournal.merge(rows, checkpoint)
      }
      agent.projector.beginHistorySeed()
      await agent.applyRows(rows, true, checkpoint)
      agent.currentSession = agent.ctx.sessions.prepare(agent.id, {
        seed: agent.projector.historySeed(),
        meta: { cwd: source.metadata?.path ?? '/', createdAt: source.createdAt },
      })
      agent.projector.finishHistorySeed(agent.session)
      agent.initializing = false
      agent.observe(source)
      if (agent.fault === null) await agent.journal.reconcileSource()
      agent.syncInbox()
      agent.publishProjection()
      options.assertSourceCurrent?.()
      agent.historyJournal.assertCurrent(checkpoint)
      agent.cache.write(rows, !agent.historyStale)
      agent.detachSession = agent.ctx.sessions.enter(agent.session)
      agent.detachAgent = agent.ctx.agents.enter(agent, undefined)
      bindNativeCommands(agent)
      agent.ctx.sessions.announce(agent.session)
      await agent.ctx.agents.announce(agent, 'startup')
      await agent.children.mount()
      return agent
    } catch (error) { await agent.dispose(); throw error }
  }

  /** Start only after the service has published this Agent in its registry. */
  startHistorySync(): void { if (this.historyStale) this.historySync.request(true) }
  requestHistorySync(): void { this.historyStale = true; this.historySync.request(true) }
  async settled(): Promise<void> { await this.historySync.settled(); await this.rowWork }

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
  get childSessions() { return this.children.list() }
  get titleEvent(): { title: string; seq: SessionSeq } | undefined { return this.lastTitleEvent }

  resolveForkBoundary(messageId: string) { return this.projector.forkBoundary(messageId) }
  resolveRewindLocalId(messageId: string): string | undefined { return this.projector.rewindLocalId(messageId) }
  resolveRewindLocalIdAtSeq(seq: number): string | undefined { return this.projector.rewindLocalIdAtSeq(seq) }
  resolveSourceMessageDisplaySeq(id: string): number | undefined { return this.projector.sourceMessageDisplaySeq(id) }

  get projection(): NonNullable<HapiProjection> {
    const goal = nativeThreadGoalSchema.safeParse(this.source.agentState?.threadGoal)
    return {
      engine: 'codex', hubId: this.binding.hubId, hapiSessionId: this.binding.hapiSessionId,
      logicalSessionId: this.logicalSessionId, displayRevision: this.displayRevision,
      machineId: this.binding.machineId, machineName: this.source.metadata?.host ?? this.binding.machineId,
      nativeId: this.binding.threadId, nativeHome: this.binding.home,
      nativeConnection: !this.connected || !this.source.active ? 'disconnected'
        : this.source.metadata?.codexNativeConnection ?? 'history',
      // `readOnly` keeps its operation-permission meaning (approvals, settings,
      // source edits). Message input is a separate admission: native Codex
      // always accepts a durable send and resolves the source on delivery.
      readOnly: !this.connected || !this.source.active || this.source.metadata?.codexNativeConnection !== 'attached'
        || this.source.metadata?.migrationInProgress !== undefined || this.fault !== null,
      readOnlyReason: !this.connected || !this.source.active || this.source.metadata?.codexNativeConnection !== 'attached'
        ? 'unavailable' : this.source.metadata?.migrationInProgress !== undefined ? 'migration' : this.fault !== null ? 'fault' : null,
      model: this.source.model ?? this.source.metadata?.codexModel ?? null,
      reasoningEffort: this.source.modelReasoningEffort ?? null,
      planId: typeof this.source.agentState?.codexPlanProposalId === 'string' ? this.source.agentState.codexPlanProposalId : null,
      threadGoal: goal.success && goal.data.threadId === this.binding.threadId ? goal.data : null,
      notices: this.observations.notices, usage: this.observations.usage,
      execution: this.source.execution ?? null,
      pendingRequests: this.approvals.pending(), resolvedRequests: this.approvals.resolved(),
      delivery: this.deliveries(), error: this.fault,
      sidechains: this.children.summaries,
      ...sourceTeamProjection(this.source),
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.assertWritable()
    if (!wakeup) throw new Error('Native Codex does not expose silent model-context injection through HAPI')
    this.journal.submit(message, target === 'next-step' ? 'steer' : 'queue')
  }
  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  scheduleText(input: { operationId: string; text: string; scheduledAt: number }): DeliveryView {
    this.assertWritable()
    if (!input.operationId.trim() || !input.text.trim()) throw new Error('Scheduled messages require a stable operation id and nonempty text')
    const entry = this.journal.submit(freezeMessage({
      id: MessageId(`hapi-schedule:${input.operationId}`), role: 'user', source: { kind: 'user', rpcId: `scheduled:${input.operationId}` },
      content: [{ type: 'text', text: input.text }],
    }), 'queue', input.scheduledAt)
    const { message: _message, ...view } = entry
    return view
  }
  /** Read an already recorded schedule without requiring a live writable owner. */
  scheduleReceipt(operationId: string): DeliveryView | null {
    const entry = this.journal.findByMessageId(`hapi-schedule:${operationId}`)
    if (!entry) return null
    const { message: _message, ...view } = entry
    return view
  }
  retryRejectedDelivery(localId: string): DeliveryView {
    this.assertWritable()
    const { message: _message, ...view } = this.journal.retryRejected(localId)
    return view
  }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(_message: UserMessage): void { throw new Error('Native Codex does not expose silent model-context injection through HAPI') }
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void {
    if (cause.kind === 'disposed') return
    this.assertWritable()
    void this.abort(options?.keepInbox === true).catch(error => this.reportError(error))
  }
  async abort(keepInbox = true): Promise<void> {
    this.assertWritable()
    if (!keepInbox) await Promise.all(this.deliveries().filter(delivery => !delivery.scheduledAt).map(delivery => this.cancelQueued(delivery.localId)))
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
  queuedEditCandidate(localId: string) {
    const value = this.queued.get(localId)
    return value ? readQueuedEditCandidate(value.raw, value.row.text) : undefined
  }
  async steerQueued(localId: string): Promise<HapiSteerResult> {
    this.assertWritable()
    if (this.deliveries().some(delivery => delivery.localId === localId && delivery.scheduledAt && delivery.scheduledAt > Date.now())) {
      throw new Error('A scheduled source message cannot be steered before it matures')
    }
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

  async handleEvent(event: HapiEvent, checkpoint = this.historyJournal.checkpoint()): Promise<void> {
    if (this.disposed || event.type === 'toast') return
    if (event.type === 'connection-changed') {
      this.connected = event.data?.status === 'connected'
      if (this.connected) { this.historyStale = true; this.historySync.request(true) }
      else {
        this.rejectIdleWaiters('Native Codex activity is unknown until its owner reconnects')
        this.publishProjection()
      }
      return
    }
    if (event.sessionId !== this.binding.hapiSessionId) return
    switch (event.type) {
      case 'message-received': await this.applyRows([event.message], false, checkpoint); break
      case 'messages-consumed':
        for (const id of event.localIds) { this.journal.update(id, 'invoked'); this.queued.delete(id) }
        this.syncInbox(); this.publishProjection();
        // Read actual native user items for original TUI/web transcript convergence.
        this.historySync.request(true)
        break
      case 'messages-dispatching': case 'messages-indeterminate': case 'messages-requeued':
        for (const id of event.localIds) this.journal.update(id, event.type === 'messages-dispatching' ? 'dispatching'
          : event.type === 'messages-indeterminate' ? 'indeterminate' : 'queued')
        this.historySync.request(true)
        break
      case 'message-cancelled':
        if (event.localId) { this.journal.update(event.localId, 'cancelled'); this.queued.delete(event.localId) }
        this.syncInbox(); this.publishProjection()
        break
      case 'messages-invalidated': case 'message-updated': case 'scheduled-matured':
        this.historyStale = true; this.historySync.request(true); break
      case 'session-updated': case 'session-added': case 'session-ended': this.historySync.request(false); break
      case 'session-removed': this.connected = false; this.publishProjection(); break
    }
  }

  async refresh(history = false): Promise<void> {
    if (this.pendingRefresh) { await this.pendingRefresh; if (history && !this.disposed) return this.refresh(true); return }
    const work = (async () => {
      if (this.disposed) return
      const snapshot = await this.transport.getSession(this.binding.hapiSessionId)
      if (this.disposed) return
      this.observe(snapshot)
      if (history || this.historyStale) {
        const checkpoint = this.historyJournal.checkpoint()
        const rows = await readNativeHistory(this.transport, this.binding.hapiSessionId)
        if (this.disposed) return
        let merged = this.historyJournal.merge(rows, checkpoint)
        try { await this.applyRows(merged, true, checkpoint) } catch (error) {
          if (error instanceof NativeHistoryChangedError && this.config.onHistoryChanged) {
            // Capture arrivals during content preparation as well. A changed
            // generation aborts this seed instead of resurrecting old rows.
            merged = this.historyJournal.merge(rows, checkpoint)
            await this.config.onHistoryChanged(this, merged, checkpoint)
            return
          }
          throw error
        }
      }
      await this.journal.reconcileSource()
      if (this.disposed) return
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
      ...acceptSourceStructuredState(previous, snapshot),
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

  private applyRows(messages: readonly HapiMessage[], authoritative = false, checkpoint = this.historyJournal.checkpoint()): Promise<void> {
    const work = this.rowWork.then(async () => {
      if (this.disposed) return
      this.historyJournal.assertCurrent(checkpoint)
      const rows = authoritative ? this.historyJournal.merge(messages, checkpoint, !this.historyStale) : messages
      if (!this.initializing && authoritative && this.historyOrder.needsReseed(rows)) {
        throw new NativeHistoryChangedError('Earlier source history is ready; acquiring its complete display generation')
      }
      await this.applyRowsNow(rows, authoritative, checkpoint)
      if (this.disposed) return
      this.historyJournal.assertCurrent(checkpoint)
      this.historyOrder.accept(rows, authoritative)
      if (authoritative && !this.initializing) {
        this.cache.write(rows); this.historyStale = false
      }
    })
    this.rowWork = work.catch(() => {})
    return work
  }

  private async applyRowsNow(messages: readonly HapiMessage[], authoritative: boolean, checkpoint: HistoryCheckpoint): Promise<void> {
    this.observations.observe(messages)
    this.childScopes.update(messages, authoritative)
    const children = (authoritative ? parseObservedHistory(messages, this.childScopes)
      : messages.flatMap(message => parseObservedMessage(message, this.childScopes))).filter(item => item.scopeId !== null)
    await this.childContent.prepare(children)
    const parsed = messages.flatMap(message => {
      const row = parseNativeRow(message, this.binding)
      return row ? [{ row, message }] : []
    })
    await this.content.prepare(parsed.map(item => item.row))
    if (this.disposed) return
    this.config.assertSourceCurrent?.()
    this.historyJournal.assertCurrent(checkpoint)
    if (authoritative) {
      const observed = new Set(parsed.map(item => item.row.key))
      for (const key of this.projector.projectedKeys) if (!observed.has(key)) {
        throw new NativeHistoryChangedError('The native Codex history was rewound or replaced')
      }
      this.queued.clear()
    }
    // Project the transcript before retiring optimistic/native pending input.
    this.projector.apply(parsed.map(item => item.row))
    await this.children.apply(children, this.childScopes.scopes(), authoritative)
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
      scheduledAt: raw.scheduledAt ?? null,
      state: raw.deliveryState ?? 'queued', error: null,
    })
    return [...entries.values()].map(entry => ({ ...entry, editable: this.queuedEditCandidate(entry.localId) !== undefined }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  private syncInbox(): void {
    const turn: UserMessage[] = []
    const step: UserMessage[] = []
    for (const delivery of this.deliveries()) {
      const message = this.journal.get(delivery.localId)?.message ?? freezeMessage({
        id: MessageId(`hapi:${delivery.localId}`), role: 'user',
        content: this.queued.has(delivery.localId) ? this.content.get(this.queued.get(delivery.localId)!.row)
          ?? [{ type: 'text', text: delivery.text }] : [{ type: 'text', text: delivery.text }],
        source: { kind: 'user' },
      })
      ;(delivery.mode === 'steer' ? step : turn).push(message)
    }
    this.inbox.sync(turn, step)
  }

  private publishProjection(): void {
    if (this.disposed || !this.approvals) return
    this.children.publishOwner()
    const value = this.projection
    const fingerprint = JSON.stringify(value)
    if (fingerprint === this.projectionFingerprint) return
    appendPluginRecord(this.session, 'plugin:hapi-dsh/state', value)
    this.projectionFingerprint = fingerprint
  }
  private assertWritable(): void {
    // Inactive/history/disconnected/fault sessions still accept a durable
    // journal submission; the delivery path resolves the source or reports an
    // explicit rejected/indeterminate receipt. Only a detached observation
    // cannot own new input.
    if (this.disposed) throw new Error('The native Codex observation was detached')
    this.config.assertSourceCurrent?.()
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
    this.historySync.dispose()
    this.rejectIdleWaiters('The native Codex observation was detached')
    this.projector?.abandonStream()
    await this.children?.dispose()
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
