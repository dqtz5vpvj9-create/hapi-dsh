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
import { sourceIsOffline, sourceOffline } from '../shared/source-connectivity.ts'
import { RemoteSourceHistory } from './remote-history.ts'
import { followSourceChanges } from './remote-follow.ts'
import { RemotePaneViews } from './remote-reading-session.ts'
import { decodeSourceAttachmentValue } from '../source-attachment-types.ts'
import { SourceReadingCache, type SourceReadingStorage } from './remote-reading-cache.ts'
import { installRemoteReadingMemory } from './remote-reading-memory.ts'
import { browserSourceStorage } from './remote-storage.ts'
import { RemoteOutbox, type SourceDeliveryStore } from './remote-outbox.ts'

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
interface TrackedOperation { readonly fingerprint: string; promise?: Promise<SourceReceipt> | undefined; receipt?: SourceReceipt | undefined }

export class RemoteSourceSession implements SessionFace {
  readonly inputCommitPolicy = 'after-acceptance' as const
  readonly eventSource = new MutableSessionEventSource()
  readonly metadata: Value<SourceSession>
  readonly historyRead: { readonly version: 1; openView(viewId: string, budget?: Budget, signal?: AbortSignal, cacheId?: string): Promise<HistoryFeedV1> }
  readonly projections: ProjectionsFace
  readonly deliveries: SourceDeliveryStore
  readonly controlStatus = new Value<string | null>(null)
  private readonly state: Value<SessionSnapshot>
  private readonly projectionValues = new Map<string, Value<unknown>>()
  private readonly submissions = new Map<string, BeginSubmissionInput>()
  private readonly operations = new Map<string, TrackedOperation>()
  private readonly stopMetadata: () => void
  private readonly stopDeliveries: () => void
  private readonly stopRetirements: () => void
  private durableIds = new Set<string>()
  private readonly lifetime = new AbortController()
  private disposed = false
  readonly ready: Promise<void>

