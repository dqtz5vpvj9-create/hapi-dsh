import type { Context } from '@deepseek-ai/cordis'
import { SessionController, type Config } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ModelCatalog, SessionAddress, SessionAttachmentRequest, SessionAttachmentValue, SessionCancelRequest, SessionCancelValue,
  SessionControlFrame, SessionCreateRequest, SessionCreateValue, SessionFollowFrame, SessionFollowRequest,
  SessionForkRequest, SessionForkValue, SessionListRequest, SessionListValue, SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue, SessionPage, SessionPageRequest, SessionPromptRequest, SessionPromptValue,
  SessionProjectionsRequest, SessionProjectionsValue, SessionRenameRequest, SessionRenameValue,
  SessionSearchRequest, SessionSearchValue, SessionSelectModelRequest, SessionSelectModelValue,
  SessionUpdateQueueRequest, SessionUpdateQueueValue, SessionWorkspacePathApplication,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { officialProviderContext } from '../shared/official-provider.ts'
import { isNativeDisplayId, isObservedDisplayId, isSourceChildDisplayId } from '../shared/source-display-id.ts'
import type {} from '../index.ts'

export { isNativeDisplayId, isObservedDisplayId, isSourceChildDisplayId } from '../shared/source-display-id.ts'

/** Match the official public history-address authorization contract. */
function addressedSession(request: { readonly address: SessionAddress }): SessionId {
  return request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId
}

/**
 * The original official Loader row stays active in a public isolated service
 * scope. It owns its Client module, Typert artifact, resource registrations and
 * Session listeners exactly once. This root service delegates every ordinary
 * operation and only separates operations whose HAPI owner has different
 * settlement semantics. Nothing changes an upstream instance or prototype.
 */
export class NativeAwareSessionController extends TypertRemoteService {
  static inject = ['loader', 'hapi']
  static Config = SessionController.Config

  constructor(ctx: Context, _config: Config) { super(ctx, 'sessionController', { namespace: 'session' }) }

  // Resolve from the current call Context. Capturing the service during
  // construction would lose Remote principal/cancellation/stream Invocation.
  private get ordinary(): SessionController {
    const original = officialProviderContext(this.ctx, 'session-controller').get('sessionController')
    if (!original) throw new Error('The isolated official Session controller has not started')
    return original
  }

  resolveAgent(sessionId: SessionId): ReturnType<SessionController['resolveAgent']> { return this.ordinary.resolveAgent(sessionId) }
  inspect(sessionId: SessionId, signal?: AbortSignal): ReturnType<SessionController['inspect']> { return this.ordinary.inspect(sessionId, signal) }
  workspaceDesktop(): ReturnType<SessionController['workspaceDesktop']> { return this.ordinary.workspaceDesktop() }

  @Remote('list')
  list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> { return this.ordinary.list(_request, signal) }

  @Remote('search')
  search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> { return this.ordinary.search(request, signal) }

  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> { return this.ordinary.create(request) }

  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    if (isNativeDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'Native Codex model selection uses hapi.nativeApplySetting; the DSH model selector cannot configure the native owner.',
      { outcome: 'rejected', sourceCode: 'native_model_control_required' }))
    if (isObservedDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'This original HAPI engine uses hapi.observedApplySetting and its source model catalog.',
      { outcome: 'rejected', sourceCode: 'observed_model_control_required' }))
    return this.ordinary.selectModel(request)
  }

  @Remote
  initializeDefaultModel(): Promise<void> { return this.ordinary.initializeDefaultModel() }

  @Remote('modelCatalog')
  modelCatalog(): Promise<ModelCatalog> { return this.ordinary.modelCatalog() }

  @Remote
  canOpenWorkspacePath(): boolean { return this.ordinary.canOpenWorkspacePath() }

  @Remote('openWorkspacePath')
  openWorkspacePath(request: SessionOpenWorkspacePathRequest, signal: AbortSignal): Promise<SessionOpenWorkspacePathValue> {
    return this.ordinary.openWorkspacePath(request, signal)
  }

  @Remote('workspacePathApplications')
  workspacePathApplications(request: { readonly path: string }, signal: AbortSignal): Promise<readonly SessionWorkspacePathApplication[]> {
    return this.ordinary.workspacePathApplications(request, signal)
  }

  @Remote('rename')
  rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    if (isSourceChildDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'Source child transcripts are read-only and retain their original owner labels.',
      { outcome: 'rejected', sourceCode: 'source_child_read_only' }))
    if (isNativeDisplayId(request.sessionId)) return this.ctx.hapi.renameNativeSession(request)
    if (isObservedDisplayId(request.sessionId)) return this.ctx.hapi.renameObservedSession(request)
    return this.ordinary.rename(request)
  }

  @Remote('fork')
  fork(request: SessionForkRequest): Promise<SessionForkValue> {
    if (isNativeDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'Native Codex forks use hapi.nativeFork and its durable native operation receipt.',
      { outcome: 'rejected', sourceCode: 'native_fork_control_required' }))
    if (isObservedDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'This session can only be forked by its original HAPI engine and source history controls.',
      { outcome: 'rejected', sourceCode: 'observed_fork_control_required' }))
    return this.ordinary.fork(request)
  }

  @Remote('prompt')
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> { return this.ordinary.prompt(request, signal) }

  @Remote('attachment')
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> { return this.ordinary.attachment(request) }

  @Remote('updateQueue')
  updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (isNativeDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'Native Codex queue changes use the asynchronous native controls; source confirmation owns queue retirement.',
      { outcome: 'rejected', sourceCode: 'native_queue_control_required' }))
    if (isObservedDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'This source-owned queue uses asynchronous HAPI controls and source delivery confirmation.',
      { outcome: 'rejected', sourceCode: 'observed_queue_control_required' }))
    return this.ordinary.updateQueue(request)
  }

  @Remote('cancel')
  cancel(request: SessionCancelRequest): SessionCancelValue { return this.ordinary.cancel(request) }

  @Remote({ name: 'page', resources: { session: addressedSession } })
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> { return this.ordinary.page(request, signal) }

  @Remote({ mode: 'stream', resources: { session: addressedSession } })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> { return this.ordinary.follow(request, signal) }

  @Remote('projections')
  projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> { return this.ordinary.projections(request, signal) }

  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> { return this.ordinary.control(signal) }
}

export default NativeAwareSessionController
