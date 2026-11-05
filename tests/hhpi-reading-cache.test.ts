/** Durable browser storage and remote source IO are controlled boundaries; cache/feed are production. */
import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SourceReadingCache } from '../src/client/remote-reading-cache.ts'
import { clearSourceStorage } from '../src/client/remote-storage.ts'
import { graphStorage } from '../src/client/runtime-store.ts'
import { RemoteSourceHistory } from '../src/client/remote-history.ts'
import { SourceError } from '../src/remote/errors.ts'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { RemoteSessions, RemoteSourceSession } from '../src/client/remote-sessions.ts'
import type { SourceChanges, SourceChangesRequest, SourcePage, SourceReadRequest, SourceSession } from '../src/remote/protocol.ts'

class BrowserStorage implements Storage {
  readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
  clear(): void { this.values.clear() }
}
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..')
let Sessions: typeof RemoteSessions
let SourceSessionFace: typeof RemoteSourceSession
before(async () => {
  const output = await build({ entryPoints: [resolve(root, 'src/client/remote-sessions.ts')],
    alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-gateway/client'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} as { RemoteSessions: typeof RemoteSessions; RemoteSourceSession: typeof RemoteSourceSession } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
  Sessions = module.exports.RemoteSessions
  SourceSessionFace = module.exports.RemoteSourceSession
})
const session: SourceSession = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread',
  title: 'Synthetic offline read', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [],
  capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
const budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }

test('Host revocation removes only its HHPI retained data and preserves drafts, primary data and other Hosts', () => {
  const storage = new BrowserStorage(), own = graphStorage(storage, 'paired-a', 'shared'), other = graphStorage(storage, 'paired-b', 'shared')
  own.setItem('hhpi:reading:v1:account:body', 'private body'); own.setItem('hhpi:outbox:v1:account:operation', 'pending operation')
  own.setItem('plugin-draft', 'unsent draft'); other.setItem('hhpi:reading:v1:account:body', 'other Host body')
  storage.setItem('hhpi:reading:v1:account:body', 'primary body')
  clearSourceStorage(own)
  assert.equal(own.getItem('hhpi:reading:v1:account:body'), null); assert.equal(own.getItem('hhpi:outbox:v1:account:operation'), null)
  assert.equal(own.getItem('plugin-draft'), 'unsent draft'); assert.equal(other.getItem('hhpi:reading:v1:account:body'), 'other Host body')
  assert.equal(storage.getItem('hhpi:reading:v1:account:body'), 'primary body')
})
function page(request: SourceReadRequest, metadata = session): SourcePage {
  const values = Array.from({ length: 800 }, (_, seq) => ({ type: 'event', event: { type: 'user/message', seq, time: 1,
    data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `body-${seq}` }] } } })) as SourcePage['entries']
  const start = request.around === undefined ? 640 : Math.max(0, request.around - 80), entries = values.slice(start, start + 160)
  return { session: metadata, epoch: 'epoch', version: 1, entries, before: start, after: start + 159, hasBefore: start > 0, hasAfter: start < 640, context: [] }
}
async function* idle(_request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
  if (signal?.aborted) return
  await new Promise<void>(resolve => { signal?.addEventListener('abort', () => resolve(), { once: true }) })
}

