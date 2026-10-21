/** Official terminal namespace with a public isolated delegate for ordinary DSH execution. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TerminalController, type Config } from '@deepseek-ai/dsh-api-terminal-controller'
import type { TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalInput, TerminalRetentionFrame, TerminalShell, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { NativeMachineTerminals, type MachineTerminalConnector } from './machine-terminals.ts'
import type {} from '../index.ts'
import { officialProviderConfig, officialProviderContext } from '../shared/official-provider.ts'
import { isLegacyTerminalId } from '../legacy-terminal-types.ts'

/**
 * The official wire is asynchronous already. This provider composes, rather
 * than overrides, the original synchronous Host class so source inventory can
 * be read from its actual machine. Its ordinary delegate remains unmodified.
 */
export class NativeAwareTerminalController extends TypertRemoteService {
  static inject = ['loader', 'hapi']
  static Config = TerminalController.Config
  private nativeState: { config: unknown; value: NativeMachineTerminals } | undefined
  private readonly lifetime = new AbortController()

  constructor(private readonly owner: Context, _config: Config, private readonly internals: { connect?: MachineTerminalConnector } = {}) {
    super(owner, 'terminalController', { namespace: 'terminal' })
    // Public Cordis isolation prevents a duplicate root service. Resolve the
    // delegate anew from each call Context so Remote Invocation is preserved.
    owner.effect(() => () => { this.lifetime.abort(); this.nativeState?.value.dispose() }, 'hapi-dsh: native terminal viewers')
  }

  private get ordinary(): TerminalController {
    const original = officialProviderContext(this.ctx, 'terminal-controller').get('terminalController')
    if (!original) throw new Error('The official TerminalController delegate is not active')
    return original
  }
  private get native(): NativeMachineTerminals {
    const config = officialProviderConfig(this.ctx, 'terminal-controller')
    if (this.nativeState?.config !== config) {
      this.nativeState?.value.dispose()
      const value = new NativeMachineTerminals(() => this.owner.hapi.nativeTerminalAuthentication(), this.owner.hapi.nativeWorkbench,
        TerminalController.Config(config as Config), { stateFile: this.owner.hapi.nativeTerminalStateFile,
          ...(this.internals.connect === undefined ? {} : { connect: this.internals.connect }) })
      this.nativeState = { config, value }
    }
    return this.nativeState!.value
  }

  @Remote
  async environment(agent: Agent, signal: AbortSignal): Promise<TerminalEnvironment> {
    const source = this.ctx.hapi.workbenchSource(agent.id)
    return source === undefined ? this.ordinary.environment(agent, signal) : this.native.environment(source, signal)
  }

  @Remote
  async shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]> {
    const source = this.ctx.hapi.workbenchSource(agent.id)
    return source === undefined ? this.ordinary.shells(agent, signal) : this.native.shells(source, signal)
  }

  @Remote
  async list(sessionId: SessionId): Promise<WebTerminalInfo[]> {
    const source = this.ctx.hapi.workbenchSource(sessionId)
    return source === undefined ? this.ordinary.list(sessionId) : this.native.list(source, this.lifetime.signal)
  }

  @Remote
  async create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> {
    if (isLegacyTerminalId(request.id)) throw new RemoteError('terminal/unavailable', 'Original SessionTerminal identities must be opened through their saved source resource.', {})
    const source = this.ctx.hapi.workbenchSource(agent.id)
    return source === undefined ? this.ordinary.create(agent, request, signal) : this.native.create(source, request, signal)
  }

  @Remote({ mode: 'stream' })
  retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    const source = this.ctx.hapi.workbenchSource(sessionId)
    if (isLegacyTerminalId(id)) {
      if (!source) throw new RemoteError('terminal/unavailable', 'The original SessionTerminal source is unavailable.', {})
      return this.ctx.hapi.legacyTerminals.retain(sessionId, source, id, signal)
    }
    return source === undefined ? this.ordinary.retain(sessionId, id, signal) : this.native.retain(source, id, signal)
  }

  @Remote({ mode: 'stream' })
  attach(agent: Agent, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput> {
    const source = this.ctx.hapi.workbenchSource(agent.id)
    if (isLegacyTerminalId(id)) {
      if (!source) throw new RemoteError('terminal/unavailable', 'The original SessionTerminal source is unavailable.', {})
      const invocation = this.ctx.invocation
      if (!invocation) throw new Error('Terminal attachment requires a Remote invocation')
      return this.ctx.hapi.legacyTerminals.attach(agent.id, source, id, invocation.uplink<TerminalInput>(), signal, invocation.uplinkWindow)
    }
    if (source === undefined) return this.ordinary.attach(agent, id, signal)
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Terminal attachment requires a Remote invocation')
    return this.native.attach(source, id, invocation.uplink<TerminalInput>(), signal, invocation.uplinkWindow)
  }

  @Remote
  async rename(agent: Agent, id: WebTerminalId, title: string): Promise<void> {
    const source = this.ctx.hapi.workbenchSource(agent.id)
    if (isLegacyTerminalId(id)) {
      if (!source) throw new RemoteError('terminal/unavailable', 'The original SessionTerminal source is unavailable.', {})
      return this.ctx.hapi.legacyTerminals.rename(agent.id, source, id, title)
    }
    if (source === undefined) return this.ordinary.rename(agent, id, title)
    await this.native.rename(source, id, title, this.lifetime.signal)
  }

  @Remote
  async close(agent: Agent, id: WebTerminalId): Promise<void> {
    const source = this.ctx.hapi.workbenchSource(agent.id)
    if (isLegacyTerminalId(id)) {
      if (!source) throw new RemoteError('terminal/unavailable', 'The original SessionTerminal source is unavailable.', {})
      this.ctx.hapi.legacyTerminals.close(agent.id, source, id)
    }
    if (source === undefined) return this.ordinary.close(agent, id)
    await this.native.closeTerminal(source, id, this.lifetime.signal)
  }
}

export default NativeAwareTerminalController
