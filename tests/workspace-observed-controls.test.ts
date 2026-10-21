/** Fake source API tests; confirmations come only from original source state. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { HapiRemoteApi } from '../src/client-api.ts'
import type { ObservedSettingReceipt, ObservedSettings } from '../src/hapi-agent/control-types.ts'
import { ObservedSettingsController } from '../src/client/observed-controls.tsx'

const id = '11111111-1111-4111-8111-111111111111'
const ok = <T>(value: T) => ({ ok: true as const, value })
const settings = (): ObservedSettings => ({ sessionId: 'display', sourceSessionId: 'source', flavor: 'pi', nativeId: 'pi-thread', readOnly: false,
    values: { model: { provider: 'provider-a', modelId: 'model-a' }, effort: 'high', permission: null, collaboration: null, serviceTier: null, copilotMode: null, control: 'remote' },
    editable: { model: true, effort: true, permission: false, collaboration: false, serviceTier: false, copilotMode: false, control: true },
    models: [{ value: { provider: 'provider-a', modelId: 'model-a' }, label: 'Model A', provider: 'provider-a' }, { value: { provider: 'provider-b', modelId: 'model-b' }, label: 'Model B', provider: 'provider-b' }],
    efforts: [{ value: 'high', label: 'High' }], permissions: [], serviceTiers: [], warnings: [], receipts: [],
})
type Api = Pick<HapiRemoteApi, 'observedSettings' | 'observedApplySetting' | 'observedSetting'>

test('a submitted source model is not painted as applied and the full Pi identity survives its receipt', async () => {
    let source = settings(), writes = 0
    let receipt: ObservedSettingReceipt | undefined
    const api: Api = {
        observedSettings: async () => ok(source), observedSetting: async () => ok(receipt!),
        observedApplySetting: async request => {
            writes++; receipt = { ...request, sourceSessionId: 'source', logicalSessionId: 'logical', status: 'submitted', createdAt: 1, updatedAt: 1, message: null }
            source = { ...source, receipts: [receipt] }; return ok(receipt)
        },
    }
    const controller = new ObservedSettingsController(api, 'display', () => id)
    await controller.refresh()
    const desired = { provider: 'provider-b', modelId: 'model-b' }
    assert.equal(await controller.apply({ kind: 'model', value: desired }), false)
    assert.deepEqual(controller.getSnapshot().data!.values.model, { provider: 'provider-a', modelId: 'model-a' })
    assert.deepEqual(controller.getSnapshot().pending!.change, { kind: 'model', value: desired })
    assert.equal(await controller.apply({ kind: 'effort', value: 'high' }), false)
    assert.equal(writes, 1)
    receipt = { ...receipt!, status: 'applied', updatedAt: 2 }
    source = { ...source, values: { ...source.values, model: desired }, receipts: [receipt] }
    await controller.refresh()
    assert.equal(controller.getSnapshot().pending, null)
    assert.deepEqual(controller.getSnapshot().data!.values.model, desired)
})

test('unknown source setting is only read again and a cold mount restores its unresolved intent', async () => {
    const source = settings(); let writes = 0, reads = 0
    const receipt: ObservedSettingReceipt = { operationId: id, sourceSessionId: 'source', logicalSessionId: 'logical', status: 'indeterminate', change: { kind: 'effort', value: 'low' }, createdAt: 1, updatedAt: 2, message: 'Source outcome unknown' }
    const api: Api = { observedSettings: async () => ok(source), observedSetting: async () => { reads++; return ok(receipt) },
        observedApplySetting: async () => { writes++; source.receipts = [receipt]; throw new Error('reply lost') } }
    const controller = new ObservedSettingsController(api, 'display', () => id)
    await controller.refresh(); await controller.apply({ kind: 'effort', value: 'low' }); await controller.refresh()
    assert.equal(writes, 1); assert.ok(reads >= 1)
    assert.equal(controller.getSnapshot().pending!.operationId, id)
    const cold = new ObservedSettingsController(api, 'display')
    await cold.refresh()
    assert.equal(cold.getSnapshot().pending!.operationId, id)
    assert.equal(await cold.apply({ kind: 'effort', value: 'high' }), false)
    assert.equal(writes, 1)
})

test('local ownership allows only the real switch-to-remote setting while source admission is read-only', async () => {
    const source = settings(); source.readOnly = true; source.values.control = 'local'
    const changes: unknown[] = []
    const api: Api = { observedSettings: async () => ok(source), observedSetting: async () => { throw new Error('unused') },
        observedApplySetting: async request => { changes.push(request.change); return ok({ operationId: request.operationId, change: request.change, sourceSessionId: 'source', logicalSessionId: 'logical', status: 'applied', createdAt: 1, updatedAt: 2, message: null }) } }
    const controller = new ObservedSettingsController(api, 'display', () => id)
    await controller.refresh()
    assert.equal(await controller.apply({ kind: 'model', value: 'forbidden' }), false)
    assert.equal(await controller.apply({ kind: 'control', value: 'remote' }), true)
    assert.deepEqual(changes, [{ kind: 'control', value: 'remote' }])
})
