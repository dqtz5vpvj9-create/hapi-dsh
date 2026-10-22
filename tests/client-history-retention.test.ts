import test from 'node:test'
import assert from 'node:assert/strict'
import { canReleaseHistory } from '../src/client/surface/history-retention.ts'

const idle = { visible: false, events: 1600, running: false, pending: 0, draft: '', attachments: 0, phase: 'plain', questions: 0 }
test('only dormant large histories without in-progress work can release a generation', () => {
    assert.equal(canReleaseHistory(idle), true)
    for (const change of [{ visible: true }, { events: 1500 }, { running: true }, { pending: 1 }, { draft: 'unsent' },
        { attachments: 1 }, { phase: 'submitting' }, { phase: 'adjudicating' }, { questions: 1 }]) {
        assert.equal(canReleaseHistory({ ...idle, ...change }), false, JSON.stringify(change))
    }
})
