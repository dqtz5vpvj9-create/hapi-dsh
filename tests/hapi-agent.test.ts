import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { HapiRequestError, type HapiApprovalAnswer, type HapiEvent, type HapiMessage, type HapiMessagesPage,
  type HapiQueuedState, type HapiSendMessage, type HapiSession } from '../src/codex/contracts.js'
import { HapiAgentService, HapiObservedControl, type HapiAgentServiceOptions, type HapiObservedTransport } from '../src/hapi-agent/index.js'
import { parseObservedHistory, parseObservedMessage } from '../src/hapi-agent/parser.js'
import { SourceLifecycle } from '../src/hapi/source-lifecycle.js'
import { HistoryReadInvalidatedError } from '../src/codex/history-journal.js'

/** Explicit source-protocol fixtures. All DSH scopes, sessions, registries and command execution are real packages. */
class Fixture implements HapiObservedTransport {
  readonly hubId = 'observed-fixture-hub'
  isConnected = true
  readonly sources = new Map<string, HapiSession>()
  readonly rows = new Map<string, HapiMessage[]>()
  readonly sent: Array<{ source: string; value: HapiSendMessage }> = []
  readonly sendTargets: string[] = []
  sendHook: ((source: string, value: HapiSendMessage) => void) | undefined
  readonly answers: Array<{ source: string; id: string; answer: HapiApprovalAnswer; deny: boolean }> = []
  readonly requests: Array<{ path: string; method: string; body: unknown }> = []
  readonly listeners = new Set<(event: HapiEvent) => void>()
  sendFailure: Error | undefined
  writeFailure: Error | undefined
  modelCatalog: unknown = { success: true, availableModels: [] }
  queue: HapiQueuedState = { queuedLocalIds: [], invokedLocalMessages: [] }
  aborts = 0
  cancelled: string[] = []
  add(flavor: string, id = flavor): HapiSession {
    const source: HapiSession = { id, namespace: 'fixture', seq: 1, createdAt: 1000, updatedAt: 1000,
      active: true, activeAt: 1000, thinking: false, thinkingAt: 1000, metadataVersion: 1, agentStateVersion: 1,
      metadata: { path: '/fixture/project', host: 'Fixture Runner', machineId: 'machine', flavor,
        ...(flavor === 'claude' ? { claudeSessionId: 'claude-thread' } : flavor === 'pi' ? { piSessionId: 'pi-thread' } : {}),
        name: `Original ${flavor}` }, agentState: { requests: {}, completedRequests: {} }, model: 'fixture-model' }
    this.sources.set(id, source); this.rows.set(id, []); return source
  }
  async listSessions() { return [...this.sources.values()].map(value => structuredClone(value)) }
  async getSession(id: string) { const source = this.sources.get(id); if (!source) throw new HapiRequestError('Missing source', 'rejected', 404); return structuredClone(source) }
  async readMessages(id: string): Promise<HapiMessagesPage> {
    return { messages: structuredClone(this.rows.get(id) ?? []), page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
      nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } }
  }
  async sendMessage(source: string, value: HapiSendMessage) {
    this.sendTargets.push(source)
    // A hook throw is a Hub rejection, never a recorded delivery.
    this.sendHook?.(source, value)
    this.sent.push({ source, value: structuredClone(value) })
    if (this.sendFailure) throw this.sendFailure
  }
  async getQueuedState() { return structuredClone(this.queue) }
  async cancelQueuedMessage(_source: string, id: string) { this.cancelled.push(id); return { status: 'cancelled' as const, localId: id } }
  async steerQueuedMessage(_source: string, id: string) { return { status: 'steered' as const, localId: id } }
  async retryIndeterminateMessage(_source: string, id: string) { return { status: 'retried' as const, localId: id } }
  async abortSession() { this.aborts++ }
  async approve(source: string, id: string, answer: HapiApprovalAnswer) { this.answers.push({ source, id, answer, deny: false }) }
  async deny(source: string, id: string, answer: HapiApprovalAnswer = {}) { this.answers.push({ source, id, answer, deny: true }) }
  async listSlashCommands() { return [{ name: 'compact', description: 'Original source compact' }] }
  subscribe(listener: (event: HapiEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event: HapiEvent) { for (const listener of this.listeners) listener(event) }
  async request(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
    const method = options.method ?? 'GET'; this.requests.push({ path, method, body: options.body })
    if (method === 'GET') return structuredClone(this.modelCatalog)
    if (this.writeFailure) throw this.writeFailure
    const id = decodeURIComponent(path.split('/')[3] ?? '')
    const source = this.sources.get(id), body = options.body as Record<string, unknown> | undefined
    if (source && path.endsWith('/effort')) source.effort = body?.effort as string | null
    if (source && path.endsWith('/model')) {
      const model = body?.model
      if (typeof model === 'object' && model !== null) {
        const selected = model as { provider: string; modelId: string }
        source.metadata!.piSelectedModel = selected; source.model = selected.modelId; source.metadataVersion++
      } else source.model = model as string | null
    }
    if (source && method === 'PATCH') { source.metadata!.name = body?.name as string; source.metadataVersion++ }
    if (source && path.endsWith('/switch')) { source.agentState!.controlledByUser = false; source.agentStateVersion++ }
    return { ok: true }
  }
}

