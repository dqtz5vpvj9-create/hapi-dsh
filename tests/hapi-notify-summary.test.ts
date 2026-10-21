/** Source wire examples; Sessions and stream lifecycles are the unchanged official DSH package. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { NativeProjector } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'
import { ObservedProjector } from '../src/hapi-agent/projector.ts'
import type { ObservedItem } from '../src/hapi-agent/parser.ts'
import { projectNotifySummaries, sourceNotifySummaryOf, splitNotifySummary, stripNotifySummaryFooter } from '../src/hapi-agent/notify-summary.ts'

const footer = 'AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"Original task completed","action":"Review the change"}'
const raw = `The original answer.\n${footer}\n\n`

test('only the original source final-line summary convention changes display text', () => {
    assert.deepEqual(splitNotifySummary(raw), { visibleText: 'The original answer.', footer,
        summary: { version: 1, status: 'done', summary: 'Original task completed', action: 'Review the change' } })
    assert.equal(splitNotifySummary(`Done.${footer}`)?.visibleText, 'Done.')
    assert.equal(splitNotifySummary(`   ${footer}  \n \n`)?.visibleText, '')
    const nested = 'AGENT_NOTIFY_SUMMARY {"summary":"Literal AGENT_NOTIFY_SUMMARY token"}'
    assert.equal(splitNotifySummary(nested)?.summary.summary, 'Literal AGENT_NOTIFY_SUMMARY token')
    for (const text of [`Example: ${footer}`, `${footer}\nLater source prose`, `${footer.slice(0, -1)}`, 'AGENT_NOTIFY_SUMMARY []',
        'Text with AGENT_NOTIFY_SUMMARY {"summary":"example"}', `AGENT_NOTIFY_SUMMARY {bad json}`, 'AGENT_NOTIFY_SUMMARY {"summary":"ok"} trailing prose']) {
        assert.equal(splitNotifySummary(text), null, text)
        assert.equal(stripNotifySummaryFooter(text), text)
    }
    assert.deepEqual(splitNotifySummary('AGENT_NOTIFY_SUMMARY {"summary":123,"action":false,"arbitrary":"hidden","version":1e309}')?.summary, {})
})

test('summary projection preserves attachments, reasoning, source bytes and text-part copy semantics', () => {
    const reasoning: ContentBlock = { type: 'reasoning', text: footer }
    const call: ContentBlock = { type: 'tool-call', id: ToolCallId('fixture-call'), name: 'source-tool', arguments: '{}' }
    const content: readonly ContentBlock[] = [{ type: 'text', text: raw }, reasoning, call, { type: 'text', text: `Second body.\n${footer}` }]
    const before = structuredClone(content), display = projectNotifySummaries(content)
    assert.deepEqual(content, before)
    assert.deepEqual(display.content[0], { type: 'text', text: 'The original answer.' })
    assert.equal(display.content[1], reasoning); assert.equal(display.content[2], call)
    assert.deepEqual(display.summaries.map(value => value.blockIndex), [0, 3])
    assert.equal(display.originalText, `${raw.trim()}\n\nSecond body.\n${footer}`)
    const unchanged: ContentBlock[] = [{ type: 'text', text: 'Ordinary assistant answer' }]
    assert.equal(projectNotifySummaries(unchanged).content, unchanged)
})

function nativeAssistant(text: string, final: boolean): Extract<NativeRow, { kind: 'assistant' }> {
    return { kind: 'assistant', key: 'original-answer', rowId: 'source-answer-row', localId: 'source-answer-local', createdAt: 1100,
        execution: { threadId: 'original-thread', turnId: 'source-turn', itemId: 'source-answer-item' },
        text, reasoning: false, final, fingerprint: `${text}:${final}` }
}
function nativeUser(): NativeRow {
    return { kind: 'user', key: 'original-user', rowId: 'source-user-row', localId: 'source-user-local', createdAt: 1000,
        execution: { threadId: 'original-thread', turnId: 'source-turn', itemId: 'source-user-item' },
        text: 'Original request', invoked: true, mode: 'queue', parts: [], fingerprint: 'original-user' }
}
function nativeEnd(): NativeRow {
    return { kind: 'turn', key: 'original-end', rowId: 'source-end-row', localId: null, createdAt: 1200, fingerprint: 'original-end',
        execution: { threadId: 'original-thread', turnId: 'source-turn', turn: { status: 'completed', started: true, ended: true } } }
}
function summaries(session: Session) {
    return session.snapshotEvents().flatMap(event => { const record = pluginRecordOf(event); const value = record && sourceNotifySummaryOf(record); return value ? [value] : [] })
}

test('native completed footer replaces only its transient attempt, retaining one real Step and native boundary', () => {
    const frames: AssistantStreamFrame[] = [], session = Session.create(SessionId('native-summary-stream'))
    const projector = new NativeProjector(session, { model: () => 'source-model', provider: () => 'hapi-codex-native', submittedMessage: () => undefined,
        stream: frame => { frames.push(frame) } })
    const incomplete = nativeAssistant(`The original answer.\nAGENT_NOTIFY_SUMMARY {"status":"done"`, false)
    projector.apply([nativeUser(), incomplete])
    projector.apply([nativeAssistant(raw, false)])
    projector.apply([nativeAssistant(raw, true), nativeEnd()])
    const events = session.snapshotEvents(), answers = events.filter(event => event.type === 'assistant/message')
    assert.equal(answers.length, 1)
    const answer = answers[0]!
    assert.deepEqual(answer.data.message.content, [{ type: 'text', text: 'The original answer.' }])
    assert.equal(events.filter(event => event.type === 'step/start').length, 1)
    assert.equal(events.filter(event => event.type === 'step/end').length, 1)
    assert.equal(frames.filter(frame => frame.type === 'end' && frame.outcome.kind === 'abandoned').length, 1)
    assert.equal(frames.filter(frame => frame.type === 'start').length, 2)
    assert.deepEqual(summaries(session), [{ messageId: answer.data.message.id, sourceRowId: 'source-answer-row', surfaceSeq: answer.seq,
        turn: answer.data.turn, step: answer.data.step, originalText: raw.trim(), summaries: [{ blockIndex: 0,
            summary: { version: 1, status: 'done', summary: 'Original task completed', action: 'Review the change' }, footer }] }])
    assert.equal(projector.rewindLocalIdAtSeq(events.find(event => event.type === 'user/message')!.seq), 'source-user-local')
    assert.ok(projector.forkBoundary(answer.data.message.id))
    const count = events.length
    projector.apply([nativeUser(), nativeAssistant(raw, true), nativeEnd()])
    assert.equal(session.snapshotEvents().length, count)
    assert.equal(incomplete.text.endsWith('"done"'), true)
})

test('native seeded summary metadata uses the exact existing assistant coordinates and source timestamp', () => {
    const id = SessionId('native-summary-seed'), projector = new NativeProjector(Session.create(id), {
        model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined, stream: () => {},
    })
    projector.beginHistorySeed(); projector.apply([nativeUser(), nativeAssistant(raw, true), nativeEnd()])
    const session = Session.create(id, projector.historySeed()); projector.finishHistorySeed(session)
    const events = session.snapshotEvents(), answer = events.find(event => event.type === 'assistant/message')!
    assert.equal(answer.time, 1100); assert.equal(summaries(session)[0]?.surfaceSeq, answer.seq)
    assert.deepEqual([summaries(session)[0]?.turn, summaries(session)[0]?.step], [1, 1])
    assert.ok(events.every((event, index) => index === 0 || event.seq === events[index - 1]!.seq + 1))
})

function observedBase(key: string) { return { key, rowId: key, localId: null, seq: 1, createdAt: 1000,
    scopeId: null, parentToolCallId: null, fingerprint: key, model: 'fixture-claude' } }

test('observed multi-part source history keeps rich content and publishes original copy text once', () => {
    const id = SessionId('observed-summary-seed')
    const reasoning: ContentBlock = { type: 'reasoning', text: footer }
    const content: ContentBlock[] = [{ type: 'text', text: raw }, reasoning, { type: 'text', text: `Other source paragraph.\n${footer}` }]
    const projector = new ObservedProjector(Session.create(id), { model: () => 'fixture', submittedMessage: () => undefined,
        content: item => item.kind === 'assistant' ? content : undefined, stream: () => {} })
    const items: ObservedItem[] = [{ ...observedBase('user'), kind: 'user', parts: [], text: 'Original user', invoked: true, mode: 'queue' },
        { ...observedBase('answer'), kind: 'assistant', text: raw, parts: [], reasoning: false, live: false, cumulative: false },
        { ...observedBase('ready'), kind: 'end', reason: 'completed', error: null }]
    projector.beginHistorySeed(); projector.apply(items)
    const session = Session.create(id, projector.historySeed()); projector.finishHistorySeed(session)
    const answer = session.snapshotEvents().find(event => event.type === 'assistant/message')!
    assert.deepEqual(answer.data.message.content, [{ type: 'text', text: 'The original answer.' }, reasoning, { type: 'text', text: 'Other source paragraph.' }])
    assert.equal(summaries(session).length, 1)
    assert.equal(summaries(session)[0]?.originalText, `${raw.trim()}\n\nOther source paragraph.\n${footer}`)
    assert.deepEqual(summaries(session)[0]?.summaries.map(value => value.blockIndex), [0, 2])
    assert.equal(content[0]!.type === 'text' && content[0]!.text, raw)
})

test('observed live footer completion cannot create a phantom latest Step', () => {
    const frames: AssistantStreamFrame[] = [], session = Session.create(SessionId('observed-summary-stream'))
    const projector = new ObservedProjector(session, { model: () => 'fixture', submittedMessage: () => undefined,
        content: () => undefined, stream: frame => { frames.push(frame) } })
    const item: ObservedItem = { ...observedBase('live-answer'), kind: 'assistant', parts: [], text: 'Body.\nAGENT_NOTIFY_SUMMARY {"status":', reasoning: false, live: true, cumulative: true }
    projector.apply([item])
    projector.apply([{ ...item, text: `Body.\n${footer}`, fingerprint: 'completed-live' }, { ...observedBase('end'), kind: 'end', reason: 'completed', error: null }])
    const events = session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'step/start').length, 1)
    assert.equal(events.filter(event => event.type === 'step/end').length, 1)
    assert.equal(events.filter(event => event.type === 'assistant/message').length, 1)
    assert.equal(summaries(session)[0]?.originalText, `Body.\n${footer}`)
    assert.equal(frames.filter(frame => frame.type === 'start').length, 2)
})
