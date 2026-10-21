import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage, freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  HapiRequestError, type HapiApprovalAnswer, type HapiCancelResult, type HapiEvent, type HapiMessage,
  type HapiMessagesPage, type HapiMessagesQuery, type HapiQueuedState, type HapiRetryResult,
  type HapiSendMessage, type HapiSession, type HapiSteerResult, type HapiTransport,
} from '../src/codex/contracts.js'
import { bindingFor, nativeSessionId, parseNativeRow } from '../src/codex/native.js'
import { NativeProjector } from '../src/codex/projector.js'
import { DeliveryJournal } from '../src/codex/delivery.js'
import { NativeApprovals } from '../src/codex/approvals.js'
import { readNativeHistory } from '../src/codex/history.js'
import { CodexService, type CodexServiceOptions } from '../src/codex/service.js'

const THREAD = 'native-thread-1'
const TURN = 'native-turn-1'

/** Protocol fixture only. All Session, AgentRegistry, scopes and projections are real pinned DSH packages. */
class FakeHapi implements HapiTransport {
  readonly hubId = 'test-hub'
  readonly listeners = new Set<(event: HapiEvent) => void>()
  readonly sent: HapiSendMessage[] = []
  readonly answers: Array<{ requestId: string; answer: HapiApprovalAnswer; deny: boolean }> = []
  readonly cancelCalls: string[] = []
  aborts = 0
  sendFailure: Error | undefined
  answerFailure: Error | undefined
  historyFailure: Error | undefined
  cancelResult: HapiCancelResult = { status: 'cancelled', localId: null }
  queue: HapiQueuedState = { queuedLocalIds: [], invokedLocalMessages: [] }
  rows: HapiMessage[] = []
  reads: HapiMessagesQuery[] = []
  readHook: ((query: HapiMessagesQuery) => HapiMessagesPage) | undefined
  source: HapiSession = {
    id: 'hapi-session-1', namespace: 'test', seq: 1, createdAt: 1000, updatedAt: 1000,
    active: true, activeAt: 1000, thinking: false, thinkingAt: 1000,
    metadataVersion: 1, agentStateVersion: 1, model: 'gpt-native-fixture',
    metadata: { path: '/workspace/test', host: 'Runner one', machineId: 'machine-1', flavor: 'codex',
      codexNativeSession: true, codexNativeConnection: 'attached', codexSessionId: THREAD,
      codexHome: '/runner/codex-home', codexHomeId: 'home-1', name: 'Native fixture' },
    agentState: { requests: {}, completedRequests: {} },
    executionVersion: 1,
    execution: { owner: 'codex', generation: 'connection-1', sequence: 1, status: 'idle', waitingOn: [],
      turnId: null, startedAt: null, completedAt: null },
  }
  async listSessions() {
    const { codexNativeSession: _native, codexNativeConnection: _connection, ...metadata } = this.source.metadata!
    return [{ ...this.source, metadata }]
  }
  async getSession(): Promise<HapiSession> { return structuredClone(this.source) }
  async readMessages(_id: string, query: HapiMessagesQuery = {}): Promise<HapiMessagesPage> {
    this.reads.push(query)
    if (this.historyFailure) throw this.historyFailure
    return this.readHook?.(query) ?? page(this.rows)
  }
  async sendMessage(_id: string, message: HapiSendMessage): Promise<void> {
    this.sent.push(structuredClone(message))
    if (this.sendFailure) throw this.sendFailure
  }
  async getQueuedState(): Promise<HapiQueuedState> { return structuredClone(this.queue) }
  async cancelQueuedMessage(_id: string, messageId: string): Promise<HapiCancelResult> {
    this.cancelCalls.push(messageId)
    return this.cancelResult
  }
  async steerQueuedMessage(_id: string, messageId: string): Promise<HapiSteerResult> { return { status: 'steered', localId: messageId } }
  async retryIndeterminateMessage(_id: string, messageId: string): Promise<HapiRetryResult> { return { status: 'retried', localId: messageId } }
  async abortSession(): Promise<void> { this.aborts++ }
  async approve(_id: string, requestId: string, answer: HapiApprovalAnswer): Promise<void> {
    this.answers.push({ requestId, answer, deny: false }); if (this.answerFailure) throw this.answerFailure
  }
  async deny(_id: string, requestId: string, answer: HapiApprovalAnswer = {}): Promise<void> {
    this.answers.push({ requestId, answer, deny: true }); if (this.answerFailure) throw this.answerFailure
  }
  subscribe(listener: (event: HapiEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event: HapiEvent): void { for (const listener of this.listeners) listener(event) }
}

function page(rows: readonly HapiMessage[], overrides: Partial<HapiMessagesPage['page']> = {}): HapiMessagesPage {
  return { messages: structuredClone([...rows]), page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
    nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null,
    snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false, ...overrides } }
}

