import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { SourceHistoryController, filterPiHistory, piHistoryPage, sourceHistorySuccessorId } from '../src/client/source-history.tsx'
import type { PiHistoryEntry, SourceHistoryAction, SourceHistoryApi, SourceHistoryOperation, SourceHistoryReceipt } from '../src/hapi-agent/history-types.ts'

/** Browser RPC fixture only: no Pi process, migration, or model is executed here. */
class Api implements SourceHistoryApi {
  readonly writes: SourceHistoryOperation[] = []
  readonly reads: string[] = []
  readonly continues: string[] = []
  receipt: SourceHistoryReceipt | null = null
  failReply = false
  failRead = false
  beforeWrite: (() => void) | undefined
  async sourceHistoryPi() { return { ok: true as const, value: { machineId: 'runner', sessions: [], operations: this.receipt ? [structuredClone(this.receipt)] : [] } } }
  async sourceHistoryTools() { return { ok: true as const, value: { sessionId: 'display', sourceSessionId: 'source', machineId: 'runner',
    flavor: 'codex', nativeId: 'original-thread', active: false, pi: null, codex: null, cursor: null, operations: this.receipt ? [structuredClone(this.receipt)] : [] } } }
  async sourceHistoryOperation(request: SourceHistoryOperation) {
    this.beforeWrite?.(); this.writes.push(structuredClone(request))
    this.receipt = receipt(request)
    if (this.failReply) throw new Error('Browser reply was lost after Host admission')
    return { ok: true as const, value: structuredClone(this.receipt) }
  }
  async sourceHistoryOperationRead({ operationId }: { operationId: string }) {
    this.reads.push(operationId)
    if (this.failRead) throw new Error('Original receipt is temporarily unavailable')
    return { ok: true as const, value: this.receipt?.operationId === operationId ? structuredClone(this.receipt) : null }
  }
  async sourceHistoryContinue({ operationId }: { operationId: string }) {
    this.continues.push(operationId); assert.equal(this.receipt?.operationId, operationId)
    this.receipt = { ...this.receipt!, status: 'indeterminate', phase: 'connect', canContinue: false, updatedAt: this.receipt!.updatedAt + 1 }
    if (this.failReply) throw new Error('The first reopen reply was lost')
    return { ok: true as const, value: structuredClone(this.receipt) }
  }
}
function receipt(request: SourceHistoryOperation): SourceHistoryReceipt {
  return { operationId: request.operationId, action: request.action, scope: 'source-scope', status: 'indeterminate', phase: 'migration',
    sourceSessionId: 'original-source', sessionId: null, createdAt: 100, updatedAt: 100, message: 'Original source reply is unknown',
    canContinue: false, items: [], cursorResult: null, codexResult: null, observation: null }
}
const migrate = (): SourceHistoryAction => ({ kind: 'codex-home', sessionId: 'display', targetHomeId: 'target-home' })
function storage() {
  const data = new Map<string, string>()
  let fault = false, discard = false
  return { data, fail: (value: boolean) => { fault = value }, drop: (value: boolean) => { discard = value },
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (fault) throw new Error('Browser storage is full'); if (!discard) data.set(key, value) } }
}

test('unknown history mutation retains its original operation through reload and never replays it', async () => {
  const api = new Api(), saved = storage(), operationId = randomUUID()
  api.failReply = true; api.failRead = true
  const controller = new SourceHistoryController(api, 'source', saved, () => operationId)
  assert.equal(await controller.run(migrate()), null)
  assert.equal(api.writes.length, 1); assert.equal(controller.canRun(migrate()), false)
  assert.deepEqual(controller.getSnapshot().prepared, [])
  const restored = new SourceHistoryController(api, 'source', saved)
  assert.equal(restored.getSnapshot().intents[0]?.operationId, operationId)
  api.failRead = false; await restored.recover()
  assert.equal(restored.getSnapshot().receipts[0]?.status, 'indeterminate')
  assert.equal(await restored.run(migrate()), null)
  assert.equal(await restored.submitPrepared(operationId), null)
  assert.equal(api.writes.length, 1); assert.ok(api.reads.every(id => id === operationId))
})

test('storage rejection sends no history mutation and explicit recovery keeps the same immutable operation', async () => {
  const api = new Api(), saved = storage(), operationId = randomUUID()
  saved.fail(true)
  const controller = new SourceHistoryController(api, 'source', saved, () => operationId)
  assert.equal(await controller.run(migrate()), null); assert.equal(api.writes.length, 0); assert.equal(api.reads.length, 0)
  assert.match(controller.getSnapshot().error ?? '', /storage is full/)
  assert.deepEqual(controller.getSnapshot().prepared, [operationId]); assert.equal(controller.canRun(migrate()), false)
  saved.fail(false)
  api.beforeWrite = () => {
    const stored = JSON.parse([...saved.data.values()][0]!)
    assert.equal(stored.intents[0].operationId, operationId); assert.deepEqual(stored.prepared, [])
  }
  const result = await controller.submitPrepared(operationId)
  assert.equal(result?.operationId, operationId); assert.equal(api.writes.length, 1)
  assert.deepEqual(api.writes[0]?.action, migrate())
  await controller.submitPrepared(operationId); assert.equal(api.writes.length, 1)
})

test('readback failure or unavailable browser storage cannot silently dispatch a migration', async () => {
  const api = new Api(), saved = storage(); saved.drop(true)
  const controller = new SourceHistoryController(api, 'source', saved)
  assert.equal(await controller.run(migrate()), null); assert.equal(api.writes.length, 0)
  assert.match(controller.getSnapshot().error ?? '', /could not retain/)
  const absent = new SourceHistoryController(api, 'without-storage')
  assert.equal(await absent.run(migrate()), null); assert.equal(api.writes.length, 0)
  assert.match(absent.getSnapshot().error ?? '', /cannot retain/)
})

