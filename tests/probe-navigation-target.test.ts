import assert from 'node:assert/strict'
import test from 'node:test'
import { selectSourceNavigationTarget, sourceNavigationText, sourceLatestTarget, sourceLatestText, sourceOpeningTarget } from '../scripts/probe-navigation-target.mjs'

const older = { turn: 10, messageId: 'source-older', prompt: 'Truncated label' }
const outline = { complete: true, firstTurn: 30, entries: [{ turn: 31, messageId: 'resident' }, older,
    { turn: 20, messageId: 'source-newer' }] }
const message = (messageId: string, text: string, seq = 1) => ({ source: { messageId, at: 100 + seq, seq }, event: {
    type: 'user/message', seq: 100, data: { id: messageId, role: 'user', content: [{ type: 'text', text }] },
} })

test('the target is the oldest archived source identity, regardless of outline array or DOM order', () => {
    assert.deepEqual(selectSourceNavigationTarget(outline), { turn: 10, messageId: 'source-older' })
    assert.deepEqual(selectSourceNavigationTarget({ ...outline, entries: [...outline.entries].reverse() }),
        { turn: 10, messageId: 'source-older' })
})

test('incomplete, resident-only, and ambiguous source targets cannot choose an arbitrary turn', () => {
    assert.throws(() => selectSourceNavigationTarget({ ...outline, complete: false }))
    assert.throws(() => selectSourceNavigationTarget({ ...outline, firstTurn: 10 }))
    assert.throws(() => selectSourceNavigationTarget({ ...outline, entries: [...outline.entries, { ...older, messageId: 'another' }] }))
    assert.throws(() => selectSourceNavigationTarget({ ...outline, entries: [...outline.entries, { ...older, turn: 11 }] }))
})

test('exact target text comes from its source user message, never the shortened outline prompt or a neighboring row', () => {
    const target = selectSourceNavigationTarget(outline)
    const full = 'The complete source message, beyond its abbreviated outline label.'
    assert.equal(sourceNavigationText([message('neighbor', 'wrong'), message(target.messageId, full)], target), full)
    assert.throws(() => sourceNavigationText([message('neighbor', full)], target))
    assert.throws(() => sourceNavigationText([message(target.messageId, full), message('neighbor', full)], target))
})

test('an absent or ambiguous text block fails rather than silently substituting another target', () => {
    const target = selectSourceNavigationTarget(outline)
    assert.throws(() => sourceNavigationText([message(target.messageId, '')], target))
    const row = message(target.messageId, 'first')
    row.event.data.content.push({ type: 'text', text: 'second' })
    assert.throws(() => sourceNavigationText([row], target))
})

test('return-latest requires the freshly identified head body instead of an older opening marker', () => {
    const old = message('opening-head', 'old opening watermark')
    const head = { messageId: 'current-head', at: 102, seq: 2 }
    assert.throws(() => sourceLatestText([old], head))
    const current = { source: head, event: { type: 'assistant/message', data: { message: {
        content: [{ type: 'text', text: 'current source watermark' }],
    } } } }
    assert.equal(sourceLatestText([old, current], head), 'current source watermark')
    assert.throws(() => sourceLatestText([old, current, current], head))
})

const nonText = (messageId: string, seq: number, type: string) => ({ source: { messageId, at: 100 + seq, seq },
    event: { type, seq: 3_000_000_000 + seq, data: { message: { content: [{ type: 'tool-call' }] } } } })

test('tool and lifecycle heads select the newest source text in the same verified context', () => {
    const old = message('old', 'old opening watermark')
    const current = { source: { messageId: 'current', at: 102, seq: 2 }, event: { type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'latest readable answer' }] } } } }
    const tool = nonText('tool', 3, 'assistant/message')
    const result = nonText('head', 4, 'tool/result')
    const lifecycle = { ...result, event: { ...result.event, type: 'step/end' } }
    const annotation = { ...result, event: { ...result.event, type: 'plugin:hapi-dsh/native-item' } }
    const expected = { ...current.source, eventType: 'assistant/message', text: 'latest readable answer' }
    assert.deepEqual(sourceLatestTarget([old, current, tool, result, lifecycle, annotation], result.source), expected)
    assert.deepEqual(sourceLatestTarget([annotation, lifecycle, result, tool, current, old], result.source), expected,
        'source positions, rather than display seq or array order, establish the latest text')
    assert.deepEqual(sourceLatestTarget([old, current, tool, lifecycle], lifecycle.source), expected)
})

test('a stale page or a context with only tools cannot substitute an old opening watermark', () => {
    const old = message('old', 'old opening watermark')
    const tool = nonText('tool', 2, 'assistant/message')
    const head = nonText('head', 3, 'step/end')
    assert.throws(() => sourceLatestTarget([old, tool], head.source), /exact authoritative head/)
    assert.throws(() => sourceLatestTarget([tool, head], head.source), /no readable latest text/)
    assert.throws(() => sourceLatestTarget([old, { ...head, source: { ...head.source, seq: 4 } }], head.source),
        /exact authoritative head/)
})

