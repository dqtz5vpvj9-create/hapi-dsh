/** Production source index, history, Session faces and RemoteStream. Only the
 * catalog/operation RPC boundary is controlled; no UI or native engine runs. */
import assert from 'node:assert/strict'
import { before, test, type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { RemoteSessions, RemoteSourceSession } from '../src/client/remote-sessions.ts'
import { SourceEventIndex } from '../src/remote/event-index.ts'
import { sourceSessionId, type SourceOperation, type SourceSession } from '../src/remote/protocol.ts'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..')
const { RemoteStream } = require('@deepseek-ai/dsh-api-gateway/client') as typeof import('@deepseek-ai/dsh-api-gateway/client')
let Sessions: typeof RemoteSessions
before(async () => {
  const output = await build({ entryPoints: [resolve(root, 'src/client/remote-sessions.ts')],
    alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-gateway/client'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} as { RemoteSessions: typeof RemoteSessions } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
  Sessions = module.exports.RemoteSessions
})

function store<T>(value: T) {
  return { getSnapshot: () => value, subscribe: (_listener: () => void) => () => {} }
}
function metadata(nativeId = 'thread', send = false): SourceSession {
  const identity = { machineId: 'synthetic-machine', sourceId: 'native-source', engine: 'codex', nativeId }
  return { ...identity, id: sourceSessionId(identity), title: `Synthetic ${nativeId}`, cwd: '/synthetic', updatedAt: 1000,
    status: 'idle', activeTurnId: null, capabilities: { send, steer: send, cancel: send, approve: false, files: false }, pendingRequests: [] }
}

async function fixture(t: TestContext, initial = metadata()) {
  const peer = metadata('other-thread', true), ctx = new Context(), index = new SourceEventIndex(':memory:', initial)
  const writes: SourceOperation[] = [], references: SessionReference[] = []
  const pendingCatalogs = new Set<ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<HhpiRemoteApi['catalog']>>>>>()
  let advertised = [initial, peer], nextCatalog: Promise<Awaited<ReturnType<HhpiRemoteApi['catalog']>>> | undefined
  const catalog = (sessions: SourceSession[]) => ({ ok: true as const, value: { protocol: 1 as const, legacyHapi: false, sessions, sources: [] } })
  const api: HhpiRemoteApi = {
    catalog: () => { const pending = nextCatalog; nextCatalog = undefined; return pending ?? Promise.resolve(catalog(advertised)) },
    read: async request => ({ ok: true, value: index.read(request) }),
    changes: (request, signal) => index.changes(request, signal),
    operate: async operation => { writes.push(operation); return { ok: true, value: { sessionId: operation.sessionId, operationId: operation.operationId, status: 'accepted', message: 'Synthetic source accepted.' } } },
    create: async () => { throw new Error('Creation is outside this capability regression') },
    resource: async () => { throw new Error('Resource reads are outside this capability regression') },
  }
  const original = { list: store({ ids: [], byId: {}, phase: 'ready' as const, projectionsBySession: {} }), windowCommit: {},
    searchResultLimit: 100, refresh: async () => {}, binding: () => undefined,
    retainInfo: () => store({ referenceCount: 0, retainedBy: {} }) } as unknown as ISessions
  ctx.reflect.provide('remote', { $stream: options => new RemoteStream({ generation: store({} as never) }, options) } as Context['remote'])
  const sessions = new Sessions(ctx, original, api)
  t.after(async () => {
    for (const reference of references.reverse()) reference.release()
    sessions.dispose()
    for (const pending of pendingCatalogs) pending.resolve(catalog([]))
    await ctx.fiber.dispose(); index.dispose()
  })
  await sessions.refresh()
  const retain = () => {
    const reference = sessions.retain(initial.id as SessionReference['sessionId'], { source: 'hapiWorkspace' })
    references.push(reference)
    return reference
  }
  const reference = retain()
  await reference.ready
  const face = reference.binding.session as RemoteSourceSession
  await face.historyRead.openView('capability-reader', { events: 20, bytes: 16_384, nodes: 20 })
  const row = (id = initial.id): SourceSession => sessions.list.getSnapshot().byId[id as SessionReference['sessionId']]!.projectionValues!.hhpiSource as SourceSession
  const holdCatalog = (values: SourceSession[]) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<HhpiRemoteApi['catalog']>>>()
    pendingCatalogs.add(pending); nextCatalog = pending.promise
    const refreshing = sessions.refresh()
    return { release: async () => { pending.resolve(catalog(values)); pendingCatalogs.delete(pending); await refreshing } }
  }
  const accept = async (value: SourceSession) => {
    const accepted = Promise.withResolvers<void>()
    const stop = face.metadata.subscribe(() => { if (face.metadata.getSnapshot().title === value.title) accepted.resolve() })
    try { index.edit(value, () => {}); await accepted.promise } finally { stop() }
  }
  return { sessions, face, reference, peer, writes, row, retain, holdCatalog, accept,
    advertise: (values: SourceSession[]) => { advertised = values } }
}

test('a late catalog cannot revoke a newer accepted send capability or replace its canonical row', { timeout: 5000 }, async t => {
  const initial = metadata(), f = await fixture(t, initial)
  const revokedPeer = { ...f.peer, capabilities: { ...f.peer.capabilities, send: false } }
  const pending = f.holdCatalog([initial, revokedPeer])
  const current = { ...initial, title: 'Accepted native owner', capabilities: { ...initial.capabilities, send: true } }
  await f.accept(current)
  await pending.release()
  assert.equal(f.face.metadata.getSnapshot().capabilities.send, true, 'a catalog started before accepted source metadata must not revoke its send capability')
  assert.deepEqual(f.row(), current, 'the canonical list must describe the same accepted native owner as the open face')
  assert.equal(f.row(f.peer.id).capabilities.send, false, 'an unrelated source still accepts this catalog response')
  const pendingSend = f.face.beginSubmission({ mode: 'queue', text: 'hello', attachments: [] })
  assert.equal((await f.face.prompt([{ type: 'text', text: 'hello' }], 'queue', undefined, pendingSend.requestId)).ok, true)
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0]!.operationId, pendingSend.requestId)
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 0)
  f.reference.release()
  const reopened = f.retain(); await reopened.ready
  assert.equal((reopened.binding.session as RemoteSourceSession).metadata.getSnapshot().capabilities.send, true, 'reopening must use the accepted canonical metadata')
  assert.equal(f.writes.length, 1, 'reopening never resends the accepted prompt')
})

