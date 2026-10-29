/** Source wire and import timing are explicit fixtures. These regressions run
 * the production journal/agents and the real pinned Session/Agent registries. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { HapiEvent, HapiMessage, HapiMessagesPage, HapiSession } from '../src/codex/contracts.js'
import { NativeCodexAgent } from '../src/codex/agent.js'
import { CodexService } from '../src/codex/service.js'
import { HapiObservedAgent, type HapiObservedTransport } from '../src/hapi-agent/agent.js'
import { HapiAgentService } from '../src/hapi-agent/service.js'
import type { NativeArtifactBlock } from '../src/codex/content.js'
import { HistoryReadInvalidatedError, SourceHistoryJournal } from '../src/codex/history-journal.js'
import { SOURCE_FRAME_EVENT } from '../src/shared/source-frames.ts'
import { SourceWindowStore } from '../src/client/source-window-store.ts'
import { SOURCE_PROJECTION_MAX_ROWS } from '../src/shared/source-projection-window.ts'

function stream(text: string, final: boolean): HapiMessage {
  return { id: `${final ? 'committed' : 'provisional'}:${text}`, seq: 4, localId: final ? 'shared-stream' : null,
    createdAt: 4000, content: { role: 'agent', content: { type: 'codex',
      data: { type: 'message', id: 'shared-stream', streamSnapshot: true, message: text } } } }
}

test('a final live row captured before a history read survives a matching stale provisional overlap', () => {
  const journal = new SourceHistoryJournal(), final = stream('Completed source answer', true)
  journal.capture({ type: 'message-received', sessionId: 'source', message: final })
  const checkpoint = journal.checkpoint()
  assert.deepEqual(journal.merge([stream('Completed source', false)], checkpoint), [final])
})

test('pre-read invoked source input cannot return to a stale queued state with null or omitted invocation time', () => {
  const invoked: HapiMessage = { id: 'invoked-row', seq: 3, localId: 'original-input', createdAt: 1000, invokedAt: 3000,
    content: { role: 'user', content: { type: 'text', text: 'Original source input' } } }
  for (const invokedAt of [null, undefined]) {
    const journal = new SourceHistoryJournal()
    journal.capture({ type: 'message-received', sessionId: 'source', message: invoked })
    const stale = { ...invoked, id: 'queued-row', seq: 1 }
    if (invokedAt === undefined) delete stale.invokedAt
    else stale.invokedAt = invokedAt
    assert.deepEqual(journal.merge([stale], journal.checkpoint()), [invoked])
  }
})

test('cumulative pre-read stream progress cannot shrink while newer source progress and final correction remain authoritative', () => {
  const journal = new SourceHistoryJournal(), live = stream('The longer live prefix', false)
  journal.capture({ type: 'message-received', sessionId: 'source', message: live })
  const checkpoint = journal.checkpoint()
  assert.deepEqual(journal.merge([stream('The longer', false)], checkpoint), [live])
  const later = stream('The longer live prefix with an indexed suffix', false)
  assert.deepEqual(journal.merge([later], checkpoint), [later])
  const committed = stream('The original final answer', true)
  journal.capture({ type: 'message-received', sessionId: 'source', message: committed })
  const correction = stream('The source-corrected final answer', true)
  assert.deepEqual(journal.merge([correction], journal.checkpoint()), [correction])
})

test('repeated journal evictions cannot downgrade proof that a stream already committed', () => {
  const journal = new SourceHistoryJournal(1), final = stream('Completed source answer', true)
  journal.capture({ type: 'message-received', sessionId: 'source', message: final })
  journal.capture({ type: 'message-received', sessionId: 'source', message: stream('Completed source', false) })
  const delayed = stream('Completed', false)
  journal.capture({ type: 'message-received', sessionId: 'source', message: delayed })
  assert.throws(() => journal.merge([delayed], journal.checkpoint()), HistoryReadInvalidatedError)
  assert.deepEqual(journal.merge([final], journal.checkpoint()), [final])
})

type Kind = 'native' | 'observed'
function input(id: string, seq: number, kind: Kind, artifact = false): HapiMessage {
  return { id: `row:${id}`, seq, localId: id, createdAt: seq * 1000, invokedAt: seq * 1000,
    content: { role: 'user', content: { type: 'text', text: id, ...(artifact ? { parts: [
      { type: 'text', text: id },
      { type: 'artifact', artifact: { id: `file:${id}`, fileName: `${id}.txt`, mimeType: 'text/plain' } },
    ] } : {}) }, ...(kind === 'native' ? { meta: { nativeExecution: { threadId: 'race-thread', turnId: 'race-turn', itemId: id } } } : {}) } }
}

function page(rows: readonly HapiMessage[]): HapiMessagesPage {
  return { messages: structuredClone([...rows]), page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
    nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null,
    snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } }
}

async function fixture(kind: Kind) {
  const directory = await mkdtemp(join(tmpdir(), `hapi-history-${kind}-race-`)), ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime)
  let owner!: Context
  await ctx.plugin({ name: 'history-race-fixture', inject: ['sessions', 'agents', 'sessionProjections'], apply(value: Context) { owner = value } })
  const source: HapiSession = { id: 'race-source', namespace: 'fixture', seq: 1, createdAt: 1000, updatedAt: 1000,
    active: true, activeAt: 1000, thinking: false, thinkingAt: 1000, metadataVersion: 1, agentStateVersion: 1,
    agentState: { requests: {}, completedRequests: {} }, metadata: { path: '/synthetic/project', name: 'Synthetic history race',
      machineId: 'synthetic-machine', ...(kind === 'native' ? { flavor: 'codex', codexNativeSession: true, codexSessionId: 'race-thread' }
        : { flavor: 'claude', claudeSessionId: 'race-thread' }) } }
  let rows: HapiMessage[] = []
  const mutations: string[] = [], created: string[] = [], createdAgents: string[] = [], operationEvents: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => { operationEvents.push(event) })
  const listeners = new Set<(event: HapiEvent) => void>()
  ctx.on('session/created', session => { created.push(session.id) })
  ctx.on('agent/created', ({ agent }) => { createdAgents.push(agent.id); return undefined })
  const transport: HapiObservedTransport = {
    hubId: 'history-race-fixture', listSessions: async () => [structuredClone(source)], getSession: async () => structuredClone(source),
    readMessages: async () => page(rows), getQueuedState: async () => ({ queuedLocalIds: [], invokedLocalMessages: [] }),
    sendMessage: async () => { mutations.push('send') }, abortSession: async () => { mutations.push('abort') },
    cancelQueuedMessage: async () => { mutations.push('cancel'); return { status: 'cancelled', localId: null } },
    steerQueuedMessage: async () => { mutations.push('steer'); return { status: 'steered', localId: 'fixture' } },
    retryIndeterminateMessage: async () => { mutations.push('retry'); return { status: 'not-found' } },
    approve: async () => { mutations.push('approve') }, deny: async () => { mutations.push('deny') },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, request: async () => ({}),
  }
  const journal = new SourceHistoryJournal()
  const create = (initialRows: HapiMessage[], importer: () => Promise<NativeArtifactBlock>) => {
    const options = { stateDirectory: directory, historyJournal: journal, historyCheckpoint: journal.checkpoint(), importArtifact: importer }
    return kind === 'native' ? NativeCodexAgent.create(owner, transport, source, options, initialRows)
      : HapiObservedAgent.create(owner, transport, source, options, initialRows)
  }
  const startService = async (importer: () => Promise<NativeArtifactBlock>) => {
    const options = { stateDirectory: directory, importArtifact: importer }
    const service = kind === 'native' ? new CodexService(owner, transport, options) : new HapiAgentService(owner, transport, options)
    await service.start()
    return service
  }
  return { ctx, source, journal, created, createdAgents, mutations, operationEvents, create, startService, setRows(next: HapiMessage[]) { rows = next },
    emit(event: HapiEvent) { for (const listener of listeners) listener(event) },
    async close() { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

function importGate() {
  let begin!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { begin = resolve }), pending = new Promise<void>(resolve => { release = resolve })
  return { started, release, async importer(): Promise<NativeArtifactBlock> {
    begin(); await pending
    return { type: 'file', attachment: { attachmentId: AttachmentId('synthetic-race-file'), name: 'fixture.txt', bytes: 4 } }
  } }
}

for (const kind of ['native', 'observed'] as const) {
  test(`${kind} live partial and final body share canonical identity without an operation-stream sequence bridge`, async () => {
    const f = await fixture(kind), gate = importGate(), agent = await f.create([], gate.importer)
    const streamAbort = new AbortController(), bodyStore = new SourceWindowStore()
    const sourceFrames = agent.sourceFrames(streamAbort.signal)[Symbol.asyncIterator]()
    bodyStore.apply((await sourceFrames.next()).value!)
    const operationEvents: SessionEvent[] = []
    const stopOperations = f.ctx.on('session/event', (session, event) => { if (session.id === agent.id) operationEvents.push(event) })
    let assistantEvents = 0
    const stop = f.ctx.on('agent/assistant-stream', () => { assistantEvents++ })
    const body = (text: string, final: boolean) => {
      const value = stream(text, final)
      return { ...value, content: { ...(value.content as object), meta: { nativeExecution: { threadId: 'race-thread', turnId: 'stream-turn', itemId: 'shared-stream' } } } }
    }
    try {
      await agent.handleEvent({ type: 'message-received', sessionId: f.source.id, message: body('Partial source answer', false) })
      bodyStore.apply((await sourceFrames.next()).value!)
      const partial = bodyStore.frames.find(frame => frame.transient)
      assert.ok(partial)
      const operationOwner = agent.session
      await agent.handleEvent({ type: 'message-received', sessionId: f.source.id, message: body('Partial source answer completed', true) })
      bodyStore.apply((await sourceFrames.next()).value!)
      const final = bodyStore.frames.find(frame => frame.key === partial.key)
      assert.ok(final && !final.transient)
      assert.equal(agent.session, operationOwner)
      assert.equal(assistantEvents, 0, 'source body updates have one canonical channel, without fabricated operation event references')
      assert.ok(!operationEvents.some(event => String(event.type) === SOURCE_FRAME_EVENT))
      assert.equal(bodyStore.frames.filter(frame => frame.key === partial.key).length, 1)
    } finally { streamAbort.abort(); await sourceFrames.return?.(); stopOperations(); stop(); await agent.dispose(); await f.close() }
  })

  test(`${kind} resident history trims old turns and rebuilds projection indexes without replacing its operation owner`, async () => {
    const f = await fixture(kind), gate = importGate()
    const rows = Array.from({ length: SOURCE_PROJECTION_MAX_ROWS + 2 }, (_, index) => input(`bounded-${index}`, index + 1, kind))
    const agent = await f.create(rows, gate.importer), owner = agent.session
    try {
      const users = () => agent.currentSourceFrames().filter(frame => frame.event.type === 'user/message')
      assert.equal(users().length, SOURCE_PROJECTION_MAX_ROWS)
      assert.ok(users().every(frame => frame.source!.seq >= 3))
      const next = input('bounded-next', SOURCE_PROJECTION_MAX_ROWS + 3, kind)
      await agent.handleEvent({ type: 'message-received', sessionId: f.source.id, message: next })
      assert.equal(users().length, SOURCE_PROJECTION_MAX_ROWS)
      assert.ok(users().every(frame => frame.source!.seq >= 4))
      assert.equal(agent.session, owner)
      assert.equal(f.ctx.agents.get(agent.id), agent)
      assert.deepEqual(f.created, [agent.id]); assert.deepEqual(f.createdAgents, [agent.id])
      assert.equal(agent.historyWindowAnchor()?.hasOlder, true)
      assert.equal(agent.sourceFrameBaseline().hasMoreBefore, true)
      assert.equal(agent.sourceHistoryVersion(), 0, 'bounded clipping is not an authoritative source rewrite')
      assert.ok(!f.operationEvents.some(event => String(event.type) === SOURCE_FRAME_EVENT), 'neither initial seed nor clipped body enters the operation log')
    } finally { await agent.dispose(); await f.close() }
  })

  test(`${kind} seed invalidated during content preparation never enters or announces its obsolete display`, { timeout: 10_000 }, async () => {
    const f = await fixture(kind), gate = importGate()
    let agent: Awaited<ReturnType<typeof f.create>> | undefined
    const creating = f.create([input('removed-before-publication', 1, kind, true)], gate.importer)
    const outcome = creating.then(value => { agent = value; return undefined }, error => error as unknown)
    try {
      await Promise.race([gate.started, outcome.then(error => { throw error ?? new Error('The import preparation gate was not reached') })])
      f.journal.capture({ type: 'messages-invalidated', sessionId: f.source.id, reason: 'rewind' })
      gate.release()
      assert.ok(await outcome instanceof HistoryReadInvalidatedError)
      assert.deepEqual(f.created, [], 'no old-generation Session announcement may escape while preparing its seed')
      assert.deepEqual(f.mutations, [])
    } finally { gate.release(); await outcome; await agent?.dispose(); await f.close() }
  })

  test(`${kind} authoritative refresh invalidated during content import cannot append its removed input`, { timeout: 10_000 }, async () => {
    const f = await fixture(kind), gate = importGate(), original = input('retained-original', 1, kind)
    const agent = await f.create([original], gate.importer)
    try {
      f.setRows([original, input('removed-during-import', 2, kind, true)])
      const refreshing = agent.refresh(true)
      const outcome = refreshing.then(() => undefined, error => error as unknown)
      await Promise.race([gate.started, outcome.then(error => { throw error ?? new Error('The import preparation gate was not reached') })])
      f.journal.capture({ type: 'messages-invalidated', sessionId: f.source.id, reason: 'rewind' })
      const replacement = input('replacement-source-input', 3, kind)
      f.setRows([original, replacement]); gate.release()
      assert.ok(await outcome instanceof HistoryReadInvalidatedError)
      const userText = () => agent.currentSourceFrames().map(frame => frame.event as SessionEvent).flatMap(event => event.type === 'user/message'
        ? event.data.content.flatMap(part => part.type === 'text' ? [part.text] : []) : [])
      assert.deepEqual(userText(), ['retained-original'])
      await agent.refresh(true)
      assert.deepEqual(userText(), ['retained-original', 'replacement-source-input'])
      assert.deepEqual(f.mutations, [], 'reconciliation must never write to the original execution')
    } finally { gate.release(); await agent.dispose(); await f.close() }
  })

  test(`${kind} invalidated rebaseline preparation keeps the published body and operation owner intact`, async () => {
    const f = await fixture(kind), gate = importGate(), original = input('visible-owner-history', 2, kind)
    const agent = await f.create([original], gate.importer), owner = agent.session
    const before = agent.sourceFrameBaseline(), checkpoint = f.journal.checkpoint()
    const rebuilding = agent.rebaseDisplayHistory([input('obsolete-prefix', 1, kind, true), original], checkpoint)
    const outcome = rebuilding.then(() => undefined, error => error)
    try {
      await gate.started
      f.journal.capture({ type: 'messages-invalidated', sessionId: f.source.id, reason: 'rewind' })
      gate.release()
      assert.ok(await outcome instanceof HistoryReadInvalidatedError)
      assert.deepEqual(agent.sourceFrameBaseline(), before)
      assert.equal(agent.session, owner); assert.equal(f.ctx.agents.get(agent.id), agent)
      assert.deepEqual(f.createdAgents, [agent.id]); assert.deepEqual(f.created, [agent.id])
      assert.deepEqual(f.mutations, [])
    } finally { gate.release(); await outcome; await agent.dispose(); await f.close() }
  })

  test(`${kind} history rebaseline keeps one writable Agent and the same display identity while preparing replacement content`, { timeout: 10_000 }, async () => {
    const f = await fixture(kind), gate = importGate(), tail = input('retained-tail', 2, kind)
    f.setRows([tail])
    const service = await f.startService(gate.importer)
    const previous = service.list()[0]!
    const previousSession = previous.session, previousRevision = previous.displayRevision, previousHistoryVersion = previous.sourceHistoryVersion()
    let replacing: Promise<unknown> | undefined
    try {
      f.setRows([input('earlier-backfill', 1, kind, true), tail])
      replacing = previous.refresh(true)
      const outcome = replacing.then(() => undefined, error => error as unknown)
      await Promise.race([gate.started, outcome.then(error => { throw error ?? new Error('The replacement preparation gate was not reached') })])
      assert.equal(service.list()[0], previous)
      assert.equal(f.ctx.agents.get(previous.id), previous)
      assert.doesNotThrow(() => previous.followup(createUserMessage({ content: [{ type: 'text', text: 'Input stays with its original execution owner' }],
        source: { kind: 'user' } })))
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(f.mutations, ['send'], 'history preparation cannot retire the only delivery owner or create another writer')
      gate.release(); assert.equal(await outcome, undefined)
      const current = service.list()[0]!
      assert.equal(current, previous)
      assert.equal(current.id, previous.id)
      assert.equal(current.displayRevision, previousRevision)
      assert.ok(current.sourceHistoryVersion() > previousHistoryVersion, 'authoritative rebaseline remains detectable after reconnect')
      assert.equal(current.session, previousSession)
      assert.deepEqual(f.created, [previous.id])
      assert.equal(current.logicalSessionId, previous.logicalSessionId)
      assert.deepEqual(f.createdAgents, [previous.id], 'history revisions announce no replacement Agent')
      assert.deepEqual(current.currentSourceFrames().map(frame => frame.event as SessionEvent).flatMap(event => event.type === 'user/message'
        ? event.data.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []), ['earlier-backfill', 'retained-tail'])
    } finally { gate.release(); await replacing?.catch(() => {}); await service.dispose(); await f.close() }
  })

  test(`${kind} immediate remove and re-add retires the exact old source incarnation`, { timeout: 10_000 }, async () => {
    const f = await fixture(kind), gate = importGate()
    f.setRows([input('retained-source-input', 1, kind)])
    const service = await f.startService(gate.importer), previous = service.list()[0]!
    try {
      f.emit({ type: 'session-removed', sessionId: f.source.id })
      assert.throws(() => previous.followup(createUserMessage({ content: [{ type: 'text', text: 'Removal has already been observed' }],
        source: { kind: 'user' } })), /removed|detached/)
      f.emit({ type: 'session-added', sessionId: f.source.id })
      await service.settled()
      const current = service.list()[0]
      assert.ok(current, 'the explicitly re-added source must have a live observation')
      assert.notEqual(current, previous, 'a retired lifetime must never be reused after its removal queue is superseded')
      assert.notEqual(current.id, previous.id, 'an announced display event namespace must not be recycled by revival')
      assert.equal(current.projection.error, null)
      assert.throws(() => previous.followup(createUserMessage({ content: [{ type: 'text', text: 'Retired source' }], source: { kind: 'user' } })), /detached/)
      assert.deepEqual(f.mutations, [])
    } finally { gate.release(); await service.dispose(); await f.close() }
  })
}
