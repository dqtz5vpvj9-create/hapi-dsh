/** Catalog wire objects are fresh; unchanged source rows must not invalidate readers/sidebar. */
import assert from 'node:assert/strict'
import { before, test, type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { RemoteSessions } from '../src/client/remote-sessions.ts'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..')
let Sessions: typeof RemoteSessions
before(async () => {
  const output = await build({ entryPoints: [resolve(root, 'src/client/remote-sessions.ts')],
    alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
    external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} as { RemoteSessions: typeof RemoteSessions } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
  Sessions = module.exports.RemoteSessions
})
function source(nativeId: string): SourceSession {
  const identity = { machineId: 'catalog-machine', sourceId: 'native', engine: 'codex', nativeId }
  return { ...identity, id: sourceSessionId(identity), title: nativeId, cwd: '/workspace', updatedAt: 1, status: 'idle',
    activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: false, files: false } }
}
async function fixture(t: TestContext, initial: SourceSession[], readable = false) {
  const ctx = new Context(), empty = { ids: [], byId: {}, phase: 'ready' as const, projectionsBySession: {} }
  let values = initial, ordinaryRefreshes = 0, online: boolean | undefined
  const original = { list: { getSnapshot: () => empty, subscribe: () => () => {} }, windowCommit: {},
    refresh: async () => { ordinaryRefreshes++ }, retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => {} }) } as unknown as ISessions
  const unused = async (): Promise<never> => { throw new Error('Catalog publication cannot execute or read native history.') }
  const api: HhpiRemoteApi = { catalog: async () => ({ ok: true, value: { protocol: 1, legacyHapi: false,
    sources: online === undefined ? [] : [{ id: 'native', machineId: 'catalog-machine', engine: 'codex', online, create: true }], sessions: structuredClone(values) } }),
    read: readable ? async request => ({ ok: true, value: { session: values.find(session => session.id === request.sessionId)!, epoch: 'retention-epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] } }) : unused,
    changes: () => { throw new Error('Catalog publication cannot subscribe to native history.') }, operate: unused, create: unused, resource: unused }
  const sessions = new Sessions(ctx, original, api)
  t.after(async () => { sessions.dispose(); await ctx.fiber.dispose() })
  await sessions.refresh()
  return { sessions, refreshes: () => ordinaryRefreshes, advertise: (next: SourceSession[]) => { values = next }, connection: (value: boolean | undefined) => { online = value } }
}

test('only a successful online native directory omission retires membership, keeping exact metadata and retained readers', async t => {
  const a = source('expired'), b = source('retained'), f = await fixture(t, [a, b], true)
  const ref = f.sessions.retain(b.id as SessionId, { source: 'hapiWorkspace' }); await ref.ready
  f.advertise([])
  await f.sessions.refresh()
  assert.ok(f.sessions.list.getSnapshot().ids.includes(a.id as SessionId), 'unknown source directory is not deletion authority')
  f.connection(false); await f.sessions.refresh()
  assert.ok(f.sessions.list.getSnapshot().ids.includes(a.id as SessionId), 'offline source directory retains last-known membership')
  f.connection(true); await f.sessions.refresh()
  const next = f.sessions.list.getSnapshot()
  assert.ok(!next.ids.includes(a.id as SessionId))
  assert.ok(next.byId[a.id as SessionId], 'saved exact links and histories remain addressable')
  assert.ok(next.ids.includes(b.id as SessionId), 'an existing input/reader keeps its original row')
  ref.release()
  assert.ok(!f.sessions.list.getSnapshot().ids.includes(b.id as SessionId))
})

test('equal fresh-wire catalog refreshes retain the public snapshot and emit no list update', async t => {
  const a = source('a'), b = source('b'), f = await fixture(t, [a, b])
  const before = f.sessions.list.getSnapshot(), refreshes = f.refreshes()
  let updates = 0, capabilityUpdates = 0
  const stop = f.sessions.list.subscribe(() => { updates++ }); t.after(stop)
  t.after(f.sessions.capabilities.subscribe(() => { capabilityUpdates++ }))
  await f.sessions.refresh()
  assert.equal(f.refreshes(), refreshes + 1, 'ordinary DSH refresh still runs')
  assert.equal(updates, 0, 'five-second polls cannot invalidate the whole source sidebar without a state change')
  assert.equal(capabilityUpdates, 0)
  assert.equal(f.sessions.list.getSnapshot(), before)
})

test('one changed source preserves unrelated row/projection identity and refreshes dependent parent lineage', async t => {
  const parent = source('parent'), peer = source('peer')
  const child = { ...source('child'), codex: { model: null, reasoningEffort: null, parentThreadId: parent.nativeId, agentNickname: 'Random nickname' } }
  const f = await fixture(t, [parent, child, peer]), before = f.sessions.list.getSnapshot()
  const id = (value: SourceSession) => value.id as typeof before.ids[number]
  f.advertise([parent, { ...child, title: 'Renamed child' }, peer])
  let updates = 0
  const stop = f.sessions.list.subscribe(() => { updates++ }); t.after(stop)
  await f.sessions.refresh()
  const after = f.sessions.list.getSnapshot()
  assert.equal(updates, 1)
  assert.equal(after.byId[id(peer)], before.byId[id(peer)], 'unrelated source row remains the same external-store value')
  assert.equal(after.projectionsBySession[id(peer)], before.projectionsBySession[id(peer)])
  assert.notEqual(after.byId[id(child)], before.byId[id(child)])
  assert.equal(after.byId[id(child)]?.title, 'Renamed child')
  assert.notEqual(after.byId[id(parent)], before.byId[id(parent)], 'derived lineage must follow the actual child change')
  assert.equal(after.byId[id(parent)]?.projectionValues?.subagentCatalog?.[0]?.label, 'Renamed child')
})

test('ordinary rows stay ready while the first native catalog is pending', async t => {
  const ctx = new Context(), id = 'ordinary-session' as SessionId, row = { id, title: 'Ordinary source', running: false,
    retainedBy: {}, blank: false, updatedAt: 1 }, originalSnapshot = { ids: [id], byId: { [id]: row }, phase: 'ready' as const, projectionsBySession: {} }
  const pending = Promise.withResolvers<Awaited<ReturnType<HhpiRemoteApi['catalog']>>>()
  const unused = async (): Promise<never> => { throw new Error('Only directory discovery is authorized by this fixture.') }
  const original = { list: { getSnapshot: () => originalSnapshot, subscribe: () => () => {} }, windowCommit: {},
    refresh: async () => {}, retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => {} }) } as unknown as ISessions
  const api: HhpiRemoteApi = { catalog: () => pending.promise, read: unused, changes: () => { throw new Error('No history is read.') }, operate: unused, create: unused, resource: unused }
  const sessions = new Sessions(ctx, original, api)
  t.after(async () => { pending.resolve({ ok: true, value: { protocol: 1, legacyHapi: false, sessions: [], sources: [] } }); sessions.dispose(); await ctx.fiber.dispose() })
  assert.equal(sessions.capabilities.getSnapshot().catalogReady, false)
  assert.equal(sessions.list.getSnapshot().phase, 'ready')
  assert.equal(sessions.list.getSnapshot().byId[id], row)
})


