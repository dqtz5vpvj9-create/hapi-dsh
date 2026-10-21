import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceFileMutation, sourceFileContains, validSourceFileName } from '../src/client/source-file-management.ts'
import type { NativeWorkbenchApi } from '../src/workbench-types.ts'
import { createSourceFileMutations, sourceFileMutationKey, type SourceFileOwner } from '../src/client/source-file-mutation-journal.ts'
import { SourceFileLocksFixture, SourceFileStorageFixture, deferred } from './source-file-mutation-fixture.ts'

const owner: SourceFileOwner = { sourceHubId: 'hub-a', sourceSessionId: 'source-a', machineId: 'machine-a' }
const journal = () => createSourceFileMutations({ storage: new SourceFileStorageFixture(), locks: new SourceFileLocksFixture(), channel: null })
type Api = Pick<NativeWorkbenchApi, 'nativeFileManage' | 'nativeFileUpload' | 'nativeFileInspect'>
const basicApi = (): Api => ({ nativeFileManage: async () => ({ ok: true, value: { success: true } }),
  nativeFileUpload: async () => ({ ok: true, value: { success: true } }),
  nativeFileInspect: async () => ({ ok: true, value: { success: false, code: 'not-found' } }) })
const rename = () => ({ action: 'rename' as const, path: '/source/a', destination: '/source/b', expectedRevision: 'a'.repeat(64) })

test('source file mutation retains unknown identity, inspects both paths, and never replays during recovery', async () => {
  const writes: unknown[] = [], reads: string[] = []
  const api: Pick<NativeWorkbenchApi, 'nativeFileManage' | 'nativeFileUpload' | 'nativeFileInspect'> = {
    nativeFileManage: async request => { writes.push(request); throw new Error('Connection lost after source rename') },
    nativeFileUpload: async request => { writes.push(request); return { ok: true, value: { success: true } } },
    nativeFileInspect: async request => { reads.push(request.path); return { ok: true, value: { success: false, code: 'not-found' } } },
  }
  const model = new SourceFileMutation(api, owner, journal())
  await model.manage({ action: 'rename', path: '/source/first', destination: '/source/second', expectedRevision: 'a'.repeat(64) })
  assert.equal(model.getSnapshot().uncertain, true)
  await model.manage({ action: 'delete', path: '/source/first', expectedRevision: 'a'.repeat(64), recursive: false })
  await model.upload('/source/new', 'YQ=='); assert.equal(writes.length, 1)
  assert.equal(await model.review(), false)
  await model.inspect(); assert.deepEqual(reads, ['/source/first', '/source/second']); assert.equal(writes.length, 1)
  assert.equal(model.getSnapshot().uncertain, true)
  assert.equal(await model.review(), true)
  await model.upload('/source/new', 'YQ=='); assert.equal(writes.length, 2)
})

test('partial delete and committed rename metadata survive the failure response', async () => {
  const result = { success: false, error: 'Cannot inspect new path', commit: { action: 'rename' as const, path: '/a', destination: '/b' } }
  const model = new SourceFileMutation({ nativeFileManage: async () => ({ ok: true, value: result }),
    nativeFileUpload: async () => ({ ok: true, value: { success: true } }),
    nativeFileInspect: async () => ({ ok: true, value: { success: false, code: 'denied' } }),
  }, owner, journal())
  await model.manage({ action: 'rename', path: '/a', destination: '/b', expectedRevision: 'a'.repeat(64) })
  assert.deepEqual(model.getSnapshot().result?.commit, result.commit)
  await model.inspect(); assert.equal(await model.review(), false)
})

test('source path guards cover descendant drafts and reject ambiguous creation names', () => {
  assert.equal(sourceFileContains('/work/a', '/work/a/file'), true)
  assert.equal(sourceFileContains('/work/a', '/work/ab/file'), false)
  assert.equal(sourceFileContains('C:\\Work\\A', 'c:/work/a/file'), true)
  assert.equal(sourceFileContains('/Work/A', '/work/a'), false)
  for (const value of ['.', '..', ' ', 'a/b', 'a\\b', 'C:drive', 'a\0b']) assert.equal(validSourceFileName(value), false)
  assert.equal(validSourceFileName('你好 source.txt'), true)
})

