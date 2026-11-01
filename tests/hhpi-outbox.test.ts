/** Production outbox and public Session lifetime; only durable storage and RPC are controlled. */
import assert from 'node:assert/strict'
import { before, test, type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteOutbox, type SourceDeliveryStore } from '../src/client/remote-outbox.ts'
import { clearSourceStorage } from '../src/client/remote-storage.ts'
import type { RemoteSessions, RemoteSourceSession } from '../src/client/remote-sessions.ts'
import type { SourceEntry, SourceOperation, SourceReceipt, SourceSession } from '../src/remote/protocol.ts'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'

const metadata: SourceSession = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread',
  title: 'Synthetic queued source', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [],
  capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
const operation = (id: string, text = id): SourceOperation => ({ sessionId: metadata.id, operationId: id, kind: 'send', text })
const accepted = (request: SourceOperation): SourceReceipt => ({ sessionId: request.sessionId, operationId: request.operationId, status: 'accepted', message: 'Accepted by the synthetic source' })
function when(view: SourceDeliveryStore, match: () => boolean): Promise<void> {
  if (match()) return Promise.resolve()
  return new Promise(resolve => { const stop = view.subscribe(() => { if (match()) { stop(); resolve() } }) })
}
function history(id: string): SourceEntry[] {
  return [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { id: 'native-message', role: 'user',
    source: { kind: 'user-rpc', rpcId: id }, content: [{ type: 'text', text: 'Saved text' }] } } }] as SourceEntry[]
}

test('offline text is durably admitted before returning and survives reload with its original identity', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), calls: SourceOperation[] = [], access = { storage, scope: 'account-host' }
  const send = async (request: SourceOperation): Promise<SourceReceipt> => { calls.push(request); return accepted(request) }
  const first = new RemoteOutbox(send); first.setStorage(access)
  first.enqueue(operation('immutable', 'Saved text')); first.start('immutable')
  assert.equal(storage.length, 1, 'the synchronous admission already wrote durable storage')
  assert.equal(calls.length, 0, 'cached/offline metadata never authorizes a native write')
  first.dispose()
  const next = new RemoteOutbox(send); t.after(() => next.dispose()); next.setStorage(access)
  const view = next.view(metadata.id)
  assert.equal(view.getSnapshot()[0]!.operation.text, 'Saved text')
  next.acceptCatalog([metadata])
  await when(view, () => view.getSnapshot()[0]?.state === 'accepted')
  assert.equal(calls.length, 1); assert.equal(calls[0]!.operationId, 'immutable')
  assert.equal(view.getSnapshot().length, 1, 'RPC acceptance does not erase an unobserved transcript echo')
  next.observe('hhpi:other:source:codex:thread', history('immutable'))
  assert.equal(view.getSnapshot().length, 1, 'another source cannot acknowledge this message')
  next.observe(metadata.id, history('immutable'))
  assert.equal(view.getSnapshot().length, 0); assert.equal(storage.length, 0)
})

test('per-session FIFO blocks a second message until the first acknowledgement, including lost-ACK reload', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'account-host' }, calls: SourceOperation[] = []
  const lost = Promise.withResolvers<SourceReceipt>()
  const first = new RemoteOutbox(request => { calls.push(request); return lost.promise }); first.setStorage(access)
  first.enqueue(operation('first')); first.enqueue(operation('second')); first.start('first'); first.start('second'); first.acceptCatalog([metadata])
  assert.deepEqual(calls.map(value => value.operationId), ['first'])
  first.dispose()
  const confirmed = Promise.withResolvers<SourceReceipt>()
  const next = new RemoteOutbox(request => { calls.push(request); return request.operationId === 'first' ? confirmed.promise : Promise.resolve(accepted(request)) })
  t.after(() => { next.dispose(); lost.resolve(accepted(operation('first'))) }); next.setStorage(access)
  next.acceptCatalog([metadata])
  assert.deepEqual(calls.map(value => value.operationId), ['first', 'first'], 'reload queries the same operation; it cannot invent a replacement ID')
  confirmed.resolve(accepted(operation('first')))
  const view = next.view(metadata.id)
  await when(view, () => view.getSnapshot().every(value => value.state === 'accepted'))
  assert.deepEqual(calls.map(value => value.operationId), ['first', 'first', 'second'])
  assert.equal(view.getSnapshot().length, 2, 'both echoes wait for their actual native user messages')
})

test('quota failure rejects admission; account changes and explicit revocation cannot replay another account queue', async t => {
  const storage = new BrowserStorage(), writes: SourceOperation[] = []
  const outbox = new RemoteOutbox(async request => { writes.push(request); return accepted(request) }); t.after(() => outbox.dispose())
  outbox.setStorage({ storage, scope: 'owner-a' }); storage.failWrites = true
  assert.throws(() => outbox.enqueue(operation('not-saved')), /draft has been kept/)
  assert.equal(outbox.view(metadata.id).getSnapshot().length, 0)
  storage.failWrites = false; outbox.enqueue(operation('owner-a-message'))
  outbox.setStorage({ storage, scope: 'owner-b' }); outbox.acceptCatalog([metadata])
  assert.equal(outbox.view(metadata.id).getSnapshot().length, 0); assert.equal(writes.length, 0)
  storage.setItem('official-composer-draft', 'keep this unsubmitted draft')
  clearSourceStorage(storage)
  assert.equal(storage.getItem('official-composer-draft'), 'keep this unsubmitted draft')
  outbox.setStorage({ storage, scope: 'owner-a' }); outbox.acceptCatalog([metadata])
  assert.equal(outbox.view(metadata.id).getSnapshot().length, 0); assert.equal(writes.length, 0)
})

