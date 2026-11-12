import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceFileMutation, sourceFileContains, validSourceFileName } from '../src/client/source-file-management.ts'
import { createSourceFileMutations, sourceFileMutationKey, type SourceFileOwner } from '../src/client/source-file-mutation-journal.ts'
import type { WorkspaceMutationResult, WorkspaceEntry, WorkspaceServices } from '../src/workspace/service-types.ts'
import type { WorkspaceFileManageRequest } from '../src/workbench-types.ts'
import { SourceFileLocksFixture, SourceFileStorageFixture, deferred } from './source-file-mutation-fixture.ts'
import { fileContext, fileOwner } from './source-file-context-fixture.ts'

type Result = WorkspaceMutationResult<WorkspaceEntry | null>
const owner = fileOwner('management-fixture')
const rename = () => ({ action: 'rename' as const, path: '/source/a', destination: '/source/b', expectedVersion: 'opaque:initial' })
function fixture(options: { storage?: SourceFileStorageFixture; locks?: SourceFileLocksFixture; owner?: SourceFileOwner } = {}) {
  const storage = options.storage ?? new SourceFileStorageFixture(), locks = options.locks ?? new SourceFileLocksFixture()
  const context = fileContext(options.owner ?? owner), journal = createSourceFileMutations({ storage, locks, channel: null })
  return { context, storage, locks, journal, create: () => new SourceFileMutation(context, journal) }
}
const applied = (id: string): Result => ({ status: 'applied', operationId: id, value: null })

test('unknown operations retain the original source identity, inspect both paths, and never replay during recovery', async () => {
  const f = fixture(), sent: WorkspaceFileManageRequest[] = [], reads: string[] = []
  f.context.services.mutations!.manage = async request => { sent.push(request); throw new Error('Connection lost after source rename') }
  f.context.services.documents.inspect = async path => { reads.push(path); return null }
  const model = f.create(); await model.manage(rename()); const id = model.getSnapshot().operationId
  assert.equal(model.getSnapshot().uncertain, true)
  await model.manage({ action: 'delete', path: '/source/a', expectedVersion: 'opaque:initial', recursive: false })
  assert.equal(sent.length, 1); assert.equal(sent[0]?.operationId, id); assert.deepEqual(sent[0]?.target, owner.binding.target)
  assert.equal(await model.review(), false); await model.inspect()
  assert.deepEqual(reads, ['/source/a', '/source/b']); assert.equal(sent.length, 1); assert.equal(model.getSnapshot().uncertain, true)
  assert.equal(await model.review(), true)
})

test('source indeterminate results stay unknown and cannot be called confirmed by inspecting current paths', async () => {
  const f = fixture(); f.context.services.mutations!.manage = async request => ({ status: 'indeterminate', operationId: request.operationId })
  const model = f.create(); await model.manage(rename()); const result = model.getSnapshot().result
  assert.equal(result?.status, 'indeterminate'); await model.inspect(); assert.equal(model.getSnapshot().phase, 'unknown')
  assert.equal(await model.review(), true); assert.deepEqual(model.getSnapshot().result, result)
})

test('original source receipts reconcile a lost acknowledgement without issuing a second mutation', async () => {
  const f = fixture(); let count = 0, operation = ''
  f.context.services.mutations!.manage = async request => { count++; operation = request.operationId; throw new Error('Lost acknowledgement') }
  f.context.services.mutations!.receipt = async id => id === operation ? applied(id) : null
  const model = f.create(); await model.manage(rename()); await model.inspect()
  assert.equal(count, 1); assert.equal(model.getSnapshot().phase, 'confirmed'); assert.equal(model.getSnapshot().uncertain, false)
})