test('authenticated cached metadata opens a source while catalog is offline and explicit removal clears it', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'authenticated-owner-host' }, saved = new SourceReadingCache(access)
  const head = page({ sessionId: session.id })
  saved.write({ session, epoch: head.epoch, version: head.version, head, windows: [] }); saved.dispose()
  const ctx = new Context(), state = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const original = { list: { getSnapshot: () => state, subscribe: () => () => {} }, windowCommit: {},
    searchResultLimit: 100, refresh: async () => {}, binding: () => undefined,
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => {} }) } as unknown as ISessions
  let removed = false, late = false, reads = 0
  const sessions = new Sessions(ctx, original, {
    catalog: async () => ({ ok: true, value: { protocol: 1, legacyHapi: false, sessions: late ? [session] : [], sources: removed ? [
      { id: session.sourceId, machineId: session.machineId, engine: session.engine, online: true, create: true },
    ] : [] } }),
    read: async () => { ++reads; throw new Error('Offline source must not be read to open its saved body') },
  } as unknown as HhpiRemoteApi, access)
  t.after(async () => { sessions.dispose(); await ctx.fiber.dispose() })
  assert.ok(sessions.list.getSnapshot().byId[session.id as SessionId], 'the authenticated bootstrap can populate the sidebar before catalog completes')
  await sessions.refresh()
  assert.ok(sessions.list.getSnapshot().byId[session.id as SessionId], 'a session-only principal may legitimately receive no source descriptors')
  const reference = sessions.retain(session.id as SessionId, { source: 'hapiWorkspace' })
  t.after(() => reference.release())
  await reference.ready
  assert.equal(reads, 0)
  assert.ok((reference.binding.session as RemoteSourceSession).history)
  const firstHistory = (reference.binding.session as RemoteSourceSession).history
  reference.release()
  const again = sessions.retain(session.id as SessionId, { source: 'hapiWorkspace' })
  t.after(() => again.release())
  await again.ready
  assert.equal(reads, 0)
  assert.equal((again.binding.session as RemoteSourceSession).history, firstHistory, 'a recently used source retains its accepted body within the bounded warm cache')
  removed = true; await sessions.refresh()
  assert.ok(sessions.list.getSnapshot().byId[session.id as SessionId], 'a cached online directory may predate the accepted source body')
  sessions.revokeReadingSource(session.id)
  assert.equal(sessions.list.getSnapshot().byId[session.id as SessionId], undefined)
  late = true; await sessions.refresh()
  assert.equal(sessions.list.getSnapshot().byId[session.id as SessionId], undefined, 'a stale source catalog cannot undo explicit revocation in this graph')
  const reopened = new SourceReadingCache(access)
  assert.equal(reopened.read(session.id), undefined)
  reopened.dispose()
})

test('a late catalog from a retired account cannot repopulate the next authenticated cache scope', async t => {
  const storage = new BrowserStorage(), a = { storage, scope: 'account-a' }, b = { storage, scope: 'account-b' }
  const second = { ...session, title: 'Account B source' }
  const cachedSecond = { ...second, title: 'Cached account B source', capabilities: { ...second.capabilities, send: false } }
  for (const [access, metadata] of [[a, session], [b, cachedSecond]] as const) {
    const saved = new SourceReadingCache(access), head = page({ sessionId: session.id }, metadata)
    saved.write({ session: metadata, epoch: head.epoch, version: head.version, head, windows: [] }); saved.dispose()
  }
  const ctx = new Context(), state = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const original = { list: { getSnapshot: () => state, subscribe: () => () => {} }, windowCommit: {},
    searchResultLimit: 100, refresh: async () => {}, binding: () => undefined,
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => {} }) } as unknown as ISessions
  const old = Promise.withResolvers<Awaited<ReturnType<HhpiRemoteApi['catalog']>>>()
  let calls = 0, oldSignal: AbortSignal | undefined
  const catalog = (metadata: SourceSession) => ({ ok: true as const, value: { protocol: 1 as const, legacyHapi: false, storageScope: metadata === second ? b.scope : a.scope, sessions: [metadata], sources: [] } })
  const sessions = new Sessions(ctx, original, {
    catalog: signal => { if (++calls === 1) { oldSignal = signal; return old.promise }; return Promise.resolve(catalog(second)) },
    read: async () => { throw new Error('Cached account body should not require source IO') },
  } as HhpiRemoteApi, a)
  t.after(async () => { old.resolve(catalog(session)); sessions.dispose(); await ctx.fiber.dispose() })
  const reference = sessions.retain(session.id as SessionId, { source: 'hapiWorkspace' })
  t.after(() => reference.release())
  await reference.ready
  const oldBinding = reference.binding
  sessions.setReadingStorage(b)
  assert.equal(oldSignal?.aborted, true)
  await sessions.refresh()
  old.resolve(catalog(session)); await old.promise
  assert.equal(sessions.list.getSnapshot().byId[session.id as SessionId]?.title, second.title)
  assert.equal(sessions.ownsBinding(oldBinding), false)
  const current = sessions.retain(session.id as SessionId, { source: 'hapiWorkspace' })
  t.after(() => current.release())
  await current.ready
  assert.equal((current.binding.session as RemoteSourceSession).metadata.getSnapshot().capabilities.send, true)
  assert.equal(sessions.list.getSnapshot().byId[session.id as SessionId]?.title, second.title, 'cached body metadata cannot roll back a more recent authenticated catalog')
  reference.release()
  assert.equal(sessions.retainInfo(session.id as SessionId).getSnapshot().referenceCount, 1,
    'a late release from the retired account cannot overwrite the next account retain state')
  const cleared = new SourceReadingCache(a)
  assert.equal(cleared.read(session.id), undefined)
  cleared.dispose()
  const retained = new SourceReadingCache(b)
  assert.equal(retained.read(session.id)?.session.title, cachedSecond.title)
  retained.dispose()
})