test('a late catalog omission cannot mark a newly updated native source offline', { timeout: 5000 }, async t => {
  const initial = metadata(), f = await fixture(t, initial), pending = f.holdCatalog([f.peer])
  const current = { ...initial, title: 'Native source still present', capabilities: { ...initial.capabilities, send: true } }
  await f.accept(current); await pending.release()
  assert.equal(f.face.metadata.getSnapshot().status, 'idle', 'a stale absence cannot offline an accepted source update')
  assert.deepEqual(f.row(), current)
  assert.equal(f.writes.length, 0)
})

test('a late catalog cannot restore permission revoked by the accepted source', { timeout: 5000 }, async t => {
  const initial = metadata('thread', true), f = await fixture(t, initial), pending = f.holdCatalog([initial, f.peer])
  const revoked = { ...initial, title: 'Native owner released', capabilities: { ...initial.capabilities, send: false } }
  await f.accept(revoked); await pending.release()
  assert.equal(f.face.metadata.getSnapshot().capabilities.send, false, 'a stale catalog must not regrant revoked send permission')
  assert.deepEqual(f.row(), revoked)
  const retirement: string[] = []
  const submission = f.face.beginSubmission({ mode: 'queue', text: 'retained draft', attachments: [], onRetire: value => { retirement.push(value.reason) } })
  assert.equal((await f.face.prompt([{ type: 'text', text: 'retained draft' }], 'queue', undefined, submission.requestId)).ok, false)
  assert.deepEqual(retirement, ['failed'])
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 0)
  assert.equal(f.writes.length, 0)
})

test('a catalog requested after an accepted source update may change its capabilities at the same timestamp', { timeout: 5000 }, async t => {
  const initial = metadata(), f = await fixture(t, initial)
  const current = { ...initial, title: 'Newly loaded native owner', capabilities: { ...initial.capabilities, send: true } }
  await f.accept(current)
  assert.deepEqual(f.row(), current, 'accepted history metadata must publish to the canonical catalog without a poll')
  const revoked = { ...current, title: 'Owner no longer loaded', capabilities: { ...current.capabilities, send: false } }
  f.advertise([revoked, f.peer]); await f.sessions.refresh()
  assert.deepEqual(f.face.metadata.getSnapshot(), revoked)
  assert.deepEqual(f.row(), revoked)
  f.reference.release()
  const reopened = f.retain(); await reopened.ready
  assert.equal((reopened.binding.session as RemoteSourceSession).metadata.getSnapshot().capabilities.send, false, 'cached history replay cannot replace a subsequent catalog on a newly retained face')
  assert.deepEqual(f.row(), revoked)
  assert.equal(f.writes.length, 0)
})
