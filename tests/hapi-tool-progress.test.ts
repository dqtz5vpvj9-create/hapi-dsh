/** Original Pi/HAPI wire shapes; production parser, projector and official
 * Session log execute unchanged. No Pi process or model is simulated here. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { HapiMessage } from '../src/codex/contracts.ts'
import { NativeHistoryChangedError } from '../src/codex/projector.ts'
import { parseObservedMessage, parseObservedHistory } from '../src/hapi-agent/parser.ts'
import { ObservedProjector } from '../src/hapi-agent/projector.ts'
import { sourceToolProgressOf } from '../src/hapi-agent/tool-progress.ts'

function row(id: string, seq: number, data: Record<string, unknown>): HapiMessage {
    return { id, localId: null, seq, createdAt: 1000 + seq, content: { role: 'agent',
        content: { type: data.type === 'ready' ? 'event' : 'codex', data } } }
}
const start = () => row('start', 1, { type: 'tool-call', callId: 'source-call', name: 'bash', input: { command: 'long-running-command' } })
const partial = (id: string, seq: number, text: string) => row(id, seq, {
    type: 'tool-call', callId: 'source-call', name: 'bash', input: { command: 'long-running-command' },
    progress: { content: [{ type: 'text', text }], details: { chunks: seq - 1 } },
})
const result = () => row('result', 5, { type: 'tool-call-result', callId: 'source-call',
    output: { content: [{ type: 'text', text: 'Actual final tool output' }] } })
function environment() {
    const session = Session.create(SessionId('source-tool-progress-fixture'))
    const projector = new ObservedProjector(session, {
        model: () => 'fixture-model', submittedMessage: () => undefined, content: () => undefined, stream: () => {},
    })
    return { session, projector }
}
function records(session: Session) {
    return session.snapshotEvents().flatMap(event => {
        const record = pluginRecordOf(event), value = record && sourceToolProgressOf(record)
        return value ? [value] : []
    })
}

test('repeated Pi partialResult updates preserve one source call, generation and official final-result boundary', () => {
    const { session, projector } = environment()
    const initial = start(), first = partial('partial-one', 2, 'First chunk'), second = partial('partial-two', 3, 'Second chunk')
    assert.equal(parseObservedMessage(initial)[0]!.fingerprint, parseObservedMessage(first)[0]!.fingerprint)
    projector.apply(parseObservedMessage(initial)); projector.apply(parseObservedMessage(first))
    projector.apply(parseObservedMessage(second))
    const beforeReplay = session.seq
    projector.apply(parseObservedMessage({ ...second, id: 'same-payload-replayed', seq: 4, createdAt: 1004 }))
    assert.equal(session.seq, beforeReplay)
    assert.equal(projector.session, session)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/call').length, 1)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/result').length, 0)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'turn/end').length, 0)
    assert.deepEqual(records(session).map(value => value.phase), ['progress', 'progress'])
    assert.equal(records(session)[1]!.sourceRowId, 'partial-two')
    assert.equal(projector.sourceMessageDisplaySeq('partial-two'), projector.sourceMessageDisplaySeq('start'))
    projector.apply(parseObservedMessage(result()))
    assert.deepEqual(records(session).map(value => value.phase), ['progress', 'progress', 'result'])
    const officialResults = session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(officialResults.length, 1)
    assert.ok(JSON.stringify(officialResults[0]!.data.message.content).includes('Actual final tool output'))
    const finished = session.seq
    projector.apply(parseObservedMessage(partial('late-partial', 6, 'Must not reopen an ended tool')))
    assert.equal(session.seq, finished)
})

test('a source turn ending without tool completion retains explicitly partial output and does not invent tool success', () => {
    const { session, projector } = environment()
    projector.apply(parseObservedHistory([start(), partial('partial', 2, 'Still running at interruption')]))
    const end = row('ready', 3, { type: 'ready' })
    projector.apply(parseObservedMessage(end))
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/result').length, 0)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'turn/end').length, 1)
    const last = records(session).at(-1)!
    assert.equal(last.phase, 'turn-ended'); assert.ok(last.phase === 'turn-ended')
    assert.equal(last.reason, 'completed'); assert.ok(JSON.stringify(last.payload).includes('Still running at interruption'))
    const finished = session.seq
    projector.apply(parseObservedMessage(partial('late', 4, 'Late partial')))
    assert.equal(session.seq, finished)
    // A genuinely later final source result remains a result, even if its
    // source delivery followed the turn marker; it is never guessed locally.
    projector.apply(parseObservedMessage(result()))
    assert.equal(records(session).at(-1)!.phase, 'result')
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/result').length, 1)
})

test('detached history coalesces progress while retaining source time and exact result status across replay', () => {
    const { session: detached, projector } = environment()
    const rows = [start(), partial('one', 2, 'One'), partial('two', 3, 'Two'), result(), row('ready', 6, { type: 'ready' })]
    projector.beginHistorySeed(); projector.apply(parseObservedHistory(rows))
    const session = Session.create(detached.id, projector.historySeed()); projector.finishHistorySeed(session)
    const observed = records(session)
    assert.deepEqual(observed.map(value => value.phase), ['progress', 'result'])
    assert.equal(observed[0]!.sourceRowId, 'two'); assert.equal(observed[0]!.createdAt, 1003)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/call').length, 1)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/result').length, 1)
    assert.ok(session.snapshotEvents().every((event, index, events) => index === 0 || event.seq === events[index - 1]!.seq + 1))
    const seq = session.seq; projector.apply(parseObservedHistory(rows)); assert.equal(session.seq, seq)
})

test('a changed invocation is still a history correction, and invalid partial payload cannot become a final result', () => {
    const { session, projector } = environment()
    projector.apply(parseObservedMessage(start()))
    const invalid = row('invalid', 2, { type: 'tool-call', callId: 'source-call', name: 'bash',
        input: { command: 'long-running-command' }, progress: { notJson: () => 'ignored' } })
    projector.apply(parseObservedMessage(invalid)); assert.deepEqual(records(session), [])
    const corrected = row('corrected', 3, { type: 'tool-call', callId: 'source-call', name: 'bash', input: { command: 'different-command' } })
    assert.throws(() => projector.apply(parseObservedMessage(corrected)), NativeHistoryChangedError)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/call').length, 1)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/result').length, 0)
})
