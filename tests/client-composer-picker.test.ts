/** Capability/identity boundaries for the production source picker. No upstream runtime is faked here. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeSettings } from '../src/client-api.ts'
import type { HapiRemoteApi, NativeSettingReceipt } from '../src/client-api.ts'
import type { ObservedSettings } from '../src/hapi-agent/control-types.ts'
import { modelKey, modelLabel, nativePickerChange, nativePickerData, observedPickerChange, observedPickerData } from '../src/client/composer-picker/data.ts'
import { NativeSettingsController } from '../src/client/native-control-state.ts'

function native(): NativeSettings {
    return { values: { model: 'a', reasoningEffort: 'medium', permissionMode: 'default', collaborationMode: 'default', serviceTier: 'standard' },
        models: [{ id: 'a', name: 'Model A', isDefault: true, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', serviceTiers: ['fast'] }],
        readOnly: false, warnings: [], operations: [] }
}
function observed(): ObservedSettings {
    return { sessionId: 'display-beta', sourceSessionId: 'source-beta', flavor: 'pi', nativeId: 'pi-beta', readOnly: false,
        values: { model: { provider: 'alpha', modelId: 'one' }, effort: 'high', permission: null, collaboration: null, serviceTier: null, copilotMode: null, control: 'remote' },
        models: [{ value: { provider: 'alpha', modelId: 'one' }, label: 'One', provider: 'alpha' }, { value: { provider: 'beta', modelId: 'one' }, label: 'One', provider: 'beta' }],
        efforts: [{ value: null, label: 'Default' }, { value: 'high', label: 'High' }], permissions: [], serviceTiers: [],
        editable: { model: true, effort: true, permission: false, collaboration: false, serviceTier: false, copilotMode: false, control: false }, warnings: [], receipts: [] }
}

test('native picker uses only the current source model capabilities and maps default effort without inventing a value', () => {
    const data = nativePickerData(native())
    assert.deepEqual(nativePickerChange(data, { kind: 'effort', value: null }), { kind: 'reasoningEffort', value: null })
    assert.equal(nativePickerChange(data, { kind: 'effort', value: 'max' }), undefined)
    assert.deepEqual(nativePickerChange(data, { kind: 'fast', value: true }), { kind: 'serviceTier', value: 'fast' })
    assert.deepEqual(nativePickerChange(data, { kind: 'fast', value: false }), { kind: 'serviceTier', value: 'standard' })
    assert.equal(nativePickerChange(data, { kind: 'permission', value: 'safe-yolo' }), undefined)
    assert.deepEqual(nativePickerChange(data, { kind: 'permission', value: 'read-only' }), { kind: 'permissionMode', value: 'read-only' })
})

test('an unknown source model remains descriptive and does not inherit another model effort or Fast options', () => {
    const source = native(); source.values.model = 'unlisted'; source.values.reasoningEffort = 'future'; source.values.serviceTier = 'fast'
    const data = nativePickerData(source)
    assert.equal(modelLabel(data.model, data.models), 'unlisted')
    assert.equal(data.effort, 'future')
    assert.deepEqual(data.efforts, [])
    assert.equal(data.fast, true)
    assert.equal(data.fastAvailable, false)
    assert.equal(nativePickerChange(data, { kind: 'fast', value: false }), undefined)
    assert.equal(nativePickerChange(data, { kind: 'model', value: 'not-in-catalog' }), undefined)
})

test('identical Pi model labels preserve provider identity, including property order independent selection', () => {
    const data = observedPickerData(observed())
    assert.notEqual(modelKey(data.models[0]!.value), modelKey(data.models[1]!.value))
    const chosen = { modelId: 'one', provider: 'beta' }
    assert.deepEqual(observedPickerChange(data, { kind: 'model', value: chosen }), { kind: 'model', value: chosen })
    assert.equal(modelLabel(chosen, data.models), 'One')
    assert.equal(observedPickerChange(data, { kind: 'model', value: 'One' }), undefined)
    assert.equal(data.fastAvailable, false)
    assert.equal(observedPickerChange(data, { kind: 'fast', value: true }), undefined)
})

test('source capability withdrawal or readonly blocks a stale popup action against the latest settings', () => {
    const source = observed(); source.editable.model = false; source.editable.effort = false
    const data = observedPickerData(source)
    assert.equal(observedPickerChange(data, { kind: 'model', value: source.models[1]!.value }), undefined)
    assert.equal(observedPickerChange(data, { kind: 'effort', value: null }), undefined)
    const locked = native(); locked.readOnly = true
    const readonly = nativePickerData(locked)
    assert.equal(nativePickerChange(readonly, { kind: 'permission', value: 'yolo' }), undefined)
    assert.equal(nativePickerChange(readonly, { kind: 'fast', value: true }), undefined)
})

test('a source default model retains its null wire identity and an unreported permission is not coerced', () => {
    const source = observed(); source.values.model = null
    source.models.unshift({ value: null, label: 'Default', provider: null })
    const data = observedPickerData(source)
    assert.equal(modelLabel(data.model, data.models), 'Default')
    assert.deepEqual(observedPickerChange(data, { kind: 'model', value: null }), { kind: 'model', value: null })
    assert.equal(data.permission, null)
    assert.equal(observedPickerChange(data, { kind: 'permission', value: 'default' }), undefined)
})

test('the capsule projection keeps source values through an indeterminate write and rejection, without replaying it', async () => {
    const source = native(), operationId = '11111111-1111-4111-8111-111111111111'
    let writes = 0
    let receipt: NativeSettingReceipt | undefined
    const api: Pick<HapiRemoteApi, 'nativeSettings' | 'nativeApplySetting'> = {
        nativeSettings: async () => ({ ok: true, value: source }),
        nativeApplySetting: async request => {
            writes++
            receipt = { operationId: request.operationId, change: request.change, createdAt: 1, status: 'indeterminate', message: 'Reply pending', observed: null }
            source.operations = [receipt]
            return { ok: true, value: receipt }
        },
    }
    // Other ledger operations are not called by this settings-only component.
    const controller = new NativeSettingsController(api as ConstructorParameters<typeof NativeSettingsController>[0], 'display-beta', () => operationId)
    await controller.refresh()
    assert.equal(await controller.apply({ kind: 'reasoningEffort', value: 'high' }), false)
    assert.equal(nativePickerData(controller.getSnapshot().data!).effort, 'medium')
    assert.equal(controller.getSnapshot().pending?.operationId, operationId)
    assert.equal(await controller.apply({ kind: 'serviceTier', value: 'fast' }), false)
    assert.equal(writes, 1)
    receipt = { ...receipt!, status: 'rejected', message: 'The source declined the change' }
    source.operations = [receipt]
    await controller.refresh()
    assert.equal(controller.getSnapshot().pending, null)
    assert.equal(controller.getSnapshot().receipt?.status, 'rejected')
    assert.equal(nativePickerData(controller.getSnapshot().data!).effort, 'medium')
    assert.equal(nativePickerData(controller.getSnapshot().data!).fast, false)
    assert.equal(writes, 1)
})
