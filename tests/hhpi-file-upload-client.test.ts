/** Actual attachment provider and preparation; source services and browser raster APIs are boundary fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { FileUploadProvider } from '@deepseek-ai/dsh-client-file-upload/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { installRemoteFileUpload } from '../src/client/remote-file-upload.ts'
import { captureSourceUploadIntents, restoreSourceUploadIntents, cancelSourceUpload } from '../src/client/source-upload-intent.ts'
import type { SourceFileClient } from '../src/client/source-workspace-provider.ts'
import type { WorkspaceServices, WorkspaceUploadService } from '../src/workspace/service-types.ts'
const session = 'hhpi:machine:source:codex:thread' as SessionId
const binding = { target: { hostId: 'selected-host', sessionId: session }, machineId: 'machine', workspaceId: 'source', root: '/source', pathStyle: 'posix' as const }
function fixture(service: WorkspaceUploadService, checkpoint?: Parameters<typeof installRemoteFileUpload>[2], resolving?: () => Promise<void>) {
  let provider!: FileUploadProvider, disposed = false
  const ctx = { fileUpload: { registerProvider(value: FileUploadProvider) { provider = value; return () => { disposed = true } } } } as unknown as Context
  const client: SourceFileClient = { async resolve(id, signal) { assert.equal(id, session); signal.throwIfAborted();
    await resolving?.(); signal.throwIfAborted()
    return { owner: { scope: 'account', binding }, services: { binding, uploads: service } as unknown as WorkspaceServices } } }
  const stop = installRemoteFileUpload(ctx, client, checkpoint)
  return { provider, stop, get disposed() { return disposed } }
}
function source(events: string[] = []) {
  let transfer: Awaited<ReturnType<WorkspaceUploadService['begin']>>, finished: Awaited<ReturnType<WorkspaceUploadService['finish']>> | undefined
  const chunks: Uint8Array[] = [], operations: string[] = []; let lostAppend = false, loseNext = false, commits = 0, image = false, cancelled = false
  const service: WorkspaceUploadService = {
    async begin(request) { events.push('begin upload'); operations.push(request.operationId); image = request.mimeType.startsWith('image/');
      if (transfer?.operationId === request.operationId) return transfer
      transfer = { ...request, uploadId: 'transfer', receivedBytes: 0, chunkBytes: 256 * 1024, maxBytes: 64 * 1024 * 1024 }; return transfer },
    async status() { return cancelled ? { state: 'cancelled' } : finished ? { state: 'finished', result: finished } : { state: 'uploading', transfer } },
    async append(request) { assert.equal(request.offset, transfer.receivedBytes); assert.deepEqual(request.target, binding.target);
      chunks.push(request.data); transfer = { ...transfer, receivedBytes: transfer.receivedBytes + request.data.length };
      if (loseNext && !lostAppend) { lostAppend = true; throw new Error('chunk reply lost') } return { receivedBytes: transfer.receivedBytes } },
    async finish() { commits++; finished = { status: 'applied', operationId: transfer.operationId,
      value: { kind: 'attachment', resource: { target: binding.target, document: { kind: 'artifact', id: 'receipt' } }, value: image
        ? { receiptId: 'receipt' as never, image: { attachmentId: 'stored' as never, mediaType: 'image/png', bytes: transfer.bytes, width: 327, height: 8192, name: 'shot.png' } }
        : { receiptId: 'receipt' as never, file: { attachmentId: 'stored' as never, name: 'test.txt', bytes: transfer.bytes } } } }; return finished },
    async cancel() { cancelled = true; return { state: 'cancelled' } },
  }
  return { service, chunks, operations, get commits() { return commits }, loseAppend() { loseNext = true } }
}
test('native provider transfers files beyond the old base64 cap in bounded raw chunks with confirmed progress', async () => {
  const s = source(), f = fixture(s.service), size = 7 * 1024 * 1024, data = new Uint8Array(size); data[1] = 128; data[size - 1] = 255
  assert.equal(f.provider.matches(session), true); assert.equal(f.provider.matches('ordinary' as SessionId), false)
  const progress: number[] = []
  const result = await f.provider.upload(session, data, 'test.txt', undefined, value => progress.push(value.loaded))
  assert.equal(result.ok && result.value.file.bytes, size); assert.equal(s.chunks.length, 28)
  assert.deepEqual(Buffer.concat(s.chunks), Buffer.from(data)); assert.equal(progress.at(-1), size)
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]!))
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(f.provider.upload(session, data, 'test.txt', aborted.signal), { name: 'AbortError' })
  assert.equal(s.operations.length, 1); f.stop(); assert.equal(f.disposed, true)
})
test('retry after a lost chunk reply resumes its durable offset and does not publish twice', async () => {
  const s = source(), f = fixture(s.service), data = new Blob([new Uint8Array(300_000)])
  s.loseAppend()
  await assert.rejects(f.provider.upload(session, data, 'test.txt'), /reply lost/)
  await f.provider.upload(session, data, 'test.txt')
  await f.provider.upload(session, data, 'test.txt')
  assert.equal(s.operations.length, 1); assert.equal(s.commits, 1); assert.equal(Buffer.concat(s.chunks).length, data.size)
})
test('a tall screenshot inside source limits uploads its exact original without a canvas resize', async t => {
  const events: string[] = [], s = source(events), f = fixture(s.service)
  const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { events.push('local decode'); return { width: 400, height: 40000, close() {} } } })
  let canvas: { width: number; height: number }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() { return canvas = { width: 0, height: 0,
    getContext() { return { clearRect() {}, drawImage() {} } }, toBlob(done: (value: Blob) => void) { events.push('local encode'); done(new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' })) } } as typeof canvas } } })
  t.after(() => { for (const [name, old] of [['createImageBitmap', oldBitmap], ['document', oldDocument]] as const) {
    if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name)
  } })
  const original = new Blob([new Uint8Array(100)], { type: 'image/png' })
  const result = await f.provider.uploadImage!(session, original, 'image/png', 'shot.png')
  assert.deepEqual(events, ['local decode', 'begin upload'])
  assert.deepEqual(s.chunks, [new Uint8Array(100)]); assert.equal(canvas!, undefined)
  assert.equal(result.ok && result.value.receiptId, 'receipt'); assert.equal(original.size, 100)
})
test('restoring durable attachment bytes after a refresh resumes the original source operation', async () => {
  const s = source(), old = fixture(s.service), original = new File([new Uint8Array(300_000)], 'test.txt')
  s.loseAppend()
  await assert.rejects(old.provider.upload(session, original, original.name), /reply lost/)
  const saved = structuredClone({ blob: original, uploads: captureSourceUploadIntents(original, session) })
  old.stop()
  const restored = new File([saved.blob], 'test.txt'); restoreSourceUploadIntents(restored, saved.uploads)
  const current = fixture(s.service)
  await current.provider.upload(session, restored, restored.name)
  assert.equal(s.operations.length, 2); assert.equal(new Set(s.operations).size, 1)
  assert.equal(s.commits, 1); assert.equal(Buffer.concat(s.chunks).length, original.size)
  assert.notEqual(captureSourceUploadIntents(restored, 'another-session').find(([id]) => id === 'another-session')![1].operationId, s.operations[0])
})
test('an image retry preserves older prepared bytes and an acknowledged prefix after preparation policy changes', async () => {
  const s = source(), f = fixture(s.service), original = new File(['retained original image'], 'original.png', { type: 'image/png' })
  const prepared = new Blob([new Uint8Array(300_000).fill(17)], { type: 'image/webp' }), operationId = crypto.randomUUID()
  restoreSourceUploadIntents(original, [[session, { operationId, prepared }]])
  s.loseAppend()
  await assert.rejects(f.provider.uploadImage!(session, original, original.type, original.name), /reply lost/)
  await f.provider.uploadImage!(session, original, original.type, original.name)
  assert.equal(new Set(s.operations).size, 1)
  assert.equal(s.operations[0], operationId)
  assert.deepEqual(Buffer.concat(s.chunks), Buffer.from(await prepared.arrayBuffer()), 'resuming never replaces an existing prefix with a new encoding')
  assert.equal(s.commits, 1)
  assert.equal(await original.text(), 'retained original image')
})
test('only explicit attachment removal cancels staged source bytes', async () => {
  const s = source(), f = fixture(s.service), original = new File([new Uint8Array(300_000)], 'test.txt')
  s.loseAppend()
  await assert.rejects(f.provider.upload(session, original, original.name), /reply lost/)
  cancelSourceUpload(original, session)
  await new Promise(resolve => setImmediate(resolve))
  const access = { scope: 'account', signal: new AbortController().signal, assertAllowed() {} }
  assert.equal((await s.service.status({ target: binding.target, uploadId: 'transfer' }, access)).state, 'cancelled')
})

test('removing an attachment while its durable begin reply is delayed cancels that original transfer', async () => {
  const s = source(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>()
  const service: WorkspaceUploadService = { ...s.service, async begin(request, access) {
    const transfer = await s.service.begin(request, access); entered.resolve(); await reply.promise; return transfer
  } }
  const f = fixture(service), file = new File(['original'], 'test.txt'), input = new AbortController()
  const upload = f.provider.upload(session, file, file.name, input.signal)
  await entered.promise
  cancelSourceUpload(file, session); input.abort(); reply.resolve()
  await assert.rejects(upload, /removed|abort/i)
  await new Promise(resolve => setImmediate(resolve))
  const access = { scope: 'account', signal: new AbortController().signal, assertAllowed() {} }
  assert.equal((await service.status({ target: binding.target, uploadId: 'transfer' }, access)).state, 'cancelled')
  assert.equal(s.chunks.length, 0); assert.equal(s.commits, 0)
})

test('a view ending during begin retains its original resumable transfer instead of cancelling it', async () => {
  const s = source(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>()
  const service: WorkspaceUploadService = { ...s.service, async begin(request, access) {
    const transfer = await s.service.begin(request, access); entered.resolve(); await reply.promise; return transfer
  } }
  const f = fixture(service), file = new File(['original'], 'test.txt'), input = new AbortController()
  const upload = f.provider.upload(session, file, file.name, input.signal)
  await entered.promise; input.abort(); reply.resolve(); await assert.rejects(upload, { name: 'AbortError' })
  const access = { scope: 'account', signal: new AbortController().signal, assertAllowed() {} }
  assert.equal((await service.status({ target: binding.target, uploadId: 'transfer' }, access)).state, 'uploading')
  await f.provider.upload(session, file, file.name)
  assert.equal(new Set(s.operations).size, 1); assert.equal(s.commits, 1)
})

test('source admission waits for the exact prepared-byte checkpoint and a storage failure keeps the upload unstarted', async () => {
  const s = source(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>()
  let fail = true
  const f = fixture(s.service, async (id, data) => {
    const saved = captureSourceUploadIntents(data, id)
    assert.equal(await saved[0]![1].prepared!.text(), 'original')
    entered.resolve(); await reply.promise
    if (fail) throw new Error('Draft storage quota exceeded; original file retained')
  })
  const file = new File(['original'], 'test.txt'), pending = f.provider.upload(session, file, file.name)
  await entered.promise; assert.equal(s.operations.length, 0)
  reply.resolve(); await assert.rejects(pending, /storage quota/)
  assert.equal(s.operations.length, 0); assert.equal(s.commits, 0)
  fail = false; await f.provider.upload(session, file, file.name)
  assert.equal(s.operations.length, 1); assert.equal(s.commits, 1)
})

test('local image preparation overlaps source resolution while durable admission still waits for both', async t => {
  const ownerEntered = Promise.withResolvers<void>(), ownerReply = Promise.withResolvers<void>(), decodeEntered = Promise.withResolvers<void>(), decodeReply = Promise.withResolvers<void>()
  const checkpointEntered = Promise.withResolvers<void>(), checkpointReply = Promise.withResolvers<void>(), s = source()
  const oldBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => {
    decodeEntered.resolve(); await decodeReply.promise; return { width: 10, height: 10, close() {} }
  } })
  t.after(() => { if (oldBitmap) Object.defineProperty(globalThis, 'createImageBitmap', oldBitmap); else Reflect.deleteProperty(globalThis, 'createImageBitmap') })
  let decoded = false; void decodeEntered.promise.then(() => { decoded = true })
  const f = fixture(s.service, async () => { checkpointEntered.resolve(); await checkpointReply.promise }, async () => { ownerEntered.resolve(); await ownerReply.promise })
  const file = new File(['image bytes'], 'small.png', { type: 'image/png' }), upload = f.provider.uploadImage!(session, file, file.type, file.name)
  await ownerEntered.promise; await Promise.resolve()
  assert.equal(decoded, true, 'local decoding must begin before the source response arrives')
  assert.equal(s.operations.length, 0)
  ownerReply.resolve(); await Promise.resolve(); assert.equal(s.operations.length, 0)
  decodeReply.resolve(); await checkpointEntered.promise; assert.equal(s.operations.length, 0)
  checkpointReply.resolve(); await upload; assert.equal(s.operations.length, 1)
})

test('the installed public FileUpload service routes HHPI to its source provider and preserves the ordinary DSH carrier', async t => {
  const require = createRequire(import.meta.url), ctx = new Context(), s = source()
  t.after(async () => { await ctx.fiber.dispose() })
  const metadata = require('@deepseek-ai/dsh-client-file-upload/package.json')
  assert.equal(metadata.version, '0.2.2-rc.1')
  let official!: { factory(resolve: NodeRequire): { apply(ctx: Context): void } }
  new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-file-upload/client'), 'utf8'))({
    __ModuleLoader__: { load(value: typeof official) { official = value } },
  })
  let ordinary = 0
  ctx.reflect.provide('remote', { fileUploads: { upload(id: string) { assert.equal(id, 'ordinary'); ordinary++; return { ok: true, value: {} } } } })
  await ctx.plugin(official.factory(require).apply)
  const client: SourceFileClient = { async resolve(id) {
    assert.equal(id, session)
    return { owner: { scope: 'account', binding }, services: { binding, uploads: s.service } as unknown as WorkspaceServices }
  } }
  let checkpoints = 0
  const stop = installRemoteFileUpload(ctx, client, async () => { checkpoints++ })
  const uploaded = await ctx.fileUpload.upload(session, Uint8Array.of(128, 255), 'test.txt')
  assert.equal(uploaded.ok && uploaded.value.receiptId, 'receipt'); assert.equal(checkpoints, 1); assert.equal(ordinary, 0)
  await ctx.fileUpload.upload('ordinary' as SessionId, Uint8Array.of(1), 'ordinary.txt')
  assert.equal(ordinary, 1)
  stop()
})