test('later source arrivals do not move the pinned head baseline', () => {
    const current = message('current', 'pinned text', 2)
    const head = nonText('head', 3, 'tool/result')
    const newer = message('newer', 'arrived after the baseline', 4)
    assert.equal(sourceLatestTarget([current, head, newer], head.source).messageId, current.source.messageId)
})

test('ambiguous latest text or missing source identity fails without choosing an older message', () => {
    const old = message('old', 'old opening watermark')
    const current = message('current', 'latest text', 2)
    const head = nonText('head', 3, 'step/end')
    assert.throws(() => sourceLatestTarget([old, current, current, head], head.source), /identity is ambiguous/)
    assert.throws(() => sourceLatestTarget([old, current, { ...current, source: { ...current.source, messageId: 'other' } }, head],
        head.source), /identity is ambiguous/)
    assert.throws(() => sourceLatestTarget([old, { ...current, source: undefined }, head], head.source), /exact source position/)
    assert.throws(() => sourceLatestTarget([message('old', 'latest text'), current, head], head.source), /text is ambiguous/)
    current.event.data.content.push({ type: 'text', text: 'second block' })
    assert.throws(() => sourceLatestTarget([old, current, head], head.source), /unique exact text block/)
})

const toolResult = (id: string, seq: number, callId = `call-${id}`) => ({
    source: { messageId: id, at: 100 + seq, seq }, event: { type: 'tool/result', data: { message: {
        id: `display-${id}`, source: { kind: 'tool', callId }, toolCallId: callId,
        content: [{ type: 'text', text: 'Output is not used as the identity' }],
    } } },
})

test('a completed tool head pins its official call identity instead of old assistant prose', () => {
    const tool = toolResult('head', 4)
    const annotation = { ...tool, event: { type: 'plugin:hapi-dsh/native-item', data: {} } }
    const result = sourceOpeningTarget([message('old', 'offscreen prose'), tool, annotation], tool.source)
    assert.deepEqual(result.marker, { kind: 'tool-result', callId: 'call-head' })
    assert.equal(result.targetAtHead, true)
    assert.deepEqual(result.sourceHead, tool.source)
    assert.equal(result.messageId, 'head')
})

test('lifecycle head coverage and its nearest completed visible item are reported as distinct identities', () => {
    const tool = toolResult('completed', 3)
    const head = nonText('lifecycle', 4, 'step/end')
    const later = toolResult('later-arrival', 5)
    const result = sourceOpeningTarget([later, head, tool, message('old', 'old prose')], head.source)
    assert.equal(result.messageId, tool.source.messageId)
    assert.equal(result.targetAtHead, false)
    assert.deepEqual(result.sourceHead, head.source)
    assert.deepEqual(result.marker, { kind: 'tool-result', callId: 'call-completed' })
    assert.throws(() => sourceOpeningTarget([tool, later], head.source), /exact authoritative head/)
})

test('tool identity ambiguity and an unsettled head cannot silently select older content', () => {
    const tool = toolResult('head', 4)
    assert.throws(() => sourceOpeningTarget([tool, tool], tool.source), /identity is ambiguous/)
    const wrong = { ...tool, event: { ...tool.event, data: { message: { ...tool.event.data.message, toolCallId: 'other' } } } }
    assert.throws(() => sourceOpeningTarget([wrong], wrong.source), /unambiguous official call identity/)
    const call = nonText('running', 5, 'assistant/message')
    assert.throws(() => sourceOpeningTarget([tool, call], call.source), /no supported exact visible watermark/)
})

test('a text head remains an exact text marker and source positions choose it over an older tool', () => {
    const tool = toolResult('old-tool', 3), head = message('answer', 'latest exact answer', 4)
    assert.deepEqual(sourceOpeningTarget([head, tool], head.source).marker, { kind: 'text', text: 'latest exact answer' })
})

test('text proof preserves raw source whitespace and rejects identities indistinguishable after outer trim', () => {
    const raw = ' \nExact  inner\ntext\n\t'
    const head = message('head', raw, 4)
    assert.equal(sourceNavigationText([head], { turn: 4, messageId: 'head' }), raw)
    assert.equal(sourceLatestText([head], head.source), raw)
    assert.deepEqual(sourceOpeningTarget([head], head.source).marker, { kind: 'text', text: raw })
    const duplicate = message('older', raw.trim(), 3)
    assert.throws(() => sourceNavigationText([duplicate, head], { turn: 4, messageId: 'head' }), /text is ambiguous/)
    assert.throws(() => sourceLatestText([duplicate, head], head.source), /text is ambiguous/)
    assert.throws(() => sourceOpeningTarget([duplicate, head], head.source), /text is ambiguous/)
    const distinct = message('older', 'Exact inner text', 3)
    assert.equal(sourceLatestText([distinct, head], head.source), raw, 'internal whitespace remains significant')
    assert.equal(head.event.data.content[0].text, raw, 'source records are never rewritten for rendering')
})
