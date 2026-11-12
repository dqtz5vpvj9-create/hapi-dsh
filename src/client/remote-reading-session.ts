/** Independent presentation lifetimes over one canonical HHPI Session and shared accepted history. */
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionBinding, SessionFace, SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationHistoryViewV1 } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UserMessageNode, SteeringMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { RemoteSourceSession } from './remote-sessions.ts'
import type { SourceWindowProgress } from './source-session-types.ts'
import type { AcceptedReadingPosition, RemoteReadingIntent } from './remote-history.ts'
import type { SourceReceipt } from '../remote/protocol.ts'

const paneScope = Symbol('hhpi.reading-occurrence')
interface PaneTag { binding?: SessionBinding }

/** The official reader owns navigation/assembly. All mutations retain their canonical native owner. */
export class RemotePaneSession implements SessionFace {
  readonly inputCommitPolicy = 'after-acceptance' as const
  get sourceEpoch(): string { return this.owner.history.sourceEpoch }
  readonly sessionId: SessionFace['sessionId']
  readonly projections: SessionFace['projections']
  readonly historyRead: RemoteSourceSession['historyRead']
  readonly metadata: RemoteSourceSession['metadata']
  readonly deliveries: RemoteSourceSession['deliveries']
  readonly controlStatus: RemoteSourceSession['controlStatus']
  readonly nativeActions: RemoteSourceSession['nativeActions']
  readonly ready: Promise<void>
  /** Direct sources use accepted-page cache sharing; no speculative prefetch is advertised. */
  readonly prefetchOlderPage?: () => Promise<void>
  private readonly opened = Promise.withResolvers<void>()
  private readonly abort = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly progressListeners = new Set<() => void>()
  private readonly stopOwner: () => void
  private readonly stopDeliveryReader: () => void
  private stopWindow: () => void = () => {}
  private window: ConversationHistoryViewV1 | undefined
  private state: SessionSnapshot
  private disposed = false
  private cacheId: string
  private openingIntent: RemoteReadingIntent = { kind: 'latest' }
  private savedReading: { epoch: string; seq: number } | undefined
  private olderRevision = 0
  private olderRead: { abort: AbortController; promise: Promise<void> } | undefined
  private progress: SourceWindowProgress & { hasMoreAfter: boolean } = { before: null, hasMoreAfter: false }
  readonly sourceWindow = {
    getSnapshot: (): SourceWindowProgress & { hasMoreAfter: boolean } => this.progress,
    subscribe: (listener: () => void): (() => void) => {
      this.progressListeners.add(listener)
      return () => { this.progressListeners.delete(listener) }
    },
  }

  constructor(private readonly owner: RemoteSourceSession, ownerReady: Promise<SessionBinding>, viewId: string) {
    this.cacheId = viewId
    this.sessionId = owner.sessionId
    this.projections = owner.projections
    this.historyRead = { version: 1, openView: (id, budget, signal) => {
      this.assertLive(); return owner.historyRead.openView(id, budget, signal, this.cacheId, this.openingIntent)
    } }
    this.metadata = owner.metadata
    this.deliveries = owner.deliveries
    this.controlStatus = owner.controlStatus
    this.nativeActions = owner.nativeActions
    this.state = { ...owner.getSnapshot(), openState: 'loading', hasMore: false, loadingOlder: false }
    this.stopOwner = owner.subscribe(() => { this.publish() })
    this.stopDeliveryReader = owner.registerDeliveryReader((nativeId, position) => this.bodyPublished(nativeId) || this.consumedBeforeWindow(position))
    this.ready = Promise.all([ownerReady, this.opened.promise]).then(() => { this.assertLive() })
    void this.ready.catch(() => {})
  }

