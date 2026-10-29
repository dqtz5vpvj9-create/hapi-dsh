/** Real Typert registry/Gateway/access checks and source feed; Agent service lookup
 * is the explicit boundary fixture. No HTTP server or browser is started. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import { RemoteError, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import { HapiController } from '../src/index.ts'
import { HAPI_REMOTE } from '../src/client-api.ts'
import { DisplayHistoryWindows } from '../src/codex/source-window.ts'
import { SourceFrameFeed } from '../src/shared/source-frame-feed.ts'
import type { SourceFrame, SourceFrameBatch } from '../src/shared/source-frames.ts'
import type { ObservedItem } from '../src/hapi-agent/parser.ts'
import { HapiObservedChild } from '../src/hapi-agent/children.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'source-follow-fixture': { kind: 'source-follow-fixture' } }
}
const nativeId = SessionId(`hapi-codex-${'c'.repeat(32)}`)
const otherId = SessionId(`hapi-observed-${'d'.repeat(32)}`)
const frame = (key: string): SourceFrame => ({ key, source: { messageId: key, at: 1, seq: 1 },
  event: { type: 'user/message', seq: 0, time: 1, data: createUserMessage({ content: [{ type: 'text', text: key }], source: { kind: 'user' } }), surfaceOp: 'append' } })

async function mount() {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(TypertRegistry)
  new RemoteAccessService(ctx)
  ctx.typert.resources.register('session', { field: 'sessionId' })
  const agents = new Map<string, ReturnType<typeof add>>()
  let controller!: HapiController, owner!: Context
  await ctx.plugin({ inject: ['sessions', 'agents', 'sessionProjections', 'typert'], apply(scope: Context) { owner = scope } })
  function add(id: SessionId) {
    const session = owner.sessions.create(id), frames: SourceFrame[] = [frame(`${id}:initial`)]
    const feed = new SourceFrameFeed(() => ({ kind: 'replace', frames: [...frames], hasMoreBefore: true }))
    const agent = { id, session, ctx: owner, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      binding: { hapiSessionId: `original:${id}`, hubId: 'fixture', machineId: 'fixture-machine' },
      historyWindowAnchor: () => undefined, currentSourceFrames: () => [...frames],
      sourceFrameBaseline: () => feed.baseline(), sourceFrames: (signal: AbortSignal) => feed.watch(signal),
    }
    const detach = owner.agents.enter(agent as unknown as Agent, undefined)
    const value = { agent, frames, feed, close() { feed.dispose(); detach() } }
    agents.set(id, value)
    return value
  }
  const native = add(nativeId), observed = add(otherId)
  const options = { client: { subscribeCatalog: () => () => {} },
    codex: { get: (id: string) => id.startsWith('hapi-codex-') ? agents.get(id)?.agent : undefined },
    observed: { get: (id: string) => id.startsWith('hapi-observed-') ? agents.get(id)?.agent : undefined },
    historyWindows: new DisplayHistoryWindows() }
  controller = new HapiController(owner, options as unknown as ConstructorParameters<typeof HapiController>[1])
  const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
  const peer = (signal: AbortSignal, principal: Principal): PeerScope => ({ id: 'source-follow-test' as PeerId,
    ctx, signal, principal, interactions: 'answer', dispose: async () => {} })
  return { ctx, controller, native, observed, owner, agents,
    stream: (sessionId: string, signal: AbortSignal, principal: Principal = { kind: 'owner' }) => gateway.stream({
      peer: peer(signal, principal), namespace: 'hapi', method: 'sourceWindowFollow', args: { request: { sessionId } } }) as Promise<AsyncIterable<SourceFrameBatch>>,
    invoke: (sessionId: string, attachmentId: string, principal: Principal = { kind: 'owner' }) => gateway.invoke({
      peer: peer(new AbortController().signal, principal), namespace: 'hapi', method: 'sourceHistoryAttachment', args: { request: { sessionId, attachmentId } } }),
    close: async () => { for (const value of agents.values()) value.close(); await ctx.fiber.dispose() },
  }
}

test('the registered Remote source stream carries baselines, live revisions and reconnect state without operation log writes', async () => {
  const app = await mount(), abort = new AbortController()
  try {
    const descriptor = HAPI_REMOTE.descriptors.find(value => value.method === 'sourceWindowFollow')!
    assert.equal(descriptor.mode, 'stream'); assert.deepEqual(descriptor.cancellation, { parameter: 'signal' })
    const iterator = (await app.stream(nativeId, abort.signal))[Symbol.asyncIterator]()
    assert.deepEqual((await iterator.next()).value, app.native.feed.baseline())
    const oldSeq = app.native.agent.session.seq
    app.native.frames.splice(0, 1, frame('revised'))
    app.native.feed.publish({ kind: 'replace', reset: true, frames: [...app.native.frames], removeKeys: ['old'], replaceSources: ['old'] })
    const update = (await iterator.next()).value!
    assert.equal(update.historyVersion, 1); assert.equal(update.reset, true)
    assert.deepEqual(update.removeKeys, ['old']); assert.deepEqual(update.replaceSources, ['old'])
    assert.equal(app.native.agent.session.seq, oldSeq, 'body updates never append to the operation Session')
    const pending = iterator.next(); abort.abort()
    await assert.rejects(pending, (error: unknown) => error instanceof RemoteError && error.code === 'gateway/cancelled')
    const reconnectedAbort = new AbortController()
    const reconnected = (await app.stream(nativeId, reconnectedAbort.signal))[Symbol.asyncIterator]()
    assert.deepEqual((await reconnected.next()).value, app.native.feed.baseline())
    reconnectedAbort.abort(); await reconnected.return?.()
    assert.equal(app.controller.sourceSessionBlank(nativeId), false)
    app.native.frames.length = 0
    assert.equal(app.controller.sourceSessionBlank(nativeId), true)
    assert.equal(app.controller.sourceSessionBlank('ordinary'), undefined)
  } finally { abort.abort(); await app.close() }
})

test('source streams authorize the exact session resource and reject ordinary or retired owners', async () => {
  const app = await mount(), abort = new AbortController()
  try {
    const held: RemoteAccessBinding[] = [{ role: { name: 'source reader', resource: 'session', actions: ['hapi/sourceWindowFollow'] }, resource: { kind: 'session', id: nativeId } }]
    app.ctx.remoteAccess.registerPolicy('source-follow-fixture', { bindings: () => held })
    const principal: Principal = { kind: 'source-follow-fixture' }
    const visible = (await app.stream(nativeId, abort.signal, principal))[Symbol.asyncIterator]()
    assert.equal((await visible.next()).value?.frames[0]?.key, app.native.frames[0]!.key)
    await assert.rejects(app.stream(otherId, abort.signal, principal), (error: unknown) => error instanceof RemoteError && error.code === 'remote-access/denied')
    const ordinary = (await app.stream('ordinary', abort.signal))[Symbol.asyncIterator]()
    await assert.rejects(ordinary.next(), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    const retired = (await app.stream(`${nativeId}-r99`, abort.signal))[Symbol.asyncIterator]()
    await assert.rejects(retired.next(), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    abort.abort(); await visible.return?.()
  } finally { abort.abort(); await app.close() }
})

test('an observed child grants only images actually served by its own live stream, and revokes on history rewrite', async () => {
  const app = await mount(), abort = new AbortController()
  let child: HapiObservedChild | undefined
  try {
    const ref = { attachmentId: AttachmentId('1'.repeat(64)), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    let readImage = async () => ({ ref, data: new Uint8Array([1]) })
    app.ctx.provide('attachments', { readImage: () => readImage() } as unknown as Context['attachments'])
    child = await HapiObservedChild.create({ agent: app.native.agent as unknown as Agent, logicalSessionId: nativeId, displayRevision: 0,
      content: () => [{ type: 'image', attachment: ref }], state: () => ({ hubId: 'fixture', hapiSessionId: 'source', flavor: 'claude',
        machineId: 'fixture-machine', machineName: 'Fixture', path: '/fixture', active: true, connection: 'connected', model: 'fixture', effort: null, permissionMode: null, error: null }) },
    app.native.agent as unknown as Agent, { scopeId: 'sdk:child', kind: 'sdk', parentScopeId: null, parentToolCallId: 'child', sourceAgentId: null,
      label: 'Source child', status: 'observed', createdAt: 1, updatedAt: 1 }, [{ kind: 'user', key: 'image', rowId: 'image', localId: null,
        seq: 1, createdAt: 1, scopeId: 'sdk:child', parentToolCallId: 'child', fingerprint: 'image', model: null,
        parts: [], text: '', invoked: true, mode: 'queue' } satisfies ObservedItem])
    await assert.rejects(app.invoke(child.id, ref.attachmentId), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    const iterator = (await app.stream(child.id, abort.signal))[Symbol.asyncIterator]()
    assert.ok((await iterator.next()).value?.frames.some(frame => frame.event.type === 'user/message'))
    const image = await app.invoke(child.id, ref.attachmentId) as { data: string }
    assert.equal(image.data, 'AQ==')
    await assert.rejects(app.invoke(otherId, ref.attachmentId), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    readImage = async () => { entered(); await released; return { ref, data: new Uint8Array([1]) } }
    const pendingImage = app.invoke(child.id, ref.attachmentId)
    await started
    child.apply([], true, true)
    release()
    await assert.rejects(pendingImage, (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    await assert.rejects(app.invoke(child.id, ref.attachmentId), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    assert.equal((await iterator.next()).value?.historyVersion, 1)
    await assert.rejects(app.invoke(child.id, ref.attachmentId), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
    abort.abort(); await iterator.return?.()
    const childId = child.id
    await child.dispose(); child = undefined
    await assert.rejects(app.invoke(childId, ref.attachmentId), (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request')
  } finally { abort.abort(); await child?.dispose(); await app.close() }
})