test('durable admission precedes the RPC and fixes the caller-owned request snapshot', async () => {
  const storage = new SourceFileStorageFixture(), locks = new SourceFileLocksFixture(), entered = deferred<void>(), continueWrite = deferred<void>()
  storage.beforeWrite = async index => { if (index === 1) { entered.resolve(); await continueWrite.promise } }
  const owned = { ...owner }, operation = rename(), sent: unknown[] = []
  const api = basicApi(); api.nativeFileManage = async request => {
    const saved = await storage.read(owner)
    assert.equal(saved?.receipt.phase, 'pending'); assert.deepEqual(request.operation, saved?.receipt.request)
    sent.push(request); return { ok: true, value: { success: true } }
  }
  const model = new SourceFileMutation(api, owned, createSourceFileMutations({ storage, locks, channel: null }))
  const flight = model.manage(operation); await entered.promise
  assert.equal(sent.length, 0)
  operation.destination = '/changed-after-admission'; owned.machineId = 'other-machine'
  continueWrite.resolve(); assert.equal(await flight, true)
  assert.deepEqual(sent, [{ source: owner, operation: rename() }])
})

test('refused durable admission and missing source ownership never send', async () => {
  const storage = new SourceFileStorageFixture(); storage.beforeWrite = async () => { throw new Error('Quota denied') }
  let sent = 0
  const api = basicApi(); api.nativeFileManage = async () => { sent++; return { ok: true, value: { success: true } } }
  const retained = createSourceFileMutations({ storage, locks: new SourceFileLocksFixture(), channel: null })
  const model = new SourceFileMutation(api, owner, retained)
  assert.equal(await model.manage(rename()), false); assert.match(model.getSnapshot().storageError ?? '', /Quota denied/)
  const incomplete = new SourceFileMutation(api, { sourceSessionId: owner.sourceSessionId }, retained)
  assert.equal(await incomplete.manage(rename()), false); assert.match(incomplete.getSnapshot().error ?? '', /Hub, session and machine/)
  assert.equal(sent, 0); assert.equal(storage.rows.size, 0)
})

test('missing cross-window lock capability refuses mutation without an in-memory fallback', async () => {
  const storage = new SourceFileStorageFixture(), unavailable = async (): Promise<never> => { throw new Error('Web Locks unavailable') }
  const retained = createSourceFileMutations({ storage, locks: { held: unavailable, exclusive: unavailable }, channel: null })
  let sent = 0
  const api = basicApi(); api.nativeFileManage = async () => { sent++; return { ok: true, value: { success: true } } }
  const model = new SourceFileMutation(api, owner, retained)
  assert.equal(await model.manage(rename()), false); assert.equal(sent, 0); assert.equal(storage.rows.size, 0)
  assert.match(model.getSnapshot().storageError ?? '', /Web Locks unavailable/)
})

test('a disposed graph does not send after a delayed admission transaction completes', async () => {
  const storage = new SourceFileStorageFixture(), entered = deferred<void>(), continueWrite = deferred<void>()
  storage.beforeWrite = async () => { entered.resolve(); await continueWrite.promise }
  let sent = 0
  const api = basicApi(); api.nativeFileManage = async () => { sent++; return { ok: true, value: { success: true } } }
  const retained = createSourceFileMutations({ storage, locks: new SourceFileLocksFixture(), channel: null })
  const model = new SourceFileMutation(api, owner, retained), flight = model.manage(rename())
  await entered.promise; model.dispose(); continueWrite.resolve()
  assert.equal(await flight, false); assert.equal(sent, 0)
  assert.equal((await storage.read(owner))?.receipt.phase, 'pending')
  const restored = new SourceFileMutation(api, owner, retained); await restored.load()
  assert.equal(restored.getSnapshot().uncertain, true); assert.equal(restored.getSnapshot().busy, false)
})

test('a rebound graph retains the active flight and can only inspect after the old RPC settles', async () => {
  const storage = new SourceFileStorageFixture(), retained = createSourceFileMutations({ storage, locks: new SourceFileLocksFixture(), channel: null })
  const started = deferred<void>(), reply = deferred<Awaited<ReturnType<Api['nativeFileManage']>>>(); let reads = 0, sent = 0
  const api = basicApi(); api.nativeFileManage = async () => { sent++; started.resolve(); return reply.promise }
  api.nativeFileInspect = async () => { reads++; return { ok: true, value: { success: false, code: 'not-found' } } }
  const original = new SourceFileMutation(api, owner, retained), flight = original.manage(rename())
  await started.promise; const operationId = original.getSnapshot().operationId; original.dispose()
  const restored = new SourceFileMutation(api, owner, retained); await restored.load()
  assert.equal(restored.getSnapshot().operationId, operationId); assert.equal(restored.getSnapshot().busy, true)
  await restored.inspect(); assert.equal(await restored.review(), false); assert.equal(reads, 0)
  reply.reject(new Error('Lost source acknowledgement')); assert.equal(await flight, false)
  await restored.load(); await restored.load(); assert.equal(restored.getSnapshot().busy, false)
  await restored.inspect(); assert.equal(reads, 2); assert.equal(await restored.review(), true)
  assert.equal(restored.getSnapshot().phase, 'reviewed'); assert.equal(restored.getSnapshot().result, null)
  assert.equal((await storage.read(owner))?.receipt.error, 'Lost source acknowledgement'); assert.equal(sent, 1)
})

