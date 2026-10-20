import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { RemoteError, remoteMethods, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import NativeAwareSessionController, { isNativeDisplayId } from '../src/codex/session-controller.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'native-control-fixture': { kind: 'native-control-fixture' } }
}

/** Uses official point reads; search is outside this contract fixture. */
class FixtureQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { throw new Error('No fixture full-text search backend') }
  override searchEvents(): Promise<never> { throw new Error('No fixture full-text search backend') }
}

async function mount(Controller: typeof SessionController = NativeAwareSessionController) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TypertRegistry)
  new FixtureQuery(ctx)
  new RemoteAccessService(ctx)
  new SessionTitleService(ctx, { fallbackMaxWords: 20, fallbackMaxBytes: 256, maxTitleBytes: 256 })
  // These protocol fixtures are only the external services the official
  // controller asks for. The controller, gateway, registry, sessions,
  // projections, title handling and resource authorization remain real DSH.
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, retirePrompt: () => {} } as unknown as Context['fileUploads'])
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture-provider', name: 'Fixture' }],
    listModels: async () => [{ id: 'fixture-model', name: 'Fixture model' }],
    resolveCallConfig: async (input: { provider: string; model: string }) => input,
  } as unknown as Context['llm'])
  const saved: unknown[] = []
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }),
    saveSelection: async (value: unknown) => { saved.push(value) },
  } as unknown as Context['agentDefaultModel'])
  const renames: unknown[] = []
  ctx.provide('hapi', {
    renameNativeSession: async (request: unknown) => { renames.push(request); return { title: 'Observed source title', seq: SessionSeq(9) } },
  } as unknown as Context['hapi'])
  const controller = new Controller(ctx, { nativeOpen: false, listWorkSliceMs: 16 })
  const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
  function ordinaryAgent(id: string) {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace/fixture' } })
    const queued: UserMessage[] = [createUserMessage({ content: [{ type: 'text', text: 'Fixture queued input' }], source: { kind: 'user' } })]
    const cancellations: unknown[] = []
    const agent = {
      id: session.id, session, ctx: ctx.extend(), status: 'idle',
      inbox: {
        nextTurn: queued, nextStep: [],
        remove: (itemId: string) => { const index = queued.findIndex(item => item.id === itemId); if (index < 0) return false; queued.splice(index, 1); return true },
      },
      cancel: (...args: unknown[]) => { cancellations.push(args) },
    } as unknown as Agent
    ctx.agents.enter(agent, undefined)
    return { agent, session, queued, cancellations }
  }
  function invoke(method: string, args: Readonly<Record<string, unknown>>, principal: Principal = { kind: 'owner' }): Promise<unknown> {
    const peer: PeerScope = { id: 'native-controller-fixture' as PeerId, ctx, principal, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} }
    return gateway.invoke({ peer, namespace: 'session', method, args })
  }
  return { ctx, controller, ordinaryAgent, invoke, saved, renames, close: () => ctx.fiber.dispose() }
}

const nativeId = SessionId(`hapi-codex-${'a'.repeat(32)}`)

test('public provider replacement inherits official Remote metadata and registers the exact official wire artifact', async () => {
  const app = await mount()
  const official = await mount(SessionController)
  try {
    assert.deepEqual(NativeAwareSessionController.inject, [...SessionController.inject, 'hapi'])
    assert.equal(NativeAwareSessionController.Config, SessionController.Config)
    assert.deepEqual(remoteMethods(app.controller), remoteMethods(official.controller))
    const contract = app.ctx.typert.getPackage('@deepseek-ai/dsh-api-session-controller', 'host')
    assert.ok(contract)
    assert.ok(contract.model.services.some(service => service.key === 'sessionController'))
    const own = new Set(['constructor', 'selectModel', 'fork', 'updateQueue', 'rename'])
    assert.deepEqual(new Set(Object.getOwnPropertyNames(NativeAwareSessionController.prototype)
      .filter(key => typeof Object.getOwnPropertyDescriptor(NativeAwareSessionController.prototype, key)?.value === 'function')), own)
    for (const key of Object.getOwnPropertyNames(SessionController.prototype)) {
      if (!own.has(key) && typeof Object.getOwnPropertyDescriptor(SessionController.prototype, key)?.value === 'function') {
        assert.equal(Reflect.get(NativeAwareSessionController.prototype, key), Reflect.get(SessionController.prototype, key), `official ${key} is inherited unchanged`)
      }
    }
  } finally { await app.close(); await official.close() }
})

