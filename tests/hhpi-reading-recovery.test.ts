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
