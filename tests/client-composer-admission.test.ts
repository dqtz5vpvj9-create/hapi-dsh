/** R8 composer admission copy: read-only only from a real projection lock. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { composerAdmission } from '../src/client/locales.ts'

test('a disconnected Codex source gets a resume hint, never a read-only lock', () => {
    assert.deepEqual(composerAdmission({ nativeConnection: 'history' }), { key: 'nativeResumeHint', resume: true })
    assert.deepEqual(composerAdmission({ nativeConnection: 'detached' }), { key: 'nativeResumeHint', resume: true })
})

test('attached or writable sessions keep the composer admitted', () => {
    assert.equal(composerAdmission({ nativeConnection: 'attached' }), null)
    assert.equal(composerAdmission({ readOnly: false }), null)
    assert.equal(composerAdmission({}), null)
})

test('engine-owned observed sessions report the local-control reason', () => {
    assert.deepEqual(composerAdmission({ readOnly: true, readOnlyReason: 'engine-owned' }),
        { key: 'sourceLocallyControlled', resume: false })
})

test('other read-only reasons keep the generic read-only reason', () => {
    for (const readOnlyReason of ['unavailable', 'fault', 'migration', null, undefined]) {
        assert.deepEqual(composerAdmission({ readOnly: true, readOnlyReason }),
            { key: 'sourceReadOnly', resume: false })
    }
})
