import test from 'node:test'
import assert from 'node:assert/strict'
import { DraftOwnership } from '../src/client/draft-ownership.ts'

test('duplicate panes share one persistence owner and hand over on close', () => {
    const ownership = new DraftOwnership(), one = {}, two = {}, other = {}
    const closeOne = ownership.retain('original', one), closeTwo = ownership.retain('original', two)
    const closeOther = ownership.retain('another', other)
    assert.equal(ownership.owner('original'), one)
    assert.equal(ownership.owner('another'), other)
    closeOne()
    assert.equal(ownership.owner('original'), two)
    closeTwo(); closeOther()
    assert.equal(ownership.owner('original'), undefined)
})
