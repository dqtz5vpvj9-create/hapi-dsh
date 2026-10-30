/** Production HHPI cache/window tests. Only the authenticated source wire is a fixture. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Budget, HistoryFeedV1, HistorySnapshotV1 } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteSourceHistory, type RemoteHistoryTransport } from '../src/client/remote-history.ts'
import { sourceSessionId, type SourceChanges, type SourceChangesRequest, type SourceEntry, type SourcePage, type SourceReadRequest, type SourceSession } from '../src/remote/protocol.ts'

const budget: Budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }
const identity = { machineId: 'fixture-machine', sourceId: 'fixture-codex', engine: 'codex', nativeId: 'fixture-thread' }
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic history', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null,
  capabilities: { send: true, steer: true, cancel: true, approve: true, files: false }, pendingRequests: [] }
function entry(seq: number, text = `body-${seq}`): SourceEntry {
  return { type: 'event', event: { seq, time: seq, type: 'user/message', data: { turn: seq, message: { id: `message-${seq}`, role: 'user', content: [{ type: 'text', text }] } } } } as unknown as SourceEntry
}
function body(snapshot: HistorySnapshotV1, seq: number): string | undefined {
  const event = snapshot.entries.find(value => value.event.seq === seq)
  return (event?.event.data as { message?: { content: Array<{ text: string }> } } | undefined)?.message?.content[0]?.text
}
class Wire implements RemoteHistoryTransport {
  readonly calls: SourceReadRequest[] = []
  entries = Array.from({ length: 1440 }, (_, index) => entry(index + 1))
  metadata = session
  epoch = 'fixture-epoch'
  version = 1
  private gate: Promise<void> | undefined
  private readonly journal: SourceChanges[] = []
  private readonly listeners = new Set<() => void>()
  deferNextRead(): { release(): void } {
    const gate = Promise.withResolvers<void>()
    this.gate = gate.promise
    return { release: () => gate.resolve() }
  }
  async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
    signal?.throwIfAborted()
    this.calls.push(request)
    const gate = this.gate; this.gate = undefined
    const available = this.entries.filter(value => request.before !== undefined ? value.event.seq < request.before : request.after !== undefined ? value.event.seq > request.after : true)
    const limit = request.limit ?? 160
    let selected = request.after !== undefined ? available.slice(0, limit) : available.slice(-limit)
    if (request.around !== undefined) {
      const index = Math.max(0, available.findIndex(value => value.event.seq >= request.around!))
      selected = available.slice(Math.max(0, index - Math.floor(limit / 2)), index + Math.ceil(limit / 2))
    }
    const first = selected[0]?.event.seq ?? null, last = selected.at(-1)?.event.seq ?? null
    const page: SourcePage = { session: this.metadata, epoch: this.epoch, version: this.version, entries: selected, before: first, after: last,
      hasBefore: first !== null && this.entries.some(value => value.event.seq < first),
      hasAfter: last !== null && this.entries.some(value => value.event.seq > last), context: [] }
    if (gate) await gate
    signal?.throwIfAborted()
    return page
  }
  async *changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
    let version = request.version
    while (!signal?.aborted) {
      const next = this.journal.find(change => change.base === version)
      if (next) { version = next.version; yield next; continue }
      await new Promise<void>(resolve => {
        const wake = (): void => { this.listeners.delete(wake); signal?.removeEventListener('abort', wake); resolve() }
        this.listeners.add(wake); signal?.addEventListener('abort', wake, { once: true })
        if (signal?.aborted) wake()
      })
    }
  }
  emit(upserts: SourceEntry[], removed: number[] = [], metadata = this.metadata): void {
    this.metadata = metadata
    const entries = new Map(this.entries.map(value => [value.event.seq, value]))
    for (const seq of removed) entries.delete(seq)
    for (const value of upserts) entries.set(value.event.seq, value)
    this.entries = [...entries.values()].sort((a, b) => a.event.seq - b.event.seq)
    this.journal.push({ session: metadata, epoch: this.epoch, base: this.version, version: ++this.version, reset: false, upserts, removed })
    for (const listener of [...this.listeners]) listener()
  }
}
async function observe(feed: HistoryFeedV1, after: string, update: () => void): Promise<void> {
  const abort = new AbortController()
  const stream = feed.changes(after, abort.signal)[Symbol.asyncIterator]()
  try {
    const next = stream.next()
    update()
    assert.equal((await next).done, false, 'the production feed must observe the source update')
  } finally { abort.abort(); await stream.return?.() }
}
async function older(feed: HistoryFeedV1, snapshot: HistorySnapshotV1, signal = new AbortController().signal): Promise<HistorySnapshotV1> {
  assert.ok(snapshot.before)
  return feed.read({ kind: 'before', cursor: snapshot.before }, budget, signal)
}

test('six older body-bearing segments retain accepted identities and reuse every visited interval', { timeout: 3000 }, async t => {
  const wire = new Wire(), owner = new RemoteSourceHistory(session.id, wire)
  t.after(() => owner.dispose())
  const feed = await owner.openView('pane-a', budget)
  let snapshot = feed.initial
  const retained = snapshot.entries.at(-1)
  const cursors: string[] = []
  for (let page = 0; page < 6; page++) {
    const previous = snapshot; cursors.push(previous.before!)
    snapshot = await older(feed, previous)
    assert.ok(snapshot.entries[0]!.event.seq < previous.entries[0]!.event.seq, `segment ${page + 1} exposes earlier body`)
    assert.equal(snapshot.entries.at(-1), retained)
    assert.equal(snapshot.entries.length, 160 * (page + 2))
  }
  const calls = wire.calls.length
  for (const cursor of cursors.reverse()) snapshot = await feed.read({ kind: 'before', cursor }, budget, new AbortController().signal)
  assert.equal(wire.calls.length, calls, 'accepted history is reused without another source read')
  const seqs = snapshot.entries.map(value => value.event.seq)
  assert.equal(new Set(seqs).size, seqs.length)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
})

test('page admission does not charge retained history again or stop live revisions', { timeout: 3000 }, async t => {
  const wire = new Wire(), owner = new RemoteSourceHistory(session.id, wire)
  t.after(() => owner.dispose())
  const admission = { ...budget, events: 200, bytes: 128 * 1024 }
  wire.entries = wire.entries.map(value => entry(value.event.seq, `body-${value.event.seq} ${'x'.repeat(512)}`))
  const feed = await owner.openView('long-pane', admission), other = await owner.openView('other-pane', admission)
  let snapshot = feed.initial
  for (let page = 1; page < 9; page++) {
    snapshot = await feed.read({ kind: 'before', cursor: snapshot.before! }, admission, new AbortController().signal)
    assert.equal(snapshot.entries.length, 160 * (page + 1), 'accepted body is never clipped to the one-page admission budget')
    feed.publication!.accept(snapshot.version)
  }
  assert.equal(other.initial.entries.length, 160)
  await observe(feed, snapshot.version, () => wire.emit([entry(1440, 'revised resident tail'), entry(1441, 'new tail')]))
  const current = await feed.refresh!(admission, new AbortController().signal)
  assert.equal(current.entries.length, 1441)
  assert.equal(body(current, 1440), 'revised resident tail')
  assert.equal(body(current, 1441), 'new tail')
  assert.equal(current.hasAfter, false, 'crossing an aggregate budget cannot manufacture a tail gap')
  const reads = wire.calls.length
  const latest = await feed.read({ kind: 'latest' }, admission, new AbortController().signal)
  assert.equal(latest.entries.length, 1441)
  assert.equal(wire.calls.length, reads)
})

test('a genuinely oversized page still fails admission without altering accepted history', async t => {
  const wire = new Wire(), owner = new RemoteSourceHistory(session.id, wire)
  t.after(() => owner.dispose())
  const feed = await owner.openView('pane', budget)
  feed.publication!.accept(feed.initial.version)
  await assert.rejects(feed.read({ kind: 'before', cursor: feed.initial.before! }, { ...budget, events: 1 }, new AbortController().signal), { code: 'CAPACITY_EXCEEDED' })
  assert.equal(feed.publication!.published?.snapshot, feed.initial)
})

test('cancelling one coalesced navigation does not cancel the other caller', { timeout: 3000 }, async t => {
  const wire = new Wire(), owner = new RemoteSourceHistory(session.id, wire)
  t.after(() => owner.dispose())
  const feed = await owner.openView('pane-a', budget), gate = wire.deferNextRead(), cancelled = new AbortController()
  const first = older(feed, feed.initial, cancelled.signal)
  const rejected = assert.rejects(first, { name: 'AbortError' })
  const surviving = older(feed, feed.initial)
  cancelled.abort(); gate.release()
  await rejected
  assert.equal((await surviving).entries.length, 320, 'the second reader owns an independent cancellation signal')
  assert.equal(wire.calls.length, 2, 'both callers share one physical page read')
})

test('a delayed old page cannot resurrect an entry deleted by the source stream', { timeout: 3000 }, async t => {
  const wire = new Wire(), owner = new RemoteSourceHistory(session.id, wire)
  t.after(() => owner.dispose())
  const feed = await owner.openView('pane-a', budget), gate = wire.deferNextRead()
  const pending = older(feed, feed.initial)
  await observe(feed, feed.initial.version, () => wire.emit([entry(1440, 'stream-marker')], [1200]))
  gate.release()
  const snapshot = await pending
  assert.equal(body(snapshot, 1200), undefined, 'a removed source identity must remain removed')
  assert.equal(body(snapshot, 1440), 'stream-marker')
})

test('reopening after an unobserved revision never marks stale cached body as current', { timeout: 3000 }, async t => {
  const wire = new Wire(), owner = new RemoteSourceHistory(session.id, wire)
  t.after(() => owner.dispose())
  const first = await owner.openView('pane-a', budget)
  assert.equal(body(await older(first, first.initial), 1200), 'body-1200')
  first.release()
  wire.emit([entry(1200, 'changed-while-unmounted')])
  const reopened = await owner.openView('pane-a', budget)
  assert.equal(body(await older(reopened, reopened.initial), 1200), 'changed-while-unmounted', 'a new baseline must reconcile its old intervals')
})

test('a delayed historical page cannot roll back active-turn metadata', { timeout: 3000 }, async t => {
  const wire = new Wire(), owner = new RemoteSourceHistory(session.id, wire)
  t.after(() => owner.dispose())
  let observed: SourceSession | undefined
  owner.subscribeSession(value => { observed = value })
  const feed = await owner.openView('pane-a', budget), gate = wire.deferNextRead()
  const pending = older(feed, feed.initial)
  await observe(feed, feed.initial.version, () => wire.emit([entry(1440, 'running-marker')], [], { ...session, status: 'running', activeTurnId: 'turn-running', updatedAt: 2 }))
  gate.release(); await pending
  assert.equal(observed?.status, 'running', 'historical metadata cannot overwrite a newer source revision')
  assert.equal(observed?.activeTurnId, 'turn-running')
})

test('a released Pane cannot accept a late page and another Pane keeps its live window', { timeout: 3000 }, async t => {
  const wire = new Wire(), owner = new RemoteSourceHistory(session.id, wire)
  t.after(() => owner.dispose())
  const first = await owner.openView('pane-a', budget), second = await owner.openView('pane-b', budget)
  const gate = wire.deferNextRead(), pending = older(first, first.initial)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  first.release(); gate.release(); await rejected
  assert.equal(second.initial.entries.length, 160)
  assert.equal((await older(second, second.initial)).entries.length, 320)
})
