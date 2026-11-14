/** Production browser creation state plus source creation ledger; RPC and Storage are explicit boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { RemoteCreationController, creationStoragePrefix } from '../src/client/remote-creation.ts'
import { RemoteOperationLedger } from '../src/client/remote-operation-ledger.ts'
import { clearSourceStorage } from '../src/client/remote-storage.ts'
import { CreationLedger } from '../src/remote/operation-ledger.ts'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { SourceCreateRequest, SourceCreationReceipt, SourceSession } from '../src/remote/protocol.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'

const source = { id: 'source', machineId: 'machine', engine: 'codex', create: true, online: true }
const session: SourceSession = { id: 'hhpi:machine:source:codex:exact-native', machineId: source.machineId, sourceId: source.id, engine: source.engine, nativeId: 'exact-native',
  title: 'Same title', cwd: '/repo', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
const ok = <T>(value: T) => ({ ok: true as const, value })
const accepted = (request: SourceCreateRequest): SourceCreationReceipt => ({ sourceId: request.sourceId, operationId: request.operationId, status: 'accepted', message: 'Native thread created.', session })
function readApi() {
  return { catalog: async () => ok({ protocol: 1 as const, legacyHapi: false, sources: [source], sessions: [session] }), resolve: async () => ok(session) }
}

test('lost reply plus browser/source restart preserves the exact creation request and never starts another native thread', async t => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-creation-ui-'); t.after(() => rm(directory, { recursive: true, force: true }))
  const storage = new BrowserStorage(), access = { storage, scope: 'creation-restart' }, calls: SourceCreateRequest[] = []
  let nativeStarts = 0, loseReply = true
  const api = { ...readApi(), async create(request: SourceCreateRequest) {
    calls.push(request)
    const result = await new CreationLedger(directory, 'same-native-source').run(request, async () => { nativeStarts++; return accepted(request) })
    if (loseReply) { loseReply = false; throw new Error('Source committed; browser reply lost') }
    return ok(result)
  } }
  const first = new RemoteCreationController(api, access, { operationId: () => 'original-create' })
  assert.equal((await first.start(source, '/repo'))?.phase, 'confirming'); first.dispose()
  const next = new RemoteCreationController(api, access, { operationId: () => 'must-not-replace' }); t.after(() => next.dispose()); await next.ready()
  assert.equal(calls.length, 1); assert.equal(next.getSnapshot().record?.request.operationId, 'original-create')
  assert.equal(await next.start({ ...source, id: 'other-source' }, '/another'), null)
  assert.equal(calls.length, 1)
  const result = await next.recover()
  assert.equal(result?.phase, 'accepted'); assert.deepEqual(calls, [calls[0], calls[0]])
  assert.equal(nativeStarts, 1)
  assert.equal((await next.resolveTarget()).id, session.id)
  assert.equal(calls.length, 2, 'opening resolves the exact target without another create carrier call')
})

test('two forms atomically claim one prepared creation before their first source request', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'two-forms' }, entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<SourceCreationReceipt>()
  const requests: SourceCreateRequest[] = []
  const api = { ...readApi(), async create(request: SourceCreateRequest) { requests.push(request); entered.resolve(); return ok(await gate.promise) } }
  const a = new RemoteCreationController(api, access), b = new RemoteCreationController(api, access); t.after(() => { a.dispose(); b.dispose() })
  const first = a.start(source, '/repo'), second = b.start(source, '/repo')
  await entered.promise; assert.equal((await second)?.phase, 'dispatching'); assert.equal(requests.length, 1)
  gate.resolve(accepted(requests[0]!)); assert.equal((await first)?.target?.id, session.id)
})

test('a missing exact target and matching catalog title/directory cannot confirm creation', async t => {
  const storage = new BrowserStorage(); let creates = 0
  const api = { ...readApi(), async create(request: SourceCreateRequest) { creates++; return ok({ ...accepted(request), session: undefined } as SourceCreationReceipt) } }
  const owner = new RemoteCreationController(api, { storage, scope: 'no-target' }); t.after(() => owner.dispose())
  assert.equal((await owner.start(source, '/repo'))?.phase, 'confirming')
  await assert.rejects(owner.resolveTarget(), /no confirmed target/)
  assert.equal(owner.getSnapshot().record?.target, undefined); assert.equal(creates, 1)
})

test('foreign creation receipts preserve the unresolved original operation', async t => {
  const storage = new BrowserStorage()
  const owner = new RemoteCreationController({ ...readApi(), async create(request) { return ok({ ...accepted(request), operationId: 'foreign' }) } }, { storage, scope: 'foreign-create' }, { operationId: () => 'original' })
  t.after(() => owner.dispose())
  assert.equal(await owner.start(source, '/repo'), null)
  assert.match(owner.getSnapshot().error!, /different creation receipt/)
  assert.equal(owner.getSnapshot().record?.request.operationId, 'original'); assert.equal(owner.getSnapshot().record?.target, undefined)
})

test('an unavailable created target keeps its identity and reopens without another native creation', async t => {
  const storage = new BrowserStorage(); let readable = false, writes = 0
  const owner = new RemoteCreationController({ ...readApi(), async create(request) { writes++; return ok(accepted(request)) }, async resolve() {
    if (!readable) throw new Error('Exact source not readable yet')
    return ok(session)
  } }, { storage, scope: 'open-recovery' }); t.after(() => owner.dispose())
  await owner.start(source, '/repo')
  await assert.rejects(owner.resolveTarget(), /not readable/)
  assert.equal(owner.getSnapshot().record?.phase, 'accepted'); readable = true
  assert.equal((await owner.resolveTarget()).nativeId, session.nativeId); assert.equal(writes, 1)
})

test('opening the exact accepted result completes that intent and a later explicit creation gets a fresh identity', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'creation-completed' }, requests: SourceCreateRequest[] = []
  const api = { ...readApi(), async create(request: SourceCreateRequest) { requests.push(request); return ok(accepted(request)) } }
  const owner = new RemoteCreationController(api, access, { operationId: () => 'first' }); t.after(() => owner.dispose())
  await owner.start(source, '/repo')
  assert.equal(await owner.completeOpened('another-operation', session.id), false)
  assert.equal(await owner.completeOpened('first', session.id + '-foreign'), false)
  assert.equal(owner.getSnapshot().record?.phase, 'accepted')
  await owner.resolveTarget()
  assert.equal(await owner.completeOpened('first', session.id), true)
  assert.equal(owner.getSnapshot().record, null)
  const next = new RemoteCreationController(api, access, { operationId: () => 'second' }); t.after(() => next.dispose()); await next.ready()
  assert.equal(next.getSnapshot().record, null)
  assert.equal((await next.start(source, '/repo'))?.request.operationId, 'second')
  assert.deepEqual(requests.map(request => request.operationId), ['first', 'second'])
  assert.equal(await owner.completeOpened('first', session.id), false, 'a late opener cannot consume the next creation')
})

test('quota and account revocation cannot dispatch or resurrect a saved creation', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'creation-revoke' }; let writes = 0
  const gate = Promise.withResolvers<SourceCreationReceipt>(), entered = Promise.withResolvers<SourceCreateRequest>()
  const owner = new RemoteCreationController({ ...readApi(), async create(request) { writes++; entered.resolve(request); return ok(await gate.promise) } }, access)
  t.after(() => owner.dispose()); await owner.ready(); storage.failWrites = true
  assert.equal(await owner.start(source, '/repo'), null); assert.equal(writes, 0)
  storage.failWrites = false; storage.setItem('official-draft', 'keep')
  const pending = owner.start(source, '/repo'), request = await entered.promise
  clearSourceStorage(storage); gate.resolve(accepted(request)); await pending
  assert.equal(await new RemoteOperationLedger(access).read(JSON.stringify(['source-creation', 'create'])), null)
  assert.ok(Array.from({ length: storage.length }, (_, i) => storage.key(i)).every(key => !key?.startsWith(creationStoragePrefix(access.scope))))
  assert.equal(storage.getItem('official-draft'), 'keep'); assert.equal(writes, 1)
})

test('another account never restores the old creation and no mount dispatches', async t => {
  const storage = new BrowserStorage(); let writes = 0
  const api = { ...readApi(), async create(request: SourceCreateRequest) { writes++; return ok(accepted(request)) } } satisfies Pick<HhpiRemoteApi, 'catalog' | 'resolve' | 'create'>
  const a = new RemoteCreationController(api, { storage, scope: 'account-a' }); await a.start(source, '/repo'); a.dispose()
  const b = new RemoteCreationController(api, { storage, scope: 'account-b' }); t.after(() => b.dispose()); await b.ready()
  assert.equal(b.getSnapshot().record, null); assert.equal(writes, 1)
})