  get readingView(): ConversationHistoryViewV1 | undefined { return this.window }
  /** Coordinates and time belong to this accepted Pane window's source generation. */
  readingWindowPosition(version: string, seq: number): AcceptedReadingPosition | undefined {
    if (this.disposed || !this.window) return undefined
    const reading = this.window.snapshot.getSnapshot()
    if (reading.phase !== 'ready' || reading.busy || reading.version !== version) return undefined
    return this.owner.history.acceptedReadingPosition(this.window.viewId, version, seq)
  }
  get readingCacheId(): string { return this.cacheId }
  get resumeReadingTarget(): number | undefined {
    if (this.window?.snapshot.getSnapshot().version == null) return undefined
    return this.openingIntent.kind === 'latest' && this.savedReading?.epoch === this.owner.history.sourceEpoch ? this.savedReading.seq : undefined
  }
  bindReadingCache(paneId: string, intent: RemoteReadingIntent = { kind: 'latest' }): void {
    if (this.window) throw new Error('Reading cache identity must be bound before the official window opens.')
    this.cacheId = paneId
    this.openingIntent = intent
    this.savedReading = this.owner.history.savedAnchor(paneId)
  }
  checkpointReading(): void { if (!this.disposed) this.owner.history.persist() }
  sourceDirectory(): ReturnType<RemoteSourceSession['sourceDirectory']> { this.assertLive(); return this.owner.sourceDirectory() }
  get promptReferences(): RemoteSourceSession['promptReferences'] { return this.owner.promptReferences }
  retrySubmission(operationId: string): void { this.assertLive(); this.owner.retrySubmission(operationId) }
  discardSubmission(operationId: string): void { this.owner.discardSubmission(operationId) }
  readonly getSnapshot = (): SessionSnapshot => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Called exactly once after the binding has been registered with the Session owner. */
  attach(view: ConversationHistoryViewV1): void {
    this.assertLive()
    if (this.window !== undefined) throw new Error('This Pane already owns an official reading window.')
    this.window = view
    const update = (): void => {
      if (this.disposed) return
      this.publish()
      this.owner.reconcilePublishedSubmissions()
      const state = view.snapshot.getSnapshot()
      if (state.phase === 'ready') this.opened.resolve()
      if (state.phase === 'error') this.opened.reject(new Error(`Source reader failed: ${state.failure}`))
      if (state.phase === 'closed') this.opened.reject(new Error('The source reader was released before opening.'))
    }
    this.stopWindow = view.snapshot.subscribe(update)
    update()
  }

