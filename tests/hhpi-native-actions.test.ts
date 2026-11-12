/** Production action owner and transactional ledger; only RPC/browser Storage are controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeActionOwner, type NativeActionInput } from '../src/client/remote-native-actions.ts'
import { RemoteOperationLedger } from '../src/client/remote-operation-ledger.ts'
import { confirmedNativeArchive, nativeActionKey } from '../src/client/remote-operation-contracts.ts'
import { clearSourceStorage, nativeActionStoragePrefix } from '../src/client/remote-storage.ts'
import type { CodexCall, CodexCallResult } from '../src/remote/codex-access.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'

const sessionId = 'hhpi:machine:source:codex:parent'
const input = (name = 'new title'): NativeActionInput => ({ sessionId, intent: 'rename', kind: 'rename',
  request: { sourceId: 'source', method: 'thread/name/set', params: { threadId: 'parent', name } } })
const accepted: CodexCallResult = { status: 'accepted', message: 'The native source accepted the original operation.' }
const transport = () => ({ async call() { return accepted }, async receipt() { return accepted } })

test('two Pane/tab owners claim one intent atomically and keep the addressed source', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'same-account' }
  const reply = Promise.withResolvers<CodexCallResult>(), entered = Promise.withResolvers<void>()
  const calls: Array<{ request: CodexCall; target: string }> = []
  const wire = { async call(request: CodexCall, target: string) { calls.push({ request, target }); entered.resolve(); return reply.promise }, async receipt() { return accepted } }
  const a = new NativeActionOwner(wire), b = new NativeActionOwner(wire)
  t.after(() => { a.dispose(); b.dispose() }); a.setStorage(access); b.setStorage(access)
  const first = a.submit(input()), second = b.submit(input())
  await entered.promise
  assert.equal((await second).phase, 'dispatching')
  assert.equal(calls.length, 1); assert.equal(calls[0]!.target, sessionId)
  reply.resolve(accepted)
  const result = await first
  assert.equal(result.phase, 'accepted')
  assert.equal((await b.recover(sessionId, 'rename'))!.request.operationId, result.request.operationId)
  assert.equal((await b.recover(sessionId, 'rename'))!.phase, 'accepted')
  assert.equal(calls.length, 1)
})

test('reload and reconnect restore locally; explicit recovery queries only the original unknown request', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'reload' }, writes: CodexCall[] = [], reads: CodexCall[] = []
  const action = { ...input(), kind: 'fork' as const, intent: 'fork:turn-a', request: { sourceId: 'source', method: 'thread/fork', params: { threadId: 'parent' } } }
  const first = new NativeActionOwner({ async call(request) { writes.push(request); throw new Error('Response lost after source execution') }, async receipt() { throw new Error('unused') } })
  first.setStorage(access)
  const unknown = await first.submit(action); assert.equal(unknown.phase, 'confirming'); first.dispose()
  const next = new NativeActionOwner({ async call(request) { writes.push(request); return accepted }, async receipt(request) {
    reads.push(request); return { ...accepted, result: { thread: { id: 'exact-child', settings: { token: 'must-not-store' } }, token: 'must-not-store' } }
  } }); t.after(() => next.dispose()); next.setStorage(access)
  await next.restore(); await next.restore()
  assert.equal(writes.length, 1); assert.equal(reads.length, 0)
  assert.equal(next.get(sessionId, action.intent)?.phase, 'confirming')
  assert.equal((await next.submit(action)).phase, 'confirming', 'mount/click repetition cannot turn uncertainty into replay')
  const result = await next.recover(sessionId, action.intent)
  assert.deepEqual(reads, [unknown.request]); assert.equal(writes.length, 1)
  assert.equal(result?.outcome?.targetNativeId, 'exact-child')
  const raw = await new RemoteOperationLedger(access).read(nativeActionKey(sessionId, action.intent))
  assert.ok(raw && !raw.includes('must-not-store'))
  assert.ok(!storage.getItem(storage.key(0)!)!.includes('thread/fork'), 'localStorage contains only the small index')
})

test('an absent or denied receipt and matching requested metadata never settle an unknown action', async t => {
  const storage = new BrowserStorage(); let calls = 0, lookups = 0
  const owner = new NativeActionOwner({ async call() { calls++; throw new Error('lost') }, async receipt() {
    lookups++
    if (lookups === 1) throw new Error('Receipt permission denied')
    return { status: 'indeterminate', message: 'No original receipt; the visible title already happens to match.', result: { name: 'new title' } }
  } }); t.after(() => owner.dispose()); owner.setStorage({ storage, scope: 'unknown' })
  const original = await owner.submit(input())
  assert.equal((await owner.recover(sessionId, 'rename'))?.phase, 'confirming')
  assert.equal((await owner.recover(sessionId, 'rename'))?.phase, 'confirming')
  assert.equal((await owner.submit(input())).request.operationId, original.request.operationId)
  assert.equal(calls, 1); assert.equal(lookups, 2)
})

test('changed pending payloads are refused; a settled intent needs an explicit new attempt', async t => {
  const storage = new BrowserStorage(), requests: CodexCall[] = [], gate = Promise.withResolvers<CodexCallResult>(), entered = Promise.withResolvers<void>()
  const owner = new NativeActionOwner({ async call(request) { requests.push(request); entered.resolve(); return requests.length === 1 ? gate.promise : accepted }, async receipt() { return accepted } })
  t.after(() => owner.dispose()); owner.setStorage({ storage, scope: 'attempts' })
  const first = owner.submit(input()); await entered.promise
  const changed = owner.submit(input('other title'))
  gate.resolve(accepted)
  await assert.rejects(changed, /another native action/)
  const result = await first
  assert.equal((await owner.submit(input())).request.operationId, result.request.operationId)
  await assert.rejects(owner.submit(input('other title')), /new attempt/)
  const second = await owner.submit({ ...input('other title'), replaceSettled: true })
  assert.notEqual(second.request.operationId, result.request.operationId); assert.equal(requests.length, 2)
})

test('quota failure and a foreign source/thread never dispatch or lose the original intent', async t => {
  const storage = new BrowserStorage(); let writes = 0
  const owner = new NativeActionOwner({ ...transport(), async call() { writes++; return accepted } })
  t.after(() => owner.dispose()); owner.setStorage({ storage, scope: 'admission' }); storage.failWrites = true
  await assert.rejects(owner.submit(input()), /Synthetic full storage/)
  assert.equal(writes, 0); assert.equal(storage.length, 0)
  storage.failWrites = false
  await assert.rejects(owner.submit({ ...input(), request: { ...input().request, params: { threadId: 'different-thread' } } }), /different source/)
  await owner.submit(input()); assert.equal(writes, 1)
})

test('a crash after preparation restores an unsent intent without a mount write', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'prepared' }; let writes = 0, transitions = 0
  const ledger = new RemoteOperationLedger(access)
  const first = new NativeActionOwner({ ...transport(), async call() { writes++; return accepted } }, { createLedger: () => ({ read: id => ledger.read(id), async transition(id, update, mirror) {
    if (++transitions === 2) throw new Error('Synthetic crash before dispatch claim')
    return ledger.transition(id, update, mirror)
  } }) })
  first.setStorage(access); await assert.rejects(first.submit(input()), /Synthetic crash/); first.dispose()
  const next = new NativeActionOwner({ ...transport(), async call() { writes++; return accepted } }); t.after(() => next.dispose()); next.setStorage(access)
  await next.restore(); const originalId = next.get(sessionId, 'rename')!.request.operationId
  assert.equal(next.get(sessionId, 'rename')?.phase, 'prepared'); assert.equal(writes, 0)
  assert.equal((await next.recover(sessionId, 'rename'))?.phase, 'prepared'); assert.equal(writes, 0)
  assert.equal((await next.submit(input())).request.operationId, originalId); assert.equal(writes, 1)
})

test('account changes discard late restore/result publications and never bind the old namespace', async t => {
  const storage = new BrowserStorage(), a = { storage, scope: 'account-a' }, b = { storage, scope: 'account-b' }
  const original = new NativeActionOwner({ async call() { throw new Error('lost') }, async receipt() { return accepted } })
  original.setStorage(a); await original.submit(input()); original.dispose()
  const gate = Promise.withResolvers<string | null | undefined>(), readStarted = Promise.withResolvers<void>()
  const owner = new NativeActionOwner(transport(), { createLedger: access => {
    const ledger = new RemoteOperationLedger(access)
    return { transition: (id, update, mirror) => ledger.transition(id, update, mirror), async read(id) {
      if (access.scope === a.scope) { readStarted.resolve(); return gate.promise }
      return ledger.read(id)
    } }
  } }); t.after(() => owner.dispose()); owner.setStorage(a); await readStarted.promise
  owner.setStorage(b); await owner.restore()
  gate.resolve(await new RemoteOperationLedger(a).read(nativeActionKey(sessionId, 'rename')))
  await Promise.resolve()
  assert.equal(owner.view(sessionId).getSnapshot().length, 0)
  const result = await owner.submit(input('account b title'))
  assert.equal(result.phase, 'accepted')
  assert.equal((await new RemoteOperationLedger(a).read(nativeActionKey(sessionId, 'rename')))!.includes('account b title'), false)
})

test('account revocation retires canonical native records and a late response cannot recreate them', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'revoked' }, gate = Promise.withResolvers<CodexCallResult>(), entered = Promise.withResolvers<void>()
  storage.setItem('official-unsent-draft', 'keep')
  const owner = new NativeActionOwner({ async call() { entered.resolve(); return gate.promise }, async receipt() { return accepted } }); t.after(() => owner.dispose()); owner.setStorage(access)
  const pending = owner.submit(input()); await entered.promise
  clearSourceStorage(storage)
  const rejected = assert.rejects(pending, /scope changed/)
  gate.resolve(accepted); await rejected
  assert.equal(owner.view(sessionId).getSnapshot().length, 0)
  assert.equal(await new RemoteOperationLedger(access).read(nativeActionKey(sessionId, 'rename')), null)
  assert.equal(storage.getItem('official-unsent-draft'), 'keep')
  assert.ok(Array.from({ length: storage.length }, (_, i) => storage.key(i)).every(key => !key?.startsWith(nativeActionStoragePrefix(access.scope))))
})

test('source revocation retires only that target and blocks its late response', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'source-revoke' }, gate = Promise.withResolvers<CodexCallResult>(), entered = Promise.withResolvers<void>()
  const other = { ...input(), sessionId: 'hhpi:machine:source:codex:other', request: { ...input().request, params: { threadId: 'other', name: 'other title' } } }
  let writes = 0
  const owner = new NativeActionOwner({ async call(_request, target) {
    writes++
    if (target === sessionId && writes === 1) { entered.resolve(); return gate.promise }
    return accepted
  }, async receipt() { return accepted } }); t.after(() => owner.dispose()); owner.setStorage(access)
  const pending = owner.submit(input()); await entered.promise
  await owner.submit(other); await owner.revokeSession(sessionId)
  const rejected = assert.rejects(pending, /was revoked/); gate.resolve(accepted); await rejected
  assert.equal(owner.view(sessionId).getSnapshot().length, 0)
  assert.equal(owner.get(other.sessionId, 'rename')?.phase, 'accepted')
  assert.equal(await new RemoteOperationLedger(access).read(nativeActionKey(sessionId, 'rename')), null)
  await assert.rejects(owner.submit(input()), /was revoked/)
  await assert.rejects(owner.submit({ ...input(), newAttempt: true }), /was revoked/, 'the revoked instance cannot regain source authority from a UI flag')
  assert.equal(writes, 2)
})


test('an unknown restore retains the accepted archive across reload until its original receipt confirms', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'archive-state' }, writes: CodexCall[] = []
  const owner = new NativeActionOwner({ async call(request) { writes.push(request); if (writes.length === 2) throw new Error('Restore reply lost'); return accepted }, async receipt() { return accepted } })
  owner.setStorage(access)
  const archive: NativeActionInput = { sessionId, intent: 'archive', kind: 'archive', request: { sourceId: 'source', method: 'thread/archive', params: { threadId: 'parent' } }, newAttempt: true }
  const first = await owner.submit(archive)
  const restore = { ...archive, request: { ...archive.request, method: 'thread/unarchive' } }
  const unknown = await owner.submit(restore)
  assert.equal(unknown.phase, 'confirming')
  assert.deepEqual(confirmedNativeArchive(unknown), { archived: true, operationId: first.request.operationId })
  owner.dispose()
  let reads = 0
  const reopened = new NativeActionOwner({ async call() { throw new Error('Reload cannot replay') }, async receipt(request) { reads++; assert.equal(request.operationId, unknown.request.operationId); return accepted } })
  t.after(() => reopened.dispose()); reopened.setStorage(access); await reopened.restore()
  assert.equal(confirmedNativeArchive(reopened.get(sessionId, 'archive'))?.archived, true)
  await assert.rejects(reopened.submit(archive), /another native action/)
  assert.equal(confirmedNativeArchive(await reopened.recover(sessionId, 'archive'))?.archived, false)
  assert.equal(writes.length, 2); assert.equal(reads, 1)
})
