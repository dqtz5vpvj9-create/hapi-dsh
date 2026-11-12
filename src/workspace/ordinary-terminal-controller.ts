/** Exact ordinary DSH delegation retains the call Context and its stream uplink. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TerminalController, type Config } from '@deepseek-ai/dsh-api-terminal-controller'
import type { TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalInput, TerminalRetentionFrame,
    TerminalShell, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { Remote, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { officialProviderContext } from '../shared/official-provider.ts'
import { assertOrdinarySourceTarget } from '../shared/source-access.ts'

export class OrdinaryTerminalController extends TypertRemoteService {
    static inject = ['loader']
    static Config = TerminalController.Config
    constructor(ctx: Context, _config: Config) { super(ctx, 'terminalController', { namespace: 'terminal' }) }
    private delegate(sessionId: string): TerminalController {
        assertOrdinarySourceTarget(sessionId)
        const service = officialProviderContext(this.ctx, 'terminal-controller').get('terminalController')
        if (!service) throw new Error('The official TerminalController delegate is not active')
        return service
    }
    @Remote
    async environment(agent: Agent, signal: AbortSignal): Promise<TerminalEnvironment> { return this.delegate(agent.id).environment(agent, signal) }
    @Remote
    shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]> { return this.delegate(agent.id).shells(agent, signal) }
    @Remote
    async list(sessionId: SessionId): Promise<WebTerminalInfo[]> { return this.delegate(sessionId).list(sessionId) }
    @Remote
    create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> { return this.delegate(agent.id).create(agent, request, signal) }
    @Remote({ mode: 'stream' })
    retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> { return this.delegate(sessionId).retain(sessionId, id, signal) }
    @Remote({ mode: 'stream' })
    attach(agent: Agent, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput> { return this.delegate(agent.id).attach(agent, id, signal) }
    @Remote
    async rename(agent: Agent, id: WebTerminalId, title: string): Promise<void> { return this.delegate(agent.id).rename(agent, id, title) }
    @Remote
    async close(agent: Agent, id: WebTerminalId): Promise<void> { return this.delegate(agent.id).close(agent, id) }
}
export default OrdinaryTerminalController