test('path guards protect descendant drafts and reject ambiguous creation names', () => {
  assert.equal(sourceFileContains('/work/a', '/work/a/file'), true); assert.equal(sourceFileContains('/work/a', '/work/ab/file'), false)
  assert.equal(sourceFileContains('C:\\Work\\A', 'c:/work/a/file'), true); assert.equal(sourceFileContains('/Work/A', '/work/a'), false)
  for (const value of ['.', '..', ' ', 'a/b', 'a\\b', 'C:drive', 'a\0b']) assert.equal(validSourceFileName(value), false)
  assert.equal(validSourceFileName('你好 source.txt'), true)
})

test('durable admission precedes RPC and snapshots both operation and source ownership', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>(), operation = rename(), sent: WorkspaceFileManageRequest[] = []
  f.storage.beforeWrite = async index => { if (index === 1) { entered.resolve(); await release.promise } }
  f.context.services.mutations!.manage = async request => {
    const row = await f.storage.read(owner); assert.equal(row?.receipt.phase, 'pending'); assert.deepEqual(row?.receipt.request, request.operation)
    sent.push(request); return applied(request.operationId)
  }
  const model = f.create(), flight = model.manage(operation); await entered.promise
  operation.destination = '/changed-after-admission'; release.resolve(); assert.equal(await flight, true)
  assert.deepEqual(sent[0]?.operation, rename()); assert.equal(sent[0]?.operationId, model.getSnapshot().operationId)
})

test('refused durable admission never sends and preserves the source request for the user', async () => {
  const f = fixture(); let sent = 0
  f.storage.beforeWrite = async () => { throw new Error('Quota denied') }
  f.context.services.mutations!.manage = async request => { sent++; return applied(request.operationId) }
  const model = f.create(); assert.equal(await model.manage(rename()), false)
  assert.equal(sent, 0); assert.equal(f.storage.rows.size, 0); assert.match(model.getSnapshot().storageError ?? '', /Quota denied/)
})

test('missing browser Web Locks refuses mutation rather than using an in-memory fallback', async () => {
  const context = fileContext(owner), storage = new SourceFileStorageFixture(), unavailable = async (): Promise<never> => { throw new Error('Web Locks unavailable') }
  const journal = createSourceFileMutations({ storage, locks: { held: unavailable, exclusive: unavailable }, channel: null }); let sent = 0
  context.services.mutations!.manage = async request => { sent++; return applied(request.operationId) }
  const model = new SourceFileMutation(context, journal); assert.equal(await model.manage(rename()), false)
  assert.equal(sent, 0); assert.equal(storage.rows.size, 0); assert.match(model.getSnapshot().storageError ?? '', /Web Locks unavailable/)
})

test('disposing a graph during durable admission retains the intent and does not send afterwards', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>(); let sent = 0
  f.storage.beforeWrite = async () => { entered.resolve(); await release.promise }
  f.context.services.mutations!.manage = async request => { sent++; return applied(request.operationId) }
  const original = f.create(), flight = original.manage(rename()); await entered.promise; original.dispose(); release.resolve()
  assert.equal(await flight, false); assert.equal(sent, 0); assert.equal((await f.storage.read(owner))?.receipt.phase, 'pending')
  const restored = f.create(); await restored.load(); assert.equal(restored.getSnapshot().uncertain, true)
})

test('rebound graphs retain an active flight and cannot inspect until its original RPC settles', async () => {
  const f = fixture(), entered = deferred<void>(), reply = deferred<Result>(); let reads = 0, sent = 0
  f.context.services.mutations!.manage = async () => { sent++; entered.resolve(); return reply.promise }
  f.context.services.documents.inspect = async () => { reads++; return null }
  const original = f.create(), flight = original.manage(rename()); await entered.promise; original.dispose()
  const restored = f.create(); await restored.load(); assert.equal(restored.getSnapshot().busy, true)
  await restored.inspect(); assert.equal(await restored.review(), false); assert.equal(reads, 0)
  reply.reject(new Error('Lost source acknowledgement')); await flight; await restored.load(); await restored.load()
  assert.equal(restored.getSnapshot().busy, false); await restored.inspect(); assert.equal(reads, 2)
  assert.equal(await restored.review(), true); assert.equal(sent, 1)
})

