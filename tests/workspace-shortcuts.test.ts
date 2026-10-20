/** Official DSH preference resolution with an explicit input-observer test double. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveShortcuts, initialShortcutConfig, type ShortcutCommandId, type ShortcutDocument } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { Shortcuts, ShortcutFixedInput, ShortcutGesture } from '@deepseek-ai/dsh-client-shortcuts/client'
import { installNewSessionShortcut } from '../src/client/shortcuts.ts'

test('New Session follows real resolved preferences, consumes once, yields to editing/modals, and disposes', () => {
    const id = 'session.new' as ShortcutCommandId
    const definitions = [{ id, defaults: { 'web:windows': { code: 'KeyN', modifiers: ['primary', 'alt'] as const } } }]
    let document: ShortcutDocument = { schemaVersion: 2, profiles: {} }
    let status: 'loading' | 'ready' = 'ready'
    let listener: ((input: ShortcutFixedInput) => void) | undefined
    let opened = 0
    let consumed = 0
    const source: Pick<Shortcuts, 'observeFixedInput' | 'catalog' | 'config'> = {
        observeFixedInput(value) { listener = value; return () => { listener = undefined } },
        catalog: { getSnapshot: () => effectiveShortcuts(definitions, document, 'web', 'windows').map(row => ({ ...row, label: 'New Session', aliases: [], keys: [], aria: undefined })), subscribe: () => () => {} },
        config: { getSnapshot: () => ({ ...initialShortcutConfig(), document, status }), subscribe: () => () => {} },
    }
    const dispose = installNewSessionShortcut(source, () => { opened++ })
    const send = (patch: Partial<ShortcutGesture> = {}, modal: string | null = null, region: 'page' | 'editable' | 'terminal' = 'editable'): void => {
        listener?.({ type: 'keydown', gesture: { code: 'KeyN', control: true, alt: true, shift: false, meta: false, repeat: false, composing: false, defaultPrevented: false, ...patch },
            context: { modal, region, target: null }, consume: () => { consumed++ } })
    }
    send(); assert.equal(opened, 1); assert.equal(consumed, 1)
    send({ repeat: true }); assert.equal(opened, 1); assert.equal(consumed, 2)
    send({ composing: true }); send({ defaultPrevented: true }); send({}, 'settings'); send({}, null, 'terminal'); send({ alt: false })
    assert.equal(opened, 1); assert.equal(consumed, 2)
    document = { schemaVersion: 2, profiles: { 'web:windows': { 'session.new': { code: 'KeyY', modifiers: ['control', 'shift'] } } } }
    send(); assert.equal(opened, 1)
    send({ code: 'KeyY', alt: false, shift: true }); assert.equal(opened, 2)
    status = 'loading'; send({ code: 'KeyY', alt: false, shift: true }); assert.equal(opened, 2)
    status = 'ready'; document = { schemaVersion: 2, profiles: { 'web:windows': { 'session.new': null } } }
    send(); assert.equal(opened, 2)
    document = { schemaVersion: 2, profiles: {} }
    dispose(); send(); assert.equal(opened, 2); assert.equal(listener, undefined)
})