test('authenticated catalog adopts its storage scope and explicit Host revocation cannot be undone by polling', async t => {
  const storage = new BrowserStorage(), a = { storage, scope: 'account-before' }, b = { storage, scope: 'authenticated-account' }
  for (const access of [a, b]) {
    const cache = new SourceReadingCache(access), head = page({ sessionId: session.id })
    cache.write({ session, epoch: head.epoch, version: head.version, head, windows: [] }); cache.dispose()
  }
  const ctx = new Context(), state = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const original = { list: { getSnapshot: () => state, subscribe: () => () => {} }, windowCommit: {},
    searchResultLimit: 100, refresh: async () => {}, binding: () => undefined,
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => {} }) } as unknown as ISessions
  let calls = 0
  const sessions = new Sessions(ctx, original, {
    catalog: async () => { ++calls; return { ok: true, value: { protocol: 1, legacyHapi: false, storageScope: b.scope, sessions: [session], sources: [] } } },
    read: async () => { throw new Error('Accepted account checkpoint should hydrate without network IO') },
  } as unknown as HhpiRemoteApi, a)
  t.after(async () => { sessions.dispose(); await ctx.fiber.dispose() })
  await sessions.refresh()
  assert.equal(calls, 1, 'the authenticated response is applied without recursively fetching the same catalog')
  const obsolete = new SourceReadingCache(a)
  assert.equal(obsolete.read(session.id), undefined); obsolete.dispose()
  const reference = sessions.retain(session.id as SessionId, { source: 'hapiWorkspace' })
  await reference.ready
  sessions.revokeStorage(); reference.release()
  await sessions.refresh()
  assert.equal(calls, 1, 'explicit Host revocation prevents catalog polling from re-enabling its cache')
  assert.equal(sessions.list.getSnapshot().byId[session.id as SessionId], undefined)
  const cleared = new SourceReadingCache(b)
  assert.equal(cleared.read(session.id), undefined); cleared.dispose()
})

test('reloading offline restores cached body and each persistent Pane position without source reads', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'authenticated-owner-host-a' }
  const cache = new SourceReadingCache(access), owner = new RemoteSourceHistory(session.id, { read: async request => page(request), changes: idle }, undefined, cache)
  const historic = await owner.openView('pane-a:1', budget, undefined, 'pane-a')
  historic.publication!.accept(historic.initial.version)
  const earlier = await historic.read({ kind: 'around', target: { key: 'message-120', seq: 120 as never } }, budget, new AbortController().signal)
  historic.publication!.accept(earlier.version)
  const latest = await owner.openView('pane-b:2', budget, undefined, 'pane-b')
  latest.publication!.accept(latest.initial.version)
  cache.writePosition(session.id, 'pane-a', { anchorKey: 'message-120', anchorTop: 27, scrollTop: 890 }, 120)
  cache.writePosition(session.id, 'pane-b', null)
  cache.flush(); owner.dispose(); cache.dispose()

  const restored = new SourceReadingCache(access)
  let reads = 0
  const offline = new RemoteSourceHistory(session.id, { read: async () => { ++reads; throw new Error('No network available') }, changes: idle }, undefined, restored)
  t.after(() => { offline.dispose(); restored.dispose() })
  assert.equal(restored.sessions()[0]?.id, session.id)
  const a = await offline.openView('pane-a:99', budget, undefined, 'pane-a'), b = await offline.openView('pane-b:100', budget, undefined, 'pane-b')
  assert.ok(a.initial.entries.some(entry => entry.event.seq === 120))
  assert.ok(b.initial.entries.some(entry => entry.event.seq === 799))
  assert.equal(reads, 0, 'cached source pages are immediately readable while transport is absent')
  assert.deepEqual(restored.readPosition(session.id, 'pane-a'), { anchorKey: 'message-120', anchorTop: 27, scrollTop: 890 })
  assert.equal(restored.readPosition(session.id, 'pane-b'), null)
})