test('two windows sharing durable storage and locks cannot replace a running source operation', async () => {
  const storage = new SourceFileStorageFixture(), locks = new SourceFileLocksFixture(), f = fixture({ storage, locks }), other = fixture({ storage, locks })
  const entered = deferred<void>(), reply = deferred<Result>(); let sent = 0
  f.context.services.mutations!.manage = async () => { sent++; entered.resolve(); return reply.promise }
  other.context.services.mutations!.manage = async request => { sent++; return applied(request.operationId) }
  const first = f.create(), flight = first.manage(rename()); await entered.promise
  const second = other.create(); await second.load(); assert.equal(second.getSnapshot().busy, true)
  assert.equal(await second.manage(rename()), false); assert.equal(await second.review(), false); assert.equal(sent, 1)
  reply.reject(new Error('Unknown after source disconnect')); await flight; await second.load(); await second.inspect()
  assert.equal(await second.review(), true); assert.equal(sent, 1)
})

test('failed result persistence leaves the original pending operation and does not permit a retry', async () => {
  const f = fixture(); let sent = 0; f.storage.beforeWrite = async index => { if (index === 2) throw new Error('Disk full after send') }
  f.context.services.mutations!.manage = async request => { sent++; return applied(request.operationId) }
  const original = f.create(); assert.equal(await original.manage(rename()), false); original.dispose()
  const restored = f.create(); await restored.load(); assert.equal(restored.getSnapshot().uncertain, true)
  assert.equal(await restored.manage(rename()), false); assert.equal(sent, 1); assert.equal((await f.storage.read(owner))?.receipt.phase, 'pending')
})

test('account, Host, machine and workspace identities isolate retained operations and corrupt owners are not replaced', async () => {
  const f = fixture(); f.context.services.mutations!.manage = async () => { throw new Error('Unknown source result') }
  await f.create().manage(rename())
  const others: SourceFileOwner[] = [ { ...owner, scope: 'another-account' },
    { ...owner, binding: { ...owner.binding, target: { ...owner.binding.target, hostId: 'another-host' } } },
    { ...owner, binding: { ...owner.binding, machineId: 'another-machine' } }, { ...owner, binding: { ...owner.binding, workspaceId: 'another-root-generation' } } ]
  for (const other of others) { const context = fileContext(other), model = new SourceFileMutation(context, f.journal); await model.load(); assert.equal(model.getSnapshot().request, null) }
  const row = (await f.storage.read(owner))!; f.storage.rows.set(sourceFileMutationKey(owner), { ...row, owner: others[0] })
  const restored = f.create(); assert.equal(await restored.manage(rename()), false); assert.match(restored.getSnapshot().storageError ?? '', /Wrong saved owner/)
})

test('a newer out-of-band receipt cannot be overwritten by an older late result', async () => {
  const f = fixture(), entered = deferred<void>(), reply = deferred<Result>()
  f.context.services.mutations!.manage = async () => { entered.resolve(); return reply.promise }
  const model = f.create(), flight = model.manage(rename()); await entered.promise
  const old = (await f.storage.read(owner))!, replacement = { ...old.receipt, operationId: crypto.randomUUID(), request: { action: 'create-file' as const, path: '/other' } }
  const newer = await f.storage.write(owner, old.revision, replacement); reply.resolve(applied(old.receipt.operationId))
  assert.equal(await flight, false); assert.deepEqual(await f.storage.read(owner), newer)
})