function user(localId = 'native-input-1', invoked = true, text = 'Hello from the original Codex TUI'): HapiMessage {
  return { id: `row:${localId}`, localId, seq: 1, createdAt: 1100, invokedAt: invoked ? 1100 : null,
    content: { role: 'user', content: { type: 'text', text }, meta: invoked
      ? { nativeExecution: { threadId: THREAD, turnId: TURN, itemId: `item:${localId}` } } : { isNativeQueuedMessage: true } } }
}

function agentBody(type: string, fields: Record<string, unknown>, itemId: string, final = true): HapiMessage {
  const stable = `codex:${THREAD}:${TURN}:${itemId}:${type}`
  return { id: final ? `native:${stable}` : `ephemeral:${stable}:${String(fields.message)}`, localId: final ? stable : null,
    seq: 2, createdAt: 1200,
    content: { role: 'agent', content: { type: 'codex', data: { type, id: stable, ...fields,
      nativeExecution: { threadId: THREAD, turnId: TURN, itemId } } } } }
}

function terminal(status: 'completed' | 'interrupted' | 'failed' = 'completed'): HapiMessage {
  const result = agentBody('native-turn', {}, `lifecycle-${status}`)
  result.createdAt = 2000
  const outer = result.content as { content: { data: Record<string, unknown> } }
  outer.content.data.nativeExecution = { threadId: THREAD, turnId: TURN,
    turn: { status, started: true, ended: true } }
  return result
}

