/** Real history/cache; deterministic source wire and Storage are the only fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSourceHistory } from '../src/client/remote-history.ts'
import { SourceReadingCache } from '../src/client/remote-reading-cache.ts'
import type { SourceChanges, SourceEntry, SourcePage, SourceReadRequest, SourceSession } from '../src/remote/protocol.ts'

class Storage {
  values = new Map<string, string>()
  get length() { return this.values.size }
  key(i: number) { return [...this.values.keys()][i] ?? null }
  getItem(k: string) { return this.values.get(k) ?? null }
  setItem(k: string, v: string) { this.values.set(k, v) }
  removeItem(k: string) { this.values.delete(k) }
  clear() { this.values.clear() }
}
const session: SourceSession = { id: 'hhpi:fixture:source:codex:thread', machineId: 'fixture', sourceId: 'source', engine: 'codex', nativeId: 'thread', title: 'Synthetic reopen', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: false, steer: false, cancel: false, approve: false, files: false } }
const budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }
const entry = (seq: number, text = `body ${seq}`): SourceEntry => ({ type: 'event', event: { type: 'user/message', seq, time: 1, data: { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } }) as SourceEntry
function sourcePage(count: number, version: number, request: SourceReadRequest): SourcePage {
  const limit = request.limit ?? 160
  const start = request.around === undefined ? Math.max(1, count - limit + 1) : Math.max(1, request.around - Math.floor(limit / 2))
  const entries = Array.from({ length: Math.min(limit, count - start + 1) }, (_, index) => entry(start + index))
  return { session, epoch: 'e', version, entries, before: start, after: entries.at(-1)?.event.seq ?? null, hasBefore: start > 1, hasAfter: start + entries.length <= count, context: [] }
}
async function* idle(signal?: AbortSignal): AsyncIterable<SourceChanges> {
  if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
}
const tick = () => new Promise(resolve => setImmediate(resolve))

for (const delta of [0, 1000, 10000]) for (const expired of [false, true]) {
  test(`reopen at latest is bounded for delta=${delta}, expired=${expired}`, async t => {
    const cache = new SourceReadingCache({ scope: 'fixture', storage: new Storage() })
    const head = sourcePage(1000, 1, { sessionId: session.id })
    cache.write({ session, epoch: 'e', version: 1, head, windows: [{ viewId: 'pane', page: head }] })
    const reads: SourceReadRequest[] = [], subscriptions: number[] = [], version = 1 + delta
    let replayed = 0
    const owner = new RemoteSourceHistory(session.id, {
      async read(request) { reads.push(request); return sourcePage(1000 + delta, version, request) },
      async *changes(request, signal) {
        subscriptions.push(request.version)
        if (request.version < version) {
          const upserts = expired ? [] : Array.from({ length: delta }, (_, i) => entry(1001 + i))
          replayed += upserts.length
          yield { session, epoch: 'e', version, base: request.version, reset: expired, upserts, removed: [] }
        }
        yield* idle(signal)
      },
    }, undefined, cache)
    t.after(() => { owner.dispose(); cache.dispose() })
    const feed = await owner.openView('pane:2', budget, undefined, 'pane')
    assert.equal(feed.initial.entries.length, 160)
    assert.equal(feed.initial.entries.at(-1)?.event.seq, 1000 + delta)
    assert.equal(reads.length, 1)
    assert.equal(reads[0]?.around, undefined)
    assert.equal(owner.retainedEvents, 160)
    assert.deepEqual(subscriptions, [version])
    assert.equal(replayed, 0)
  })
}

test('an explicit remote target opens directly around its sequence', async t => {
  const reads: SourceReadRequest[] = []
  const owner = new RemoteSourceHistory(session.id, {
    async read(request) { reads.push(request); return sourcePage(11000, 10001, request) },
    changes: (_request, signal) => idle(signal),
  })
  t.after(() => owner.dispose())
  const feed = await owner.openView('deep-link', budget, undefined, 'pane', { kind: 'around', seq: 900 })
  assert.equal(reads.length, 1)
  assert.equal(reads[0]?.around, 900)
  assert.equal(feed.initial.entries.length, 160)
  assert.ok(feed.initial.entries.some(value => value.event.seq === 900))
  assert.equal(feed.initial.hasAfter, true)
})

test('a latest Pane does not wait for another Pane replay and replay outside both windows is not retained', async t => {
  const replay = Promise.withResolvers<void>()
  let count = 1000, version = 1, observed = 0
  const owner = new RemoteSourceHistory(session.id, {
    async read(request) { return sourcePage(count, version, request) },
    async *changes(_request, signal) {
      await replay.promise
      if (signal?.aborted) return
      const upserts = [entry(900, 'revised during absence'), ...Array.from({ length: 10000 }, (_, i) => entry(1001 + i))]
      yield { session, epoch: 'e', version: 10001, base: 1, reset: false, upserts, removed: [] }
      yield* idle(signal)
    },
  })
  t.after(() => { replay.resolve(); owner.dispose() })
  owner.subscribeEntries(entries => { observed += entries.length })
  const old = await owner.openView('old', budget)
  old.publication!.accept(old.initial.version)
  count = 11000; version = 10001
  const latest = await owner.openView('new', budget)
  assert.equal(latest.initial.entries.at(-1)?.event.seq, 11000)
  assert.equal(owner.sourceVersion, 1, 'new target must not falsely advance shared synchronization')
  assert.equal(old.publication!.published!.snapshot, old.initial)
  const abort = new AbortController(), stream = old.changes(old.initial.version, abort.signal)[Symbol.asyncIterator]()
  const pending = stream.next()
  replay.resolve()
  const change = (await pending).value!
  assert.ok(JSON.stringify(change.snapshot?.entries.find(value => value.event.seq === 900)).includes('revised during absence'))
  assert.equal(change.snapshot?.entries.length, 160)
  assert.equal(change.snapshot?.hasAfter, true, 'a large replay leaves an unread range instead of breaking or expanding the existing reader')
  await tick()
  assert.equal(owner.sourceVersion, 10001)
  assert.equal(owner.retainedEvents, 320, 'only the two requested windows retain body')
  assert.equal(observed, 160 + 160 + 10001, 'receipt/state observers still receive the actual replay')
  const stillLatest = await latest.refresh!(budget, abort.signal)
  assert.equal(stillLatest.entries.length, 160)
  assert.equal(stillLatest.entries.at(-1)?.event.seq, 11000)
  abort.abort(); await stream.return?.()
})

test('an older replay deletion cannot erase a newer target snapshot', async t => {
  const replay = Promise.withResolvers<void>()
  let version = 1
  const owner = new RemoteSourceHistory(session.id, {
    async read(request) { return sourcePage(1000, version, request) },
    async *changes(_request, signal) {
      await replay.promise
      if (signal?.aborted) return
      yield { session, epoch: 'e', version: 2, base: 1, reset: false, upserts: [], removed: [900] }
      yield { session, epoch: 'e', version: 3, base: 2, reset: false, upserts: [entry(900)], removed: [] }
      yield* idle(signal)
    },
  })
  t.after(() => { replay.resolve(); owner.dispose() })
  await owner.openView('old', budget)
  version = 3
  const target = await owner.openView('new', budget, undefined, 'new', { kind: 'around', seq: 900 })
  replay.resolve(); await tick()
  const current = await target.refresh!(budget, new AbortController().signal)
  assert.equal(current, target.initial, 'replay older than this window cannot publish an intermediate deletion')
  assert.ok(current.entries.some(value => value.event.seq === 900))
})
