/** Production native owner/ledger; only browser storage and read scheduling are fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeActionOwner } from '../src/client/remote-native-actions.ts'
import { RemoteOperationLedger } from '../src/client/remote-operation-ledger.ts'
import { nativeActionKey, type NativeActionRecord } from '../src/client/remote-operation-contracts.ts'
import { nativeActionStoragePrefix, type SourceStorage } from '../src/client/remote-storage.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'

const sessionId = 'hhpi:machine:source:codex:original'
const plan = (intent: string): NativeActionRecord => ({ version: 1, sessionId, intent, kind: 'plan',
  request: { sourceId: 'source', method: 'turn/start', operationId: `operation-${intent}`, params: { threadId: 'original',
    clientUserMessageId: `operation-${intent}`, input: [{ type: 'text', text: 'Continue planning; do not implement yet.\n\nFixture plan', text_elements: [] }],
    collaborationMode: { mode: 'plan', settings: { model: 'fixture-model', reasoning_effort: 'medium', developer_instructions: null } } } },
  phase: 'accepted', createdAt: 1, updatedAt: 2, outcome: { status: 'accepted', message: 'The original source accepted the action.' } })
async function seed(access: SourceStorage, ...records: NativeActionRecord[]): Promise<void> {
  const ledger = new RemoteOperationLedger(access)
  for (const record of records) {
    const id = nativeActionKey(record.sessionId, record.intent)
    await ledger.transition(id, () => JSON.stringify(record), () => access.storage.setItem(nativeActionStoragePrefix(access.scope) + encodeURIComponent(id),
      JSON.stringify({ version: 1, sessionId: record.sessionId, intent: record.intent })))
  }
}
function controlledOwner(access: SourceStorage) {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let reads = 0, calls = 0, receipts = 0
  const owner = new NativeActionOwner({ async call() { calls++; throw new Error('Restore must not send') }, async receipt() { receipts++; throw new Error('Restore must not query native receipts') } },
    { createLedger: target => {
      const ledger = new RemoteOperationLedger(target)
      return { transition: (id, update, mirror) => ledger.transition(id, update, mirror), async read(id) {
        const raw = await ledger.read(id)
        if (target.scope === access.scope) { reads++; entered.resolve(); await gate.promise }
        return raw
      } }
    } })
  return { owner, gate, entered, counts: () => ({ reads, calls, receipts }) }
}

test('constructor restore installs persisted accepted plans after delayed reads without any native action', async t => {
  const access = { storage: new BrowserStorage(), scope: 'initial-restore' }, record = plan('plan:14:assistant-step66:78')
  await seed(access, record)
  const f = controlledOwner(access); t.after(() => f.owner.dispose()); f.owner.setStorage(access)
  await f.entered.promise
  assert.equal(f.owner.view(sessionId).getSnapshot().length, 0)
  f.gate.resolve(); await f.owner.restore()
  assert.deepEqual(f.owner.view(sessionId).getSnapshot(), [record])
  assert.deepEqual(f.counts(), { reads: 2, calls: 0, receipts: 0 })
})

test('same-scope concurrent plan restores publish both exact accepted operation identities', async t => {
  const access = { storage: new BrowserStorage(), scope: 'overlapping-restore' }, first = plan('plan:14:assistant-step66:78'), second = plan('plan:14:assistant-step84:88')
  await seed(access, first, second)
  const f = controlledOwner(access); t.after(() => f.owner.dispose()); f.owner.setStorage(access)
  await f.entered.promise
  const restored = Promise.all([f.owner.restore(), f.owner.restore(), f.owner.restore()])
  f.gate.resolve(); await restored
  assert.deepEqual(f.owner.view(sessionId).getSnapshot().map(x => [x.intent, x.phase, x.request.operationId]),
    [first, second].map(x => [x.intent, 'accepted', x.request.operationId]))
  assert.equal(f.counts().calls + f.counts().receipts, 0)
})

test('an account generation exit immediately clears accepted plans and excludes late old restoration', async t => {
  const storage = new BrowserStorage(), access = { storage, scope: 'old-account' }, record = plan('plan:old-account')
  await seed(access, record)
  const f = controlledOwner(access); t.after(() => f.owner.dispose()); f.owner.setStorage(access)
  await f.entered.promise
  const pending = f.owner.restore()
  f.owner.setStorage({ storage, scope: 'new-account' }); await f.owner.restore()
  assert.equal(f.owner.view(sessionId).getSnapshot().length, 0)
  f.gate.resolve(); await pending
  assert.equal(f.owner.view(sessionId).getSnapshot().length, 0)
  assert.equal(f.counts().calls + f.counts().receipts, 0)
})

test('disposing an owner prevents a delayed accepted-plan restore from republishing', async () => {
  const access = { storage: new BrowserStorage(), scope: 'dispose-restore' }
  await seed(access, plan('plan:dispose'))
  const f = controlledOwner(access); f.owner.setStorage(access); await f.entered.promise
  const pending = f.owner.restore(); f.owner.dispose(); f.gate.resolve(); await pending
  assert.equal(f.owner.view(sessionId).getSnapshot().length, 0)
  assert.equal(f.counts().calls + f.counts().receipts, 0)
})

test('revoking another conversation during initial restore preserves the accepted plan target', async t => {
  const access = { storage: new BrowserStorage(), scope: 'target-revocation' }, record = plan('plan:preserved')
  await seed(access, record)
  const f = controlledOwner(access); t.after(() => f.owner.dispose()); f.owner.setStorage(access)
  await f.entered.promise
  const pending = f.owner.restore()
  await f.owner.revokeSession('hhpi:machine:source:codex:unrelated')
  f.gate.resolve(); await pending
  assert.equal(f.owner.get(sessionId, record.intent)?.phase, 'accepted')
  assert.equal(f.owner.get(sessionId, record.intent)?.request.operationId, record.request.operationId)
  assert.equal(f.counts().calls + f.counts().receipts, 0)
})


test('a revoked target cannot reappear from a previously read accepted plan while other targets restore', async t => {
  const access = { storage: new BrowserStorage(), scope: 'revoked-target' }, revoked = plan('plan:revoked')
  const other = { ...plan('plan:other'), sessionId: 'hhpi:machine:source:codex:other',
    request: { ...plan('plan:other').request, params: { threadId: 'other' } } }
  await seed(access, revoked, other)
  const f = controlledOwner(access); t.after(() => f.owner.dispose()); f.owner.setStorage(access)
  await f.entered.promise
  const pending = f.owner.restore()
  await f.owner.revokeSession(sessionId)
  f.gate.resolve(); await pending
  assert.equal(f.owner.view(sessionId).getSnapshot().length, 0)
  assert.equal(f.owner.get(other.sessionId, other.intent)?.phase, 'accepted')
  assert.equal(await new RemoteOperationLedger(access).read(nativeActionKey(sessionId, revoked.intent)), null)
  await assert.rejects(f.owner.submit({ sessionId, intent: revoked.intent, kind: 'plan', request: revoked.request }), /was revoked/)
  assert.equal(f.counts().calls + f.counts().receipts, 0)
})
