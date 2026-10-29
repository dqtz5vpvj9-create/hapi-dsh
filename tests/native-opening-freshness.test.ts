import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { NativeHistoryCache } from '../src/codex/history-cache.ts'
import { nativeStateDirectory } from '../src/codex/state-directory.ts'
import { bindingFor, nativeSessionId } from '../src/codex/native.ts'
import { CodexService, type CodexServiceOptions } from '../src/codex/service.ts'
import { SourceHistoryWindow } from '../src/codex/source-window.ts'
import { projectedSourceEvents } from './source-frame-fixture.ts'
import {
  type HapiApprovalAnswer, type HapiCancelResult, type HapiEvent, type HapiMessage, type HapiMessagesPage,
  type HapiMessagesQuery, type HapiQueuedState, type HapiRetryResult, type HapiSendMessage, type HapiSession,
  type HapiSteerResult, type HapiTransport,
} from '../src/codex/contracts.ts'

const THREAD = 'opening-thread-1'
const TURN = 'opening-turn-1'
const EPOCH = 73
const SESSION = 'opening-source-1'

/** Protocol fixture only; DSH Session, AgentRegistry, projections and the Codex service are real packages. */
class FakeHapi implements HapiTransport {
  readonly hubId = 'opening-hub'
  readonly listeners = new Set<(event: HapiEvent) => void>()
  readonly sent: HapiSendMessage[] = []
  readonly reads: HapiMessagesQuery[] = []
  rows: HapiMessage[] = []
  epoch = EPOCH
  maxRowsPerPage = 200
  failure: Error | undefined
  readHook: ((query: HapiMessagesQuery) => HapiMessagesPage | Promise<HapiMessagesPage>) | undefined
  source: HapiSession = {
    id: SESSION, namespace: 'test', seq: 1, createdAt: 1000, updatedAt: 1000,
    active: true, activeAt: 1000, thinking: false, thinkingAt: 1000,
    metadataVersion: 1, agentStateVersion: 1, model: 'gpt-opening-fixture',
    metadata: { path: '/workspace/opening', host: 'Runner opening', machineId: 'opening-machine',
      flavor: 'codex', codexNativeSession: true, codexNativeConnection: 'attached',
      codexSessionId: THREAD, codexHome: '/runner/codex-home', codexHomeId: 'opening-home', name: 'Opening fixture' },
    agentState: { requests: {}, completedRequests: {} },
    executionVersion: 1,
    execution: { owner: 'codex', generation: 'opening-connection', sequence: 1, status: 'idle',
      waitingOn: [], turnId: null, startedAt: null, completedAt: null },
  }