  private publish(): void {
    if (this.disposed) return
    const base = this.owner.getSnapshot(), reading = this.window?.snapshot.getSnapshot()
    const nextState: SessionSnapshot = { ...base, openState: reading?.version == null ? 'loading' : 'open',
      hasMore: reading?.hasBefore ?? false, loadingOlder: reading?.busy ?? false }
    // No HAPI coordinate is synthesized from an opaque native cursor. The
    // monotonic count proves that this occurrence committed an older request.
    const nextProgress: typeof this.progress = { before: null, hasMoreAfter: reading?.hasAfter ?? false,
      olderRevision: this.olderRevision,
      // The canonical source epoch is published only after the official reader
      // accepts its opening window. attach() runs synchronously before that
      // baseline exists, so asking for the epoch during initial publication
      // would fail the entire pane mount.
      ...(reading?.version != null ? { historyId: JSON.stringify([this.sessionId, this.window!.viewId, this.owner.history.sourceEpoch]) } : {}),
      ...(reading?.phase === 'error' ? { pagingError: true as const } : {}) }
    // Official reader phases also publish body/correction revisions. Session
    // consumers observe only SessionSnapshot fields; source navigation has its
    // own subscribers and must not invalidate the input and conversation face.
    const different = (left: object, right: object): boolean => {
      const fields = new Set([...Object.keys(left), ...Object.keys(right)])
      return [...fields].some(key => !Object.is(Reflect.get(left, key), Reflect.get(right, key)))
    }
    if (different(this.state, nextState)) {
      this.state = nextState
      for (const listener of this.listeners) listener()
    }
    if (different(this.progress, nextProgress)) {
      this.progress = nextProgress
      for (const listener of this.progressListeners) listener()
    }
  }
  private assertLive(): void {
    if (this.disposed) throw new Error('This reading occurrence has been released.')
  }
  private reader(): ConversationHistoryViewV1 {
    this.assertLive()
    if (this.window === undefined) throw new Error('The official Pane reader has not been attached.')
    return this.window
  }
  async loadOlder(): Promise<void> {
    const view = this.reader()
    if (this.olderRead) return this.olderRead.promise
    const state = view.snapshot.getSnapshot()
    if (!state.hasBefore) return
    if (state.before == null) throw new Error('The source reader did not provide its older-history cursor.')
    const abort = new AbortController()
    const promise = view.read({ kind: 'before', cursor: state.before }, AbortSignal.any([abort.signal, this.abort.signal]))
      .then(snapshot => {
        this.assertLive()
        if (snapshot.before !== state.before) { ++this.olderRevision; this.publish() }
      })
      .finally(() => { if (this.olderRead?.abort === abort) this.olderRead = undefined })
    this.olderRead = { abort, promise }
    return promise
  }
  cancelOlderPage(reason: unknown = new DOMException('Reading cancelled.', 'AbortError')): void {
    this.olderRead?.abort.abort(reason)
  }
  async loadAfter(): Promise<boolean> {
    const view = this.reader(), state = view.snapshot.getSnapshot()
    if (!state.hasAfter || state.after == null) return false
    await view.read({ kind: 'after', cursor: state.after }, this.abort.signal)
    return true
  }
  async loadThrough(seq: Parameters<SessionFace['loadThrough']>[0]): Promise<void> {
    const view = this.reader(), state = view.snapshot.getSnapshot()
    if (state.entries.some(entry => entry.event.seq === seq)) return
    await view.read({ kind: 'around', target: { key: String(seq), seq } }, this.abort.signal)
  }
  async returnToLive(signal?: AbortSignal): Promise<boolean> {
    this.cancelOlderPage()
    await this.reader().read({ kind: 'latest' }, signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal)
    return true
  }
  beginSubmission(...args: Parameters<SessionFace['beginSubmission']>): ReturnType<SessionFace['beginSubmission']> {
    this.assertLive(); return this.owner.beginSubmission(args[0], nativeId => this.bodyPublished(nativeId))
  }
  private bodyPublished(nativeId: string): boolean {
    if (this.disposed) return true
    const entry = this.window?.snapshot.getSnapshot().entries.find(entry => entry.event.type === 'user/message'
      && entry.event.data.source.kind === 'user' && 'rpcId' in entry.event.data.source && entry.event.data.source.rpcId === nativeId)
    if (!entry || entry.event.type !== 'user/message') return false
    const content = entry.event.data.content
    // The official assembled payload, rather than an arriving source page,
    // owns the queue-to-body handoff for the submitting occurrence.
    return this.window?.reads.get('chat')?.nodes.values().some(node => {
      if (node.visibility !== 'visible' || node.kind !== 'user' && node.kind !== 'steering') return false
      const data = node.data as UserMessageNode | SteeringMessageNode
      const source = data.source as { kind?: string; rpcId?: string } | undefined
      return source?.kind === 'user' && source.rpcId === nativeId && data.seq === entry.event.seq
        && JSON.stringify(data.content) === JSON.stringify(content)
    }) ?? false
  }
  /** A restored, source-confirmed old message need not be scrolled into view again. */
  private consumedBeforeWindow(position: SourceReceipt['observed']): boolean {
    const view = this.window, state = view?.snapshot.getSnapshot()
    if (this.disposed || !position || !view || state?.phase !== 'ready' || state.busy || state.version == null) return false
    const nodes = view.reads.get('chat')?.nodes.values().filter(node => node.visibility === 'visible') ?? []
    const head = Math.min(...nodes.map(node => node.anchorSeq))
    if (!Number.isSafeInteger(head) || position.seq >= head) return false
    const accepted = this.readingWindowPosition(state.version, head)
    return accepted?.epoch === position.epoch
  }
  async prompt(...args: Parameters<SessionFace['prompt']>): ReturnType<SessionFace['prompt']> {
    // Conversation yields a paint after durable admission. Releasing this
    // presentation during that yield must not strand an already saved click.
    if (!this.owner.ownsSavedSubmission(args[3], args[1])) this.assertLive()
    return this.owner.prompt(...args)
  }
  async cancel(...args: Parameters<SessionFace['cancel']>): ReturnType<SessionFace['cancel']> {
    this.assertLive(); return this.owner.cancel(...args)
  }
  async readAttachment(...args: Parameters<SessionFace['readAttachment']>): ReturnType<SessionFace['readAttachment']> {
    this.assertLive(); return (this.owner as SessionFace).readAttachment(...args)
  }
  async updateQueue(...args: Parameters<SessionFace['updateQueue']>): ReturnType<SessionFace['updateQueue']> {
    this.assertLive(); return (this.owner as SessionFace).updateQueue(...args)
  }
  async rename(...args: Parameters<SessionFace['rename']>): ReturnType<SessionFace['rename']> {
    this.assertLive(); return (this.owner as SessionFace).rename(...args)
  }
  async command(...args: Parameters<SessionFace['command']>): ReturnType<SessionFace['command']> {
    this.assertLive(); return (this.owner as SessionFace).command(...args)
  }
  operate(...args: Parameters<RemoteSourceSession['operate']>): ReturnType<RemoteSourceSession['operate']> {
    this.assertLive(); return this.owner.operate(...args)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.stopWindow(); this.stopOwner(); this.stopDeliveryReader()
    this.owner.reconcilePublishedSubmissions()
    this.opened.reject(new Error('The reading occurrence was released.'))
    this.listeners.clear(); this.progressListeners.clear()
  }
}

