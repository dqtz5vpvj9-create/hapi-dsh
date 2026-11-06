import { sourceControlOperationId } from '../src/shared/source-operation-policy.ts'
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
import { RemoteOperationLedger } from '../src/client/remote-operation-ledger.ts'
import { clearSourceStorage } from '../src/client/remote-storage.ts'
import type { RemoteSessions, RemoteSourceSession } from '../src/client/remote-sessions.ts'
import type { SourceEntry, SourceOperation, SourceReadRequest, SourceReceipt, SourceSession } from '../src/remote/protocol.ts'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'

const metadata: SourceSession = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread',
  title: 'Synthetic queued source', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [],
  capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
const operation = (id: string, text = id): SourceOperation => ({ sessionId: metadata.id, operationId: id, kind: 'send', text })
const largeImage = (): NonNullable<SourceOperation['images']>[number] => ({ mediaType: 'image/png', data: Buffer.alloc(2 * 1024 * 1024).toString('base64') })
const accepted = (request: SourceOperation): SourceReceipt => ({ sessionId: request.sessionId, operationId: request.operationId, status: 'accepted', message: 'Accepted by the synthetic source' })
function when(view: SourceDeliveryStore, match: () => boolean): Promise<void> {
  if (match()) return Promise.resolve()
  return new Promise(resolve => { const stop = view.subscribe(() => { if (match()) { stop(); resolve() } }) })
}
function history(id: string): SourceEntry[] {
  return [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { id: 'native-message', role: 'user',
    source: { kind: 'user-rpc', rpcId: id }, content: [{ type: 'text', text: 'Saved text' }] } } }] as SourceEntry[]
}

test('a large image-only message survives reload through the transactional payload without filling the text journal', { timeout: 5000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'large-image' }, calls: SourceOperation[] = []
  const set = storage.setItem.bind(storage)
  storage.setItem = (key, value) => {
    if (value.length * 2 > 64 * 1024) throw new DOMException('Synthetic small localStorage quota', 'QuotaExceededError')
    set(key, value)
  }
  const image = largeImage(), request: SourceOperation = { ...operation('image-only', ''), images: [image] }
  const first = new RemoteOutbox(async value => { calls.push(value); return accepted(value) }); first.setStorage(access)
  await first.admit(request); first.start(request.operationId)
  const journal = storage.getItem(storage.key(0)!)!
  assert.ok(journal.length < 1000); assert.equal(journal.includes(image.data.slice(0, 100)), false)
  assert.equal((await new RemoteOperationLedger(access).read(request.operationId))?.includes(image.data), true)
  first.enqueue(operation('following-text')); first.start('following-text'); first.dispose()
  const next = new RemoteOutbox(async value => { calls.push(value); return accepted(value) }); t.after(() => next.dispose())
  next.setStorage(access); next.acceptCatalog([{ ...metadata, capabilities: { ...metadata.capabilities, images: true } }])
  await when(next.view(metadata.id), () => next.get('following-text')?.state === 'accepted')
  assert.deepEqual(calls.map(value => value.operationId), ['image-only', 'following-text'], 'later text waits for the earlier image payload to restore')
  assert.deepEqual(calls[0]!.images, [image]); assert.equal(next.get('image-only')?.state, 'accepted')
  next.observe(metadata.id, history('image-only'))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(await new RemoteOperationLedger(access).read('image-only'), null, 'observed retirement releases the image payload as well as its journal')
})

test('a lost image acknowledgement is reconciled after reload without resending the image', { timeout: 5000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'image-lost-ack' }, calls: SourceOperation[] = []
  const called = Promise.withResolvers<void>(), lost = Promise.withResolvers<SourceReceipt>()
  const request = { ...operation('uncertain-image'), images: [largeImage()] }
  const first = new RemoteOutbox(value => { calls.push(value); called.resolve(); return lost.promise }); first.setStorage(access)
  await first.admit(request); first.start(request.operationId); first.acceptCatalog([{ ...metadata, capabilities: { ...metadata.capabilities, images: true } }])
  await called.promise; first.dispose()
  const confirmed = Promise.withResolvers<SourceReceipt>(), lookedUp = Promise.withResolvers<SourceOperation>()
  const next = new RemoteOutbox(async value => { calls.push(value); return accepted(value) }, value => { lookedUp.resolve(value); return confirmed.promise })
  t.after(() => { next.dispose(); lost.resolve(accepted(request)) }); next.setStorage(access)
  next.acceptCatalog([{ ...metadata, capabilities: { ...metadata.capabilities, images: true } }])
  assert.deepEqual((await lookedUp.promise).images, request.images)
  assert.equal(calls.length, 1)
  confirmed.resolve({ ...accepted(request), ownerAdmission: { localId: request.operationId, state: 'queued' } })
  await when(next.view(metadata.id), () => next.get(request.operationId)?.state === 'owner-accepted')
  assert.equal(calls.length, 1); assert.ok(storage.getItem(storage.key(0)!)!.length < 1000)
})

