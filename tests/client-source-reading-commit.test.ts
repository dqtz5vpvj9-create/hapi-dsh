/** Real installed Session + Chat assembly. DOM geometry and mounted-reader delivery are explicit seats. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId, type LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { SessionBinding, SessionEventLikeEntry, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import { bindSourceReadingCommits, SourceReadCommits, type SourceReadingCommit } from '../src/client/source-reading-commit.ts'
import { publishPaneMountedChat, type MountedChatControlV1 } from '../src/client/mounted-chat-control.ts'
import { officialChat } from './official-conversation-fixture.ts'
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis } }

function store<T>(initial: T) {
    let current = initial
    const listeners = new Set<() => void>()
    return { getSnapshot: () => current, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        set(value: T) { current = value; for (const listener of [...listeners]) listener() }, notify() { for (const listener of [...listeners]) listener() } }
}

function fixture(t: TestContext, options: { hostId?: string; paneId?: string; focused?: boolean; mounted?: boolean } = {}) {
    const dom = new JSDOM('<!doctype html><section id="pane"><div data-conversation-scroll></div></section>'), window = dom.window, document = window.document
    const target = document.getElementById('pane')!, port = target.firstElementChild as HTMLElement
    let visibility = 'visible', available = true, sequence = 0
    Object.defineProperty(document, 'visibilityState', { get: () => visibility })
    const frames = new Map<number, FrameRequestCallback>()
    window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence }
    window.cancelAnimationFrame = handle => { frames.delete(handle) }
    Object.defineProperties(port, { clientHeight: { value: 500 }, clientWidth: { value: 800 } })
    port.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 800, width: 800, height: 500 }) as DOMRect
    const native = Session.create(SessionId('same-native-session')), chat = officialChat(), entries: SessionEventLikeEntry[] = []
    const assembler = chat.assembler as unknown as Pick<ConversationNodeAssembler, 'append' | 'flush'>
    chat.assembler.replaceWindow([], false); chat.assembler.activateTarget('chat'); chat.assembler.flush()
    const rendered = store(chat.assembler.snapshot('chat'))
    const events = store({ entries, revision: 0, hasMore: false, change: { kind: 'replace', entries } })
    const session = { getSnapshot: () => ({ removed: false }) }
    const binding = { sessionId: native.id, session, eventSource: events } as unknown as SessionBinding
    let currentBinding = binding
    const reference = { sessionId: native.id, get binding() { return currentBinding }, ready: Promise.resolve(binding) } as SessionReference
    const navigation = { hostId: options.hostId ?? 'source-host', paneId: options.paneId ?? 'pane', state: store({ visible: true, focused: options.focused ?? true }) } as unknown as WorkspacePaneNavigation
    const ctx = { uiConversation: { binding: (candidate: SessionBinding) => { assert.equal(candidate, binding); return { target: () => rendered } } } } as unknown as Context
    const commits: SourceReadingCommit[] = [], bus = new SourceReadCommits(), stopFeed = bus.subscribe(value => commits.push(value))
    const facts = { revision: 1, renderRevision: 1, anchor: null as { key: string; top: number } | null, following: true, hasOlder: false, busy: false }
    const notices = new Set<() => void>()
    let heldRender = false
    const renderedNodes = new Map<string, ChatConversationViewNode | undefined>()
    const unsupported = async (): Promise<never> => { throw new Error('Read commits must never move or load a reader') }
    const control: MountedChatControlV1 = { version: 1, read: () => facts, subscribe(listener) { notices.add(listener); return () => { notices.delete(listener) } },
        renderedNode: key => renderedNodes.get(key),
        loadOlder: unsupported, reveal: unsupported, toLatest: unsupported }
    const mount = () => publishPaneMountedChat(target as unknown as HTMLElement, control)
    if (options.mounted !== false) mount()
    const stop = bindSourceReadingCommits(ctx, target as unknown as HTMLElement, reference, navigation, () => available, bus.publish)
    t.after(async () => { stop(); stopFeed(); bus.dispose(); publishPaneMountedChat(target as unknown as HTMLElement, null); await chat.close(); dom.window.close() })
    const render = () => {
        const snapshot = chat.assembler.snapshot('chat'); port.replaceChildren()
        for (const key of snapshot.order) {
            const node = snapshot.nodes.get(key) as ReturnType<typeof snapshot.nodes.get> & { visibility: string }
            if (!node || node.visibility !== 'visible') continue
            const row = document.createElement('div'); row.dataset.chatNodeKey = key; row.dataset.chatAnchorKey = key
            row.getBoundingClientRect = () => ({ top: 20, bottom: 120, left: 0, right: 800, width: 800, height: 100 }) as DOMRect
            row.getClientRects = () => [row.getBoundingClientRect()] as unknown as DOMRectList
            port.append(row)
        }
        rendered.set(snapshot)
        if (!heldRender) {
            renderedNodes.clear(); for (const key of snapshot.order) renderedNodes.set(key, snapshot.nodes.get(key) as ChatConversationViewNode | undefined)
            facts.renderRevision += 1
        }
    }
    const append = (event: SessionEventLikeEntry) => { entries.push(event); assembler.append(event); assembler.flush(); events.set({ ...events.getSnapshot(), revision: events.getSnapshot().revision + 1 }); render() }
    const commit = (event: SessionEvent) => { append({ type: 'event', event }); return event }
    const user = (text = 'original source body') => commit(native.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' }))
    return { binding, reference, navigation, native, commits, facts, entries, target, port, rendered, append, commit, user, mount,
        frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0) },
        notify() { for (const listener of [...notices]) listener() },
        visible(value: string) { visibility = value; document.dispatchEvent(new window.Event('visibilitychange')) },
        available(value: boolean) { available = value; rendered.notify() },
        replaceBinding() { currentBinding = { ...binding } }, stop,
        holdRender(value: boolean) { heldRender = value },
        commitRender() {
            const snapshot = rendered.getSnapshot(); renderedNodes.clear()
            for (const key of snapshot.order) renderedNodes.set(key, snapshot.nodes.get(key) as ChatConversationViewNode | undefined)
            facts.renderRevision += 1; for (const listener of [...notices]) listener()
        },
        unmount() { publishPaneMountedChat(target as unknown as HTMLElement, null) },
    }
}

test('a late mounted reader submits a real source position only after its first committed publication', t => {
    const f = fixture(t, { mounted: false }); const body = f.user(); f.frame(); assert.equal(f.commits.length, 0)
    f.facts.revision = 0; f.mount(); f.frame(); assert.equal(f.commits.length, 0)
    f.facts.revision = 1; f.notify(); f.frame()
    assert.equal(f.commits.length, 1); assert.strictEqual(f.commits[0]!.sessionBinding, f.binding)
    assert.deepEqual(f.commits[0], { hostId: 'source-host', paneId: 'pane', sessionBinding: f.binding, position: { kind: 'dsh', seq: body.seq }, at: body.time })
    f.notify(); f.frame(); assert.equal(f.commits.length, 1, 'unchanged publications are not repeated')
})

test('hidden, unfocused, pre-reading and busy views cannot submit seen state', t => {
    const f = fixture(t, { focused: false }); f.user(); f.frame(); assert.equal(f.commits.length, 0)
    const state = f.navigation.state as ReturnType<typeof store<{ visible: boolean; focused: boolean }>>
    state.set({ visible: false, focused: true }); f.frame(); assert.equal(f.commits.length, 0)
    state.set({ visible: true, focused: true }); f.visible('hidden'); f.frame(); assert.equal(f.commits.length, 0)
    f.visible('visible'); f.available(false); f.frame(); assert.equal(f.commits.length, 0)
    f.available(true); f.facts.busy = true; f.notify(); f.frame(); assert.equal(f.commits.length, 0)
    f.facts.busy = false; f.notify(); f.frame(); assert.equal(f.commits.length, 1)
})

test('focus without an actual body or a visible row is not a read', t => {
    const f = fixture(t); f.frame(); assert.equal(f.commits.length, 0)
    f.user(); f.port.replaceChildren(); f.frame(); assert.equal(f.commits.length, 0)
    f.rendered.notify(); f.frame(); assert.equal(f.commits.length, 0)
})

test('a row outside the visible viewport width cannot submit a read', t => {
    const f = fixture(t); f.user()
    const row = f.port.querySelector<HTMLElement>('[data-chat-node-key]')!
    row.getBoundingClientRect = () => ({ top: 20, bottom: 120, left: 1200, right: 2000, width: 800, height: 100 }) as DOMRect
    f.frame(); assert.equal(f.commits.length, 0)
    row.getBoundingClientRect = () => ({ top: 20, bottom: 120, left: 0, right: 800, width: 800, height: 100 }) as DOMRect
    f.notify(); f.frame(); assert.equal(f.commits.length, 1)
})

test('tail-following body updates commit even when official reading facts do not change', t => {
    const f = fixture(t); const first = f.user('first body'); f.frame()
    const second = f.user('second body'); f.frame()
    assert.equal(f.facts.revision, 1, 'no synthetic reader publication was created')
    assert.deepEqual(f.commits.map(value => value.position.seq), [first.seq, second.seq])
    assert.deepEqual(f.commits.map(value => value.at), [first.time, second.time])
})

test('an anchored viewport records its greatest actually visible body position, not the old top anchor', t => {
    const f = fixture(t); f.user('top body'); const last = f.user('last visible body')
    f.facts.following = false; f.facts.anchor = { key: f.port.firstElementChild!.getAttribute('data-chat-node-key')!, top: 20 }
    f.frame(); assert.equal(f.commits.length, 1); assert.equal(f.commits[0]!.position.seq, last.seq)
})

test('warm Assistant and tool-result rows commit original event identities rather than fractional anchors', t => {
    const f = fixture(t); f.commit(f.native.append('turn/start', { turn: 1 })); f.commit(f.native.append('step/start', { turn: 1, step: 1 })); const user = f.user()
    f.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: user.seq + 0.5, time: Date.now(), data: {
        attemptId: 'reading-attempt' as LlmAttemptId, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' } } } })
    const answer = f.commit(f.native.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'answer' }] }) }, { surfaceOp: 'append' }))
    f.frame(); assert.equal(f.commits.at(-1)!.position.seq, answer.seq)
    f.commit(f.native.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('reading-call'), name: 'fixture_tool', arguments: '{}' }))
    const result = f.commit(f.native.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('reading-call'), content: [{ type: 'text', text: 'result' }], isError: false }) }, { surfaceOp: 'append' }))
    f.frame(); assert.equal(f.commits.at(-1)!.position.seq, result.seq); assert.equal(f.commits.at(-1)!.at, result.time)
})

test('unmount, stale binding and disposal cannot submit a queued former occurrence', t => {
    const f = fixture(t); f.user(); f.unmount(); f.frame(); assert.equal(f.commits.length, 0)
    f.mount(); f.replaceBinding(); f.frame(); assert.equal(f.commits.length, 0)
    f.stop(); f.notify(); f.frame(); assert.equal(f.commits.length, 0)
})

test('a same-key result waits for the official rendered payload acknowledgement instead of a frame', t => {
    const f = fixture(t); f.commit(f.native.append('turn/start', { turn: 1 })); f.commit(f.native.append('step/start', { turn: 1, step: 1 })); f.user()
    const call = f.commit(f.native.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('same-key-call'), name: 'fixture_tool', arguments: '{}' }))
    f.frame(); assert.equal(f.commits.at(-1)!.position.seq, call.seq)
    f.holdRender(true)
    const result = f.commit(f.native.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('same-key-call'), content: [{ type: 'text', text: 'new result' }], isError: false }) }, { surfaceOp: 'append' }))
    f.frame(); f.rendered.notify(); f.frame()
    assert.ok(!f.commits.some(commit => commit.position.seq === result.seq), 'frames and a current source snapshot cannot acknowledge an old rendered Node')
    f.commitRender(); f.frame(); assert.equal(f.commits.at(-1)!.position.seq, result.seq)
})

test('another Host or Pane never borrows the focused occurrence for a read commit', t => {
    const a = fixture(t, { hostId: 'host-a', paneId: 'pane-a', focused: false }), b = fixture(t, { hostId: 'host-b', paneId: 'pane-b' })
    a.user(); b.user(); a.frame(); b.frame()
    assert.equal(a.commits.length, 0); assert.equal(b.commits.length, 1)
    assert.equal(b.commits[0]!.hostId, 'host-b'); assert.equal(b.commits[0]!.paneId, 'pane-b'); assert.strictEqual(b.commits[0]!.sessionBinding, b.binding)
})
