import { projectedSourceEvents } from './source-frame-fixture.ts'
import { SOURCE_FRAME_EVENT, type SourceFrameBatch } from '../src/shared/source-frames.ts'
/** Original source protocol fixtures with the real published Agent/Session/Scope registries. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionPage } from '@deepseek-ai/dsh-api-session-controller/types'
import { TYPERT as SESSION_TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert'
import SubagentRuntime, { type SubagentPromptRequest, type SubagentPromptRequestId, type SubagentPromptReceipt } from '@deepseek-ai/dsh-subagent'
import { TYPERT as SUBAGENT_TYPERT } from '@deepseek-ai/dsh-subagent/typert'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { RemoteError, remoteMethods, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import sourceSubagentPlugin from '../src/hapi-agent/subagent-controller.ts'
import { officialDelegateFixture } from './official-provider-fixture.ts'
import type { HapiApprovalAnswer, HapiEvent, HapiMessage, HapiMessagesPage, HapiQueuedState, HapiSendMessage, HapiSession } from '../src/codex/contracts.js'
import { HapiRequestError } from '../src/codex/contracts.js'
import { HapiAgentService, type HapiObservedTransport } from '../src/hapi-agent/index.js'
import { sourceDshChildCatalog } from '../src/hapi-agent/dsh-child-protocol.js'
import type { SourceDshChildDescriptor, SourceDshChildMessage } from '../src/hapi-agent/dsh-child-types.js'

class Source implements HapiObservedTransport {
  readonly hubId = 'dsh-child-agent-fixture'
  isConnected = true
  readonly listeners = new Set<(event: HapiEvent) => void>()
  readonly mutations: Array<{ operation: string; child: string; body: unknown }> = []
  readonly parentWrites: HapiSendMessage[] = []
  readonly rows: HapiMessage[] = []
  readonly children = new Map<string, SourceDshChildMessage[]>()
  readonly epochs = new Map<string, string>()
  losePrompt = false
  readonly source: HapiSession = {
    id: 'original-parent', namespace: 'fixture', seq: 1, createdAt: 1000, updatedAt: 1000,
    active: true, activeAt: 1000, thinking: false, thinkingAt: 1000, metadataVersion: 1, agentStateVersion: 1,
    model: 'parent-model', metadata: { flavor: 'dsh', path: '/original/runner/project', machineId: 'original-runner',
      host: 'Original Runner', dshSessionId: 'original-dsh-parent', dshCapabilities: { control: true, steering: true, resume: true, images: true, subagents: true } },
    agentState: { requests: {}, completedRequests: {} },
  }
  add(id: string, mode: SourceDshChildDescriptor['mode'] = 'continuable') {
    const child: SourceDshChildDescriptor = { sessionId: id, label: `Original ${id}`, name: `Child ${id}`, mode,
      createdAt: 1100, activity: 'inactive', lastTurnCompleted: true, settledMs: 50 }
    Object.assign(this.source.metadata!, { dshSubagents: [...sourceDshChildCatalog(this.source), child] })
    this.children.set(id, [{ id: `${id}:0`, role: 'user', kind: 'message', text: `Task for ${id}`, createdAt: 1100 },
      { id: `${id}:1`, role: 'assistant', kind: 'message', text: `Answer from ${id}`, createdAt: 1150 }])
    this.epochs.set(id, `${id}:1100`); return child
  }
  change(id: string, change: Partial<SourceDshChildDescriptor>) {
    Object.assign(this.source.metadata!, { dshSubagents: sourceDshChildCatalog(this.source).map(child => child.sessionId === id ? { ...child, ...change } : child) })
    this.source.metadataVersion++; this.source.updatedAt++
  }
  async listSessions() { return [structuredClone(this.source)] }
  async getSession(id: string) { assert.equal(id, this.source.id); return structuredClone(this.source) }
  async readMessages(): Promise<HapiMessagesPage> { return { messages: structuredClone(this.rows), page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
    nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } } }
  async getQueuedState(): Promise<HapiQueuedState> { return { queuedLocalIds: [], invokedLocalMessages: [] } }
  async sendMessage(_id: string, value: HapiSendMessage) { this.parentWrites.push(value) }
  async cancelQueuedMessage(_id: string, localId: string) { return { status: 'cancelled' as const, localId } }
  async steerQueuedMessage(_id: string, localId: string) { return { status: 'steered' as const, localId } }
  async retryIndeterminateMessage(_id: string, localId: string) { return { status: 'retried' as const, localId } }
  async abortSession() { throw new Error('A child cannot stop its HAPI parent') }
  async approve(_id: string, _request: string, _answer: HapiApprovalAnswer) { throw new Error('A child cannot approve for its HAPI parent') }
  async deny(_id: string, _request: string, _answer?: HapiApprovalAnswer) { throw new Error('A child cannot deny for its HAPI parent') }
  async request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown> {
    const url = new URL(path, 'https://fixture.invalid'), matched = /^\/api\/sessions\/([^/]+)\/dsh-subagents\/([^/]+)\/(messages|prompt|interrupt)$/.exec(url.pathname)
    assert.ok(matched, `Unexpected child route ${url.pathname}`); assert.equal(decodeURIComponent(matched[1]!), this.source.id)
    const id = decodeURIComponent(matched[2]!), operation = matched[3]!, rows = this.children.get(id)
    assert.ok(rows); assert.ok(sourceDshChildCatalog(this.source).some(child => child.sessionId === id))
    if (operation !== 'messages') {
      assert.equal(options?.method, 'POST'); this.mutations.push({ operation, child: id, body: options?.body })
      if (operation === 'interrupt') return { accepted: true }
      if (this.losePrompt) throw new HapiRequestError('Fixture lost the original reply', 'indeterminate', 401)
      return { messageId: `original-dsh-message-${this.mutations.length}` }
    }
    const limit = Number(url.searchParams.get('limit')), before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
    const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined
    const epoch = this.epochs.get(id)!, reset = url.searchParams.has('epoch') && url.searchParams.get('epoch') !== epoch || after !== undefined && after > rows.length
    const start = after !== undefined && !reset ? after : Math.max(0, (before ?? rows.length) - limit)
    const end = after !== undefined && !reset ? Math.min(rows.length, after + limit) : before ?? rows.length
    return { sessionId: id, messages: structuredClone(rows.slice(start, end)), epoch,
      before: start > 0 ? start : null, hasMore: start > 0, after: after !== undefined && !reset ? end : rows.length,
      hasLater: after !== undefined && !reset && end < rows.length, reset, truncated: false }
  }
  subscribe(listener: (event: HapiEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: HapiEvent) { for (const listener of this.listeners) listener(event) }
}
async function mount(source: Source, directory: string) {
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime)
  let service: HapiAgentService | undefined
  await ctx.plugin(Object.assign(async (owner: Context) => { service = new HapiAgentService(owner, source, { stateDirectory: directory }); await service.start() },
    { inject: ['sessions', 'agents', 'sessionProjections'] }))
  assert.ok(service); assert.deepEqual([...service.failures()], [])
  return { ctx, service, async close() { await service!.dispose(); await ctx.fiber.dispose() } }
}
class FixtureQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { throw new Error('This point-read fixture has no search index') }
  override searchEvents(): Promise<never> { throw new Error('This point-read fixture has no search index') }
}
/** Real original history, subagent projections, gateway and isolation; external IO is not exercised. */
async function controls(ctx: Context) {
  await ctx.plugin(TypertRegistry)
  new FixtureQuery(ctx); new RemoteAccessService(ctx)
  new SessionTitleService(ctx, { fallbackMaxWords: 20, fallbackMaxBytes: 256, maxTitleBytes: 256 })
  ctx.provide('workingDirectory', { get: (session: { header: { cwd: string } }) => session.header.cwd } as unknown as Context['workingDirectory'])
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, retirePrompt: () => {} } as unknown as Context['fileUploads'])
  ctx.provide('llm', { listProviders: () => [], listModels: async () => [] } as unknown as Context['llm'])
  ctx.provide('agentDefaultModel', { currentSelection: () => undefined } as unknown as Context['agentDefaultModel'])
  new SessionController(ctx, { nativeOpen: false, listWorkSliceMs: 16 })
  const isolated = officialDelegateFixture(ctx, 'subagent', {}), originalFiber = await isolated.plugin(SubagentRuntime)
  const original = isolated.get('subagents')!
  assert.ok(original)
  await ctx.plugin(sourceSubagentPlugin)
  ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-subagent', SUBAGENT_TYPERT))
  ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-session-controller', SESSION_TYPERT))
  const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
  function invoke(namespace: string, method: string, args: Readonly<Record<string, unknown>>, principal: Principal = { kind: 'owner' }): Promise<unknown> {
    const peer: PeerScope = { id: 'source-child-control-fixture' as PeerId, ctx, principal, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} }
    return gateway.invoke({ peer, namespace, method, args })
  }
  return { original, originalFiber, invoke }
}
const input = (text = 'Continue the original child') => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
function text(agent: { sourceFrameBaseline(): SourceFrameBatch }) {
  return projectedSourceEvents(agent).flatMap(event => event.type === 'assistant/message' ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
}

test('source DSH members register real official child Sessions while only actual continuable children accept original prompts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-child-agents-')), source = new Source()
  for (const [id, mode] of [['worker', 'continuable'], ['one-shot', 'one-shot'], ['external', 'external'], ['unknown', 'unknown']] as const) source.add(id, mode)
  const app = await mount(source, directory)
  try {
    const parent = app.service.list()[0]!, child = parent.childSessions.find(value => value.scopeInfo.sourceAgentId === 'worker')!
    const worker = app.service.dshChild(child.id)!
    assert.ok(worker); assert.equal(app.service.list().length, 1); assert.equal(app.service.get(worker.id), undefined)
    assert.equal(app.ctx.agents.get(worker.id), worker); assert.equal(app.ctx.sessions.get(worker.id), worker.session)
    assert.equal(worker.session.header.origin, 'subagent'); assert.equal(worker.session.header.parentSession, parent.id)
    assert.equal(worker.projection.sidechain?.kind, 'dsh-child'); assert.equal(worker.projection.readOnly, false)
    assert.equal(worker.projection.capabilities.images, false); assert.equal(worker.projection.model, null)
    assert.deepEqual(text(worker), ['Answer from worker']); assert.deepEqual(text(parent), [])
    const baseline = worker.sourceFrameBaseline()
    await worker.refresh()
    assert.deepEqual(worker.sourceFrameBaseline(), baseline, 'unchanged history preserves its source version and body')
    assert.equal(projectedSourceEvents(worker).filter(event => event.type === 'turn/end').length, 0)
    assert.equal(worker.state.descriptor.lastTurnCompleted, true)
    const message = input(); worker.followup(message); await worker.journal.settled()
    assert.equal(source.mutations.length, 1); assert.equal(source.mutations[0]?.child, 'worker'); assert.equal(source.mutations[0]?.operation, 'prompt')
    assert.equal(worker.state.receipts[0]?.status, 'accepted'); assert.equal(worker.state.receipts[0]?.displayMessageId, message.id)
    assert.equal(source.parentWrites.length, 0)
    for (const value of parent.childSessions.filter(value => value.id !== worker.id)) {
      assert.equal(value.projection.readOnly, true); assert.throws(() => value.followup(input()), /continuable/)
      assert.throws(() => value.cancel({ kind: 'user' }), /continuable/)
    }
    let local = 0
    app.ctx.commands.register({ name: 'only-local', description: 'Fixture', handler: () => { local++; return { kind: 'success' } } })
    await assert.rejects(app.ctx.commands.execute(worker, '/only-local', [], new AbortController().signal), /local DSH commands/)
    assert.equal(local, 0); assert.throws(() => worker.inject(input()), /context injection/)
    assert.throws(() => worker.inbox.clear(), /queue editing/)
    worker.cancel({ kind: 'disposed' }); assert.equal(source.mutations.length, 1)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
  assert.equal(source.mutations.length, 1)
})