test('existing inline image journals migrate without dispatch or dropping their original identity', { timeout: 5000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'legacy-image' }, request = { ...operation('legacy-image'), images: [largeImage()] }
  const key = `hhpi:outbox:v1:${access.scope}:${request.operationId}`
  storage.setItem(key, JSON.stringify({ version: 1, operation: request, createdAt: 1, state: 'confirming', attempts: 1, retryAt: 0, message: 'Confirming' }))
  let writes = 0
  const outbox = new RemoteOutbox(async value => { writes++; return accepted(value) }); t.after(() => outbox.dispose())
  outbox.setStorage(access)
  await when(outbox.view(metadata.id), () => !!outbox.get(request.operationId))
  assert.equal(outbox.get(request.operationId)?.operation.images?.[0]?.data, request.images[0]!.data)
  assert.equal(JSON.parse(storage.getItem(key)!).version, 2); assert.ok(storage.getItem(key)!.length < 1000); assert.equal(writes, 0)
})

test('a late image payload read cannot populate another account or dispatch there', { timeout: 5000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'image-account-a' }, request = { ...operation('owned-image'), images: [largeImage()] }
  const first = new RemoteOutbox(async value => accepted(value)); first.setStorage(access); await first.admit(request); first.dispose()
  const read = Promise.withResolvers<string | null | undefined>(), readCalled = Promise.withResolvers<void>()
  let writes = 0
  const next = new RemoteOutbox(async value => { writes++; return accepted(value) }, undefined, undefined, source => {
    const ledger = new RemoteOperationLedger(source)
    return { read: () => { readCalled.resolve(); return read.promise }, transition: ledger.transition.bind(ledger) }
  }); t.after(() => next.dispose()); next.setStorage(access); await readCalled.promise
  next.setStorage({ storage, scope: 'image-account-b' }); next.acceptCatalog([metadata])
  read.resolve(await new RemoteOperationLedger(access).read(request.operationId))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(next.view(metadata.id).getSnapshot().length, 0); assert.equal(writes, 0)
})

for (const revoke of ['session', 'account'] as const) test(`${revoke} revocation retires an image index while its payload is still restoring`, { timeout: 5000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: `cold-revoke-${revoke}` }, request = { ...operation('cold-image'), images: [largeImage()] }
  const first = new RemoteOutbox(async value => accepted(value)); first.setStorage(access); await first.admit(request); first.dispose()
  const ledger = new RemoteOperationLedger(access), original = await ledger.read(request.operationId)
  const read = Promise.withResolvers<string | null | undefined>(), readCalled = Promise.withResolvers<void>()
  let writes = 0
  const next = new RemoteOutbox(async value => { writes++; return accepted(value) }, undefined, undefined, () => ({
    read: () => { readCalled.resolve(); return read.promise }, transition: ledger.transition.bind(ledger),
  })); t.after(() => next.dispose()); next.setStorage(access); next.acceptCatalog([metadata]); await readCalled.promise
  if (revoke === 'session') next.revokeSession(metadata.id); else next.clear()
  read.resolve(original); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(storage.length, 0); assert.equal(await ledger.read(request.operationId), null)
  assert.equal(next.view(metadata.id).getSnapshot().length, 0); assert.equal(writes, 0)
})

test('source revocation before asynchronous image admission cannot leave another saved intent', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'admission-revoked' }
  const outbox = new RemoteOutbox(async value => accepted(value)); t.after(() => outbox.dispose()); outbox.setStorage(access)
  const pending = outbox.admit({ ...operation('revoked-before-save'), images: [largeImage()] })
  outbox.revokeSession(metadata.id)
  await assert.rejects(pending, /draft has been kept/)
  assert.equal(storage.length, 0); assert.equal(await new RemoteOperationLedger(access).read('revoked-before-save'), undefined)
})