interface PaneRecord {
  binding: SessionBinding
  session: RemotePaneSession
  release(): void
}

export interface RemotePaneReference extends SessionReference {
  readonly preparationReady: Promise<SessionBinding>
}

/** Registry validation prevents manufactured or stale bindings from entering an official SessionProvider. */
export class RemotePaneViews {
  private readonly records = new Map<SessionBinding, PaneRecord>()
  private readonly keys = new Set<string>()

  open(held: SessionReference, viewId: string): RemotePaneReference {
    const owner = held.binding.session as RemoteSourceSession
    const key = JSON.stringify([held.sessionId, viewId])
    if (this.keys.has(key)) { held.release(); throw new Error('This Pane reading occurrence is already retained.') }
    const scope = createScope(held.binding.ctx, held.sessionId), tag: PaneTag = {}
    const session = new RemotePaneSession(owner, held.ready, viewId)
    const binding: SessionBinding = { sessionId: held.sessionId, viewId, session,
      eventSource: held.binding.eventSource,
      ctx: scope.ctx.extend({ [paneScope]: tag }) as SessionBinding['ctx'] }
    tag.binding = binding
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.records.delete(binding); this.keys.delete(key)
      session.dispose()
      void Promise.resolve(scope.fiber.dispose()).finally(() => { held.release() }).catch(() => {})
    }
    this.keys.add(key)
    this.records.set(binding, { binding, session, release })
    // The source baseline is enough to render Chat. Full readiness intentionally
    // waits for the official reading occurrence to commit, which itself needs
    // Chat mounted to assemble that window.
    const preparationReady = held.ready.then(() => {
      if (released) throw new Error('The reading occurrence was released.')
      return binding
    })
    void preparationReady.catch(() => {})
    const ready = session.ready.then(() => { if (released) throw new Error('The reading occurrence was released.'); return binding })
    void ready.catch(() => {})
    return { sessionId: held.sessionId, preparationReady, ready,
      get binding() { if (released) throw new Error('The reading occurrence was released.'); return binding },
      release, [Symbol.dispose]: release }
  }
  isPaneContext(ctx: Context): boolean { return (ctx as Context & { [paneScope]?: PaneTag })[paneScope] !== undefined }
  owns(binding: SessionBinding): boolean { return this.records.has(binding) }
  bindingOf(ctx: Context): SessionBinding | undefined {
    const binding = (ctx as Context & { [paneScope]?: PaneTag })[paneScope]?.binding
    return binding !== undefined && this.records.has(binding) ? binding : undefined
  }
  releaseSession(id: string): void { for (const record of [...this.records.values()]) if (record.binding.sessionId === id) record.release() }
  dispose(): void { for (const record of [...this.records.values()]) record.release() }
}
