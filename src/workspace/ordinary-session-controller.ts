import { assertOrdinarySourceTarget } from '../shared/source-access.ts'
import type { Context } from '@deepseek-ai/cordis'
import { SessionController, type Config } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionObserveEventRequest, SessionEventFrame, SessionProjectionFrame, SessionStateRequest, SessionState, SessionWaitRequest, SessionWaitValue, SessionEventsPage,
  ModelCatalog, SessionAddress, SessionAttachmentRequest, SessionAttachmentValue, SessionCancelRequest, SessionCancelValue,
  SessionControlFrame, SessionCreateRequest, SessionCreateValue, SessionFollowFrame, SessionFollowRequest,
  SessionForkRequest, SessionForkValue, SessionListRequest, SessionListValue, SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue, SessionPage, SessionPageRequest, SessionPromptRequest, SessionPromptValue,
  SessionProjectionsRequest, SessionProjectionsValue, SessionRenameRequest, SessionRenameValue,
  SessionSearchRequest, SessionSearchValue, SessionSelectModelRequest, SessionSelectModelValue,
  SessionUpdateQueueRequest, SessionUpdateQueueValue, SessionWorkspacePathApplication,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { officialProviderContext } from '../shared/official-provider.ts'
import { openingWindow, sessionListHints } from '../shared/history-window.ts'

/** Check both sides of an official child history address before local resolution. */
function assertOrdinaryAddress(address: SessionAddress): void {
  if (address.kind === 'session') assertOrdinarySourceTarget(address.sessionId)
  else {
    assertOrdinarySourceTarget(address.parentSessionId)
    assertOrdinarySourceTarget(address.childSessionId)
  }
}

/** Public delegation retains the isolated official owner and the current call Invocation. */
export class OrdinarySessionController extends TypertRemoteService {
  static inject = ['loader']
  static Config = SessionController.Config

  constructor(ctx: Context, _config: Config) { super(ctx, 'sessionController', { namespace: 'session' }) }

  // Resolve from the current call Context. Capturing the service during
  // construction would lose Remote principal/cancellation/stream Invocation.
  private get ordinary(): SessionController {
    const original = officialProviderContext(this.ctx, 'session-controller').get('sessionController')
    if (!original) throw new Error('The isolated official Session controller has not started')
    return original
  }

  resolveAgent(sessionId: SessionId): ReturnType<SessionController['resolveAgent']> { assertOrdinarySourceTarget(sessionId); return this.ordinary.resolveAgent(sessionId) }
  workspaceDesktop(): ReturnType<SessionController['workspaceDesktop']> { return this.ordinary.workspaceDesktop() }

  @Remote('list')
  async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    return sessionListHints(await this.ordinary.list(_request, signal))
  }

  @Remote('search')
  search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> { return this.ordinary.search(request, signal) }

  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.sessionId !== undefined) assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.create(request)
  }

  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    assertOrdinarySourceTarget(request.sessionId)
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
    assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.rename(request)
  }

  @Remote('fork')
  fork(request: SessionForkRequest): Promise<SessionForkValue> {
    assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.fork(request)
  }

  @Remote('prompt')
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    assertOrdinarySourceTarget(request.sessionId); return this.ordinary.prompt(request, signal) }

  @Remote('attachment')
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> { assertOrdinarySourceTarget(request.sessionId); return this.ordinary.attachment(request) }

  @Remote('updateQueue')
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.updateQueue(request)
  }

  @Remote('cancel')
  cancel(request: SessionCancelRequest): SessionCancelValue {
    assertOrdinarySourceTarget(request.sessionId); return this.ordinary.cancel(request) }

  @Remote('page')
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    assertOrdinaryAddress(request.address)
    return this.ordinary.page(request, signal)
  }

  @Remote
  events(request: SessionPageRequest, signal: AbortSignal): Promise<SessionEventsPage> {
    assertOrdinaryAddress(request.address)
    return this.ordinary.events(request, signal)
  }
  @Remote({ mode: 'stream' })
  observeEvent(request: SessionObserveEventRequest, signal: AbortSignal): AsyncIterable<SessionEventFrame> {
    assertOrdinaryAddress(request.address)
    return this.ordinary.observeEvent(request, signal)
  }
  @Remote({ mode: 'stream' })
  observeProjections(request: SessionProjectionsRequest, signal: AbortSignal): AsyncIterable<SessionProjectionFrame> {
    assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.observeProjections(request, signal)
  }
  @Remote
  state(request: SessionStateRequest, signal: AbortSignal): Promise<SessionState> {
    assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.state(request, signal)
  }
  @Remote({ mode: 'stream' })
  observeState(request: SessionStateRequest, signal: AbortSignal): AsyncIterable<SessionState> {
    assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.observeState(request, signal)
  }
  @Remote
  wait(request: SessionWaitRequest, signal: AbortSignal): Promise<SessionWaitValue> {
    assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.wait(request, signal)
  }

  @Remote({ mode: 'stream' })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    assertOrdinaryAddress(request.address)
    return this.ordinary.follow(openingWindow(request), signal)
  }

  @Remote('projections')
  projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    assertOrdinarySourceTarget(request.sessionId)
    return this.ordinary.projections(request, signal)
  }

  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> { return this.ordinary.control(signal) }
}

export default OrdinarySessionController