test('two windows sharing storage and Web Locks cannot review or replace a still-running source mutation', async () => {
  const storage = new SourceFileStorageFixture(), locks = new SourceFileLocksFixture()
  const firstJournal = createSourceFileMutations({ storage, locks, channel: null }), secondJournal = createSourceFileMutations({ storage, locks, channel: null })
  const started = deferred<void>(), reply = deferred<Awaited<ReturnType<Api['nativeFileManage']>>>(); let sent = 0, reads = 0
  const api = basicApi(); api.nativeFileManage = async () => { sent++; started.resolve(); return reply.promise }
  api.nativeFileInspect = async () => { reads++; return { ok: true, value: { success: false, code: 'not-found' } } }
  const first = new SourceFileMutation(api, owner, firstJournal), flight = first.manage(rename())
  await started.promise
  const second = new SourceFileMutation(api, owner, secondJournal); await second.load()
  assert.equal(second.getSnapshot().busy, true)
  await second.inspect(); assert.equal(await second.review(), false)
  assert.equal(await second.upload('/source/new', 'YQ=='), false); assert.equal(reads, 0); assert.equal(sent, 1)
  reply.reject(new Error('Unknown after source disconnect')); await flight; await second.load()
  await second.inspect(); assert.equal(await second.review(), true)
  assert.equal(second.getSnapshot().phase, 'reviewed'); assert.equal(sent, 1)
})

test('pending intent after a window loss reloads as unknown and upload bytes are never retained', async () => {
  const storage = new SourceFileStorageFixture(), locks = new SourceFileLocksFixture(), retained = createSourceFileMutations({ storage, locks, channel: null })
  let uploads = 0, reads = 0
  const api = basicApi(); api.nativeFileUpload = async () => { uploads++; throw new Error('Lost upload acknowledgement') }
  api.nativeFileInspect = async () => { reads++; return { ok: true, value: { success: false, code: 'not-found' } } }
  const original = new SourceFileMutation(api, owner, retained)
  const payload = Buffer.from('File bytes must not enter the operation journal').toString('base64')
  await original.upload('/source/upload.txt', payload); original.dispose()
  const row = (await storage.read(owner))!; row.receipt.phase = 'pending'; row.receipt.error = null
  storage.rows.set(sourceFileMutationKey(owner), row)
  const restored = new SourceFileMutation(api, owner, createSourceFileMutations({ storage, locks, channel: null })); await restored.load()
  assert.equal(restored.getSnapshot().uncertain, true); assert.equal(restored.getSnapshot().busy, false)
  assert.equal(await restored.upload('/source/upload.txt', payload), false)
  assert.equal(JSON.stringify([...storage.rows.values()]).includes(payload), false)
  assert.deepEqual(restored.getSnapshot().request, { action: 'upload', path: '/source/upload.txt' })
  await restored.inspect(); assert.equal(await restored.review(), true)
  assert.equal(reads, 1); assert.equal(uploads, 1); assert.equal(restored.getSnapshot().phase, 'reviewed')
})

test('failed result persistence leaves the original durable pending receipt and never retries the source', async () => {
  const storage = new SourceFileStorageFixture(); storage.beforeWrite = async index => { if (index === 2) throw new Error('Disk full after send') }
  const locks = new SourceFileLocksFixture(); let sent = 0
  const api = basicApi(); api.nativeFileManage = async () => { sent++; return { ok: true, value: { success: true } } }
  const original = new SourceFileMutation(api, owner, createSourceFileMutations({ storage, locks, channel: null }))
  assert.equal(await original.manage(rename()), false); assert.equal((await storage.read(owner))?.receipt.phase, 'pending')
  original.dispose(); const restored = new SourceFileMutation(api, owner, createSourceFileMutations({ storage, locks, channel: null }))
  await restored.load(); assert.equal(restored.getSnapshot().uncertain, true); assert.equal(restored.getSnapshot().result, null)
  assert.equal(await restored.manage(rename()), false); assert.equal(sent, 1)
})