test('native generic model/fork/queue controls refuse through the real official gateway without changing source shadow state', async () => {
  const app = await mount()
  try {
    const session = app.ctx.sessions.create(nativeId, { meta: { cwd: '/workspace/fixture' } })
    const initial = session.seq
    const rejects = [
      ['selectModel', { sessionId: nativeId, provider: 'fixture-provider', model: 'fixture-model' }, 'native_model_control_required'],
      ['fork', { sessionId: nativeId }, 'native_fork_control_required'],
      ['updateQueue', { sessionId: nativeId, itemId: 'queued-item', action: { kind: 'remove' } }, 'native_queue_control_required'],
    ] as const
    for (const [method, request, code] of rejects) {
      await assert.rejects(app.invoke(method, { request }), (error: unknown) => error instanceof RemoteError
        && error.code === 'hapi/request' && (error.details as { sourceCode?: string }).sourceCode === code)
    }
    assert.equal(session.seq, initial)
    assert.deepEqual(await app.invoke('rename', { request: { sessionId: nativeId, title: 'Source title' } }), { title: 'Observed source title', seq: 9 })
    assert.equal(app.renames.length, 1)
    assert.equal(session.seq, initial)
    assert.equal(isNativeDisplayId(`${nativeId}-r12`), true)
    assert.equal(isNativeDisplayId('hapi-codex-looking-but-ordinary'), false)
  } finally { await app.close() }
})

test('provider replacement retains original resource authorization before dispatching native overrides', async () => {
  const app = await mount()
  try {
    const held: RemoteAccessBinding[] = []
    app.ctx.remoteAccess.registerPolicy('native-control-fixture', { bindings: () => held })
    const principal: Principal = { kind: 'native-control-fixture' }
    const request = { sessionId: nativeId }
    await assert.rejects(app.invoke('fork', { request }, principal), (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied')
    held.push({ role: { name: 'fixture native fork', resource: 'session', actions: ['session/fork'] }, resource: { kind: 'session', id: nativeId } })
    await assert.rejects(app.invoke('fork', { request }, principal), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    await assert.rejects(app.invoke('fork', { request: { sessionId: `${nativeId}-r1` } }, principal), (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied')
  } finally { await app.close() }
})

test('ordinary DSH selectModel, rename, fork validation, queue removal and cancellation retain official behavior', async () => {
  for (const Controller of [SessionController, NativeAwareSessionController]) {
    const app = await mount(Controller)
    try {
      const regular = app.ordinaryAgent('ordinary-session')
      const request = { sessionId: regular.session.id, provider: 'fixture-provider', model: 'fixture-model' }
      assert.deepEqual(await app.controller.selectModel(request), { selected: { provider: 'fixture-provider', model: 'fixture-model' } })
      assert.equal(regular.session.snapshotEvents().filter(event => event.type === 'model/selection').length, 1)
      assert.equal(app.saved.length, 1)
      assert.equal((await app.controller.rename({ sessionId: regular.session.id, title: ' New ordinary title ' })).title, 'New ordinary title')
      assert.equal(app.renames.length, 0)
      await assert.rejects(app.controller.fork({ sessionId: regular.session.id, atSeq: -1 }), (error: unknown) => error instanceof RemoteError && error.code === 'gateway/bad-request')
      const itemId = regular.queued[0]!.id
      assert.deepEqual(await app.controller.updateQueue({ sessionId: regular.session.id, itemId, action: { kind: 'remove' } }), { accepted: true })
      assert.equal(regular.queued.length, 0)
      assert.deepEqual(app.controller.cancel({ sessionId: regular.session.id }), { accepted: true })
      assert.deepEqual(regular.cancellations, [[{ kind: 'user' }, { keepInbox: true }]])
    } finally { await app.close() }
  }
})
