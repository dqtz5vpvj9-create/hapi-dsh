import { projectedSourceEvents } from './source-frame-fixture.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { HapiApprovalAnswer, HapiEvent, HapiMessage, HapiMessagesPage, HapiQueuedState, HapiSendMessage, HapiSession } from '../src/codex/contracts.js'
import { CodexService } from '../src/codex/service.js'
import { HapiAgentService, type HapiObservedTransport } from '../src/hapi-agent/index.js'
import { ObservedScopeIndex } from '../src/hapi-agent/scopes.js'
import { parseObservedHistory } from '../src/hapi-agent/parser.js'
import { NativeHistoryChangedError } from '../src/codex/projector.js'
import { SOURCE_FRAME_EVENT, type SourceFrameBatch } from '../src/shared/source-frames.ts'
import { SourceWindowStore } from '../src/client/source-window-store.ts'
import { HapiObservedChild } from '../src/hapi-agent/children.ts'

/** Source protocol fixtures only; the Session, Agent, scope and projection objects are official packages. */
class Source implements HapiObservedTransport {
  readonly hubId = 'source-child-fixture'
  isConnected = true
  readonly listeners = new Set<(event: HapiEvent) => void>()
  readonly sent: HapiSendMessage[] = []
  readonly mutations: string[] = []
  rows: HapiMessage[] = []
  readonly source: HapiSession
  constructor(native = false) {
    this.source = { id: 'parent', namespace: 'fixture', seq: 1, createdAt: 1000, updatedAt: 1000,
      active: true, activeAt: 1000, thinking: false, thinkingAt: 1000, metadataVersion: 1, agentStateVersion: 1,
      model: 'fixture-model', metadata: { flavor: native ? 'codex' : 'claude', path: '/fixture/project', host: 'Fixture Runner', machineId: 'fixture-machine',
        ...(native ? { codexNativeSession: true, codexSessionId: 'native-parent-thread', codexNativeConnection: 'attached' as const }
          : { claudeSessionId: 'sdk-parent-thread' }) }, agentState: { requests: {}, completedRequests: {} } }
  }
  async listSessions() { return [structuredClone(this.source)] }
  async getSession() { return structuredClone(this.source) }
  async readMessages(): Promise<HapiMessagesPage> { return { messages: structuredClone(this.rows), page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
    nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } } }
  async getQueuedState(): Promise<HapiQueuedState> { return { queuedLocalIds: [], invokedLocalMessages: [] } }
  async sendMessage(_id: string, value: HapiSendMessage) { this.sent.push(value) }
  async cancelQueuedMessage(_id: string, localId: string) { this.mutations.push('cancel'); return { status: 'cancelled' as const, localId } }
  async steerQueuedMessage(_id: string, localId: string) { this.mutations.push('steer'); return { status: 'steered' as const, localId } }
  async retryIndeterminateMessage(_id: string, localId: string) { this.mutations.push('retry'); return { status: 'retried' as const, localId } }
  async abortSession() { this.mutations.push('abort') }
  async approve(_id: string, _request: string, _answer: HapiApprovalAnswer) { this.mutations.push('approve') }
  async deny(_id: string, _request: string, _answer?: HapiApprovalAnswer) { this.mutations.push('deny') }
  async request(_path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown> {
    if (options?.method && options.method !== 'GET') this.mutations.push(options.method)
    return { success: true }
  }
  subscribe(listener: (event: HapiEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event: HapiEvent) { for (const listener of this.listeners) listener(event) }
}

function row(index: number, id: string, type: string, data: unknown, localId: string | null = null): HapiMessage {
  return { id, seq: index, localId, createdAt: 1000 + index * 100, content: { role: 'agent', content: { type, data } } }
}
function sdk(index: number, uuid: string, data: Record<string, unknown>) { return row(index, `row:${uuid}`, 'output', { uuid, ...data }) }
function task(index: number, uuid: string, callId: string, prompt: string, parentToolUseId?: string) {
  return sdk(index, uuid, { type: 'assistant', ...(parentToolUseId ? { isSidechain: true, parentToolUseId } : {}),
    message: { content: [{ type: 'tool_use', id: callId, name: 'Task', input: { prompt, description: `Task ${callId}` } }] } })
}
function sdkAnswer(index: number, uuid: string, text: string, parentToolUseId?: string) {
  return sdk(index, uuid, { type: 'assistant', ...(parentToolUseId ? { isSidechain: true, parentToolUseId } : {}),
    message: { model: 'original-sdk-model', content: [{ type: 'text', text }] } })
}
function taskResult(index: number, uuid: string, callId: string, parentToolUseId?: string) {
  return sdk(index, uuid, { type: 'user', ...(parentToolUseId ? { isSidechain: true, parentToolUseId } : {}),
    message: { content: [{ type: 'tool_result', tool_use_id: callId, content: `Task ${callId} finished` }] } })
}
function trace(index: number, id: string, child: string, message: Record<string, unknown>, parentThreadId = 'native-parent-thread') {
  return row(index, `trace-row:${index}`, 'codex', { type: 'agent-run-trace', id, agentId: child, cardId: `codex-agent:${child}`,
    scope: { role: 'child', threadId: child, parentThreadId }, scope_role: 'child', message: { ...message, id } }, message.streamSnapshot ? null : id)
}
function run(index: number, child: string, status: string, extra: Record<string, unknown> = {}) {
  return row(index, `run:${index}`, 'codex', { type: 'agent-run-update', agentId: child, cardId: `codex-agent:${child}`, status,
    scope: { role: 'child', threadId: child, parentThreadId: 'native-parent-thread' }, ...extra })
}
async function mount(source: Source, directory: string, native = false) {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime)
  let service: CodexService | HapiAgentService | undefined
  await ctx.plugin(Object.assign(async (owner: Context) => {
    service = native ? new CodexService(owner, source, { stateDirectory: directory })
      : new HapiAgentService(owner, source, { stateDirectory: directory })
    await service.start()
  }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
  assert.ok(service)
  assert.deepEqual([...service.failures()], [])
  return { ctx, service, async close() { await service!.dispose(); await ctx.fiber.dispose() } }
}
function texts(agent: { sourceFrameBaseline(): SourceFrameBatch }): string[] {
  return bodyEvents(agent).flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
}
const bodyEvents = projectedSourceEvents

test('source scope index resolves exact SDK tool and legacy UUID chains while keeping ambiguous orphans separate', () => {
  const rows = [task(1, 'parent-call', 'task-a', 'A\n\nB'),
    sdk(2, 'legacy-root', { type: 'user', isSidechain: true, message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }),
    sdk(3, 'legacy-answer', { type: 'assistant', isSidechain: true, parentUuid: 'legacy-root', message: { content: [{ type: 'text', text: 'Legacy child answer' }] } }),
    task(4, 'nested-call', 'task-b', 'Nested', 'task-a'), sdkAnswer(5, 'nested-answer', 'Nested child answer', 'task-b'),
    task(6, 'ambiguous-call-1', 'ambiguous-a', 'same'), task(7, 'ambiguous-call-2', 'ambiguous-b', 'same'),
    sdk(8, 'orphan-a', { type: 'user', isSidechain: true, message: { content: 'same' } }),
    sdk(9, 'orphan-b', { type: 'assistant', isSidechain: true, parentUuid: 'missing-parent-b', message: { content: [{ type: 'text', text: 'Unmatched child' }] } })]
  const index = new ObservedScopeIndex(); index.update(rows, true)
  assert.equal(index.forRow(rows[1]!).scopeId, 'sdk-tool:task-a')
  assert.equal(index.forRow(rows[2]!).scopeId, 'sdk-tool:task-a')
  assert.equal(index.forRow(rows[4]!).scopeId, 'sdk-tool:task-b')
  assert.equal(index.scopes().find(value => value.scopeId === 'sdk-tool:task-b')?.parentScopeId, 'sdk-tool:task-a')
  assert.match(index.forRow(rows[7]!).scopeId!, /^sdk-orphan:/)
  assert.notEqual(index.forRow(rows[7]!).scopeId, index.forRow(rows[8]!).scopeId)
  assert.ok(parseObservedHistory(rows).filter(item => item.kind === 'assistant' && item.text.includes('child')).every(item => item.scopeId !== null))
  const orphan = new ObservedScopeIndex(); orphan.update([rows[2]!])
  assert.throws(() => orphan.update(rows, true), NativeHistoryChangedError)
})

test('actual SDK parent and nested children become separate official Sessions with exact read-only ownership', async () => {
  const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hapi-sidechains-')), source = new Source()
  source.rows = [task(1, 'task-a-call', 'task-a', 'Explore'), sdkAnswer(2, 'a-answer', 'A child answer', 'task-a'),
    task(3, 'task-b-call', 'task-b', 'Nested', 'task-a'), sdkAnswer(4, 'b-answer', 'B child answer', 'task-b'),
    taskResult(5, 'b-result', 'task-b', 'task-a'), taskResult(6, 'a-result', 'task-a'), sdkAnswer(7, 'parent-answer', 'Parent answer')]
  const app = await mount(source, directory)
  try {
    const parent = app.service.list()[0]!, a = parent.childSessions.find(value => value.scopeInfo.scopeId === 'sdk-tool:task-a')!,
      b = parent.childSessions.find(value => value.scopeInfo.scopeId === 'sdk-tool:task-b')!
    assert.ok(a && b); assert.equal(app.service.list().length, 1)
    assert.equal(app.service.get(a.id), undefined); assert.equal(app.service.get(a.logicalSessionId), undefined)
    assert.equal(app.ctx.agents.get(a.id), a); assert.equal(app.ctx.sessions.get(b.id), b.session)
    assert.equal(a.session.header.parentSession, parent.id); assert.equal(a.session.header.origin, 'subagent')
    assert.equal(b.session.header.parentSession, a.id); assert.equal(b.session.header.delegationDepth, 2)
    assert.deepEqual(texts(parent), ['Parent answer']); assert.deepEqual(texts(a), ['A child answer']); assert.deepEqual(texts(b), ['B child answer'])
    assert.equal(a.projection.sidechain?.status, 'completed'); assert.equal(b.projection.sidechain?.status, 'completed')
    assert.equal(bodyEvents(a).filter(event => event.type === 'turn/end').length, 1)
    assert.equal(app.ctx.sessionProjections.snapshot(a.session, ['hapiObserved']).values.hapiObserved?.readOnly, true)
    assert.ok(Object.values(a.projection.capabilities).every(value => value === false)); assert.equal(a.projection.delivery.length, 0)
    assert.equal(a.projection.pendingRequests.length, 0)
    const message = createUserMessage({ content: [{ type: 'text', text: 'Must not execute' }], source: { kind: 'user' } })
    for (const write of [() => a.followup(message), () => a.steer(message), () => a.inject(message),
      () => a.send(message, 'next-turn', true), () => a.inbox.append('next-turn', message), () => a.cancel({ kind: 'user' }),
      () => a.runMaintenance(async () => undefined)]) assert.throws(write, /read-only/)
    a.cancel({ kind: 'disposed' }); await a.whenIdle()
    let global = 0
    app.ctx.commands.register({ name: 'late-child-command', description: 'Fixture', handler: () => { global++; return { kind: 'success' } } })
    await assert.rejects(app.ctx.commands.execute(a, '/late-child-command', [], new AbortController().signal), /read-only/)
    assert.equal(global, 0)
    await parent.refresh(true)
    assert.equal(app.service.list()[0]!.displayRevision, 0); assert.deepEqual(texts(a), ['A child answer'])
    assert.equal(source.sent.length, 0); assert.deepEqual(source.mutations, [])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
  assert.deepEqual(source.mutations, [])
})

test('native agent-run cumulative traces retain real child thread identity and do not contaminate the native parent', async () => {
  const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hapi-native-children-')), source = new Source(true)
  const nativeExecution = { threadId: 'child-thread', turnId: 'child-turn', itemId: 'child-answer' }
  source.rows = [run(1, 'child-thread', 'running'),
    trace(2, 'child-message', 'child-thread', { type: 'message', message: 'Part', streamSnapshot: true, nativeExecution }),
    trace(3, 'child-message', 'child-thread', { type: 'message', message: 'Full child answer', nativeExecution }),
    run(4, 'child-thread', 'completed'), run(5, 'child-thread', 'running', { activityKind: 'wait_agent' }),
    run(6, 'child-thread', 'canceled', { activityKind: 'close_agent' })]
  const app = await mount(source, directory, true)
  try {
    const parent = app.service.list()[0]!, child = parent.childSessions[0]!
    assert.ok(child); assert.equal(parent.childSessions.length, 1); assert.equal(app.service.get(child.id), undefined)
    assert.equal(child.projection.nativeId, 'child-thread'); assert.equal(child.projection.flavor, 'codex')
    assert.equal(child.projection.sidechain?.rootSessionId, parent.id); assert.equal(child.projection.sidechain?.status, 'completed')
    assert.equal(app.ctx.sessionProjections.snapshot(child.session, ['hapiObserved']).values.hapiObserved?.sidechain?.sourceAgentId, 'child-thread')
    assert.deepEqual(texts(child), ['Full child answer']); assert.deepEqual(texts(parent), [])
    assert.equal(bodyEvents(child).filter(event => event.type === 'user/message').length, 0)
    assert.equal(bodyEvents(child).filter(event => event.type === 'turn/end').length, 1)
    await parent.refresh(true); assert.equal(app.service.list()[0]!.displayRevision, 0)
    source.isConnected = false; source.emit({ type: 'connection-changed', data: { status: 'disconnected' } }); await app.service.settled()
    assert.equal(child.projection.connection, 'disconnected'); await assert.rejects(child.whenIdle(), /not confirmed/)
    assert.equal(source.sent.length, 0); assert.deepEqual(source.mutations, [])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('source child lineage changes retire only that view; corrections preserve its current Agent and Session', async () => {
  const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hapi-child-generation-')), source = new Source()
  const answer = sdk(3, 'late-child', { type: 'assistant', isSidechain: true, parentUuid: 'late-root', message: { content: [{ type: 'text', text: 'Original child' }] } })
  source.rows = [answer]
  const app = await mount(source, directory)
  try {
    const oldParent = app.service.list()[0]!, oldChild = oldParent.childSessions[0]!
    source.rows = [task(1, 'late-call', 'task-late', 'Late prompt'),
      sdk(2, 'late-root', { type: 'user', isSidechain: true, message: { content: 'Late prompt' } }), answer]
    await oldParent.refresh(true)
    const current = app.service.list()[0]!, child = current.childSessions[0]!
    assert.equal(current, oldParent); assert.equal(current.displayRevision, 0); assert.notEqual(child.id, oldChild.id)
    assert.equal(child.scopeInfo.scopeId, 'sdk-tool:task-late'); assert.equal(app.ctx.agents.get(oldChild.id), undefined)
    assert.throws(() => oldChild.followup(createUserMessage({ content: [{ type: 'text', text: 'stale' }], source: { kind: 'user' } })), /read-only/)
    const session = child.session
    source.rows[2] = sdk(3, 'late-child', { type: 'assistant', isSidechain: true, parentUuid: 'late-root', message: { content: [{ type: 'text', text: 'Rewritten child' }] } })
    await current.refresh(true)
    assert.equal(app.service.list()[0], oldParent); assert.equal(current.displayRevision, 0)
    assert.equal(current.childSessions[0], child); assert.equal(child.session, session)
    assert.deepEqual(texts(child), ['Rewritten child'])
    assert.equal(app.ctx.agents.get(child.id), child); assert.equal(app.ctx.sessions.get(child.id), session)
    const restored = [...source.rows]
    source.rows = []
    await current.refresh(true)
    assert.equal(app.service.list()[0], oldParent); assert.equal(current.childSessions.length, 0)
    assert.equal(app.ctx.agents.get(child.id), undefined)
    source.rows = restored
    await current.refresh(true)
    const recreated = current.childSessions[0]!
    assert.notEqual(recreated.id, child.id, 'a removed public child identity cannot be reused by a new view')
    assert.equal(recreated.logicalSessionId, child.logicalSessionId)
    assert.deepEqual(texts(recreated), ['Rewritten child'])
    assert.equal(source.sent.length, 0); assert.deepEqual(source.mutations, [])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a child publishes live source text and commits one final body without replacing its Session', async () => {
  const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hapi-child-live-')), source = new Source(true)
  const nativeExecution = { threadId: 'child-thread', turnId: 'child-turn', itemId: 'child-answer' }
  source.rows = [run(1, 'child-thread', 'running'),
    trace(2, 'child-message', 'child-thread', { type: 'message', message: 'Part', streamSnapshot: true, nativeExecution })]
  const app = await mount(source, directory, true)
  try {
    const parent = app.service.list()[0]!, child = parent.childSessions[0]!, session = child.session
    assert.ok(child instanceof HapiObservedChild)
    const sourceStream = child.sourceFrames(new AbortController().signal)[Symbol.asyncIterator]()
    const window = new SourceWindowStore()
    window.apply((await sourceStream.next()).value!)
    const visible = () => window.entries.flatMap(entry => entry.event.type === 'assistant/message'
      ? entry.event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    assert.deepEqual(visible(), ['Part'])
    const partial = child.currentSourceFrames().find(frame => frame.transient)!
    assert.ok(partial)
    const update = trace(3, 'child-message', 'child-thread', { type: 'message', message: 'Partial reply', streamSnapshot: true, nativeExecution })
    source.rows.push(update); source.emit({ type: 'message-received', sessionId: 'parent', message: update })
    await app.service.settled()
    window.apply((await sourceStream.next()).value!)
    assert.deepEqual(visible(), ['Partial reply'])
    assert.equal(child.currentSourceFrames().find(frame => frame.transient)?.key, partial.key)
    const final = trace(4, 'child-message', 'child-thread', { type: 'message', message: 'Finished reply', nativeExecution })
    source.rows.push(final); source.emit({ type: 'message-received', sessionId: 'parent', message: final })
    await app.service.settled()
    window.apply((await sourceStream.next()).value!)
    assert.equal(app.service.list()[0], parent); assert.equal(parent.childSessions[0], child); assert.equal(child.session, session)
    assert.deepEqual(visible(), ['Finished reply'])
    assert.equal(child.currentSourceFrames().find(frame => frame.key === partial.key)?.transient, undefined)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 0,
      'the transport Session never becomes a second transcript owner')
    assert.ok(session.snapshotEvents().every(event => String(event.type) !== SOURCE_FRAME_EVENT))
    await sourceStream.return?.()
    assert.deepEqual(source.mutations, [])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('source child trace rejects a foreign native execution instead of relabeling its thread', () => {
  const rows = [trace(1, 'foreign-trace', 'child-a', { type: 'message', message: 'Wrong owner',
    nativeExecution: { threadId: 'child-b', turnId: 'turn-b', itemId: 'item-b' } })]
  assert.throws(() => parseObservedHistory(rows), /different agent identity/)
})
