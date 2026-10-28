import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { NativeProjector } from '../src/codex/projector.ts'
import { parseNativeRow, compareNativeMessages, type NativeBinding } from '../src/codex/native.ts'
import { ObservedProjector } from '../src/hapi-agent/projector.ts'
import { parseObservedHistory, parseObservedMessage } from '../src/hapi-agent/parser.ts'
import { parseNativeObservation } from '../src/codex/observations.ts'
import { nativeIndexedHistory } from './fixtures/source-conversation-fixture.ts'
import { officialChat, officialHistoryPage } from './official-conversation-fixture.ts'

const binding: NativeBinding = { hubId: 'synthetic-hub', hapiSessionId: 'synthetic-source', threadId: 'synthetic-thread', home: null, homeId: null, machineId: 'synthetic-machine' }

for (const kind of ['native', 'observed'] as const) test(`${kind}: 180-turn indexed history retains real official Chat rows and bounded message metadata`, async () => {
    const source = nativeIndexedHistory(binding.threadId), id = SessionId(`synthetic-long-${kind}`)
    const projector = kind === 'native'
        ? new NativeProjector(Session.create(id), { model: () => 'synthetic-model', provider: () => 'synthetic-provider', submittedMessage: () => undefined, stream: () => {} })
        : new ObservedProjector(Session.create(id), { model: () => 'synthetic-model', submittedMessage: () => undefined, content: () => undefined, stream: () => {} })
    projector.beginHistorySeed()
    if (projector instanceof NativeProjector) projector.apply(source.flatMap(row => { const parsed = parseNativeRow(row, binding); return parsed ? [parsed] : [] }))
    else projector.apply(parseObservedHistory(source))
    const session = Session.create(id, projector.historySeed()), preparedSeq = session.seq
    projector.finishHistorySeed(session)
    const events = session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'user/message').length, 180)
    assert.equal(events.filter(event => event.type === 'assistant/message').length, 4500)
    assert.equal(events.filter(event => event.type === 'turn/end').length, 180)
    assert.equal(session.seq, preparedSeq, 'binding the prepared seed must not append all source annotations as a live tail')
    for (const event of events) assert.equal(events[event.seq], event)
    const page = await officialHistoryPage(session), chat = officialChat()
    try {
        assert.equal(page.hasMore, true)
        assert.ok(page.entries.length < 300, `the 50-message initial window unexpectedly carries ${page.entries.length} events`)
        const bodySeqs = new Set<number>(page.entries.map(({ event }) => event.seq))
        for (const { event } of page.entries) {
            const record = pluginRecordOf(event)
            if (record?.type === 'plugin:hapi-dsh/native-item' || record?.type === 'plugin:hapi-dsh-observed/item') {
                assert.equal(bodySeqs.has((record.data as { surfaceSeq: number }).surfaceSeq), true)
            }
        }
        chat.assembler.replaceWindow(page.entries, page.hasMore); chat.assembler.activateTarget('chat')
        const snapshot = chat.assembler.snapshot('chat')
        const nodes = snapshot.order.map(key => snapshot.nodes.get(key)!)
        const users = nodes.filter(node => node.kind === 'user'), assistants = nodes.filter(node => node.kind === 'assistant-step')
        assert.equal(users.length, 2); assert.equal(assistants.length, 50)
        assert.ok(users.some(node => node.data.content?.some(block => block.text === 'Synthetic original input 180.')))
        const answer = assistants.find(node => node.data.blocks?.some(block => block.text === 'Synthetic final answer 180.'))
        assert.ok(answer)
        assert.ok(chat.assembler.grouped('chat')?.entries.some(entry => entry.kind === 'node' && entry.key === answer.key && entry.groupPart === 'response'), 'official process grouping must leave the actual final answer visible')
    } finally { await chat.close() }
})

test('shared Codex lifecycle is not source-event JSON and completed streamSnapshot history settles once', () => {
    const rows = nativeIndexedHistory(binding.threadId, 1, 2), first = rows[0]!
    const execution = { threadId: binding.threadId, turnId: 'synthetic-turn-0', turn: { status: 'completed', started: true, ended: true } }
    const lifecycle = { ...first, id: 'synthetic-lifecycle', localId: 'synthetic-lifecycle', seq: 0,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'native-turn', id: 'synthetic-lifecycle', nativeExecution: execution } } } }
    const parsed = parseObservedHistory([lifecycle, ...rows])
    assert.equal(parsed.some(item => item.kind === 'notice'), false)
    assert.equal(parsed.filter(item => item.kind === 'end').length, 1)
    assert.equal(parsed.at(-1)?.kind, 'end')
    const answer = parsed.find(item => item.kind === 'assistant' && !item.reasoning)
    assert.ok(answer?.kind === 'assistant'); assert.equal(answer.live, false)
    const provisional = structuredClone(rows.at(-1)!); provisional.localId = null
    const source = provisional.content as { meta: { nativeExecution: { turn?: unknown } } }
    delete source.meta.nativeExecution.turn
    const live = parseObservedMessage(provisional).find(item => item.kind === 'assistant')
    assert.ok(live?.kind === 'assistant'); assert.equal(live.live, true)
})

test('native source stop rows and source position timestamps retain interrupted facts and canonical page order', () => {
    const rows = nativeIndexedHistory(binding.threadId, 1, 1), later = rows[1]!, earlier = rows[0]!
    later.createdAt = earlier.createdAt - 1000
    assert.ok(compareNativeMessages(earlier, later) < 0, 'an old original item timestamp must not reorder a newer source position')
    const stop = { ...later, id: 'synthetic-stop', localId: 'synthetic-stop', content: { role: 'agent',
        meta: { nativeExecution: { threadId: binding.threadId, turnId: 'synthetic-turn-0', turn: { status: 'interrupted', started: true, ended: true } } },
        content: { type: 'event', data: { type: 'message', message: 'Aborted by user' }, id: 'synthetic-stop' } } }
    const parsed = parseNativeRow(stop, binding)
    assert.equal(parsed?.kind, 'turn'); assert.equal(parsed?.execution?.turn?.status, 'interrupted')
    const observed = parseObservedMessage(stop)
    assert.equal(observed.find(item => item.kind === 'end')?.reason, 'aborted')
})

test('source error notices preserve HAPI technical details without inventing another model turn', () => {
    const row = { ...nativeIndexedHistory(binding.threadId, 1, 1)[0]!, content: { role: 'agent', content: { type: 'event',
        data: { type: 'error', message: 'Source request failed. Expand details.', details: 'Synthetic upstream rejection: invalid model selection.' } } } }
    const observed = parseObservedMessage(row)
    assert.equal(observed.length, 1)
    assert.equal(observed[0]?.kind, 'notice')
    const notice = observed.find(item => item.kind === 'notice')?.notice
    assert.equal(notice?.details, 'Synthetic upstream rejection: invalid model selection.')
    const native = parseNativeObservation(row, binding)
    assert.equal(native?.kind, 'notice')
    assert.equal(native?.kind === 'notice' ? native.value.details : undefined, notice?.details)
})