test('source identity includes Hub and machine, and incompatible stored owners cannot be replaced', async () => {
  const storage = new SourceFileStorageFixture(), retained = createSourceFileMutations({ storage, locks: new SourceFileLocksFixture(), channel: null })
  const api = basicApi(); api.nativeFileManage = async () => { throw new Error('Unknown source result') }
  const first = new SourceFileMutation(api, owner, retained); await first.manage(rename())
  for (const other of [{ ...owner, sourceHubId: 'hub-b' }, { ...owner, machineId: 'machine-b' }]) {
    const model = new SourceFileMutation(api, other, retained); await model.load(); assert.equal(model.getSnapshot().request, null)
  }
  const corruptOwner = { ...owner, sourceSessionId: 'wrong-owner' }
  storage.rows.set(sourceFileMutationKey(owner), { ...(await storage.read(owner))!, owner: corruptOwner })
  const restored = new SourceFileMutation(api, owner, retained)
  assert.equal(await restored.manage(rename()), false); assert.match(restored.getSnapshot().storageError ?? '', /Wrong saved owner/)
})

test('an out-of-band newer receipt cannot be overwritten by an older late result', async () => {
  const storage = new SourceFileStorageFixture(), retained = createSourceFileMutations({ storage, locks: new SourceFileLocksFixture(), channel: null })
  const started = deferred<void>(), reply = deferred<Awaited<ReturnType<Api['nativeFileManage']>>>()
  const api = basicApi(); api.nativeFileManage = async () => { started.resolve(); return reply.promise }
  const model = new SourceFileMutation(api, owner, retained), flight = model.manage(rename()); await started.promise
  const previous = (await storage.read(owner))!, replacement = { ...previous.receipt, operationId: crypto.randomUUID(), request: { action: 'upload' as const, path: '/other' } }
  const newer = await storage.write(owner, previous.revision, replacement)
  reply.resolve({ ok: true, value: { success: true } }); assert.equal(await flight, false)
  assert.deepEqual(await storage.read(owner), newer)
})

test('partial source evidence is bounded with its omitted-path count, without being called confirmed', async () => {
  const api = basicApi(); api.nativeFileManage = async () => ({ ok: true, value: { success: false, deletedPaths: Array.from({ length: 50 }, (_, index) => `/source/${index}`) } })
  const model = new SourceFileMutation(api, owner, journal()); await model.manage(rename())
  assert.equal(model.getSnapshot().result?.deletedPaths?.length, 32); assert.equal(model.getSnapshot().omittedPaths, 18)
  assert.equal(model.getSnapshot().phase, 'unknown')
})

test('a delayed lock grant rechecks durable admission and never replaces another window unknown receipt', async () => {
  const storage = new SourceFileStorageFixture(), locks = new SourceFileLocksFixture(), requested = deferred<void>(), grant = deferred<void>()
  const delayedLocks = { held: locks.held.bind(locks), async exclusive<T>(key: string, action: () => Promise<T>) {
    requested.resolve(); await grant.promise; return locks.exclusive(key, action)
  } }
  const waitingJournal = createSourceFileMutations({ storage, locks: delayedLocks, channel: null })
  let sent = 0
  const waitingApi = basicApi(); waitingApi.nativeFileManage = async () => { sent++; return { ok: true, value: { success: true } } }
  const waiting = new SourceFileMutation(waitingApi, owner, waitingJournal), waitingFlight = waiting.manage({ action: 'create-file', path: '/new-request' })
  await requested.promise
  const otherApi = basicApi(); otherApi.nativeFileManage = async () => { throw new Error('Lost first acknowledgement') }
  const other = new SourceFileMutation(otherApi, owner, createSourceFileMutations({ storage, locks, channel: null }))
  await other.manage(rename()); const unknown = await storage.read(owner)
  assert.equal(unknown?.receipt.phase, 'unknown')
  await waiting.load(); assert.equal(waiting.getSnapshot().uncertain, true)
  grant.resolve(); assert.equal(await waitingFlight, false)
  assert.equal(sent, 0); assert.deepEqual(await storage.read(owner), unknown)
})

test('a stale review button cannot bypass a different window active Web Lock', async () => {
  const storage = new SourceFileStorageFixture(), locks = new SourceFileLocksFixture()
  const first = createSourceFileMutations({ storage, locks, channel: null }), second = createSourceFileMutations({ storage, locks, channel: null })
  const api = basicApi(); api.nativeFileManage = async () => { throw new Error('Unconfirmed source request') }
  const model = new SourceFileMutation(api, owner, second); await model.manage(rename()); await model.inspect()
  assert.equal(model.getSnapshot().canReview, true)
  const entered = deferred<void>(), done = deferred<void>()
  const flight = first.exclusive(owner, model.getSnapshot().operationId!, async () => { entered.resolve(); await done.promise })
  await entered.promise
  assert.equal(await model.review(), false); assert.equal((await storage.read(owner))?.receipt.phase, 'unknown')
  done.resolve(); await flight
})
