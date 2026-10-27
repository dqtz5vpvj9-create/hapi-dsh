/** Published rc.3 client transport and Session owner; source wire is an in-memory fixture. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { SessionFollowFrame, SessionFollowRequest, SessionHistoryRecord, SessionAssistantStreamBaseline, SessionControlFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ISessions, SessionJournalChange } from '@deepseek-ai/dsh-api-session-controller/client'
import { boundedSourceFollow } from '../src/codex/bounded-follow.ts'

// Execute the unchanged published browser factory with its public dependencies.
const require = createRequire(import.meta.url)
let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-api-session-controller/client') } | undefined
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8'))({
  __ModuleLoader__: { load(value: typeof published) { published = value } },
})
assert.ok(published)
const client = published.factory(name => name === '@deepseek-ai/dsh-api-gateway/client' ? gateway : require(name))
const { SessionEventStream, MutableSessionEventSource } = client
const { RemoteStream } = gateway
const id = 'bounded-follow-fixture' as SessionId
type Snapshot = Extract<SessionFollowFrame, { type: 'snapshot' }>

function event(seq: number, text = ''): SessionHistoryRecord {
  return { type: 'event', event: { type: 'plugin:fixture/record', seq, time: 1000 + seq, data: { text }, ignorable: true } }
}
function snapshot(records: readonly SessionHistoryRecord[], assistantStream: SessionAssistantStreamBaseline = { revision: 0 }): Snapshot {
  return { type: 'snapshot', header: { version: 2, id, createdAt: 1000, isSeeded: false },
    cursor: records.at(-1)?.event.seq ?? -1, records, hasMore: false,
    projections: { asOfSeq: records.at(-1)?.event.seq ?? -1, values: {} }, assistantStream }
}
async function collect(source: AsyncIterable<SessionFollowFrame>): Promise<SessionFollowFrame[]> {
  const frames: SessionFollowFrame[] = []
  for await (const frame of source) frames.push(frame)
  return frames
}
async function* frames(values: readonly SessionFollowFrame[]) { yield* values }
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await tick() }
  assert.ok(predicate(), 'Expected the published client transport to settle')
}

class Channel implements AsyncIterable<SessionFollowFrame>, AsyncIterator<SessionFollowFrame> {
  private readonly queued: SessionFollowFrame[] = []
  private waiting: ((value: IteratorResult<SessionFollowFrame>) => void) | undefined
  private closed = false
  private readonly aborted = () => { this.close() }
  constructor(private readonly signal: AbortSignal, private readonly onClose: () => void) {
    signal.addEventListener('abort', this.aborted, { once: true })
    if (signal.aborted) this.close()
  }
  push(frame: SessionFollowFrame): void {
    assert.equal(this.closed, false)
    const waiting = this.waiting; this.waiting = undefined
    if (waiting) waiting({ done: false, value: frame }); else this.queued.push(frame)
  }
  private close(): void {
    if (this.closed) return
    this.closed = true; this.signal.removeEventListener('abort', this.aborted)
    this.queued.length = 0; this.waiting?.({ done: true, value: undefined }); this.waiting = undefined
    this.onClose()
  }
  next(): Promise<IteratorResult<SessionFollowFrame>> {
    const frame = this.queued.shift()
    return frame ? Promise.resolve({ done: false, value: frame }) : this.closed
      ? Promise.resolve({ done: true, value: undefined }) : new Promise(resolve => { this.waiting = resolve })
  }
  async return(): Promise<IteratorResult<SessionFollowFrame>> { this.close(); return { done: true, value: undefined } }
  [Symbol.asyncIterator](): AsyncIterator<SessionFollowFrame> { return this }
}

function transport(maxEvents: number) {
  const connection = { generation: createSnapshotStore({}) } as unknown as Pick<ConnectionHandle, 'generation'>
  const log = [event(0)], channels: Channel[] = [], requests: SessionFollowRequest[] = []
  let closed = 0, pages = 0
  let baseline: SessionAssistantStreamBaseline = { revision: 0 }
  const wire = {
    $stream: <T>(options: RemoteStreamOptions<T>) => new RemoteStream(connection, options),
    session: {
      follow(request: SessionFollowRequest, signal: AbortSignal) {
        assert.deepEqual(request.address, { kind: 'session', sessionId: id })
        requests.push(request)
        const channel = new Channel(signal, () => { closed++ }); channels.push(channel)
        // The source fixture owns its opening window, just as the official
        // pager does. The generation wrapper must not choose another cut.
        channel.push(snapshot(log.slice(-2), baseline))
        return boundedSourceFollow(channel, { maxEvents, maxBytes: 1_000_000 })
      },
      async page() { pages++; throw new Error('A contiguous rollover must not require gap repair') },
    },
  }
  return { connection, wire, log, channels, requests, get closed() { return closed }, get pages() { return pages },
    setBaseline(value: SessionAssistantStreamBaseline) { baseline = value },
    append(value: SessionHistoryRecord) { log.push(value); channels.at(-1)!.push(value) },
  }
}

test('live budgets forward the crossing frame whole and close the source iterator', async () => {
  let closed = 0
  async function* source() { try { yield snapshot([event(0)]); yield event(1); yield event(2); yield event(3) } finally { closed++ } }
  const received = await collect(boundedSourceFollow(source(), { maxEvents: 2, maxBytes: 1_000_000 }))
  assert.deepEqual(received.map(value => value.type === 'event' ? value.event.seq : value.type), ['snapshot', 1, 2])
  assert.equal(closed, 1)
})

test('a large durable event exceeds the byte budget without truncation', async () => {
  const huge = event(1, '漢🙂'.repeat(30_000))
  const received = await collect(boundedSourceFollow(frames([snapshot([event(0)]), huge, event(2)]), { maxEvents: 100, maxBytes: 200 }))
  assert.equal(received.length, 2); assert.equal(received[1], huge)
})

test('assistant frames count toward live budgets and preserve complete source chunks', async () => {
  const chunk: SessionFollowFrame = { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt' as LlmAttemptId,
    revision: 1, index: 0, time: 1001, chunk: { type: 'text-delta', index: 0, text: '漢🙂'.repeat(30_000) } } }
  const received = await collect(boundedSourceFollow(frames([snapshot([event(0)]), chunk, event(1)]), { maxEvents: 1, maxBytes: 100 }))
  assert.equal(received.length, 2); assert.equal(received[1], chunk)
})

test('a large non-message opening snapshot is forwarded unchanged', async () => {
  const original = snapshot(Array.from({ length: 2_000 }, (_, seq) => event(seq)))
  const received = await collect(boundedSourceFollow(frames([original, event(2000)]), { maxEvents: 1, maxBytes: 1 }))
  assert.equal(received[0], original); assert.equal(original.records.length, 2_000)
  assert.equal(received.length, 2)
})

test('one oversized snapshot event and active assistant baseline remain complete without a snapshot-only restart', async () => {
  const huge = event(1, 'source output '.repeat(30_000))
  const assistantStream: SessionAssistantStreamBaseline = { revision: 5, activeAttempt: {
    attemptId: 'active' as LlmAttemptId, startedAfterSeq: 1 as SessionSeq, turn: 1, step: 1, nextIndex: 1,
    stream: [{ type: 'chunk', time: 1002, chunk: { type: 'text-delta', index: 0, text: 'live answer '.repeat(30_000) } }],
  } }
  const original = snapshot([event(0), huge], assistantStream)
  const received = await collect(boundedSourceFollow(frames([original, event(2), event(3)]), { maxEvents: 1, maxBytes: 32 }))
  assert.equal(received.length, 2)
  assert.equal(received[0], original); assert.equal(received[1]?.type === 'event' && received[1].event.seq, 2)
})

test('consumer cancellation closes the original source even before its live budget is reached', async () => {
  let closed = 0
  async function* source() { try { yield snapshot([event(0)]); yield event(1) } finally { closed++ } }
  const iterator = boundedSourceFollow(source(), { maxEvents: 100 })[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.type, 'snapshot')
  await iterator.return?.(); assert.equal(closed, 1)
})

test('published SessionEventStream reopens multiple generations into the same event source', async () => {
  const fixture = transport(2), feed = new MutableSessionEventSource(), changes: SessionJournalChange[] = [], failures: unknown[] = []
  const journal = new SessionEventStream(fixture.wire as unknown as ConstructorParameters<typeof SessionEventStream>[0],
    { kind: 'session', sessionId: id }, { publish(change) {
      changes.push(change)
      if (change.type === 'replace') feed.replace(change.entries, change.hasMore)
      else if (change.type === 'append') feed.append(change.entry)
    }, failed: error => { failures.push(error) } })
  const owner = { journal, feed }
  try {
    await journal.open({ maxMessages: 20 })
    fixture.append(event(1)); fixture.append(event(2))
    await until(() => failures.length > 0 || changes.filter(change => change.type === 'replace').length === 2)
    assert.deepEqual(failures, [])
    assert.deepEqual(feed.getSnapshot().entries.map(entry => entry.event.seq), [1, 2])
    fixture.append(event(3)); fixture.append(event(4))
    await until(() => changes.filter(change => change.type === 'replace').length === 3)
    assert.deepEqual(feed.getSnapshot().entries.map(entry => entry.event.seq), [3, 4])
    assert.equal(owner.journal, journal); assert.equal(owner.feed, feed)
    assert.equal(fixture.requests.length, 3); assert.equal(fixture.closed, 2); assert.equal(fixture.pages, 0)
    assert.ok(fixture.requests.every(request => request.assistantStream === true && request.maxMessages === 20))
    assert.deepEqual(changes.flatMap(change => change.type === 'append' ? [change.entry.event.seq] : []), [1, 2, 3, 4])
    assert.deepEqual(failures, [])
  } finally { await journal.dispose() }
  assert.equal(fixture.closed, 3)
})

test('the published Session owner installs replacement baselines without losing its scope or pending input', async () => {
  const fixture = transport(2), root = new Context()
  const firstAttempt = 'first-attempt' as LlmAttemptId, nextAttempt = 'next-attempt' as LlmAttemptId
  fixture.setBaseline({ revision: 1, activeAttempt: { attemptId: firstAttempt, startedAfterSeq: 0 as SessionSeq, turn: 1, step: 1,
    nextIndex: 1, stream: [{ type: 'chunk', time: 1001, chunk: { type: 'text-delta', index: 0, text: 'Old partial.' } }],
  } })
  const remote = { ...fixture.wire, $on: () => () => {}, commands: {}, subagents: {}, session: {
    ...fixture.wire.session,
    async list() { return { ok: true, value: { items: [{ sessionId: id, running: false, blank: false, updatedAt: 1000 }] } } },
    async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
      yield { type: 'baseline', value: { projections: {} } }
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
  } }
  root.provide('connection', fixture.connection)
  root.provide('remote', remote)
  root.provide('typert', { contexts: { registerClient() {} } })
  try {
    await root.plugin({ apply: client.apply })
    const sessions = root.get('sessions') as unknown as ISessions
    await sessions.refresh()
    const reference = sessions.retain(id, { source: 'controllerOperation' })
    try {
      await reference.ready
      const binding = reference.binding, owner = binding.session, feed = binding.eventSource, scope = binding.ctx
      assert.ok(feed.getSnapshot().entries.some(entry => entry.type === 'transient' && entry.event.data.attemptId === firstAttempt))
      const submission = owner.beginSubmission({ mode: 'queue', text: 'Pending source input', attachments: [] })
      const replacements: number[] = []
      const stop = feed.subscribe(() => { if (feed.getSnapshot().change.kind === 'replace') replacements.push(fixture.requests.length) })
      try {
        fixture.setBaseline({ revision: 1 })
        fixture.append(event(1)); fixture.append(event(2))
        await until(() => replacements.length === 1)
        assert.deepEqual(feed.getSnapshot().entries.map(entry => entry.event.seq), [1, 2])
        // Read-only diagnostics expose the retained fold that a facade-only
        // trim cannot clear; the real Session installWindow owns these writes.
        const fold = (owner as unknown as { assistantStream: { publishedSeqs: Set<number>; pending: Map<number, unknown> } }).assistantStream
        assert.deepEqual([...fold.publishedSeqs], [1, 2]); assert.equal(fold.pending.size, 0)
        fixture.setBaseline({ revision: 3, activeAttempt: { attemptId: nextAttempt, startedAfterSeq: 2 as SessionSeq, turn: 2, step: 1,
          nextIndex: 1, stream: [{ type: 'chunk', time: 1003, chunk: { type: 'text-delta', index: 0, text: 'New partial.' } }],
        } })
        fixture.channels.at(-1)!.push({ type: 'assistant-stream', frame: { type: 'start', attemptId: nextAttempt,
          revision: 2, startedAfterSeq: 2 as SessionSeq, turn: 2, step: 1 } })
        fixture.channels.at(-1)!.push({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: nextAttempt,
          revision: 3, index: 0, time: 1003, chunk: { type: 'text-delta', index: 0, text: 'New partial.' } } })
        await until(() => replacements.length === 2)
        assert.equal(fixture.requests.length, 3, 'cleared assistant state must not request another rebaseline')
        const transients = feed.getSnapshot().entries.filter(entry => entry.type === 'transient')
        assert.equal(transients.length, 1); assert.equal(transients[0]!.event.data.attemptId, nextAttempt)
        assert.equal(reference.binding, binding); assert.equal(reference.binding.session, owner)
        assert.equal(reference.binding.eventSource, feed); assert.equal(reference.binding.ctx, scope)
        assert.equal(owner.getSnapshot().openState, 'open')
        assert.ok(owner.getSnapshot().pendingSubmissions.some(input => input.requestId === submission.requestId))
        assert.equal(fixture.pages, 0)
      } finally { stop(); submission.abandon() }
    } finally { reference.release() }
  } finally { await root.fiber.dispose() }
  assert.equal(fixture.closed, fixture.requests.length)
})