  async listSessions() {
    const { codexNativeSession: _native, codexNativeConnection: _connection, ...metadata } = this.source.metadata!
    return [{ ...this.source, metadata }]
  }
  async getSession(): Promise<HapiSession> { return structuredClone(this.source) }
  async readMessages(_id: string, query: HapiMessagesQuery = {}): Promise<HapiMessagesPage> {
    this.reads.push({ ...query })
    if (this.failure) throw this.failure
    if (this.readHook) return this.readHook(query)
    return this.page(query)
  }
  async sendMessage(_id: string, message: HapiSendMessage): Promise<void> { this.sent.push(structuredClone(message)) }
  async getQueuedState(): Promise<HapiQueuedState> { return { queuedLocalIds: [], invokedLocalMessages: [] } }
  async cancelQueuedMessage(): Promise<HapiCancelResult> { return { status: 'cancelled', localId: null } }
  async steerQueuedMessage(): Promise<HapiSteerResult> { return { status: 'steered', localId: null } }
  async retryIndeterminateMessage(): Promise<HapiRetryResult> { return { status: 'retried', localId: null } }
  async abortSession(): Promise<void> {}
  async approve(_id: string, _requestId: string, _answer: HapiApprovalAnswer): Promise<void> {}
  async deny(_id: string, _requestId: string, _answer: HapiApprovalAnswer = {}): Promise<void> {}
  subscribe(listener: (event: HapiEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event: HapiEvent): void { for (const listener of [...this.listeners]) listener(event) }

  private positioned(): HapiMessage[] {
    return this.rows.filter(row => typeof row.seq === 'number')
      .sort((left, right) => (left.invokedAt ?? left.createdAt) - (right.invokedAt ?? right.createdAt)
        || (left.seq ?? 0) - (right.seq ?? 0))
  }
  private queuedRows(): HapiMessage[] { return this.rows.filter(row => typeof row.seq !== 'number') }
  private static position(row: HapiMessage) { return { at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0 } }
  page(query: HapiMessagesQuery = {}): HapiMessagesPage {
    const limit = Math.min(query.limit ?? 50, this.maxRowsPerPage)
    if (query.epoch !== undefined && query.epoch !== this.epoch) {
      return { messages: [], page: { direction: 'latest', limit, epoch: this.epoch, reset: true,
        nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null,
        snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } }
    }
    const all = this.positioned()
    let selected: HapiMessage[]
    let hasMore: boolean
    let direction: HapiMessagesPage['page']['direction'] = 'latest'
    if (query.afterAt !== undefined && query.afterSeq !== undefined) {
      direction = 'after'
      const after = { at: query.afterAt, seq: query.afterSeq }
      const pool = all.filter(row => {
        const position = FakeHapi.position(row)
        return position.at > after.at || position.at === after.at && position.seq > after.seq
      })
      selected = pool.slice(0, limit); hasMore = pool.length > selected.length
    } else if (query.beforeAt !== undefined && query.beforeSeq !== undefined) {
      direction = 'before'
      const before = { at: query.beforeAt, seq: query.beforeSeq }
      const pool = all.filter(row => {
        const position = FakeHapi.position(row)
        return position.at < before.at || position.at === before.at && position.seq < before.seq
      })
      selected = pool.slice(-limit); hasMore = pool.length > selected.length
    } else {
      selected = all.slice(-limit); hasMore = all.length > selected.length
    }
    const first = selected[0], last = selected.at(-1), head = all.at(-1)
    return {
      messages: structuredClone([...selected, ...this.queuedRows()]),
      page: {
        direction, limit, epoch: this.epoch, reset: false,
        nextBeforeAt: first ? FakeHapi.position(first).at : null,
        nextBeforeSeq: first ? FakeHapi.position(first).seq : null,
        nextAfterAt: last && direction !== 'before' ? FakeHapi.position(last).at : direction === 'after' ? null : last ? FakeHapi.position(last).at : null,
        nextAfterSeq: last && direction !== 'before' ? FakeHapi.position(last).seq : direction === 'after' ? null : last ? FakeHapi.position(last).seq : null,
        snapshotHeadAt: head ? FakeHapi.position(head).at : null,
        snapshotHeadSeq: head ? FakeHapi.position(head).seq : null,
        hasMore,
      },
    }
  }
}

function userRow(turn = TURN, seq = 1, at = 1000, localId = 'opening-user'): HapiMessage {
  return { id: `user:${localId}`, localId, seq, createdAt: at, invokedAt: at,
    content: { role: 'user', content: { type: 'text', text: `Question ${localId}` },
      meta: { nativeExecution: { threadId: THREAD, turnId: turn, itemId: localId } } } }
}

function agentRow(itemId: string, turn = TURN, seq = 2, at = 1001, text = `Answer ${itemId}`): HapiMessage {
  const stable = `codex:${THREAD}:${turn}:${itemId}:message`
  return { id: `native:${stable}`, localId: stable, seq, createdAt: at,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: stable, message: text,
      streamSnapshot: true, nativeExecution: { threadId: THREAD, turnId: turn, itemId } } } } }
}

function queuedPrompt(id: string, at = 900): HapiMessage {
  return { id, localId: id, seq: null, createdAt: at, invokedAt: null,
    content: { meta: { sentFrom: 'webapp', deliveryMode: 'queue', queueDismissed: true }, role: 'user',
      content: { type: 'text', text: `Dismissed ${id}` } } }
}