  constructor(readonly sessionId: SessionId, metadata: SourceSession, readonly history: RemoteSourceHistory, private readonly api: HhpiRemoteApi, private readonly outbox?: RemoteOutbox) {
    this.metadata = new Value(metadata)
    this.state = new Value<SessionSnapshot>({ sessionId, pendingSubmissions: [], running: metadata.status === 'running' || metadata.status === 'waiting', subagent: null,
      removed: false, openState: 'loading', openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false,
      lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false })
    this.projections = { faceOf: key => {
      let value = this.projectionValues.get(key)
      if (!value) { value = new Value<unknown>(undefined); this.projectionValues.set(key, value) }
      return value
    } }
    this.historyRead = { version: 1, openView: (viewId, budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }, signal, cacheId) => {
      if (this.disposed) return Promise.reject(new DOMException('The source view was released.', 'AbortError'))
      return history.openView(viewId, budget, signal, cacheId)
    } }
    this.stopMetadata = history.subscribeSession(session => { if (!history.metadataFromCache && this.metadata.getSnapshot() !== session) this.update(session) })
    this.deliveries = outbox?.view(sessionId) ?? new Value([])
    this.stopDeliveries = this.deliveries.subscribe(() => { this.syncDeliveries() })
    this.stopRetirements = outbox?.onRetire((id, observed) => { this.retire(id, observed ? { reason: 'observed', attachments: [] } : { reason: 'failed' }) }) ?? (() => {})
    this.syncDeliveries()
    this.update(metadata)
    this.ready = history.prepare(this.lifetime.signal).then(page => {
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
  private syncDeliveries(): void {
    if (this.disposed) return
    const deliveries = this.deliveries.getSnapshot().filter(entry => entry.state !== 'owner-accepted'), prior = this.durableIds
    this.durableIds = new Set(deliveries.map(entry => entry.operation.operationId))
    const state = this.state.getSnapshot()
    this.state.set({ ...state, pendingSubmissions: [...state.pendingSubmissions.filter(entry => !prior.has(entry.requestId) && !this.durableIds.has(entry.requestId)),
      ...deliveries.map(entry => ({ requestId: entry.operation.operationId as SessionRequestId, placement: 'transcript' as const,
        time: entry.createdAt, text: entry.operation.text ?? '', attachments: [] }))] })
  }
  discardSubmission(operationId: string): void { this.outbox?.discard(operationId) }
  ownsSavedSubmission(operationId: string | undefined): boolean {
    return operationId !== undefined && this.outbox?.get(operationId)?.operation.sessionId === this.sessionId
  }
  update(session: SourceSession): void {
    if (this.disposed) return
    if (session.id !== this.sessionId) throw new Error('Source metadata crossed session identities')
    this.metadata.set(session)
    this.state.set({ ...this.state.getSnapshot(), running: session.status === 'offline'
      ? this.state.getSnapshot().running : session.status === 'running' || session.status === 'waiting' })
    for (const [key, value] of [['title', session.title], ['hhpiSource', session]] as const) {
      let store = this.projectionValues.get(key)
      if (!store) { store = new Value<unknown>(value); this.projectionValues.set(key, store) } else store.set(value)
    }
  }
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle {
    if (this.disposed) throw sourceError('The source view was released.')
    if (input.attachments.length) throw sourceError('This source currently accepts text input. Your files and draft have been kept.')
    const requestId = crypto.randomUUID() as SessionRequestId
    if (input.mode === 'queue' && this.outbox) {
      const metadata = this.metadata.getSnapshot()
      if (!sourceIsOffline(metadata) && !metadata.capabilities.send) throw sourceError('The source does not support send.')
      this.outbox.enqueue({ sessionId: this.sessionId, operationId: requestId, kind: 'send', text: input.text })
      this.submissions.set(requestId, input)
      return { requestId, admitted: true, abandon: () => { this.outbox?.abandon(requestId) } }
    }
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
    if (mode === 'queue' && this.outbox) {
      try {
        if (content.some(part => part.type !== 'text')) {
          this.outbox.abandon(requestId)
          throw sourceError('This source currently accepts text input. Your files and draft have been kept.')
        }
        const text = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
        const saved = this.outbox.get(requestId)
        if (!saved) signal?.throwIfAborted()
        if (saved && (saved.operation.sessionId !== this.sessionId || saved.operation.text !== text)) {
          this.outbox.abandon(requestId)
          throw sourceError('A saved submission cannot be changed after admission.')
        }
        if (!saved) {
          if (this.disposed) throw sourceError('The source view was released.')
          signal?.throwIfAborted()
          const metadata = this.metadata.getSnapshot()
          if (!sourceIsOffline(metadata) && !metadata.capabilities.send) throw sourceError('The source does not support send.')
          this.outbox.enqueue({ sessionId: this.sessionId, operationId: requestId, kind: 'send', text })
        }
        this.outbox.start(requestId)
        if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), promptAttempted: true, promptError: null })
        return { ok: true, value: { accepted: true } }
      } catch (cause) {
        const error = cause instanceof RemoteError ? cause as RemoteError<'hhpi/source'> : sourceError(cause instanceof Error ? cause.message : 'The message could not be saved.')
        if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), promptError: { op: 'send', error } })
        return { ok: false, error }
      }
    }
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
      if (sourceIsOffline(metadata)) throw sourceError('The source is offline. No operation was sent.')
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
    if (existing && existing.fingerprint !== fingerprint) return Promise.reject(sourceError('An operation ID was reused with different arguments.'))
    if (existing?.promise) return existing.promise
    if (existing?.receipt && existing.receipt.status !== 'indeterminate' && existing.receipt.retryable !== true) return Promise.resolve(existing.receipt)
    const tracked = existing ?? { fingerprint }
    const request = Object.freeze({ ...operation })
    // Publish the identity before invoking remote code, including a synchronous
    // callback. Once dispatched, releasing a view never cancels the native write.
    const promise = Promise.resolve().then(async () => {
      // Lost browser ACKs are read using the same immutable identity. Looking
      // up an existing receipt cannot dispatch a control to a replacement turn.
      if (existing && this.api.receipt) {
        const prior = result(await this.api.receipt(request))
        if (prior && prior.retryable !== true) return prior
      }
      this.assertOperationCurrent(request)
      return result(await this.api.operate(request))
    }).then(receipt => {
      if (receipt.sessionId !== request.sessionId || receipt.operationId !== request.operationId) throw sourceError('The source returned a receipt for a different operation or session.', true)
      tracked.receipt = Object.freeze({ ...receipt })
      return tracked.receipt
    }).finally(() => {
      if (tracked.promise === promise) tracked.promise = undefined
    })
    tracked.promise = promise; this.operations.set(request.operationId, tracked)
    return promise
  }
  private assertOperationCurrent(operation: SourceOperation): void {
    if (this.disposed) throw sourceError('The source view was released.')
    const metadata = this.metadata.getSnapshot()
    if (sourceIsOffline(metadata)) throw sourceError('Reconnect before controlling the original native operation.')
    if (!metadata.capabilities[operation.kind]) throw sourceError(`The source does not support ${operation.kind}.`)
    if ((operation.kind === 'steer' || operation.kind === 'cancel') && (!operation.turnId || metadata.activeTurnId !== operation.turnId)) throw sourceError('The original native turn is no longer active. No replacement turn was controlled.')
    if (operation.kind === 'approve' && (!operation.requestId || !metadata.pendingRequests.some(request => request.id === operation.requestId))) throw sourceError('The original native approval is no longer available.')
  }
  async cancel(): ReturnType<SessionFace['cancel']> {
    const session = this.metadata.getSnapshot()
    if (sourceIsOffline(session)) {
      const message = 'Waiting for the source connection. Reconnect before stopping the original turn.'
      this.controlStatus.set(message)
      return { ok: false, error: new RemoteError('hhpi/source', message, { outcome: 'rejected', sourceCode: 'TARGET_UNAVAILABLE' }) }
    }
    if (!session.activeTurnId || !session.capabilities.cancel) {
      this.controlStatus.set('There is no cancellable native turn. No control was sent.')
      return { ok: false, error: sourceError('There is no cancellable native turn.') }
    }
    try {
      const receipt = await this.operate({ sessionId: this.sessionId, operationId: `cancel:${session.activeTurnId}`, kind: 'cancel', turnId: session.activeTurnId })
      this.controlStatus.set(receipt.message)
      if (receipt.status !== 'accepted') throw sourceError(receipt.message, receipt.status === 'indeterminate')
      return { ok: true, value: { accepted: true } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Cancellation is waiting for confirmation for the original turn.'
      this.controlStatus.set(message)
      return { ok: false, error: sourceError(message, true) }
    }
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
    this.disposed = true; this.lifetime.abort(); this.stopMetadata(); this.stopDeliveries(); this.stopRetirements()
    for (const id of this.submissions.keys()) if (!this.outbox?.get(id)) this.retire(id, { reason: 'failed' })
    this.submissions.clear()
  }
}

