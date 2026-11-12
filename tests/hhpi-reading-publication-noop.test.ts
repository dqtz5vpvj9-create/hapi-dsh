/** Production source/window publication and Pane stores; only native IO and official reader snapshots are controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import type { HistoryFeedV1, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteSourceHistory } from '../src/client/remote-history.ts'
import { SourceReadingCache } from '../src/client/remote-reading-cache.ts'
import { sourceSessionId, type SourceChanges, type SourceEntry, type SourcePage, type SourceSession } from '../src/remote/protocol.ts'

const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native' }
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Source', cwd: '/source', updatedAt: 1, status: 'idle', activeTurnId: null,
  capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] }
const entry = (seq: number, text = `body-${seq}`): SourceEntry => ({ type: 'event', event: { seq, time: 1, type: 'user/message',
  data: { turn: seq, message: { id: String(seq), role: 'user', content: [{ type: 'text', text }] } } } }) as SourceEntry
const budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
class StorageFixture implements Storage {
  private data = new Map<string, string>()
  get length() { return this.data.size }
  clear() { this.data.clear() }
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
  key(index: number) { return [...this.data.keys()][index] ?? null }
}
async function historyFixture() {
  let version = 1, metadata = session, wake = () => {}
  const journal: SourceChanges[] = [], values = [entry(10), entry(20)]
  const cache = new SourceReadingCache({ storage: new StorageFixture(), scope: 'isolated' })
  const owner = new RemoteSourceHistory(session.id, {
    read: async (): Promise<SourcePage> => ({ session: metadata, epoch: 'epoch', version, entries: values, before: 10, after: 20, hasBefore: true, hasAfter: false, context: [] }),
    async *changes(request, signal) {
      let seen = request.version
      while (!signal?.aborted) {
        const next = journal.find(change => change.base === seen)
        if (next) { seen = next.version; yield next; continue }
        await new Promise<void>(resolve => {
          const done = () => { signal?.removeEventListener('abort', done); resolve() }
          wake = done; signal?.addEventListener('abort', done, { once: true })
          if (signal?.aborted) done()
        })
      }
    },
  }, undefined, cache)
  const feed = await owner.openView('pane', budget)
  feed.publication!.accept(feed.initial.version)
  const emit = async (upserts: SourceEntry[], next = metadata) => {
    metadata = next
    journal.push({ session: metadata, epoch: 'epoch', base: version, version: ++version, reset: false, upserts, removed: [] })
    wake(); await settle()
  }
  return { owner, feed, cache, emit }
}

test('outside-window materialization and metadata advance the checkpoint without an official body candidate', async t => {
  const f = await historyFixture(); t.after(() => f.owner.dispose())
  const abort = new AbortController(), changes = f.feed.changes(f.feed.initial.version, abort.signal)[Symbol.asyncIterator]()
  let notified = false
  const next = changes.next().then(value => { notified = true; return value })
  await f.emit([entry(1)])
  assert.equal(notified, false, 'older records outside this Pane must not schedule an official commit')
  await f.emit([], { ...session, title: 'Renamed without body changes' })
  assert.equal(notified, false)
  const checkpoint = f.cache.read(session.id)!
  assert.equal(checkpoint.version, 3)
  assert.equal(checkpoint.session.title, 'Renamed without body changes')
  assert.deepEqual(checkpoint.windows[0]!.page.entries.map(value => value.event.seq), [10, 20])
  await f.emit([entry(20, 'Actual correction')])
  const delta = (await next).value!
  assert.equal(delta.base, f.feed.initial.version, 'opaque reading versions advance only for an observable candidate')
  assert.notEqual(delta.version, delta.base)
  assert.match(JSON.stringify(delta.snapshot), /Actual correction/)
  abort.abort(); await changes.return?.()
})

test('a pending changed candidate cannot make its old published snapshot a current checkpoint', async t => {
  const f = await historyFixture(); t.after(() => f.owner.dispose())
  const abort = new AbortController(), changes = f.feed.changes(f.feed.initial.version, abort.signal)[Symbol.asyncIterator]()
  const next = changes.next()
  await f.emit([entry(20, 'Pending correction')])
  const candidate = (await next).value!.snapshot!
  assert.equal(f.cache.read(session.id)!.version, 1, 'unaccepted source body changes retain the old durable checkpoint')
  await f.emit([entry(1)], { ...session, title: 'Latest metadata' })
  assert.equal(f.cache.read(session.id)!.version, 1, 'no-op coverage belongs to the pending snapshot identity, never the old published snapshot')
  f.feed.publication!.accept(candidate.version)
  const saved = f.cache.read(session.id)!
  assert.equal(saved.version, 3)
  assert.match(JSON.stringify(saved.windows[0]!.page.entries), /Pending correction/)
  assert.equal(saved.session.title, 'Latest metadata')
  abort.abort(); await changes.return?.()
})

test('Pane state and source navigation notify independently and keep every actual field change', async () => {
  const output = await build({ entryPoints: ['src/client/remote-reading-session.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
    alias: { '@deepseek-ai/dsh-api-session-controller/client': './tests/fixtures/client-session-contract.ts' }, external: ['@deepseek-ai/cordis'], logLevel: 'silent' })
  const module = { exports: {} as typeof import('../src/client/remote-reading-session.ts') }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports)
  let base = { sessionId: session.id, pendingSubmissions: [], running: false, removed: false, openState: 'open', hasMore: true,
    loadingOlder: false } as unknown as SessionSnapshot
  let ownerListener = () => {}, readerListener = () => {}
  let reading = { version: 'initial', phase: 'ready', busy: false, hasBefore: true, hasAfter: false, before: 'older' }
  const pane = new module.exports.RemotePaneSession({ sessionId: session.id, projections: {}, historyRead: {}, metadata: {}, history: { sourceEpoch: 'epoch' },
    registerDeliveryReader: () => () => {}, reconcilePublishedSubmissions: () => {},
    getSnapshot: () => base, subscribe: (listener: () => void) => { ownerListener = listener; return () => {} } } as never, Promise.resolve({} as never), 'pane')
  pane.attach({ viewId: 'pane', snapshot: { getSnapshot: () => reading, subscribe: (listener: () => void) => { readerListener = listener; return () => {} } },
    read: async () => { reading = { ...reading, before: 'even-older', version: 'next' }; return reading } } as never)
  let states = 0, progress = 0
  pane.subscribe(() => { states++ }); pane.sourceWindow.subscribe(() => { progress++ })
  const initial = pane.getSnapshot(), initialProgress = pane.sourceWindow.getSnapshot()
  readerListener()
  assert.equal(pane.getSnapshot(), initial); assert.equal(pane.sourceWindow.getSnapshot(), initialProgress)
  assert.equal(states, 0); assert.equal(progress, 0)
  reading = { ...reading, busy: true }; readerListener()
  assert.equal(states, 1); assert.equal(progress, 0)
  reading = { ...reading, version: 'body-publication' }; readerListener()
  assert.equal(states, 1, 'official body-only publication does not replace the equal Session snapshot')
  reading = { ...reading, busy: false }; readerListener()
  assert.equal(states, 2)
  await pane.loadOlder()
  assert.equal(states, 2); assert.equal(progress, 1)
  assert.equal(pane.sourceWindow.getSnapshot().olderRevision, 1)
  reading = { ...reading, phase: 'error' }; readerListener()
  assert.equal(progress, 2); assert.equal(pane.sourceWindow.getSnapshot().pagingError, true)
  reading = { ...reading, hasAfter: true }; readerListener()
  assert.equal(progress, 3)
  base = { ...base, running: true }; ownerListener()
  assert.equal(states, 3, 'actual execution state remains observable')
  pane.dispose()
})


test('identical resident upserts retain the accepted objects and only a genuine revision publishes', async t => {
  const f = await historyFixture(); t.after(() => f.owner.dispose())
  const abort = new AbortController(), changes = f.feed.changes(f.feed.initial.version, abort.signal)[Symbol.asyncIterator]()
  let published = false
  const next = changes.next().then(value => { published = true; return value })
  const resident = f.feed.initial.entries[0] as SourceEntry
  await f.emit([resident])
  assert.equal(published, false, 'same-reference resident context does not create a candidate')
  await f.emit([structuredClone(resident)])
  assert.equal(published, false, 'identical wire retransmission does not create a candidate')
  const checkpoint = f.cache.read(session.id)!
  assert.equal(checkpoint.version, 3, 'both observed source revisions advance durable provenance')
  const latest = await f.owner.page({}, new AbortController().signal)
  assert.equal(latest.entries.find(value => value.event.seq === resident.event.seq), resident, 'shared materialization retains the original accepted object')
  await f.emit([entry(resident.event.seq, 'Genuine revision')])
  const delta = (await next).value!
  assert.equal(delta.base, f.feed.initial.version)
  assert.match(JSON.stringify(delta.snapshot), /Genuine revision/)
  abort.abort(); await changes.return?.()
})