async function mount(fake: FakeHapi, directory: string, options: Partial<CodexServiceOptions> = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  let service: CodexService | undefined
  await ctx.plugin(Object.assign(async (owner: Context) => {
    service = new CodexService(owner, fake, { stateDirectory: directory, ...options })
    await service.start()
  }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
  assert.ok(service)
  const mounted = service
  return { ctx, service: mounted, async close() { await mounted.dispose(); await ctx.fiber.dispose() } }
}

test('native scheduled delivery remains source-owned through abort, view closure and offline receipt recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-')), fake = new FakeHapi()
  let app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!, operationId = randomUUID(), scheduledAt = Date.now() + 60_000
    const original = agent.scheduleText({ operationId, text: 'Run when the original timer fires', scheduledAt })
    await agent.journal.settled()
    assert.equal(fake.sent[0]?.scheduledAt, scheduledAt)
    await assert.rejects(agent.steerQueued(original.localId), /scheduled/)
    await agent.abort(false); assert.deepEqual(fake.cancelCalls, [])
    const aborts = fake.aborts
    await app.close(); assert.equal(fake.aborts, aborts)
    fake.source.active = false
    app = await mount(fake, directory)
    const restored = app.service.list()[0]!
    fake.emit({ type: 'connection-changed', data: { status: 'disconnected' } }); await app.service.settled()
    assert.equal(restored.scheduleReceipt(operationId)?.localId, original.localId)
    assert.equal(restored.scheduleReceipt(operationId)?.scheduledAt, scheduledAt)
    assert.equal(restored.scheduleReceipt('missing'), null); assert.equal(fake.sent.length, 1)
    assert.throws(() => restored.scheduleText({ operationId, text: 'Run when the original timer fires', scheduledAt }), /available|writable|inactive/)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native discovery uses detail facts missing from HAPI summaries and registers real DSH sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-'))
  const fake = new FakeHapi()
  fake.rows = [user(), agentBody('reasoning', { message: 'Considering the code' }, 'reasoning-1'),
    agentBody('tool-call', { callId: 'call-1', name: 'CodexBash', input: { command: 'pwd' } }, 'call-1'),
    agentBody('tool-call-result', { callId: 'call-1', output: '/workspace/test' }, 'call-1'),
    agentBody('message', { message: 'The project is ready.', streamSnapshot: true }, 'answer-1'), terminal()]
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]
    assert.ok(agent)
    assert.equal(app.ctx.agents.get(agent.id), agent)
    assert.equal(app.ctx.sessions.get(agent.id), agent.session)
    assert.equal(agent.options.provider, 'hapi-codex-native')
    const events = agent.session.snapshotEvents()
    assert.equal(agent.session.header.createdAt, fake.source.createdAt)
    assert.deepEqual(events.map(event => event.seq), events.map((_event, index) => index))
    assert.equal(events.find(event => event.type === 'user/message')?.time, 1100)
    assert.equal(events.find(event => event.type === 'assistant/message')?.time, 1200)
    assert.equal(events.find(event => event.type === 'turn/end')?.time, 2000)
    assert.equal(events.filter(event => event.type === 'user/message').length, 1)
    assert.equal(events.filter(event => event.type === 'assistant/message').length, 3)
    assert.equal(events.filter(event => event.type === 'tool/result').length, 1)
    assert.equal(events.filter(event => event.type === 'turn/start').length, 1)
    assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
    const displayedAnswer = events.find(event => event.type === 'assistant/message' && event.data.message.content.some(part => part.type === 'text'))
    assert.equal(displayedAnswer?.type, 'assistant/message')
    if (displayedAnswer?.type === 'assistant/message') {
      assert.deepEqual(agent.resolveForkBoundary(displayedAnswer.data.message.id), { threadId: THREAD, turnId: TURN, itemId: 'answer-1' })
    }
    assert.equal(agent.resolveForkBoundary('not-a-committed-message'), undefined)
    assert.equal(app.ctx.sessionProjections.snapshot(agent.session).values.hapi?.nativeId, THREAD)
    assert.equal(fake.sent.length, 0)
    assert.equal(fake.aborts, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('official command scope sends native control lines through the existing durable queue, without executing a global DSH handler', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-commands-'))
  const fake = new FakeHapi()
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    let globalCalls = 0
    app.ctx.commands.register({ name: 'compact', description: 'DSH-only compaction', handler: () => {
      globalCalls++; return { kind: 'success', text: 'DSH compaction ran' }
    } })
    assert.equal(app.ctx.commands.find(agent, 'compact')?.definitionId, 'hapi-dsh/native-codex/compact')
    const execution = await app.ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
    assert.equal(execution?.result.kind, 'success')
    assert.match(execution?.result.text ?? '', /Submitted.*outcome/)
    await agent.journal.settled()
    assert.equal(globalCalls, 0)
    assert.equal(fake.sent.length, 1)
    assert.equal(fake.sent[0]?.text, '/compact')
    assert.equal(fake.sent[0]?.localId, `dsh:native-command:${execution?.commandId}`)
    assert.equal(agent.projection.delivery[0]?.state, 'accepted')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 0)
    await agent.dispose()
    assert.equal(app.ctx.commands.find(agent, 'compact')?.definitionId, undefined)
    assert.equal(app.ctx.commands.find(agent, 'compact')?.description, 'DSH-only compaction')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native source notices, usage, and goal state survive a history refresh without inventing model turns or replaying commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-observations-'))
  const fake = new FakeHapi()
  fake.source.agentState = { threadGoal: { threadId: THREAD, objective: 'Finish the native task', status: 'paused', tokensUsed: 5 } }
  let app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    const status: HapiMessage = { id: 'hub-event-status', localId: null, seq: 88, createdAt: 2500,
      content: { role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Codex model: native-test-model' } } } }
    const usage = agentBody('token_count', { model: 'model-at-native-turn', info: {
      last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 },
      total: { inputTokens: 10000, outputTokens: 2000, cachedInputTokens: 6000 }, modelContextWindow: 128000,
    } }, 'usage')
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: status })
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: status })
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: usage })
    await app.service.settled()
    assert.equal(agent.projection.notices.length, 1)
    assert.equal(agent.projection.notices[0]?.text, 'Codex model: native-test-model')
    assert.equal(agent.projection.usage?.contextTokens, 100)
    assert.equal(agent.projection.usage?.cachedInputTokens, 60)
    assert.equal(agent.projection.usage?.total?.inputTokens, 10000)
    assert.equal(agent.projection.usage?.model, 'model-at-native-turn')
    assert.equal(agent.projection.threadGoal?.status, 'paused')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 0)
    // Native REST history omits Hub-only status events. They are not a rewind.
    await agent.refresh(true)
    assert.equal(app.service.list()[0]?.id, agent.id)
    assert.equal(agent.projection.notices.length, 1)
    fake.source.agentStateVersion++
    fake.source.agentState = { threadGoal: null }
    await agent.refresh()
    assert.equal(agent.projection.threadGoal, null)
    await app.close()
    app = await mount(fake, directory)
    assert.equal(app.service.list()[0]?.projection.notices.length, 1)
    assert.equal(app.service.list()[0]?.projection.usage?.contextTokens, 100)
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('actual native error text reaches the official terminal error and remains available as a source notice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-errors-'))
  const fake = new FakeHapi()
  fake.rows = [user(), agentBody('error', { message: 'Codex error: native capacity is unavailable' }, 'failure'), terminal('failed')]
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    assert.equal(end?.type, 'turn/end')
    if (end?.type === 'turn/end') {
      assert.equal(end.data.reason.kind, 'error')
      if (end.data.reason.kind === 'error') assert.equal(end.data.reason.error.message, 'Codex error: native capacity is unavailable')
    }
    assert.equal(agent.projection.notices[0]?.kind, 'error')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('source-confirmed identity rotation retires old native display admission and binds the new native thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-rotate-'))
  const fake = new FakeHapi()
  fake.rows = [user(), terminal()]
  const app = await mount(fake, directory)
  try {
    const original = app.service.list()[0]!
    const prompt = original.session.snapshotEvents().find(event => event.type === 'user/message')
    assert.ok(prompt?.type === 'user/message')
    assert.equal(original.resolveRewindLocalId(prompt.data.id), 'native-input-1')
    assert.equal(original.resolveRewindLocalId('item:native-input-1'), undefined)
    assert.equal(original.resolveRewindLocalId('hapi:not-a-user'), undefined)
    fake.source.metadataVersion++
    fake.source.metadata = { ...fake.source.metadata!, codexSessionId: 'replacement-native-thread', codexHome: '/runner/other-home', codexHomeId: 'home-2' }
    fake.rows = []
    const replacement = await app.service.reconcileSource(fake.source.id)
    assert.ok(replacement)
    assert.equal(replacement.logicalSessionId, original.logicalSessionId)
    assert.notEqual(replacement.id, original.id)
    assert.equal(replacement.binding.threadId, 'replacement-native-thread')
    assert.equal(replacement.binding.homeId, 'home-2')
    assert.equal(replacement.resolveRewindLocalId(prompt.data.id), undefined)
    assert.throws(() => original.followup(createUserMessage({ content: [{ type: 'text', text: 'Never retarget this old view' }], source: { kind: 'user' } })), /detached/)
    replacement.followup(createUserMessage({ content: [{ type: 'text', text: 'New source only' }], source: { kind: 'user' } }))
    await replacement.journal.settled()
    assert.equal(fake.sent.length, 1)
    assert.equal(fake.sent[0]?.text, 'New source only')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native lifecycle reconciliation refuses an unversioned identity change and keeps source-not-ready sessions read-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-unready-'))
  const fake = new FakeHapi()
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    fake.source.metadata = { ...fake.source.metadata!, codexSessionId: 'unversioned-native-thread' }
    await assert.rejects(app.service.reconcileSource(fake.source.id), /without advancing/)
    assert.equal(agent.projection.readOnly, true)
    fake.source.metadataVersion++
    delete fake.source.metadata.codexSessionId
    assert.equal(await app.service.reconcileSource(fake.source.id), undefined)
    assert.equal(agent.projection.readOnly, true)
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a replacement native identity never inherits the prior thread unknown deliveries or approval receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-bound-receipts-'))
  const fake = new FakeHapi()
  fake.source.agentState = { requests: { permission: { tool: 'CodexBash', arguments: { command: 'pwd' } } } }
  let app = await mount(fake, directory)
  try {
    const original = app.service.list()[0]!
    fake.sendFailure = new HapiRequestError('Source delivery acknowledgement was lost', 'indeterminate')
    original.followup(createUserMessage({ content: [{ type: 'text', text: 'Original thread only' }], source: { kind: 'user' } }))
    await original.journal.settled()
    fake.answerFailure = new HapiRequestError('Source approval acknowledgement was lost', 'indeterminate')
    await assert.rejects(original.answerApproval('permission', { decision: 'approved' }), /acknowledgement was lost/)
    assert.equal(original.projection.delivery[0]?.state, 'indeterminate')
    assert.equal(original.projection.pendingRequests[0]?.stage, 'indeterminate')
    fake.source.metadataVersion++
    fake.source.metadata = { ...fake.source.metadata!, codexSessionId: 'replacement-thread-with-independent-queue' }
    fake.source.agentStateVersion++
    // Native request IDs are not globally unique across thread lifetimes.
    fake.source.agentState = { requests: { permission: { tool: 'CodexBash', arguments: { command: 'whoami' } } } }
    const replacement = await app.service.reconcileSource(fake.source.id)
    assert.ok(replacement)
    assert.equal(replacement.projection.delivery.length, 0)
    assert.equal(replacement.projection.pendingRequests[0]?.stage, 'pending')
    await app.close()
    app = await mount(fake, directory)
    const restored = app.service.list()[0]!
    assert.equal(restored.projection.delivery.length, 0)
    assert.equal(restored.projection.pendingRequests[0]?.stage, 'pending')
    assert.equal(fake.sent.length, 1)
    assert.equal(fake.answers.length, 1)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('queued rich input from another native frontend retains official image/file blocks in the DSH inbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-external-queue-'))
  const fake = new FakeHapi()
  const pending = user('other-frontend-input', false, 'Examine the attachment')
  pending.content = { role: 'user', content: { type: 'text', text: 'Examine the attachment', parts: [
    { type: 'text', text: 'Examine the attachment' },
    { type: 'artifact', artifact: { id: 'native-queued-file', fileName: 'notes.txt', mimeType: 'text/plain' } },
  ] }, meta: { isNativeQueuedMessage: true } }
  fake.rows = [pending]
  const app = await mount(fake, directory, { importArtifact: async () => ({
    type: 'file', attachment: { attachmentId: AttachmentId('queued-notes'), bytes: 12, name: 'notes.txt' },
  }) })
  try {
    const agent = app.service.list()[0]!
    assert.equal(agent.inbox.nextTurn.length, 1)
    assert.deepEqual(agent.inbox.nextTurn[0]?.content.map(block => block.type), ['text', 'file'])
    assert.equal(agent.projection.delivery[0]?.localId, 'other-frontend-input')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0)
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('provisional snapshots stream, completion settles once, and live/history raw ids deduplicate', () => {
  const fake = new FakeHapi()
  const binding = bindingFor(fake.hubId, fake.source)
  const session = Session.create(SessionId('projection-fixture'))
  const frames: AssistantStreamFrame[] = []
  const projector = new NativeProjector(session, { model: () => 'native-model', provider: () => 'native-fixture',
    submittedMessage: () => undefined, stream: frame => frames.push(frame) })
  const apply = (row: HapiMessage) => { const parsed = parseNativeRow(row, binding); assert.ok(parsed); projector.apply([parsed]) }
  apply(user())
  apply(agentBody('message', { message: 'Hel', streamSnapshot: true }, 'answer', false))
  apply(agentBody('message', { message: 'Hello', streamSnapshot: true }, 'answer', false))
  assert.equal(session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 0)
  assert.deepEqual(frames.filter(frame => frame.type === 'chunk' && frame.chunk.type === 'text-delta')
    .map(frame => frame.type === 'chunk' && frame.chunk.type === 'text-delta' ? frame.chunk.text : ''), ['Hel', 'lo'])
  const final = agentBody('message', { message: 'Hello!', streamSnapshot: true }, 'answer')
  apply(final)
  apply({ ...final, id: 'different-history-envelope', seq: 9000, createdAt: 9999 })
  apply(agentBody('message', { message: 'Hel', streamSnapshot: true }, 'answer', false))
  assert.equal(session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
  assert.equal(frames.filter(frame => frame.type === 'end' && frame.outcome.kind === 'committed').length, 1)
})

test('pending input uses one native dispatch and survives loss of the acknowledgement without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-delivery-'))
  const fake = new FakeHapi()
  fake.sendFailure = new HapiRequestError('Acknowledgement lost', 'indeterminate')
  const message = createUserMessage({ content: [{ type: 'text', text: 'Run once' }], source: { kind: 'user' } })
  try {
    let journal = new DeliveryJournal(directory, 'stable', fake.source.id, fake, () => undefined)
    const delivery = journal.submit(message, 'queue')
    await journal.settled()
    assert.equal(journal.get(delivery.localId)?.state, 'indeterminate')
    journal.submit(message, 'queue')
    journal = new DeliveryJournal(directory, 'stable', fake.source.id, fake, () => undefined)
    await journal.reconcileSource()
    journal.submit(message, 'queue')
    assert.equal(fake.sent.length, 1)
    fake.queue = { queuedLocalIds: [], invokedLocalMessages: [{ localId: delivery.localId, invokedAt: 1500 }] }
    await journal.reconcileSource()
    journal.update(delivery.localId, 'queued') // Older source/HTTP notifications cannot regress invocation.
    assert.equal(journal.get(delivery.localId)?.state, 'invoked')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('repeated native plan updates retain distinct official tool calls and pair each result with its own native item', () => {
  const fake = new FakeHapi()
  const binding = bindingFor(fake.hubId, fake.source)
  const session = Session.create(SessionId('plan-projection-fixture'))
  const projector = new NativeProjector(session, { model: () => 'native-model', provider: () => 'native-fixture',
    submittedMessage: () => undefined, stream: () => {} })
  const rows = [
    agentBody('tool-call', { callId: 'codex-plan-state', name: 'update_plan', input: { plan: 'First plan' } }, 'plan-one'),
    agentBody('tool-call-result', { callId: 'codex-plan-state', output: 'First plan accepted' }, 'plan-one'),
    agentBody('tool-call', { callId: 'codex-plan-state', name: 'update_plan', input: { plan: 'Updated plan' } }, 'plan-two'),
    agentBody('tool-call-result', { callId: 'codex-plan-state', output: 'Updated plan accepted' }, 'plan-two'),
  ].map(row => { const parsed = parseNativeRow(row, binding); assert.ok(parsed); return parsed })
  projector.apply(rows)
  const calls = session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.callId)
  const results = session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message.toolCallId)
  assert.equal(new Set(calls).size, 2)
  assert.deepEqual(results, calls)
  projector.apply(rows)
  assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/call').length, 2)
})

