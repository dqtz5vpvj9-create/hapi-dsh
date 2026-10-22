/** Pure adapter/protocol tests; these do not claim browser or device acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { currentCapacity } from '../src/client/source-capacity.tsx'
import { hapiProjectionSchema } from '../src/codex/projection-types.ts'
import { parseReloadReadingAnchor } from '../src/client/reading-anchor.ts'
import { selectionQuote } from '../src/client/document-selection.tsx'

test('capacity recovery survives the public projection and never shows another turn or idle retry', () => {
    const schema = hapiProjectionSchema.unwrap().shape.execution
    const base = { owner: 'codex', generation: 'g', sequence: 1, status: 'active', waitingOn: [], turnId: 't', startedAt: 1, completedAt: null,
        capacityRecovery: { turnId: 't', phase: 'waiting', retryAt: 100, attempt: 1, maxAttempts: 5 } }
    const execution = schema.parse(base)!
    assert.deepEqual(currentCapacity(execution), base.capacityRecovery)
    assert.equal(currentCapacity({ ...execution, turnId: 'other' }), null)
    assert.equal(currentCapacity({ ...execution, status: 'idle' }), null)
    assert.equal(currentCapacity({ ...execution, status: 'systemError', capacityRecovery: { turnId: 't', phase: 'retrying' } }), null)
    assert.equal(currentCapacity({ ...execution, status: 'systemError', capacityRecovery: { turnId: 't', phase: 'failed', reason: 'unconfirmed' } })?.reason, 'unconfirmed')
})

test('reading bookmarks preserve stable source identity and remain compatible with earlier bookmarks', () => {
    const old = { key: 'message:1', seq: 3, offset: -8 }
    assert.deepEqual(parseReloadReadingAnchor(JSON.stringify(old)), old)
    const stable = { ...old, displayId: 'old-generation', sourceMessageId: 'original-message' }
    assert.deepEqual(parseReloadReadingAnchor(JSON.stringify(stable)), stable)
    assert.equal(parseReloadReadingAnchor(JSON.stringify({ ...stable, seq: 3.5 })), undefined)
})

test('document selection retains exact selected lines, path and supplied revision without claiming a missing revision', () => {
    assert.equal(selectionQuote('/source/a.ts', 'a\n\nb', 'rev-1'), '[选区引用 / Document selection]\nSource: /source/a.ts\nRevision: rev-1\n> a\n> \n> b\n')
    assert.match(selectionQuote('/source/b', 'selected'), /Revision: not reported/)
})