test('closing and reopening a retained source while offline reuses its authorized reading checkpoint', async t => {
  const cache = new SourceReadingCache({ storage: new BrowserStorage(), scope: 'owner' })
  let reads = 0
  const owner = new RemoteSourceHistory(session.id, { read: async request => { ++reads; return page(request) }, changes: idle }, undefined, cache)
  t.after(() => { owner.dispose(); cache.dispose() })
  const first = await owner.openView('pane:1', budget, undefined, 'pane')
  const earlier = await first.read({ kind: 'around', target: { key: 'message-120', seq: 120 as never } }, budget, new AbortController().signal)
  first.publication!.accept(earlier.version)
  first.release()
  const previousReads = reads
  const reopened = await owner.openView('pane:2', budget, undefined, 'pane')
  assert.ok(reopened.initial.entries.some(entry => entry.event.seq === 120))
  assert.equal(reads, previousReads, 'a released Pane must not make its cached body depend on a new network request')
})

test('unpublished and discarded navigation never replaces the durable reader window', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'owner' }, cache = new SourceReadingCache(access)
  const owner = new RemoteSourceHistory(session.id, { read: async request => page(request), changes: idle }, undefined, cache)
  t.after(() => { owner.dispose(); cache.dispose() })
  const feed = await owner.openView('pane:1', budget, undefined, 'pane')
  feed.publication!.accept(feed.initial.version)
  cache.writePosition(session.id, 'pane', { anchorKey: 'message-700', anchorTop: 12, scrollTop: 900 }, 700)
  const proposal = await feed.read({ kind: 'around', target: { key: 'message-120', seq: 120 as never } }, budget, new AbortController().signal)
  cache.flush()
  const whilePrepared = new SourceReadingCache(access)
  assert.ok(whilePrepared.read(session.id)!.windows[0]!.page.entries.some(entry => entry.event.seq === 700))
  assert.ok(!whilePrepared.read(session.id)!.windows[0]!.page.entries.some(entry => entry.event.seq === 120))
  whilePrepared.dispose()
  feed.publication!.discard(proposal.version); cache.flush()
  const afterDiscard = new SourceReadingCache(access)
  assert.equal(afterDiscard.readPosition(session.id, 'pane')?.anchorKey, 'message-700')
  assert.ok(afterDiscard.read(session.id)!.windows[0]!.page.entries.some(entry => entry.event.seq === 700))
  afterDiscard.dispose()
})

test('a delayed latest page preserves newer accepted tail content in the durable checkpoint', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'owner' }, cache = new SourceReadingCache(access)
  const gate = Promise.withResolvers<void>(), queue: SourceChanges[] = [], listeners = new Set<() => void>()
  const head = page({ sessionId: session.id }), extra: SourcePage['entries'] = []
  let version = 1, hold = false
  const owner = new RemoteSourceHistory(session.id, {
    async read(request) {
      const current = { ...page(request), version }
      const snapshot = request.around === undefined ? { ...current, entries: [...head.entries, ...extra], after: 799 + extra.length } : current
      if (hold && request.around === undefined) { hold = false; await gate.promise }
      return snapshot
    },
    async *changes(_request, signal) {
      while (!signal?.aborted) {
        const change = queue.shift()
        if (change) { yield change; continue }
        await new Promise<void>(resolve => {
          const wake = (): void => { listeners.delete(wake); signal?.removeEventListener('abort', wake); resolve() }
          listeners.add(wake); signal?.addEventListener('abort', wake, { once: true })
          if (signal?.aborted) wake()
        })
      }
    },
  }, undefined, cache)
  t.after(() => { owner.dispose(); cache.dispose() })
  const feed = await owner.openView('pane', budget)
  const earlier = await feed.read({ kind: 'around', target: { key: 'message-120', seq: 120 as never } }, budget, new AbortController().signal)
  feed.publication!.accept(earlier.version)
  let cursor = earlier.version
  const append = async (seq: number): Promise<void> => {
    const abort = new AbortController(), iterator = feed.changes(cursor, abort.signal)[Symbol.asyncIterator](), next = iterator.next()
    const entry = { ...head.entries[0]!, event: { ...head.entries[0]!.event, seq } } as SourcePage['entries'][number]
    extra.push(entry); queue.push({ session, epoch: head.epoch, base: version, version: ++version, reset: false, upserts: [entry], removed: [] })
    for (const wake of [...listeners]) wake()
    try {
      const value = await next
      assert.ok(!value.done); cursor = value.value.version
      feed.publication!.accept(cursor)
    } finally { abort.abort(); await iterator.return?.() }
  }
  await append(800)
  hold = true
  const pending = feed.read({ kind: 'latest' }, budget, new AbortController().signal)
  await append(801); gate.resolve()
  const latest = await pending
  assert.ok(latest.entries.some(entry => entry.event.seq === 801), 'an older tail response cannot hide an already accepted append')
  feed.publication!.accept(latest.version); cache.flush()
  const reopened = new SourceReadingCache(access)
  assert.equal(reopened.read(session.id)?.version, 3)
  assert.ok(reopened.read(session.id)?.head.entries.some(entry => entry.event.seq === 801))
  assert.ok(reopened.read(session.id)?.windows[0]?.page.entries.some(entry => entry.event.seq === 801))
  reopened.dispose()
})

