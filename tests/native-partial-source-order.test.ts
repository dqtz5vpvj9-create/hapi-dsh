import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { NativeProjector } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'
import { orderSourceWindow } from '../src/client/source-event-order.ts'
import { officialChat } from './official-conversation-fixture.ts'

function page(name: string, at: number, seq: number, step: number) {
    const projector = new NativeProjector(Session.create(SessionId(`partial-order-${name}`)), {
        model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined,
        stream: () => {}, turnBase: 1_000_000,
    })
    projector.setSuppressFirstTurnStart()
    projector.beginHistorySeed()
    const row: NativeRow = { kind: 'assistant', key: name, rowId: name, localId: name, seq: at,
        createdAt: at, fingerprint: name, text: name, final: true, reasoning: false,
        execution: { threadId: 'thread', turnId: 'one-long-turn', itemId: name } }
    projector.apply([row])
    const events = projector.historySeed()
    const sequence = new Map(events.map((event, index) => [Number(event.seq), seq + index]))
    return events.map((event, index) => {
        const data = event.data as Record<string, unknown>
        return { type: 'event' as const, event: { ...event, seq: seq + index, data: { ...data,
            ...(typeof data.step === 'number' ? { step } : {}),
            ...(typeof data.displayStep === 'number' ? { displayStep: step } : {}),
            ...(typeof data.surfaceSeq === 'number' ? { surfaceSeq: sequence.get(data.surfaceSeq) } : {}),
        } }, source: { messageId: name, at, seq: at } } as unknown as SessionEventLikeEntry
    })
}

test('sorting a clipped live turn does not invent a start after a subsequently prepended older page', async () => {
    const chat = officialChat()
    try {
        const tail = orderSourceWindow([...page('later', 30, 1000, 3), ...page('middle', 20, 1100, 2)])
        const older = page('older', 10, 900, 1)
        const records = (rows: readonly SessionEventLikeEntry[]) => rows as unknown as readonly { type: 'event'; event: SessionEvent }[]
        chat.assembler.replaceWindow(records(tail), true)
        chat.assembler.activateTarget('chat')
        assert.doesNotThrow(() => chat.assembler.prepend(records(older), true),
            'the official turn-process context must accept preceding content of the same partial turn')
        chat.assembler.flush()
        const snapshot = chat.assembler.snapshot('chat')
        const text = snapshot.order.map(key => snapshot.nodes.get(key)).flatMap(node => node?.data.blocks ?? [])
            .flatMap(part => typeof part.text === 'string' ? [part.text] : [])
        assert.deepEqual(text, ['older', 'middle', 'later'])
        assert.equal(tail.filter(row => row.event.type === 'turn/start').length, 0,
            'an unavailable source prefix does not prove where its turn started')
    } finally { await chat.close() }
})

function toolPage(kind: 'tool-call' | 'tool-result', at: number, seq: number) {
    const projector = new NativeProjector(Session.create(SessionId(`partial-tool-${kind}`)), {
        model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined,
        stream: () => {}, turnBase: 1_000_000,
    })
    projector.setSuppressFirstTurnStart()
    projector.beginHistorySeed()
    const base = { key: kind, rowId: kind, localId: kind, seq: at, createdAt: at, fingerprint: kind,
        execution: { threadId: 'thread', turnId: 'one-long-turn', itemId: 'same-tool-item' }, callId: 'same-call' }
    const row: NativeRow = kind === 'tool-call' ? { ...base, kind, name: 'fixture', input: {} }
        : { ...base, kind, output: 'synthetic output', isError: false }
    projector.apply([row])
    const events = projector.historySeed()
    const sequence = new Map(events.map((event, index) => [Number(event.seq), seq + index]))
    return events.map((event, index) => {
        const data = event.data as Record<string, unknown>
        return { type: 'event' as const, event: { ...event, seq: seq + index, data: { ...data,
            ...(typeof data.surfaceSeq === 'number' ? { surfaceSeq: sequence.get(data.surfaceSeq) } : {}),
        } }, source: { messageId: kind, at, seq: at } } as unknown as SessionEventLikeEntry
    })
}

test('a late call precedes its resident result within one step in official chat and trajectory', async () => {
    const chat = officialChat({ trajectory: true })
    try {
        const ordered = orderSourceWindow([...toolPage('tool-result', 20, 1000), ...toolPage('tool-call', 10, 1100)])
        assert.doesNotThrow(() => chat.assembler.replaceWindow(ordered as unknown as readonly { type: 'event'; event: SessionEvent }[], true))
        chat.assembler.activateTarget('chat')
        chat.assembler.activateTarget('trajectory')
        assert.doesNotThrow(() => chat.assembler.flush())
        const call = ordered.findIndex(row => row.event.type === 'tool/call')
        const result = ordered.findIndex(row => row.event.type === 'tool/result')
        const assistant = ordered.findIndex(row => row.event.type === 'assistant/message')
        assert.ok(assistant < call && call < result)
        assert.equal(ordered.filter(row => row.event.type === 'tool/call').length, 1)
        assert.equal(ordered.filter(row => row.event.type === 'tool/result').length, 1)
        assert.equal(ordered.filter(row => row.event.type === 'turn/start').length, 0)
        for (const row of ordered.filter(row => String(row.event.type) === 'plugin:hapi-dsh/native-item')) {
            const data = row.event.data as Record<string, unknown>
            const body = ordered.find(item => Number(item.event.seq) === data.surfaceSeq)!
            assert.ok(body, 'every source annotation still addresses its own durable message')
            assert.equal((body as unknown as { source: { messageId: string } }).source.messageId, data.sourceMessageId)
            assert.ok(Number(body.event.seq) < Number(row.event.seq), 'source annotations follow their relocated bodies')
        }
    } finally { await chat.close() }
})

test('a result-only partial tool step stays partial until its real call is available', async () => {
    const chat = officialChat({ trajectory: true })
    try {
        const rows = toolPage('tool-result', 20, 1000)
        const ordered = orderSourceWindow(rows)
        assert.equal(ordered.filter(row => row.event.type === 'tool/call').length, 0)
        assert.equal(ordered.filter(row => row.event.type === 'turn/start').length, 0)
        assert.equal(ordered.filter(row => row.event.type === 'tool/result').length, 1)
        assert.equal(ordered.length, rows.length)
        assert.doesNotThrow(() => chat.assembler.replaceWindow(ordered as unknown as readonly { type: 'event'; event: SessionEvent }[], true))
        chat.assembler.activateTarget('chat')
        chat.assembler.activateTarget('trajectory')
        assert.doesNotThrow(() => chat.assembler.flush())
    } finally { await chat.close() }
})