interface RecordOwner { scope: AgentScopeHandle; session: RemoteSourceSession; binding: SessionBinding; counts: Map<SessionRetainOptions['source'], number> }
/** Delegate native DSH unchanged and add only explicitly advertised HHPI identities. */
export class RemoteSessions implements ISessions {
  readonly list: Value<SessionListState>
  readonly historySource?: NonNullable<ISessions['historySource']>
  readonly windowCommit?: NonNullable<ISessions['windowCommit']>
  private readonly metadata = new Map<string, SourceSession>()
  private readonly revokedReadingSources = new Set<string>()
  private historyMetadataRevision = 0
  private readonly historyMetadataRevisions = new Map<string, number>()
  private readonly records = new Map<SessionId, RecordOwner>()
  private readonly readingViews = new RemotePaneViews()
  private readonly histories = new Map<SessionId, RemoteSourceHistory>()
  private readonly retainObservers = new Map<SessionId, Value<SessionRetainInfo>>()
  private readonly stopOriginal: () => void
  private readonly lifetime = new AbortController()
  private readingCache: SourceReadingCache | undefined
  private readingStorage: SourceReadingStorage | undefined
  private storageRevoked = false
  private readonly outbox: RemoteOutbox
  private stopReadingMemory: (() => void) | undefined
  private refreshRead: Promise<void> | undefined
  private refreshAbort: AbortController | undefined
  private storageGeneration = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private catalogChecked = false
  private catalogReceived = false
  readonly capabilities: HhpiCatalogCapabilityStore
  private readonly capabilityState: Value<HhpiCatalogCapability>
  legacyHapi = false