test('an accepted epoch reset removes the old durable body before its replacement can load', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'owner' }, cache = new SourceReadingCache(access)
  const reset = Promise.withResolvers<SourceChanges>(), observed = Promise.withResolvers<void>()
  let reads = 0
  const owner = new RemoteSourceHistory(session.id, {
    read: async (request, signal) => {
      if (++reads === 1) return page(request)
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
      throw new Error('The replacement is intentionally unavailable')
    },
    async *changes(request, signal) { yield await reset.promise; yield* idle(request, signal) },
  }, undefined, cache)
  t.after(() => { owner.dispose(); cache.dispose() })
  owner.subscribeSession(metadata => { if (metadata.title === 'Rewritten') observed.resolve() })
  const feed = await owner.openView('pane', budget)
  feed.publication!.accept(feed.initial.version); cache.flush()
  reset.resolve({ session: { ...session, title: 'Rewritten' }, epoch: 'replacement', version: 1, base: 0, reset: true, upserts: [], removed: [] })
  await observed.promise
  const reloaded = new SourceReadingCache(access)
  assert.equal(reloaded.read(session.id), undefined, 'the source has explicitly invalidated this epoch, even while recovery is offline')
  reloaded.dispose()
})

test('an explicit source access denial clears durable body and late reader release cannot restore it', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'owner' }, cache = new SourceReadingCache(access)
  let reads = 0
  const owner = new RemoteSourceHistory(session.id, { read: async request => {
    if (++reads === 1) return page(request)
    throw new SourceError('UNSUPPORTED', 'Access to this source resource was not granted.')
  }, changes: idle }, undefined, cache)
  t.after(() => { owner.dispose(); cache.dispose() })
  const feed = await owner.openView('pane', budget)
  feed.publication!.accept(feed.initial.version); cache.flush()
  await assert.rejects(feed.read({ kind: 'around', target: { key: 'message-120', seq: 120 as never } }, budget, new AbortController().signal), { code: 'UNSUPPORTED' })
  feed.release(); cache.flush()
  const reloaded = new SourceReadingCache(access)
  assert.equal(reloaded.read(session.id), undefined)
  reloaded.dispose()
})

test('account and Host scopes cannot read each other and explicit cache removal revokes saved body', () => {
  const storage = new BrowserStorage(), a = new SourceReadingCache({ storage, scope: 'host-a-user-a' }), b = new SourceReadingCache({ storage, scope: 'host-a-user-b' })
  try {
    const head = page({ sessionId: session.id })
    a.write({ session, epoch: head.epoch, version: head.version, head, windows: [] }); a.flush()
    assert.equal(b.read(session.id), undefined); assert.deepEqual(b.sessions(), [])
    a.remove(session.id)
    assert.equal(a.read(session.id), undefined)
    const reopened = new SourceReadingCache({ storage, scope: 'host-a-user-a' })
    assert.deepEqual(reopened.sessions(), []); reopened.dispose()
  } finally { a.dispose(); b.dispose() }
})

