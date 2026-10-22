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
import { TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import type { SessionControlFrame, SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError, remoteMethods, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import NativeAwareSessionController, { isNativeDisplayId, isObservedDisplayId } from '../src/codex/session-controller.ts'
import { HapiObservedChild } from '../src/hapi-agent/children.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'native-control-fixture': { kind: 'native-control-fixture' } }
}

/** Uses official point reads; search is outside this contract fixture. */
class FixtureQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { throw new Error('No fixture full-text search backend') }
  override searchEvents(): Promise<never> { throw new Error('No fixture full-text search backend') }
}

async function mount(Controller: typeof SessionController | typeof NativeAwareSessionController = NativeAwareSessionController) {
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
  let resolverRegistrations = 0
  ctx.provide('fileUploads', { registerAgentResolver: () => { resolverRegistrations++; return () => {} }, retirePrompt: () => {} } as unknown as Context['fileUploads'])
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
  const steers: unknown[] = []
  ctx.provide('hapi', {
    nativeSteerInbox: async (sessionId: string, itemId: string) => { steers.push({ sessionId, itemId }); return itemId === 'failed' ? { status: 'failed', error: 'Source outcome unknown', localId: itemId } : { status: 'steered', localId: itemId } },
    renameNativeSession: async (request: unknown) => { renames.push(request); return { title: 'Observed source title', seq: SessionSeq(9) } },
    renameObservedSession: async (request: unknown) => { renames.push(request); return { title: 'Original engine title', seq: SessionSeq(11) } },
  } as unknown as Context['hapi'])
  const config = { nativeOpen: false, listWorkSliceMs: 16 }
  // Only Loader entry discovery is a fixture here. The isolated official
  // constructor, Cordis service tracing, Remote metadata and Gateway are real.
  const privateScope = Symbol('official Session controller fixture')
  const original = new SessionController(Controller === SessionController ? ctx : ctx.isolate('sessionController', privateScope), config)
  const entry = { options: { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller', isolate: { sessionController: true } },
    disabled: false, fiber: { config }, realm: { access: () => privateScope } }
  ctx.provide('loader', { *entries() { yield entry } } as unknown as Context['loader'])
  // In production this registration belongs to the active official package
  // root. The wrapper neither supplies another artifact nor installs readers.
  ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-session-controller', TYPERT))
  let controller: SessionController | NativeAwareSessionController = original
  if (Controller !== SessionController) await ctx.plugin(Object.assign((owner: Context) => {
    controller = new NativeAwareSessionController(owner, config)
  }, { inject: NativeAwareSessionController.inject }))
  const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
  function ordinaryAgent(id: string, agentContext = ctx.extend()) {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace/fixture' } })
    const queued: UserMessage[] = [createUserMessage({ content: [{ type: 'text', text: 'Fixture queued input' }], source: { kind: 'user' } })]
    const cancellations: unknown[] = []
    const agent = {
      id: session.id, session, ctx: agentContext, status: 'idle',
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
  function stream(method: string, args: Readonly<Record<string, unknown>>, principal: Principal, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    const peer: PeerScope = { id: 'native-controller-stream-fixture' as PeerId, ctx, principal, interactions: 'answer', signal, dispose: async () => {} }
    return gateway.stream({ peer, namespace: 'session', method, args })
  }
  return { ctx, controller, original, ordinaryAgent, invoke, stream, saved, renames, steers, entry,
    get resolverRegistrations() { return resolverRegistrations }, close: () => ctx.fiber.dispose() }
}

const nativeId = SessionId(`hapi-codex-${'a'.repeat(32)}`)

test('public composition retains one isolated official constructor and the exact official Remote contract', async () => {
  const app = await mount()
  const official = await mount(SessionController)
  try {
    assert.deepEqual(NativeAwareSessionController.inject, ['loader', 'hapi'])
    assert.equal(NativeAwareSessionController.Config, SessionController.Config)
    const describe = (controller: object) => remoteMethods(controller).map(({ resources, ...value }) => ({ ...value,
      resources: Object.keys(resources ?? {}) })).sort((a, b) => a.method.localeCompare(b.method))
    assert.deepEqual(describe(app.controller), describe(official.controller))
    assert.equal(app.resolverRegistrations, 1)
    assert.equal(app.controller instanceof SessionController, false)
    assert.equal(app.original instanceof SessionController, true)
    const contract = app.ctx.typert.getPackage('@deepseek-ai/dsh-api-session-controller', 'host')
    assert.ok(contract)
    assert.ok(contract.model.services.some(service => service.key === 'sessionController'))
    assert.equal(app.controller.canOpenWorkspacePath(), false)
    app.entry.disabled = true
    assert.throws(() => app.controller.canOpenWorkspacePath(), /active isolated package-root/)
    app.entry.disabled = false
  } finally { await app.close(); await official.close() }
})

test('delegation preserves the current non-owner Invocation for ordinary list filtering and control streams', async () => {
  const app = await mount(), abort = new AbortController()
  try {
    app.ordinaryAgent('visible'); app.ordinaryAgent('private')
    app.ctx.remoteAccess.registerPolicy('native-control-fixture', { bindings: () => [
      { role: { name: 'fixture list', resource: 'global', actions: ['session/list', 'session/control'] }, resource: { kind: 'global' } },
      { role: { name: 'fixture visible', resource: 'session', actions: ['session/list', 'session/control'] }, resource: { kind: 'session', id: SessionId('visible') } },
    ] })
    const principal: Principal = { kind: 'native-control-fixture' }
    const visible = await app.invoke('list', { _request: {} }, principal) as SessionListValue
    assert.deepEqual(visible.items.map(row => row.sessionId), ['visible'])
    const all = await app.invoke('list', { _request: {} }) as SessionListValue
    assert.equal(all.items.length, 2)
    const stream = await app.stream('control', {}, principal, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    const baseline = (await iterator.next()).value as SessionControlFrame
    assert.equal(baseline.type, 'baseline')
    assert.ok(baseline.type === 'baseline')
    assert.deepEqual(Object.keys(baseline.value.projections), ['visible'])
    await iterator.return?.()
    assert.equal(app.resolverRegistrations, 1)
  } finally { abort.abort(); await app.close() }
})

test('the composed history readers authorize the exact child resource, not only the named parent', async () => {
  const app = await mount(), abort = new AbortController()
  try {
    const held: RemoteAccessBinding[] = [{ role: { name: 'parent history', resource: 'session', actions: ['session/page', 'session/follow'] },
      resource: { kind: 'session', id: SessionId('parent') } }]
    app.ctx.remoteAccess.registerPolicy('native-control-fixture', { bindings: () => held })
    const principal: Principal = { kind: 'native-control-fixture' }
    const request = { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'ungranted-child', mode: 'unknown' } }
    const denied = (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied'
    await assert.rejects(app.invoke('page', { request: { ...request, throughSeq: 0 } }, principal), denied)
    await assert.rejects(app.stream('follow', { request }, principal, abort.signal), denied)
  } finally { abort.abort(); await app.close() }
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

test('observed original engines reject generic loop controls and route rename through their actual owner', async () => {
  const app = await mount(), id = SessionId(`hapi-observed-${'b'.repeat(32)}-r2`)
  try {
    const session = app.ctx.sessions.create(id), initial = session.seq
    for (const [method, request, sourceCode] of [
      ['selectModel', { sessionId: id, provider: 'fixture-provider', model: 'fixture-model' }, 'observed_model_control_required'],
      ['fork', { sessionId: id }, 'observed_fork_control_required'],
      ['updateQueue', { sessionId: id, itemId: 'pending', action: { kind: 'remove' } }, 'observed_queue_control_required'],
    ] as const) await assert.rejects(app.invoke(method, { request }), (error: unknown) => error instanceof RemoteError
      && error.code === 'hapi/request' && (error.details as { sourceCode?: string }).sourceCode === sourceCode)
    assert.deepEqual(await app.invoke('rename', { request: { sessionId: id, title: 'Original title' } }), { title: 'Original engine title', seq: 11 })
    assert.equal(app.renames.length, 1); assert.equal(session.seq, initial)
    assert.equal(isObservedDisplayId(id), true); assert.equal(isObservedDisplayId('hapi-observed-ordinary'), false)
  } finally { await app.close() }
})

test('source children retain original official subagent ownership rejection and never route writes to the source parent', async () => {
  const app = await mount(), children: HapiObservedChild[] = []
  try {
    for (const prefix of ['hapi-codex', 'hapi-observed']) {
      await app.ctx.plugin(Object.assign(async (ownerContext: Context) => {
        const root = app.ordinaryAgent(`${prefix}-${'c'.repeat(32)}-r2`, ownerContext)
        const child = await HapiObservedChild.create({ agent: root.agent, logicalSessionId: root.agent.id, displayRevision: 2,
          content: () => undefined, state: () => ({ hubId: 'fixture', hapiSessionId: 'original-parent', flavor: 'claude',
            machineId: 'fixture-machine', machineName: 'Fixture', path: '/fixture', active: true, connection: 'connected',
            model: 'fixture-model', effort: null, permissionMode: null, error: null }) }, root.agent,
        { scopeId: 'sdk-tool:child', kind: 'sdk', parentToolCallId: 'child', parentScopeId: null, sourceAgentId: null,
          label: 'Original source child', status: 'observed', createdAt: 1000, updatedAt: 1000 }, [])
        children.push(child)
      }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
    }
    for (const child of children) {
      for (const [method, request] of [
        ['selectModel', { sessionId: child.id, provider: 'fixture-provider', model: 'fixture-model' }],
        ['fork', { sessionId: child.id }],
        ['updateQueue', { sessionId: child.id, itemId: 'pending', action: { kind: 'remove' } }],
        ['rename', { sessionId: child.id, title: 'Must not rename parent' }],
      ] as const) await assert.rejects(app.invoke(method, { request }), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
      await assert.rejects(app.invoke('prompt', { request: { sessionId: child.id, requestId: 'child-input', mode: 'queue',
        content: [{ type: 'text', text: 'Must not execute' }] } }), (error: unknown) => error instanceof RemoteError
        && error.code === 'session/agent-busy' && error.message.includes('subagent routing'))
      await assert.rejects(app.invoke('cancel', { request: { sessionId: child.id } }), (error: unknown) => error instanceof RemoteError
        && error.code === 'session/agent-busy' && error.message.includes('subagent routing'))
    }
    assert.equal(app.renames.length, 0); assert.equal(app.saved.length, 0)
  } finally { for (const child of children.reverse()) await child.dispose(); await app.close() }
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

 test('official queue steer routes native and observed IDs through source receipts and preserves failures', async () => {
  const app = await mount()
  try {
    for (const sessionId of [nativeId, SessionId(`hapi-observed-${'b'.repeat(32)}`)]) {
      assert.deepEqual(await app.controller.updateQueue({ sessionId, itemId: 'original-message-id' as never, action: { kind: 'steer' } }), { accepted: true })
      assert.deepEqual(app.steers.at(-1), { sessionId, itemId: 'original-message-id' })
      await assert.rejects(app.controller.updateQueue({ sessionId, itemId: 'failed' as never, action: { kind: 'steer' } }), /Source outcome unknown/)
    }
    assert.equal(app.steers.length, 4)
  } finally { await app.close() }
})

test('source inbox steering resolves original message IDs and refuses unconfirmed rows', async () => {
  const { NativeCodexAgent } = await import('../src/codex/agent.ts')
  const { HapiObservedAgent } = await import('../src/hapi-agent/agent.ts')
  for (const [AgentClass, prefix] of [[NativeCodexAgent, 'hapi:'], [HapiObservedAgent, 'hapi-observed:']] as const) {
    const calls: string[] = []
    const fixture = {
      deliveries: () => [{ localId: 'owned', state: 'queued' }, { localId: 'external', state: 'queued' }, { localId: 'unknown', state: 'indeterminate' }],
      journal: { get: (id: string) => id === 'owned' ? { message: { id: 'official-message-id' } } : undefined },
      steerQueued: async (id: string) => { calls.push(id); return { status: 'steered' as const, localId: id } },
    }
    const steer = (id: string) => AgentClass.prototype.steerInbox.call(fixture as never, id)
    await steer('official-message-id'); await steer(`${prefix}external`)
    await assert.rejects(steer(`${prefix}unknown`), /no longer confirmed queued/)
    await assert.rejects(steer('unrelated-id'), /no longer confirmed queued/)
    assert.deepEqual(calls, ['owned', 'external'])
  }
})
