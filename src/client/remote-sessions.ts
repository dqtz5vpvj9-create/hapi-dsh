/** Public Session faces for native HHPI sources. These faces never create a DSH Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AgentScopeHandle, BeginSubmissionInput, Budget, HistoryFeedV1, ISessions, PendingSubmissionRetirement, ProjectionsFace, SessionBinding, SessionFace, SessionListState, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionSnapshot, SessionTarget, SubmissionHandle } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { isSourceSessionId, type SourceOperation, type SourceReceipt, type SourceSession } from '../remote/protocol.ts'
import { isSourceDisplayId } from '../shared/source-display-id.ts'
import { RemoteSourceHistory } from './remote-history.ts'
import { followSourceChanges } from './remote-follow.ts'
import { RemotePaneViews } from './remote-reading-session.ts'
import { decodeSourceAttachmentValue } from '../source-attachment-types.ts'

declare module '@deepseek-ai/cordis' { interface Context { hhpiSessions: RemoteSessions } }
declare module '@deepseek-ai/dsh-session-projection/types' { interface SessionProjectionMap { hhpiSource: SourceSession } }
class Value<T> {
  private readonly listeners = new Set<() => void>()
  constructor(private value: T) {}
  readonly getSnapshot = (): T => this.value
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  set(value: T): void { this.value = value; for (const listener of this.listeners) listener() }
}
export interface HhpiCatalogCapability { catalogReady: boolean; legacyHapi: boolean }
export interface HhpiCatalogCapabilityStore {
  getSnapshot(): HhpiCatalogCapability
  subscribe(listener: () => void): () => void
}
function result<T>(value: RemoteResult<T>): T { if (!value.ok) throw value.error; return value.value }
function sourceError(message: string, indeterminate = false): RemoteError<'hhpi/source'> {
  return new RemoteError('hhpi/source', message, { outcome: indeterminate ? 'indeterminate' : 'rejected', sourceCode: indeterminate ? 'outcome_unknown' : 'unsupported' })
}
interface TrackedOperation { readonly fingerprint: string; readonly promise: Promise<SourceReceipt> }

export class RemoteSourceSession implements SessionFace {
  readonly eventSource = new MutableSessionEventSource()
  readonly metadata: Value<SourceSession>
  readonly historyRead: { readonly version: 1; openView(viewId: string, budget?: Budget, signal?: AbortSignal): Promise<HistoryFeedV1> }
  readonly projections: ProjectionsFace
  private readonly state: Value<SessionSnapshot>
  private readonly projectionValues = new Map<string, Value<unknown>>()
  private readonly submissions = new Map<string, BeginSubmissionInput>()
  private readonly operations = new Map<string, TrackedOperation>()
  private readonly stopMetadata: () => void
  private disposed = false
  readonly ready: Promise<void>

  constructor(readonly sessionId: SessionId, metadata: SourceSession, readonly history: RemoteSourceHistory, private readonly api: HhpiRemoteApi) {
    this.metadata = new Value(metadata)
    this.state = new Value<SessionSnapshot>({ sessionId, pendingSubmissions: [], running: metadata.status === 'running' || metadata.status === 'waiting', subagent: null,
      removed: false, openState: 'loading', openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false,
      lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false })
    this.projections = { faceOf: key => {
      let value = this.projectionValues.get(key)
      if (!value) { value = new Value<unknown>(undefined); this.projectionValues.set(key, value) }
      return value
    } }
    this.historyRead = { version: 1, openView: (viewId, budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }, signal) => {
      if (this.disposed) return Promise.reject(new DOMException('The source view was released.', 'AbortError'))
      return history.openView(viewId, budget, signal)
    } }
    this.stopMetadata = history.subscribeSession(session => { this.update(session) })
    this.update(metadata)
    this.ready = history.prepare().then(page => {
      if (this.disposed) throw new DOMException('The source view was released.', 'AbortError')
      this.state.set({ ...this.state.getSnapshot(), openState: 'open', hasMore: page.hasBefore,
        blank: !page.entries.some(entry => ['user/message', 'assistant/message', 'tool/call'].includes(entry.event.type)) })
    }).catch(error => {
      if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), openState: 'error', openError: sourceError(error instanceof Error ? error.message : 'Source history is unavailable.') })
      throw error
    })
    void this.ready.catch(() => {})
  }
  readonly getSnapshot = (): SessionSnapshot => this.state.getSnapshot()
  readonly subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)
  update(session: SourceSession): void {
    if (this.disposed) return
    if (session.id !== this.sessionId) throw new Error('Source metadata crossed session identities')
    this.metadata.set(session)
    this.state.set({ ...this.state.getSnapshot(), running: session.status === 'running' || session.status === 'waiting' })
    for (const [key, value] of [['title', session.title], ['hhpiSource', session]] as const) {
      let store = this.projectionValues.get(key)
      if (!store) { store = new Value<unknown>(value); this.projectionValues.set(key, store) } else store.set(value)
    }
  }
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle {
    if (this.disposed) throw sourceError('The source view was released.')
    const requestId = crypto.randomUUID() as SessionRequestId
    this.submissions.set(requestId, input)
    this.state.set({ ...this.state.getSnapshot(), pendingSubmissions: [...this.state.getSnapshot().pendingSubmissions,
      { requestId, placement: input.mode === 'steer' ? 'steering' : 'transcript', time: Date.now(), text: input.text, attachments: input.attachments }] })
    return { requestId, abandon: () => { this.retire(requestId, { reason: 'failed' }) } }
  }
  private retire(id: string, retirement: PendingSubmissionRetirement): void {
    const pending = this.submissions.get(id)
    if (!pending) return
    this.submissions.delete(id)
    this.state.set({ ...this.state.getSnapshot(), pendingSubmissions: this.state.getSnapshot().pendingSubmissions.filter(value => value.requestId !== id) })
    pending.onRetire?.(retirement)
  }
  async prompt(...[content, mode, signal, suppliedId]: Parameters<SessionFace['prompt']>): ReturnType<SessionFace['prompt']> {
    const requestId = suppliedId ?? crypto.randomUUID() as SessionRequestId
    if (signal?.aborted) {
      this.retire(requestId, { reason: 'failed' })
      signal.throwIfAborted()
    }
    if (this.disposed) return { ok: false, error: sourceError('The source view was released.') }
    this.state.set({ ...this.state.getSnapshot(), promptAttempted: true, promptError: null })
    try {
      if (content.some(part => part.type !== 'text')) throw sourceError('This source currently accepts text input. File resources remain scoped to its source machine.')
      const text = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      const metadata = this.metadata.getSnapshot()
      const kind = mode === 'steer' ? 'steer' : 'send'
      if (metadata.status === 'offline') throw sourceError('The source is offline. No operation was sent.')
      if (!metadata.capabilities[kind]) throw sourceError(`The source does not support ${kind}.`)
      if (kind === 'steer' && !metadata.activeTurnId) throw sourceError('There is no active native turn to steer.')
      const receipt = await this.operate({ sessionId: this.sessionId, operationId: requestId, kind, text,
        ...(kind === 'steer' && metadata.activeTurnId ? { turnId: metadata.activeTurnId } : {}) })
      if (receipt.status !== 'accepted') throw sourceError(receipt.message, receipt.status === 'indeterminate')
      this.retire(requestId, { reason: 'observed', attachments: [] })
      return { ok: true, value: { accepted: true } }
    } catch (cause) {
      const error = cause instanceof RemoteError ? cause as RemoteError<'hhpi/source'> : sourceError(cause instanceof Error ? cause.message : 'The source did not acknowledge this operation.', true)
      this.retire(requestId, { reason: 'failed' })
      if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), promptError: { op: 'send', error } })
      return { ok: false, error }
    }
  }
  /** Share exact operation identities across Panes, including uncertain outcomes. */
  operate(operation: SourceOperation): Promise<SourceReceipt> {
    if (this.disposed) return Promise.reject(sourceError('The source view was released.'))
    if (operation.sessionId !== this.sessionId) return Promise.reject(sourceError('An operation belongs to another source session.'))
    const fingerprint = JSON.stringify([operation.kind, operation.text ?? null, operation.turnId ?? null, operation.requestId ?? null, operation.decision ?? null])
    const existing = this.operations.get(operation.operationId)
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.reject(sourceError('An operation ID was reused with different arguments.'))
    const request = Object.freeze({ ...operation })
    // Publish the identity before invoking remote code, including a synchronous
    // callback. Once dispatched, releasing a view never cancels the native write.
    const promise = Promise.resolve().then(() => this.api.operate(request)).then(result).then(receipt => {
      if (receipt.sessionId !== request.sessionId || receipt.operationId !== request.operationId) throw sourceError('The source returned a receipt for a different operation or session.', true)
      return Object.freeze({ ...receipt })
    })
    this.operations.set(request.operationId, { fingerprint, promise })
    return promise
  }
  async cancel(): ReturnType<SessionFace['cancel']> {
    const session = this.metadata.getSnapshot()
    if (!session.activeTurnId || !session.capabilities.cancel) return { ok: false, error: sourceError('There is no cancellable native turn.') }
    try {
      const receipt = await this.operate({ sessionId: this.sessionId, operationId: `cancel:${session.activeTurnId}`, kind: 'cancel', turnId: session.activeTurnId })
      if (receipt.status !== 'accepted') throw sourceError(receipt.message, receipt.status === 'indeterminate')
      return { ok: true, value: { accepted: true } }
    } catch (cause) { return { ok: false, error: sourceError(cause instanceof Error ? cause.message : 'Cancellation was not acknowledged.', true) } }
  }
  async readAttachment(...[attachmentId]: Parameters<SessionFace['readAttachment']>): ReturnType<SessionFace['readAttachment']> {
    if (this.disposed) return { ok: false, error: sourceError('The source view was released.') }
    try {
      const epoch = this.history.sourceEpoch
      const resource = result(await this.api.resource({ sessionId: this.sessionId, path: `attachment:${attachmentId}` }))
      if (this.disposed || this.history.sourceEpoch !== epoch) throw sourceError('The source history changed while its image was loading.')
      if (!resource.attachment || resource.attachment.attachmentId !== attachmentId || resource.attachment.mediaType !== resource.mimeType) {
        throw sourceError('The source returned a different image reference.')
      }
      return { ok: true, value: decodeSourceAttachmentValue({ attachment: resource.attachment, data: resource.content }) }
    } catch (cause) {
      return { ok: false, error: sourceError(cause instanceof Error ? cause.message : 'The native image is unavailable.') }
    }
  }
  async updateQueue(): ReturnType<SessionFace['updateQueue']> { return { ok: false, error: sourceError('This engine does not expose native queue editing.') } }
  async rename(): ReturnType<SessionFace['rename']> { return { ok: false, error: sourceError('This engine does not expose native rename.') } }
  async command(): ReturnType<SessionFace['command']> { return { ok: false, error: sourceError('Send source commands as text through its native input.') } }
  async loadOlder(): Promise<void> { throw sourceError('History navigation requires the current Pane reader.') }
  async loadThrough(): Promise<void> { throw sourceError('History navigation requires the current Pane reader.') }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.stopMetadata()
    for (const id of this.submissions.keys()) this.retire(id, { reason: 'failed' })
  }
}