test('bounded read-cache eviction preserves drafts and pending operations', () => {
  const storage = new BrowserStorage(), cache = new SourceReadingCache({ storage, scope: 'owner' })
  storage.setItem('hhpi:outbox:owner:operation', 'must remain')
  try {
    for (let native = 0; native < 12; ++native) {
      const metadata = { ...session, nativeId: `thread-${native}`, id: `hhpi:machine:source:codex:thread-${native}` }
      const head = page({ sessionId: metadata.id }, metadata)
      cache.write({ session: metadata, epoch: head.epoch, version: head.version, head, windows: [] }); cache.flush()
    }
    assert.equal(cache.sessions().length, 8)
    assert.equal(storage.getItem('hhpi:outbox:owner:operation'), 'must remain')
    assert.ok([...storage.values.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0) < 4 * 1024 * 1024)
  } finally { cache.dispose() }
})

test('browser quota failures never make a live reader fail or erase operation storage', async t => {
  const storage = new BrowserStorage()
  storage.setItem('hhpi:outbox:owner:operation', 'must remain')
  storage.setItem = (key, value) => {
    if (key.startsWith('hhpi:reading:')) throw new DOMException('Synthetic full storage', 'QuotaExceededError')
    storage.values.set(key, value)
  }
  const cache = new SourceReadingCache({ storage, scope: 'owner' })
  const owner = new RemoteSourceHistory(session.id, { read: async request => page(request), changes: idle }, undefined, cache)
  t.after(() => { owner.dispose(); cache.dispose() })
  const feed = await owner.openView('pane', budget)
  feed.publication!.accept(feed.initial.version)
  assert.doesNotThrow(() => cache.flush())
  assert.ok(feed.initial.entries.some(entry => entry.event.seq === 799))
  assert.equal(storage.getItem('hhpi:outbox:owner:operation'), 'must remain')
})

test('a corrupted or cross-source snapshot is discarded before it can enter a reading window', () => {
  const storage = new BrowserStorage(), access = { storage, scope: 'owner' }, cache = new SourceReadingCache(access)
  const head = page({ sessionId: session.id })
  cache.write({ session, epoch: head.epoch, version: head.version, head, windows: [] }); cache.flush(); cache.dispose()
  const key = [...storage.values.keys()].find(key => key.endsWith(session.id))!
  const saved = JSON.parse(storage.getItem(key)!)
  saved.head.session = { ...saved.session, id: 'hhpi:another:source:codex:thread' }
  storage.setItem(key, JSON.stringify(saved))
  const reopened = new SourceReadingCache(access)
  try { assert.equal(reopened.read(session.id), undefined); assert.equal(storage.getItem(key), null) }
  finally { reopened.dispose() }
})

test('oversized checkpoints use complete source dependency pages and preserve a prior valid checkpoint', () => {
  const storage = new BrowserStorage(), access = { storage, scope: 'owner' }, cache = new SourceReadingCache(access)
  try {
    const head = page({ sessionId: session.id })
    cache.write({ session, epoch: head.epoch, version: head.version, head, windows: [] }); cache.flush()
    const huge = { ...head, entries: [...head.entries, { type: 'event', event: { type: 'tool/output', seq: 800, time: 1, data: { output: 'x'.repeat(2 * 1024 * 1024) } } }] } as SourcePage
    cache.write({ session, epoch: huge.epoch, version: huge.version, head: huge, windows: [] }); cache.flush()
    const retained = new SourceReadingCache(access)
    assert.deepEqual(retained.read(session.id)?.head, head, 'an over-budget live turn cannot erase the last complete checkpoint')
    retained.dispose()
    const dependency = { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } } as SourcePage['entries'][number]
    const safe = { ...head, entries: [dependency, ...head.entries], context: [1] }
    cache.write({ session, epoch: head.epoch, version: head.version, head: huge, windows: [{ viewId: 'pane', page: huge }], pages: [safe] })
    cache.writePosition(session.id, 'pane', { anchorKey: 'message-700', anchorTop: 4, scrollTop: 700 }, 700); cache.flush()
    const compacted = new SourceReadingCache(access)
    assert.deepEqual(compacted.read(session.id)!.windows[0]!.page, safe, 'capacity trimming must retain the source-declared turn dependency')
    compacted.dispose()
    cache.write({ session, epoch: 'replacement', version: 1, head: { ...huge, epoch: 'replacement' }, windows: [] }); cache.flush()
    const rewritten = new SourceReadingCache(access)
    assert.equal(rewritten.read(session.id), undefined, 'a replaced epoch cannot use the oversized fallback to retain obsolete body')
    rewritten.dispose()
  } finally { cache.dispose() }
})