async function mount(fake: FakeHapi, directory: string, options: Partial<CodexServiceOptions> = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  let service: CodexService | undefined
  const errors: string[] = []
  await ctx.plugin(Object.assign(async (owner: Context) => {
    service = new CodexService(owner, fake, {
      stateDirectory: directory, fastHistorySeed: true, discovery: 'on-demand',
      onError: error => { errors.push(error.message) }, ...options,
    })
    await service.start()
  }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
  assert.ok(service)
  return { ctx, service, errors, async close() { await service!.dispose(); await ctx.fiber.dispose() } }
}

function openingCache(directory: string, fake: FakeHapi): NativeHistoryCache {
  const logical = nativeSessionId(fake.hubId, fake.source.id)
  return new NativeHistoryCache(nativeStateDirectory(directory, logical, bindingFor(fake.hubId, fake.source)), logical)
}

test('same-epoch ordinary append stays in the opening owner without an archive read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-opening-append-')), fake = new FakeHapi()
  fake.rows = [userRow(), agentRow('first', TURN, 2, 1001), queuedPrompt('queued-old', 900)]
  const app = await mount(fake, directory)
  try {
    const agent = await app.service.openSource(fake.source.id)
    assert.ok(agent)
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(fake.rows[1]!.id), undefined)
    const revision = agent.displayRevision, identity = agent.id, reads = fake.reads.length
    const next = agentRow('second', TURN, 3, 1002)
    fake.rows.push(next)
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: next })
    await app.service.settled()
    assert.equal(app.service.list()[0], agent, 'a live append keeps the same Agent')
    assert.equal(agent.displayRevision, revision)
    assert.equal(agent.id, identity)
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(next.id), undefined)
    await agent.refresh(true)
    await app.service.settled()
    assert.equal(app.service.list()[0], agent, 'ordinary refresh keeps the same Agent')
    assert.equal(agent.displayRevision, revision)
    assert.equal(fake.reads.slice(reads).some(query => query.afterAt !== undefined), true,
      'catch-up reads forward from the resident tail')
    assert.equal(fake.sent.length, 0); assert.equal(agent.projection.error, null)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a message arriving during the opening read is appended after the seed, not dropped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-opening-race-')), fake = new FakeHapi()
  fake.rows = [userRow(), agentRow('seed', TURN, 2, 1001)]
  let release!: (page: HapiMessagesPage) => void, reading!: () => void
  const blocked = new Promise<HapiMessagesPage>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  let first = true
  fake.readHook = query => {
    if (!first) return fake.page(query)
    first = false; reading(); return blocked
  }
  const app = await mount(fake, directory)
  try {
    const opening = app.service.openSource(fake.source.id)
    await started
    const snapshot = fake.page({ limit: 200, bounded: true })
    const live = agentRow('during-open', TURN, 3, 1002)
    fake.rows.push(live)
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: live })
    release(snapshot)
    const agent = await opening
    assert.ok(agent)
    await app.service.settled()
    assert.equal(app.service.list()[0], agent)
    assert.equal(agent.displayRevision, 0)
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(live.id), undefined)
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(fake.rows[1]!.id), undefined)
    assert.equal(fake.sent.length, 0)
  } finally { release(fake.page({ limit: 200, bounded: true })); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a reconnect after missed updates catches up forward in the same display owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-opening-reconnect-')), fake = new FakeHapi()
  fake.maxRowsPerPage = 7
  fake.rows = [userRow(), agentRow('before-gap', TURN, 2, 1001)]
  const app = await mount(fake, directory)
  try {
    const agent = await app.service.openSource(fake.source.id)
    assert.ok(agent)
    const revision = agent.displayRevision
    for (let index = 0; index < 25; index++) fake.rows.push(agentRow(`missed-${index}`, TURN, 3 + index, 1002 + index))
    const missed = fake.rows.at(-1)!
    const reads = fake.reads.length
    fake.emit({ type: 'connection-changed', data: { status: 'disconnected' } })
    fake.emit({ type: 'connection-changed', data: { status: 'connected' } })
    await app.service.settled()
    assert.equal(app.service.list()[0], agent, 'reconnect never replaces the display')
    assert.equal(agent.displayRevision, revision)
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(missed.id), undefined)
    assert.ok(fake.reads.slice(reads).some(query => query.afterAt !== undefined),
      'missed updates are read in order from the last resident source position')
    assert.equal(fake.sent.length, 0); assert.equal(agent.projection.error, null)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

function initialThread(fake: FakeHapi): string { return fake.source.metadata!.codexSessionId! }

test('a live row arriving first is merged with an in-flight forward page in source order, without replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-opening-forward-race-')), fake = new FakeHapi()
  fake.rows = [userRow(), agentRow('base', TURN, 2, 1001)]
  let release!: () => void, reading!: () => void, blocked = false, forwardFinished = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  fake.readHook = query => {
    if (query.afterAt !== undefined && !blocked) {
      blocked = true; reading(); return gate.then(() => { forwardFinished = true; return fake.page(query) })
    }
    return fake.page(query)
  }
  const app = await mount(fake, directory)
  const sourceAbort = new AbortController()
  let refreshing: Promise<void> | undefined
  try {
    const agent = await app.service.openSource(fake.source.id)
    assert.ok(agent)
    const revision = agent.displayRevision, identity = agent.id
    const updates = agent.sourceFrames(sourceAbort.signal)[Symbol.asyncIterator]()
    await updates.next()
    const readStart = fake.reads.length
    const earlier = agentRow('arrived-before-live', TURN, 3, 1002)
    const olderLive = agentRow('same-row', TURN, 4, 1003, 'old live value')
    const updatedLive = agentRow('same-row', TURN, 4, 1003, 'updated live value')
    fake.rows.push(earlier, olderLive)
    refreshing = agent.refresh(true)
    await started
    // The source feed must publish the live row while the forward request is
    // still explicitly gated, independent of elapsed wall-clock time.
    const liveCommitted = updates.next()
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: updatedLive })
    const liveBatch = await liveCommitted
    assert.ok(liveBatch.value?.frames.some(frame => frame.source?.messageId === updatedLive.id))
    assert.equal(forwardFinished, false, 'live body is published before the in-flight forward page is released')
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(updatedLive.id), undefined, 'live row is visible while forward is blocked')
    release()
    await refreshing
    await app.service.settled()
    const current = app.service.list()[0]
    assert.equal(current?.id, identity, 'the same display owner survives the race')
    assert.equal(current.displayRevision, revision, 'no new display generation')
    assert.equal(current.session.id, agent.session.id, 'the same official Session identity')
    assert.equal(current.binding.threadId, initialThread(fake), 'the same source binding')
    assert.notEqual(current.resolveSourceMessageDisplaySeq(earlier.id), undefined)
    assert.notEqual(current.resolveSourceMessageDisplaySeq(updatedLive.id), undefined)
    const answers = projectedSourceEvents(current).flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : [])
    assert.equal(answers.filter(text => text === 'updated live value').length, 1, 'same-row update is applied once')
    assert.equal(answers.filter(text => text === 'old live value').length, 0, 'the in-flight stale version is not committed')
    const sourceItems = projectedSourceEvents(current).flatMap(event => {
      if (event.type !== 'plugin:hapi-dsh/native-item') return []
      const data = event.data as { sourceSeq?: unknown; nativeItemId?: unknown }
      return typeof data.sourceSeq === 'number' && typeof data.nativeItemId === 'string'
        ? [{ seq: data.sourceSeq, item: data.nativeItemId }] : []
    }).sort((left, right) => left.seq - right.seq)
    assert.ok(sourceItems.findIndex(value => value.item === 'arrived-before-live')
      < sourceItems.findIndex(value => value.item === 'same-row'),
      'the annotated source surface retains source order for the delayed earlier row')
    // The bounded history facade and live body retain the same source order.
    const facadeRows = [...fake.rows.filter(row => row.id !== olderLive.id), updatedLive]
      .sort((left, right) => (left.invokedAt ?? left.createdAt) - (right.invokedAt ?? right.createdAt)
        || (left.seq ?? 0) - (right.seq ?? 0))
    const rendered = await current.renderHistoryPage(facadeRows)
    const earlierSeq = rendered.sources.get(earlier.id)
    const liveSeq = rendered.sources.get(updatedLive.id)
    assert.ok(earlierSeq !== undefined && liveSeq !== undefined && earlierSeq < liveSeq,
      'the history facade orders the late row before the live row')
    const outline = facadeRows.filter(row => typeof row.seq === 'number').map(row => ({
      messageId: row.id, label: '', at: row.invokedAt ?? row.createdAt, seq: row.seq!, createdAt: row.createdAt }))
    const window = new SourceHistoryWindow(current, fake, undefined, async () => ({ entries: outline,
      page: { epoch: EPOCH, hasMore: false, beforeCursor: null, complete: true } }))
    const facadePage = await window.windowAt(updatedLive.id, 99, 1, async () => ({ messages: facadeRows,
      page: { beforeCursor: { at: 0, seq: 0 }, afterCursor: { at: 1, seq: 1 },
        hasMoreBefore: false, hasMoreAfter: false, epoch: EPOCH, reset: false } }))
    const facadeOrder = facadePage.frames.flatMap(frame => frame.source?.seq ?? [])
    assert.ok(facadeOrder.includes(earlier.seq!) && facadeOrder.includes(updatedLive.seq!))
    assert.ok(facadeOrder.indexOf(earlier.seq!) < facadeOrder.indexOf(updatedLive.seq!),
      'the bounded SourceHistoryWindow facade retains source order')
    const raceReads = fake.reads.slice(readStart)
    assert.ok(raceReads.length > 0)
    assert.ok(raceReads.every(query => query.afterAt !== undefined),
      'the race uses forward cursors only, not a full-archive recovery')
    assert.ok(raceReads.length <= 2, 'one forward page plus at most one epoch check')
    assert.equal(fake.sent.length, 0); assert.equal(current.projection.error, null)
  } finally { sourceAbort.abort(); release(); await refreshing?.catch(() => {}); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('an older transport cache is never the seed when the current source tail is readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-opening-cache-fresh-')), fake = new FakeHapi()
  fake.rows = [userRow(), agentRow('current', TURN, 2, 1001)]
  const stale = agentRow('stale-cache', TURN, 1, 500)
  openingCache(directory, fake).write([stale], true, EPOCH)
  const app = await mount(fake, directory)
  try {
    const agent = await app.service.openSource(fake.source.id)
    assert.ok(agent)
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(fake.rows[1]!.id), undefined)
    assert.equal(agent.resolveSourceMessageDisplaySeq(stale.id), undefined,
      'a readable current tail replaces the persisted preview')
    const cache = openingCache(directory, fake).snapshot(true)
    assert.equal(cache?.epoch, EPOCH)
    assert.equal(cache?.rows.some(row => row.id === fake.rows[1]!.id), true)
    assert.equal(cache?.rows.some(row => row.id === stale.id), false)
    assert.equal(cache?.complete, false, 'a fast opening window is never marked complete')
    assert.equal(agent.projection.error, null); assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a legacy cache without an epoch proves continuity in place instead of rewriting the archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-opening-legacy-')), fake = new FakeHapi()
  fake.rows = [userRow(), agentRow('cached-legacy', TURN, 2, 1001)]
  // The cache predates epoch persistence. It is not proof of a structural
  // rewrite; the bounded source page must prove its newest row still exists.
  openingCache(directory, fake).write([userRow(), agentRow('cached-legacy', TURN, 2, 1001)], true)
  const newer = agentRow('after-legacy', TURN, 3, 1002)
  fake.rows.push(newer)
  let reads = 0
  fake.readHook = query => {
    if (++reads === 1) throw new Error('Opening tail unavailable temporarily')
    return fake.page(query)
  }
  const app = await mount(fake, directory)
  try {
    const agent = await app.service.openSource(fake.source.id)
    assert.ok(agent)
    await app.service.settled()
    const current = app.service.list()[0]
    assert.equal(current?.id, agent.id, 'a missing cache epoch is not a structural rewrite')
    assert.equal(current.displayRevision, 0)
    assert.notEqual(current.resolveSourceMessageDisplaySeq(newer.id), undefined)
    assert.equal(current.projection.error, null)
    const fullArchiveReads = fake.reads.filter(query => query.afterAt === undefined && query.beforeAt === undefined
      && (query.limit ?? 50) > 32)
    assert.equal(fullArchiveReads.length, 1, 'only the failed opening read is unbounded by this fixture')
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a failed opening read uses the cache only as explicitly stale fallback and recovers forward', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-opening-offline-')), fake = new FakeHapi()
  fake.maxRowsPerPage = 10
  fake.rows = [userRow(), agentRow('cached', TURN, 2, 1001)]
  const first = await mount(fake, directory)
  try { await first.service.openSource(fake.source.id); await first.service.settled() } finally { await first.close() }
  // A long ordinary append that exceeds the old 20-page backward overlap walk.
  for (let index = 0; index < 300; index++) fake.rows.push(agentRow(`offline-${index}`, TURN, 3 + index, 1002 + index))
  const newest = fake.rows.at(-1)!
  fake.failure = new Error('Source transport is offline during the opening read')
  const app = await mount(fake, directory)
  try {
    const agent = await app.service.openSource(fake.source.id)
    assert.ok(agent)
    assert.match(agent.projection.error ?? '', /stale/)
    assert.match(agent.projection.error ?? '', /offline/)
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(fake.rows[1]!.id), undefined,
      'the cached preview remains readable while the source is offline')
    assert.equal(agent.displayRevision, 0)
    // Let the first automatic read attempt settle before restoring transport;
    // the retry timer itself is not part of this deterministic catch-up.
    await app.service.settled()
    await new Promise(resolve => setTimeout(resolve, 20))
    fake.failure = undefined
    const reads = fake.reads.length
    await agent.refresh(true)
    await app.service.settled()
    assert.equal(app.service.list()[0], agent, 'cache recovery keeps the same display owner')
    assert.equal(agent.displayRevision, 0, 'recovery is not a display replacement')
    assert.notEqual(agent.resolveSourceMessageDisplaySeq(newest.id), undefined)
    assert.equal(agent.projection.error, null)
    const recoveryReads = fake.reads.slice(reads)
    assert.ok(recoveryReads.some(query => query.afterAt !== undefined), 'recovery continues with forward cursors')
    assert.ok(recoveryReads.filter(query => query.afterAt === undefined).every(query => query.limit === 32),
      'recovery uses only one bounded overlap probe, never an archive read')
    assert.equal(fake.sent.length, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