test('oversized image admission reports the actual source limit and retains the draft instead of an invalid-operation error', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'native-frame-limit' }
  let sends = 0
  const outbox = new RemoteOutbox(async value => { sends++; return accepted(value) }); t.after(() => outbox.dispose()); outbox.setStorage(access)
  const image = { mediaType: 'image/png' as const, data: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') }
  await assert.rejects(outbox.admit({ ...operation('too-large'), images: [image] }), /6 MiB.*draft and attachments have been kept/)
  assert.equal(storage.length, 0); assert.equal(sends, 0)
  await assert.rejects(outbox.admit({ ...operation('bad-media-type'), images: [{ ...image, data: 'YWJj', mediaType: 'image/unknown' as 'image/png' }] }), /images.0.mediaType/)
})

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
  const lost = Promise.withResolvers<SourceReceipt>(), called = Promise.withResolvers<void>()
  const first = new RemoteOutbox(request => { calls.push(request); called.resolve(); return lost.promise }); first.setStorage(access)
  first.enqueue(operation('first')); first.enqueue(operation('second')); first.start('first'); first.start('second'); first.acceptCatalog([metadata])
  await called.promise
  assert.deepEqual(calls.map(value => value.operationId), ['first'])
  first.dispose()
  const confirmed = Promise.withResolvers<SourceReceipt>()
  const next = new RemoteOutbox(request => { calls.push(request); return Promise.resolve(accepted(request)) }, request => request.operationId === 'first' ? confirmed.promise : Promise.resolve(null))
  t.after(() => { next.dispose(); lost.resolve(accepted(operation('first'))) }); next.setStorage(access)
  next.acceptCatalog([metadata])
  assert.deepEqual(calls.map(value => value.operationId), ['first'], 'reload queries the original receipt without dispatching again')
  confirmed.resolve(accepted(operation('first')))
  const view = next.view(metadata.id)
  await when(view, () => view.getSnapshot().every(value => value.state === 'accepted'))
  assert.deepEqual(calls.map(value => value.operationId), ['first', 'second'])
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
  }, async request => ({ ...accepted(request), status: 'rejected', retryable: true, message: 'The authenticated source confirms this operation was not dispatched.' }))
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
  let observed: SourceEntry[] = []
  const receipt = Promise.withResolvers<SourceReceipt>(), called = Promise.withResolvers<void>()
  const api = { catalog: async () => ({ ok: true, value: { protocol: 1, storageScope: 'account-host', legacyHapi: false, sources: [], sessions: [current] } }),
    read: async () => ({ ok: true, value: { session: current, epoch: 'epoch', version: 1, entries: observed, before: null, after: null, hasBefore: false, hasAfter: false, context: [] } }),
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
  const failedImages: string[] = []
  face.update({ ...current, capabilities: { ...current.capabilities, images: true } })
  const imageLimits = face.projections.faceOf('imageLimits').getSnapshot()
  assert.equal(imageLimits?.maxImageBytes, 6 * 1024 * 1024)
  assert.equal(imageLimits?.maxMessageImageBytes, 6 * 1024 * 1024)
  assert.equal(imageLimits?.maxImagesPerMessage, 10)
  const failedImage = face.beginSubmission({ mode: 'queue', text: 'Keep this image draft',
    attachments: [{ type: 'image', value: { previewUrl: 'blob:synthetic-image' } }], onRetire: value => failedImages.push(value.reason) })
  const imageResult = await face.prompt([{ type: 'image', ...largeImage() }, { type: 'text', text: 'Keep this image draft' }], 'queue', undefined, failedImage.requestId)
  assert.equal(imageResult.ok, false); assert.equal(face.getSnapshot().pendingSubmissions.length, 0, 'failed image admission must remove its unsent transcript echo')
  assert.deepEqual(failedImages, ['failed']); assert.equal(writes.length, 0)
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
  const probe = new RemoteOutbox(async request => accepted(request)); t.after(() => probe.dispose())
  probe.setStorage({ storage, scope: 'account-host' })
  assert.equal(probe.view(metadata.id).getSnapshot()[0]!.operation.operationId, pending.requestId)
  observed = history(pending.requestId); receipt.resolve(accepted(writes[0]!))
  await when(face.deliveries, () => face.deliveries.getSnapshot().length === 0)
  assert.equal([...Array(storage.length).keys()].filter(index => storage.key(index)?.startsWith('hhpi:outbox:')).length, 0,
    'a matching background source read frees accepted queue capacity even after every Pane has closed')
  assert.equal(writes.length, 1)
})