  constructor(private readonly ctx: Context, private readonly original: ISessions, readonly api: HhpiRemoteApi, readingStorage?: SourceReadingStorage) {
    this.outbox = new RemoteOutbox(async operation => result(await this.api.operate(operation)),
      this.api.receipt ? async operation => result(await this.api.receipt!(operation)) : undefined,
      async (operation, receipt) => {
        // An open official reader publishes accepted entries normally. Exact
        // receipt coordinates still reconcile messages outside its viewport;
        // with no Pane, a bounded tail read also works without a rendering graph.
        if (this.records.has(operation.sessionId as SessionId) && !receipt.observed) return []
        const page = result(await this.api.read({ sessionId: operation.sessionId, limit: 160,
          ...(receipt.observed ? { epoch: receipt.observed.epoch, around: receipt.observed.seq } : {}) }, this.lifetime.signal))
        if (page.session.id !== operation.sessionId) throw sourceError('The source returned another session while confirming delivery.', true)
        if (receipt.observed && page.epoch !== receipt.observed.epoch) return []
        return page.entries
      })
    if (original.historySource) this.historySource = original.historySource
    if (original.windowCommit) this.windowCommit = original.windowCommit
    this.capabilityState = new Value({ catalogReady: false, legacyHapi: false })
    this.capabilities = this.capabilityState
    this.list = new Value(this.listSnapshot(original.list.getSnapshot()))
    this.stopOriginal = original.list.subscribe(() => { this.publish() })
    this.setReadingStorage(readingStorage)
    void this.refreshSources().catch(() => {
      // A failed HHPI request must not keep ordinary DSH sessions in `pending`.
      // The next interval retry will publish advertised source rows on success.
      if (!this.catalogChecked) { this.catalogChecked = true; this.publish() }
    })
    this.timer = setInterval(() => { void this.refreshSources().catch(() => {}) }, 5000)
  }
  /** The caller supplies only storage selected by the authenticated bootstrap/catalog scope. */
  setReadingStorage(access: SourceReadingStorage | undefined, refresh = true): void {
    if (this.storageRevoked && access) return
    if (!this.storageRevoked && access?.scope === this.readingStorage?.scope && access?.storage === this.readingStorage?.storage) return
    ++this.storageGeneration; this.refreshAbort?.abort(); this.refreshAbort = undefined; this.refreshRead = undefined
    for (const id of [...this.metadata.keys()]) this.removeReadingSource(id)
    this.revokedReadingSources.clear()
    if (this.readingCache) {
      this.readingCache.clear(); this.readingCache.dispose(); this.readingCache = undefined
    }
    this.readingStorage = access
    this.outbox.clear(); this.outbox.setStorage(access)
    if (access) {
      this.readingCache = new SourceReadingCache(access)
      for (const session of this.readingCache.sessions()) this.metadata.set(session.id, sourceOffline(session))
      if (!this.stopReadingMemory) this.stopReadingMemory = installRemoteReadingMemory(this.ctx, () => this.readingCache, binding => this.ownsBinding(binding))
      if (this.metadata.size) this.catalogChecked = true
    }
    this.publish()
    if (refresh && this.timer !== undefined) void this.refreshSources().catch(() => {})
  }
  /** Explicit Host/account revocation, never an ordinary network loss or page close. */
  revokeStorage(): void {
    this.storageRevoked = true
    this.setReadingStorage(undefined, false)
  }
  private removeReadingSource(id: string): void {
    this.histories.get(id as SessionId)?.revokeCachedReading()
    this.readingViews.releaseSession(id)
    const record = this.records.get(id as SessionId)
    if (record) { this.records.delete(id as SessionId); record.session.dispose(); void record.scope.fiber.dispose() }
    this.histories.get(id as SessionId)?.dispose(); this.histories.delete(id as SessionId)
    this.readingCache?.remove(id); this.metadata.delete(id); this.historyMetadataRevisions.delete(id); this.retainObservers.delete(id as SessionId)
  }
  /** Called only for an explicit source removal/revocation, never a partial directory omission. */
  revokeReadingSource(id: string): void {
    if (!isSourceSessionId(id)) throw new Error('Only a native HHPI source reading cache can be revoked.')
    this.revokedReadingSources.add(id)
    this.outbox.revokeSession(id); this.removeReadingSource(id); this.publish()
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
    if (this.storageRevoked || this.lifetime.signal.aborted) return
    if (this.refreshRead) return this.refreshRead
    // Catalog metadata has no source version. A response may only replace a
    // source whose accepted history state has not advanced since this request.
    // Native updatedAt cannot order ownership/capability changes in one second.
    const startedAt = this.historyMetadataRevision
    const generation = this.storageGeneration, abort = new AbortController()
    this.refreshAbort = abort
    const signal = AbortSignal.any([this.lifetime.signal, abort.signal])
    const work = (async () => {
      const catalog = result(await this.api.catalog(signal))
      signal.throwIfAborted()
      if (generation !== this.storageGeneration) return
      if (catalog.storageScope && catalog.storageScope !== this.readingStorage?.scope) {
        // This response is already authenticated. Adopt its identity once and
        // apply the same catalog after retiring every old-scope reader/request.
        const access = this.readingStorage ? { ...this.readingStorage, scope: catalog.storageScope } : browserSourceStorage(catalog.storageScope)
        this.setReadingStorage(access, false)
      }
      this.catalogReceived = true
      this.legacyHapi = catalog.legacyHapi
      this.catalogChecked = true
      const active = new Set(catalog.sessions.map(session => session.id))
      const unchanged = (id: string): boolean => (this.historyMetadataRevisions.get(id) ?? 0) <= startedAt
      for (const [id, old] of this.metadata) if (!active.has(id) && unchanged(id)) {
        // A source may return its prior successful directory while discovery
        // runs. Neither omission nor an old `online` flag authorizes deletion.
        const offline = sourceOffline(old)
        this.metadata.set(id, offline); this.records.get(id as SessionId)?.session.update(offline)
      }
      for (const session of catalog.sessions) if (!this.revokedReadingSources.has(session.id) && unchanged(session.id)) {
        this.metadata.set(session.id, session); this.records.get(session.id as SessionId)?.session.update(session)
      }
      if (catalog.storageScope && catalog.storageScope === this.readingStorage?.scope) {
        this.outbox.acceptCatalog([...this.metadata.values()].filter(session => !this.revokedReadingSources.has(session.id)))
      }
      this.publish()
      this.capabilityState.set({ catalogReady: true, legacyHapi: catalog.legacyHapi })
    })().finally(() => {
      if (this.refreshRead === work) this.refreshRead = undefined
      if (this.refreshAbort === abort) this.refreshAbort = undefined
    })
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
        }, undefined, this.readingCache)
        this.histories.set(target, history)
        history.subscribeEntries(entries => { this.outbox.observe(target, entries) })
        // Subscribe once per shared history, not per Pane/Session face. Cached
        // metadata replay on a later retain is not a new native observation.
        // History disposal clears this subscription with its accepted cache.
        const observedHistory = history
        history.subscribeSession(session => {
          if (this.lifetime.signal.aborted || observedHistory.metadataFromCache) return
          const changed = JSON.stringify(this.metadata.get(target)) !== JSON.stringify(session)
          this.metadata.set(target, session)
          this.historyMetadataRevisions.set(target, ++this.historyMetadataRevision)
          this.records.get(target)?.session.update(session)
          this.outbox.updateSession(session)
          // Body-only changes often repeat metadata; avoid rebuilding the
          // complete sidebar catalog for every accepted output chunk.
          if (changed) this.publish()
        })
      }
      const scope = createScope(this.ctx, target)
      const session = new RemoteSourceSession(target, metadata, history, this.api, this.outbox)
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
      if (this.records.get(target) === held) this.publishRetains(target, held)
      if (held.counts.size === 0 && this.records.get(target) === held) {
        this.records.delete(target); held.session.dispose(); void held.scope.fiber.dispose()
        // A durable checkpoint replaces an unbounded set of inactive in-memory
        // transcript owners. The next retain rebuilds from that accepted body.
        if (this.readingCache) { this.histories.get(target)?.dispose(); this.histories.delete(target) }
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
    this.readingCache?.dispose(); this.stopReadingMemory?.(); this.outbox.dispose()
    this.records.clear(); this.histories.clear(); this.metadata.clear(); this.historyMetadataRevisions.clear(); this.revokedReadingSources.clear()
  }
}
