import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { SourceSession } from '../src/remote/protocol.ts'
import type { CodexCall } from '../src/remote/codex-access.ts'
import { codexInputSources } from '../src/client/remote-input-triggers.ts'
const id = 'hhpi:machine:source:codex:thread' as SessionId
const source = { id, sourceId: 'source', nativeId: 'thread', cwd: '/workspace', codex: { model: 'fixture' } } as SourceSession
const signal = new AbortController().signal
const session = { sessionId: id }

test('native slash submission preserves the original request after a lost reply and never blindly resends', async () => {
  const calls: CodexCall[] = [], receipts: CodexCall[] = []
  const api = { async nativeCall(request: CodexCall) { calls.push(request); throw new Error('lost reply') },
    async nativeReceipt(request: CodexCall) { receipts.push(request); return { ok: true, value: { status: 'accepted', message: 'confirmed' } } } } as unknown as HhpiRemoteApi
  const [slash] = codexInputSources(api, value => value === id ? source : undefined, () => true)
  const picked = slash!.onPick({ session, candidate: { name: 'compact' }, position: 'leading', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 0 } })
  assert.ok(picked && picked !== 'handled' && 'claim' in picked)
  const ctx = {} as Context
  assert.equal((await picked.claim.submit('', ctx, [])).kind, 'error')
  assert.equal((await picked.claim.submit('changed', ctx, [])).kind, 'error')
  assert.equal((await picked.claim.submit('', ctx, [])).kind, 'success')
  assert.equal(calls.length, 1); assert.deepEqual(receipts, calls)
  assert.equal(calls[0]!.params.threadId, 'thread')
  assert.deepEqual(await slash!.candidates({ sessionId: 'ordinary' as SessionId }, { query: '', position: 'leading', drilled: false, signal }), [])
})

test('at-reference candidates read the native workspace and serialize the selected path through the official codec', async () => {
  const calls: CodexCall[] = []
  const api = { async nativeCall(request: CodexCall) { calls.push(request); return { ok: true, value: { status: 'accepted', result: request.method === 'fs/readDirectory'
    ? { entries: [{ fileName: 'hello world.txt', isFile: true, isDirectory: false }] }
    : { files: [{ path: 'src/index.ts', root: '/workspace' }] } } } } } as unknown as HhpiRemoteApi
  const [, at] = codexInputSources(api, () => source, () => true)
  const rows = await at!.candidates(session, { query: '', position: 'inline', drilled: false, signal })
  const pick = at!.onPick({ session, candidate: rows[0]!, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 0 } })
  assert.ok(pick && pick !== 'handled' && 'insert' in pick)
  assert.equal(pick.insert.ref, '/workspace/hello world.txt')
  assert.equal(await at!.codec!.serialize(pick.insert.ref, signal), 'Referenced workspace path: "/workspace/hello world.txt"')
  await at!.candidates(session, { query: 'index', position: 'inline', drilled: false, signal })
  assert.deepEqual(calls.map(call => [call.method, call.params]), [['fs/readDirectory', { path: '/workspace' }], ['fuzzyFileSearch', { query: 'index', roots: ['/workspace'] }]])
})


test('retained Pane command candidates use their bound source even without a canonical owner in the installer context', async () => {
  const [slash] = codexInputSources({} as HhpiRemoteApi, () => undefined, () => true)
  const binding = { session: { metadata: { getSnapshot: () => source } } } as unknown as import('@deepseek-ai/dsh-api-session-controller/client').SessionBinding
  const rows = await slash!.candidates({ sessionId: id, binding }, { query: 'compact', position: 'leading', drilled: false, signal })
  assert.deepEqual(rows.map(row => row.name), ['compact'])
})
