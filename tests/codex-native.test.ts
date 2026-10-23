import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { NativeHistoryCache } from '../src/codex/history-cache.ts'
import { nativeStateDirectory } from '../src/codex/state-directory.ts'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
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
import { HistoryReadInvalidatedError } from '../src/codex/history-journal.js'
import { hapiProjectionDefinition, hapiProjectionView } from '../src/codex/projection-state.ts'
import type { HapiProjectionState as HapiProjection } from '../src/codex/projection-types.ts'

const THREAD = 'native-thread-1'
const TURN = 'native-turn-1'

/** Protocol fixture only. All Session, AgentRegistry, scopes and projections are real pinned DSH packages. */
class FakeHapi implements HapiTransport {
  readonly hubId = 'test-hub'
  readonly listeners = new Set<(event: HapiEvent) => void>()
  readonly sent: HapiSendMessage[] = []
  /** Every attempted dispatch target; a rejected attempt is not a delivery. */
  readonly sendTargets: string[] = []
  /** Throw from here to simulate a per-attempt Hub rejection. */
  sendHook: ((sessionId: string, message: HapiSendMessage) => void) | undefined
  readonly sessionsById = new Map<string, HapiSession>()
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
  readHook: ((query: HapiMessagesQuery) => HapiMessagesPage | Promise<HapiMessagesPage>) | undefined
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
  async getSession(id?: string): Promise<HapiSession> {
    const explicit = id === undefined ? undefined : this.sessionsById.get(id)
    return structuredClone(explicit ?? this.source)
  }
  async readMessages(_id: string, query: HapiMessagesQuery = {}): Promise<HapiMessagesPage> {
    this.reads.push(query)
    if (this.historyFailure) throw this.historyFailure
    return this.readHook?.(query) ?? page(this.rows)
  }
  async sendMessage(id: string, message: HapiSendMessage): Promise<void> {
    this.sendTargets.push(id)
    // A hook throw is a Hub rejection, never a recorded delivery.
    this.sendHook?.(id, message)
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

test('opening a current native owner does not wait for or reread its archive', async () => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hapi-open-owner-'), fake = new FakeHapi()
  const app = await mount(fake, directory)
  try {
    const original = app.service.list()[0]!, reads = fake.reads.length
    fake.historyFailure = new Error('Archive unavailable while the live owner is reachable')
    fake.source.model = 'fresh-source-model'
    const opened = await app.service.openSource(fake.source.id)
    assert.equal(opened, original)
    assert.equal(opened?.projection.model, 'fresh-source-model')
    assert.equal(fake.reads.length, reads)
    assert.equal(fake.sent.length, 0)
    assert.equal(fake.aborts, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('execution churn does not duplicate source notices, queues or approvals, and official replay remains lossless', async () => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hapi-status-log-'), fake = new FakeHapi()
  fake.source.agentState!.requests = { pending: { tool: 'Fixture command', arguments: { command: 'synthetic '.repeat(20_000) } } }
  fake.rows = [{ id: 'notice', localId: null, seq: 1, createdAt: 1000, content: {
    role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Synthetic notice', details: 'details '.repeat(30_000) } },
  } }, user('large-queued-input', false, 'Queued synthetic input '.repeat(10_000))]
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!, start = agent.session.seq
    for (let i = 0; i < 100; i++) {
      fake.source.execution = { ...fake.source.execution!, sequence: i + 2 }
      fake.source.executionVersion = i + 2
      await agent.refreshSettings()
    }
    const additions = agent.session.snapshotEvents().filter(event => event.seq >= start)
    assert.equal(additions.filter(event => pluginRecordOf(event)?.type === 'plugin:hapi-dsh/execution').length, 100)
    assert.equal(additions.filter(event => ['plugin:hapi-dsh/status', 'plugin:hapi-dsh/session-state'].includes(pluginRecordOf(event)?.type ?? '')).length, 0)
    assert.ok(JSON.stringify(additions).length < 60_000, '100 execution updates must not copy unchanged large notices, queue text and approval arguments')
    let replay: HapiProjection = null
    for (const event of agent.session.snapshotEvents()) replay = hapiProjectionDefinition.apply(replay, event)
    assert.deepEqual(replay, agent.projection)
    assert.deepEqual(app.ctx.sessionProjections.snapshot(agent.session).values.hapi, hapiProjectionView(replay))
    assert.equal(replay?.notices[0]?.details?.length, 240_000)
    assert.equal(replay?.pendingRequests.length, 1)
    assert.equal(replay?.delivery[0]?.text.length, 230_000)
    const next = { id: 'notice-2', localId: null, seq: 2, createdAt: 2000, content: {
      role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Next synthetic notice' } },
    } }
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: next })
    await app.service.settled()
    replay = null
    for (const event of agent.session.snapshotEvents()) replay = hapiProjectionDefinition.apply(replay, event)
    assert.deepEqual(replay, agent.projection)
    assert.equal(replay?.notices.length, 2)
    fake.source.execution = null; fake.source.executionVersion = 200
    await agent.refreshSettings()
    replay = null
    for (const event of agent.session.snapshotEvents()) replay = hapiProjectionDefinition.apply(replay, event)
    assert.equal(replay?.execution, null, 'an authoritative absence replaces the previous execution value')
    assert.deepEqual(replay, agent.projection)
    assert.deepEqual(app.ctx.sessionProjections.snapshot(agent.session).values.hapi, hapiProjectionView(replay))
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('execution domain replay accepts old complete state/status records and retains queue and approval facts', async () => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hapi-status-compat-'), fake = new FakeHapi()
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!, session = agent.session, initial = agent.projection
    const { notices, ...legacyStatus } = initial
    appendPluginRecord(session, 'plugin:hapi-dsh/status', { ...legacyStatus, model: 'legacy-model' })
    appendPluginRecord(session, 'plugin:hapi-dsh/notices', notices)
    appendPluginRecord(session, 'plugin:hapi-dsh/execution', null)
    const { execution: _execution, ...sessionState } = legacyStatus
    appendPluginRecord(session, 'plugin:hapi-dsh/session-state', { ...sessionState, model: 'new-model' })
    let replay: HapiProjection = null
    for (const event of session.snapshotEvents()) replay = hapiProjectionDefinition.apply(replay, event)
    assert.deepEqual(replay, { ...initial, model: 'new-model', execution: null })
    assert.deepEqual(app.ctx.sessionProjections.snapshot(session).values.hapi, hapiProjectionView(replay))
    // A legacy full value remains authoritative if an older writer resumes.
    appendPluginRecord(session, 'plugin:hapi-dsh/status', legacyStatus)
    assert.deepEqual(app.ctx.sessionProjections.snapshot(session).values.hapi, hapiProjectionView(initial))
    appendPluginRecord(session, 'plugin:hapi-dsh/execution', null)
    appendPluginRecord(session, 'plugin:hapi-dsh/state', initial)
    assert.deepEqual(app.ctx.sessionProjections.snapshot(session).values.hapi, hapiProjectionView(initial))
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

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
    // Scheduling is message input, not a source operation: the same durable
    // operation id resolves to its existing receipt without a new delivery.
    assert.equal(restored.scheduleText({ operationId, text: 'Run when the original timer fires', scheduledAt }).localId, original.localId)
    assert.equal(fake.sent.length, 1)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('checking an externally submitted native receipt reads source state without sending or guessing consumption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-receipt-')), fake = new FakeHapi()
  fake.rows = [{ ...user('external', false), deliveryState: 'indeterminate' }]
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    assert.equal(agent.projection.delivery[0]?.state, 'indeterminate')
    fake.queue = { queuedLocalIds: ['external'], invokedLocalMessages: [] }
    assert.equal((await agent.checkDelivery('external'))?.state, 'queued')
    fake.queue = { queuedLocalIds: [], indeterminateLocalIds: ['external'], invokedLocalMessages: [] }
    assert.equal((await agent.checkDelivery('external'))?.state, 'indeterminate')
    fake.queue = { queuedLocalIds: [], invokedLocalMessages: [{ localId: 'another-message', invokedAt: 2000 }] }
    assert.equal((await agent.checkDelivery('external'))?.state, 'indeterminate')
    fake.queue = { queuedLocalIds: [], invokedLocalMessages: [{ localId: 'external', invokedAt: 2000 }] }
    assert.equal(await agent.checkDelivery('external'), null)
    assert.equal(agent.projection.delivery.length, 0)
    assert.equal(fake.sent.length, 0)
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
    assert.equal(agent.session.header.agentPreset, undefined, 'an externally owned Codex session is not a DSH preset composition')
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

test('native lifecycle reconciliation refuses an unversioned identity change without locking message input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-unready-'))
  const fake = new FakeHapi()
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    fake.source.metadata = { ...fake.source.metadata!, codexSessionId: 'unversioned-native-thread' }
    await assert.rejects(app.service.reconcileSource(fake.source.id), /without advancing/)
    fake.source.metadataVersion++
    delete fake.source.metadata.codexSessionId
    assert.equal(await app.service.reconcileSource(fake.source.id), undefined)
    // A source-not-ready display is a diagnostic, not an input gate: the
    // durable journal still accepts the message and delivery resolves it.
    const message = createUserMessage({ content: [{ type: 'text', text: 'Send despite unready source' }], source: { kind: 'user' } })
    agent.followup(message)
    await agent.journal.settled()
    assert.equal(fake.sent.length, 1)
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
  assert.deepEqual(frames.map(frame => frame.revision), frames.map((_frame, index) => index + 1),
    'official DSH followers require a dense revision on every start/chunk/end frame')
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
    // `readOnly` gates source operations; message input is admitted separately.
    assert.equal(agent.projection.nativeConnection, 'disconnected')
    assert.equal(agent.projection.readOnlyReason, 'unavailable')
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
  // One resetting pass (latest page, then its resetting backward page) and one
  // complete pass. These fixture pages carry no snapshot head, so no extra
  // anchored validation read is issued.
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

test('native settings recover only history read faults after validating the current source snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-settings-')), fake = new FakeHapi()
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    fake.historyFailure = new Error('Settings must not read history')
    fake.source.permissionMode = 'yolo'
    agent.reportError(new HistoryReadInvalidatedError())
    assert.equal(agent.projection.readOnlyReason, 'fault')
    await agent.refreshSettings()
    assert.equal(agent.projection.readOnly, false)
    assert.equal(agent.projection.permissionMode, 'yolo')
    assert.equal(agent.projection.error, null)
    agent.reportError(new Error('Source operation failed'))
    agent.reportError(new HistoryReadInvalidatedError())
    await agent.refreshSettings()
    assert.equal(agent.projection.readOnly, true)
    assert.equal(agent.projection.error, 'Source operation failed', 'history retries cannot erase a real fault')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a changed native identity cannot clear a history fault through a settings read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-settings-identity-')), fake = new FakeHapi()
  const app = await mount(fake, directory)
  try {
    const agent = app.service.list()[0]!
    agent.reportError(new HistoryReadInvalidatedError())
    fake.source.metadata = { ...fake.source.metadata!, codexSessionId: 'another-native-thread' }; fake.source.metadataVersion++
    await assert.rejects(agent.refreshSettings())
    assert.equal(agent.projection.readOnly, true)
    assert.match(agent.projection.error ?? '', /Source history changed/)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('offline native history uses a read cache and keeps the fault diagnostic-only for input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-cache-'))
  const fake = new FakeHapi()
  fake.rows = [user(), agentBody('message', { message: 'Cached native answer' }, 'answer'), terminal()]
  let app = await mount(fake, directory)
  try {
    await app.close()
    fake.historyFailure = new Error('Runner is offline')
    app = await mount(fake, directory)
    const agent = app.service.list()[0]!
    assert.match(agent.projection.error ?? '', /offline/)
    assert.equal(agent.projection.readOnlyReason, 'fault')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
    // Faults are diagnostics: the durable journal still accepts the message and
    // the delivery path reports the real source outcome instead of a fake lock.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Send despite cached history' }], source: { kind: 'user' } }))
    await agent.journal.settled()
    assert.equal(fake.sent.length, 1)
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

// ---------------------------------------------------------------------------
// R4: unavailable/stale native sources are not read-only; delivery resolves the
// original session per HAPI's resolve-before-send ordering.
// ---------------------------------------------------------------------------

function outbound(localId: string, text: string): UserMessage {
  return freezeMessage({ id: MessageId(localId), role: 'user', source: { kind: 'user', rpcId: localId },
    content: [{ type: 'text', text }] })
}

test('an inactive native session resumes the exact original thread before delivery and sends exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-resume-')), fake = new FakeHapi()
  fake.source.active = false
  const resumes: string[] = []
  const app = await mount(fake, directory, { resumeSession: async id => { resumes.push(id); fake.source.active = true; return id } })
  try {
    const agent = app.service.list()[0]!
    // `readOnly` keeps its operation-permission meaning, but input is admitted.
    assert.equal(agent.projection.readOnly, true)
    assert.equal(agent.projection.readOnlyReason, 'unavailable')
    agent.followup(outbound('r4-inactive', 'Deliver after resume'))
    await agent.journal.settled()
    assert.deepEqual(resumes, [fake.source.id], 'resume targets the original source id')
    assert.deepEqual(fake.sendTargets, [fake.source.id], 'delivery targets the verified resumed id')
    assert.equal(fake.sent.length, 1)
    assert.equal(fake.sent[0]?.localId, 'dsh:r4-inactive')
    assert.equal(agent.projection.delivery[0]?.state, 'accepted')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('concurrent queued deliveries share one single-flight resume of the inactive source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-resume-once-')), fake = new FakeHapi()
  fake.source.active = false
  const resumes: string[] = []
  const app = await mount(fake, directory, { resumeSession: async id => { resumes.push(id); return id } })
  try {
    const agent = app.service.list()[0]!
    agent.followup(outbound('r4-first', 'First queued message'))
    agent.followup(outbound('r4-second', 'Second queued message'))
    await agent.journal.settled()
    assert.equal(resumes.length, 1, 'one original source resume serves both deliveries')
    assert.deepEqual(fake.sendTargets, [fake.source.id, fake.source.id])
    assert.equal(fake.sent.length, 2)
    assert.ok(agent.projection.delivery.every(row => row.state === 'accepted'))
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a confirmed session_inactive rejection resumes once and retries the same durable localId', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-resume-race-')), fake = new FakeHapi()
  const resumes: string[] = []
  fake.sendHook = () => { throw new HapiRequestError('Session is inactive', 'rejected', 409, 'session_inactive') }
  const app = await mount(fake, directory, { resumeSession: async id => { resumes.push(id); fake.sendHook = undefined; return id } })
  try {
    const agent = app.service.list()[0]!
    agent.followup(outbound('r4-race', 'Race with source inactivity'))
    await agent.journal.settled()
    assert.deepEqual(resumes, [fake.source.id])
    assert.deepEqual(fake.sendTargets, [fake.source.id, fake.source.id], 'one rejected attempt, one delivery')
    assert.equal(fake.sent.length, 1)
    assert.equal(fake.sent[0]?.localId, 'dsh:r4-race', 'the retried dispatch kept the durable localId')
    assert.equal(agent.projection.delivery[0]?.state, 'accepted')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('an indeterminate native delivery never resumes, retries or replaces the original source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-unknown-')), fake = new FakeHapi()
  const resumes: string[] = []
  fake.sendFailure = new HapiRequestError('Connection lost after dispatch', 'indeterminate')
  const app = await mount(fake, directory, { resumeSession: async id => { resumes.push(id); return id } })
  try {
    const agent = app.service.list()[0]!
    agent.followup(outbound('r4-unknown', 'Unknown delivery'))
    await agent.journal.settled()
    assert.deepEqual(resumes, [], 'a transport failure is unknown, not an inactive-source proof')
    assert.equal(fake.sendTargets.length, 1)
    assert.equal(agent.projection.delivery[0]?.state, 'indeterminate')
    assert.match(agent.projection.delivery[0]?.error ?? '', /Connection lost/)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a failed resume keeps the message in a rejected retryable delivery and never replays it automatically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-resume-failed-')), fake = new FakeHapi()
  fake.source.active = false
  const resumes: string[] = []
  let fail = true
  const app = await mount(fake, directory, { resumeSession: async id => {
    resumes.push(id)
    if (fail) throw new HapiRequestError('Original session resume is unavailable', 'rejected', 409, 'resume_unavailable')
    return id
  } })
  try {
    const agent = app.service.list()[0]!
    agent.followup(outbound('r4-resume-failed', 'Keep this draft'))
    await agent.journal.settled()
    assert.equal(fake.sendTargets.length, 0, 'nothing is sent when the original source cannot be resumed')
    const failed = agent.projection.delivery[0]!
    assert.equal(failed.state, 'rejected')
    assert.match(failed.error ?? '', /resume is unavailable/)
    assert.equal(failed.text, 'Keep this draft', 'the message stays in the durable journal')
    fail = false
    agent.retryRejectedDelivery('dsh:r4-resume-failed')
    await agent.journal.settled()
    assert.equal(resumes.length, 2)
    assert.equal(fake.sendTargets.length, 1, 'only the explicit retry dispatches')
    assert.equal(agent.projection.delivery[0]?.state, 'accepted')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('resuming into a different native identity is rejected before delivery and preserves the draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-resume-identity-')), fake = new FakeHapi()
  fake.source.active = false
  const other = structuredClone(fake.source)
  other.id = 'resumed-other-session'
  other.metadata = { ...other.metadata!, codexSessionId: 'a-different-native-thread' }
  fake.sessionsById.set('resumed-other-session', other)
  const app = await mount(fake, directory, { resumeSession: async () => 'resumed-other-session' })
  try {
    const agent = app.service.list()[0]!
    agent.followup(outbound('r4-wrong-thread', 'Do not deliver here'))
    await agent.journal.settled()
    assert.equal(fake.sendTargets.length, 0, 'an identity mismatch is caught before any delivery')
    const failed = agent.projection.delivery[0]!
    assert.equal(failed.state, 'rejected')
    assert.match(failed.error ?? '', /different native Codex thread/)
    assert.equal(failed.text, 'Do not deliver here')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a different resumed session id is rebound before delivery and persisted as an explicit notice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-resume-rebind-')), fake = new FakeHapi()
  fake.source.active = false
  const app = await mount(fake, directory, { resumeSession: async () => 'resumed-native-session' })
  try {
    const agent = app.service.list()[0]!
    agent.followup(outbound('r4-rebind', 'Deliver to the resumed session'))
    await agent.journal.settled()
    assert.deepEqual(fake.sendTargets, ['resumed-native-session'])
    const delivery = agent.projection.delivery[0]!
    assert.equal(delivery.state, 'accepted')
    assert.match(delivery.error ?? '', /resumed as a new session \(resumed-native-session\)/)
    assert.match(delivery.error ?? '', /reopen it from the sidebar/)
    // Later deliveries already target the rebound session without another resume.
    agent.followup(outbound('r4-after-rebind', 'Next message'))
    await agent.journal.settled()
    assert.deepEqual(fake.sendTargets, ['resumed-native-session', 'resumed-native-session'])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

async function eventuallyNative(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), 'the live projection should advance without waiting for history')
}

test('indexed native output and running state advance during blocked archival reads without a display reset', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-indexed-live-')), fake = new FakeHapi()
  fake.rows = [user(), agentBody('message', { message: 'Existing answer' }, 'existing')]
  const app = await mount(fake, directory), initial = app.service.list()[0]!
  const oldRows = [...fake.rows]
  let release!: (value: HapiMessagesPage) => void, reads = 0
  const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve })
  fake.readHook = () => ++reads === 1 ? blocked : page(fake.rows)
  const archive = initial.refresh(true)
  try {
    await eventuallyNative(() => reads === 1)
    const live = agentBody('message', { message: 'Indexed output while archive waits' }, 'indexed-live')
    live.createdAt = 1400; live.seq = 4; fake.rows.push(live)
    fake.source.execution = { ...fake.source.execution!, sequence: 2, status: 'active', turnId: TURN }
    fake.source.executionVersion = 2
    fake.emit({ type: 'session-updated', sessionId: fake.source.id })
    for (let index = 0; index < 20; index++) fake.emit({ type: 'messages-invalidated', sessionId: fake.source.id, reason: 'native-history' })
    await eventuallyNative(() => initial.status === 'running' && initial.resolveSourceMessageDisplaySeq(live.id) !== undefined)
    assert.equal(app.service.list()[0]!.id, initial.id)
    release(page(oldRows)); await archive; await app.service.settled()
    assert.equal(app.service.list()[0]!.id, initial.id)
    assert.notEqual(initial.resolveSourceMessageDisplaySeq(live.id), undefined)
    assert.equal(fake.sent.length, 0)
  } finally { release(page(fake.rows)); await archive.catch(() => {}); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native cached display returns before a blocked history read and live output survives older backfill', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-live-first-')), fake = new FakeHapi()
  fake.rows = [user(), agentBody('message', { message: 'Cached answer' }, 'cached')]
  let app = await mount(fake, directory), release: ((value: HapiMessagesPage) => void) | undefined
  try {
    await app.close()
    const missing = agentBody('message', { message: 'Between cache and attach' }, 'missing')
    missing.createdAt = 1300; missing.seq = 3
    const live = agentBody('message', { message: 'Live during backfill' }, 'live')
    live.createdAt = 1400; live.seq = 4
    const history = new Promise<HapiMessagesPage>(resolve => { release = resolve })
    fake.readHook = () => history
    app = await mount(fake, directory, { fastHistorySeed: true })
    const initial = app.service.list()[0]!
    assert.match(initial.projection.error ?? '', /stale/)
    assert.equal(initial.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: live })
    await eventuallyNative(() => initial.resolveSourceMessageDisplaySeq(live.id) !== undefined)
    // The snapshot was taken before the live row reached the source index.
    release!(page([...fake.rows, missing])); release = undefined
    await app.service.settled()
    const current = app.service.list()[0]!, answers = current.session.snapshotEvents().flatMap(event =>
      event.type === 'assistant/message' ? event.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : [])
    assert.deepEqual(answers, ['Cached answer', 'Between cache and attach', 'Live during backfill'])
    assert.equal(current.binding.threadId, initial.binding.threadId)
    assert.equal(current.displayRevision, initial.displayRevision + 1)
    assert.equal(current.projection.error, null)
    assert.equal(fake.sent.length, 0); assert.equal(fake.aborts, 0)
  } finally { release?.(page(fake.rows)); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

for (const legacyCache of [false, true]) test(`native ${legacyCache ? 'legacy cache' : 'cold attach'} seeds bounded initial context while full history remains blocked`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-cold-tail-')), fake = new FakeHapi()
  const tail = agentBody('message', { message: 'Latest bounded answer' }, 'tail')
  tail.createdAt = 1300; tail.seq = 3
  const older = user()
  if (legacyCache) {
    const logicalId = nativeSessionId(fake.hubId, fake.source.id)
    new NativeHistoryCache(nativeStateDirectory(directory, logicalId, bindingFor(fake.hubId, fake.source)), logicalId)
      .write([agentBody('message', { message: 'Old legacy cache' }, 'legacy')])
  }
  let release!: (value: HapiMessagesPage) => void, reads = 0
  const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve })
  fake.readHook = query => {
    if (query?.limit === 1) return page([tail])
    if (query?.beforeSeq !== undefined) return page([older, tail])
    return ++reads === 1 ? page([tail], { hasMore: true, nextBeforeAt: 1300, nextBeforeSeq: 3 }) : blocked
  }
  const app = await mount(fake, directory, { fastHistorySeed: true })
  try {
    const initial = app.service.list()[0]!
    assert.notEqual(initial.resolveSourceMessageDisplaySeq(tail.id), undefined)
    assert.equal(initial.sourceMessageAtDisplaySeq(initial.resolveSourceMessageDisplaySeq(tail.id)!), tail.id)
    assert.equal(initial.sourceMessageAtDisplaySeq(-1), undefined)
    release(page([older, tail])); await app.service.settled()
    const current = app.service.list()[0]!
    assert.equal(current.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1)
    assert.equal(current.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
    assert.equal(current.binding.threadId, initial.binding.threadId)
  } finally { release(page([older, tail])); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native events arriving during the first history response are captured before the Agent exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-attach-race-')), fake = new FakeHapi()
  let release!: (value: HapiMessagesPage) => void, reading!: () => void
  const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  fake.readHook = () => { reading(); return blocked }
  const mounting = mount(fake, directory)
  await started
  const live = agentBody('message', { message: 'Arrived before attach completed' }, 'live')
  fake.emit({ type: 'message-received', sessionId: fake.source.id, message: live })
  release(page([user()]))
  const app = await mounting
  try {
    await app.service.settled()
    const agent = app.service.list()[0]!
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(live.id), undefined)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
    assert.equal(agent.displayRevision, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native failed cache reconciliation retries automatically without a later source event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-stale-retry-')), fake = new FakeHapi()
  fake.rows = [user()]
  let app = await mount(fake, directory)
  try {
    await app.close(); fake.historyFailure = new Error('Transient history read failure')
    app = await mount(fake, directory); await app.service.settled()
    assert.match(app.service.list()[0]!.projection.error ?? '', /Transient/)
    const answer = agentBody('message', { message: 'Recovered without another event' }, 'recovered')
    fake.rows.push(answer); fake.historyFailure = undefined
    for (let index = 0; index < 250 && app.service.list()[0]!.resolveSourceMessageDisplaySeq(answer.id) === undefined; index++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await app.service.settled()
    assert.notEqual(app.service.list()[0]!.resolveSourceMessageDisplaySeq(answer.id), undefined)
    assert.equal(app.service.list()[0]!.projection.error, null)
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('on-demand native discovery ignores unopened activity and captures arrivals during explicit opening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-lazy-')), fake = new FakeHapi()
  let reads = 0, release!: (value: HapiMessagesPage) => void, reading!: () => void
  const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reading = resolve })
  fake.readHook = () => { reads++; reading(); return blocked }
  const app = await mount(fake, directory, { discovery: 'on-demand' })
  try {
    fake.emit({ type: 'session-updated', sessionId: fake.source.id })
    fake.emit({ type: 'connection-changed', data: { status: 'connected' } })
    await app.service.settled()
    assert.equal(app.service.list().length, 0); assert.equal(reads, 0)
    const opening = app.service.openSource(fake.source.id)
    await started
    const live = agentBody('message', { message: 'Arrived while opening lazily' }, 'lazy-live')
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: live })
    release(page([user()]))
    const agent = await opening
    await app.service.settled()
    assert.ok(agent); assert.notEqual(agent.resolveSourceMessageDisplaySeq(live.id), undefined)
    fake.emit({ type: 'session-removed', sessionId: fake.source.id })
    await app.service.settled()
    assert.equal(await app.service.openSource(fake.source.id), undefined)
    assert.equal(fake.sent.length, 0); assert.equal(fake.aborts, 0)
  } finally { release(page([])); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native default seed waits for complete initial history and needs no routine display replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-safe-seed-')), fake = new FakeHapi()
  const latest = agentBody('message', { message: 'Latest answer' }, 'latest')
  let release!: (value: HapiMessagesPage) => void, reading!: () => void, mounted = false
  const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reading = resolve })
  fake.readHook = query => query.beforeSeq === undefined ? page([latest], { hasMore: true, nextBeforeAt: latest.createdAt, nextBeforeSeq: latest.seq })
    : (reading(), blocked)
  const mounting = mount(fake, directory).then(app => { mounted = true; return app })
  await started
  assert.equal(mounted, false, 'cache-first / partial first paint requires explicit fastHistorySeed')
  release(page([user()]))
  const app = await mounting
  try {
    await app.service.settled()
    const current = app.service.list()[0]!
    assert.equal(current.displayRevision, 0)
    assert.equal(current.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1)
    assert.equal(current.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
    assert.equal(current.projection.error, null)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native removal during initial history cannot announce or resurrect the deleted source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-removed-attach-')), fake = new FakeHapi()
  let release!: (value: HapiMessagesPage) => void, reading!: () => void
  const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reading = resolve })
  fake.readHook = () => { reading(); return blocked }
  const mounting = mount(fake, directory)
  await started
  fake.emit({ type: 'session-removed', sessionId: fake.source.id })
  release(page([user()]))
  const app = await mounting
  try {
    await app.service.settled()
    assert.equal(app.service.list().length, 0)
    assert.equal(app.ctx.sessions.get(SessionId(nativeSessionId(fake.hubId, fake.source.id))), undefined)
    await app.service.refreshCatalog()
    assert.equal(app.service.list().length, 0, 'a stale catalog cannot undo a source removal')
    assert.equal(fake.aborts, 0); assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native replacement preparation failure retries after old Agent disposal without another source event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-native-replacement-retry-')), fake = new FakeHapi()
  const latest = agentBody('message', { message: 'Latest before repair' }, 'latest')
  latest.createdAt = 1300; latest.seq = 3; fake.rows = [user(), latest]
  const resets: Array<[string, string]> = [], errors: string[] = []
  const app = await mount(fake, directory, { onDisplayReset: (before, after) => { resets.push([before, after]) }, onError: error => { errors.push(error.message) } })
  try {
    const previous = app.service.list()[0]!, missing = agentBody('message', { message: 'Older recovered answer' }, 'older')
    const original = fake.getSession.bind(fake); let snapshots = 0
    fake.getSession = async id => { if (++snapshots === 2) throw new Error('Replacement source temporarily unavailable'); return original(id) }
    fake.rows = [user(), missing, latest]
    fake.emit({ type: 'message-updated', sessionId: fake.source.id })
    for (let index = 0; index < 300 && (app.service.list()[0]?.displayRevision ?? 0) < 2; index++) await new Promise(resolve => setTimeout(resolve, 10))
    await app.service.settled()
    const current = app.service.list()[0]!
    assert.ok(current, 'service-owned retry survives disposal of the failed display')
    assert.ok(current.displayRevision >= 2, 'the failed replacement namespace is never reused')
    assert.notEqual(current.resolveSourceMessageDisplaySeq(missing.id), undefined)
    assert.equal(app.ctx.sessions.get(previous.id), undefined)
    assert.deepEqual(resets, [[previous.id, current.id]])
    assert.ok(errors.some(error => error.includes('temporarily unavailable')))
    assert.equal(fake.sent.length, 0); assert.equal(fake.aborts, 0); assert.equal(fake.answers.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
