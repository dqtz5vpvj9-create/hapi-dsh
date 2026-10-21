import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { ConversationMatch, ConversationNodeContext, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { sourceToolProgressDefinition as definition, SOURCE_TOOL_PROGRESS, type SourceToolProgressState } from '../src/client/tool-progress-conversation.ts'
import type { SourceToolProgress } from '../src/hapi-agent/tool-progress.ts'

const first: SourceToolProgress = { callId: 'display-call', sourceCallId: 'original-call', toolName: 'bash',
    sourceRowId: 'partial-one', createdAt: 1000, turn: 2, step: 3, phase: 'progress', payload: { content: [{ type: 'text', text: 'One' }] } }
function match(record: SourceToolProgress, seq: number): ConversationStartMatch {
    const event = { type: 'plugin:hapi-dsh/tool-progress', data: record, seq, time: record.createdAt, ignorable: true }
    return { role: 'start', event: event as unknown as ConversationMatch['event'], location: { kind: 'unresolved' } }
}
function context(state?: SourceToolProgressState): ConversationNodeContext<SourceToolProgressState> {
    return { key: 'source-progress:display-call', kind: SOURCE_TOOL_PROGRESS, id: first.callId, matches: [], start: undefined, state, current: new Map() }
}

test('progress uses its own additive public chat kind without claiming any official tool or assistant events', () => {
    const initial = match(first, 10)
    assert.deepEqual(definition.match(initial.event), { id: first.callId, role: 'start' })
    for (const type of ['assistant/message', 'tool/call', 'tool/result', 'turn/end']) {
        assert.equal(definition.match({ ...initial.event, type } as ConversationMatch['event']), null)
    }
    let state = definition.start(context(), initial, { previous: () => undefined })
    const next = { ...first, sourceRowId: 'partial-two', createdAt: 1010, payload: { content: [{ type: 'text', text: 'Two' }] } }
    state = definition.update({ ...context(state), state }, match(next, 13))
    const node = definition.buildViewNode!(context(state))
    assert.deepEqual(node, { key: 'source-progress:display-call', id: first.callId, kind: SOURCE_TOOL_PROGRESS,
        target: 'chat', anchorSeq: 10, location: { kind: 'unresolved' }, visibility: 'visible', groupTree: 'process', data: next })
    assert.equal(definition.buildLocationData, undefined)
    assert.equal(definition.update({ ...context(state), state }, match(next, 13)), state)
})

test('an actual result removes the partial node; turn-end without result keeps explicit incomplete evidence', () => {
    const initial = match(first, 10), ctx = context()
    let state = definition.start(ctx, initial, { previous: () => undefined })
    const ended: SourceToolProgress = { ...first, phase: 'turn-ended', reason: 'aborted' }
    state = definition.update({ ...context(state), state }, match(ended, 14))
    assert.deepEqual(definition.buildViewNode!(context(state))?.data, ended)
    assert.equal(definition.update({ ...context(state), state }, match(first, 15)), state)
    const result: SourceToolProgress = { callId: first.callId, sourceCallId: first.sourceCallId, toolName: first.toolName,
        sourceRowId: 'final', createdAt: 1020, turn: 2, step: 3, phase: 'result', isError: true }
    state = definition.update({ ...context(state), state }, match(result, 16))
    assert.equal((definition.buildViewNode!(context(state)) as ChatNode<'hapi-tool-progress'> | null)?.visibility, 'hidden')
    assert.deepEqual(definition.buildViewNode!(context(state))?.data, result)
    assert.equal(definition.update({ ...context(state), state }, match(first, 17)), state)
    assert.equal(definition.match(match({ ...first, step: 0 }, 18).event), null)
})

test('the unchanged official incremental assembler accepts a final hidden upsert instead of withdrawing the materialized progress key', () => {
    const require = createRequire(import.meta.url)
    let registration: { factory(resolve: (id: string) => unknown): Record<string, unknown> } | undefined
    const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8')
    new Function('window', source)({ __ModuleLoader__: { load(value: typeof registration) { registration = value } } })
    assert.ok(registration)
    const unused = new Proxy({}, { get() { throw new Error('The assembler-only test unexpectedly reached a browser service') } })
    const exports = registration.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' || id === '@deepseek-ai/dsh-client-store' ? unused : require(id))
    type Node = ChatNode<'hapi-tool-progress'>
    type Input = { type: 'event'; event: ConversationMatch['event'] }
    const Assembler = exports.ConversationNodeAssembler as new (events: { entries(): typeof definition[]; fallbackEntry(): undefined },
        views: { entries(): Array<{ target: string; create(): {
            empty: ReadonlyMap<string, Node>; replace(input: { nodes: Node[] }): ReadonlyMap<string, Node>;
            apply(input: { upserts: Node[] }): ReadonlyMap<string, Node>
        } }> }) => {
            replaceWindow(input: Input[], more: boolean): void; activateTarget(target: string): void;
            append(input: Input): void; flush(): void; snapshot(target: string): ReadonlyMap<string, Node>
        }
    let snapshot: ReadonlyMap<string, Node> = new Map()
    const assembler = new Assembler({ entries: () => [definition], fallbackEntry: () => undefined }, { entries: () => [{ target: 'chat', create: () => ({
        empty: snapshot,
        replace: ({ nodes }) => { snapshot = new Map(nodes.map(node => [node.key, node])); return snapshot },
        apply: ({ upserts }) => { const next = new Map(snapshot); for (const node of upserts) next.set(node.key, node); snapshot = next; return snapshot },
    }) }] })
    assembler.replaceWindow([{ type: 'event', event: match(first, 10).event }], false)
    assembler.activateTarget('chat'); assembler.flush()
    assert.equal([...assembler.snapshot('chat').values()][0]?.visibility, 'visible')
    const final: SourceToolProgress = { callId: first.callId, sourceCallId: first.sourceCallId, toolName: first.toolName,
        sourceRowId: 'actual-final', createdAt: 1010, turn: 2, step: 3, phase: 'result', isError: false }
    assembler.append({ type: 'event', event: match(final, 11).event })
    assert.doesNotThrow(() => assembler.flush())
    const nodes = [...assembler.snapshot('chat').values()]
    assert.equal(nodes.length, 1); assert.equal(nodes[0]?.visibility, 'hidden'); assert.deepEqual(nodes[0]?.data, final)
})
