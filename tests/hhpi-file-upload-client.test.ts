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
