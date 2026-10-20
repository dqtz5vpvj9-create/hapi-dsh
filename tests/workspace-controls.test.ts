/** Explicit fake RPC tests for UI intent/receipt semantics; official browser tests live in e2e/. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { HapiRemoteApi, NativeForkState, NativeForkView, NativeSettings, NativeSettingReceipt, NativePlanState, NativePlanReceipt } from '../src/client-api.ts'
import { NativeControlLedger } from '../src/client/native-control-state.ts'

const ok = <T>(value: T) => ({ ok: true as const, value })
const sourceSettings = (): NativeSettings => ({
    values: { model: 'source-model', reasoningEffort: 'high', permissionMode: 'default', collaborationMode: 'default', serviceTier: null },
    models: [{ id: 'source-model', name: 'Source model', isDefault: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', serviceTiers: [] }],
    readOnly: false, warnings: [], operations: [],
})
type FakeApi = Pick<HapiRemoteApi, 'nativeSettings' | 'nativeApplySetting' | 'nativeForkState' | 'nativeFork' | 'nativeForkOperation' | 'nativeForkClose' | 'nativePlan' | 'nativeImplementPlan'>
function fakeApi(overrides: Partial<FakeApi>): FakeApi {
    const unused = async (): Promise<never> => { throw new Error('This fake operation was not configured') }
    return { nativeSettings: unused, nativeApplySetting: unused, nativeForkState: unused, nativeFork: unused, nativeForkOperation: unused, nativeForkClose: unused, nativePlan: unused, nativeImplementPlan: unused, ...overrides }
}

test('unknown setting keeps its intent across UI remounts and never paints an optimistic native value', async () => {
    let source = sourceSettings()
    let writes = 0
    const api = fakeApi({ nativeSettings: async () => ok(source), nativeApplySetting: async () => { writes++; throw new Error('Connection lost after submission') } })
    const ledger = new NativeControlLedger(api, () => 'setting-operation')
    const controller = ledger.settings('session')
    await controller.refresh()
    assert.equal(await controller.apply({ kind: 'model', value: 'next-model' }), false)
    assert.equal(controller.getSnapshot().data!.values.model, 'source-model')
    assert.equal(controller.getSnapshot().pending!.operationId, 'setting-operation')
    assert.match(controller.getSnapshot().error!, /Connection lost/)
    assert.equal(ledger.settings('session'), controller)
    await controller.refresh()
    assert.equal(await controller.apply({ kind: 'model', value: 'next-model' }), false)
    assert.equal(writes, 1)
    const receipt: NativeSettingReceipt = { operationId: 'setting-operation', createdAt: 1, status: 'observed', change: { kind: 'model', value: 'next-model' }, message: null, observed: { ...source.values, model: 'next-model' } }
    source = { ...source, values: receipt.observed!, operations: [receipt] }
    await controller.refresh()
    assert.equal(controller.getSnapshot().pending, null)
    assert.equal(controller.getSnapshot().data!.values.model, 'next-model')
    assert.equal(writes, 1)
})

test('a cold client restores unresolved native setting receipts and rejects another write', async () => {
    const source = sourceSettings()
    source.operations.push({ operationId: 'prior-op', change: { kind: 'permissionMode', value: 'read-only' }, createdAt: 2, status: 'indeterminate', message: 'Native acknowledgement missing', observed: null })
    let writes = 0
    const api = fakeApi({ nativeSettings: async () => ok(source), nativeApplySetting: async () => { writes++; throw new Error('Should not write') } })
    const controller = new NativeControlLedger(api).settings('session')
    await controller.refresh()
    assert.equal(controller.getSnapshot().pending!.operationId, 'prior-op')
    assert.equal(await controller.apply({ kind: 'collaborationMode', value: 'plan' }), false)
    assert.equal(writes, 0)
})

test('an explicitly rejected setting releases its intent while retaining the source error', async () => {
    const controller = new NativeControlLedger(fakeApi({
        nativeSettings: async () => ok(sourceSettings()),
        nativeApplySetting: async () => { throw { code: 'hapi/request', message: 'Runner is unavailable', details: { outcome: 'rejected' } } },
    }), () => 'rejected-setting').settings('session')
    await controller.refresh()
    await controller.apply({ kind: 'model', value: 'next-model' })
    assert.equal(controller.getSnapshot().pending, null)
    assert.equal(controller.getSnapshot().error, 'Runner is unavailable')
    assert.equal(controller.getSnapshot().data!.values.model, 'source-model')
})

test('unknown fork is inspected with its original identity and opens only an attached child', async () => {
    let source: NativeForkState = { revision: 4, blockingSourceSessionId: null, message: null, operations: [] }
    const operations: Array<{ operationId: string; action: string }> = []
    let writes = 0
    const ready: NativeForkView = { operationId: 'fork-operation', submission: 'acknowledged', sessionId: 'display-child', message: null,
        operation: { operationId: 'fork-operation', status: 'created', sourceSessionId: 'native-parent', childSessionId: 'native-child', sourceRevision: 5, message: 'Ready', updatedAt: 3, nativeThreadId: 'native-thread-child', binding: 'ready' } }
    const api = fakeApi({
        nativeForkState: async () => ok(source),
        nativeFork: async request => { writes++; assert.equal(request.expectedForkRevision, 4); assert.equal(request.displayMessageId, 'dsh-message'); throw new Error('Reply lost') },
        nativeForkOperation: async request => { operations.push(request); source = { ...source, revision: 5, operations: [ready] }; return ok(ready) },
    })
    const ledger = new NativeControlLedger(api, () => 'fork-operation')
    const controller = ledger.fork('parent')
    await controller.refresh()
    await controller.create({ displayMessageId: 'dsh-message' })
    assert.equal(controller.getSnapshot().operations[0]!.sessionId, null)
    assert.equal(controller.getSnapshot().operations[0]!.submission, 'indeterminate')
    assert.equal(await controller.create(), null)
    assert.equal(ledger.fork('parent'), controller)
    assert.equal(writes, 1)
    const result = await controller.inspect('fork-operation', 'reconcile')
    assert.equal(result!.sessionId, 'display-child')
    assert.deepEqual(operations, [{ sessionId: 'parent', operationId: 'fork-operation', action: 'reconcile' }])
    assert.equal(writes, 1)
})

test('duplicate-risk fork is a separate explicit operation with the recorded original identity', async () => {
    const old: NativeForkView = { operationId: 'uncertain', submission: 'indeterminate', operation: null, sessionId: null, message: 'Unknown' }
    const source: NativeForkState = { revision: 8, blockingSourceSessionId: 'parent', message: null, operations: [old] }
    const requests: unknown[] = []
    const controller = new NativeControlLedger(fakeApi({
        nativeForkState: async () => ok(source),
        nativeFork: async request => { requests.push(request); return ok({ ...old, operationId: request.operationId, submission: 'acknowledged' }) },
    }), () => 'new-operation').fork('parent')
    await controller.refresh()
    assert.equal(await controller.create(), null)
    assert.equal(await controller.create({ duplicateRiskOf: 'unrelated' }), null)
    await controller.create({ duplicateRiskOf: 'uncertain' })
    assert.deepEqual(requests, [{ sessionId: 'parent', operationId: 'new-operation', expectedForkRevision: 8, duplicateRiskOf: 'uncertain' }])
})

test('an unknown plan submission keeps one operation across remounts and later native reads', async () => {
    let source: NativePlanState = { planId: 'source-plan', readOnly: false, operations: [] }
    const writes: unknown[] = []
    const api = fakeApi({ nativePlan: async () => ok(source), nativeImplementPlan: async request => { writes.push(request); throw new Error('Reply lost') } })
    const ledger = new NativeControlLedger(api, () => 'plan-operation')
    const controller = ledger.plan('session')
    await controller.refresh()
    assert.equal(await controller.implement('unrelated-plan'), null)
    await controller.implement('source-plan')
    assert.equal(controller.getSnapshot().operations[0]!.status, 'indeterminate')
    assert.equal(ledger.plan('session'), controller)
    await controller.refresh()
    assert.equal(await controller.implement('source-plan'), null)
    assert.deepEqual(writes, [{ sessionId: 'session', planId: 'source-plan', operationId: 'plan-operation' }])
    const receipt: NativePlanReceipt = { operationId: 'plan-operation', planId: 'source-plan', localId: 'source-plan:implement', status: 'submitted', createdAt: 1, updatedAt: 2, message: null, sourceCode: null }
    source = { ...source, operations: [receipt] }
    await controller.refresh()
    assert.equal(controller.getSnapshot().operations[0]!.status, 'submitted')
    assert.equal(await controller.implement('source-plan'), null)
    source = { ...source, operations: [{ ...receipt, status: 'invoked', updatedAt: 3 }] }
    await controller.refresh()
    assert.equal(controller.getSnapshot().operations[0]!.status, 'invoked')
    assert.equal(writes.length, 1)
})

test('a cold client restores native plan ownership and only a new actionable plan can launch', async () => {
    let source: NativePlanState = { planId: 'old-plan', readOnly: false, operations: [{
        operationId: 'old-operation', planId: 'old-plan', localId: 'old-plan:implement', status: 'queued', createdAt: 1, updatedAt: 2, message: null, sourceCode: null,
    }] }
    let writes = 0
    const controller = new NativeControlLedger(fakeApi({
        nativePlan: async () => ok(source), nativeImplementPlan: async request => {
            writes++
            assert.equal(request.planId, 'new-plan')
            return ok({ ...source.operations[0]!, operationId: request.operationId, planId: request.planId, localId: `${request.planId}:implement`, status: 'submitted' })
        },
    }), () => 'new-operation').plan('session')
    await controller.refresh()
    assert.equal(await controller.implement('old-plan'), null)
    assert.equal(writes, 0)
    source = { ...source, planId: 'new-plan', readOnly: true }
    await controller.refresh(); assert.equal(await controller.implement('new-plan'), null)
    source = { ...source, readOnly: false }
    await controller.refresh(); await controller.implement('new-plan')
    assert.equal(writes, 1)
    assert.equal(controller.getSnapshot().operations.at(-1)!.status, 'submitted')
})
