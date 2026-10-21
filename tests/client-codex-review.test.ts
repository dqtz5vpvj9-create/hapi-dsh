import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationMatch, ConversationNodeContext, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sourceReviewDefinition as definition, SOURCE_REVIEW_DATA, type SourceReviewTurn } from '../src/client/codex-review-conversation.ts'
import type { SourceCodexReviewRecord } from '../src/hapi-agent/codex-review.ts'

function record(messageId: string, surfaceSeq: number): SourceCodexReviewRecord {
    return { messageId, sourceRowId: `source-${messageId}`, surfaceSeq, turn: 1, step: surfaceSeq,
        review: { findings: [], overallCorrectness: 'patch is correct', overallExplanation: null, overallConfidenceScore: 0.9 } }
}
function match(value: SourceCodexReviewRecord): ConversationStartMatch {
    const event = { type: 'plugin:hapi-dsh/codex-review', data: value, seq: value.surfaceSeq + 1, time: 1000, ignorable: true }
    return { role: 'start', event: event as unknown as ConversationMatch['event'], location: { kind: 'unresolved' } }
}
function context(state?: SourceReviewTurn): ConversationNodeContext<SourceReviewTurn> {
    return { key: 'source-review:1', kind: SOURCE_REVIEW_DATA, id: '1', matches: [], start: undefined, state, current: new Map() }
}
test('review adds only owned Turn data, preserving every official rendering target and per-message identity', () => {
    assert.equal(definition.target, undefined); assert.equal(definition.buildViewNode, undefined)
    const first = match(record('first', 2)), second = match(record('second', 5))
    assert.deepEqual(definition.match(first.event), { id: '1', role: 'start' })
    assert.equal(definition.match({ ...first.event, type: 'assistant/message' } as ConversationMatch['event']), null)
    let state = definition.start(context(), first, { previous: () => undefined })
    state = definition.update({ ...context(state), state }, second)
    assert.equal(definition.update({ ...context(state), state }, second), state)
    assert.equal(definition.buildLocationData!(context(state), 'step', null), null)
    assert.deepEqual(definition.buildLocationData!(context(state), 'turn', null), {
        kind: 'turn', turn: 1, key: SOURCE_REVIEW_DATA, value: [record('first', 2), record('second', 5)],
    })
    assert.equal(definition.match(match({ ...record('bad', 5), turn: 0 }).event), null)
})
