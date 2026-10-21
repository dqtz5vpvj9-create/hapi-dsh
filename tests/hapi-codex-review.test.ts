/** Review-shaped source JSON fixtures; the official Session and both source
 * projection lifecycles execute production code. No review model is invoked. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { HapiMessage } from '../src/codex/contracts.ts'
import { parseNativeRow, type NativeBinding } from '../src/codex/native.ts'
import { NativeProjector } from '../src/codex/projector.ts'
import { parseObservedMessage } from '../src/hapi-agent/parser.ts'
import { ObservedProjector } from '../src/hapi-agent/projector.ts'
import { parseSourceCodexReview, sourceStandaloneReview, sourceCodexReviewOf } from '../src/hapi-agent/codex-review.ts'

const raw = JSON.stringify({ findings: [{ title: 'Check the original source boundary', body: 'The queue must retain the same local identifier.',
    priority: 1, confidence_score: 0.93, code_location: { absolute_file_path: '/original/project/queue.ts', line_range: { start: 7, end: 9 } } }],
    overall_correctness: 'patch is incorrect', overall_explanation: 'A source-owned operation must not be replayed automatically.', overall_confidence_score: 0.88 })

test('only standalone source review JSON is recognized, preserving supported aliases and finite values', () => {
    assert.deepEqual(parseSourceCodexReview(raw), { findings: [{ title: 'Check the original source boundary', body: 'The queue must retain the same local identifier.',
        priority: 1, confidenceScore: 0.93, filePath: '/original/project/queue.ts', lineStart: 7, lineEnd: 9 }],
        overallCorrectness: 'patch is incorrect', overallExplanation: 'A source-owned operation must not be replayed automatically.', overallConfidenceScore: 0.88 })
    const aliases = parseSourceCodexReview(JSON.stringify({ findings: [{ title: 'Camel fields', body: 'Body', priority: null, confidenceScore: 0,
        codeLocation: { absoluteFilePath: '/source/file', lineRange: { start: 12, end: 12 } } }, { title: 'Missing body' }, null],
        overallCorrectness: 'patch is correct', overallExplanation: 'Done', overallConfidenceScore: 1, arbitrary: { never: 'exposed' } }))
    assert.equal(aliases?.findings.length, 1)
    assert.deepEqual(aliases?.findings[0], { title: 'Camel fields', body: 'Body', priority: null, confidenceScore: 0, filePath: '/source/file', lineStart: 12, lineEnd: 12 })
    assert.equal(aliases?.overallConfidenceScore, 1)
    assert.equal(JSON.stringify(aliases).includes('arbitrary'), false)
    assert.equal(parseSourceCodexReview('{"overall_explanation":"Finite-only","overall_confidence_score":1e309}')?.overallConfidenceScore, null)
    for (const value of [raw.slice(0, -1), `Review: ${raw}`, `\`\`\`json\n${raw}\n\`\`\``, '[]', '{}', '{"findings":[]}',
        '{"findings":[{"title":"No body"}]}', '{"overall_confidence_score":0.8}', `${raw}\nLater prose`]) assert.equal(parseSourceCodexReview(value), null, value)
    assert.ok(parseSourceCodexReview('{"findings":[],"overall_confidence_score":0}'))
})

test('observed Pi snapshots and live or reasoning rows remain type-stable ordinary text', () => {
    assert.equal(sourceStandaloneReview(raw, { streamSnapshot: true, id: 'normal' }), null)
    assert.equal(sourceStandaloneReview(raw, { id: 'pi-old-nonce-turn-4-message-2-text-0' }), null)
    const row = (data: Record<string, unknown>): HapiMessage => ({ id: 'review-row', localId: null, seq: 1, createdAt: 1000,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'normal-review-id', message: raw, ...data } } } })
    for (const data of [{ streamSnapshot: true }, { id: 'pi-old-turn-1-message-1-text-0' }, { live: true }, { type: 'reasoning' }]) {
        const item = parseObservedMessage(row(data))[0]!
        assert.ok(item.kind === 'assistant'); assert.equal(item.review, undefined); assert.equal(item.text, raw)
    }
    const item = parseObservedMessage(row({}))[0]!
    assert.ok(item.kind === 'assistant'); assert.deepEqual(item.review, parseSourceCodexReview(raw)); assert.equal(item.text, raw)
})

function reviews(session: Session) {
    return session.snapshotEvents().flatMap(event => { const raw = pluginRecordOf(event), value = raw && sourceCodexReviewOf(raw); return value ? [value] : [] })
}
const binding: NativeBinding = { hubId: 'fixture-hub', hapiSessionId: 'fixture-source', threadId: 'original-native-thread', machineId: 'original-machine', home: '/original/home', homeId: 'original-home' }
function nativeRow(final: boolean): HapiMessage {
    return { id: final ? 'final-source-row' : 'provisional-source-row', localId: final ? 'stable-review-item' : null, seq: final ? 2 : 1, createdAt: final ? 1100 : 1000,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'stable-review-item', message: raw, streamSnapshot: true,
            nativeExecution: { threadId: binding.threadId, turnId: 'original-turn', itemId: 'review-item', phase: 'final_answer' } } } } }
}
function nativeEnd(status: 'completed' | 'interrupted' = 'completed'): HapiMessage {
    return { id: 'source-end', localId: null, seq: 3, createdAt: 1200, content: { role: 'agent', content: { type: 'codex', data: {
        type: 'native-turn', id: 'end', nativeExecution: { threadId: binding.threadId, turnId: 'original-turn', turn: { status, started: true, ended: true } },
    } } } }
}

test('native review annotation waits for a proven final item and preserves official source text and boundary identity', () => {
    const session = Session.create(SessionId('native-review-display')), projector = new NativeProjector(session, {
        model: () => 'fixture', provider: () => 'hapi-codex-native', submittedMessage: () => undefined, stream: () => {},
    })
    projector.apply([parseNativeRow(nativeRow(false), binding)!]); assert.equal(reviews(session).length, 0)
    projector.apply([parseNativeRow(nativeRow(true), binding)!, parseNativeRow(nativeEnd(), binding)!])
    const answer = session.snapshotEvents().find(event => event.type === 'assistant/message')!
    assert.deepEqual(answer.data.message.content, [{ type: 'text', text: raw }])
    assert.deepEqual(reviews(session), [{ messageId: answer.data.message.id, sourceRowId: 'final-source-row', surfaceSeq: answer.seq,
        turn: answer.data.turn, step: answer.data.step, review: parseSourceCodexReview(raw) }])
    assert.deepEqual(projector.forkBoundary(answer.data.message.id), { threadId: binding.threadId, turnId: 'original-turn', itemId: 'review-item' })
    const seq = session.seq
    projector.apply([parseNativeRow(nativeRow(true), binding)!, parseNativeRow(nativeEnd(), binding)!]); assert.equal(session.seq, seq)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
})

test('interruption-frozen valid JSON does not invent a completed review', () => {
    const session = Session.create(SessionId('native-review-interrupted')), projector = new NativeProjector(session, {
        model: () => 'fixture', provider: () => 'hapi-codex-native', submittedMessage: () => undefined, stream: () => {},
    })
    projector.apply([parseNativeRow(nativeRow(false), binding)!, parseNativeRow(nativeEnd('interrupted'), binding)!])
    assert.deepEqual(reviews(session), [])
    const answer = session.snapshotEvents().find(event => event.type === 'assistant/message')!
    assert.deepEqual(answer.data.message.content, [{ type: 'text', text: raw }])
})

test('standalone legacy source reviews seed exact timestamps and metadata without replacing the official assistant', () => {
    const id = SessionId('legacy-review-display'), projector = new ObservedProjector(Session.create(id), {
        model: () => 'source-codex', submittedMessage: () => undefined, content: () => undefined, stream: () => {},
    })
    const row: HapiMessage = { id: 'legacy-review-row', localId: null, seq: 1, createdAt: 1000,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'legacy-review', message: raw } } } }
    projector.beginHistorySeed(); projector.apply(parseObservedMessage(row))
    const session = Session.create(id, projector.historySeed()); projector.finishHistorySeed(session)
    const answer = session.snapshotEvents().find(event => event.type === 'assistant/message')!
    assert.deepEqual(answer.data.message.content, [{ type: 'text', text: raw }]); assert.equal(answer.time, 1000)
    assert.equal(reviews(session).length, 1); assert.equal(reviews(session)[0]!.surfaceSeq, answer.seq)
    assert.equal(projector.sourceMessageDisplaySeq(row.id), answer.seq)
    const seq = session.seq; projector.apply(parseObservedMessage(row)); assert.equal(session.seq, seq)
})