for (const availability of ['read-only', 'offline'] as const) test(`lost ACK recovery reads the existing receipt and matching user message while the native source is ${availability}`, { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'account-host' }
  const first = new RemoteOutbox(async () => { throw new Error('Lost browser reply') })
  first.setStorage(access); first.enqueue(operation('read-only-recovery')); first.start('read-only-recovery'); first.acceptCatalog([metadata])
  await when(first.view(metadata.id), () => first.view(metadata.id).getSnapshot()[0]?.state === 'confirming')
  first.dispose()
  let writes = 0, lookups = 0, reads = 0
  const next = new RemoteOutbox(async request => { writes++; return accepted(request) }, async request => {
    lookups++; return { ...accepted(request), observed: { epoch: 'source-epoch', seq: 123 } }
  }, async (request, receipt) => { reads++; assert.equal(receipt.observed?.seq, 123); return history(request.operationId) })
  t.after(() => next.dispose()); next.setStorage(access)
  next.acceptCatalog([availability === 'offline' ? { ...metadata, status: 'offline' } : { ...metadata, capabilities: { ...metadata.capabilities, send: false } }])
  await when(next.view(metadata.id), () => next.view(metadata.id).getSnapshot().length === 0)
  assert.equal(writes, 0); assert.equal(lookups, 1); assert.equal(reads, 1); assert.equal(storage.length, 0)
})

test('closing a Pane after an ACK still reconciles an accepted message outside the source tail', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), ctx = new Context()
  let writes = 0, aroundReads = 0
  const api = { catalog: async () => ({ ok: true, value: { protocol: 1, storageScope: 'account-host', legacyHapi: false, sources: [], sessions: [metadata] } }),
    read: async (request: SourceReadRequest) => {
      if (request.around === 1) aroundReads++
      return { ok: true, value: { session: metadata, epoch: 'epoch', version: 1,
        entries: request.around === 1 ? history(savedId) : [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] } }
    },
    operate: async (request: SourceOperation) => { writes++; return { ok: true, value: accepted(request) } },
    receipt: async (request: SourceOperation) => ({ ok: true, value: { ...accepted(request), observed: { epoch: 'epoch', seq: 1 } } }),
  } as unknown as HhpiRemoteApi
  const original = { list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }), subscribe: () => () => {} },
    refresh: async () => {}, windowCommit: {}, retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => {} }) } as unknown as ISessions
  let savedId = ''
  const sessions = new Sessions(ctx, original, api, { storage, scope: 'account-host' })
  t.after(async () => { sessions.dispose(); await ctx.fiber.dispose() }); await sessions.refresh()
  const ref = sessions.retain(metadata.id as SessionId, { source: 'hapiWorkspace' }); await ref.ready
  const face = ref.binding.session as RemoteSourceSession
  const pending = face.beginSubmission({ mode: 'queue', text: 'Saved text', attachments: [] }); savedId = pending.requestId
  assert.equal((await face.prompt([{ type: 'text', text: 'Saved text' }], 'queue', undefined, pending.requestId)).ok, true)
  await when(face.deliveries, () => face.deliveries.getSnapshot()[0]?.state === 'accepted')
  assert.equal(aroundReads, 0)
  ref.release()
  await when(face.deliveries, () => face.deliveries.getSnapshot().length === 0)
  assert.equal(writes, 1); assert.equal(aroundReads, 1)
  assert.equal([...Array(storage.length).keys()].filter(index => storage.key(index)?.startsWith('hhpi:outbox:')).length, 0)
})

test('exact owner admission transfers responsibility to a bounded viewable receipt without consuming pending capacity', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage()
  const outbox = new RemoteOutbox(async request => ({ ...accepted(request), ownerAdmission: { localId: request.operationId, state: 'queued' } }))
  t.after(() => outbox.dispose()); outbox.setStorage({ storage, scope: 'owner-handoff' }); outbox.acceptCatalog([metadata])
  const view = outbox.view(metadata.id)
  for (let index = 0; index < 260; index++) {
    const id = `owner-message-${index}`; outbox.enqueue(operation(id, `Original text ${index}`)); outbox.start(id)
    await when(view, () => outbox.get(id)?.state === 'owner-accepted')
  }
  assert.equal(view.getSnapshot().length, 128, 'only independently bounded owner receipts remain, not 260 active submissions')
  assert.equal(view.getSnapshot().at(-1)!.operation.text, 'Original text 259')
  outbox.enqueue(operation('still-sendable', 'A new draft can still be admitted'))
  assert.equal(outbox.get('still-sendable')?.state, 'queued')
})

