import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cursorLaunchPicker, chooseCursorLaunchModel } from '../src/client/cursor-models/launch.ts'
import { sourceCreationRequest } from '../src/client/source-creation.ts'
import { sourceLaunchFieldsSchema } from '../src/client/launch-drafts.ts'
import type { SourceMachineOptions } from '../src/source-machine-types.ts'

const options = (models: string[], skus: string[] = []): SourceMachineOptions => ({ agent: 'cursor', availability: { available: true, reason: null },
    models: models.map(id => ({ id, name: id, origin: 'runner', reasoningEfforts: [] })),
    cliModelSkus: skus.map(modelId => ({ modelId })), efforts: [], warnings: [], currentModelId: null,
})

test('Cursor base selection requires a precise variant and preserves the chosen source SKU at launch', () => {
    const source = options(['family[reasoning=high,fast=false]'], ['cursor-family-high', 'cursor-family-high-fast'])
    const initial = cursorLaunchPicker(source, '')
    assert.equal(initial.mode, 'dual')
    const choice = chooseCursorLaunchModel(initial, 'family')
    assert.deepEqual(choice, { model: '', cursorBase: 'family' })
    const pending = cursorLaunchPicker(source, choice.model, choice.cursorBase)
    assert.equal(pending.pendingVariant, true)
    assert.deepEqual(pending.variants.map(row => row.value), ['cursor-family-high', 'cursor-family-high-fast'])
    const selected = cursorLaunchPicker(source, 'cursor-family-high-fast', choice.cursorBase)
    assert.equal(selected.pendingVariant, false)
    assert.equal(selected.unavailable, false)
    const fields = sourceLaunchFieldsSchema.parse({ agent: 'cursor', machineId: 'runner', directory: '/repo', model: selected.wire, cursorBase: selected.base })
    const request = sourceCreationRequest(fields, 'cursor-intent-0001')
    assert.equal(request.model, 'cursor-family-high-fast')
    assert.equal(request.modelReasoningEffort, undefined)
    assert.equal('cursorBase' in request, false)
})

test('Cursor unfinished variant selection survives form persistence without turning into Auto', () => {
    const source = options(['family[a=1]', 'family[a=2]'])
    const fields = sourceLaunchFieldsSchema.parse({ agent: 'cursor', model: '', cursorBase: 'family' })
    const restored = sourceLaunchFieldsSchema.parse(JSON.parse(JSON.stringify(fields)))
    const picker = cursorLaunchPicker(source, restored.model, restored.cursorBase)
    assert.equal(picker.modelValue, 'family')
    assert.equal(picker.variantValue, '')
    assert.equal(picker.pendingVariant, true)
    assert.deepEqual(chooseCursorLaunchModel(picker, 'auto'), { model: 'auto', cursorBase: 'auto' })
})

test('Cursor flat catalogs retain exact wires and normalize default aliases only to Auto', () => {
    const source = options(['single[fast=false]', 'other'])
    const picker = cursorLaunchPicker(source, 'default[]')
    assert.equal(picker.mode, 'flat')
    assert.equal(picker.modelValue, 'auto')
    assert.deepEqual(chooseCursorLaunchModel(picker, 'single[fast=false]'), { model: 'single[fast=false]', cursorBase: 'single' })
})

test('Cursor keeps a known ACP wire selectable when source CLI labels arrive, without guessing a SKU', () => {
    const wire = 'family[reasoning=high,fast=false]'
    const picker = cursorLaunchPicker(options([wire], ['family-high', 'family-high-fast']), wire)
    assert.equal(picker.pendingVariant, false)
    assert.equal(picker.variantValue, wire)
    assert.equal(picker.variants[0]?.value, wire)
})

test('Cursor stale source values and orphan SKUs cannot manufacture catalog availability', () => {
    const picker = cursorLaunchPicker(options(['other[a=1]'], ['unadvertised-high']), 'family[a=1]', 'family')
    assert.equal(picker.unavailable, true)
    assert.equal(picker.catalog.wireToBase.has('family[a=1]'), false)
    assert.equal(picker.catalog.wireToBase.has('unadvertised-high'), false)
    assert.equal(picker.pendingVariant, true)
})

test('Cursor source catalog shrinking cannot silently replace an unfinished base with Auto', () => {
    const picker = cursorLaunchPicker(options(['family[a=1]']), '', 'family')
    assert.equal(picker.mode, 'flat')
    assert.equal(picker.pendingVariant, true)
    assert.deepEqual(chooseCursorLaunchModel(picker, 'family[a=1]'), { model: 'family[a=1]', cursorBase: 'family' })
})
