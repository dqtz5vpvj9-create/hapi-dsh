/**
 * Integration regression for the real public SourceSessions facade.
 *
 * The backend is a real CodexService/NativeProjector feed. The client half is
 * the real bundled SourceSessions + MutableSessionEventSource public surface,
 * not a detached manually sorted list. A forward HTTP page is blocked for >2s
 * while a live row is published; the delayed page then returns an earlier row
 * from an ended turn plus a stale same-row version.
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { ISessions, SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import {
  type HapiApprovalAnswer, type HapiCancelResult, type HapiEvent, type HapiMessage, type HapiMessagesPage,
  type HapiMessagesQuery, type HapiQueuedState, type HapiRetryResult, type HapiSendMessage, type HapiSession,
  type HapiSteerResult, type HapiTransport,
} from '../src/codex/contracts.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const contractEvents = join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')),
  'lib/types/client/contract/events.js')
const THREAD = 'late-merge-thread'
const EPOCH = 91
const SESSION = 'late-merge-source'
let runtime: any
let CodexService: any

before(async () => {
  const built = await build({
    stdin: { contents: [
      `export { SourceSessions } from ${JSON.stringify(join(root, 'src/client/source-sessions.ts'))}`,
      "export { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'",
    ].join('\n'), resolveDir: root, sourcefile: 'late-merge-entry.ts', loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': contractEvents },
    bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, logLevel: 'silent',
  })
  runtime = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`)
  // Keep the host implementation out of the client TS program; this test runs
  // the real service at runtime but the client project must not compile it.
  const hostPath = new URL('../src/codex/service.ts', import.meta.url).href
  ;({ CodexService } = await import(hostPath))
})

class FakeHapi implements HapiTransport {
  readonly hubId = 'late-merge-hub'
  readonly listeners = new Set<(event: HapiEvent) => void>()
  readonly sent: HapiSendMessage[] = []
  readonly reads: HapiMessagesQuery[] = []
  rows: HapiMessage[] = []
  epoch = EPOCH
  readHook: ((query: HapiMessagesQuery) => HapiMessagesPage | Promise<HapiMessagesPage>) | undefined
  source: HapiSession = {
    id: SESSION, namespace: 'test', seq: 1, createdAt: 1000, updatedAt: 1000,
    active: true, activeAt: 1000, thinking: false, thinkingAt: 1000,
    metadataVersion: 1, agentStateVersion: 1, model: 'fixture',
    metadata: { path: '/workspace/late', host: 'Runner late', machineId: 'late-machine', flavor: 'codex',
      codexNativeSession: true, codexNativeConnection: 'attached', codexSessionId: THREAD,
      codexHome: '/runner/codex-home', codexHomeId: 'late-home', name: 'Late merge fixture' },
    agentState: { requests: {}, completedRequests: {} },
    executionVersion: 1,
    execution: { owner: 'codex', generation: 'late-connection', sequence: 1, status: 'idle',
      waitingOn: [], turnId: null, startedAt: null, completedAt: null },
  }
  async listSessions() { const { codexNativeSession: _n, codexNativeConnection: _c, ...metadata } = this.source.metadata!; return [{ ...this.source, metadata }] }
  async getSession(): Promise<HapiSession> { return structuredClone(this.source) }
  async readMessages(_id: string, query: HapiMessagesQuery = {}): Promise<HapiMessagesPage> {
    this.reads.push({ ...query })
    if (this.readHook) return this.readHook(query)
    return this.page(query)
  }
  async sendMessage(_id: string, message: HapiSendMessage): Promise<void> { this.sent.push(structuredClone(message)) }
  async getQueuedState(): Promise<HapiQueuedState> { return { queuedLocalIds: [], invokedLocalMessages: [] } }
  async cancelQueuedMessage(): Promise<HapiCancelResult> { return { status: 'cancelled', localId: null } }
  async steerQueuedMessage(): Promise<HapiSteerResult> { return { status: 'steered', localId: 'fixture' } }
  async retryIndeterminateMessage(): Promise<HapiRetryResult> { return { status: 'retried', localId: 'fixture' } }
  async abortSession(): Promise<void> {}
  async approve(_id: string, _requestId: string, _answer: HapiApprovalAnswer): Promise<void> {}
  async deny(_id: string, _requestId: string, _answer: HapiApprovalAnswer = {}): Promise<void> {}
  subscribe(listener: (event: HapiEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event: HapiEvent): void { for (const listener of [...this.listeners]) listener(event) }
  private positioned() { return this.rows.filter(row => typeof row.seq === 'number')
    .sort((left, right) => (left.invokedAt ?? left.createdAt) - (right.invokedAt ?? right.createdAt) || (left.seq ?? 0) - (right.seq ?? 0)) }
  page(query: HapiMessagesQuery = {}): HapiMessagesPage {
    const all = this.positioned(), limit = query.limit ?? 200
    if (query.epoch !== undefined && query.epoch !== this.epoch) return { messages: [], page: { direction: 'latest', limit,
      epoch: this.epoch, reset: true, nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null,
      snapshotHeadAt: null, snapshotHeadSeq: null, hasMore: false } }
    let selected: HapiMessage[], hasMore = false
    if (query.afterAt !== undefined && query.afterSeq !== undefined) {
      const after = { at: query.afterAt, seq: query.afterSeq }
      const pool = all.filter(row => { const at = row.invokedAt ?? row.createdAt, seq = row.seq ?? 0
        return at > after.at || at === after.at && seq > after.seq })
      selected = pool.slice(0, limit); hasMore = pool.length > selected.length
    } else if (query.beforeAt !== undefined && query.beforeSeq !== undefined) {
      const before = { at: query.beforeAt, seq: query.beforeSeq }
      const pool = all.filter(row => { const at = row.invokedAt ?? row.createdAt, seq = row.seq ?? 0
        return at < before.at || at === before.at && seq < before.seq })
      selected = pool.slice(-limit); hasMore = pool.length > selected.length
    } else { selected = all.slice(-limit); hasMore = all.length > selected.length }
    const first = selected[0], last = selected.at(-1), head = all.at(-1)
    const at = (row?: HapiMessage) => row ? row.invokedAt ?? row.createdAt : null
    const seq = (row?: HapiMessage) => row ? row.seq ?? 0 : null
    return { messages: structuredClone(selected), page: { direction: 'latest', limit, epoch: this.epoch, reset: false,
      nextBeforeAt: at(first), nextBeforeSeq: seq(first), nextAfterAt: at(last), nextAfterSeq: seq(last),
      snapshotHeadAt: at(head), snapshotHeadSeq: seq(head), hasMore } }
  }
}

function user(turnId: string, seq: number, at: number, localId: string): HapiMessage {
  return { id: `user:${localId}`, localId, seq, createdAt: at, invokedAt: at,
    content: { role: 'user', content: { type: 'text', text: `question ${localId}` },
      meta: { nativeExecution: { threadId: THREAD, turnId, itemId: localId } } } }
}
function answer(turnId: string, itemId: string, seq: number, at: number, text: string): HapiMessage {
  const stable = `codex:${THREAD}:${turnId}:${itemId}:message`
  return { id: `native:${stable}`, localId: stable, seq, createdAt: at,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: stable, message: text,
      streamSnapshot: true, nativeExecution: { threadId: THREAD, turnId, itemId } } } } }
}
function terminal(turnId: string, itemId: string, seq: number, at: number): HapiMessage {
  const row = answer(turnId, itemId, seq, at, '')
  row.content = { role: 'agent', content: { type: 'codex', data: { type: 'native-turn', id: itemId,
    nativeExecution: { threadId: THREAD, turnId, itemId, turn: { status: 'completed', started: true, ended: true } } } } }
  return row
}

async function mount(fake: FakeHapi, directory: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime)
  let service: any
  const errors: string[] = []
  await ctx.plugin(Object.assign(async (owner: Context) => {
    service = new CodexService(owner, fake, { stateDirectory: directory, fastHistorySeed: true, discovery: 'on-demand',
      onError: (error: Error) => { errors.push(error.message) } })
    await service.start()
  }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
  assert.ok(service)
  return { ctx, service, errors, async close() { await service!.dispose(); await ctx.fiber.dispose() } }
}

function snapshot(id: SessionId): SessionSnapshot {
  return { sessionId: id, pendingSubmissions: [], running: false, subagent: null, removed: false,
    openState: 'open', openError: null, hasMore: true, loadingOlder: false, promptError: null,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false }
}
const event = (seq: number, turn: number) => ({ type: 'event', event: { type: 'turn/start', seq, time: seq, data: { turn } } }) as any

test('real SourceSessions facade: blocked forward, fast live, late earlier ended-turn row', { timeout: 15_000 }, async () => {
  const traceparent = `00-${randomUUID().replace(/-/g, '')}-${randomUUID().replace(/-/g, '').slice(0, 16)}-01`
  const directory = await mkdtemp(join(tmpdir(), 'hapi-late-merge-')), fake = new FakeHapi()
  const oldUser = user('turn-old', 1, 1000, 'old-user')
  const oldAnswer = answer('turn-old', 'old-answer', 2, 1001, 'old answer')
  const oldEnd = terminal('turn-old', 'old-end', 3, 1002)
  fake.rows = [oldUser, oldAnswer, oldEnd]
  let release!: () => void, reading!: () => void, blocked = false
  let delayedPage: HapiMessagesPage | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  fake.readHook = query => {
    if (query.afterAt !== undefined && !blocked) { blocked = true; reading(); return gate.then(() => delayedPage!) }
    return fake.page(query)
  }
  const app = await mount(fake, directory)
  try {
    const agent = await app.service.openSource(fake.source.id)
    assert.ok(agent)
    const revision = agent.displayRevision, faceId = agent.id
    const readStart = fake.reads.length
    const id = agent.id as unknown as SessionId
    const source = new runtime.MutableSessionEventSource()
    source.replace([event(1, 100)], true)
    const binding: any = { sessionId: id, eventSource: source, ctx: {},
      session: { sessionId: id, projections: { faceOf: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) },
        getSnapshot: () => snapshot(id), subscribe: () => () => {}, loadOlder: async () => {}, loadThrough: async () => {} } }
    const original = {
      retain: () => ({ sessionId: id, binding, ready: Promise.resolve(binding), release() {} } as unknown as SessionReference),
      retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }), subscribe: () => () => {} }),
      binding: () => binding,
    } as unknown as ISessions
    const facade = new runtime.SourceSessions(original)
    facade.attach({
      sourceHistoryOutline: async () => ({ ok: true, value: { entries: [
        { turn: 100, seq: 2_000_000_000, prompt: 'head', response: '', messageId: 'm-head', at: 4, sourceSeq: 4 },
      ], seedIndex: 0, firstTurn: 100, complete: true, head: { messageId: 'm-head', at: 4, seq: 4 } } }),
      sourceHistoryWindowPage: async () => ({ ok: true, value: { records: [{
        type: 'event', event: { type: 'assistant/message', seq: 3_000_000_000, time: 3,
          data: { turn: 200, body: 'head' } },
      } as any], hasMoreBefore: true, hasMoreAfter: false, before: { at: 2, seq: 2 }, after: { at: 4, seq: 4 } } }),
    })
    const reference = facade.retain(id, { source: 'mainView' })
    await reference.ready
    assert.equal(await reference.binding.session.returnToLive(), true)
    assert.equal((reference.binding.eventSource.getSnapshot().entries[0]?.event.data as any)?.body, 'head',
      'returnToLive completes only after publishing the source head window')
    const face = reference.binding.session, eventSource = reference.binding.eventSource
    let appended = agent.session.snapshotEvents().length
    const pump = () => {
      const events = agent.session.snapshotEvents()
      for (const entry of events.slice(appended)) source.append({ type: 'event', event: entry } as any)
      appended = events.length
    }
    // Start the forward read and keep it blocked for >2s.
    const refreshing = agent.refresh(true)
    await started
    const live = answer('turn-live', 'live-item', 4, 1003, 'live value')
    const staleLive = answer('turn-live', 'live-item', 4, 1003, 'old live value')
    const earlier = answer('turn-old', 'late-earlier', 2, 1002, 'earlier value')
    fake.rows.push(live)
    delayedPage = { messages: [earlier, staleLive], page: { direction: 'after', limit: 200, epoch: EPOCH, reset: false,
      nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: 1004, nextAfterSeq: 5,
      snapshotHeadAt: 1004, snapshotHeadSeq: 5, hasMore: false } }
    const liveStarted = Date.now()
    fake.emit({ type: 'message-received', sessionId: fake.source.id, message: live })
    await new Promise(resolve => setTimeout(resolve, 30))
    pump()
    for (let index = 0; index < 200; index++) {
      if (reference.binding.eventSource.getSnapshot().entries.some((entry: any) => textOf(entry) === 'live value')) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const liveVisible = reference.binding.eventSource.getSnapshot().entries.some((entry: any) => textOf(entry) === 'live value')
    const liveElapsed = Date.now() - liveStarted
    assert.equal(liveVisible, true, 'live value must be published while forward is blocked')
    assert.ok(liveElapsed < 1500, `live facade latency ${liveElapsed}ms must stay below 1500ms`)
    const blockedAt = Date.now()
    await new Promise(resolve => setTimeout(resolve, 2100))
    assert.ok(Date.now() - blockedAt >= 2000, 'the forward HTTP page stays blocked for more than 2s')
    // The delayed page contains an earlier row from an already-ended turn and
    // the stale version of the same live item.
    release()
    await refreshing
    await app.service.settled()
    pump()
    await new Promise(resolve => setTimeout(resolve, 60))
    const entries = reference.binding.eventSource.getSnapshot().entries
    const texts = entries.map((entry: any) => textOf(entry)).filter((value: string) => value.length > 0)
    const liveEntries = entries.filter((entry: any) => textOf(entry) === 'live value')
    assert.equal(liveEntries.length, 1, 'same-row update must appear once')
    assert.equal(entries.some((entry: any) => textOf(entry) === 'old live value'), false, 'stale same-row version must not be rendered')
    assert.equal(reference.binding.session, face, 'the live SourceSession face identity is unchanged')
    assert.equal(reference.binding.eventSource, eventSource, 'the event source identity is unchanged')
    assert.equal(app.service.list()[0]?.displayRevision, revision, 'no new display generation')
    assert.equal(app.service.list()[0]?.binding.threadId, THREAD, 'source identity is unchanged')
    const liveSource = liveEntries[0] as any
    assert.equal(liveSource.source?.messageId, live.id, 'live event retains its source mapping')
    const earlierEntry = entries.find((entry: any) => textOf(entry) === 'earlier value') as any
    assert.ok(earlierEntry, 'the delayed earlier row must reach the facade')
    assert.equal(earlierEntry.source?.messageId, earlier.id, 'late row retains its source mapping')
    const raceReads = fake.reads.slice(readStart)
    assert.ok(raceReads.every(query => query.afterAt !== undefined), 'the race must not read the full archive')
    // This is the public facade's actual order, not a pre-sorted detached list.
    const trace = { traceparent, liveElapsed, blockedMs: 2100, faceStable: reference.binding.session === face,
      eventSourceStable: reference.binding.eventSource === eventSource,
      entries: entries.map((entry: any, index: number) => ({ index, text: textOf(entry),
        sourceMessageId: entry.source?.messageId ?? null, sourceAt: entry.source?.at ?? null,
        sourceSeq: entry.source?.seq ?? null, seq: entry.event?.seq ?? null, type: entry.event?.type, turn: entry.event?.data?.turn, step: entry.event?.data?.step })) }
    if (process.env.LATE_MERGE_TRACE) console.error('LATE_MERGE_TRACE ' + JSON.stringify(trace))
    assert.ok(entries.indexOf(earlierEntry) < entries.indexOf(liveSource),
      `facade source order: earlier must precede live (trace ${traceparent})`)
    assert.equal(fake.sent.length, 0)
    reference.release()
  } finally { release(); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

function textOf(entry: any): string {
  const data = entry?.event?.data
  const content = data?.message?.content
  if (Array.isArray(content)) return content.flatMap((block: any) => typeof block?.text === 'string' ? [block.text] : []).join('')
  return typeof data?.body === 'string' ? data.body : ''
}
