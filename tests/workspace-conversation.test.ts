/** Public SlotCore ownership is real; shell services are explicit test doubles.
 * Complete official rendering and source first-send are exercised in e2e/. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationMatch, ConversationNodeContext, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { installRemotePane } from '../src/client/remote-pane.tsx'
import { SOURCE_STATE_VIEW, createSourceStateBuilder, sourceStateDefinition as definition, sourceStateRecord, sourceStateViewDefinition, type SourceStateNode, type SourceStateSnapshot } from '../src/client/source-state-conversation.ts'
import { hapiProjectionSchema } from '../src/codex/projection-types.ts'

test('pane composition preserves the original main/header ownership and third-party header entries through disposal', () => {
    const core = new SlotCore(), Empty = () => null
    core.register({ name: 'root', children: {
        main: { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' }, 'settings.launcher': { kind: 'single', scope: 'root' },
        'sidebar.right.tab.menu.item': { kind: 'list', scope: 'session' }, 'rightbar.session': { kind: 'single', scope: 'session' },
    } }, (_props: PropsRenderSlots<'main' | 'shell.overlay' | 'sidebar.panellist' | 'settings.launcher' | 'sidebar.right.tab.menu.item' | 'rightbar.session'>) => null)
    core.register({ name: 'main', key: 'conversation', children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } } }, (_props: PropsRenderSlots<'main.conversation'>) => null)
    core.register({ name: 'main.conversation', children: { 'conversation.header': { kind: 'single', scope: 'session-maybe' } } }, (_props: PropsRenderSlots<'conversation.header'>) => null)
    core.register({ name: 'conversation.header', children: { 'conversation.session.header': { kind: 'single', scope: 'session' } } }, (_props: PropsRenderSlots<'conversation.session.header'>) => null)
    core.register({ name: 'conversation.session.header', children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
        'conversation.session.header.corner': { kind: 'single', scope: 'session' },
        'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
    } }, (_props: PropsRenderSlots<'conversation.session.header.actions' | 'conversation.session.header.utilities' | 'conversation.session.header.corner' | 'conversation.session.header.lineage'>) => null)
    const originalMain = core.entriesOfSlot('main')[0], originalRoot = core.entriesOfSlot('main.conversation')[0]
    const originalHeader = core.entriesOfSlot('conversation.header')[0]
    const ctx = { slots: {
        register: core.register.bind(core), entriesOfSlot: core.entriesOfSlot.bind(core), subscribe: core.subscribe.bind(core),
        inject: (_key: string, callback: () => () => void) => callback(),
    }, locale: { subscribe: () => () => {} },
    // This ownership fixture does not provide shared workspace preferences.
    // A real Cordis dependency scope remains dormant until that service exists.
    inject: () => ({ dispose() {} }),
    } as unknown as Context
    const pane = installRemotePane(ctx, { localeInstalled: true })
    assert.equal(core.entriesOfSlot('main')[0], originalMain)
    assert.equal(core.entriesOfSlot('main.conversation')[0], originalRoot)
    assert.equal(core.entriesOfSlot('conversation.header')[0], originalHeader)
    assert.equal(core.entries('main').length, 1)
    assert.equal(core.entriesOfSlot('shell.overlay').some(entry => entry.options.id === 'hapi.workspace.pane-bridge'), true)
    core.register({ name: 'conversation.session.header.utilities', id: 'third-party-test' }, Empty)
    const utility = core.entriesOfSlot('conversation.session.header.utilities')[0]
    pane.dispose(); pane.dispose()
    assert.equal(core.entriesOfSlot('main')[0], originalMain)
    assert.equal(core.entriesOfSlot('main.conversation')[0], originalRoot)
    assert.equal(core.entriesOfSlot('conversation.header')[0], originalHeader)
    assert.equal(core.entriesOfSlot('conversation.session.header.utilities')[0], utility)
    assert.equal(core.spec('hapi.remote.bridge'), undefined)
})

const source = hapiProjectionSchema.parse({ engine: 'codex', hubId: 'hub', hapiSessionId: 'actual-source', logicalSessionId: 'display',
    displayRevision: 0, machineId: 'runner-a', machineName: 'Runner A', nativeId: 'native-thread', nativeHome: '/source/codex',
    nativeConnection: 'attached', readOnly: false, model: 'source-model', reasoningEffort: null,
    execution: { owner: 'native', generation: 'source-generation', sequence: 1, status: 'idle', waitingOn: [], turnId: null, startedAt: null, completedAt: null },
    pendingRequests: [], resolvedRequests: [], delivery: [], error: null })!
function match(data: unknown = source, seq = 1, type = 'plugin:hapi-dsh/state'): ConversationStartMatch {
    return { role: 'start', event: { type, data, seq, time: 1000 + seq, ignorable: true } as unknown as ConversationMatch['event'], location: { kind: 'session' } }
}
function context(state?: SourceStateSnapshot): ConversationNodeContext<SourceStateSnapshot> {
    return { key: `${SOURCE_STATE_VIEW}:source`, kind: SOURCE_STATE_VIEW, id: 'source', matches: [], start: undefined, state, current: new Map() }
}
const timeline = { turnOrder: [], turns: new Map() }

test('source business view requires actual validated adapter state and leaves ordinary conversation/blank execution facts unchanged', () => {
    for (const type of ['user/message', 'assistant/message', 'tool/call', 'turn/start', 'turn/end', 'plugin:other/state']) assert.equal(definition.match(match(source, 1, type).event), null)
    for (const invalid of [null, {}, { engine: 'codex', nativeConnection: 'attached' }, { ...source, nativeConnection: 'invented' }]) assert.equal(sourceStateRecord(match(invalid).event), null)
    const initial = match()
    assert.deepEqual(definition.match(initial.event), { id: 'source', role: 'start' })
    const state = definition.start(context(), initial, { previous: () => undefined })
    assert.equal(state.record.kind, 'codex')
    assert.equal(state.record.value.hapiSessionId, 'actual-source')
    assert.equal(state.record.kind === 'codex' && state.record.value.execution?.status, 'idle')
    const node = definition.buildViewNode!(context(state)) as SourceStateNode
    assert.equal(node.target, SOURCE_STATE_VIEW)
    assert.equal(definition.buildLocationData, undefined)
    const builder = createSourceStateBuilder()
    assert.equal(sourceStateViewDefinition.isActive!(builder.empty), false)
    assert.equal(sourceStateViewDefinition.isActive!(builder.replace({ nodes: [node], timeline })), true)
    assert.equal(sourceStateViewDefinition.isActive!(builder.replace({ nodes: [], timeline })), false)
    assert.equal(source.execution?.status, 'idle')
    assert.equal(Object.hasOwn(source, 'blank'), false)
})

test('source view follows newest source record, keeps disconnect/read-only truthful, and clears absent history windows', () => {
    const initial = definition.start(context(), match(source, 10), { previous: () => undefined })
    const disconnected = { ...source, nativeConnection: 'disconnected', readOnly: true }
    const next = definition.update({ ...context(initial), state: initial }, match(disconnected, 11))
    assert.equal(next.record.kind === 'codex' && next.record.value.nativeConnection, 'disconnected')
    assert.equal(next.record.value.readOnly, true)
    assert.equal(definition.update({ ...context(next), state: next }, match(source, 10)), next)
    const builder = createSourceStateBuilder()
    const newer = definition.buildViewNode!(context(next)) as SourceStateNode
    const older = definition.buildViewNode!(context(initial)) as SourceStateNode
    assert.equal(builder.apply({ upserts: [newer, older], timeline }), next)
    assert.equal(builder.replace({ nodes: [], timeline }), null)
})
