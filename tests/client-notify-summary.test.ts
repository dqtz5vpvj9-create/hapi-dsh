import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationMatch, ConversationNodeContext, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sourceSummaryDefinition, SOURCE_SUMMARY_DATA, type SourceSummaryTurn } from '../src/client/notify-summary-conversation.ts'
import { createSourceSummaryCoordinator, notifySourceSummarySettings, type SourceSummarySettings } from '../src/client/notify-summary-state.ts'
import type { SourceNotifySummary } from '../src/hapi-agent/notify-summary.ts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test('one workspace coordinator coalesces root and pane reads for the same Hub', async () => {
    const coordinator = createSourceSummaryCoordinator({ pollMs: 0 }), source = coordinator.forHub('hub')
    assert.equal(source, coordinator.forHub('hub')); assert.equal(source.getSnapshot(), false)
    const reply = deferred<SourceSummarySettings>(); let firstReads = 0, secondReads = 0, changes = 0
    const stop = source.subscribe(() => { changes++ })
    const root = source.retain(async () => { firstReads++; return reply.promise })
    const pane = source.retain(async () => { secondReads++; return { hubId: 'hub', sessionSummaryInChat: false } })
    const refresh = coordinator.refresh(); await Promise.resolve()
    assert.equal(firstReads, 1); assert.equal(secondReads, 0)
    reply.resolve({ hubId: 'hub', sessionSummaryInChat: true }); await refresh
    assert.equal(source.getSnapshot(), true); assert.equal(changes, 1)
    root(); await coordinator.refresh()
    assert.equal(secondReads, 1); assert.equal(source.getSnapshot(), false); assert.equal(changes, 2)
    pane(); stop(); await coordinator.refresh(); assert.equal(secondReads, 1); coordinator.dispose()
})

test('source-confirmed preference wins over a stale read and unknown settings never enter the shared state', async () => {
    const coordinator = createSourceSummaryCoordinator({ pollMs: 0 }), source = coordinator.forHub('hub'), reply = deferred<SourceSummarySettings>()
    const release = source.retain(() => reply.promise), refresh = coordinator.refresh()
    notifySourceSummarySettings(coordinator, { hubId: 'hub', sessionSummaryInChat: true })
    reply.resolve({ hubId: 'hub', sessionSummaryInChat: false }); await refresh
    assert.equal(source.getSnapshot(), true)
    release()
    const wrongHub = source.retain(async () => ({ hubId: 'unrelated-hub', sessionSummaryInChat: false }))
    await coordinator.refresh(); assert.equal(source.getSnapshot(), true)
    wrongHub()
    const failed = source.retain(async () => { throw new Error('Source is offline') })
    await coordinator.refresh(); assert.equal(source.getSnapshot(), true)
    failed(); coordinator.dispose()
})

test('shared summary preferences isolate Hubs and disposal cannot publish a late read', async () => {
    const coordinator = createSourceSummaryCoordinator({ pollMs: 0 }), first = coordinator.forHub('first'), second = coordinator.forHub('second')
    coordinator.accept({ hubId: 'first', sessionSummaryInChat: true })
    assert.equal(first.getSnapshot(), true); assert.equal(second.getSnapshot(), false)
    const reply = deferred<SourceSummarySettings>(); let changes = 0
    second.subscribe(() => { changes++ }); second.retain(() => reply.promise)
    const refresh = coordinator.refresh(); coordinator.dispose(); reply.resolve({ hubId: 'second', sessionSummaryInChat: true }); await refresh
    assert.equal(changes, 0); assert.equal(second.getSnapshot(), false)
})

function record(messageId: string, turn = 1, step = 1, seq = 5): SourceNotifySummary {
    return { messageId, turn, step, surfaceSeq: seq, sourceRowId: `source-${messageId}`, originalText: 'Raw source footer',
        summaries: [{ blockIndex: 0, footer: 'AGENT_NOTIFY_SUMMARY {"summary":"Done"}', summary: { summary: 'Done' } }] }
}
function match(value: SourceNotifySummary): ConversationStartMatch {
    // Plugin records are intentionally outside SessionEventMap. The published
    // log preserves them under their runtime type, validated by their owner.
    const event = { type: 'plugin:hapi-dsh/notify-summary', data: value, seq: 10, time: 1000, ignorable: true }
    return { role: 'start', event: event as unknown as ConversationMatch['event'], location: { kind: 'unresolved' } }
}
function context(state: SourceSummaryTurn | undefined): ConversationNodeContext<SourceSummaryTurn> {
    return { key: 'summary:1', kind: SOURCE_SUMMARY_DATA, id: '1', matches: [], start: undefined, state, current: new Map() }
}

test('summary Definition owns only its Turn data and never claims an official rendering target', () => {
    assert.equal(sourceSummaryDefinition.target, undefined); assert.equal(sourceSummaryDefinition.buildViewNode, undefined)
    const first = match(record('a')), second = match(record('b', 1, 2, 9))
    assert.deepEqual(sourceSummaryDefinition.match(first.event), { id: '1', role: 'start' })
    assert.equal(sourceSummaryDefinition.match({ ...first.event, type: 'user/message' } as ConversationMatch['event']), null)
    let state = sourceSummaryDefinition.start(context(undefined), first, { previous: () => undefined })
    state = sourceSummaryDefinition.update({ ...context(state), state }, second)
    const same = sourceSummaryDefinition.update({ ...context(state), state }, second)
    assert.equal(same, state)
    assert.equal(sourceSummaryDefinition.buildLocationData!(context(state), 'step', null), null)
    const published = sourceSummaryDefinition.buildLocationData!(context(state), 'turn', null)
    assert.deepEqual(published, { kind: 'turn', turn: 1, key: SOURCE_SUMMARY_DATA, value: [record('a'), record('b', 1, 2, 9)] })
    assert.equal(sourceSummaryDefinition.buildLocationData!(context(state), 'turn', published), published)
    const malformed = match({ ...record('bad'), step: 0 })
    assert.equal(sourceSummaryDefinition.match(malformed.event), null)
})
