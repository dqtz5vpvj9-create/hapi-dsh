import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeSessionTools } from '../src/client-api.ts'
import { nativeToolAllowed } from '../src/client/native-tool-admission.ts'

const active: NativeSessionTools = { sessionId: 'current-display', sourceSessionId: 'original-source', active: true, readOnly: false,
    canRewind: true, canClear: false, goal: null, summary: '', pinMode: 'none', operations: [] }

test('source confirmations cannot act on an unread or previous selection, and lifecycle predicates use current source facts', () => {
    assert.equal(nativeToolAllowed(null, 'current-display', { kind: 'restart' }), false)
    assert.equal(nativeToolAllowed(active, 'another-display', { kind: 'archive' }), false)
    assert.equal(nativeToolAllowed(active, 'current-display', { kind: 'restart' }), true)
    assert.equal(nativeToolAllowed(active, 'current-display', { kind: 'delete' }), false)
    assert.equal(nativeToolAllowed(active, 'current-display', { kind: 'reopen' }), false)
    assert.equal(nativeToolAllowed({ ...active, active: false }, 'current-display', { kind: 'delete' }), true)
    assert.equal(nativeToolAllowed({ ...active, active: false }, 'current-display', { kind: 'archive' }), false)
    assert.equal(nativeToolAllowed(active, 'current-display', { kind: 'clear' }), false)
    assert.equal(nativeToolAllowed({ ...active, canClear: true }, 'current-display', { kind: 'clear' }), true)
    assert.equal(nativeToolAllowed({ ...active, readOnly: true }, 'current-display', { kind: 'goal', command: { action: 'clear' } }), false)
})