interface RecordOwner { scope: AgentScopeHandle; session: RemoteSourceSession; binding: SessionBinding; counts: Map<SessionRetainOptions['source'], number> }
/** Delegate native DSH unchanged and add only explicitly advertised HHPI identities. */
export class RemoteSessions implements ISessions {
  readonly list: Value<SessionListState>
  readonly historySource?: NonNullable<ISessions['historySource']>
  readonly windowCommit?: NonNullable<ISessions['windowCommit']>
  private readonly metadata = new Map<string, SourceSession>()
  private readonly records = new Map<SessionId, RecordOwner>()
  private readonly readingViews = new RemotePaneViews()
  private readonly histories = new Map<SessionId, RemoteSourceHistory>()
  private readonly retainObservers = new Map<SessionId, Value<SessionRetainInfo>>()
  private readonly stopOriginal: () => void
  private readonly lifetime = new AbortController()
  private refreshRead: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private catalogChecked = false
  private catalogReceived = false
  readonly capabilities: HhpiCatalogCapabilityStore
  private readonly capabilityState: Value<HhpiCatalogCapability>
  legacyHapi = false

  constructor(private readonly ctx: Context, private readonly original: ISessions, readonly api: HhpiRemoteApi) {
    if (original.historySource) this.historySource = original.historySource
    if (original.windowCommit) this.windowCommit = original.windowCommit
    this.capabilityState = new Value({ catalogReady: false, legacyHapi: false })
    this.capabilities = this.capabilityState
    this.list = new Value(this.listSnapshot(original.list.getSnapshot()))
    this.stopOriginal = original.list.subscribe(() => { this.publish() })
    void this.refreshSources().catch(() => {
      // A failed HHPI request must not keep ordinary DSH sessions in `pending`.
      // The next interval retry will publish advertised source rows on success.
      if (!this.catalogChecked) { this.catalogChecked = true; this.publish() }
    })
    this.timer = setInterval(() => { void this.refreshSources().catch(() => {}) }, 5000)
  }
  get searchResultLimit(): number { return this.original.searchResultLimit }
  ownsBinding(binding: SessionBinding): boolean {
    return this.readingViews.owns(binding) || this.binding(binding.sessionId) === binding || this.original.ownsBinding?.(binding) === true
  }
  bindingOf(ctx: Context): SessionBinding | undefined {
    if (this.readingViews.isPaneContext(ctx)) return this.readingViews.bindingOf(ctx)
    const id = this.scopeOf(ctx)
    return this.original.bindingOf?.(ctx) ?? (id === undefined ? undefined : this.records.get(id)?.binding)
  }
  openReadingView(reference: SessionReference, viewId: string): SessionReference | undefined {
    this.lifetime.signal.throwIfAborted()
    if (!isSourceSessionId(reference.sessionId)) return this.original.openReadingView?.(reference, viewId)
    if (this.binding(reference.sessionId) !== reference.binding) throw new Error('The canonical source Session is no longer retained.')
    if (this.windowCommit?.readingOccurrences !== 1) throw new Error('Independent source reading requires the complete reading-occurrence extension set.')
    return this.readingViews.open(this.retain(reference.sessionId, { source: 'hapiWorkspace' }), viewId)
  }
  private async refreshSources(): Promise<void> {
    if (this.refreshRead) return this.refreshRead
    const work = (async () => {
      const catalog = result(await this.api.catalog(this.lifetime.signal))
      this.lifetime.signal.throwIfAborted()
      this.catalogReceived = true
      this.legacyHapi = catalog.legacyHapi
      this.catalogChecked = true
      const active = new Set(catalog.sessions.map(session => session.id))
      for (const [id, old] of this.metadata) if (!active.has(id)) {
        const offline: SourceSession = { ...old, status: 'offline' }
        this.metadata.set(id, offline); this.records.get(id as SessionId)?.session.update(offline)
      }
      for (const session of catalog.sessions) { this.metadata.set(session.id, session); this.records.get(session.id as SessionId)?.session.update(session) }
      this.publish()
      this.capabilityState.set({ catalogReady: true, legacyHapi: catalog.legacyHapi })
    })().finally(() => { if (this.refreshRead === work) this.refreshRead = undefined })
    this.refreshRead = work
    return work
  }
  private publish(): void {
    const base = this.original.list.getSnapshot()
    const ids = [...base.ids], byId = { ...base.byId }
    for (const session of this.metadata.values()) {
      const id = session.id as SessionId
      ids.push(id)
      byId[id] = { id, title: session.title, displayTitle: session.title, cwd: session.cwd, running: session.status === 'running' || session.status === 'waiting',
        retainedBy: this.retainInfo(id).getSnapshot().retainedBy, blank: false, updatedAt: session.updatedAt, projectionValues: { hhpiSource: session } }
    }
    this.list.set(this.listSnapshot({ ...base, ids, byId }))
  }
  private listSnapshot(base: SessionListState): SessionListState {
    const pending = !this.catalogChecked && base.phase === 'ready'
    if (!this.catalogChecked || !this.catalogReceived || this.legacyHapi) return pending ? { ...base, phase: 'pending' } : base
    const hidden = new Set([...base.ids, ...Object.keys(base.byId)].filter(isSourceDisplayId) as SessionId[])
    if (hidden.size === 0) return base
    const byId = { ...base.byId }
    const projectionsBySession = { ...base.projectionsBySession }
    for (const id of hidden) { delete byId[id]; delete projectionsBySession[id] }
    return { ...base, ids: base.ids.filter(id => !hidden.has(id)), byId, projectionsBySession }
  }
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    if (typeof target !== 'string' || !isSourceSessionId(target)) return this.original.retain(target, options)
    this.lifetime.signal.throwIfAborted(); options.signal?.throwIfAborted()
    if (!this.windowCommit) throw new Error('Direct HHPI sources require the pinned DSH history/window extension. Rebuild and install the source overlay.')
    let record = this.records.get(target)
    if (!record) {
      const metadata = this.metadata.get(target)
      if (!metadata) throw new Error('This source session has not been advertised by its Host.')
      let history = this.histories.get(target)
      if (!history) {
        history = new RemoteSourceHistory(target, {
          read: async (request, signal) => result(await this.api.read(request, signal)),
          changes: (request, signal) => followSourceChanges(this.ctx.remote, (cursor, generation) => this.api.changes(cursor, generation), request, signal),
        })
        this.histories.set(target, history)
      }
      const scope = createScope(this.ctx, target)
      const session = new RemoteSourceSession(target, metadata, history, this.api)
      const binding: SessionBinding = { sessionId: target, session, eventSource: session.eventSource, ctx: scope.ctx }
      record = { scope, session, binding, counts: new Map() }
      this.records.set(target, record)
    }
    const held = record
    held.counts.set(options.source, (held.counts.get(options.source) ?? 0) + 1)
    this.publishRetains(target, held)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      options.signal?.removeEventListener('abort', release)
      const count = held.counts.get(options.source) ?? 0
      if (count <= 1) held.counts.delete(options.source); else held.counts.set(options.source, count - 1)
      this.publishRetains(target, held)
      if (held.counts.size === 0 && this.records.get(target) === held) {
        this.records.delete(target); held.session.dispose(); void held.scope.fiber.dispose()
      }
    }
    options.signal?.addEventListener('abort', release, { once: true })
    const ready = held.session.ready.then(() => { if (released) throw new DOMException('The view was released.', 'AbortError'); return held.binding })
    void ready.catch(() => {})
    return { sessionId: target, get binding() { if (released) throw new Error('The view was released'); return held.binding }, ready, release, [Symbol.dispose]: release }
  }
  async using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T> {
    const reference = this.retain(target, options); try { return await operation(reference) } finally { reference.release() }
  }
  retainInfo(id: SessionId): ReturnType<ISessions['retainInfo']> {
    if (!isSourceSessionId(id)) return this.original.retainInfo(id)
    let store = this.retainObservers.get(id)
    if (!store) { store = new Value<SessionRetainInfo>({ referenceCount: 0, retainedBy: {} }); this.retainObservers.set(id, store) }
    return store
  }
  private publishRetains(id: SessionId, record: RecordOwner): void {
    this.retainInfo(id)
    this.retainObservers.get(id)!.set({ referenceCount: [...record.counts.values()].reduce((a, b) => a + b, 0), retainedBy: Object.fromEntries(record.counts) })
    this.publish()
  }
  create(...args: Parameters<ISessions['create']>): ReturnType<ISessions['create']> { return this.original.create(...args) }
  subagentAddress(...args: Parameters<ISessions['subagentAddress']>): ReturnType<ISessions['subagentAddress']> { return this.original.subagentAddress(...args) }
  async refreshProjections(id: SessionId): Promise<void> { if (isSourceSessionId(id)) return this.refreshSources(); return this.original.refreshProjections(id) }
  async refresh(): Promise<void> { await Promise.all([this.original.refresh(), this.refreshSources()]) }
  search(...args: Parameters<ISessions['search']>): ReturnType<ISessions['search']> { return this.original.search(...args) }
  fork(...args: Parameters<ISessions['fork']>): ReturnType<ISessions['fork']> {
    if (isSourceSessionId(args[0].sessionId)) return Promise.reject(sourceError('This source has not declared native fork capability.'))
    return this.original.fork(...args)
  }
  scope(id: SessionId): ReturnType<ISessions['scope']> { return this.records.get(id)?.scope.ctx ?? this.original.scope(id) }
  scopeOf(ctx: Context): SessionId | undefined { return scopeOf(ctx) ?? this.original.scopeOf(ctx) }
  sessionOf(ctx: Context): SessionFace | undefined {
    if (this.readingViews.isPaneContext(ctx)) return this.readingViews.bindingOf(ctx)?.session
    const id = this.scopeOf(ctx); return id ? this.records.get(id)?.session ?? this.original.sessionOf(ctx) : undefined
  }
  binding(id: SessionId): SessionBinding | undefined { return this.records.get(id)?.binding ?? this.original.binding(id) }
  dispose(): void {
    this.readingViews.dispose()
    this.lifetime.abort(); if (this.timer) clearInterval(this.timer); this.stopOriginal()
    for (const record of this.records.values()) { record.session.dispose(); void record.scope.fiber.dispose() }
    for (const history of this.histories.values()) history.dispose()
    this.records.clear(); this.histories.clear(); this.metadata.clear()
  }
}