test('native queue cancellation race preserves invoked input and original DSH message identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-queue-'))
  const fake = new FakeHapi()
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    const message = createUserMessage({ content: [{ type: 'text', text: 'A queued prompt' }], source: { kind: 'user' } })
    agent.followup(message)
    await agent.journal.settled()
    const entry = agent.journal.values()[0]!
    assert.equal(fake.sent.length, 1)
    assert.equal(agent.inbox.nextTurn[0]?.id, message.id)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0)
    assert.throws(() => agent.inbox.remove(message.id), /asynchronous/)
    fake.cancelResult = { status: 'invoked', message: user(entry.localId, true, entry.text) }
    const result = await agent.cancelQueued(entry.localId)
    assert.equal(result.status, 'invoked')
    assert.equal(agent.inbox.nextTurn.length, 0)
    const projected = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    assert.equal(projected?.type === 'user/message' ? projected.data.id : undefined, message.id)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('approval submission is not native resolution and stale source versions cannot reopen it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-approval-'))
  const fake = new FakeHapi()
  fake.source.agentState = { requests: { 'native-request-1': { tool: 'exec_command', arguments: { command: 'pwd' } } } }
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    const stale = structuredClone(fake.source)
    const result = await agent.answerApproval('native-request-1', { decision: 'approved' })
    assert.equal(result.stage, 'submitted')
    assert.equal(agent.projection.pendingRequests[0]?.stage, 'submitted')
    assert.equal(agent.projection.resolvedRequests.length, 0)
    assert.equal(fake.answers.length, 1)
    await agent.answerApproval('native-request-1', { decision: 'approved' })
    assert.equal(fake.answers.length, 1)
    fake.source.agentStateVersion = 2
    fake.source.agentState = { requests: {}, completedRequests: { 'native-request-1': {
      tool: 'exec_command', arguments: { command: 'pwd' }, status: 'resolved', completedAt: 2000,
    } } }
    await agent.refresh()
    assert.equal(agent.projection.pendingRequests.length, 0)
    assert.equal(agent.projection.resolvedRequests[0]?.status, 'resolved')
    fake.source = stale
    await agent.refresh()
    assert.equal(agent.projection.pendingRequests.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('actionable plan projection comes only from versioned native source state and stale reads cannot restore a consumed proposal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-plan-projection-'))
  const fake = new FakeHapi()
  fake.rows = [agentBody('message', { message: 'Here is a plan. Implement the plan.', streamSnapshot: true }, 'answer-1'), terminal()]
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    assert.equal(agent.projection.planId, null)
    const planId = `codex-proposed-plan:${THREAD}:${TURN}:plan-item`
    fake.source.agentStateVersion = 2
    fake.source.agentState = { ...fake.source.agentState, codexPlanProposalId: planId }
    await agent.refresh()
    assert.equal(agent.projection.planId, planId)
    assert.equal(app.ctx.sessionProjections.snapshot(agent.session).values.hapi?.planId, planId)
    const stale = structuredClone(fake.source)
    fake.source.agentStateVersion = 3
    fake.source.agentState = { ...fake.source.agentState, codexPlanProposalId: null }
    await agent.refresh()
    assert.equal(agent.projection.planId, null)
    fake.source = stale
    await agent.refresh()
    assert.equal(agent.projection.planId, null)
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('disconnect and disposal never terminate or fabricate completion for the original native owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-detach-'))
  const fake = new FakeHapi()
  fake.source.execution = { owner: 'codex', generation: 'connection-1', sequence: 3, status: 'active', waitingOn: [],
    turnId: TURN, startedAt: 1000, completedAt: null }
  fake.rows = [user()]
  const app = await mount(fake, directory)
  const agent = app.service.list()[0]!
  try {
    assert.equal(agent.status, 'running')
    fake.emit({ type: 'connection-changed', data: { status: 'disconnected' } })
    await app.service.settled()
    assert.equal(agent.status, 'running')
    assert.equal(agent.projection.readOnly, true)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 0)
    agent.cancel({ kind: 'disposed' })
    await app.close()
    assert.equal(fake.aborts, 0)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native history epoch resets restart pagination without mixing pages', async () => {
  const fake = new FakeHapi()
  let generation = 1
  fake.readHook = query => {
    if (query.beforeAt !== undefined && generation === 1) { generation = 2; return page([], { epoch: 2, reset: true }) }
    if (query.beforeAt !== undefined) return page([user('older')], { epoch: 2 })
    return page([user(generation === 1 ? 'stale' : 'latest')], { epoch: generation,
      hasMore: true, nextBeforeAt: 1000, nextBeforeSeq: 1 })
  }
  const rows = await readNativeHistory(fake, fake.source.id)
  assert.deepEqual(new Set(rows.map(row => row.localId)), new Set(['latest', 'older']))
  assert.equal(fake.reads.length, 4)
})

