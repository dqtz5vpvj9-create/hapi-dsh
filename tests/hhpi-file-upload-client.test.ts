import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { FileUploadProvider } from '@deepseek-ai/dsh-client-file-upload/client'
import { installRemoteFileUpload } from '../src/client/remote-file-upload.ts'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
test('official upload provider preserves source routing, bytes, cancellation, and rejects oversized bodies before transport', async () => {
  let provider!: FileUploadProvider
  let disposed = false
  const requests: unknown[] = []
  const ctx = { fileUpload: { registerProvider(value: FileUploadProvider) { provider = value; return () => { disposed = true } } } } as unknown as Context
  const api = { async upload(request: unknown) { requests.push(request); return { ok: true, value: { receiptId: 'fixture', file: { attachmentId: 'fixture', name: 'test.txt', bytes: 3 } } } } } as unknown as HhpiRemoteApi
  const stop = installRemoteFileUpload(ctx, api)
  const session = 'hhpi:machine:source:codex:thread' as SessionId
  assert.equal(provider.matches(session), true); assert.equal(provider.matches('ordinary' as SessionId), false)
  await provider.upload(session, new Uint8Array([0, 128, 255]), 'test.txt')
  assert.deepEqual(requests[0], { sessionId: session, name: 'test.txt', data: 'AID/', operationId: (requests[0] as { operationId: string }).operationId })
  await assert.rejects(provider.upload(session, new Uint8Array(6 * 1024 * 1024 + 1)), /limit/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(provider.upload(session, new Uint8Array([1]), 'cancelled', cancelled.signal), { name: 'AbortError' })
  assert.equal(requests.length, 1)
  stop(); assert.equal(disposed, true)
})


test('selected images finish local optimization before any source upload and use the real source receipt', async t => {
  let provider!: FileUploadProvider
  const events: string[] = [], requests: { data: string }[] = []
  const ctx = { fileUpload: { registerProvider(value: FileUploadProvider) { provider = value; return () => {} } } } as unknown as Context
  const api = { async upload(request: { data: string }) { events.push('remote upload'); requests.push(request); return { ok: true, value: { receiptId: 'receipt', file: { attachmentId: 'stored', name: 'shot.png', bytes: 3 } } } } } as unknown as HhpiRemoteApi
  const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { events.push('local decode'); return { width: 2, height: 2, close() {} } } })
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() { return { getContext() { return { clearRect() {}, drawImage() {} } }, toBlob(done: (value: Blob) => void) { events.push('local encode'); done(new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' })) } } } } })
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: class { result = ''; onload?: () => void; readAsDataURL() { this.result = 'data:image/png;base64,AQID'; this.onload?.() } } })
  t.after(() => { for (const [name, descriptor] of [['document', originalDocument], ['FileReader', originalReader], ['createImageBitmap', originalBitmap]] as const) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) } })
  installRemoteFileUpload(ctx, api)
  const result = await provider.uploadImage!('hhpi:machine:source:codex:thread' as SessionId, new Blob([new Uint8Array(7 * 1024 * 1024)], { type: 'image/png' }), 'image/png', 'shot.png')
  assert.deepEqual(events, ['local decode', 'local encode', 'local decode', 'remote upload'])
  assert.deepEqual(requests.map(value => value.data), ['AQID'])
  assert.equal(result.ok && result.value.receiptId, 'receipt')
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(provider.uploadImage!('hhpi:machine:source:codex:thread' as SessionId, new Blob(), 'image/png', 'shot.png', aborted.signal), { name: 'AbortError' })
  assert.equal(requests.length, 1)
})
