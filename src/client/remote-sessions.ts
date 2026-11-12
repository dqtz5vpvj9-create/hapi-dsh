/** Public Session faces for native HHPI sources. These faces never create a DSH Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { confirmedNativeArchive } from './remote-operation-contracts.ts'
import type { AgentScopeHandle, BeginSubmissionInput, Budget, HistoryFeedV1, ISessions, PendingSubmissionRetirement, ProjectionsFace, SessionBinding, SessionFace, SessionListState, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionSnapshot, SessionTarget, SubmissionHandle } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { sourceSessionId, isSourceSessionId, type SourceOperation, type SourceReceipt, type SourceSession } from '../remote/protocol.ts'
import { isSourceDisplayId } from '../shared/source-display-id.ts'
import { operationRefusal, sourceControlOperationId } from '../shared/source-operation-policy.ts'
import { sourceIsOffline, sourceOffline } from '../shared/source-connectivity.ts'
import { SOURCE_INPUT_IMAGE_LIMITS } from '../shared/source-image-limits.ts'
import { prepareSourceImages } from './source-image-preparation.ts'
import { RemoteSessionState } from './remote-session-state.ts'
import { RemoteSourceHistory, type RemoteReadingIntent } from './remote-history.ts'
import { followSourceChanges } from './remote-follow.ts'
import { RemotePaneViews } from './remote-reading-session.ts'
import { decodeSourceAttachmentValue } from '../source-attachment-types.ts'
import { SourceReadingCache, type SourceReadingStorage } from './remote-reading-cache.ts'
import { installRemoteReadingMemory, registerSourceReadingCheckpoint } from './remote-reading-memory.ts'
import type { WorkspaceUpdatePreparations } from './update-preparation.ts'
import type { MountedChatControlV1 } from './mounted-chat-control.ts'
import { browserSourceStorage } from './remote-storage.ts'
import { RemoteCreationController } from './remote-creation.ts'
import type { OperationTransactions } from './remote-operation-ledger.ts'
import { RemoteOutbox, type SourceDeliveryStore } from './remote-outbox.ts'
import { SourceDirectories, type SourceDirectory } from './source-capabilities.ts'
import { NativeActionOwner } from './remote-native-actions.ts'
import type { SourceWorkspaceApi } from '../workspace/source-api.ts'
import { NativeSubmissionPending, submitRemoteStructuredInput, supportsCodexReference } from './remote-structured-input.ts'
import { RemoteNativeQueue, type SourceQueueSnapshot } from './remote-native-queue.ts'
import { sourceQuestion, sourceQuestionCallId } from '../shared/native-async-questions.ts'
import type { AskUserQuestionAnswer, UserQuestionProjectionView } from '@deepseek-ai/dsh-user-questions/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

declare module '@deepseek-ai/cordis' { interface Context { hhpiSessions: RemoteSessions } }
declare module '@deepseek-ai/dsh-session-projection/types' { interface SessionProjectionMap { hhpiArchived: boolean; hhpiSource: SourceSession; hhpiDiscovery: 'advertised' | 'last-known'; hhpiPreparingImages: boolean } }
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
  readonly eventSource = new MutableSessionEventSource()
  readonly metadata: Value<SourceSession>
  readonly historyRead: { readonly version: 1; openView(viewId: string, budget?: Budget, signal?: AbortSignal, cacheId?: string, intent?: RemoteReadingIntent): Promise<HistoryFeedV1> }
  readonly projections: ProjectionsFace
  readonly deliveries: SourceDeliveryStore
  readonly controlStatus = new Value<string | null>(null)
  private readonly state: Value<SessionSnapshot>
  private readonly projectionValues = new Map<string, Value<unknown>>()
  private readonly submissions = new Map<string, BeginSubmissionInput>()
  private readonly structuredSubmissionObservers = new Map<string, () => void>()
  private readonly submissionReaders = new Map<string, (nativeId: string) => boolean>()
  private readonly observedSubmissions = new Map<string, { nativeId: string; attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[]; position?: SourceReceipt['observed'] }>()
  private readonly nativeSubmissions = new Set<string>()
  /** Several local Send attempts can refer to one immutable native operation. */
  private readonly nativeSubmissionIds = new Map<string, string>()
  private readonly operations = new Map<string, TrackedOperation>()
  private readonly stopMetadata: () => void
  private readonly stopDeliveries: () => void
  private readonly stopRetirements: () => void
  private durableIds = new Set<string>()
  private readonly durableSubmissions = new Set<string>()
  private readonly retiredDeliveries = new Set<string>()
  private readonly deliveryReaders = new Set<(nativeId: string, position?: SourceReceipt['observed']) => boolean>()
  private readonly restoredDeliveries = new Set<string>()
  private readonly checkedRestoredDeliveries = new Set<string>()
  private nativeQueue: RemoteNativeQueue | undefined
  private stopQueueHistory: (() => void) | undefined
  private readonly lifetime = new AbortController()
  private disposed = false
  readonly ready: Promise<void>

  constructor(readonly sessionId: SessionId, metadata: SourceSession, readonly history: RemoteSourceHistory, private readonly api: HhpiRemoteApi, private readonly outbox?: RemoteOutbox, private readonly directories?: SourceDirectories, readonly nativeActions?: NativeActionOwner, private readonly sourceUploads?: Pick<SourceWorkspaceApi, 'uploadInputs'>) {
    this.metadata = new Value(metadata)
    this.state = new Value<SessionSnapshot>({ sessionId, pendingSubmissions: [], running: metadata.status === 'running' || metadata.status === 'waiting', subagent: null,
      removed: false, openState: 'loading', openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false,
      lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false })
    this.projectionValues.set('hhpiPreparingImages', new Value(false))
    this.projections = { faceOf: key => {
      let value = this.projectionValues.get(key)
      if (!value) { value = new Value<unknown>(undefined); this.projectionValues.set(key, value) }
      return value
    } }
    this.historyRead = { version: 1, openView: (viewId, budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }, signal, cacheId, intent) => {
      if (this.disposed) return Promise.reject(new DOMException('The source view was released.', 'AbortError'))
      return history.openView(viewId, budget, signal, cacheId, intent)
    } }
    this.stopMetadata = history.subscribeSession(session => { if (!history.metadataFromCache && this.metadata.getSnapshot() !== session) this.update(session) })
    this.deliveries = outbox?.view(sessionId) ?? new Value([])
    this.stopDeliveries = this.deliveries.subscribe(() => { this.syncDeliveries() })
    this.stopRetirements = outbox?.onRetire((id, observed) => {
      // Admission and arriving history do not replace the submitting reader's
      // committed body. Its existing exact-message observer owns that handoff.
      if (observed && this.durableSubmissions.has(id) && this.submissions.has(id)) return
      this.retire(id, observed ? { reason: 'observed', attachments: [] } : { reason: 'failed' })
    }) ?? (() => {})
    this.syncDeliveries()
    this.update(metadata)
    if (metadata.codex && nativeActions && directories) {
      this.nativeQueue = new RemoteNativeQueue(this, api, snapshot => this.publishNativeQueue(snapshot))
      this.stopQueueHistory = history.subscribeEntries(entries => { this.nativeQueue?.observe(entries) })
      void this.nativeQueue.refresh()
    }
    this.ready = history.prepare(this.lifetime.signal).then(page => {
      if (this.disposed) throw new DOMException('The source view was released.', 'AbortError')
      this.state.set({ ...this.state.getSnapshot(), openState: 'open', hasMore: page.hasBefore,
        blank: !page.entries.some(entry => ['user/message', 'assistant/message', 'tool/call'].includes(entry.event.type)) })
      this.checkRestoredDeliveries()
    }).catch(error => {
      if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), openState: 'error', openError: sourceError(error instanceof Error ? error.message : 'Source history is unavailable.') })
      throw error
    })
    void this.ready.catch(() => {})
  }
  readonly getSnapshot = (): SessionSnapshot => this.state.getSnapshot()
  readonly subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)
  private publishNativeQueue(snapshot: SourceQueueSnapshot): void {
    if (this.disposed) return
    for (const [key, value] of [['queueActions', snapshot.actions], ['inbox', snapshot.inbox]] as const) {
      const store = this.projectionValues.get(key)
      if (!store) this.projectionValues.set(key, new Value<unknown>(value))
      else if (JSON.stringify(store.getSnapshot()) !== JSON.stringify(value)) store.set(value)
    }
  }
  sourceDirectory(): SourceDirectory | undefined {
    if (this.disposed) throw sourceError('The source view was released.')
    return this.directories?.forSession(this.metadata.getSnapshot())
  }
  private syncDeliveries(): void {
    if (this.disposed) return
    const all = this.deliveries.getSnapshot()
    for (const id of this.retiredDeliveries) if (!all.some(entry => entry.operation.operationId === id)) this.retiredDeliveries.delete(id)
    const deliveries = all.filter(entry => !this.retiredDeliveries.has(entry.operation.operationId) && ['send', 'steer'].includes(entry.operation.kind)), prior = this.durableIds
    this.durableIds = new Set(deliveries.map(entry => entry.operation.operationId))
    const state = this.state.getSnapshot()
    const nativeQueue = !!this.metadata.getSnapshot().codex && !!this.nativeActions && !!this.directories
    for (const entry of deliveries) {
      const id = entry.operation.operationId
      this.durableSubmissions.add(id)
      if (!this.submissions.has(id)) {
        if (entry.attempts > 0) this.restoredDeliveries.add(id)
        this.submissions.set(id, { mode: entry.operation.kind === 'steer' ? 'steer' : 'queue', text: entry.operation.text ?? '',
          attachments: state.pendingSubmissions.find(item => item.requestId === id)?.attachments
            ?? entry.operation.images?.map(image => ({ type: 'image' as const, value: { previewUrl: `data:${image.mediaType};base64,${image.data}` } })) ?? [] })
      }
      if (this.restoredDeliveries.has(id) && entry.receipt?.status === 'accepted' && entry.receipt.observed)
        this.observedSubmissions.set(id, { nativeId: id, attachments: this.observedSubmissions.get(id)?.attachments ?? [], position: entry.receipt.observed })
    }
    this.state.set({ ...state, pendingSubmissions: [...state.pendingSubmissions.filter(entry => !this.durableIds.has(entry.requestId)
      && (!prior.has(entry.requestId) || this.submissions.has(entry.requestId))),
      ...deliveries.map(entry => ({ requestId: entry.operation.operationId as SessionRequestId,
        placement: entry.operation.kind === 'steer' ? 'steering' as const : nativeQueue ? 'queued' as const : 'transcript' as const,
        time: entry.createdAt, text: entry.operation.text ?? '', attachments: this.submissions.get(entry.operation.operationId)!.attachments }))] })
    for (const entry of deliveries) this.watchStructuredSubmission(entry.operation.operationId, entry.operation.operationId)
    this.reconcilePublishedSubmissions()
    if (this.state.getSnapshot().openState === 'open') this.checkRestoredDeliveries()
    this.nativeQueue?.pendingChanged()
  }
  private checkRestoredDeliveries(refresh = false): void {
    if (refresh) this.checkedRestoredDeliveries.clear()
    for (const id of this.restoredDeliveries) if (!this.checkedRestoredDeliveries.has(id) && this.outbox?.get(id)?.state === 'owner-accepted'
      && !this.outbox.get(id)?.receipt?.observed) {
      this.checkedRestoredDeliveries.add(id)
      void this.outbox.checkOwnerAdmission(id)
    }
  }
  /** Restored deliveries use exact body acknowledgement or confirmed official window bounds. */
  registerDeliveryReader(reader: (nativeId: string, position?: SourceReceipt['observed']) => boolean): () => void {
    this.deliveryReaders.add(reader)
    return () => { this.deliveryReaders.delete(reader) }
  }
  retrySubmission(operationId: string): void {
    const saved = this.outbox?.get(operationId)
    if (!saved || saved.operation.sessionId !== this.sessionId) return
    try {
      this.controlStatus.set(null)
      if (saved.attempts === 0) this.assertOperationCurrent(saved.operation)
      this.outbox?.retry(operationId)
    } catch (cause) { this.controlStatus.set(cause instanceof Error ? cause.message : 'The original request cannot be resumed.') }
  }
  discardSubmission(operationId: string): void { this.outbox?.discard(operationId) }
  ownsSavedSubmission(operationId: string | undefined, mode: Parameters<SessionFace['prompt']>[1] = 'queue'): boolean {
    const saved = operationId === undefined ? undefined : this.outbox?.get(operationId)
    return saved?.operation.sessionId === this.sessionId && saved.operation.kind === (mode === 'steer' ? 'steer' : 'send')
  }
  update(session: SourceSession): void {
    if (this.disposed) return
    if (session.id !== this.sessionId) throw new Error('Source metadata crossed session identities')
    // Page and stream replies can repeat the same metadata as fresh objects.
    // Keep external-store snapshots stable so body updates do not invalidate
    // every source-aware tool and the official conversation layout.
    const previous = this.metadata.getSnapshot()
    if (previous !== session && JSON.stringify(previous) === JSON.stringify(session)) session = previous
    if (previous !== session) this.metadata.set(session)
    if (previous.status !== session.status || previous.updatedAt !== session.updatedAt || JSON.stringify(previous.connection) !== JSON.stringify(session.connection))
      void this.nativeQueue?.refresh()
    const state = this.state.getSnapshot()
    const running = session.status === 'offline' ? state.running : session.status === 'running' || session.status === 'waiting'
    if (running !== state.running) this.state.set({ ...state, running })
    for (const [key, value] of [['title', session.title], ['hhpiSource', session],
      ['imageLimits', session.capabilities.images ? SOURCE_INPUT_IMAGE_LIMITS : undefined]] as const) {
      let store = this.projectionValues.get(key)
      if (!store) { store = new Value<unknown>(value); this.projectionValues.set(key, store) } else if (store.getSnapshot() !== value) store.set(value)
    }
    // Reconnection/catalog refresh may supply proof that the first lookup
    // could not read. Reuse that event; no polling or input replay is added.
    if (this.state.getSnapshot().openState === 'open' && !sourceIsOffline(session)) this.checkRestoredDeliveries(true)
    const questions: UserQuestionProjectionView = { active: session.pendingRequests.flatMap(request => {
      const question = sourceQuestion(request)
      return question ? [{ callId: sourceQuestionCallId(request) as ToolCallId, questions: [question], state: 'continued' as const }] : []
    }), settled: [] }
    const projected = this.projections.faceOf('userQuestions')
    if (JSON.stringify(projected.getSnapshot()) !== JSON.stringify(questions)) this.projectionValues.get('userQuestions')!.set(questions)
  }
  /** Official question composer channel; the source owns validation, dispatch and settlement. */
  async answerQuestion(callId: string, answer: AskUserQuestionAnswer): Promise<boolean> {
    const request = this.metadata.getSnapshot().pendingRequests.find(row => sourceQuestionCallId(row) === callId && sourceQuestion(row))
    if (!request) return false
    const operationId = await sourceControlOperationId(this.sessionId, 'approve', sourceQuestionCallId(request))
    if (!this.metadata.getSnapshot().pendingRequests.some(row => sourceQuestionCallId(row) === callId)) return false
    const receipt = await this.operate({ sessionId: this.sessionId, operationId, kind: 'approve', requestId: request.id,
      response: { answers: answer.answers, nativeQuestionRevision: request.params.revision } })
    if (receipt.status !== 'accepted') throw new Error(receipt.message)
    return true
  }
  readonly promptReferences = { accepts: (source: string): boolean => !!this.metadata.getSnapshot().codex && !!this.nativeActions && !!this.directories && supportsCodexReference(source) }
  private nativeComposerAvailable(): boolean {
    const metadata = this.metadata.getSnapshot()
    return !!metadata.codex && !!this.nativeActions && !!this.directories && !sourceIsOffline(metadata)
  }
  beginSubmission(input: BeginSubmissionInput, bodyPublished?: (nativeId: string) => boolean): SubmissionHandle {
    if (this.disposed) throw sourceError('The source view was released.')
    if (input.attachments.some(attachment => attachment.type === 'file' ? !this.metadata.getSnapshot().capabilities.files : !this.metadata.getSnapshot().capabilities.images)) throw sourceError('This source cannot accept these attachments. Your files and draft have been kept.')
    const requestId = crypto.randomUUID() as SessionRequestId
    if (bodyPublished) this.submissionReaders.set(requestId, bodyPublished)
    // Choose the carrier before accepting the draft. An online Codex message
    // shares structured input's native queue and durable composer intent.
    // Offline text keeps its existing outbox admission and original identity.
    const native = this.nativeComposerAvailable() || input.content?.some(part => part.type === 'reference')
    if (native) this.nativeSubmissions.add(requestId)
    if (this.outbox && !native && !input.attachments.length) {
      const metadata = this.metadata.getSnapshot()
      const kind = input.mode === 'steer' ? 'steer' : 'send'
      const operation: SourceOperation = { sessionId: this.sessionId, operationId: requestId, kind, text: input.text,
        ...(kind === 'steer' && metadata.activeTurnId ? { turnId: metadata.activeTurnId } : {}) }
      if (kind !== 'send') this.assertOperationCurrent(operation)
      else if (!sourceIsOffline(metadata) && !metadata.capabilities.send) throw sourceError('The source does not support send.')
      this.outbox.enqueue(operation)
      this.submissions.set(requestId, input)
      this.acceptSubmission(requestId)
      return { requestId, abandon: () => { this.outbox?.abandon(requestId) } }
    }
    this.submissions.set(requestId, input)
    this.state.set({ ...this.state.getSnapshot(), pendingSubmissions: [...this.state.getSnapshot().pendingSubmissions,
      { requestId, placement: input.mode === 'steer' ? 'steering' : native ? 'queued' : 'transcript', time: Date.now(), text: input.text, attachments: input.attachments }] })
    this.nativeQueue?.pendingChanged()
    return { requestId, abandon: () => { this.retire(requestId, { reason: 'failed' }) } }
  }
  private acceptSubmission(id: string): void {
    const pending = this.submissions.get(id)
    if (!pending?.onAccept) return
    const { onAccept, ...accepted } = pending
    this.submissions.set(id, accepted)
    onAccept()
  }
  private associateNativeSubmission(requestId: string, nativeId: string): void {
    if (!this.submissions.has(requestId)) return
    // Keep settled aliases only while their original composer operation is
    // current, so rechecking the same handle cannot open a second carrier.
    for (const [id, original] of this.nativeSubmissionIds) if (!this.submissions.has(id) && original !== nativeId) this.nativeSubmissionIds.delete(id)
    this.nativeSubmissionIds.set(requestId, nativeId)
    const state = this.state.getSnapshot(), aliases = new Set(this.nativeSubmissionAliases(nativeId))
    const occurrence = state.pendingSubmissions.find(item => aliases.has(item.requestId) || item.requestId === nativeId)
    if (!occurrence) return
    this.state.set({ ...state, pendingSubmissions: [...state.pendingSubmissions.filter(item => !aliases.has(item.requestId) && item.requestId !== nativeId),
      { ...occurrence, requestId: nativeId as SessionRequestId }] })
  }
  private nativeSubmissionAliases(nativeId: string): string[] {
    return [...this.submissions.keys()].filter(id => (this.nativeSubmissionIds.get(id) ?? id) === nativeId)
  }
  private acceptNativeSubmission(nativeId: string): void { for (const id of this.nativeSubmissionAliases(nativeId)) this.acceptSubmission(id) }
  private retire(id: string, retirement: PendingSubmissionRetirement): void {
    const pending = this.submissions.get(id)
    if (!pending) return
    const nativeId = this.nativeSubmissionIds.get(id) ?? id
    const durable = this.durableSubmissions.delete(id)
    if (durable && retirement.reason === 'observed') this.retiredDeliveries.add(id)
    this.submissions.delete(id)
    this.nativeSubmissions.delete(id)
    this.submissionReaders.delete(id); this.observedSubmissions.delete(id)
    this.structuredSubmissionObservers.get(id)?.(); this.structuredSubmissionObservers.delete(id)
    const stillOwned = this.nativeSubmissionAliases(nativeId).length > 0
    this.state.set({ ...this.state.getSnapshot(), pendingSubmissions: this.state.getSnapshot().pendingSubmissions.filter(value =>
      value.requestId === nativeId ? stillOwned : value.requestId !== id) })
    pending.onRetire?.(retirement)
    this.restoredDeliveries.delete(id); this.checkedRestoredDeliveries.delete(id)
    if (durable && retirement.reason === 'observed') this.outbox?.settleOwnerAdmission(id)
  }
  /** An explicit source-confirmed removal retires only that original queued occurrence. */
  retireQueuedSubmission(nativeId: string): void {
    for (const id of this.nativeSubmissionAliases(nativeId)) this.retire(id, { reason: 'observed', attachments: [] })
  }
  /** A source-confirmed text edit updates the handoff fallback, never creates a new submission. */
  updateQueuedSubmissionText(requestId: string, text: string): void {
    const state = this.state.getSnapshot()
    if (state.pendingSubmissions.some(item => item.requestId === requestId && item.text !== text)) this.state.set({ ...state,
      pendingSubmissions: state.pendingSubmissions.map(item => item.requestId === requestId ? { ...item, text } : item) })
  }
  /** The submitting Pane retires its handoff only after its official body window publishes the exact message. */
  reconcilePublishedSubmissions(): void {
    for (const observed of this.observedSubmissions.values()) {
      const aliases = this.nativeSubmissionAliases(observed.nativeId)
      if (aliases.every(id => {
        const reader = this.submissionReaders.get(id)
        return reader ? reader(observed.nativeId) : !this.durableSubmissions.has(id)
          || [...this.deliveryReaders].some(read => read(observed.nativeId, this.restoredDeliveries.has(id) ? observed.position : undefined))
      }))
        for (const id of aliases) this.retire(id, { reason: 'observed', attachments: observed.attachments })
    }
  }
  private watchStructuredSubmission(requestId: string, nativeId: string): void {
    this.associateNativeSubmission(requestId, nativeId)
    if (!this.submissions.has(requestId) || this.structuredSubmissionObservers.has(requestId)) return
    const stop = this.history.subscribeEntries(entries => {
      const observed = entries.find(entry => entry.event.type === 'user/message' && (entry.event.data as { source?: { rpcId?: string } }).source?.rpcId === nativeId)
      if (!observed || observed.event.type !== 'user/message') return
      this.acceptNativeSubmission(nativeId)
      const attachments = observed.event.data.content.flatMap(part => part.type === 'image' ? [part.attachment] : [])
      this.observedSubmissions.set(requestId, { nativeId, attachments, position: this.observedSubmissions.get(requestId)?.position })
      this.reconcilePublishedSubmissions()
    })
    if (this.submissions.has(requestId)) this.structuredSubmissionObservers.set(requestId, stop)
    else stop()
  }
  async prompt(...[content, mode, signal, suppliedId]: Parameters<SessionFace['prompt']>): ReturnType<SessionFace['prompt']> {
    const requestId = suppliedId ?? crypto.randomUUID() as SessionRequestId
    // A saved outbox ID never switches to another write carrier after reconnect.
    const saved = this.outbox?.get(requestId)
    const native = this.nativeSubmissions.has(requestId) || this.nativeSubmissionIds.has(requestId) || this.nativeActions?.get(this.sessionId, 'composer')?.request.operationId === requestId
    if (!saved && (native || this.nativeComposerAvailable() || content.some(part => part.type === 'reference'))) {
      try {
        if (this.disposed) throw sourceError('The source view was released.')
        const signalForAttempt = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
        signalForAttempt.throwIfAborted()
        if (content.some(part => part.type === 'file' && !this.metadata.getSnapshot().capabilities.files || part.type === 'image' && !this.metadata.getSnapshot().capabilities.images)) throw sourceError('This source cannot accept these attachments. Your files and draft have been kept.')
        const images = await this.prepareImages(content.flatMap(part => part.type === 'image' ? [{ mediaType: part.mediaType, data: part.data }] : []), signalForAttempt)
        let imageIndex = 0
        const normalized = content.map(part => part.type === 'image' ? { ...part, ...images[imageIndex++]! } : part)
        const nativeId = await submitRemoteStructuredInput(this, this.metadata.getSnapshot(), normalized, mode, this.nativeSubmissionIds.get(requestId) ?? requestId, async (receiptIds, uploadSignal, clientUserMessageId) => {
          if (!receiptIds.length) return []
          if (!this.sourceUploads?.uploadInputs) throw sourceError('The source upload receipt resolver is unavailable. Your files and draft have been kept.')
          return result(await this.sourceUploads.uploadInputs({ sessionId: this.sessionId, receiptIds: [...receiptIds], ...(clientUserMessageId ? { clientUserMessageId } : {}) }, uploadSignal)).input
        }, signalForAttempt)
        if (!this.disposed) {
          this.associateNativeSubmission(requestId, nativeId)
          this.acceptNativeSubmission(nativeId)
          // Queue acceptance clears the input, while the native QueueDock
          // keeps this occurrence until its exact source message takes over.
          this.watchStructuredSubmission(requestId, nativeId)
          void this.nativeQueue?.refresh()
          this.state.set({ ...this.state.getSnapshot(), promptAttempted: true, promptError: null })
        }
        return { ok: true, value: { accepted: true } }
      } catch (cause) {
        if (!this.disposed) {
          if (cause instanceof NativeSubmissionPending) this.watchStructuredSubmission(requestId, cause.clientUserMessageId)
          else this.retire(requestId, { reason: 'failed' })
        }
        const error = cause instanceof RemoteError ? cause as RemoteError<'hhpi/source'> : sourceError(cause instanceof Error ? cause.message : 'The native structured input could not be submitted.', cause instanceof NativeSubmissionPending)
        if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), promptError: { op: 'send', error } })
        return { ok: false, error }
      }
    }
    if (this.outbox) {
      try {
        if (content.some(part => part.type === 'reference')) throw sourceError('A saved submission cannot be changed after admission.')
        if (content.some(part => part.type === 'file' && !this.metadata.getSnapshot().capabilities.files || part.type === 'image' && !this.metadata.getSnapshot().capabilities.images)) {
          this.outbox.abandon(requestId)
          throw sourceError('This source cannot accept these attachments. Your files and draft have been kept.')
        }
        const text = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
        const files = content.flatMap(part => part.type === 'file' ? [part.receiptId] : [])
        const images = await this.prepareImages(content.flatMap(part => part.type === 'image' ? [{ mediaType: part.mediaType, data: part.data }] : []), signal)
        const saved = this.outbox.get(requestId)
        if (!saved) signal?.throwIfAborted()
        if (saved && (saved.operation.sessionId !== this.sessionId || saved.operation.text !== text || JSON.stringify(saved.operation.images ?? []) !== JSON.stringify(images) || JSON.stringify(saved.operation.files ?? []) !== JSON.stringify(files) || saved.operation.kind !== (mode === 'steer' ? 'steer' : 'send'))) {
          this.outbox.abandon(requestId)
          throw sourceError('A saved submission cannot be changed after admission.')
        }
        if (!saved) {
          if (this.disposed) throw sourceError('The source view was released.')
          signal?.throwIfAborted()
          const metadata = this.metadata.getSnapshot()
          if (mode !== 'steer' && !sourceIsOffline(metadata) && !metadata.capabilities.send) throw sourceError('The source does not support send.')
          const kind = mode === 'steer' ? 'steer' : 'send'
          const operation: SourceOperation = { sessionId: this.sessionId, operationId: requestId, kind, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}),
            ...(kind === 'steer' && metadata.activeTurnId ? { turnId: metadata.activeTurnId } : {}) }
          if (kind !== 'send') this.assertOperationCurrent(operation)
          await this.outbox.admit(operation)
        }
        this.acceptSubmission(requestId)
        this.outbox.start(requestId)
        if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), promptAttempted: true, promptError: null })
        return { ok: true, value: { accepted: true } }
      } catch (cause) {
        if (!this.outbox.get(requestId)) this.retire(requestId, { reason: 'failed' })
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
      if (content.some(part => part.type === 'file' && !this.metadata.getSnapshot().capabilities.files || part.type === 'image' && !this.metadata.getSnapshot().capabilities.images)) throw sourceError('This source cannot accept these attachments. File resources remain scoped to its source machine.')
      const files = content.flatMap(part => part.type === 'file' ? [part.receiptId] : [])
      const images = await this.prepareImages(content.flatMap(part => part.type === 'image' ? [{ mediaType: part.mediaType, data: part.data }] : []), signal)
      const text = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      const metadata = this.metadata.getSnapshot()
      const kind = mode === 'steer' ? 'steer' : 'send'
      if (sourceIsOffline(metadata)) throw sourceError('The source is offline. No operation was sent.')
      if (!metadata.capabilities[kind]) throw sourceError(`The source does not support ${kind}.`)
      if (kind === 'steer' && !metadata.activeTurnId) throw sourceError('There is no active native turn to steer.')
      const receipt = await this.operate({ sessionId: this.sessionId, operationId: requestId, kind, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}),
        ...(kind === 'steer' && metadata.activeTurnId ? { turnId: metadata.activeTurnId } : {}) })
      if (receipt.status !== 'accepted') throw sourceError(receipt.message, receipt.status === 'indeterminate')
      this.acceptSubmission(requestId)
      return { ok: true, value: { accepted: true } }
    } catch (cause) {
      const error = cause instanceof RemoteError ? cause as RemoteError<'hhpi/source'> : sourceError(cause instanceof Error ? cause.message : 'The source did not acknowledge this operation.', true)
      if (!(error.details as { outcome?: string } | undefined)?.outcome || (error.details as { outcome?: string }).outcome !== 'indeterminate') this.retire(requestId, { reason: 'failed' })
      if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), promptError: { op: 'send', error } })
      return { ok: false, error }
    }
  }
  private async prepareImages(images: NonNullable<SourceOperation['images']>, signal?: AbortSignal): Promise<NonNullable<SourceOperation['images']>> {
    if (!images.length) return images
    const state = this.projectionValues.get('hhpiPreparingImages')!
    state.set(true)
    try { return await prepareSourceImages(images, signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])) }
    finally { state.set(false) }
  }
  /** Share exact operation identities across Panes, including uncertain outcomes. */
  operate(operation: SourceOperation): Promise<SourceReceipt> {
    if (this.disposed) return Promise.reject(sourceError('The source view was released.'))
    if (operation.sessionId !== this.sessionId) return Promise.reject(sourceError('An operation belongs to another source session.'))
    // Structured answers may contain secret fields; do not persist them in the browser outbox.
    if (this.outbox && operation.response === undefined) {
      const saved = this.outbox.get(operation.operationId)
      if (!saved) this.assertOperationCurrent(operation)
      return this.outbox.submit(operation)
    }
    const fingerprint = JSON.stringify([operation.kind, operation.text ?? null, operation.turnId ?? null, operation.requestId ?? null, operation.decision ?? null, ...(operation.response === undefined ? [] : [operation.response]), ...(operation.images === undefined ? [] : [operation.images])])
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
        if (!prior) return { operationId: request.operationId, sessionId: request.sessionId, status: 'indeterminate' as const, message: 'No receipt is available yet. The original operation was not resent.' }
        if (prior.retryable !== true) return prior
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
    const refusal = operationRefusal(this.metadata.getSnapshot(), operation)
    if (refusal) throw sourceError(refusal)
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
      const receipt = await this.operate({ sessionId: this.sessionId, operationId: await sourceControlOperationId(this.sessionId, 'cancel', session.activeTurnId), kind: 'cancel', turnId: session.activeTurnId })
      this.controlStatus.set(receipt.status === 'accepted' ? null : 'The action did not complete.')
      if (receipt.status !== 'accepted') throw sourceError(receipt.message, receipt.status === 'indeterminate')
      return { ok: true, value: { accepted: true } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Cancellation is waiting for confirmation for the original turn.'
      this.controlStatus.set(message)
      return { ok: false, error: sourceError(message, true) }
    }
  }
  async readAttachment(...[attachment]: Parameters<SessionFace['readAttachment']>): ReturnType<SessionFace['readAttachment']> {
    if (this.disposed) return { ok: false, error: sourceError('The source view was released.') }
    try {
      const attachmentId = attachment.attachmentId
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
  async updateQueue(...[itemId, action]: Parameters<SessionFace['updateQueue']>): ReturnType<SessionFace['updateQueue']> {
    if (!this.nativeQueue) return { ok: false, error: sourceError('This engine does not expose native queue editing.') }
    try { await this.nativeQueue.update(itemId, action); return { ok: true, value: { accepted: true } } }
    catch (cause) { return { ok: false, error: sourceError(cause instanceof Error ? cause.message : 'The source queue action could not be confirmed.') } }
  }
  async rename(): ReturnType<SessionFace['rename']> { return { ok: false, error: sourceError('Use the original source name action; this engine does not allocate DSH rename events.') } }
  async command(): ReturnType<SessionFace['command']> { return { ok: false, error: sourceError('Send source commands as text through its native input.') } }
  async loadOlder(): Promise<void> { throw sourceError('History navigation requires the current Pane reader.') }
  async loadThrough(): Promise<void> { throw sourceError('History navigation requires the current Pane reader.') }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.lifetime.abort(); this.stopMetadata(); this.stopDeliveries(); this.stopRetirements()
    this.stopQueueHistory?.(); this.nativeQueue?.dispose()
    for (const id of this.submissions.keys()) if (!this.outbox?.get(id)) this.retire(id, { reason: 'failed' })
    this.submissions.clear()
    this.nativeSubmissions.clear()
    this.deliveryReaders.clear(); this.durableSubmissions.clear(); this.retiredDeliveries.clear()
    this.restoredDeliveries.clear(); this.checkedRestoredDeliveries.clear()
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
  private readonly acceptedState = new RemoteSessionState()
  private historyMetadataRevision = 0
  private readonly historyMetadataRevisions = new Map<string, number>()
  private readonly stopActions: () => void
  private readonly records = new Map<SessionId, RecordOwner>()
  private readonly readingViews = new RemotePaneViews()
  private readonly histories = new Map<SessionId, RemoteSourceHistory>()
  private readonly releaseTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly inactiveHistories = new Map<SessionId, true>()
  private readonly retainObservers = new Map<SessionId, Value<SessionRetainInfo>>()
  private readonly stopOriginal: () => void
  private readonly lifetime = new AbortController()
  private readingCache: SourceReadingCache | undefined
  private readonly readingSamples = new WeakMap<SessionBinding, number>()
  private readingStorage: SourceReadingStorage | undefined
  private storageRevoked = false
  private readonly outbox: RemoteOutbox
  private readonly directories: SourceDirectories
  readonly nativeActions: NativeActionOwner
  private readonly sourceConnections = new Map<string, boolean>()
  private stopReadingMemory: (() => void) | undefined
  private refreshRead: Promise<void> | undefined
  private refreshAbort: AbortController | undefined
  private storageGeneration = 0
  private storageLifetime = new AbortController()
  private readonly workspaceLifetimes = new Map<string, AbortController>()
  private timer: ReturnType<typeof setInterval> | undefined
  private catalogChecked = false
  private catalogReceived = false
  private advertised = new Set<string>()
  private directoryOmissions = new Set<string>()
  readonly capabilities: HhpiCatalogCapabilityStore
  private readonly capabilityState: Value<HhpiCatalogCapability>
  private readonly creations = new Map<string, RemoteCreationController>()

  constructor(private readonly ctx: Context, private readonly original: ISessions, readonly api: HhpiRemoteApi, readingStorage?: SourceReadingStorage, private readonly createOperations?: (access: SourceReadingStorage) => OperationTransactions,
    private readonly sourceUploads?: Pick<SourceWorkspaceApi, 'uploadInputs'>) {
    // This registry belongs to this exact authenticated Remote graph. Another
    // Host has another instance, even when it advertises the same source ID.
    this.directories = new SourceDirectories(api, 'bound-host', readingStorage?.scope ?? 'unresolved', this.storageGeneration)
    this.nativeActions = new NativeActionOwner({
      call: async request => {
        if (!this.api.nativeCall) throw sourceError('Native source actions are not connected.')
        return result(await this.api.nativeCall(request))
      },
      receipt: async request => {
        if (!this.api.nativeReceipt) throw sourceError('Native action receipts are not connected.', true)
        return result(await this.api.nativeReceipt(request))
      },
    }, createOperations ? { createLedger: createOperations } : {})
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
      }, createOperations)
    if (original.historySource) this.historySource = original.historySource
    if (original.windowCommit) this.windowCommit = original.windowCommit
    this.capabilityState = new Value({ catalogReady: false, legacyHapi: false })
    this.capabilities = this.capabilityState
    this.list = new Value(this.listSnapshot(original.list.getSnapshot()))
    this.stopActions = this.nativeActions.subscribe(() => this.publish())
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
    this.storageLifetime.abort(); this.storageLifetime = new AbortController()
    for (const lifetime of this.workspaceLifetimes.values()) lifetime.abort()
    this.workspaceLifetimes.clear()
    ++this.storageGeneration; this.refreshAbort?.abort(); this.refreshAbort = undefined; this.refreshRead = undefined
    for (const creation of this.creations.values()) creation.dispose()
    this.creations.clear()
    this.directories.reset(access?.scope ?? 'revoked', this.storageGeneration)
    this.sourceConnections.clear()
    for (const id of [...this.metadata.keys()]) this.removeReadingSource(id)
    this.revokedReadingSources.clear()
    if (this.readingCache) {
      this.readingCache.clear(); this.readingCache.dispose(); this.readingCache = undefined
    }
    this.readingStorage = access
    this.outbox.clear(); this.outbox.setStorage(access)
    this.nativeActions.setStorage(access)
    if (access) {
      this.readingCache = new SourceReadingCache(access)
      for (const session of this.readingCache.sessions()) this.metadata.set(session.id, sourceOffline(session))
      if (!this.stopReadingMemory) this.stopReadingMemory = installRemoteReadingMemory(this.ctx, () => this.readingCache, binding => this.ownsBinding(binding), undefined,
        binding => { this.readingSamples.set(binding, (this.readingSamples.get(binding) ?? 0) + 1) })
      if (this.metadata.size) this.catalogChecked = true
    }
    this.publish()
    if (refresh && this.timer !== undefined) void this.refreshSources().catch(() => {})
  }
  /** Register an actual mounted reader; source/cache presence alone never proves a capture. */
  installReadingCheckpoint(updates: WorkspaceUpdatePreparations, binding: SessionBinding,
    reader: () => MountedChatControlV1 | undefined): () => void {
    if (!isSourceSessionId(binding.sessionId)) return () => {}
    const cache = this.readingCache, access = this.captureWorkspaceAccess(binding.sessionId)
    if (!cache) throw sourceError('The authenticated reading cache is unavailable. The page remains open.')
    return registerSourceReadingCheckpoint(updates, binding, reader, { cache,
      current: () => {
        if (this.readingCache !== cache || access.signal.aborted || !this.ownsBinding(binding)) return false
        try { access.assertCurrent(); return true } catch { return false }
      }, samples: () => this.readingSamples.get(binding) ?? 0,
    })
  }
  /** Source tools pin the authenticated account and abort when that account or source is revoked. */
  captureWorkspaceAccess(sessionId: string): { scope: string; signal: AbortSignal; assertCurrent(): void } {
    const scope = this.readingStorage?.scope, generation = this.storageGeneration
    const assertCurrent = () => {
      this.lifetime.signal.throwIfAborted()
      if (!scope || this.storageRevoked || generation !== this.storageGeneration || this.revokedReadingSources.has(sessionId)) {
        throw sourceError('The authenticated source workspace changed. Reopen it before continuing.')
      }
      if (!isSourceSessionId(sessionId)) throw sourceError('The workspace must name an exact source session.')
    }
    assertCurrent()
    let lifetime = this.workspaceLifetimes.get(sessionId)
    if (!lifetime) { lifetime = new AbortController(); this.workspaceLifetimes.set(sessionId, lifetime) }
    return { scope: scope!, signal: AbortSignal.any([this.lifetime.signal, this.storageLifetime.signal, lifetime.signal]), assertCurrent }
  }
  /** Explicit Host/account revocation, never an ordinary network loss or page close. */
  revokeStorage(): void {
    this.storageRevoked = true
    this.setReadingStorage(undefined, false)
  }
  /** One creation intent belongs to this authenticated Host, not to a modal lifetime. */
  createController = (intent = 'new-session'): RemoteCreationController => {
    this.lifetime.signal.throwIfAborted()
    let creation = this.creations.get(intent)
    if (!creation) {
      creation = new RemoteCreationController(this.api, this.readingStorage, { intent,
        ...(this.createOperations ? { createLedger: this.createOperations } : {}) })
      this.creations.set(intent, creation)
    }
    return creation
  }
  private removeReadingSource(id: string): void {
    this.inactiveHistories.delete(id as SessionId)
    this.histories.get(id as SessionId)?.revokeCachedReading()
    this.readingViews.releaseSession(id)
    const record = this.records.get(id as SessionId)
    if (record) { this.records.delete(id as SessionId); record.session.dispose(); void record.scope.fiber.dispose() }
    this.histories.get(id as SessionId)?.dispose(); this.histories.delete(id as SessionId)
    this.readingCache?.remove(id); this.metadata.delete(id); this.acceptedState.forget(id); this.historyMetadataRevisions.delete(id); this.retainObservers.delete(id as SessionId)
  }
  /** Called only for an explicit source removal/revocation, never a partial directory omission. */
  revokeReadingSource(id: string): void {
    if (!isSourceSessionId(id)) throw new Error('Only a native HHPI source reading cache can be revoked.')
    this.revokedReadingSources.add(id)
    this.workspaceLifetimes.get(id)?.abort(); this.workspaceLifetimes.delete(id)
    void this.nativeActions.revokeSession(id).catch(error => { console.error('HHPI native action revocation failed.', error) })
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
      // A source absent from this directory may still be discovering, or may
      // be readable through session-only grants. Only an actual observation
      // changes its last accepted connection state; requests still check ACLs.
      for (const source of catalog.sources) {
        if (this.sourceConnections.has(source.id) && this.sourceConnections.get(source.id) !== source.online) this.directories.invalidate(source.id)
        this.sourceConnections.set(source.id, source.online)
      }
      this.catalogChecked = true
      const active = new Set(catalog.sessions.map(session => session.id))
      const failedSources = new Set(catalog.sources.filter(source => !source.online).map(source => source.id))
      this.advertised = active
      for (const [id, old] of this.metadata) {
        if (active.has(id)) this.directoryOmissions.delete(id)
        else if (catalog.sources.some(source => source.id === old.sourceId && source.machineId === old.machineId
          && source.engine === 'codex' && source.online)) this.directoryOmissions.add(id)
      }
      const unchanged = (id: string): boolean => (this.historyMetadataRevisions.get(id) ?? 0) <= startedAt
      for (const [id, old] of this.metadata) if (!active.has(id) && failedSources.has(old.sourceId) && unchanged(id)) {
        // A source may return its prior successful directory while discovery
        // runs. Neither omission nor an old `online` flag authorizes deletion.
        const offline = sourceOffline(old)
        this.metadata.set(id, offline); this.records.get(id as SessionId)?.session.update(offline)
      }
      for (const advertised of catalog.sessions) if (!this.revokedReadingSources.has(advertised.id) && unchanged(advertised.id)) {
        const session = this.acceptedState.hint(advertised)
        this.metadata.set(session.id, session); this.records.get(session.id as SessionId)?.session.update(session)
      }
      if (catalog.storageScope && catalog.storageScope === this.readingStorage?.scope) {
        this.outbox.acceptCatalog([...this.metadata.values()].filter(session => !this.revokedReadingSources.has(session.id)))
      }
      this.publish()
      if (!this.capabilityState.getSnapshot().catalogReady) this.capabilityState.set({ catalogReady: true, legacyHapi: false })
    })().finally(() => {
      if (this.refreshRead === work) this.refreshRead = undefined
      if (this.refreshAbort === abort) this.refreshAbort = undefined
    })
    this.refreshRead = work
    return work
  }
  /** A saved original identity can open before the full source directory is loaded. */
  async resolveSession(id: SessionId, signal: AbortSignal): Promise<void> {
    if (!isSourceSessionId(id)) return
    if (this.storageRevoked || this.revokedReadingSources.has(id)) throw sourceError('Access to this source was revoked.')
    if (this.metadata.has(id)) return
    if (!this.api.resolve) { await this.refreshSources(); return }
    const generation = this.storageGeneration
    const session = result(await this.api.resolve({ sessionId: id }, signal))
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
    if (generation !== this.storageGeneration || this.storageRevoked || this.revokedReadingSources.has(id))
      throw sourceError('The authenticated source scope changed while resolving this conversation.')
    if (session.id !== id) throw sourceError('The source resolved a different conversation.')
    this.metadata.set(id, session)
    this.historyMetadataRevisions.set(id, ++this.historyMetadataRevision)
    this.catalogChecked = true
    this.publish()
  }
  private retainWarmHistory(id: SessionId): void {
    const history = this.histories.get(id)
    if (!history) return
    history.suspend()
    if (!this.readingCache) {
      const timer = setTimeout(() => {
        this.releaseTimers.delete(id)
        if (!this.records.has(id) && this.histories.get(id) === history) { history.dispose(); this.histories.delete(id) }
      }, 300)
      timer.unref?.(); this.releaseTimers.set(id, timer); return
    }
    this.inactiveHistories.delete(id); this.inactiveHistories.set(id, true)
    let bytes = [...this.histories.values()].reduce((total, value) => total + value.retainedBytes, 0)
    for (const candidate of this.inactiveHistories.keys()) {
      if (this.inactiveHistories.size <= this.readingCache.maxSessions && bytes <= 32 * 1024 * 1024) break
      const inactive = this.histories.get(candidate)
      this.inactiveHistories.delete(candidate)
      if (this.records.has(candidate)) continue
      if (inactive) { bytes -= inactive.retainedBytes; inactive.dispose(); this.histories.delete(candidate) }
    }
  }
  private publish(): void {
    const base = this.original.list.getSnapshot()
    const previous = this.list.getSnapshot()
    const ids = [...base.ids], byId = { ...base.byId }, projectionsBySession = { ...base.projectionsBySession }
    const catalogs = new Map<string, Array<{ id: SessionId; createdAt: number; mode: 'external'; label: string }>>()
    for (const child of this.metadata.values()) {
      if (!child.codex?.parentThreadId) continue
      const parent = sourceSessionId({ ...child, nativeId: child.codex.parentThreadId })
      const entries = catalogs.get(parent) ?? []
      entries.push({ id: child.id as SessionId, createdAt: child.updatedAt, mode: 'external', label: child.title })
      catalogs.set(parent, entries)
    }
    for (const session of this.metadata.values()) {
      const id = session.id as SessionId
      const archive = confirmedNativeArchive(this.nativeActions.get(id, 'archive'))
      const retainedBy = this.retainInfo(id).getSnapshot().retainedBy
      const children = catalogs.get(session.id) ?? []
      const discovery = this.advertised.has(session.id) ? 'advertised' : 'last-known'
      const prior = previous.byId[id], values = prior?.projectionValues
      if (this.directoryMember(id, retainedBy)) ids.push(id)
      // RPC catalogs contain fresh objects even when their facts did not change.
      // Keep unrelated external-store rows stable across a poll or one source's
      // metadata update; parent lineage remains an explicit row dependency.
      if (prior && prior.retainedBy === retainedBy && values?.hhpiArchived === archive?.archived
        && values?.hhpiDiscovery === discovery && JSON.stringify(values.hhpiSource) === JSON.stringify(session)
        && JSON.stringify(values.subagentCatalog ?? []) === JSON.stringify(children)) {
        byId[id] = prior
        projectionsBySession[id] = previous.projectionsBySession[id]!
        continue
      }
      byId[id] = { id, title: session.title, displayTitle: session.title, cwd: session.cwd,
        ...(session.codex?.parentThreadId ? { parentId: sourceSessionId({ ...session, nativeId: session.codex.parentThreadId }) as SessionId, origin: 'subagent' as const } : {}), running: session.status === 'running' || session.status === 'waiting',
        retainedBy, blank: false, updatedAt: session.updatedAt, projectionValues: { ...(archive ? { hhpiArchived: archive.archived } : {}), hhpiSource: session, subagentCatalog: children, hhpiDiscovery: discovery } }
      projectionsBySession[id] = { values: byId[id]!.projectionValues!, state: 'ready', error: null }
    }
    const next = this.listSnapshot({ ...base, ids, byId, projectionsBySession })
    const sameIds = next.ids.length === previous.ids.length && next.ids.every((id, index) => id === previous.ids[index])
    if (sameIds) next.ids = previous.ids
    if (next.phase === previous.phase && sameIds && Object.keys(next.byId).length === Object.keys(previous.byId).length
      && Object.entries(next.byId).every(([id, row]) => row === previous.byId[id as SessionId])
      && Object.keys(next.projectionsBySession).length === Object.keys(previous.projectionsBySession).length
      && Object.entries(next.projectionsBySession).every(([id, projection]) => projection === previous.projectionsBySession[id as SessionId])) return
    this.list.set(next)
  }
  private listSnapshot(base: SessionListState): SessionListState {
    const ordinaryReady = base.ids.some(id => !isSourceSessionId(id) && !isSourceDisplayId(id))
    const pending = !this.catalogChecked && base.phase === 'ready' && !ordinaryReady
    const current: SessionListState = pending ? { ...base, phase: 'pending' } : base
    const hidden = new Set([...base.ids, ...Object.keys(base.byId)].filter(isSourceDisplayId) as SessionId[])
    if (hidden.size === 0) return current
    const byId = { ...base.byId }
    const projectionsBySession = { ...base.projectionsBySession }
    for (const id of hidden) { delete byId[id]; delete projectionsBySession[id] }
    return { ...current, ids: base.ids.filter(id => !hidden.has(id)), byId, projectionsBySession }
  }
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    if (typeof target !== 'string' || !isSourceSessionId(target)) return this.original.retain(target, options)
    const releaseTimer = this.releaseTimers.get(target)
    if (releaseTimer !== undefined) { clearTimeout(releaseTimer); this.releaseTimers.delete(target) }
    this.inactiveHistories.delete(target)
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
          this.acceptedState.observe(session)
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
      const session = new RemoteSourceSession(target, metadata, history, this.api, this.outbox, this.directories, this.nativeActions, this.sourceUploads)
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
        this.retainWarmHistory(target)
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
    const observer = this.retainObservers.get(id)!
    observer.set({ referenceCount: [...record.counts.values()].reduce((a, b) => a + b, 0), retainedBy: Object.fromEntries(record.counts) })
    // A lease changes this row's references, not source facts or parent lineage.
    // Read after notifying observers: a synchronous listener may retain/release
    // again, so this publication must use its latest counts and list snapshot.
    const retainedBy = observer.getSnapshot().retainedBy
    const previous = this.list.getSnapshot(), row = previous.byId[id]
    if (!row || !this.metadata.has(id)) { this.publish(); return }
    if (row.retainedBy === retainedBy) return
    const visible = this.directoryMember(id, retainedBy), present = previous.ids.includes(id)
    const ids = visible === present ? previous.ids : visible ? [...previous.ids, id] : previous.ids.filter(value => value !== id)
    this.list.set({ ...previous, ids, byId: { ...previous.byId, [id]: { ...row, retainedBy } } })
  }
  private directoryMember(id: SessionId, retainedBy: Readonly<Record<string, number>>): boolean {
    return !this.directoryOmissions.has(id) || Object.values(retainedBy).some(count => count > 0)
      || this.outbox.view(id).getSnapshot().length > 0
      || [...this.creations.values()].some(owner => owner.getSnapshot().record?.target?.id === id)
  }
  create(...args: Parameters<ISessions['create']>): ReturnType<ISessions['create']> { return this.original.create(...args) }
  subagentAddress(...args: Parameters<ISessions['subagentAddress']>): ReturnType<ISessions['subagentAddress']> { return this.original.subagentAddress(...args) }
  async refreshProjections(id: SessionId): Promise<void> { if (isSourceSessionId(id)) return this.refreshSources(); return this.original.refreshProjections(id) }
  async refresh(): Promise<void> { await Promise.all([this.original.refresh(), this.refreshSources()]) }
  search(...args: Parameters<ISessions['search']>): ReturnType<ISessions['search']> { return this.original.search(...args) }
  /** Source lifecycle actions have native receipts, not fabricated DSH event sequences. */
  readonly sourceActions = {
    rename: async (sessionId: SessionId, title: string): Promise<void> => {
      const name = title.trim()
      if (!name) throw sourceError('A conversation name cannot be empty.')
      await this.runSourceAction(sessionId, 'rename', 'thread/name/set', { name })
    },
    archive: async (sessionId: SessionId, archived: boolean): Promise<void> => {
      await this.runSourceAction(sessionId, 'archive', archived ? 'thread/archive' : 'thread/unarchive', {})
    },
  }
  private async runSourceAction(sessionId: SessionId, kind: 'rename' | 'archive', method: string, params: Record<string, unknown>): Promise<void> {
    if (!isSourceSessionId(sessionId)) throw sourceError('This action requires an exact HHPI source identity.')
    await this.resolveSession(sessionId, this.lifetime.signal)
    const source = this.metadata.get(sessionId)
    if (!source || sourceIsOffline(source) && method !== 'thread/unarchive') throw sourceError('Reconnect the original source before changing this conversation.')
    const capabilities = await this.directories.forSession(source).capabilities(this.lifetime.signal)
    if (capabilities.methods[method] !== 'write') throw sourceError('The original source does not support this action.')
    const action = await this.nativeActions.submit({ sessionId, intent: kind, kind, newAttempt: true,
      request: { sourceId: source.sourceId, method, params: { threadId: source.nativeId, ...params } } })
    if (action.phase !== 'accepted') throw sourceError(action.outcome?.message ?? 'The original action is waiting for confirmation.', action.phase !== 'rejected')
  }
  async fork(options: Parameters<ISessions['fork']>[0]): ReturnType<ISessions['fork']> {
    if (!isSourceSessionId(options.sessionId)) return this.original.fork(options)
    if (options.atSeq !== undefined) throw sourceError('Forking at this displayed event is unavailable; use the source conversation fork action.')
    await this.resolveSession(options.sessionId, this.lifetime.signal)
    const source = this.metadata.get(options.sessionId)
    if (!source || sourceIsOffline(source)) throw sourceError('Reconnect the original source before creating a branch.')
    const capability = await this.directories.forSession(source).capabilities(this.lifetime.signal)
    if (capability.methods['thread/fork'] !== 'write') throw sourceError('The original source does not support branching.')
    const action = await this.nativeActions.submit({ sessionId: source.id, intent: 'fork', kind: 'fork', newAttempt: true,
      request: { sourceId: source.sourceId, method: 'thread/fork', params: { threadId: source.nativeId, excludeTurns: true } } })
    if (action.phase !== 'accepted' || !action.outcome?.targetNativeId)
      throw sourceError(action.outcome?.message ?? 'The original branch request is waiting for confirmation. Check its result before retrying.', action.phase !== 'rejected')
    const childId = sourceSessionId({ ...source, nativeId: action.outcome.targetNativeId }) as SessionId
    // Catalog propagation is a read after the confirmed native write. A failed
    // read must not turn a created branch into a retryable creation failure.
    try { await this.resolveSession(childId, this.lifetime.signal) } catch { /* Opening the exact returned ID resolves it again. */ }
    if (!this.lifetime.signal.aborted) options.onCreated?.(childId)
    return childId
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
    for (const creation of this.creations.values()) creation.dispose()
    this.creations.clear()
    this.directories.dispose(); this.sourceConnections.clear()
    this.stopActions()
    this.nativeActions.dispose()
    this.lifetime.abort(); this.storageLifetime.abort(); this.workspaceLifetimes.clear(); if (this.timer) clearInterval(this.timer); this.stopOriginal()
    for (const record of this.records.values()) { record.session.dispose(); void record.scope.fiber.dispose() }
    for (const history of this.histories.values()) history.dispose()
    this.readingCache?.dispose(); this.stopReadingMemory?.(); this.outbox.dispose()
    for (const timer of this.releaseTimers.values()) clearTimeout(timer)
    this.releaseTimers.clear()
    this.records.clear(); this.histories.clear(); this.inactiveHistories.clear(); this.metadata.clear(); this.advertised.clear(); this.directoryOmissions.clear(); this.acceptedState.clear(); this.historyMetadataRevisions.clear(); this.revokedReadingSources.clear()
  }
}
