/** Real installed Gateway/readers/subagent manager; Loader discovery and execution handles are fixtures. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionFollowFrame, SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { TYPERT as SESSION_TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert'
import SubagentRuntime, { type SubagentResult } from '@deepseek-ai/dsh-subagent'
import { TYPERT as SUBAGENT_TYPERT } from '@deepseek-ai/dsh-subagent/typert'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { RemoteError, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import OrdinarySessionController from '../src/workspace/ordinary-session-controller.ts'
import subagentPlugin, { OrdinarySubagentController } from '../src/workspace/ordinary-subagent-controller.ts'
import { initializeOfficialController } from './official-controller-initialization.ts'
import { officialDelegateFixture } from './official-provider-fixture.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'ordinary-controller-fixture': { kind: 'ordinary-controller-fixture' } }
}
class FixtureQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { throw new Error('Search IO is outside this contract') }
  override searchEvents(): Promise<never> { throw new Error('Search IO is outside this contract') }
}

test('ordinary Gateway/history and child lifecycle keep the official owner and reject native source targets', async () => {
  const ctx = new Context(), abort = new AbortController()
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentRegistry); await ctx.plugin(TypertRegistry)
    new FixtureQuery(ctx); new RemoteAccessService(ctx)
    new SessionTitleService(ctx, { fallbackMaxWords: 20, fallbackMaxBytes: 256, maxTitleBytes: 256 })
    ctx.provide('workingDirectory', { ensure: async () => '/workspace/fixture' } as unknown as Context['workingDirectory'])
    let resolverRegistrations = 0
    ctx.provide('fileUploads', { registerAgentResolver: () => { resolverRegistrations++; return () => {} }, retirePrompt: () => {} } as unknown as Context['fileUploads'])
    ctx.provide('llm', { listProviders: () => [], listModels: async () => [] } as unknown as Context['llm'])
    ctx.provide('agentDefaultModel', { currentSelection: () => undefined } as unknown as Context['agentDefaultModel'])
    const config = { nativeOpen: false, listWorkSliceMs: 16 }
    const sessionScope = officialDelegateFixture(ctx, 'session-controller', config)
    const officialSession = await initializeOfficialController(new SessionController(sessionScope, config))
    await ctx.plugin(OrdinarySessionController, config)
    const subagentScope = officialDelegateFixture(ctx, 'subagent', {})
    await subagentScope.plugin(SubagentRuntime)
    await ctx.plugin(subagentPlugin)
    const officialSubagents = subagentScope.get('subagents')!
    const subagents = ctx.get('subagents') as unknown as OrdinarySubagentController
    assert.ok(subagents instanceof OrdinarySubagentController)
    assert.ok(officialSubagents instanceof SubagentRuntime)
    assert.equal(OrdinarySessionController.Config, SessionController.Config)
    assert.equal(OrdinarySubagentController.Config, SubagentRuntime.Config)
    ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-session-controller', SESSION_TYPERT))
    ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-subagent', SUBAGENT_TYPERT))
    const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
    const principal: Principal = { kind: 'ordinary-controller-fixture' }
    const peer = (identity: Principal = { kind: 'owner' }): PeerScope => ({ id: 'ordinary-controller-peer' as PeerId,
      ctx, principal: identity, signal: abort.signal, interactions: 'answer', dispose: async () => {} })
    const invoke = (namespace: string, method: string, args: Record<string, unknown>, identity?: Principal) => gateway.invoke({ peer: peer(identity), namespace, method, args })
    const session = ctx.sessions.create(SessionId('ordinary-parent'), { meta: { cwd: '/workspace/fixture' } })
    // No model executes. The real registry owns this fixture parent with a real Cordis Context.
    const parent = { id: session.id, session, ctx: ctx.extend(), status: 'idle' } as Agent
    ctx.agents.enter(parent, undefined)
    const privateSession = ctx.sessions.create(SessionId('ordinary-private'), { meta: { cwd: '/workspace/fixture' } })
    ctx.agents.enter({ id: privateSession.id, session: privateSession, ctx: ctx.extend(), status: 'idle' } as Agent, undefined)
    ctx.remoteAccess.registerPolicy('ordinary-controller-fixture', { bindings: () => [
      { role: { name: 'list and child controls', resource: 'global', actions: ['session/list', 'subagents/interruptByParent'] }, resource: { kind: 'global' } },
      { role: { name: 'visible history', resource: 'session', actions: ['session/list', 'session/follow'] }, resource: { kind: 'session', id: parent.id } },
    ] })
    const listed = await invoke('session', 'list', { _request: {} }, principal) as SessionListValue
    assert.deepEqual(listed.items.map(row => row.sessionId), [parent.id], 'current non-owner Invocation reaches the isolated official list authorization')
    session.append('turn/start', { turn: 0 })
    for (let index = 0; index < 60; index++) session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Synthetic history ${index}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const stream = await gateway.stream({ peer: peer(principal), namespace: 'session', method: 'follow', args: {
      request: { address: { kind: 'session', sessionId: parent.id }, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } },
    } })
    const reader = stream[Symbol.asyncIterator](), opening = (await reader.next()).value as SessionFollowFrame
    assert.equal(opening.type, 'snapshot')
    assert.ok(opening.type === 'snapshot')
    assert.equal(opening.records.filter(row => row.type === 'event' && row.event.type === 'user/message').length, 20, 'openingWindow still bounds the official reader')
    assert.equal(opening.hasMore, true)
    await reader.return?.()
    assert.ok(officialSession instanceof SessionController)
    assert.equal(resolverRegistrations, 1, 'only the official constructor registers an Agent resolver')

    const result = Promise.withResolvers<SubagentResult>(), childId = SessionId('ordinary-managed-child')
    let starts = 0, disposals = 0
    const lifecycle: string[] = []
    ctx.on('subagent/start', () => { lifecycle.push('start') }, { global: true })
    ctx.on('subagent/end', () => { lifecycle.push('end') }, { global: true })
    const unregister = subagents.registerProvider({ name: 'fixture-execution', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      async start(request) {
        starts++; assert.equal(request.parent, parent)
        request.signal.addEventListener('abort', () => result.resolve({ output: [], stopReason: 'aborted' }), { once: true })
        return { id: childId, result: result.promise, async dispose() { disposals++ } }
      },
    })
    const activation = await subagents.startActivation({ provider: 'fixture-execution', label: 'Synthetic child',
      request: { parent, prompt: [{ type: 'text', text: 'Synthetic execution' }] }, signal: abort.signal, delivery: 'caller' })
    assert.equal(activation.childId, childId)
    const joining = subagents.waitForChildren(parent)
    await assert.rejects(invoke('subagents', 'interruptByParent', { childSessionId: childId,
      parentSessionId: privateSession.id, mode: 'continuable' }, principal), (error: unknown) => error instanceof RemoteError && error.code === 'subagent/unauthorized')
    assert.equal(disposals, 0, 'an unrelated ordinary parent cannot stop the official activation')
    assert.deepEqual(await invoke('subagents', 'interruptByParent', { childSessionId: childId,
      parentSessionId: parent.id, mode: 'continuable' }, principal), { accepted: true })
    await activation.result; await joining
    assert.equal(starts, 1); assert.equal(disposals, 1)
    assert.deepEqual(lifecycle, ['start', 'end'])
    await subagents.drainChildren(parent, [childId]); await subagents.drainDescendants([parent])
    unregister()

    const wrongSource = (error: unknown) => error instanceof RemoteError && error.code === 'hhpi/source'
    for (const id of ['hhpi:machine:source:codex:thread', 'hhpi:malformed', `hapi-codex-${'a'.repeat(32)}`, `hapi-observed-${'b'.repeat(32)}-child-${'c'.repeat(24)}`]) {
      await assert.rejects(invoke('session', 'create', { request: { sessionId: id } }), wrongSource)
      await assert.rejects(invoke('session', 'page', { request: { address: { kind: 'subagent', parentSessionId: id, childSessionId: parent.id, mode: 'unknown' }, throughSeq: session.seq } }), wrongSource)
      await assert.rejects(invoke('subagents', 'prompt', { request: { requestId: 'fixture-rpc', parentSessionId: parent.id,
        childSessionId: id, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'Do not deliver' }] } }), wrongSource)
      assert.throws(() => subagents.drainChildren(parent, [SessionId(id)]), wrongSource)
      assert.equal(ctx.sessions.get(SessionId(id)), undefined, 'refused source IDs never create local sessions')
    }
    assert.equal(starts, 1); assert.equal(disposals, 1)
  } finally { abort.abort(); await ctx.fiber.dispose() }
})