test('a delayed lock grant rechecks durable admission rather than replacing another window unknown operation', async () => {
  const storage = new SourceFileStorageFixture(), locks = new SourceFileLocksFixture(), requested = deferred<void>(), grant = deferred<void>(), context = fileContext(owner); let sent = 0
  const waitingJournal = createSourceFileMutations({ storage, locks: { held: locks.held.bind(locks), async exclusive<T>(key: string, action: () => Promise<T>) {
    requested.resolve(); await grant.promise; return locks.exclusive(key, action)
  } }, channel: null })
  context.services.mutations!.manage = async request => { sent++; return applied(request.operationId) }
  const waiting = new SourceFileMutation(context, waitingJournal), flight = waiting.manage({ action: 'create-file', path: '/source/new' }); await requested.promise
  const other = fixture({ storage, locks }); other.context.services.mutations!.manage = async () => { throw new Error('Lost first acknowledgement') }
  await other.create().manage(rename()); const unknown = await storage.read(owner); grant.resolve()
  assert.equal(await flight, false); assert.equal(sent, 0); assert.deepEqual(await storage.read(owner), unknown)
})

test('a stale review action cannot bypass another window active lock', async () => {
  const f = fixture(); f.context.services.mutations!.manage = async () => { throw new Error('Unconfirmed') }
  const model = f.create(); await model.manage(rename()); await model.inspect(); assert.equal(model.getSnapshot().canReview, true)
  const entered = deferred<void>(), release = deferred<void>(), flight = f.journal.exclusive(owner, model.getSnapshot().operationId!, async () => { entered.resolve(); await release.promise })
  await entered.promise; assert.equal(await model.review(), false); assert.equal((await f.storage.read(owner))?.receipt.phase, 'unknown'); release.resolve(); await flight
})

test('browser upload chunks remain binary and file bytes never enter the durable operation record', async () => {
  const f = fixture(), bytes = new TextEncoder().encode('sensitive upload bytes'), chunks: Uint8Array[] = []
  let transfer: Awaited<ReturnType<NonNullable<WorkspaceServices['uploads']>['begin']>>
  const services: WorkspaceServices = { ...f.context.services, uploads: {
    async begin(request) { transfer = { uploadId: crypto.randomUUID(), target: request.target, operationId: request.operationId, destination: request.destination,
      bytes: request.bytes, receivedBytes: 0, chunkBytes: 5, maxBytes: 1024 }; return transfer },
    async append(request) { chunks.push(request.data); return { receivedBytes: request.offset + request.data.length } },
    async finish() { return { status: 'applied', operationId: transfer.operationId, value: { kind: 'file', resource: { target: owner.binding.target, document: { kind: 'file', path: '/source/upload' } },
      file: { absolutePath: '/source/upload', version: 'opaque:uploaded', bytes: bytes.length } } } },
    async status() { return { state: 'uploading', transfer } }, async cancel() { return { state: 'cancelled' } },
  } }
  const model = new SourceFileMutation({ owner, services }, f.journal)
  assert.equal(await model.upload('/source/upload', new Blob([bytes])), true)
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes)); assert.equal(JSON.stringify([...f.storage.rows.values()]).includes('sensitive upload bytes'), false)
  assert.deepEqual(model.getSnapshot().request, { action: 'upload', path: '/source/upload', bytes: bytes.length, mimeType: 'application/octet-stream', uploadId: transfer!.uploadId })
})