test('actual browser quota can reclaim only already handed-off receipts before admitting the next text', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage()
  const outbox = new RemoteOutbox(async request => ({ ...accepted(request), ownerAdmission: { localId: request.operationId, state: 'queued' } }))
  t.after(() => outbox.dispose()); outbox.setStorage({ storage, scope: 'quota-handoff' }); outbox.acceptCatalog([metadata])
  outbox.enqueue(operation('saved-by-owner')); outbox.start('saved-by-owner')
  await when(outbox.view(metadata.id), () => outbox.get('saved-by-owner')?.state === 'owner-accepted')
  const write = storage.setItem.bind(storage)
  storage.setItem = (key, value) => {
    if (storage.length && storage.getItem(key) === null) throw new DOMException('Synthetic device quota', 'QuotaExceededError')
    write(key, value)
  }
  outbox.enqueue(operation('new-local-work'))
  assert.equal(outbox.get('saved-by-owner'), undefined); assert.equal(outbox.get('new-local-work')?.state, 'queued')
  assert.throws(() => outbox.enqueue(operation('must-keep-draft')), /draft has been kept/)
  assert.equal(outbox.get('new-local-work')?.state, 'queued', 'a quota retry never removes unhanded local work')
})

test('a handed-off long text remains inspectable without blocking new active submissions', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), text = '文'.repeat(600_000)
  const outbox = new RemoteOutbox(async request => ({ ...accepted(request), ownerAdmission: { localId: request.operationId, state: 'queued' } }))
  t.after(() => outbox.dispose()); outbox.setStorage({ storage, scope: 'long-owner-receipt' }); outbox.acceptCatalog([metadata])
  outbox.enqueue(operation('long-owner-message', text)); outbox.start('long-owner-message')
  await when(outbox.view(metadata.id), () => outbox.get('long-owner-message')?.state === 'owner-accepted')
  assert.equal(outbox.get('long-owner-message')?.operation.text, text, 'a receipt exceeding 1 MiB keeps its exact source-owned original text')
  outbox.enqueue(operation('new-message-after-large-receipt', 'Still writable'))
  assert.equal(outbox.get('new-message-after-large-receipt')?.state, 'queued')
})

test('a late owner admission cannot recreate a source explicitly revoked during its in-flight send', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), reply = Promise.withResolvers<SourceReceipt>()
  const outbox = new RemoteOutbox(() => reply.promise); t.after(() => outbox.dispose())
  outbox.setStorage({ storage, scope: 'revocation' }); outbox.enqueue(operation('late-admission')); outbox.start('late-admission'); outbox.acceptCatalog([metadata])
  outbox.revokeSession(metadata.id)
  reply.resolve({ ...accepted(operation('late-admission')), ownerAdmission: { localId: 'late-admission', state: 'queued' } })
  await reply.promise; await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(outbox.view(metadata.id).getSnapshot().length, 0); assert.equal(storage.length, 0)
})

test('read-only receipt permission denial cannot be mistaken for a rejection of the original write', { timeout: 3000 }, async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'receipt-grants' }
  const first = new RemoteOutbox(async () => { throw new Error('Browser reply lost') }); first.setStorage(access)
  first.enqueue(operation('receipt-denied')); first.start('receipt-denied'); first.acceptCatalog([metadata])
  await when(first.view(metadata.id), () => first.get('receipt-denied')?.state === 'confirming'); first.dispose()
  let writes = 0, lookups = 0
  const next = new RemoteOutbox(async request => { writes++; return accepted(request) }, async () => {
    lookups++; throw Object.assign(new Error('Synthetic missing hhpi/receipt grant'), { code: 'remote-access/denied' })
  })
  t.after(() => next.dispose()); next.setStorage(access); next.acceptCatalog([metadata])
  await when(next.view(metadata.id), () => next.get('receipt-denied')?.message.includes('Receipt access') === true)
  assert.equal(next.get('receipt-denied')?.state, 'confirming'); assert.equal(writes, 0); assert.equal(lookups, 1)
  next.start('receipt-denied'); assert.equal(lookups, 1, 'a denied read waits for a fresh authenticated catalog')
  assert.equal(storage.length, 1)
})