test('an explicit permission rejection stays visible without automatic retry or a replacement operation', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), calls: SourceOperation[] = []
  const outbox = new RemoteOutbox(async request => { calls.push(request); throw Object.assign(new Error('Synthetic access denied'), { code: 'remote-access/denied' }) })
  t.after(() => outbox.dispose()); outbox.setStorage({ storage, scope: 'account-host' })
  outbox.enqueue(operation('denied')); outbox.start('denied'); outbox.acceptCatalog([metadata])
  const view = outbox.view(metadata.id)
  await when(view, () => view.getSnapshot()[0]?.state === 'rejected')
  outbox.acceptCatalog([metadata]); outbox.start('denied')
  assert.equal(calls.length, 1); assert.match(view.getSnapshot()[0]!.message, /access denied/)
  assert.equal(storage.length, 1)
})

test('the pinned HTTP authentication failure pauses recovery until a new authenticated catalog', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(); let calls = 0
  const outbox = new RemoteOutbox(async request => {
    calls++
    if (calls === 1) throw Object.assign(new Error('client api: hhpi/operate failed: request returned HTTP 401'), { code: 'gateway/internal' })
    return accepted(request)
  })
  t.after(() => outbox.dispose()); outbox.setStorage({ storage, scope: 'account-host' })
  outbox.enqueue(operation('auth-recovery')); outbox.start('auth-recovery'); outbox.acceptCatalog([metadata])
  const view = outbox.view(metadata.id)
  await when(view, () => view.getSnapshot()[0]?.state === 'confirming')
  assert.match(view.getSnapshot()[0]!.message, /authenticated access/)
  outbox.start('auth-recovery'); assert.equal(calls, 1, 'a failed authentication cannot be retried as ordinary weak-network loss')
  outbox.acceptCatalog([metadata])
  await when(view, () => view.getSnapshot()[0]?.state === 'accepted')
  assert.equal(calls, 2); assert.equal(view.getSnapshot()[0]!.operation.operationId, 'auth-recovery')
})

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..')
let Sessions: typeof RemoteSessions
before(async () => {
  const output = await build({ entryPoints: [resolve(root, 'src/client/remote-sessions.ts')],
    alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-gateway/client'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} as { RemoteSessions: typeof RemoteSessions } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
  Sessions = module.exports.RemoteSessions
})

test('public source Session accepts locally while offline, preserves quota-failed drafts, and completes delivery after its Pane closes', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), ctx = new Context(), writes: SourceOperation[] = []
  let current = { ...metadata, status: 'offline' as SourceSession['status'] }
  const receipt = Promise.withResolvers<SourceReceipt>(), called = Promise.withResolvers<void>()
  const api = { catalog: async () => ({ ok: true, value: { protocol: 1, storageScope: 'account-host', legacyHapi: false, sources: [], sessions: [current] } }),
    read: async () => ({ ok: true, value: { session: current, epoch: 'epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] } }),
    operate: async (request: SourceOperation) => { writes.push(request); called.resolve(); return { ok: true, value: await receipt.promise } } } as unknown as HhpiRemoteApi
  const original = { list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }), subscribe: () => () => {} },
    refresh: async () => {}, windowCommit: {}, retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => {} }) } as unknown as ISessions
  const sessions = new Sessions(ctx, original, api, { storage, scope: 'account-host' })
  t.after(async () => { sessions.dispose(); await ctx.fiber.dispose() })
  await sessions.refresh()
  const reference = sessions.retain(metadata.id as SessionId, { source: 'hapiWorkspace' }); await reference.ready
  const face = reference.binding.session as RemoteSourceSession, retired: string[] = []
  storage.failWrites = true
  assert.throws(() => face.beginSubmission({ mode: 'queue', text: 'Keep the draft', attachments: [] }), /draft has been kept/)
  assert.equal(face.getSnapshot().pendingSubmissions.length, 0)
  storage.failWrites = false
  const pending = face.beginSubmission({ mode: 'queue', text: 'Saved text', attachments: [], onRetire: value => { retired.push(value.reason) } })
  assert.ok([...Array(storage.length).keys()].some(index => storage.key(index)?.startsWith('hhpi:outbox:')), 'beginSubmission has synchronously persisted the clicked text')
  const paneLifetime = new AbortController()
  // Official Conversation yields nextPaint between beginSubmission and prompt.
  // Closing the view during that yield aborts its input lifetime, not the saved intent.
  paneLifetime.abort(); reference.release()
  assert.equal((await face.prompt([{ type: 'text', text: 'Saved text' }], 'queue', paneLifetime.signal, pending.requestId)).ok, true)
  assert.equal(writes.length, 0)
  reference.release(); assert.deepEqual(retired, [], 'closing a Pane does not fail an admitted message or resurrect its draft')
  current = metadata; await sessions.refresh(); await called.promise
  receipt.resolve(accepted(writes[0]!))
  const probe = new RemoteOutbox(async request => accepted(request)); t.after(() => probe.dispose())
  probe.setStorage({ storage, scope: 'account-host' })
  assert.equal(probe.view(metadata.id).getSnapshot()[0]!.operation.operationId, pending.requestId)
  assert.equal(writes.length, 1)
})