function interruptedUpload() {
  const f = fixture(), data = new Uint8Array([0, 255, 1, 2, 3, 4]), offsets: number[] = []
  let transfer: Awaited<ReturnType<NonNullable<WorkspaceServices['uploads']>['begin']>>, begins = 0, finishes = 0, statuses = 0, loseBegin = false, loseFinish = false, interrupted = true
  let finished: Awaited<ReturnType<NonNullable<WorkspaceServices['uploads']>['finish']>> | undefined
  const services: WorkspaceServices = { ...f.context.services, uploads: {
    async begin(request) {
      begins++
      transfer ??= { uploadId: crypto.randomUUID(), target: request.target, operationId: request.operationId, destination: request.destination,
        bytes: request.bytes, receivedBytes: 0, chunkBytes: 2, maxBytes: 1024 }
      assert.equal(request.operationId, transfer.operationId)
      if (loseBegin) { loseBegin = false; throw new Error('Lost begin reply') }
      return transfer
    },
    async append(request) {
      const saved = (await f.storage.read(owner))!.receipt
      assert.equal(saved.request.action === 'upload' && saved.request.uploadId, transfer.uploadId)
      offsets.push(request.offset); transfer = { ...transfer, receivedBytes: request.offset + request.data.length }
      if (interrupted) { interrupted = false; throw new Error('Lost append reply') }
      return { receivedBytes: transfer.receivedBytes }
    },
    async finish() {
      finishes++
      finished = { status: 'applied', operationId: transfer.operationId, value: { kind: 'file', resource: { target: owner.binding.target, document: { kind: 'file', path: '/source/upload' } },
        file: { absolutePath: '/source/upload', version: 'opaque:uploaded', bytes: data.length } } }
      if (loseFinish) throw new Error('Lost finish reply')
      return finished
    },
    async status(request) { statuses++; assert.equal(request.uploadId, transfer.uploadId); return finished ? { state: 'finished', result: finished } : { state: 'uploading', transfer } },
    async cancel() { return { state: 'cancelled' } },
  } }
  const create = () => new SourceFileMutation({ owner, services }, f.journal)
  return { ...f, create, file: new Blob([data]), offsets, counts: () => ({ begins, finishes, statuses }),
    loseBegin: () => { loseBegin = true }, loseFinish: () => { loseFinish = true }, noInterruption: () => { interrupted = false } }
}

test('lost append acknowledgement resumes the original upload from authoritative status without resending confirmed bytes', async () => {
  const f = interruptedUpload(), model = f.create()
  assert.equal(await model.upload('/source/upload', f.file), false); const id = model.getSnapshot().operationId
  assert.equal(model.getSnapshot().hasUploadFile, true); await model.inspect()
  assert.deepEqual(f.offsets, [0]); assert.equal(f.counts().finishes, 0); assert.equal(model.getSnapshot().canReview, false)
  assert.equal(await model.resumeUpload(), true)
  assert.deepEqual(f.offsets, [0, 2, 4]); assert.equal(model.getSnapshot().operationId, id); assert.equal(f.counts().begins, 1)
})

test('refresh cannot resume without original bytes and reselected files require explicit matching intent', async () => {
  const f = interruptedUpload(), original = f.create(); await original.upload('/source/upload', f.file); original.dispose()
  const restored = f.create(); await restored.load(); assert.equal(restored.getSnapshot().hasUploadFile, false)
  assert.equal(await restored.resumeUpload(), false); assert.equal(await restored.resumeUpload(f.file), false)
  assert.equal(await restored.resumeUpload(new Blob(['wrong-size']), true), false); assert.deepEqual(f.offsets, [0])
  assert.equal(await restored.resumeUpload(f.file, true), true); assert.deepEqual(f.offsets, [0, 2, 4]); assert.equal(f.counts().begins, 1)
})

test('inspection consumes the original finished receipt and does not blindly repeat finish after its reply is lost', async () => {
  const f = interruptedUpload(); f.noInterruption(); f.loseFinish(); const original = f.create()
  assert.equal(await original.upload('/source/upload', f.file), false); original.dispose()
  const restored = f.create(); await restored.load(); await restored.inspect()
  assert.equal(restored.getSnapshot().phase, 'confirmed'); assert.equal(restored.getSnapshot().result?.status, 'applied')
  assert.equal(f.counts().finishes, 1); assert.equal(f.counts().begins, 1)
})

test('explicit recovery after a lost begin reply uses the original operation ID and does not admit a new upload', async () => {
  const f = interruptedUpload(); f.loseBegin(); f.noInterruption(); const model = f.create()
  assert.equal(await model.upload('/source/upload', f.file), false); const id = model.getSnapshot().operationId
  assert.deepEqual(f.offsets, []); assert.equal(await model.resumeUpload(), true)
  assert.equal(model.getSnapshot().operationId, id); assert.equal(f.counts().begins, 2); assert.equal(f.counts().finishes, 1)
})