function row(id: string, index: number, role: string, content: unknown, extra: Partial<HapiMessage> = {}): HapiMessage {
  return { id, seq: index, localId: null, createdAt: 1000 + index * 100, content: { role, content }, ...extra }
}
function input(id = 'input', text = 'Original input'): HapiMessage { return row(id, 1, 'user', { type: 'text', text }, { localId: id, invokedAt: 1100 }) }
function codex(id: string, index: number, data: unknown): HapiMessage { return row(id, index, 'agent', { type: 'codex', data }) }
function ready(id = 'ready', index = 10): HapiMessage { return row(id, index, 'agent', { type: 'event', data: { type: 'ready' } }) }
async function mount(fixture: Fixture, directory: string, options: Partial<HapiAgentServiceOptions> = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime)
  let service: HapiAgentService | undefined
  await ctx.plugin(Object.assign(async (owner: Context) => {
    service = new HapiAgentService(owner, fixture, { stateDirectory: directory, ...options }); await service.start()
  }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
  assert.ok(service)
  return { ctx, service, async close() { await service!.dispose(); await ctx.fiber.dispose() } }
}

test('all existing non-native HAPI flavors enter real official Sessions with original ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new Fixture()
  for (const flavor of ['claude', 'codex', 'pi', 'cursor', 'qoder', 'dsh', 'grok', 'opencode', 'gemini', 'copilot', 'kimi', 'agy']) {
    source.add(flavor); source.rows.set(flavor, [input(), codex('answer', 2, { type: 'message', message: `Original ${flavor} answer` }), ready()])
  }
  const native = source.add('codex', 'native'); native.metadata!.codexNativeSession = true; native.metadata!.codexSessionId = 'native-thread'
  const app = await mount(source, directory)
  try {
    assert.equal(app.service.list().length, 12); assert.equal(app.service.byHapiSession('native'), undefined)
    for (const agent of app.service.list()) {
      assert.equal(app.ctx.agents.get(agent.id), agent); assert.equal(app.ctx.sessions.get(agent.id), agent.session)
      assert.equal(agent.projection.ownership, 'hapi-runner'); assert.equal(agent.projection.engine, 'hapi')
      assert.equal(agent.session.header.agentPreset, undefined, 'an observed source engine is not a DSH preset composition')
      assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
      assert.equal(agent.resolveRewindLocalId('hapi-observed:user:input'), 'input')
      const seq = agent.resolveSourceMessageDisplaySeq('input'); assert.notEqual(seq, undefined)
      assert.equal(agent.sourceMessageAtDisplaySeq(seq!), 'input')
      assert.equal(agent.sourceMessageAtDisplaySeq(-1), undefined)
      assert.equal(agent.resolveRewindLocalIdAtSeq(seq!), 'input')
      assert.equal(agent.resolveRewindLocalIdAtSeq(seq! + 1), undefined)
    }
    assert.equal(source.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Claude SDK blocks retain source model, actual tool correlation and authorized rich resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new Fixture(); source.add('claude')
  source.rows.set('claude', [row('user', 1, 'user', { type: 'text', text: 'Read these', attachments: [
    { id: 'upload', filename: 'source.txt', mimeType: 'text/plain', path: '/runner/upload', size: 3 },
  ] }, { localId: 'original-local', invokedAt: 1100 }),
  row('sdk-assistant', 2, 'agent', { type: 'output', data: { type: 'assistant', uuid: 'sdk-1', message: { model: 'source-claude', content: [
    { type: 'thinking', thinking: 'Considering the original request' },
    { type: 'tool_use', id: 'tool-original', name: 'Read', input: { file_path: '/runner/upload' } },
  ] } } }),
  row('sdk-tool', 3, 'agent', { type: 'output', data: { type: 'user', uuid: 'sdk-2', message: { content: [
    { type: 'tool_result', tool_use_id: 'tool-original', content: [{ type: 'text', text: 'Source bytes' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eHl6' } }] },
  ] } } }),
  row('sdk-final', 4, 'agent', { type: 'output', data: { type: 'assistant', uuid: 'sdk-3', message: { model: 'source-claude', content: [{ type: 'text', text: 'Actual final answer' }] } } }), ready()])
  const imports: string[] = []
  const app = await mount(source, directory, {
    importAttachment: async (id, ref) => { imports.push(`${id}:${ref.path}`); return { type: 'file', attachment: { attachmentId: AttachmentId('fixture-upload'), bytes: 3, name: ref.filename } } },
    importInline: async (id, ref) => { imports.push(`${id}:${ref.base64}`); return { type: 'file', attachment: { attachmentId: AttachmentId('fixture-image'), bytes: 3, name: 'source-image' } } },
  })
  try {
    const agent = app.service.list()[0]!, events = agent.session.snapshotEvents()
    const user = events.find(event => event.type === 'user/message'); assert.ok(user?.type === 'user/message')
    assert.equal(user.data.content[1]?.type, 'file')
    const call = events.find(event => event.type === 'tool/call'), result = events.find(event => event.type === 'tool/result')
    assert.ok(call?.type === 'tool/call' && result?.type === 'tool/result'); assert.equal(call.data.callId, result.data.message.toolCallId)
    assert.equal(result.data.message.content[1]?.type, 'file')
    assert.deepEqual(imports, ['claude:/runner/upload', 'claude:eHl6'])
    const answer = events.filter(event => event.type === 'assistant/message').at(-1)
    assert.ok(answer?.type === 'assistant/message'); assert.equal(answer.data.message.source.model, 'source-claude')
    await agent.refresh(true); assert.equal(imports.length, 2)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Pi cumulative snapshots converge on one official answer and do not invent native executions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new Fixture(); source.add('pi')
  const rows = [input(), codex('delta1', 2, { type: 'message', id: 'pi-stream', streamSnapshot: true, message: 'Part' }),
    codex('delta2', 3, { type: 'message', id: 'pi-stream', streamSnapshot: true, message: 'Partial source answer' }), ready()]
  source.rows.set('pi', rows)
  assert.ok(parseObservedHistory(rows).every(item => !('execution' in item)))
  const app = await mount(source, directory)
  try {
    const agent = app.service.list()[0]!, answers = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    assert.equal(answers.length, 1); assert.ok(answers[0]?.type === 'assistant/message')
    assert.deepEqual(answers[0].data.message.content, [{ type: 'text', text: 'Partial source answer' }])
    await agent.refresh(true)
    assert.equal(app.service.list()[0]!.displayRevision, 0)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 1)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('source delivery remains unknown after disconnect and restart, without automatic replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new Fixture(); source.add('claude')
  source.sendFailure = new HapiRequestError('Fixture lost reply', 'indeterminate')
  let app = await mount(source, directory)
  try {
    const message = freezeMessage({ id: MessageId('source-send-id'), role: 'user', source: { kind: 'user', rpcId: 'stable-send' }, content: [{ type: 'text', text: 'One original send' }] })
    const agent = app.service.list()[0]!; agent.followup(message); await agent.journal.settled()
    assert.equal(source.sent.length, 1); assert.equal(agent.projection.delivery[0]?.state, 'indeterminate')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0)
    await app.close(); app = await mount(source, directory)
    app.service.list()[0]!.followup(message); await app.service.list()[0]!.journal.settled(); assert.equal(source.sent.length, 1)
    source.isConnected = false; source.emit({ type: 'connection-changed', data: { status: 'disconnected' } }); await app.service.settled()
    // A disconnected source is not a fake read-only lock. The same durable
    // delivery identity remains unchanged, so this cannot replay the message.
    app.service.list()[0]!.followup(message); await app.service.list()[0]!.journal.settled()
    assert.equal(source.sent.length, 1)
    assert.equal(source.aborts, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('observed cache attach keeps live output moving while a blocked history snapshot backfills a missing row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-live-first-')), source = new Fixture()
  source.add('claude')
  const cached = [input(), codex('cached', 2, { type: 'message', message: 'Cached source answer' })]
  source.rows.set('claude', cached)
  let app = await mount(source, directory), release: ((value: HapiMessagesPage) => void) | undefined
  try {
    await app.close()
    const missing = codex('missing', 3, { type: 'message', message: 'Previously missing source row' })
    const live = codex('live', 4, { type: 'message', message: 'Live source answer' })
    const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve })
    const read = source.readMessages.bind(source)
    const snapshot = await read('claude')
    source.readMessages = () => blocked
    app = await mount(source, directory, { fastHistorySeed: true })
    const initial = app.service.list()[0]!
    assert.match(initial.projection.error ?? '', /stale/)
    source.emit({ type: 'message-received', sessionId: 'claude', message: live })
    for (let index = 0; index < 200 && initial.resolveSourceMessageDisplaySeq(live.id) === undefined; index++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.notEqual(initial.resolveSourceMessageDisplaySeq(live.id), undefined, 'live output does not wait for full history')
    release!({ ...snapshot, messages: [...cached, missing] }); release = undefined
    await app.service.settled()
    const current = app.service.list()[0]!, answers = current.session.snapshotEvents().flatMap(event =>
      event.type === 'assistant/message' ? event.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : [])
    assert.deepEqual(answers, ['Cached source answer', 'Previously missing source row', 'Live source answer'])
    assert.equal(current.binding.nativeId, initial.binding.nativeId)
    assert.equal(current.projection.error, null)
    assert.equal(source.sent.length, 0); assert.equal(source.aborts, 0)
  } finally {
    release?.({ messages: [], page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
      nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } })
    await app.close(); await rm(directory, { recursive: true, force: true })
  }
})

test('Pi extension answers preserve editor payload and wait for actual final completedRequests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new Fixture(), pi = source.add('pi')
  pi.agentState!.requests = { editor: { tool: 'request_user_input', arguments: { questions: [{ id: 'editor', header: 'Edit', question: 'Edit', required: true,
    inputType: 'editor', prefill: 'line one\nline two', options: [] }] } } }
  const app = await mount(source, directory)
  try {
    const agent = app.service.list()[0]!
    assert.equal(agent.projection.pendingRequests[0]?.tool, 'request_user_input')
    assert.deepEqual(await agent.answerApproval('editor', { answers: { editor: { answers: ['new line\nother line'] } } }), { stage: 'submitted' })
    assert.equal(agent.projection.pendingRequests[0]?.stage, 'submitted'); assert.equal(source.answers.length, 1)
    assert.deepEqual(source.answers[0]?.answer, { answers: { editor: { answers: ['new line\nother line'] } } })
    pi.agentState = { requests: {}, completedRequests: { editor: { tool: 'request_user_input', arguments: {}, status: 'approved', completedAt: 2000 } } }; pi.agentStateVersion++
    await agent.refresh(); assert.equal(agent.projection.pendingRequests.length, 0); assert.equal(agent.projection.resolvedRequests[0]?.status, 'approved')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('source setting catalogs preserve Pi provider identity and Qoder option ids; HTTP 401 cannot authorize replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new Fixture(), pi = source.add('pi'), qoder = source.add('qoder')
  pi.metadata!.piSelectedModel = { provider: 'provider-one', modelId: 'same-name' }; pi.model = 'same-name'
  qoder.metadata!.qoderConfigOptions = [{ id: 'model', category: 'model', currentValue: 'qoder-model', options: [{ value: 'qoder-model' }] },
    { id: 'reasoning_effort', category: 'model', options: [{ value: 'high', name: 'High' }] }]
  source.modelCatalog = { success: true, availableModels: [{ provider: 'provider-one', modelId: 'same-name', reasoning: true, thinkingLevelMap: { max: null, xhigh: 'high' } },
    { provider: 'provider-two', modelId: 'same-name', reasoning: true }] }
  const app = await mount(source, directory), controls = new HapiObservedControl(source, app.service, directory)
  try {
    const agent = app.service.byHapiSession('pi')!, settings = await controls.settings({ sessionId: agent.id })
    assert.equal(settings.permissions.length, 0); assert.equal(settings.editable.permission, false)
    assert.equal(settings.models.length, 2); assert.ok(settings.efforts.some(option => option.value === 'xhigh')); assert.ok(!settings.efforts.some(option => option.value === 'max'))
    const q = await controls.settings({ sessionId: app.service.byHapiSession('qoder')!.id })
    assert.deepEqual(q.models.map(model => model.value), ['qoder-model', 'fixture-model']); assert.deepEqual(q.efforts, [{ value: 'high', label: 'High' }])
    source.writeFailure = new HapiRequestError('Fixture HTTP 401 after dispatch', 'indeterminate', 401)
    const operationId = randomUUID(), request = { sessionId: agent.id, operationId, change: { kind: 'model' as const, value: { provider: 'provider-two', modelId: 'same-name' } } }
    const receipt = await controls.applySetting(request); assert.equal(receipt.status, 'indeterminate')
    assert.deepEqual(source.requests.find(item => item.method === 'POST')?.body, { model: { provider: 'provider-two', modelId: 'same-name' } })
    await controls.applySetting(request); await controls.readSetting({ sessionId: agent.id, operationId })
    const restored = new HapiObservedControl(source, app.service, directory); await restored.applySetting(request)
    assert.equal(source.requests.filter(item => item.method === 'POST').length, 1)
    pi.metadata!.piSelectedModel = { provider: 'provider-two', modelId: 'same-name' }; pi.metadataVersion++
    assert.equal((await restored.readSetting({ sessionId: agent.id, operationId })).status, 'applied')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('observed settings and confirmation recover a history read collision without fetching history or replaying a write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-settings-')), source = new Fixture()
  source.add('claude')
  const app = await mount(source, directory), controls = new HapiObservedControl(source, app.service, directory)
  try {
    const agent = app.service.list()[0]!
    source.readMessages = async () => { throw new Error('History must stay independent of settings') }
    agent.refresh = async () => { throw new Error('Settings must not use a full source refresh') }
    agent.reportError(new HistoryReadInvalidatedError())
    assert.equal(agent.projection.readOnly, true)
    assert.equal((await controls.settings({ sessionId: agent.id })).readOnly, false)
    assert.equal(agent.projection.error, null)
    const request = { sessionId: agent.id, operationId: randomUUID(), change: { kind: 'effort', value: 'high' } as const }
    assert.equal((await controls.applySetting(request)).status, 'applied')
    agent.reportError(new HistoryReadInvalidatedError())
    assert.equal((await controls.readSetting(request)).status, 'applied')
    await controls.applySetting(request)
    assert.equal(source.requests.filter(call => call.method === 'POST').length, 1)
    agent.reportError(new Error('Original source identity is unavailable'))
    agent.reportError(new HistoryReadInvalidatedError())
    assert.equal((await controls.settings({ sessionId: agent.id })).readOnly, true)
    assert.equal(agent.projection.error, 'Original source identity is unavailable')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('scheduled source delivery has one durable identity and survives view disposal without a local timer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new Fixture(); source.add('pi')
  let app = await mount(source, directory)
  try {
    const agent = app.service.list()[0]!, operationId = randomUUID(), scheduledAt = Date.now() + 60_000
    agent.scheduleText({ operationId, text: 'Do this later', scheduledAt }); await agent.journal.settled()
    assert.equal(source.sent[0]?.value.scheduledAt, scheduledAt)
    agent.scheduleText({ operationId, text: 'Do this later', scheduledAt }); assert.equal(source.sent.length, 1)
    assert.throws(() => agent.scheduleText({ operationId, text: 'Changed', scheduledAt }), /identity/)
    assert.throws(() => agent.scheduleText({ operationId: randomUUID(), text: 'Too late', scheduledAt: Date.now() + 8 * 24 * 60 * 60 * 1000 }), /seven days/)
    await agent.abort(false); assert.deepEqual(source.cancelled, [])
    const aborts = source.aborts; await app.close(); assert.equal(source.aborts, aborts)
    app = await mount(source, directory); app.service.list()[0]!.scheduleText({ operationId, text: 'Do this later', scheduledAt })
    assert.equal(source.sent.length, 1)
    const restored = app.service.list()[0]!
    source.isConnected = false; source.sources.get('pi')!.active = false
    source.emit({ type: 'connection-changed', data: { status: 'disconnected' } }); await app.service.settled()
    assert.equal(restored.scheduleReceipt(operationId)?.scheduledAt, scheduledAt)
    assert.equal(restored.scheduleReceipt('missing'), null); assert.equal(source.sent.length, 1)
    // Scheduling is message input: an offline/inactive source keeps the same
    // durable operation identity and never replays it.
    assert.equal(restored.scheduleText({ operationId, text: 'Do this later', scheduledAt }).localId,
      restored.scheduleReceipt(operationId)?.localId)
    assert.equal(source.sent.length, 1)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('source lifecycle consumes an actual official user event seq and attaches the original engine fork as another official Session', async () => {
  class ForkFixture extends Fixture {
    override async request(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
      if (!path.endsWith('/fork')) return super.request(path, options)
      this.requests.push({ path, method: options.method ?? 'GET', body: options.body })
      assert.deepEqual(options.body, { messageLocalId: 'original-invoked-local' })
      const child = this.add('pi', 'original-child')
      child.metadata!.piSessionId = 'actual-child-native-thread'; child.metadata!.forkedFrom = 'pi'
      this.rows.set(child.id, [input('original-invoked-local')])
      return { sessionId: child.id }
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new ForkFixture(), original = source.add('pi')
  original.metadata!.capabilities = { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } }
  source.rows.set('pi', [input('original-invoked-local'), codex('answer', 2, { type: 'message', message: 'Source answer' }), ready()])
  const app = await mount(source, directory), lifecycle = new SourceLifecycle(source, app.service, directory)
  try {
    const agent = app.service.byHapiSession('pi')!, seq = agent.resolveSourceMessageDisplaySeq('original-invoked-local')
    assert.notEqual(seq, undefined)
    const user = agent.session.snapshotEvents().find(event => event.seq === seq)
    assert.equal(user?.type, 'user/message')
    const request = { sessionId: agent.id, operationId: randomUUID(), action: { kind: 'fork' as const, displayMessageSeq: seq! } }
    const result = await lifecycle.operate(request)
    assert.equal(result.status, 'confirmed')
    const child = app.service.byHapiSession('original-child')!
    assert.equal(child.binding.nativeId, 'actual-child-native-thread')
    assert.equal(app.ctx.agents.get(child.id), child); assert.equal(app.ctx.sessions.get(child.id), child.session)
    assert.equal(child.projection.ownership, 'hapi-runner'); assert.equal(child.projection.flavor, 'pi')
    assert.equal(child.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1)
    await lifecycle.operate(request); assert.equal(source.requests.filter(row => row.path.endsWith('/fork')).length, 1)
    assert.equal(source.sent.length, 0); assert.equal(source.aborts, 0)
  } finally { await lifecycle.settled(); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('source command scope prevents official global handlers from mutating a HAPI-owned session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-')), source = new Fixture(); source.add('claude')
  const app = await mount(source, directory)
  try {
    let globalCalls = 0
    app.ctx.commands.register({ name: 'compact', description: 'Official fixture handler', handler: () => { globalCalls++; return { kind: 'success' } } })
    app.ctx.commands.register({ name: 'later-global', description: 'Late plugin registration', handler: () => { globalCalls++; return { kind: 'success' } } })
    const agent = app.service.list()[0]!
    const result = await app.ctx.commands.execute(agent, '/compact exact trailing text', [], new AbortController().signal)
    assert.equal(result?.result.kind, 'success'); await agent.journal.settled()
    await app.ctx.commands.execute(agent, '/later-global', [], new AbortController().signal); await agent.journal.settled()
    assert.equal(globalCalls, 0); assert.deepEqual(source.sent.map(value => value.value.text), ['/compact exact trailing text', '/later-global'])
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('parser distinguishes live source snapshots, terminal facts and queued human input', () => {
  const queued = parseObservedMessage(row('pending', 1, 'user', { type: 'text', text: 'waiting' }, { localId: 'pending-local', invokedAt: null }))
  assert.equal(queued[0]?.kind, 'user'); assert.ok(queued[0]?.kind === 'user'); assert.equal(queued[0].invoked, false)
  const live = parseObservedMessage(codex('thinking', 2, { type: 'reasoning', id: 'thought', message: 'Reasoning', live: true }))
  assert.ok(live[0]?.kind === 'assistant'); assert.equal(live[0].live, true)
  assert.equal(parseObservedMessage(ready())[0]?.kind, 'end')
})

// ---------------------------------------------------------------------------
// R4: only original-engine input ownership is read-only; inactive sources are
// resumed before delivery per HAPI's resolve-before-send ordering.
// ---------------------------------------------------------------------------

test('an observed engine owning local input keeps the accurate admission block', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-owned-')), source = new Fixture()
  const claude = source.add('claude')
  claude.agentState = { ...claude.agentState, controlledByUser: true }
  const app = await mount(source, directory)
  try {
    const agent = app.service.list()[0]!
    assert.equal(agent.projection.readOnly, true)
    assert.equal(agent.projection.readOnlyReason, 'engine-owned')
    assert.equal(agent.projection.capabilities.switchToRemote, true)
    assert.throws(() => agent.followup(freezeMessage({ id: MessageId('owned-block'), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Do not send' }] })), /local terminal.*remote control/)
    assert.equal(source.sent.length, 0, 'the original engine owns input, so nothing is journaled for delivery')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('an inactive observed source resumes the original session before delivery and sends once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-resume-')), source = new Fixture()
  const claude = source.add('claude')
  claude.active = false
  const resumes: string[] = []
  const app = await mount(source, directory, { resumeSession: async id => { resumes.push(id); return id } })
  try {
    const agent = app.service.list()[0]!
    assert.equal(agent.projection.readOnlyReason, 'unavailable')
    agent.followup(freezeMessage({ id: MessageId('observed-inactive'), role: 'user', source: { kind: 'user', rpcId: 'observed-inactive' },
      content: [{ type: 'text', text: 'Deliver after resume' }] }))
    await agent.journal.settled()
    assert.deepEqual(resumes, ['claude'])
    assert.deepEqual(source.sendTargets, ['claude'])
    assert.equal(source.sent.length, 1)
    assert.equal(agent.projection.delivery[0]?.state, 'accepted')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a confirmed session_inactive rejection resumes once and retries the same durable source delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-race-')), source = new Fixture()
  source.add('claude')
  const resumes: string[] = []
  source.sendHook = () => { throw new HapiRequestError('Session is inactive', 'rejected', 409, 'session_inactive') }
  const app = await mount(source, directory, { resumeSession: async id => { resumes.push(id); source.sendHook = undefined; return id } })
  try {
    const agent = app.service.list()[0]!
    agent.followup(freezeMessage({ id: MessageId('observed-race'), role: 'user', source: { kind: 'user', rpcId: 'observed-race' },
      content: [{ type: 'text', text: 'Race the source shutdown' }] }))
    await agent.journal.settled()
    assert.deepEqual(resumes, ['claude'])
    assert.deepEqual(source.sendTargets, ['claude', 'claude'])
    assert.equal(source.sent.length, 1)
    assert.equal(source.sent[0]?.value.localId, 'dsh:observed-race')
    assert.equal(agent.projection.delivery[0]?.state, 'accepted')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a failed original-source resume leaves an explicit retryable delivery without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-resume-failed-')), source = new Fixture()
  const claude = source.add('claude')
  claude.active = false
  let fail = true
  const app = await mount(source, directory, { resumeSession: async () => {
    if (fail) throw new HapiRequestError('Original session resume is unavailable', 'rejected', 409, 'resume_unavailable')
    return 'claude'
  } })
  try {
    const agent = app.service.list()[0]!
    agent.followup(freezeMessage({ id: MessageId('observed-resume-failed'), role: 'user', source: { kind: 'user', rpcId: 'observed-resume-failed' },
      content: [{ type: 'text', text: 'Keep this draft' }] }))
    await agent.journal.settled()
    assert.equal(source.sendTargets.length, 0)
    const failed = agent.projection.delivery[0]!
    assert.equal(failed.state, 'rejected')
    assert.match(failed.error ?? '', /resume is unavailable/)
    assert.equal(failed.text, 'Keep this draft')
    fail = false
    agent.retryRejectedDelivery('dsh:observed-resume-failed')
    await agent.journal.settled()
    assert.deepEqual(source.sendTargets, ['claude'], 'only the explicit retry delivers')
    assert.equal(agent.projection.delivery[0]?.state, 'accepted')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('observed removal during initial history prevents a stale catalog from recreating the source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-removed-attach-')), fixture = new Fixture(), source = fixture.add('pi')
  let release!: (value: HapiMessagesPage) => void, reading!: () => void
  const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reading = resolve })
  const original = fixture.readMessages.bind(fixture), snapshot = await original(source.id)
  fixture.readMessages = async () => { reading(); return blocked }
  const mounting = mount(fixture, directory)
  await started; fixture.emit({ type: 'session-removed', sessionId: source.id }); release(snapshot)
  const app = await mounting
  try {
    await app.service.settled(); assert.equal(app.service.list().length, 0)
    await app.service.refreshCatalog(); assert.equal(app.service.list().length, 0)
    assert.equal(fixture.sent.length, 0); assert.equal(fixture.aborts, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('observed replacement preparation retries independently of the disposed old Agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-observed-replacement-retry-')), fixture = new Fixture(), source = fixture.add('pi')
  const latest = codex('latest', 3, { type: 'message', message: 'Current answer' })
  fixture.rows.set(source.id, [input(), latest])
  const resets: Array<[string, string]> = []
  const app = await mount(fixture, directory, { onDisplayReset: (before, after) => { resets.push([before, after]) } })
  try {
    const previous = app.service.list()[0]!, missing = codex('older', 2, { type: 'message', message: 'Recovered answer' })
    const original = fixture.getSession.bind(fixture); let snapshots = 0
    fixture.getSession = async id => { if (++snapshots === 2) throw new Error('Replacement source temporarily unavailable'); return original(id) }
    fixture.rows.set(source.id, [input(), missing, latest])
    fixture.emit({ type: 'message-updated', sessionId: source.id })
    for (let index = 0; index < 300 && (app.service.list()[0]?.displayRevision ?? 0) < 2; index++) await new Promise(resolve => setTimeout(resolve, 10))
    await app.service.settled()
    const current = app.service.list()[0]!
    assert.ok(current); assert.ok(current.displayRevision >= 2)
    assert.notEqual(current.resolveSourceMessageDisplaySeq(missing.id), undefined)
    assert.equal(app.ctx.sessions.get(previous.id), undefined)
    assert.deepEqual(resets, [[previous.id, current.id]])
    assert.equal(fixture.sent.length, 0); assert.equal(fixture.aborts, 0); assert.equal(fixture.answers.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
