/** Production cache/window behavior. The only fixture boundary is the source wire. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSourceHistory, type RemoteHistoryTransport } from '../src/client/remote-history.ts'
import type { SourceChanges, SourceChangesRequest, SourceEntry, SourcePage, SourceReadRequest, SourceSession } from '../src/remote/protocol.ts'
import type { Budget, HistoryFeedV1, HistorySnapshotV1 } from '@deepseek-ai/dsh-api-session-controller/client'

const budget: Budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }
const metadata: SourceSession = { id: 'hhpi:codex:synthetic-a', sourceId: 'source-a', machineId: 'machine-a', engine: 'codex', nativeId: 'thread-a', title: 'Synthetic continuous history', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null,
  capabilities: { send: true, steer: true, cancel: true, approve: true, files: true }, pendingRequests: [] }
function entry(seq: number, text = `readable-${seq}`): SourceEntry {
  return { type: 'event', event: { seq, time: seq, type: 'user/message', data: { turn: seq, message: { id: `message-${seq}`, role: 'user', content: [{ type: 'text', text }] } } } } as unknown as SourceEntry
}
function readable(snapshot: HistorySnapshotV1): string[] { return snapshot.entries.map(value => (value.event.data as unknown as { message: { content: Array<{ text: string }> } }).message.content[0]!.text) }
class SourceFixture implements RemoteHistoryTransport {
  readonly calls: SourceReadRequest[] = []
  entries = Array.from({ length: 1400 }, (_, index) => entry(index + 1))
  version = 1
  epoch = 'epoch-1'
  private readonly journal: SourceChanges[] = []
  private readonly listeners = new Set<() => void>()
  gate: Promise<void> | undefined
  async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
    this.calls.push(request)
    const available = this.entries.filter(value => request.before !== undefined ? value.event.seq < request.before : request.after !== undefined ? value.event.seq > request.after : true)
    const limit = request.limit ?? 160
    let selected = request.after !== undefined ? available.slice(0, limit) : available.slice(-limit)
    if (request.around !== undefined) {
      const index = Math.max(0, available.findIndex(value => value.event.seq >= request.around!))
      selected = available.slice(Math.max(0, index - Math.floor(limit / 2)), index + Math.ceil(limit / 2))
    }
    const first = selected[0]?.event.seq ?? null, last = selected.at(-1)?.event.seq ?? null
    const page: SourcePage = { session: metadata, epoch: this.epoch, version: this.version, entries: selected, before: first, after: last,
      hasBefore: first !== null && first > 1, hasAfter: last !== null && last < this.entries.at(-1)!.event.seq, context: [] }
    if (this.gate) await this.gate
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
  emit(upserts: SourceEntry[], removed: number[] = []): void {
    const entries = new Map(this.entries.map(value => [value.event.seq, value]))
    for (const seq of removed) entries.delete(seq)
    for (const value of upserts) entries.set(value.event.seq, value)
    this.entries = [...entries.values()].sort((a, b) => a.event.seq - b.event.seq)
    this.journal.push({ session: metadata, epoch: this.epoch, base: this.version, version: ++this.version, reset: false, upserts, removed })
    for (const listener of this.listeners) listener()
  }
}
async function older(feed: HistoryFeedV1, snapshot: HistorySnapshotV1, signal: AbortSignal): Promise<HistorySnapshotV1> {
  assert.ok(snapshot.before)
  return feed.read({ kind: 'before', cursor: snapshot.before }, budget, signal)
}

test('six continuous reads keep older readable body, all accepted rows, identity and cached return trips', async () => {
  const wire = new SourceFixture(), owner = new RemoteSourceHistory(metadata.id, wire), abort = new AbortController()
  try {
    const feed = await owner.openView('pane-a', budget)
    let snapshot = feed.initial
    const initialLast = snapshot.entries.at(-1)
    const cursors: string[] = []
    for (let page = 0; page < 6; page++) {
      const before = snapshot
      cursors.push(before.before!)
      snapshot = await older(feed, before, abort.signal)
      assert.ok(Number(snapshot.entries[0]!.event.seq) < Number(before.entries[0]!.event.seq), `read ${page + 1} must expose earlier text`)
      assert.ok(readable(snapshot).includes(readable(before)[0]!))
      assert.equal(snapshot.entries.at(-1), initialLast, 'previously accepted source entry is reused')
    }
    assert.equal(snapshot.entries.length, 1120)
    const calls = wire.calls.length
    for (const before of cursors.reverse()) snapshot = await feed.read({ kind: 'before', cursor: before }, budget, abort.signal)
    assert.equal(wire.calls.length, calls, 'returning through an accepted interval must not read its pages again')
    assert.equal(new Set(snapshot.entries.map(value => value.event.seq)).size, snapshot.entries.length)
    feed.release()
  } finally { owner.dispose() }
})

test('automatic and button calls for one cursor share one request, and another Pane keeps an independent window', async () => {
  const wire = new SourceFixture(), owner = new RemoteSourceHistory(metadata.id, wire), abort = new AbortController()
  try {
    const first = await owner.openView('a', budget), second = await owner.openView('b', budget)
    const gate = Promise.withResolvers<void>(); wire.gate = gate.promise
    const one = older(first, first.initial, abort.signal), two = older(first, first.initial, abort.signal)
    assert.equal(wire.calls.length, 2)
    gate.resolve()
    const [left, right] = await Promise.all([one, two])
    assert.equal(left, right)
    assert.equal(second.initial.entries.length, 160, 'another Pane does not acquire the first Pane navigation')
    const cached = await older(second, second.initial, abort.signal)
    assert.equal(wire.calls.length, 2, 'independent readers share accepted source pages')
    assert.equal(cached.entries.length, 320)
  } finally { owner.dispose() }
})

test('a late page cannot overwrite a streaming revision or a newer navigation', async () => {
  const wire = new SourceFixture(), owner = new RemoteSourceHistory(metadata.id, wire), abort = new AbortController()
  try {
    const feed = await owner.openView('a', budget)
    const gate = Promise.withResolvers<void>(); wire.gate = gate.promise
    const earlier = older(feed, feed.initial, abort.signal)
    wire.emit([entry(1200, 'revised-body')])
    await new Promise<void>(resolve => queueMicrotask(resolve))
    gate.resolve(); wire.gate = undefined
    const snapshot = await earlier
    assert.ok(readable(snapshot).includes('revised-body'))
    assert.ok(!readable(snapshot).includes('readable-1200'))
    const nextGate = Promise.withResolvers<void>(); wire.gate = nextGate.promise
    const stale = older(feed, snapshot, abort.signal)
    const jump = feed.read({ kind: 'around', target: { key: 'message-1000', seq: 1000 as never } }, budget, abort.signal)
    nextGate.resolve()
    await assert.rejects(stale, { code: 'STALE_VERSION' })
    assert.ok((await jump).entries.some(value => value.event.seq === 1000))
  } finally { owner.dispose() }
})

test('snapshot-to-subscribe changes replay and streaming completion replaces the same identity', async () => {
  const wire = new SourceFixture(), owner = new RemoteSourceHistory(metadata.id, wire), abort = new AbortController()
  try {
    const feed = await owner.openView('a', budget)
    wire.emit([entry(1400, 'stream-final')])
    await new Promise<void>(resolve => queueMicrotask(resolve))
    const iterator = feed.changes(feed.initial.version, abort.signal)[Symbol.asyncIterator]()
    const next = await iterator.next()
    assert.equal(next.done, false)
    assert.equal(next.value!.base, feed.initial.version)
    const replacement = next.value!.changes.find(change => change.kind === 'replace')
    assert.ok(replacement && replacement.kind === 'replace')
    assert.equal(replacement.entries.filter(value => value.event.seq === 1400).length, 1)
    assert.equal((replacement.entries.at(-1)!.event.data as unknown as { message: { content: [{ text: string }] } }).message.content[0].text, 'stream-final')
    abort.abort(); await iterator.return?.()
  } finally { owner.dispose() }
})

test('released Pane rejects late history and neither release nor navigation sends source operations', async () => {
  const wire = new SourceFixture(), owner = new RemoteSourceHistory(metadata.id, wire), abort = new AbortController()
  try {
    const feed = await owner.openView('a', budget)
    const gate = Promise.withResolvers<void>(); wire.gate = gate.promise
    const pending = older(feed, feed.initial, abort.signal)
    feed.release(); gate.resolve()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(wire.calls.length, 2)
  } finally { owner.dispose() }
})

test('under real shared-cache pressure active windows remain pinned and can revisit retained pages', async () => {
  const wire = new SourceFixture(), owner = new RemoteSourceHistory(metadata.id, wire, { bytes: 1024, events: 20 }), abort = new AbortController()
  try {
    const a = await owner.openView('a', budget), b = await owner.openView('b', budget)
    const next = await older(a, a.initial, abort.signal)
    owner.trimCache()
    const reads = wire.calls.length
    const other = await older(b, b.initial, abort.signal)
    assert.equal(other.entries.length, next.entries.length)
    assert.equal(wire.calls.length, reads, 'pressure cannot evict a visible reader or its accepted page')
  } finally { owner.dispose() }
})