test('retaining one source updates only its lease row while real lineage and source changes still publish', async t => {
  const parent = source('parent'), nextParent = source('next-parent'), peer = source('peer')
  const child = { ...source('child'), codex: { model: null, reasoningEffort: null, parentThreadId: parent.nativeId } }
  const f = await fixture(t, [parent, nextParent, child, peer], true), id = parent.id as SessionId
  const before = f.sessions.list.getSnapshot(), peerRow = before.byId[peer.id as SessionId]!
  // Observe accesses to a valid metadata field, without timing thresholds or
  // replacing the real catalog/lease owner. A lease has no reason to revisit it.
  const peerFacts = peerRow.projectionValues!.hhpiSource as SourceSession
  let unrelatedReads = 0
  Object.defineProperty(peerFacts, 'title', { configurable: true, enumerable: true, get() { unrelatedReads++; return peer.title } })
  const first = f.sessions.retain(id, { source: 'hapiWorkspace' }); t.after(() => first.release())
  await first.ready
  assert.equal(f.sessions.list.getSnapshot().byId[id]!.retainedBy.hapiWorkspace, 1)
  const second = f.sessions.retain(id, { source: 'hapiWorkspace' }); t.after(() => second.release())
  await second.ready
  assert.equal(f.sessions.list.getSnapshot().byId[id]!.retainedBy.hapiWorkspace, 2)
  second.release()
  assert.equal(f.sessions.list.getSnapshot().byId[id]!.retainedBy.hapiWorkspace, 1)
  first.release()
  const after = f.sessions.list.getSnapshot()
  assert.deepEqual(after.byId[id]!.retainedBy, {})
  assert.equal(unrelatedReads, 0, 'retain/release must not scan or serialize unrelated source metadata')
  assert.equal(after.byId[peer.id as SessionId], peerRow)
  assert.equal(after.projectionsBySession, before.projectionsBySession)
  assert.equal(after.ids, before.ids)
  assert.equal(after.byId[id]!.projectionValues, before.byId[id]!.projectionValues)

  f.advertise([parent, nextParent, { ...child, title: 'Moved child', codex: { ...child.codex, parentThreadId: nextParent.nativeId } }, { ...peer, status: 'offline', capabilities: { ...peer.capabilities, send: false } }])
  await f.sessions.refresh()
  const changed = f.sessions.list.getSnapshot()
  assert.deepEqual(changed.byId[id]!.projectionValues!.subagentCatalog, [])
  assert.equal(changed.byId[nextParent.id as SessionId]!.projectionValues!.subagentCatalog![0]!.label, 'Moved child')
  assert.equal(changed.byId[child.id as SessionId]!.parentId, nextParent.id)
  assert.equal(changed.byId[peer.id as SessionId]!.projectionValues!.hhpiSource!.status, 'offline')
  assert.equal(changed.byId[peer.id as SessionId]!.projectionValues!.hhpiSource!.capabilities.send, false)
})