test('persistent Pane windows share one body table and sidebar bootstrap reads metadata only', () => {
  const storage = new BrowserStorage(), access = { storage, scope: 'owner-deduplicated' }, cache = new SourceReadingCache(access)
  const head = page({ sessionId: session.id })
  head.entries = [{ type: 'event', event: { type: 'tool/output', seq: 700, time: 1, data: { output: 'x'.repeat(600_000) } } }] as SourcePage['entries']
  cache.write({ session, epoch: head.epoch, version: head.version, head, windows: [{ viewId: 'left', page: head }, { viewId: 'right', page: head }] })
  cache.writePosition(session.id, 'left', { anchorKey: '700', anchorTop: 12, scrollTop: 600 }, 700)
  cache.flush(); cache.dispose()
  const bodyKey = [...storage.values.keys()].find(key => key.endsWith(session.id))!
  const packed = JSON.parse(storage.values.get(bodyKey)!)
  assert.equal(packed.entries.length, 1)
  assert.ok(Buffer.byteLength(storage.values.get(bodyKey)!) < 650_000, 'multiple Pane references do not consume the body budget again')
  const reads: string[] = [], get = storage.getItem.bind(storage)
  storage.getItem = key => { reads.push(key); return get(key) }
  const restored = new SourceReadingCache(access)
  try {
    assert.equal(restored.sessions()[0]?.id, session.id)
    assert.ok(!reads.includes(bodyKey), 'sidebar startup must not parse all retained transcripts')
    assert.equal(restored.read(session.id)?.windows.length, 2)
    assert.equal(restored.readPosition(session.id, 'left')?.anchorTop, 12)
  } finally { restored.dispose() }
})


test('repeated source metadata keeps conversation snapshots stable while real controls and titles update', async t => {
  const history = new RemoteSourceHistory(session.id, { read: async request => page(request), changes: idle })
  const face = new SourceSessionFace(session.id as SessionId, session, history, {} as HhpiRemoteApi)
  t.after(() => { face.dispose(); history.dispose() })
  await face.ready
  const title = face.projections.faceOf('title'), source = face.projections.faceOf('hhpiSource')
  assert.equal(title.getSnapshot(), session.title, 'initial metadata must initialize projections')
  assert.equal(source.getSnapshot(), face.metadata.getSnapshot())
  const before = { metadata: face.metadata.getSnapshot(), state: face.getSnapshot(), source: source.getSnapshot() }
  const notifications = { metadata: 0, state: 0, title: 0, source: 0 }
  face.metadata.subscribe(() => ++notifications.metadata)
  face.subscribe(() => ++notifications.state)
  title.subscribe(() => ++notifications.title)
  source.subscribe(() => ++notifications.source)
  for (let repeat = 0; repeat < 6; ++repeat) face.update(structuredClone(session))
  assert.deepEqual(notifications, { metadata: 0, state: 0, title: 0, source: 0 })
  assert.equal(face.metadata.getSnapshot(), before.metadata)
  assert.equal(face.getSnapshot(), before.state)
  assert.equal(source.getSnapshot(), before.source)
  const changed = { ...session, title: 'Renamed source', capabilities: { ...session.capabilities, send: false } }
  face.update(changed)
  assert.equal(title.getSnapshot(), changed.title)
  assert.equal(face.metadata.getSnapshot().capabilities.send, false, 'write capability changes cannot be hidden by metadata deduplication')
  assert.deepEqual(notifications, { metadata: 1, state: 0, title: 1, source: 1 })
  face.update({ ...changed, status: 'running', activeTurnId: 'turn-active' })
  assert.equal(face.getSnapshot().running, true)
  face.update({ ...changed, status: 'offline' })
  assert.equal(face.getSnapshot().running, true, 'disconnect cannot erase the last known native running state')
  face.update(changed)
  assert.equal(face.getSnapshot().running, false)
  assert.equal(notifications.state, 2)
  assert.throws(() => face.update({ ...changed, id: 'hhpi:machine:source:codex:other' }), /crossed session identities/)
})