test('child interrupt acceptance does not invent execution completion and unknown prompts do not replay on reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-child-reconnect-')), source = new Source(); source.add('worker')
  const app = await mount(source, directory)
  try {
    const parent = app.service.list()[0]!, child = app.service.dshChild(parent.childSessions[0]!.id)!
    source.losePrompt = true
    const message = input(); child.steer(message); await child.journal.settled()
    assert.equal(child.state.receipts[0]?.status, 'unknown'); assert.equal(source.mutations.length, 1)
    source.change('worker', { activity: 'running', openSince: 2000, lastTurnCompleted: undefined })
    await parent.refresh(true); assert.equal(child.status, 'running')
    let idle = false; const settled = child.whenIdle().then(() => { idle = true })
    const receipt = await child.interrupt('explicit-child-interrupt')
    assert.equal(receipt.status, 'accepted'); assert.equal(child.status, 'running'); assert.equal(idle, false)
    await child.interrupt('explicit-child-interrupt'); assert.equal(source.mutations.length, 2)
    source.change('worker', { activity: 'inactive', openSince: undefined, settledMs: 80, lastTurnCompleted: false })
    await parent.refresh(true); await settled; assert.equal(idle, true)
    source.isConnected = false; source.emit({ type: 'connection-changed', data: { status: 'disconnected' } }); await app.service.settled()
    assert.equal(child.projection.readOnly, true); await assert.rejects(child.whenIdle(), /quiescence/)
    child.steer(message); await child.journal.settled(); assert.equal(source.mutations.length, 2)
    source.isConnected = true; source.emit({ type: 'connection-changed', data: { status: 'connected' } }); await app.service.settled()
    assert.equal(child.projection.readOnly, false); assert.equal(child.state.receipts[0]?.status, 'unknown'); assert.equal(source.mutations.length, 2)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('real child epoch corrections retain parent and child owners while replacing only source body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-child-epoch-')), source = new Source(); source.add('worker')
  const app = await mount(source, directory)
  try {
    const oldParent = app.service.list()[0]!, oldChild = app.service.dshChild(oldParent.childSessions[0]!.id)!
    const stream = oldChild.sourceFrames(new AbortController().signal)[Symbol.asyncIterator]()
    const baseline = (await stream.next()).value!
    source.epochs.set('worker', 'replacement-epoch')
    source.children.get('worker')![1] = { ...source.children.get('worker')![1]!, text: 'Corrected actual child answer' }
    const session = oldChild.session, journal = oldChild.journal
    await oldChild.refresh()
    const parent = app.service.list()[0]!, child = app.service.dshChild(parent.childSessions[0]!.id)!
    assert.equal(parent, oldParent); assert.equal(parent.displayRevision, 0); assert.equal(child, oldChild)
    assert.equal(child.session, session); assert.equal(child.journal, journal)
    const corrected = (await stream.next()).value!
    assert.equal(corrected.reset, true); assert.equal(corrected.historyVersion, baseline.historyVersion! + 1)
    assert.ok(session.snapshotEvents().every(event => String(event.type) !== SOURCE_FRAME_EVENT && event.type !== 'assistant/message'))
    assert.equal(app.ctx.agents.get(oldChild.id), oldChild); assert.equal(app.service.dshChild(oldChild.id), oldChild)
    assert.deepEqual(text(child), ['Corrected actual child answer']); assert.equal(source.mutations.length, 0)
    const waiting = stream.next()
    Object.assign(source.source.metadata!, { dshSubagents: [] }); source.source.metadataVersion++
    await parent.refresh(true)
    assert.equal(app.service.list()[0]!.childSessions.length, 0); assert.equal(app.service.dshChild(child.id), undefined)
    assert.equal((await waiting).done, true, 'retiring the child releases a reader awaiting its next source frame')
    assert.throws(() => child.followup(input()), /detached/)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a cached source child remains readable after restart while its original parent is offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-child-cache-')), source = new Source(); source.add('worker')
  let app = await mount(source, directory)
  try {
    const original = app.service.list()[0]!.childSessions[0]!, id = original.id
    await app.close(); source.source.active = false
    app = await mount(source, directory)
    const child = app.service.dshChild(id)!
    assert.ok(child); assert.equal(child.projection.readOnly, true); assert.deepEqual(text(child), ['Answer from worker'])
    assert.equal(child.state.history.complete, false); assert.match(child.state.history.error ?? '', /active Runner/)
    assert.throws(() => child.followup(input()), /active Runner/); assert.equal(source.mutations.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('official child-addressed history validates the real descriptor and catalog for every source observer mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-child-history-')), source = new Source()
  for (const mode of ['continuable', 'one-shot', 'external', 'unknown'] as const) source.add(mode, mode)
  const app = await mount(source, directory)
  try {
    const control = await controls(app.ctx), parent = app.service.list()[0]!
    const listed = await app.ctx.subagents.listChildren(parent.id)
    assert.equal(listed.length, 4)
    for (const value of parent.childSessions) {
      const child = app.service.dshChild(value.id)!, mode = child.state.descriptor.mode === 'continuable' ? 'continuable' : 'one-shot'
      const identity = app.ctx.sessionProjections.snapshot(child.session, ['subagent']).values.subagent
      assert.ok(identity); assert.equal(identity.mode, mode)
      const page = await control.invoke('session', 'page', { request: {
        address: { kind: 'subagent', parentSessionId: parent.id, childSessionId: child.id, mode },
        throughSeq: SessionSeq(child.session.seq - 1), maxMessages: 100,
      } }) as SessionPage
      assert.ok(page.records.length > 0)
      assert.ok(page.records.every(row => String(row.event.type) !== SOURCE_FRAME_EVENT && row.event.type !== 'assistant/message'),
        'the official child page carries operation records, never a second transcript')
      const sourceStream = child.sourceFrames(new AbortController().signal)[Symbol.asyncIterator]()
      const opening = await sourceStream.next(); await sourceStream.return?.()
      assert.ok((opening.value as SourceFrameBatch).frames.some(frame => frame.event.type === 'assistant/message'))
      assert.equal(child.projection.error, null)
      assert.equal(child.session.snapshotEvents().filter(event => event.type === 'subagent/descriptor').length, 1)
      assert.equal(projectedSourceEvents(child).filter(event => event.type === 'turn/end').length, 0)
    }
    const describe = (value: object) => remoteMethods(value).map(({ resources, ...rest }) => ({ ...rest, resources: Object.keys(resources ?? {}) }))
    assert.deepEqual(describe(app.ctx.subagents), describe(control.original))
    assert.equal(app.ctx.subagents instanceof SubagentRuntime, false)
    assert.ok(control.original instanceof SubagentRuntime)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('the actual official subagent Gateway keeps source request identity durable and rejects cross-parent or readonly writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-child-gateway-')), source = new Source()
  source.add('worker'); source.add('readonly', 'one-shot')
  const app = await mount(source, directory)
  try {
    const control = await controls(app.ctx), parent = app.service.list()[0]!
    const child = app.service.dshChild(parent.childSessions.find(value => value.scopeInfo.sourceAgentId === 'worker')!.id)!
    const readonly = parent.childSessions.find(value => value.scopeInfo.sourceAgentId === 'readonly')!
    const request: SubagentPromptRequest = { childSessionId: child.id, parentSessionId: parent.id, mode: 'continuable', delivery: 'queue',
      requestId: 'hapi-source-child:11111111-1111-4111-8111-111111111111' as SubagentPromptRequestId, content: [{ type: 'text', text: 'Continue the original source child' }], clientTimeZone: 'UTC' }
    await assert.rejects(control.invoke('subagents', 'prompt', { request: { ...request, requestId: 'ordinary-default-send' } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'subagent/delivery-unavailable' && error.message.includes('/child'))
    assert.equal(source.mutations.length, 0, 'Ordinary Send cannot start an uncorrelatable source prompt')
    source.losePrompt = true
    const first = await control.invoke('subagents', 'prompt', { request }) as SubagentPromptReceipt
    await child.journal.settled()
    const again = await control.invoke('subagents', 'prompt', { request }) as SubagentPromptReceipt
    await child.journal.settled()
    assert.equal(first.messageId, again.messageId); assert.equal(source.mutations.length, 1)
    assert.equal(child.state.receipts[0]?.status, 'unknown'); assert.equal(child.state.receipts[0]?.displayMessageId, first.messageId)
    assert.equal(child.state.receipts[0]?.clientRequestId, request.requestId)
    await assert.rejects(control.invoke('subagents', 'prompt', { request: { ...request, content: [{ type: 'text', text: 'Changed same intent' }] } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'subagent/delivery-unavailable')
    await assert.rejects(control.invoke('subagents', 'prompt', { request: { ...request, parentSessionId: SessionId('foreign-parent') } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'subagent/unauthorized')
    await assert.rejects(control.invoke('subagents', 'prompt', { request: { ...request, childSessionId: readonly.id } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'subagent/not-resumable')
    await assert.rejects(control.invoke('subagents', 'prompt', { request: { ...request, content: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }] } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'subagent/attachment-invalid')
    assert.equal(source.mutations.length, 1)
    source.change('worker', { activity: 'running', openSince: 3000 }); await parent.refresh(true)
    assert.deepEqual(await control.invoke('subagents', 'interruptByParent', { childSessionId: child.id, parentSessionId: parent.id, mode: 'continuable' }), { accepted: true })
    await child.journal.settled()
    assert.equal(source.mutations.length, 2); assert.equal(source.mutations[1]?.operation, 'interrupt'); assert.equal(child.status, 'running')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a changed source continuation mode retires the immutable official descriptor before admitting another prompt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-child-mode-')), source = new Source(); source.add('worker')
  const app = await mount(source, directory)
  try {
    const parent = app.service.list()[0]!, old = app.service.dshChild(parent.childSessions[0]!.id)!
    source.change('worker', { mode: 'one-shot' })
    await assert.rejects(old.refresh(), /continuation capability/)
    const current = app.service.list()[0]!.childSessions[0]!
    assert.notEqual(current.id, old.id); assert.equal(current.projection.readOnly, true)
    assert.throws(() => old.followup(input()), /detached/)
    assert.equal(source.mutations.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('opening a parent with forty children never waits for child transcripts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-open-fast-')), source = new Source()
  for (let index = 0; index < 40; index++) source.add(`bulk-${index}`, index % 2 ? 'continuable' : 'one-shot')
  let childReads = 0
  const originalRequest = source.request.bind(source)
  source.request = async (path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }) => {
    if (/\/dsh-subagents\/.+\/messages/.test(path)) childReads++
    return originalRequest(path, options)
  }
  const started = Date.now()
  const app = await mount(source, directory)
  try {
    const elapsed = Date.now() - started
    const parent = app.service.list()[0]!
    assert.ok(parent, 'the parent display attaches')
    assert.equal(parent.childSessions.length, 40, 'children register from descriptors immediately')
    assert.equal(childReads, 0, 'the parent open must not read a single child transcript')
    assert.ok(elapsed < 2000, `parent attach took ${elapsed}ms; it must not serialize child history`)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
