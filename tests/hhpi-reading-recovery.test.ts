/** Real history owner/feed recovery; only authenticated source IO is controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteSourceHistory, type RemoteHistoryTransport } from '../src/client/remote-history.ts'
import type { SourceChanges, SourceChangesRequest, SourceEntry, SourcePage, SourceSession } from '../src/remote/protocol.ts'

const session: SourceSession = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread',
  title: 'Synthetic recovery', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [],
  capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
const budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }
function entry(seq: number): SourceEntry { return { type: 'event', event: { type: 'user/message', seq, time: 1,
  data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `body-${seq}` }] } } } as SourceEntry }
function page(version = 1): SourcePage { return { session, epoch: 'epoch', version, entries: [entry(version)], before: version, after: version,
  hasBefore: false, hasAfter: false, context: [] } }
const unavailable = (): RemoteError<'hhpi/source'> => new RemoteError('hhpi/source', 'Source temporarily unavailable', { sourceCode: 'TARGET_UNAVAILABLE', outcome: 'rejected' })
async function turn(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)) }
async function* idle(_request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
  if (signal?.aborted) return
  await new Promise<void>(resolve => { signal?.addEventListener('abort', () => resolve(), { once: true }) })
}

test('opening survives transient source failure and resumes without reopening the Pane', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0, settled = false
  const owner = new RemoteSourceHistory(session.id, { read: async () => { if (++reads < 3) throw unavailable(); return page() }, changes: idle })
  t.after(() => owner.dispose())
  const opened = owner.openView('pane', budget).then(value => { settled = true; return value })
  await turn()
  assert.equal(settled, false)
  t.mock.timers.tick(10_000); await turn()
  assert.equal(settled, false)
  t.mock.timers.tick(10_000)
  const feed = await opened
  assert.equal(reads, 3)
  assert.equal(feed.initial.entries[0]?.event.seq, 1)
})

test('closing the final pending opener cancels recovery without cancelling a surviving opener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const owner = new RemoteSourceHistory(session.id, { read: async () => { ++reads; throw unavailable() }, changes: idle })
  t.after(() => owner.dispose())
  const a = new AbortController(), b = new AbortController()
  const first = owner.prepare(a.signal), second = owner.prepare(b.signal)
  const rejectedA = assert.rejects(first, { name: 'AbortError' }), rejectedB = assert.rejects(second, { name: 'AbortError' })
  await turn(); a.abort(); await rejectedA
  t.mock.timers.tick(10_000); await turn()
  assert.equal(reads, 2, 'one surviving opener keeps the shared read recoverable')
  b.abort(); await rejectedB; await turn()
  t.mock.timers.tick(60_000); await turn()
  assert.equal(reads, 2, 'no opener remains to own another source read')
})

test('a temporary domain failure resumes live updates from the accepted source cursor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: SourceChangesRequest[] = [], update = Promise.withResolvers<void>()
  const transport: RemoteHistoryTransport = { read: async () => page(),
    async *changes(request, signal) {
      requests.push(request)
      if (requests.length === 1) throw unavailable()
      await update.promise
      if (signal?.aborted) return
      yield { session, epoch: 'epoch', base: 1, version: 2, reset: false, upserts: [entry(2)], removed: [] }
      yield* idle(request, signal)
    } }
  const owner = new RemoteSourceHistory(session.id, transport)
  t.after(() => owner.dispose())
  const feed = await owner.openView('pane', budget), abort = new AbortController()
  const stream = feed.changes(feed.initial.version, abort.signal)[Symbol.asyncIterator](), next = stream.next()
  await turn(); t.mock.timers.tick(10_000); await turn()
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1], requests[0])
  update.resolve()
  const accepted = await next
  assert.deepEqual(accepted.value?.snapshot?.entries.map(value => value.event.seq), [1, 2])
  abort.abort(); await stream.return?.()
})

test('a version gap rebaselines the existing reader and keeps permanent failures terminal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0, follows = 0
  const owner = new RemoteSourceHistory(session.id, { read: async () => page(++reads === 1 ? 1 : 3),
    async *changes(request, signal) {
      if (++follows === 1) yield { session, epoch: 'epoch', base: 2, version: 3, reset: false, upserts: [entry(3)], removed: [] }
      yield* idle(request, signal)
    } })
  t.after(() => owner.dispose())
  const feed = await owner.openView('pane', budget), abort = new AbortController()
  const stream = feed.changes(feed.initial.version, abort.signal)[Symbol.asyncIterator]()
  const recovered = await stream.next()
  assert.equal(recovered.value?.snapshot?.entries[0]?.event.seq, 3)
  assert.equal(owner.sourceVersion, 3)
  abort.abort(); await stream.return?.()

  const denied = new RemoteError('hhpi/source', 'This source is not authorized', { sourceCode: 'UNSUPPORTED', outcome: 'rejected' })
  const unavailableOwner = new RemoteSourceHistory(session.id, { read: async () => { throw denied }, changes: idle })
  t.after(() => unavailableOwner.dispose())
  await assert.rejects(unavailableOwner.prepare(), error => error === denied)
})


test('an unavailable foreground source exits its RPC budget and an explicit retry can open it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let online = false
  const owner = new RemoteSourceHistory(session.id, { read: async () => { if (!online) throw unavailable(); return page() }, changes: idle })
  t.after(() => owner.dispose())
  const failed = assert.rejects(owner.prepare(), { code: 'TARGET_UNAVAILABLE', message: /within 30 seconds/ })
  await turn(); t.mock.timers.tick(30_000); await failed
  online = true
  assert.equal((await owner.openView('retry', budget)).initial.entries[0]?.event.seq, 1)
})

test('a source read that ignores cancellation cannot keep a foreground opener pending forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalled = Promise.withResolvers<SourcePage>()
  const owner = new RemoteSourceHistory(session.id, { read: () => stalled.promise, changes: idle })
  t.after(() => owner.dispose())
  const failed = assert.rejects(owner.prepare(), { code: 'TARGET_UNAVAILABLE' })
  await turn(); t.mock.timers.tick(30_000); await failed
  stalled.resolve(page()); await turn()
  assert.equal(owner.sourceVersion, 0, 'late timed-out transport results cannot become accepted history')
})

test('a returned page cannot wait forever for a disconnected source version stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const owner = new RemoteSourceHistory(session.id, { read: async () => page(++calls), changes: idle })
  t.after(() => owner.dispose())
  const feed = await owner.openView('pane', budget)
  const failed = assert.rejects(feed.read({ kind: 'around', target: { key: 'message-2', seq: 2 as never } }, budget, new AbortController().signal), { code: 'TARGET_UNAVAILABLE' })
  await turn(); t.mock.timers.tick(30_000); await failed
  assert.equal(feed.initial.entries[0]?.event.seq, 1, 'a stalled version catchup leaves the already accepted body mounted')
})

test('same-epoch replay expiry revalidates the whole retained interval without jumping to latest', async t => {
  const reset = Promise.withResolvers<SourceChanges>(), revalidated = Promise.withResolvers<void>()
  let version = 1, gap = false
  const owner = new RemoteSourceHistory(session.id, {
    read: async request => {
      const start = request.after !== undefined ? request.after + 1 : request.before !== undefined ? request.before - 160 : 840
      if (gap) revalidated.resolve()
      const entries = Array.from({ length: request.limit ?? 160 }, (_, offset) => entry(start + offset)).filter(value => !gap || value.event.seq !== 700)
      return { session, epoch: 'epoch', version, entries, before: start, after: entries.at(-1)!.event.seq, hasBefore: true, hasAfter: request.after !== undefined, context: [] }
    },
    async *changes(request, signal) { yield await reset.promise; yield* idle(request, signal) },
  })
  t.after(() => owner.dispose())
  const feed = await owner.openView('pane', budget)
  const older = await feed.read({ kind: 'before', cursor: feed.initial.before! }, budget, new AbortController().signal)
  feed.publication!.accept(older.version)
  version = 2; gap = true
  const abort = new AbortController(), stream = feed.changes(older.version, abort.signal)[Symbol.asyncIterator](), next = stream.next()
  reset.resolve({ session, epoch: 'epoch', base: 1, version: 2, reset: true, upserts: [], removed: [] })
  await revalidated.promise
  const restored = await next
  const seqs = restored.value!.snapshot!.entries.map(value => value.event.seq)
  assert.ok(seqs.includes(680)); assert.ok(seqs.includes(999))
  assert.ok(!seqs.includes(700), 'authoritative deletion in a missed journal range is respected')
  assert.ok(restored.value!.snapshot!.hasAfter, 'recovery remains in the historic interval')
  abort.abort(); await stream.return?.()
})