test('native rewind creates a fresh DSH display namespace while retaining thread and durable delivery identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-rewind-'))
  const fake = new FakeHapi()
  fake.rows = [user(), agentBody('message', { message: 'Old answer', streamSnapshot: true }, 'answer'), terminal()]
  const changes: Array<[string, string]> = []
  let app = await mount(fake, directory, { onDisplayReset: (oldId, newId) => { changes.push([oldId, newId]) } })
  try {
    const previous = app.service.list()[0]!
    const logicalId = previous.logicalSessionId
    fake.rows = [user(), agentBody('message', { message: 'Rewritten native answer', streamSnapshot: true }, 'answer'), terminal()]
    fake.emit({ type: 'messages-invalidated', sessionId: fake.source.id, reason: 'rewind' })
    await app.service.settled()
    const current = app.service.list()[0]!
    assert.notEqual(current.id, previous.id)
    assert.equal(current.logicalSessionId, logicalId)
    assert.equal(current.displayRevision, 1)
    assert.equal(current.binding.threadId, previous.binding.threadId)
    assert.equal(current.binding.home, previous.binding.home)
    assert.deepEqual(changes, [[previous.id, current.id]])
    assert.equal(app.ctx.sessions.get(previous.id), undefined)
    assert.equal(app.ctx.agents.get(current.id), current)
    assert.equal(fake.aborts, 0)
    const displayId = current.id
    await app.close()
    app = await mount(fake, directory)
    assert.equal(app.service.list()[0]?.id, displayId)
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('attachment admission resolves runner paths before the one native send', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-file-'))
  const fake = new FakeHapi()
  let uploads = 0
  const app = await mount(fake, directory, { resolveAttachments: async (sessionId, message) => {
    assert.equal(sessionId, fake.source.id)
    assert.equal(message.content[1]?.type, 'file')
    uploads++
    return [{ id: 'native-upload', filename: 'sample.txt', mimeType: 'text/plain', size: 3, path: '/runner/uploads/sample.txt' }]
  } })
  try {
    const agent = app.service.list()[0]!
    const message: UserMessage = freezeMessage({ id: MessageId('upload-message'), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read this file' }, { type: 'file', attachment: {
        attachmentId: AttachmentId('fixture-digest'), name: 'sample.txt', bytes: 3,
      } }] })
    agent.followup(message)
    await agent.journal.settled()
    assert.equal(uploads, 1)
    assert.equal(fake.sent.length, 1)
    assert.equal(fake.sent[0]?.attachments?.[0]?.path, '/runner/uploads/sample.txt')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('offline native history uses a read cache and does not enable native actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-cache-'))
  const fake = new FakeHapi()
  fake.rows = [user(), agentBody('message', { message: 'Cached native answer' }, 'answer'), terminal()]
  let app = await mount(fake, directory)
  try {
    await app.close()
    fake.historyFailure = new Error('Runner is offline')
    app = await mount(fake, directory)
    const agent = app.service.list()[0]!
    assert.equal(agent.projection.readOnly, true)
    assert.match(agent.projection.error ?? '', /offline/)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
    assert.throws(() => agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Cannot send' }], source: { kind: 'user' } })), /offline/)
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Hub and source identities remain distinct, and foreign native thread data is rejected', () => {
  assert.notEqual(nativeSessionId('hub-a', 'same-source'), nativeSessionId('hub-b', 'same-source'))
  const fake = new FakeHapi()
  const foreign = agentBody('message', { message: 'Foreign answer' }, 'answer')
  const envelope = foreign.content as { content: { data: { nativeExecution: { threadId: string } } } }
  envelope.content.data.nativeExecution.threadId = 'another-thread'
  assert.throws(() => parseNativeRow(foreign, bindingFor(fake.hubId, fake.source)), /different Codex thread/)
})

