import { SourceFrameFeed } from '../shared/source-frame-feed.ts'
import { withSourceAgentServices } from '../shared/source-agent-services.ts'
import { sessionHeaderCwd } from '../hapi/session-header-cwd.ts'
import { boundedProjectionRows, SOURCE_PROJECTION_MAX_EVENTS, SOURCE_PROJECTION_MAX_BYTES } from '../shared/source-projection-window.ts'
import type { SourceFrameBatch, SourceFrame } from '../shared/source-frames.ts'
import { toSourceFrames } from '../shared/source-frame-builder.ts'
import { checkedQueueMessage } from '../hapi/queue-receipt.ts'
import type { Context } from '@deepseek-ai/cordis'
import {
  agentEvents, type Agent, type AgentCancelCause, type AgentEventDispatch, type AgentOptions, type AgentStatus,
  type Inbox, type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord, Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import {
  HapiRequestError,
  type HapiApprovalAnswer, type HapiAttachment, type HapiCancelResult, type HapiEvent, type HapiMessage,
  type HapiNativeRuntime, type HapiRetryResult, type HapiSession, type HapiSteerResult, type HapiTransport,
} from './contracts.js'
import { NativeApprovals } from './approvals.js'
import { DeliveryJournal } from './delivery.js'
import { NativeHistoryEpochChangedError, readNativeHistoryForward, readNativeHistorySnapshot, readNativeHistoryTail, readNativeHistoryUpdate } from './history.js'
import { NativeHistoryCache } from './history-cache.js'
import { HistoryReadInvalidatedError, SourceHistoryJournal, SourceHistoryOrder, mergeSourceRows, sourceHistoryKey, type HistoryCheckpoint } from './history-journal.js'
import { SourceHistorySync } from './history-sync.js'
import { NativeContent, type NativeArtifactImporter } from './content.js'
import { assertBinding, bindingFor, compareNativeMessages, nativeSessionId, parseNativeRow, record, type NativeBinding, type NativeRow } from './native.js'
import { NativeHistoryChangedError, NativeProjector } from './projector.js'
import { DISPLAY_TURN_BASE, isSourceTurnStart, sourcePosition, sourceTurnKey, type HistoryWindowAnchor, type RenderedHistoryPage } from './source-window.js'
import type { DeliveryView, HapiProjectionState } from './projection-types.js'
import { NativeObservations } from './observations.js'
import { nativeThreadGoalSchema } from './observation-types.js'
import { bindNativeCommands } from './commands.js'
import { nativeStateDirectory } from './state-directory.js'
import { ObservedContent } from '../hapi-agent/content.js'
import { ObservedChildren } from '../hapi-agent/children.js'
import { ObservedScopeIndex } from '../hapi-agent/scopes.js'
import { parseObservedHistory, parseObservedMessage } from '../hapi-agent/parser.js'
import { sourceTeamProjection, acceptSourceStructuredState } from '../source-collaboration-types.js'
import { queuedAttachments, queuedEditCandidate as readQueuedEditCandidate } from './queued-edit-candidate.js'
import { SourceStatePublisher } from '../shared/source-state-publisher.ts'

/** The first display window needs recent source context, not an archive walk.
 * Three pages plus one epoch check is the bounded opening contract; older
 * history is served by the source history window on demand. */
const OPENING_TAIL_PAGES = 3

/** HAPI epochs are snapshot revisions, including content edits and reconnects.
 * Reuse an owner only after its source boundaries still name the same rows at
 * the same positions. A cursor reset alone is not evidence of a rewind. */
export async function readHistoryRevision(transport: HapiTransport, sessionId: string,
  latest: HapiMessage | undefined, anchor: HistoryWindowAnchor | undefined): Promise<{
    rows: HapiMessage[]; epoch: number; hasMore: boolean
  } | null> {
  const head = await transport.readMessages(sessionId, { limit: 32, bounded: true })
  const epoch = head.page.epoch
  const current = (page: typeof head): void => {
    if (page.page.reset || page.page.epoch !== epoch)
      throw new HistoryReadInvalidatedError('Source snapshot changed during bounded continuity validation')
  }
  current(head)
  const boundary = async (expected: { id: string; at: number; seq: number }, key?: string): Promise<HapiMessage | undefined> => {
    const matches = (row: HapiMessage): boolean => key === undefined ? row.id === expected.id : sourceHistoryKey(row) === key
    let row = head.messages.find(matches)
    if (!row) {
      // The cursor is exclusive; advancing only seq includes exactly the
      // known position, without relying on mutable message text or a hash.
      const page = await transport.readMessages(sessionId, { limit: 1, bounded: true, epoch,
        beforeAt: expected.at, beforeSeq: expected.seq + 1 })
      current(page); row = page.messages.find(matches)
    }
    return row && sourcePosition(row).at === expected.at && sourcePosition(row).seq === expected.seq ? row : undefined
  }
  const latestRow = latest ? await boundary({ id: latest.id, ...sourcePosition(latest) }, sourceHistoryKey(latest)) : undefined
  if (latest && !latestRow || anchor?.oldest && !await boundary(anchor.oldest)) return null
  if (!latest || head.messages.some(row => sourceHistoryKey(row) === sourceHistoryKey(latest)))
    return { rows: head.messages, epoch, hasMore: false }
  // A reconnect may leave more than one latest page between the old owner and
  // the new head. Preserve its cursor and bounded forward progress.
  try {
    const forward = await readNativeHistoryForward(transport, sessionId, epoch, sourcePosition(latest), 12)
    return { rows: [latestRow!, ...forward.rows], epoch, hasMore: forward.hasMore }
  } catch (error) {
    if (error instanceof NativeHistoryEpochChangedError)
      throw new HistoryReadInvalidatedError('Source snapshot changed during bounded continuity catch-up')
    throw error
  }
}

export interface NativeCodexOptions {
  /** Opening a display must not wait for child registration. */
  deferChildren?: boolean
  stateDirectory: string
  displayRevision?: number
  resolveAttachments?: (hapiSessionId: string, message: UserMessage) => Promise<HapiAttachment[]>
  importArtifact?: NativeArtifactImporter
  /** Rebuild the canonical read model after authoritative native history changes. */
  onHistoryChanged?: (agent: NativeCodexAgent, rows: HapiMessage[], checkpoint: HistoryCheckpoint, epoch?: number) => Promise<void>
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
  private readonly currentSession: Session
  readonly inbox: NativeInbox
  readonly dispatch: AgentEventDispatch
  readonly binding: NativeBinding
  readonly journal: DeliveryJournal
  private readonly approvals: NativeApprovals
  private readonly scope: Scope
  private projector: NativeProjector
  private readonly cache: NativeHistoryCache
  private readonly content: NativeContent
  private readonly observations: NativeObservations
  private readonly childContent: ObservedContent
  private childScopes = new ObservedScopeIndex()
  private readonly children: ObservedChildren
  /** Settles after child/subagent sessions have registered in the background. */
  childrenReady: Promise<void> = Promise.resolve()
  private source: HapiSession
  private readonly queued = new Map<string, { row: NativeRow & { kind: 'user' }; raw: HapiMessage }>()
  private readonly idleWaiters = new Set<{ resolve(): void; reject(error: Error): void }>()
  private detachAgent: (() => void) | undefined
  private detachSession: (() => void) | undefined
  private disposed = false
  private initializing = true
  private connected = true
  private fault: string | null = null
  private historyReadFault = false
  private readonly projectionPublisher = new SourceStatePublisher<NonNullable<HapiProjectionState>, 'execution'>({
    initial: value => { appendPluginRecord(this.session, 'plugin:hapi-dsh/state', value) },
    status: value => { appendPluginRecord(this.session, 'plugin:hapi-dsh/session-state', value) },
    notices: value => { appendPluginRecord(this.session, 'plugin:hapi-dsh/notices', value) },
  }, {
    key: 'execution', write: value => { appendPluginRecord(this.session, 'plugin:hapi-dsh/execution', value) },
  })
  private sourceRunning = false
  private lastTitle: string | undefined
  private lastTitleEvent: { title: string; seq: SessionSeq } | undefined
  private lastModelSelection = ''
  private pendingRefresh: Promise<void> | undefined
  private readonly historyJournal: SourceHistoryJournal
  private readonly historyOrder = new SourceHistoryOrder()
  private readonly historySync: SourceHistorySync
  private readonly liveSync: SourceHistorySync
  private historyEpoch: number | undefined
  private historyAnchor: HistoryWindowAnchor | undefined
  private structuralResetPending = false
  private historyFallback = false
  private historyStale = false
  private rowWork: Promise<void> = Promise.resolve()
  private residentRows: readonly HapiMessage[] = []
  private transientSources = new Set<string>()
  private transientKeys = new Set<string>()
  private readonly sourceFeed = new SourceFrameFeed(() => ({ kind: 'replace', frames: this.currentSourceFrames(), hasMoreBefore: this.projectedHasMoreBefore ?? this.historyWindowAnchor()?.hasOlder === true }))
  private projectionEventBytes = 0
  private projectedHasMoreBefore: boolean | undefined
  /** Live rows arriving during one forward read are merged, not committed early. */
  private constructor(
    parent: Context,
    readonly transport: HapiTransport,
    source: HapiSession,
    private readonly config: NativeCodexOptions,
  ) {
    this.source = source
    this.historyEpoch = config.historyEpoch
    this.historyJournal = config.historyJournal ?? new SourceHistoryJournal()
    this.historySync = new SourceHistorySync(history => this.refresh(history), error => this.reportError(error))
    // Running state and the newest native items must not wait behind archival
    // pagination from this or another source. Each live source still coalesces.
    this.liveSync = new SourceHistorySync(history => this.refreshLive(history), error => this.reportError(error), false)
    this.binding = bindingFor(transport.hubId, source)
    this.logicalSessionId = nativeSessionId(transport.hubId, source.id)
    this.displayRevision = config.displayRevision ?? 0
    this.id = this.displayRevision === 0 ? this.logicalSessionId : SessionId(`${this.logicalSessionId}-r${this.displayRevision}`)
    this.scope = createScope(parent, this)
    this.ctx = withSourceAgentServices(this.scope.ctx, parent)
    this.currentSession = this.ctx.sessions.prepare(this.id, {
      meta: { cwd: sessionHeaderCwd(source.metadata?.path), createdAt: source.createdAt },
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
    this.projector = this.createProjector()
  }

  private createProjector(): NativeProjector {
    return NativeProjector.history({
      model: () => this.options.model ?? 'codex-native', provider: () => this.options.provider ?? 'codex-native',
      turnBase: DISPLAY_TURN_BASE, streamRevisionBase: this.projector?.streamRevision() ?? 0,
      submittedMessage: localId => this.journal.get(localId)?.message,
      content: row => this.content.get(row),
      stream: () => {},
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
        // A snapshot revision is not cache freshness. Open the bounded tail before
        // the archive backfill so an old cache cannot hide current messages.
        try {
          checkpoint = agent.historyJournal.checkpoint()
          const tail = options.fastHistorySeed ? await readNativeHistoryTail(transport, source.id, OPENING_TAIL_PAGES)
            : { ...await readNativeHistorySnapshot(transport, source.id), complete: true }
          agent.historyEpoch = tail.epoch
          rows = agent.historyJournal.merge(tail.rows, checkpoint)
          if (options.fastHistorySeed) {
            const aligned = alignHistoryRows(rows, !tail.complete, ('epoch' in tail ? tail.epoch : undefined) ?? 0, 'before' in tail ? tail.before : undefined)
            rows = aligned.rows
            agent.historyAnchor = aligned.anchor ?? completeHistoryAnchor([], agent.historyEpoch ?? 0)
            // Older history is not missing display data: the source window
            // pages it on demand. Only a failed read leaves this stale.
            agent.historyStale = false
          } else {
            agent.historyAnchor = completeHistoryAnchor(rows, agent.historyEpoch ?? 0)
            agent.historyStale = !tail.complete
          }
        } catch (error) {
          options.assertSourceCurrent?.()
          if (error instanceof HistoryReadInvalidatedError) throw error
          checkpoint = agent.historyJournal.checkpoint()
          const cached = (options.fastHistorySeed ? agent.cache.snapshot(true) : undefined) ?? agent.cache.snapshot()
          agent.historyEpoch = cached?.epoch
          rows = agent.historyJournal.overlayCache(cached?.rows ?? [])
          const fallbackFirst = rows[0]
          agent.historyAnchor = fallbackFirst
            ? { epoch: cached?.epoch ?? 0, before: sourcePosition(fallbackFirst), firstTurn: DISPLAY_TURN_BASE + 1, hasOlder: true,
              partial: !isSourceTurnStart(fallbackFirst),
              oldest: { id: fallbackFirst.id, at: sourcePosition(fallbackFirst).at, seq: sourcePosition(fallbackFirst).seq } }
            : completeHistoryAnchor([], 0)
          agent.historyFallback = rows.length > 0
          agent.historyStale = true
          agent.historyReadFault = true
          agent.fault = `${error instanceof Error ? error.message : 'Source history is unavailable'}; cached history is stale and is being reconciled`
        }
      } else if (options.initialRowsMerged !== true) {
        rows = agent.historyJournal.merge(rows, checkpoint)
      }
      if (initialRows) {
        // A replacement owns the complete authoritative rows. It must never be
        // mistaken for an unseeded cache fallback and re-enter replacement.
        if (options.historyEpoch !== undefined) agent.historyEpoch = options.historyEpoch
        agent.historyAnchor = completeHistoryAnchor(rows, agent.historyEpoch ?? 0)
        agent.historyStale = false
      }
      if (!rows) rows = []
      if (agent.historyAnchor?.partial) agent.projector.setSuppressFirstTurnStart()
      await agent.applyRows(rows, true, checkpoint)
      agent.initializing = false
      agent.observe(source)
      if (agent.fault === null) await agent.journal.reconcileSource()
      agent.syncInbox()
      agent.publishProjection()
      options.assertSourceCurrent?.()
      agent.historyJournal.assertCurrent(checkpoint)
      // A fast opening seed is a bounded window, never a complete archive.
      if (options.fastHistorySeed && !initialRows) agent.cache.writeOpening(rows, false, agent.historyEpoch)
      else agent.cache.write(rows, !agent.historyStale, agent.historyEpoch)
      agent.detachSession = agent.ctx.sessions.enter(agent.session)
      agent.detachAgent = agent.ctx.agents.enter(agent, undefined)
      bindNativeCommands(agent)
      agent.ctx.sessions.announce(agent.session)
      // Profile plugins may attach local prompt/team tooling in a startup
      // listener. A source-owned Agent only mirrors remote execution, so a
      // listener that cannot run here must not fail opening the session.
      try { await agent.ctx.agents.announce(agent, 'startup') }
      catch (error) {
        console.warn('[hapi-dsh] agent startup listener failed; continuing with the source-owned agent:', error instanceof Error ? error.message : String(error))
      }
      if (options.deferChildren === true) {
        agent.childrenReady = agent.children.mount().catch(error => {
          console.warn('[hapi-dsh] background child registration failed; the parent display stays usable', error instanceof Error ? error.message : String(error))
        })
      } else await agent.children.mount()
      return agent
    } catch (error) { await agent.dispose(); throw error }
  }

  /** Start only after the service has published this Agent in its registry. */
  startHistorySync(): void { if (this.historyStale) this.historySync.request(true) }
  requestHistorySync(): void { this.historyStale = true; this.historySync.request(true) }
  async settled(): Promise<void> { await this.liveSync.settled(); await this.historySync.settled(); await this.rowWork }

  currentSourceFrames(): SourceFrame[] {
    return [...toSourceFrames({ events: this.projector.historySeed(), eventSources: this.projector.eventSources()!,
      turnAnchors: this.projector.turnAnchorEntries(), stepAnchors: this.projector.stepAnchorEntries() }),
      ...this.projector.activeSourceFrames()]
  }
  sourceFrameBaseline(): SourceFrameBatch { return this.sourceFeed.baseline() }
  sourceHistoryVersion(): number { return this.sourceFeed.version }
  sourceFrames(signal: AbortSignal): AsyncIterable<SourceFrameBatch> { return this.sourceFeed.watch(signal) }
  publishHistoryPageEnrichment(frames: readonly SourceFrame[]): void {
    if (!this.disposed && frames.length) this.sourceFeed.publish({ kind: 'merge', frames: [...frames] })
  }

  private publishSourceFrames(start: number, replace: boolean, reset = false): void {
    this.projectionEventBytes = (replace ? 0 : this.projectionEventBytes)
      + this.projector.historySeed().slice(start).reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0)
    const all = this.currentSourceFrames()
    const active = new Set(all.flatMap(frame => frame.transient && frame.source ? [frame.source.messageId] : []))
    const activeKeys = new Set(all.flatMap(frame => frame.transient ? [frame.key] : []))
    const removeKeys = [...this.transientKeys].filter(key => !all.some(frame => frame.key === key))
    const replaceSources = new Set([...this.transientSources, ...active])
    const frames = replace ? all : all.filter((frame, index) => index >= start
      || !!frame.source && replaceSources.has(frame.source.messageId))
    if (frames.length || replace || replaceSources.size || removeKeys.length) this.sourceFeed.publish(
      { kind: replace ? 'replace' : 'merge', frames, ...(replace ? { hasMoreBefore: this.projectedHasMoreBefore ?? this.historyWindowAnchor()?.hasOlder === true } : {}), ...(reset ? { reset: true } : {}), ...(!replace && replaceSources.size ? { replaceSources: [...replaceSources] } : {}),
        ...(removeKeys.length ? { removeKeys } : {}) })
    this.transientSources = active; this.transientKeys = activeKeys
  }


  /** Replace only read-model state; journals, inbox, approvals and the Session
   * transport continue to belong to this exact Agent throughout preparation. */
  rebaseDisplayHistory(rows: readonly HapiMessage[], checkpoint: HistoryCheckpoint, epoch?: number): Promise<void> {
    const work = this.rowWork.then(async () => {
      if (this.disposed) return
      this.historyJournal.assertCurrent(checkpoint)
      const retained = boundedProjectionRows(this.historyJournal.merge(rows, checkpoint))
      await this.applyRowsNow(retained.rows, true, checkpoint, true, true, retained.trimmed)
      if (this.disposed) return
      this.historyJournal.assertCurrent(checkpoint)
      this.residentRows = retained.rows
      this.historyOrder.accept(retained.rows, true)
      this.historyEpoch = epoch ?? this.historyEpoch
      this.historyAnchor = completeHistoryAnchor(retained.rows, this.historyEpoch ?? 0)
      if (retained.trimmed && this.historyAnchor) this.historyAnchor = { ...this.historyAnchor, hasOlder: true }
      this.historyStale = false; this.historyFallback = false; this.structuralResetPending = false
      this.fault = null; this.historyReadFault = false
      this.cache.writeOpening(retained.rows, !retained.trimmed, this.historyEpoch)
      this.syncInbox(); this.publishProjection()
    })
    this.rowWork = work.catch(() => {})
    return work
  }

  historyWindowAnchor(): HistoryWindowAnchor | undefined { return this.historyAnchor }
  historyTurnAnchors(): RenderedHistoryPage['turnAnchors'] { return this.projector.turnAnchorEntries() }

  /** Project one bounded source page without creating a display Session. */
  async renderHistoryPage(rows: readonly HapiMessage[]): Promise<RenderedHistoryPage> {
    const parsed = rows.flatMap(message => {
      const row = parseNativeRow(message, this.binding)
      return row ? [row] : []
    })
    const project = (): RenderedHistoryPage => {
      const history = NativeProjector.history({
        model: () => this.options.model ?? 'codex-native', provider: () => this.options.provider ?? 'codex-native',
        submittedMessage: localId => this.journal.get(localId)?.message, content: row => this.content.get(row), stream: () => {}, turnBase: 0,
      })
      if (!rows.length || !isSourceTurnStart(rows[0]!)) history.setSuppressFirstTurnStart()
      history.apply(parsed)
      return {
        events: history.historySeed(), lastTurn: history.lastTurn,
        sources: history.sourceSeqEntries(), rewinds: history.rewindSeqEntries(), forks: history.forkBoundaryEntries(),
        turnAnchors: history.turnAnchorEntries(), stepAnchors: history.stepAnchorEntries(),
        eventSources: history.eventSources()!,
      }
    }
    const rendered = project()
    const hasRemoteResources = parsed.some(row => {
      const raw = row.kind === 'user' ? row.parts : row.kind === 'tool-result' ? record(row.output)?.content : undefined
      if (!Array.isArray(raw)) return false
      return raw.some(part => {
        const artifact = record(record(part)?.artifact)
        return record(part)?.type === 'artifact' && typeof artifact?.id === 'string' && artifact.externalUrl === undefined
      })
    })
    if (!hasRemoteResources) return rendered
    // A message page is readable before old artifact bytes finish importing.
    return { ...rendered, resourceEnrichment: this.content.prepare(parsed).then(project) }
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
  get childSessions() { return this.children.list() }
  get titleEvent(): { title: string; seq: SessionSeq } | undefined { return this.lastTitleEvent }

  resolveForkBoundary(messageId: string) { return this.projector.forkBoundary(messageId) }
  resolveRewindLocalId(messageId: string): string | undefined { return this.projector.rewindLocalId(messageId) }
  resolveRewindLocalIdAtSeq(seq: number): string | undefined { return this.projector.rewindLocalIdAtSeq(seq) }
  resolveSourceMessageDisplaySeq(id: string): number | undefined { return this.projector.sourceMessageDisplaySeq(id) }
  sourceMessageAtDisplaySeq(seq: number): string | undefined { return this.projector.sourceMessageAtDisplaySeq(seq) }

  get projection(): NonNullable<HapiProjectionState> {
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
      permissionMode: this.source.permissionMode ?? null, serviceTier: this.source.serviceTier ?? null, collaborationMode: this.source.collaborationMode ?? null,
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
  recoverDelivery(localId: string, action: 'retry' | 'discard', operationId: string): DeliveryView {
    if (action === 'retry') this.assertWritable()
    const { message: _message, recoveries: _recoveries, ...view } = this.journal.recoverRejected(localId, action, operationId)
    return view
  }
  async checkDelivery(localId: string): Promise<DeliveryView | null> {
    const state = await this.transport.getQueuedState(this.binding.hapiSessionId, [localId])
    this.journal.reconcile(state)
    const pending = this.queued.get(localId)
    if (pending) {
      const raw = checkedQueueMessage(pending.raw, state)
      if (raw) this.queued.set(localId, { ...pending, raw })
      else this.queued.delete(localId)
    }
    this.syncInbox(); this.publishProjection()
    return this.deliveries().find(entry => entry.localId === localId) ?? null
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
  async steerInbox(itemId: string) {
    const delivery = this.deliveries().find(row =>
      (this.journal.get(row.localId)?.message?.id ?? `hapi:${row.localId}`) === itemId)
    if (!delivery || delivery.state !== 'queued') throw new Error('Source queue item is no longer confirmed queued; refresh its receipt before steering')
    return this.steerQueued(delivery.localId)
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
      if (this.connected) { this.historyStale = true; this.liveSync.request(true); this.historySync.request(true) }
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
      case 'messages-invalidated':
        if (event.reason === 'native-history') {
          // Incremental live reads apply provisional snapshot updates; a full
          // archive sync rejects them as a changed durable message.
          this.historyStale = true; this.liveSync.request(true)
          break
        }
        this.structuralResetPending = true
        this.historyEpoch = undefined
        this.historyStale = true; this.historySync.request(true); break
      case 'message-updated': case 'scheduled-matured':
        this.historyStale = true; this.historySync.request(true); break
      case 'session-updated': case 'session-added': case 'session-ended': this.liveSync.request(false); break
      case 'session-removed': this.connected = false; this.publishProjection(); break
    }
  }

  private async refreshLive(history: boolean): Promise<void> {
    // A stale opening fallback keeps its read fault visible until a history
    // read succeeds; a settings refresh must not hide it.
    if (!this.historyStale) await this.refreshSettings()
    if (!history || this.disposed) return
    const epoch = this.historyEpoch
    if (epoch === undefined) {
      // History catch-up has one serialized worker. The live edge only asks
      // for it; it never starts a second bounded/full read concurrently.
      this.historyStale = true
      this.historySync.request(true)
      return
    }
    const checkpoint = this.historyJournal.checkpoint()
    let rows: HapiMessage[] | null
    try { rows = await readNativeHistoryUpdate(this.transport, this.binding.hapiSessionId, epoch,
      row => this.historyOrder.overlapsLatest(row)) }
    catch (error) {
      if (error instanceof NativeHistoryEpochChangedError) { this.invalidateHistoryEpoch(); return }
      throw error
    }
    if (this.disposed) return
    this.historyJournal.assertCurrent(checkpoint)
    if (!rows || this.historyOrder.needsReseed(rows)) { this.historySync.request(true); return }
    // Indexed-native notifications carry no row payload. Retain the validated
    // delta just like SSE rows so an older in-flight archive cannot erase it.
    for (const message of rows) this.historyJournal.capture({ type: 'message-received', sessionId: this.binding.hapiSessionId, message })
    try { await this.applyRows(rows, false, this.historyJournal.checkpoint()) }
    catch (error) {
      if (error instanceof NativeHistoryChangedError) { this.historySync.request(true); return }
      throw error
    }
    this.syncInbox(); this.publishProjection()
  }

  private invalidateHistoryEpoch(): void {
    this.historyJournal.capture({ type: 'messages-invalidated', sessionId: this.binding.hapiSessionId, reason: 'rewind' })
    this.historyEpoch = undefined; this.historyStale = true; this.structuralResetPending = true
    this.historySync.request(true)
  }

  /** Settings reads must not queue behind transcript loading or delivery reconciliation. */
  async refreshSettings(source?: HapiSession): Promise<void> {
    if (this.disposed) throw new Error('The native Codex observation was detached')
    this.config.assertSourceCurrent?.()
    const snapshot = source ?? await this.transport.getSession(this.binding.hapiSessionId)
    if (this.disposed) throw new Error('The native Codex observation was detached')
    this.config.assertSourceCurrent?.()
    this.observe(snapshot)
    // A fresh, identity-checked source snapshot restores settings after a
    // read checkpoint collision. It does not claim that history has caught up.
    if (this.historyReadFault) { this.fault = null; this.historyReadFault = false }
    this.publishProjection()
  }

  async refresh(history = false): Promise<void> {
    if (this.pendingRefresh) { await this.pendingRefresh; if (history && !this.disposed) return this.refresh(true); return }
    const work = (async () => {
      if (this.disposed) return
      const snapshot = await this.transport.getSession(this.binding.hapiSessionId)
      if (this.disposed) return
      this.observe(snapshot)
      if (history || this.historyStale) {
        if (this.config.fastHistorySeed) {
          await this.refreshBounded()
        } else {
        const checkpoint = this.historyJournal.checkpoint()
        const snapshot = await readNativeHistorySnapshot(this.transport, this.binding.hapiSessionId)
        const rows = snapshot.rows
        if (this.disposed) return
        // Forget live rows from the removed epoch before taking a new read;
        // otherwise the receive journal could resurrect a deleted message.
        if (this.historyEpoch !== undefined && this.historyEpoch !== snapshot.epoch) { this.invalidateHistoryEpoch(); return }
        const merged = this.historyJournal.merge(rows, checkpoint)
        try { await this.applyRows(merged, true, checkpoint, true) } catch (error) {
          if (error instanceof NativeHistoryChangedError && this.config.onHistoryChanged) {
            // Capture arrivals during content preparation as well. A changed
            // generation aborts this seed instead of resurrecting old rows.
            // The same merged array still owns the authoritative source prefix;
            // the service adds only the post-checkpoint journal suffix.
            await this.config.onHistoryChanged(this, merged, checkpoint, snapshot.epoch)
            return
          }
          throw error
        }
        this.historyEpoch = snapshot.epoch
        this.cache.write(merged, true, this.historyEpoch)
        }
      }
      await this.journal.reconcileSource()
      if (this.disposed) return
      this.fault = null; this.historyReadFault = false
      this.syncInbox(); this.publishProjection()
    })()
    this.pendingRefresh = work
    try { await work } finally { if (this.pendingRefresh === work) this.pendingRefresh = undefined }
  }

  /**
   * Normal catch-up never reads the whole source archive. Older history is a
   * source-window page, not a new display generation. Snapshot revisions need
   * continuity validation; only structural changes request replacement.
   */
  private async refreshBounded(): Promise<void> {
    if (this.disposed) return
    if (this.structuralResetPending) { this.structuralResetPending = false; await this.replaceForStructuralChange(); return }
    if (this.historyFallback) {
      // Keep live activity independent. A delayed older source page is applied
      // after the live row; the source-frame annotations preserve source order
      // for the history window. Snapshot revisions require boundary validation.
      this.historyFallback = false
      try {
        const latestRow = this.historyOrder.latestRow()
        const latest = this.historyOrder.latestPosition()
        const checkpoint = this.historyJournal.checkpoint()
        const page = await this.transport.readMessages(this.binding.hapiSessionId, { limit: 32, bounded: true })
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
          this.syncInbox(); this.publishProjection()
          return
        }
        this.historyJournal.assertCurrent(checkpoint)
        let forward: Awaited<ReturnType<typeof readNativeHistoryForward>>
        try {
          forward = await readNativeHistoryForward(this.transport, this.binding.hapiSessionId, this.historyEpoch, latest!, 12)
        } catch (error) {
          if (error instanceof NativeHistoryEpochChangedError) { await this.refreshRevision(latestRow, checkpoint); return }
          throw error
        }
        if (this.disposed) return
        await this.applyRows(forward.rows, false, this.historyJournal.checkpoint())
        this.historyStale = forward.hasMore
        this.fault = null; this.historyReadFault = false
        this.syncInbox(); this.publishProjection()
        if (forward.hasMore) this.historySync.request(true)
        return
      } catch (error) {
        if (this.disposed) return
        this.historyFallback = true; throw error
      }
    }
    if (this.historyEpoch === undefined) {
      const checkpoint = this.historyJournal.checkpoint()
      const tail = await readNativeHistoryTail(this.transport, this.binding.hapiSessionId, OPENING_TAIL_PAGES)
      if (this.disposed) return
      const merged = this.historyJournal.merge(tail.rows, checkpoint)
      const aligned = alignHistoryRows(merged, !tail.complete, ('epoch' in tail ? tail.epoch : undefined) ?? 0, 'before' in tail ? tail.before : undefined)
      await this.applyRows(aligned.rows, false, checkpoint)
      this.historyEpoch = tail.epoch
      this.historyAnchor = aligned.anchor ?? completeHistoryAnchor(aligned.rows, this.historyEpoch ?? 0)
      this.historyStale = false
      this.fault = null; this.historyReadFault = false
      this.cache.writeOpening(aligned.rows, false, this.historyEpoch)
      this.syncInbox(); this.publishProjection()
      return
    }
    const latest = this.historyOrder.latestPosition()
    if (!latest) {
      const tail = await readNativeHistoryTail(this.transport, this.binding.hapiSessionId, OPENING_TAIL_PAGES)
      if (this.disposed) return
      const checkpoint = this.historyJournal.checkpoint()
      const merged = this.historyJournal.merge(tail.rows, checkpoint)
      await this.applyRows(merged, false, checkpoint)
      this.historyEpoch = tail.epoch
      this.historyAnchor = alignHistoryRows(merged, !tail.complete, tail.epoch ?? 0, tail.before).anchor ?? completeHistoryAnchor(merged, tail.epoch ?? 0)
      this.historyStale = false
      this.fault = null; this.historyReadFault = false
      this.syncInbox(); this.publishProjection()
      return
    }
    const checkpoint = this.historyJournal.checkpoint()
    const latestRow = this.historyOrder.latestRow()
    let forward: Awaited<ReturnType<typeof readNativeHistoryForward>>
    try {
      forward = await readNativeHistoryForward(this.transport, this.binding.hapiSessionId, this.historyEpoch, latest, 12)
    } catch (error) {
      if (error instanceof NativeHistoryEpochChangedError) { await this.refreshRevision(latestRow, checkpoint); return }
      throw error
    }
    if (this.disposed) return
    await this.applyRows(forward.rows, false, this.historyJournal.checkpoint())
    this.historyStale = forward.hasMore
    this.fault = null; this.historyReadFault = false
    this.syncInbox(); this.publishProjection()
    if (forward.hasMore) this.historySync.request(true)
  }

  private async refreshRevision(latest: HapiMessage | undefined, checkpoint: HistoryCheckpoint): Promise<void> {
    const revision = await readHistoryRevision(this.transport, this.binding.hapiSessionId,
      latest, this.historyAnchor)
    if (this.disposed) return
    this.historyJournal.assertCurrent(checkpoint)
    if (!revision) {
      this.historyJournal.capture({ type: 'messages-invalidated', sessionId: this.binding.hapiSessionId, reason: 'rewind' })
      await this.replaceForStructuralChange(); return
    }
    await this.applyRows(revision.rows, false, checkpoint)
    this.historyEpoch = revision.epoch
    if (this.historyAnchor) this.historyAnchor = { ...this.historyAnchor, epoch: revision.epoch }
    this.historyStale = revision.hasMore
    this.fault = null; this.historyReadFault = false
    this.syncInbox(); this.publishProjection()
    if (revision.hasMore) this.historySync.request(true)
  }

  /** Reconcile source content while preserving the execution and operation owners. */
  private async replaceForStructuralChange(): Promise<void> {
    const checkpoint = this.historyJournal.checkpoint()
    const snapshot = await readNativeHistorySnapshot(this.transport, this.binding.hapiSessionId)
    if (this.disposed) return
    if (!this.config.onHistoryChanged) throw new NativeHistoryChangedError('The native source history changed structurally')
    const merged = this.historyJournal.merge(snapshot.rows, checkpoint)
    await this.config.onHistoryChanged(this, merged, checkpoint, snapshot.epoch)
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

  private applyRows(messages: readonly HapiMessage[], authoritative = false, checkpoint = this.historyJournal.checkpoint(), merged = false): Promise<void> {
    const work = this.rowWork.then(async () => {
      if (this.disposed) return
      this.historyJournal.assertCurrent(checkpoint)
      const rows = merged ? messages : authoritative ? this.historyJournal.merge(messages, checkpoint, !this.historyStale) : messages
      if (!this.initializing && authoritative && !this.config.fastHistorySeed && this.historyOrder.needsReseed(rows)) {
        throw new NativeHistoryChangedError('Earlier source history is ready; acquiring its complete display generation')
      }
      const retained = boundedProjectionRows(authoritative ? rows : mergeSourceRows(this.residentRows, rows))
      const rebase = retained.trimmed || this.projector.historySeed().length > SOURCE_PROJECTION_MAX_EVENTS
        || this.projectionEventBytes > SOURCE_PROJECTION_MAX_BYTES
      await this.applyRowsNow(rebase ? retained.rows : rows, rebase || authoritative, checkpoint, rebase, false, retained.trimmed ? true : undefined)
      this.residentRows = retained.rows
      if (retained.trimmed) this.historyAnchor = { ...completeHistoryAnchor(retained.rows, this.historyEpoch ?? 0), hasOlder: true }
      if (this.disposed) return
      this.historyJournal.assertCurrent(checkpoint)
      this.historyOrder.accept(retained.rows, retained.trimmed || authoritative)
      if (authoritative && !this.initializing) {
        this.historyStale = false
      }
    })
    this.rowWork = work.catch(() => {})
    return work
  }

  private async applyRowsNow(messages: readonly HapiMessage[], authoritative: boolean, checkpoint: HistoryCheckpoint, rebase = false, reset = false, hasMoreBefore?: boolean): Promise<void> {
    this.observations.observe(messages)
    const scopes = rebase ? new ObservedScopeIndex() : this.childScopes
    scopes.update(messages, authoritative)
    const children = (authoritative ? parseObservedHistory(messages, scopes)
      : messages.flatMap(message => parseObservedMessage(message, scopes))).filter(item => item.scopeId !== null)
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
      for (const key of rebase ? [] : this.projector.projectedKeys) if (!observed.has(key)) {
        throw new NativeHistoryChangedError('The native Codex history was rewound or replaced')
      }
      this.queued.clear()
    }
    // Project the transcript before retiring optimistic/native pending input.
    const projector = rebase ? this.createProjector() : this.projector
    const start = rebase ? 0 : projector.historySeed().length
    projector.apply(parsed.map(item => item.row), !authoritative)
    if (rebase) { this.projector.abandonStream(); this.projector = projector }
    if (hasMoreBefore !== undefined) this.projectedHasMoreBefore = hasMoreBefore
    this.publishSourceFrames(start, rebase || this.initializing, reset)
    this.childScopes = scopes
    await this.children.apply(children, scopes.scopes(), authoritative, reset)
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
    return [...entries.values()].map(entry => {
      const candidate = this.queuedEditCandidate(entry.localId)
      return { ...entry, attachments: queuedAttachments(this.queued.get(entry.localId)?.raw), attachmentNames: candidate?.attachmentNames ?? [], editable: candidate !== undefined, cancelable: entry.state === 'queued' }
    })
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
    this.projectionPublisher.publish(this.projection)
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
    const historyRead = error instanceof HistoryReadInvalidatedError
    // A background read retry must not replace a real source/identity fault.
    if (historyRead && this.fault !== null && !this.historyReadFault) return
    this.historyReadFault = historyRead
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
    this.sourceFeed.dispose()
    this.historySync.dispose()
    this.liveSync.dispose()
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


/** Start a bounded live seed at an invoked human turn boundary. */
function completeHistoryAnchor(rows: readonly HapiMessage[], epoch: number): HistoryWindowAnchor {
  const sorted = rows.length ? [...rows].sort(compareNativeMessages) : []
  // HAPI appends unpositioned queued prompts to every message page. They have
  // old creation times but no source seq; they are not transcript positions and
  // must not become the window's oldest anchor (which drives outline mapping).
  const first = sorted.find(row => typeof row.seq === 'number') ?? sorted[0]
  const position = first ? sourcePosition(first) : { at: 0, seq: 0 }
  return { epoch, before: position, firstTurn: DISPLAY_TURN_BASE + 1, hasOlder: false,
    ...(first ? { oldest: { id: first.id, at: position.at, seq: position.seq },
      partial: !isSourceTurnStart(first) } : {}) }
}

function alignHistoryRows(rows: readonly HapiMessage[], sourceHasOlder: boolean, epoch: number,
  authoritativeBefore?: { at: number; seq: number }): {
  rows: HapiMessage[]; anchor: HistoryWindowAnchor | undefined
} {
  const sorted = [...rows].sort(compareNativeMessages)
  if (!sorted.length) return { rows: [], anchor: sourceHasOlder ? undefined : completeHistoryAnchor([], epoch) }
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
    anchor: {
      epoch,
      before: sourcePosition(aligned[0]!),
      firstTurn: DISPLAY_TURN_BASE + 1,
      hasOlder: sourceHasOlder || cut > 0,
      partial: false,
      oldest: { id: aligned[0]!.id, at: sourcePosition(aligned[0]!).at, seq: sourcePosition(aligned[0]!).seq },
    },
  }
}
