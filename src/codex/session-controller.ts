import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import type {
  SessionForkRequest, SessionForkValue, SessionRenameRequest, SessionRenameValue,
  SessionSelectModelRequest, SessionSelectModelValue, SessionUpdateQueueRequest, SessionUpdateQueueValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../index.ts'

/** Both current and cold display generations retain the native namespace. */
export function isNativeDisplayId(id: string): boolean {
  return /^hapi-codex-[0-9a-f]{32}(?:-r[1-9][0-9]*)?$/.test(id)
}

/**
 * Ordinary Cordis provider replacement over the public official controller.
 * The inherited Remote service, schemas, authorization and all other methods
 * remain official. Native operations that have different settlement semantics
 * use our explicit controls; no upstream instance or prototype is modified.
 */
export class NativeAwareSessionController extends SessionController {
  static override inject = [...SessionController.inject, 'hapi']

  constructor(...args: ConstructorParameters<typeof SessionController>) {
    super(...args)
    const [ctx] = args
    // Replacing the Loader row also removes discovery of the original
    // package's generated artifact. Register that exact public artifact;
    // its schemas, resource readers and service dispatch remain official.
    const contract = validateTypertManifest('@deepseek-ai/dsh-api-session-controller', TYPERT)
    if (!ctx.typert.getPackage(contract.package, 'host')) {
      ctx.effect(() => ctx.typert.register(contract), 'hapi-dsh: official Session Remote contract')
    }
  }

  override selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    if (isNativeDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'Native Codex model selection uses hapi.nativeApplySetting; the DSH model selector cannot configure the native owner.',
      { outcome: 'rejected', sourceCode: 'native_model_control_required' }))
    return super.selectModel(request)
  }

  override fork(request: SessionForkRequest): Promise<SessionForkValue> {
    if (isNativeDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'Native Codex forks use hapi.nativeFork and its durable native operation receipt.',
      { outcome: 'rejected', sourceCode: 'native_fork_control_required' }))
    return super.fork(request)
  }

  override updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (isNativeDisplayId(request.sessionId)) return Promise.reject(new RemoteError('hapi/request',
      'Native Codex queue changes use the asynchronous native controls; source confirmation owns queue retirement.',
      { outcome: 'rejected', sourceCode: 'native_queue_control_required' }))
    return super.updateQueue(request)
  }

  override rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    if (isNativeDisplayId(request.sessionId)) return this.ctx.hapi.renameNativeSession(request)
    return super.rename(request)
  }
}

export default NativeAwareSessionController