test('approval recovery preserves an unknown outcome until the source records final resolution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-approval-recovery-'))
  const fake = new FakeHapi()
  const state = { requests: { request: { tool: 'exec_command', arguments: { command: 'pwd' } } } }
  try {
    let approvals = new NativeApprovals(directory, 'logical-session', fake.source.id, fake, () => undefined)
    approvals.observe(state)
    await approvals.answer('request', { decision: 'approved' })
    assert.equal(approvals.pending()[0]?.stage, 'submitted')
    approvals = new NativeApprovals(directory, 'logical-session', fake.source.id, fake, () => undefined)
    approvals.observe(state)
    assert.equal(approvals.pending()[0]?.stage, 'indeterminate')
    await assert.rejects(approvals.answer('request', { decision: 'approved' }), /unknown/)
    assert.equal(fake.answers.length, 1)
    approvals.observe({ requests: {}, completedRequests: { request: {
      tool: 'exec_command', arguments: { command: 'pwd' }, status: 'resolved', completedAt: 9000,
    } } })
    assert.deepEqual(await approvals.answer('request', { decision: 'denied' }), { stage: 'resolved' })
    assert.equal(approvals.pending().length, 0)
    assert.equal(fake.answers.length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('native activity waiters reject on lost observation and disposal instead of hanging or inventing idle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-waiters-'))
  const fake = new FakeHapi()
  fake.source.execution!.status = 'active'
  fake.source.execution!.turnId = TURN
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    const unknown = assert.rejects(agent.whenIdle(), /unknown/)
    fake.emit({ type: 'connection-changed', data: { status: 'disconnected' } })
    await app.service.settled()
    await unknown
    assert.equal(agent.status, 'running')
    fake.emit({ type: 'connection-changed', data: { status: 'connected' } })
    await app.service.settled()
    const detached = assert.rejects(agent.whenIdle(), /detached/)
    await agent.dispose()
    await detached
    assert.equal(fake.aborts, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('original TUI rich user and tool resources become official DSH attachments and remain readable offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-native-artifacts-'))
  const fake = new FakeHapi()
  const prompt = user()
  prompt.content = { role: 'user', content: { type: 'text', text: 'Inspect the image', parts: [
    { type: 'text', text: 'Inspect the image' },
    { type: 'artifact', artifact: { id: 'native-picture', fileName: 'picture.png', mimeType: 'image/png' } },
    { type: 'artifact', artifact: { id: 'remote-link', fileName: 'Original resource', mimeType: 'image/png', externalUrl: 'https://example.test/resource.png' } },
  ] }, meta: { nativeExecution: { threadId: THREAD, turnId: TURN, itemId: 'user-image' } } }
  fake.rows = [prompt, agentBody('tool-call', { callId: 'report', name: 'native_resource', input: {} }, 'report'),
    agentBody('tool-call-result', { callId: 'report', output: { content: [
      { type: 'text', text: 'The report is ready' },
      { type: 'artifact', artifact: { id: 'native-report', fileName: 'report.pdf', mimeType: 'application/pdf' } },
      { type: 'unsupported', label: 'Encrypted tool content' },
    ] } }, 'report'), terminal()]
  const imported: string[] = []
  const options: Partial<CodexServiceOptions> = { importArtifact: async (sessionId, ref) => {
    assert.equal(sessionId, fake.source.id)
    imported.push(ref.id)
    if (ref.mimeType === 'image/png') return { type: 'image', attachment: {
      attachmentId: AttachmentId('fixture-image'), mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: ref.fileName,
    } }
    return { type: 'file', attachment: { attachmentId: AttachmentId('fixture-file'), bytes: 20, name: ref.fileName } }
  } }
  let app = await mount(fake, directory, options)
  try {
    const events = app.service.list()[0]!.session.snapshotEvents()
    const input = events.find(event => event.type === 'user/message')
    const output = events.find(event => event.type === 'tool/result')
    assert.deepEqual(input?.type === 'user/message' ? input.data.content.map(block => block.type) : [], ['text', 'image', 'text'])
    assert.deepEqual(output?.type === 'tool/result' ? output.data.message.content.map(block => block.type) : [], ['text', 'file', 'text'])
    assert.deepEqual(imported, ['native-picture', 'native-report'])
    await app.close()
    fake.historyFailure = new Error('Runner offline')
    app = await mount(fake, directory, { importArtifact: async () => { throw new Error('Offline artifact fetch must not run') } })
    const cached = app.service.list()[0]!.session.snapshotEvents()
    const cachedInput = cached.find(event => event.type === 'user/message')
    assert.equal(cachedInput?.type === 'user/message' ? cachedInput.data.content[1]?.type : undefined, 'image')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a native resource becoming available refreshes display generation while preserving its source identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-artifact-recovery-'))
  const fake = new FakeHapi()
  const row = user()
  row.content = { role: 'user', content: { type: 'text', text: '', parts: [
    { type: 'artifact', artifact: { id: 'native-file', fileName: 'data.txt', mimeType: 'text/plain' } },
  ] }, meta: { nativeExecution: { threadId: THREAD, turnId: TURN, itemId: 'input-with-file' } } }
  fake.rows = [row, terminal()]
  let available = false
  const app = await mount(fake, directory, { importArtifact: async (_sessionId, ref) => {
    if (!available) throw new Error('Runner unavailable')
    return { type: 'file', attachment: { attachmentId: AttachmentId('available-file'), bytes: 3, name: ref.fileName } }
  } })
  try {
    const previous = app.service.list()[0]!
    const missing = previous.session.snapshotEvents().find(event => event.type === 'user/message')
    assert.equal(missing?.type === 'user/message' ? missing.data.content[0]?.type : undefined, 'text')
    available = true
    await previous.refresh(true)
    const current = app.service.list()[0]!
    assert.notEqual(current.id, previous.id)
    assert.equal(current.binding.threadId, previous.binding.threadId)
    assert.equal(current.logicalSessionId, previous.logicalSessionId)
    const restored = current.session.snapshotEvents().find(event => event.type === 'user/message')
    assert.equal(restored?.type === 'user/message' ? restored.data.content[0]?.type : undefined, 'file')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native content deduplication ignores JSON key ordering and rejects an actual identity retarget', async () => {
  const fake = new FakeHapi()
  const binding = bindingFor(fake.hubId, fake.source)
  const left = agentBody('tool-call', { callId: 'same', name: 'native', input: { x: 1, y: 2 } }, 'tool')
  const right = agentBody('tool-call', { callId: 'same', name: 'native', input: { y: 2, x: 1 } }, 'tool')
  assert.equal(parseNativeRow(left, binding)?.fingerprint, parseNativeRow(right, binding)?.fingerprint)
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-binding-'))
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    fake.source.metadataVersion = 0
    fake.source.metadata!.codexSessionId = 'stale-other-thread'
    await agent.refresh()
    assert.equal(agent.binding.threadId, THREAD)
    fake.source.metadataVersion = 2
    await assert.rejects(agent.refresh(), /identity changed/)
    assert.equal(agent.sourceSession.metadata?.codexSessionId, THREAD)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