test('a stored prepared operation is never automatically submitted after browser reconstruction', async () => {
  const api = new Api(), saved = storage(), operationId = randomUUID(); let writes = 0
  const flaky = { getItem: saved.getItem, setItem: (key: string, value: string) => {
    if (++writes === 2) throw new Error('The dispatch marker could not be saved')
    saved.setItem(key, value)
  } }
  const controller = new SourceHistoryController(api, 'source', flaky, () => operationId)
  await controller.run(migrate()); assert.equal(api.writes.length, 0)
  const restored = new SourceHistoryController(api, 'source', saved)
  assert.deepEqual(restored.getSnapshot().prepared, [operationId]); await restored.recover()
  assert.equal(api.writes.length, 0); assert.equal(api.reads.length, 0)
  await restored.submitPrepared(operationId)
  assert.equal(api.writes.length, 1); assert.equal(api.writes[0]?.operationId, operationId)
})

test('observing the target Codex home does not turn an unknown migration receipt into success or unlock another write', async () => {
  const api = new Api(), saved = storage(), controller = new SourceHistoryController(api, 'source', saved)
  const unknown = await controller.run(migrate()); assert.ok(unknown)
  api.receipt = { ...unknown, sessionId: 'display-r1', updatedAt: 200, observation: {
    sourceSessionId: 'original-source', sessionId: 'display-r1', nativeId: 'original-thread', active: false,
    codexHome: '/fixture/target-home', cursorProtocol: null, migrationInProgress: null, targetObserved: true,
  } }
  await controller.inspect(unknown.operationId)
  assert.equal(controller.getSnapshot().receipts[0]?.status, 'indeterminate')
  assert.equal(controller.getSnapshot().receipts[0]?.codexResult, null)
  assert.equal(controller.canRun(migrate()), false); assert.equal(api.writes.length, 1)
})

test('recovered Pi import needs one explicit first reconnect; unknown reconnect only reads thereafter', async () => {
  const api = new Api(), saved = storage(), request: SourceHistoryOperation = { operationId: randomUUID(),
    action: { kind: 'pi-import', machineId: 'runner', piSessionIds: ['original-pi'], connect: true } }
  api.receipt = { ...receipt(request), status: 'ready-to-connect', phase: 'import', canContinue: true }
  const controller = new SourceHistoryController(api, 'pi:runner', saved)
  controller.accept([api.receipt]); await controller.recover()
  assert.equal(api.continues.length, 0); assert.equal(api.writes.length, 0)
  saved.fail(true); assert.equal(await controller.continue(request.operationId), null); assert.equal(api.continues.length, 0)
  saved.fail(false); api.failReply = true
  await controller.continue(request.operationId); assert.deepEqual(api.continues, [request.operationId])
  const restored = new SourceHistoryController(api, 'pi:runner', saved); await restored.recover()
  assert.equal(await restored.continue(request.operationId), null)
  assert.equal(api.continues.length, 1); assert.equal(api.writes.length, 0)
})

test('Pi catalog search and pages preserve source identities without inventing server pagination', () => {
  const rows: PiHistoryEntry[] = Array.from({ length: 103 }, (_, i) => ({ id: `native-${i}`, title: `Fixture task ${i}`,
    lastUserMessage: i === 101 ? 'recover the branch' : 'source input', cwd: i < 100 ? '/project/a' : '/project/b',
    model: 'original-provider/model', file: `/fixture/pi/${i}.jsonl`, modifiedAt: i, messageCount: 3 }))
  const filtered = filterPiHistory(rows, 'recover model', '/project/b')
  assert.deepEqual(filtered.map(row => row.id), ['native-101'])
  assert.equal(piHistoryPage(rows, 1).rows[0]?.id, 'native-50')
  assert.deepEqual(piHistoryPage(rows, 99).rows.map(row => row.id), ['native-100', 'native-101', 'native-102'])
  assert.deepEqual(piHistoryPage([], 4), { rows: [], page: 0, pages: 1 })
})

test('migration draft handoff requires both confirmed execution and the attached observed target', () => {
  const completed: SourceHistoryReceipt = { ...receipt({ operationId: randomUUID(), action: migrate() }),
    status: 'confirmed', phase: 'complete', sessionId: 'target-display', observation: {
      sourceSessionId: 'original-source', sessionId: 'target-display', nativeId: 'original-thread', active: false,
      codexHome: '/fixture/target-home', cursorProtocol: null, migrationInProgress: null, targetObserved: true,
    } }
  assert.equal(sourceHistorySuccessorId(completed), 'target-display')
  assert.equal(sourceHistorySuccessorId({ ...completed, action: { kind: 'cursor-acp', sessionId: 'display', keepSource: true, forceArchiveRunning: false, skipVerify: false } }), 'target-display')
  assert.equal(sourceHistorySuccessorId({ ...completed, status: 'indeterminate' }), undefined, 'An observed target cannot prove migration success')
  assert.equal(sourceHistorySuccessorId({ ...completed, observation: null }), undefined)
  assert.equal(sourceHistorySuccessorId({ ...completed, observation: { ...completed.observation!, targetObserved: false } }), undefined)
  assert.equal(sourceHistorySuccessorId({ ...completed, observation: { ...completed.observation!, sessionId: 'stale-display' } }), undefined)
  assert.equal(sourceHistorySuccessorId({ ...completed, action: { kind: 'pi-import', machineId: 'runner', piSessionIds: ['original-pi'], connect: true } }), undefined, 'Pi imports retain ordinary navigation rather than inheriting another session draft')
})