test('control identities remain session-scoped, bounded and durable for native target IDs shared by two sessions', async t => {
  const storage = new BrowserStorage(), writes: SourceOperation[] = []
  const outbox = new RemoteOutbox(async request => { writes.push(request); return accepted(request) })
  t.after(() => outbox.dispose()); outbox.setStorage({ storage, scope: 'controls' })
  const first = { ...metadata, status: 'running' as const, activeTurnId: 'same-turn', capabilities: { ...metadata.capabilities, cancel: true } }
  const second = { ...first, id: 'hhpi:machine:source:codex:other-thread', nativeId: 'other-thread' }
  outbox.acceptCatalog([first, second])
  const ids = await Promise.all([first, second].map(session => sourceControlOperationId(session.id, 'cancel', 'same-turn')))
  assert.notEqual(ids[0], ids[1])
  assert.ok((await sourceControlOperationId('x'.repeat(2000), 'cancel', 't'.repeat(2000))).length <= 256)
  assert.equal(ids[0], await sourceControlOperationId(first.id, 'cancel', 'same-turn'))
  const receipts = await Promise.all([first, second].map((session, i) => outbox.submit({ sessionId: session.id,
    operationId: ids[i]!, kind: 'cancel', turnId: 'same-turn' })))
  assert.ok(receipts.every(receipt => receipt.status === 'accepted'))
  assert.equal(writes.length, 2)
})

test('two contexts choosing different approval decisions cannot replace the first canonical intent', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'conflicting-controls' }, calls: SourceOperation[] = []
  const a = new RemoteOutbox(async request => { calls.push(request); return accepted(request) })
  const b = new RemoteOutbox(async request => { calls.push(request); return accepted(request) })
  t.after(() => { a.dispose(); b.dispose() }); a.setStorage(access); b.setStorage(access)
  const session = { ...metadata, capabilities: { ...metadata.capabilities, approve: true },
    pendingRequests: [{ id: 'approval', method: 'synthetic', params: {} }] }
  const operationId = await sourceControlOperationId(session.id, 'approve', 'approval')
  const original: SourceOperation = { sessionId: session.id, operationId, kind: 'approve', requestId: 'approval', decision: 'accept' }
  a.acceptCatalog([session]); b.acceptCatalog([session])
  const first = a.submit(original), second = b.submit({ ...original, decision: 'decline' })
  const rejected = assert.rejects(second, /different arguments/)
  a.acceptCatalog([session]); b.acceptCatalog([session])
  await rejected
  assert.equal((await first).status, 'accepted')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.decision, 'accept')
})


test('a control saved before authenticated access requires explicit resume rather than reconnect dispatch', async t => {
  const storage = new BrowserStorage(), writes: SourceOperation[] = []
  const outbox = new RemoteOutbox(async request => { writes.push(request); return accepted(request) })
  t.after(() => outbox.dispose()); outbox.setStorage({ storage, scope: 'explicit-control' })
  const session = { ...metadata, status: 'running' as const, activeTurnId: 'original', capabilities: { ...metadata.capabilities, cancel: true } }
  const request: SourceOperation = { sessionId: session.id, operationId: 'explicit-original', kind: 'cancel', turnId: 'original' }
  assert.equal((await outbox.submit(request)).status, 'indeterminate')
  outbox.acceptCatalog([session]); await Promise.resolve()
  assert.equal(writes.length, 0)
  outbox.retry(request.operationId)
  await when(outbox.view(session.id), () => outbox.get(request.operationId)?.state === 'accepted')
  assert.equal(writes.length, 1)
})

test('a stale context cannot abandon an intent already claimed by another context', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'abandon-race' }
  const called = Promise.withResolvers<void>(), reply = Promise.withResolvers<SourceReceipt>(), retired: boolean[] = []
  const a = new RemoteOutbox(async () => { called.resolve(); return reply.promise }), b = new RemoteOutbox(async request => accepted(request))
  t.after(() => { reply.resolve(accepted(operation('original'))); a.dispose(); b.dispose() })
  a.setStorage(access); a.enqueue(operation('original')); b.setStorage(access); b.onRetire((_, observed) => retired.push(observed))
  a.acceptCatalog([metadata]); a.start('original'); await called.promise
  b.abandon('original')
  await when(b.view(metadata.id), () => (b.get('original')?.attempts ?? 0) > 0)
  assert.deepEqual(retired, [])
  assert.equal(storage.length, 1, 'an in-flight intent retains its durable identity')
})
