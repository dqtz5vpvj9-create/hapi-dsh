/** Actual reading binding with DOM/Session boundary doubles; no browser claim. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import type { PaneReadingIntent } from '../src/client/reading-intent.ts'
import { bindPaneReading, registerLatestCancellation } from '../src/client/reading-view.ts'
import { bindRemotePaneReading } from '../src/client/remote-reading.ts'
import { publishPaneMountedChat } from '../src/client/mounted-chat-control.ts'
import { officialChat } from './official-conversation-fixture.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'
import { createWorkspaceUpdatePreparations } from '../src/client/update-preparation.ts'
import { armOrdinaryReadingForReload, installOrdinaryReadingMemory } from '../src/client/ordinary-reading-checkpoint.ts'

function store<T>(initial: T) {
    let value = initial
    const listeners = new Set<() => void>()
    return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
        set(next: T) { value = next; for (const listener of listeners) listener() } }
}
class Events {
    readonly listeners = new Map<string, Set<(event: Event) => void>>()
    addEventListener(type: string, listener: (event: Event) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set())
        this.listeners.get(type)!.add(listener)
    }
    removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener) }
    emit(type: string, target: unknown, values: Record<string, unknown> = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener({ type, target, isTrusted: true, ...values } as unknown as Event)
    }
}
async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve() }

function nativeWindow(kind: 'tool' | 'assistant', warm: boolean, result = false) {
    const native = Session.create(SessionId('session')), chat = officialChat(), entries: SessionEventLikeEntry[] = []
    const assembler = chat.assembler as unknown as Pick<ConversationNodeAssembler, 'append' | 'flush'>
    chat.assembler.replaceWindow([], false); chat.assembler.activateTarget('chat'); chat.assembler.flush()
    const append = (entry: SessionEventLikeEntry) => { entries.push(entry); assembler.append(entry); assembler.flush() }
    append({ type: 'event', event: native.append('turn/start', { turn: 1 }) })
    append({ type: 'event', event: native.append('step/start', { turn: 1, step: 1 }) })
    const user = native.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'source prompt' }] }), { surfaceOp: 'append' })
    append({ type: 'event', event: user })
    if (warm) append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: user.seq + 0.5, time: Date.now(),
        data: { attemptId: 'reading-fixture-attempt' as LlmAttemptId, turn: 1, step: 1, chunk: kind === 'tool'
            ? { type: 'tool-call-delta', index: 0, id: ToolCallId('reading-fixture-call'), name: 'fixture_tool', argumentsDelta: '{}' }
            : { type: 'text-delta', index: 0, text: 'source answer' } } } })
    let target: SessionEvent = kind === 'tool'
        ? native.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('reading-fixture-call'), name: 'fixture_tool', arguments: '{}' })
        : native.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'source answer' }] }) }, { surfaceOp: 'append' })
    append({ type: 'event', event: target })
    if (result) {
        target = native.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
            callId: ToolCallId('reading-fixture-call'), content: [{ type: 'text', text: 'source result' }], isError: false,
        }) }, { surfaceOp: 'append' })
        append({ type: 'event', event: target })
    }
    const nodes = () => { const snapshot = chat.assembler.snapshot('chat'); return snapshot.order.map(key => snapshot.nodes.get(key)!).filter(Boolean) }
    const row = nodes().find(node => node.kind === (kind === 'tool' ? 'tool-call' : 'assistant-step'))!
    assert.ok(row)
    return { target, row, nodes, entries: () => entries, close: () => chat.close() }
}

function fixture(options: { scrollend?: boolean; returnToLive?: (signal?: AbortSignal) => boolean | Promise<boolean>;
    latestControl?: 'button' | 'following' | 'missing'; sourceHistory?: boolean; hhpi?: boolean; remoteBinding?: boolean;
    storage?: Map<string, string>; reload?: boolean; initialLatest?: boolean; ordinaryHero?: boolean;
    nativePage?: (signal: AbortSignal) => Promise<void>; missingNativeTarget?: boolean;
    nativeResident?: boolean; emptyNative?: boolean; nativeWindow?: ReturnType<typeof nativeWindow>; emptyEventSource?: boolean } = {}) {
    const observer = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
    let now = 0, id = 0, top = 300, rowTop = 500, rowPresent = true
    const timers = new Map<number, { at: number; run: () => void }>(), frames = new Map<number, FrameRequestCallback>()
    const storage = options.storage ?? new Map<string, string>(), writes: number[] = [], loads: number[] = [], officialClicks: number[] = []
    const nativeReads: unknown[] = [], nativeReveals: unknown[] = []
    let nativeLoaded = options.nativeResident ?? !options.nativePage
    const window = Object.assign(new Events(), {
        innerWidth: 390, innerHeight: 844,
        performance: { getEntriesByType: () => options.reload ? [{ type: 'reload' }] : [] },
        sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
        setTimeout(run: () => void, delay: number) { const handle = ++id; timers.set(handle, { at: now + delay, run }); return handle },
        clearTimeout(handle: number) { timers.delete(handle) },
        requestAnimationFrame(run: FrameRequestCallback) { const handle = ++id; frames.set(handle, run); return handle },
        cancelAnimationFrame(handle: number) { frames.delete(handle) },
    })
    const root = Object.assign(new Events(), {
        dataset: {} as Record<string, string>, isConnected: true, hidden: false,
        closest: (selector: string) => selector.includes('aria-hidden') ? null : root,
        querySelector: (selector: string) => selector === '[data-conversation-scroll]' ? port
            : options.ordinaryHero && selector === '[data-conversation-content][data-content-phase="hero"] [data-composer-input]' ? {} : null,
        querySelectorAll: (selector: string) => selector === 'button[aria-label]' ? (!options.latestControl || options.latestControl === 'button' ? [latestButton] : [])
            : selector.includes('data-chat-anchor-key') && rowPresent ? [row] : [],
        prepend: () => {}, append: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    })
    const document = Object.assign(new Events(), { defaultView: window, visibilityState: 'visible', elementFromPoint: () => rowPresent ? row : null,
        createElement: () => ({ className: '', textContent: '', type: '', onclick: undefined, setAttribute() {}, append() {}, remove() {} }) }
    )
    const port = {
        ...(options.scrollend === false ? {} : { onscrollend: null }), ownerDocument: document,
        scrollHeight: 5000, clientHeight: 660,
        get scrollTop() { return top }, set scrollTop(value: number) { writes.push(value); top = value },
        getBoundingClientRect: () => ({ top: 40, bottom: 700, left: 0, right: 390, height: 660 }),
        contains: (element: unknown) => element === row,
        closest: (selector: string) => selector === '[data-conversation-scroll]'
            || selector === '[data-chat-following-tail]' && options.latestControl === 'following' ? port : null,
        querySelector: () => null,
        querySelectorAll: () => rowPresent ? [row] : [],
    }
    const row = {
        parentElement: root, dataset: { chatNodeKey: 'message-50', chatAnchorKey: 'message-50' }, tagName: 'DIV',
        getBoundingClientRect: () => ({ top: 40 + rowTop - top, bottom: 140 + rowTop - top, height: 100 }),
        getClientRects: () => rowPresent ? [row.getBoundingClientRect()] : [],
        closest: (selector: string) => selector === '[data-chat-node-key]' ? row : selector === '[data-conversation-scroll]' ? port : null,
        getAttribute: () => null, hasAttribute: () => false,
    }
    const latestButton = {
        className: 'official_toBottom', disabled: false, getClientRects: () => [{}],
        click() { officialClicks.push(port.scrollHeight); port.scrollTop = port.scrollHeight - port.clientHeight },
    }
    Object.assign(root, { ownerDocument: document })
    const state = store({ visible: true, focused: true }), reading = store<PaneReadingIntent | undefined>(options.initialLatest
        ? { revision: 1, sessionId: 'session', target: { kind: 'latest' } } : undefined)
    const eventState = store({ revision: 0, change: { kind: 'append' } })
    const windowEntries = () => nativeLoaded ? options.nativeWindow?.entries() ?? [] : []
    const events = { ...eventState, getSnapshot: () => ({ ...eventState.getSnapshot(), entries: options.emptyEventSource ? [] : windowEntries() }) }
    const history = store({ openState: 'open', loadingOlder: false, removed: false, blank: options.ordinaryHero === true, hasMore: false, running: false, promptAttempted: false })
    const sourceWindow = store({ hasMoreAfter: false, historyId: 'host-a', historyVersion: 0 })
    let completeLoad: (() => void) | undefined
    const sessionId = options.hhpi ? 'hhpi:reading-machine:reading-source:codex:reading-thread' : 'session'
    let sourceEpoch = 'reading-epoch-1'
    const reference = { sessionId, ready: Promise.resolve(), binding: { sessionId, eventSource: events,
        session: { sessionId, ...history, get sourceEpoch() { return sourceEpoch }, returnToLive: options.returnToLive,
            ...(options.remoteBinding ? { readingView: {} } : {}), ...(options.sourceHistory ? { sourceWindow } : {}),
            loadThrough(seq: number) { loads.push(seq); return new Promise<void>(resolve => { completeLoad = resolve }) } } } } as unknown as SessionReference
    const heroChat = options.ordinaryHero ? officialChat() : undefined
    if (heroChat) { heroChat.assembler.replaceWindow([], false); heroChat.assembler.flush(); assert.equal(heroChat.assembler.snapshot('chat'), undefined) }
    const ctx = new Context(), application = new WorkspaceApplicationIdentity(), updates = createWorkspaceUpdatePreparations()
    application.set({ accountId: 'reading-account', origin: 'https://fixture.invalid' }, 'reading-device')
    ctx.reflect.provide('sessions', { list: { getSnapshot: () => ({ byId: { session: {} } }) }, binding: () => reference.binding } as unknown as Context['sessions'])
    ctx.reflect.provide('locale', { bind: () => () => 'To bottom', getSnapshot: () => ({ active: 'en' }) } as unknown as Context['locale'])
    ctx.reflect.provide('uiConversation', { binding: () => ({
            readingView: { snapshot: { getSnapshot: () => ({ entries: windowEntries() }) }, async read(request: { target: { seq: number } }, signal: AbortSignal) {
                if (options.nativePage) {
                    nativeReads.push(request); await options.nativePage(signal); nativeLoaded = !options.missingNativeTarget
                } else {
                    loads.push(request.target.seq)
                    await new Promise<void>(resolve => { completeLoad = resolve })
                }
            } },
            target: () => ({ getSnapshot: () => heroChat ? heroChat.assembler.snapshot('chat') : options.emptyNative ? undefined : ({
                order: nativeLoaded ? options.nativeWindow?.nodes().map(node => node.key) ?? ['message-50'] : [],
                nodes: {
                get: (key: string) => options.nativeWindow ? options.nativeWindow.nodes().find(node => node.key === key) : key === 'message-50' ? { key, anchorSeq: 50 } : undefined,
                values: () => nativeLoaded ? options.nativeWindow?.nodes() ?? [{ key: 'message-50', anchorSeq: 50, kind: 'assistant-step' }] : [],
            } }), subscribe: () => { heroChat?.assembler.activateTarget('chat'); return () => {} } }),
        }) } as unknown as Context['uiConversation'])
    const stopMemory = installOrdinaryReadingMemory(ctx)
    const navigation = { hostId: 'host', paneId: 'pane', state, reading, application, updates } as unknown as WorkspacePaneNavigation
    if (!options.emptyNative) publishPaneMountedChat(root, { version: 1,
        read: () => ({ revision: 0, anchor: null, following: false, hasOlder: true, busy: false }), subscribe: () => () => {},
        checkpointReading() { ctx.chatScrollMemory.forBinding(reference.binding)!.save({ anchorKey: 'message-50', anchorTop: rowTop - top, scrollTop: top }) },
        async loadOlder() { throw new Error('Exact notification navigation must not replay intervening history') },
        async reveal(target) { nativeReveals.push(target) }, async toLatest() { throw new Error('A missing original target cannot fall back to latest') },
    })
    const dispose = (options.remoteBinding ? bindRemotePaneReading : bindPaneReading)(ctx, root as unknown as HTMLElement, reference, navigation)
    const framesNow = () => { const current = [...frames.values()]; frames.clear(); for (const run of current) run(now) }
    return {
        root, document, window, port, row, writes, loads,
        replaceSourceEpoch(value: string) { sourceEpoch = value; sourceWindow.set({ ...sourceWindow.getSnapshot(), historyId: value }) }, officialClicks, state, reading, sourceWindow, nativeReads, nativeReveals, updates, storage,
        async ready() { await microtasks(); root.emit('scroll', port); framesNow() },
        replace() { events.set({ revision: events.getSnapshot().revision + 1, change: { kind: 'replace' } }) },
        gesture(type: string, values: Record<string, unknown> = {}) { root.emit(type, row, values) },
        scroll(value: number) { top = value; root.emit('scroll', port); framesNow() },
        shift(value: number) { rowTop += value },
        showRow(value: boolean) { rowPresent = value },
        end() { root.emit('scrollend', port); framesNow() },
        flushFrames: framesNow,
        async complete() { completeLoad?.(); await microtasks() },
        advance(duration: number) {
            now += duration
            for (const [handle, timer] of [...timers]) if (timer.at <= now) { timers.delete(handle); timer.run() }
        },
        dispose() {
            dispose()
            stopMemory(); updates.dispose(); application.dispose(); void ctx.fiber.dispose(); void heroChat?.close()
            publishPaneMountedChat(root, null)
            if (observer) Object.defineProperty(globalThis, 'MutationObserver', observer)
            else Reflect.deleteProperty(globalThis, 'MutationObserver')
        },
    }
}

test('the actual Pane binding registers its official reader checkpoint and restores only its armed untargeted reload', async () => {
    const before = fixture(); await before.ready(); await before.updates.checkpoint(); armOrdinaryReadingForReload(before.updates)
    const saved = before.storage; before.dispose()
    const after = fixture({ storage: saved, reload: true })
    try {
        await after.ready(); assert.deepEqual(after.loads, [50]); await after.complete()
        assert.deepEqual(after.nativeReveals, [{ key: 'message-50', seq: 50 }]); assert.deepEqual(after.writes, [])
    } finally { after.dispose() }
})

test('explicit initial latest skips the controlled ticket and arbitrary legacy reload anchors are never read', async () => {
    const before = fixture(); await before.ready(); await before.updates.checkpoint(); armOrdinaryReadingForReload(before.updates)
    const saved = before.storage; before.dispose()
    const explicit = fixture({ storage: saved, reload: true, initialLatest: true })
    try {
        await explicit.ready(); explicit.flushFrames(); await microtasks()
        assert.deepEqual(explicit.loads, []); assert.deepEqual(explicit.nativeReveals, []); assert.deepEqual(explicit.officialClicks, [5000])
    } finally { explicit.dispose() }
    const legacyKey = 'hapi-dsh:reload-reading:["host","pane","session"]'
    saved.set(legacyKey, JSON.stringify({ key: 'message-50', seq: 50, offset: 30 }))
    const ordinary = fixture({ storage: saved, reload: true })
    try {
        await ordinary.ready(); assert.deepEqual(ordinary.loads, []); assert.deepEqual(ordinary.nativeReveals, [])
        assert.ok(saved.has(legacyKey), 'the original unscoped record remains available for explicit local recovery')
    } finally { ordinary.dispose() }
})

test('ordinary DSH notification reads around its original message and reveals through the mounted native reader', async t => {
    const f = fixture({ nativePage: async () => {} }); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'message', messageId: '50', origin: 'notification' } })
    await microtasks()
    assert.deepEqual(f.nativeReads, [{ kind: 'around', target: { key: '50', seq: 50 } }])
    assert.deepEqual(f.nativeReveals, [{ key: 'message-50', seq: 50 }])
    assert.deepEqual(f.loads, []); assert.deepEqual(f.writes, [])
})

test('a removed ordinary DSH notification target reports failure without landing at latest or another message', async t => {
    const f = fixture({ nativePage: async () => {}, missingNativeTarget: true }); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'message', messageId: '50', origin: 'notification' } })
    await microtasks()
    assert.equal(f.root.dataset.hapiReading, 'error'); assert.deepEqual(f.nativeReveals, []); assert.deepEqual(f.loads, [])
})

for (const kind of ['tool', 'assistant'] as const) {
    for (const resident of [true, false]) test(`HHPI ${resident ? 'resident streamed' : 'cold'} native ${kind} reveals its original integer source identity`, async t => {
        const window = nativeWindow(kind, resident); t.after(() => window.close())
        const f = fixture({ hhpi: true, remoteBinding: true, nativeWindow: window, nativeResident: resident,
            nativePage: async () => { if (resident) throw new Error('The exact resident target must not read another window') } })
        t.after(() => f.dispose()); await f.ready()
        if (resident) assert.notEqual(Math.floor(window.row.anchorSeq), window.target.seq,
            'the actual streamed row proves that rounding its sorting anchor loses the committed event identity')
        f.reading.set({ revision: 1, sessionId: 'hhpi:reading-machine:reading-source:codex:reading-thread',
            target: { kind: 'message', messageId: String(window.target.seq), origin: 'link' } })
        await microtasks()
        assert.equal(f.root.dataset.hapiReading, 'ready')
        assert.deepEqual(f.nativeReads, resident ? [] : [{ kind: 'around', target: { key: String(window.target.seq), seq: window.target.seq } }])
        assert.deepEqual(f.nativeReveals, [{ key: window.row.key, seq: window.target.seq }])
        assert.deepEqual(f.loads, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.officialClicks, [])
    })

    test(`an already mounted streamed native ${kind} reveals its original durable identity without a history read`, async t => {
        const window = nativeWindow(kind, true); t.after(() => window.close())
        const f = fixture({ nativeWindow: window, nativeResident: true, nativePage: async () => { throw new Error('A resident original must not reload') } }); t.after(() => f.dispose()); await f.ready()
        assert.notEqual(window.row.anchorSeq, window.target.seq)
        f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'message', messageId: String(window.target.seq), origin: 'notification' } })
        await microtasks()
        assert.equal(f.root.dataset.hapiReading, 'ready')
        assert.deepEqual(f.nativeReads, []); assert.deepEqual(f.nativeReveals, [{ key: window.row.key, seq: window.target.seq }])
        assert.deepEqual(f.officialClicks, []); assert.deepEqual(f.loads, []); assert.deepEqual(f.writes, [])
    })

    test(`a cold native ${kind} reads around the original integer seq and reveals the same official node`, async t => {
        const window = nativeWindow(kind, false); t.after(() => window.close())
        const f = fixture({ nativeWindow: window, nativePage: async () => {} }); t.after(() => f.dispose()); await f.ready()
        f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'message', messageId: String(window.target.seq), origin: 'notification' } })
        await microtasks()
        assert.equal(f.root.dataset.hapiReading, 'ready')
        assert.deepEqual(f.nativeReads, [{ kind: 'around', target: { key: String(window.target.seq), seq: window.target.seq } }])
        assert.deepEqual(f.nativeReveals, [{ key: window.row.key, seq: window.target.seq }]); assert.deepEqual(f.officialClicks, [])
    })
}

for (const resident of [true, false]) test(`HHPI ${resident ? 'resident' : 'cold'} tool result resolves from its committed occurrence when the legacy event source is empty`, async t => {
    const window = nativeWindow('tool', false, true); t.after(() => window.close())
    const pending = Promise.withResolvers<void>()
    const f = fixture({ hhpi: true, remoteBinding: true, nativeWindow: window, nativeResident: resident, emptyEventSource: true,
        nativePage: () => pending.promise })
    t.after(() => f.dispose()); await f.ready()
    assert.notEqual(window.row.anchorSeq, window.target.seq, 'a result sequence names its call node rather than its sorting anchor')
    f.reading.set({ revision: 1, sessionId: 'hhpi:reading-machine:reading-source:codex:reading-thread',
        target: { kind: 'message', messageId: String(window.target.seq), origin: 'link' } })
    await microtasks()
    if (!resident) {
        assert.equal(f.root.dataset.hapiReading, 'waiting')
        assert.deepEqual(f.nativeReveals, [], 'the prepared window must not land before the official read commits')
        pending.resolve(); await microtasks()
    }
    assert.equal(f.root.dataset.hapiReading, 'ready')
    assert.deepEqual(f.nativeReads, resident ? [] : [{ kind: 'around', target: { key: String(window.target.seq), seq: window.target.seq } }])
    assert.deepEqual(f.nativeReveals, [{ key: window.row.key, seq: window.target.seq }])
    assert.deepEqual(f.loads, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.officialClicks, [])
})

test('source paging and item revision replacements do not turn ordinary reading into recovery navigation', async t => {
    const f = fixture({ sourceHistory: true }); t.after(() => f.dispose()); await f.ready()
    f.shift(120); f.replace(); await microtasks()
    f.sourceWindow.set({ ...f.sourceWindow.getSnapshot(), hasMoreAfter: true })
    f.replace(); await microtasks()
    assert.deepEqual(f.loads, [], 'same-history replacement must not load the retained bookmark again')
    assert.deepEqual(f.writes, [], 'ordinary commits cannot reposition the reader')
    assert.equal(f.root.dataset.hapiReading, undefined, 'a data update is not a navigation lifecycle')
})

for (const change of ['rewrite', 'host-restart'] as const) {
    test(`source ${change} still restores the reader after body publication`, async t => {
        const f = fixture({ sourceHistory: true }); t.after(() => f.dispose()); await f.ready()
        f.shift(120); f.replace(); await microtasks()
        assert.deepEqual(f.loads, [], 'a replace alone carries no source-reset meaning')
        f.sourceWindow.set({ ...f.sourceWindow.getSnapshot(),
            ...(change === 'rewrite' ? { historyVersion: 1 } : { historyId: 'host-b' }) })
        await microtasks()
        assert.deepEqual(f.loads, [50], 'the committed history identity/version owns recovery')
        await f.complete()
        assert.deepEqual(f.nativeReveals, [{ key: 'message-50', seq: 50 }]); assert.deepEqual(f.writes, [])
        f.replace(); f.sourceWindow.set({ ...f.sourceWindow.getSnapshot(), hasMoreAfter: true })
        await microtasks()
        assert.deepEqual(f.loads, [50], 'later same-version commits do not repeat the recovery')
    })
}

test('source replace waits through held touch and post-release inertia before recovering current reading', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] })
    f.replace(); await microtasks()
    assert.deepEqual(f.loads, [], 'replace must not start old-anchor navigation while the finger owns scrolling')
    f.scroll(350)
    f.gesture('touchend', { touches: [] })
    f.scroll(390); f.advance(500); await microtasks()
    assert.deepEqual(f.loads, [], 'touchend and a quiet timer are not the native scrollend')
    f.root.emit('scrollend', {})
    assert.deepEqual(f.loads, [], 'an inner scrollend cannot settle the outer conversation')
    f.end(); await microtasks()
    assert.deepEqual(f.loads, [50], 'deferred reconnect recovery still runs once scrolling settles')
    await f.complete()
    assert.deepEqual(f.writes, [], 'recovery uses the settled offset instead of the pre-gesture offset')
})

test('idle source replace preserves real reconnect restoration', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.shift(120); f.replace(); await microtasks()
    assert.deepEqual(f.loads, [50])
    await f.complete()
    assert.deepEqual(f.nativeReveals, [{ key: 'message-50', seq: 50 }], 'the official reader restores the retained source target')
    assert.deepEqual(f.writes, [], 'the plugin cannot place a reconnect viewport through DOM scroll writes')
})

test('a new gesture cancels an already running reconnect restore', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.shift(120); f.replace(); await microtasks()
    f.gesture('touchstart', { touches: [{}] }); f.scroll(380)
    await f.complete()
    assert.deepEqual(f.writes, [], 'late history completion cannot reclaim reader ownership')
})

test('touch release before the first compositor scroll does not prematurely resume recovery', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace()
    f.gesture('touchend', { touches: [] }); await microtasks()
    assert.deepEqual(f.loads, [], 'give the compositor a chance to deliver its first scroll after release')
    f.scroll(360); f.advance(500); await microtasks()
    assert.deepEqual(f.loads, [])
    f.end(); await microtasks(); await f.complete()
    assert.deepEqual(f.writes, [])
})

test('browsers without scrollend resume recovery after a quiet interval extended by each scroll', async t => {
    const f = fixture({ scrollend: false }); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace(); f.gesture('touchend', { touches: [] })
    f.advance(100); f.scroll(340); f.advance(100); await microtasks()
    assert.deepEqual(f.loads, [], 'fallback settling is extended by each native scroll')
    f.advance(200); await microtasks()
    assert.deepEqual(f.loads, [50])
    await f.complete(); assert.deepEqual(f.writes, [])
})

test('a tap without scrolling releases recovery even when native scrollend never fires', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace(); f.shift(120)
    f.gesture('touchend', { touches: [] }); f.advance(200); await microtasks()
    assert.deepEqual(f.loads, [50])
    await f.complete()
    assert.deepEqual(f.nativeReveals, [{ key: 'message-50', seq: 50 }], 'a tap without reader motion does not discard the source target')
    assert.deepEqual(f.writes, [])
})

test('pointercancel before native pan is not the end of touch ownership', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('pointerdown', { pointerType: 'touch' }); f.gesture('touchstart', { touches: [{}] })
    f.window.emit('pointercancel', f.row, { pointerType: 'touch' }); f.replace(); f.advance(500); await microtasks()
    assert.deepEqual(f.loads, [])
    f.scroll(350); f.gesture('touchend', { touches: [] }); f.scroll(380); await microtasks()
    assert.deepEqual(f.loads, [])
    f.end(); await microtasks(); await f.complete(); assert.deepEqual(f.writes, [])
})

test('deferred recovery retains its original bookmark if replacement removed the readable row', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace(); f.showRow(false)
    f.scroll(350); f.gesture('touchend', { touches: [] }); f.end(); await microtasks()
    assert.deepEqual(f.loads, [50], 'missing replacement DOM must not discard the reconnect bookmark')
    f.showRow(true); f.shift(120); await f.complete()
    assert.deepEqual(f.nativeReveals, [{ key: 'message-50', seq: 50 }]); assert.deepEqual(f.writes, [])
})

test('explicit latest navigation supersedes a deferred reconnect bookmark', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
    await microtasks(); f.flushFrames(); await microtasks()
    assert.deepEqual(f.loads, [])
    assert.deepEqual(f.officialClicks, [5000], 'a deliberate latest action reaches the existing official scroll owner')
    assert.deepEqual(f.writes, [4340], 'the original owner places the tail; the plugin does not write scrollTop')
    f.gesture('touchend', { touches: [] }); f.end(); f.advance(500); await microtasks()
    assert.deepEqual(f.loads, [], 'settling does not resurrect the replaced recovery request')
})

test('latest source commit precedes the official tail action on its replacement window', async t => {
    let commit!: (value: boolean) => void
    const committed = new Promise<boolean>(resolve => { commit = resolve })
    const f = fixture({ returnToLive: () => committed }); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
    await microtasks(); f.flushFrames()
    assert.deepEqual(f.officialClicks, [], 'the old history window must not jump to its obsolete bottom')
    f.port.scrollHeight = 9000; f.replace(); commit(true)
    await microtasks()
    assert.deepEqual(f.officialClicks, [], 'source completion must first reach the mounted Chat commit')
    f.flushFrames(); await microtasks()
    assert.deepEqual(f.loads, [], 'latest replacement must not revive the previous reading bookmark')
    assert.deepEqual(f.officialClicks, [9000])
    assert.deepEqual(f.writes, [8340])
})

for (const cancel of ['reader', 'hidden'] as const) {
    test(`a pending latest landing is cancelled by ${cancel} before its source finishes`, async t => {
        let commit!: (value: boolean) => void, signal: AbortSignal | undefined
        const committed = new Promise<boolean>(resolve => { commit = resolve })
        const f = fixture({ returnToLive: current => { signal = current; return committed } })
        t.after(() => f.dispose()); await f.ready()
        f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
        await microtasks()
        if (cancel === 'reader') f.gesture('wheel', { deltaY: -100 })
        else f.state.set({ visible: false, focused: false })
        assert.equal(signal?.aborted, true, 'the source operation must receive cancellation, not only its final scroll')
        commit(true); await microtasks(); f.flushFrames(); await microtasks()
        assert.deepEqual(f.officialClicks, [])
        assert.deepEqual(f.writes, [])
    })
}

test('failed latest source preparation retains the old window without an official tail action', async t => {
    const f = fixture({ returnToLive: () => Promise.resolve(false) }); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
    await microtasks(); f.flushFrames(); await microtasks()
    assert.deepEqual(f.officialClicks, [])
    assert.deepEqual(f.writes, [])
    assert.equal(f.root.dataset.hapiReading, 'error')
})

test('an existing official smooth tail owner needs no second scroll action', async t => {
    const f = fixture({ latestControl: 'following' }); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
    await microtasks(); f.flushFrames(); await microtasks()
    assert.deepEqual(f.officialClicks, [])
    assert.deepEqual(f.writes, [], 'only the original owner completes its ongoing motion')
    assert.equal(f.root.dataset.hapiReading, 'ready')
    f.replace(); await microtasks()
    assert.deepEqual(f.loads, [], 'a mid-follow position must not become a reconnect bookmark')
})

test('a fully opened ordinary blank admits its official hero editor without a nonexistent latest action', async t => {
    const f = fixture({ ordinaryHero: true, latestControl: 'missing', initialLatest: true })
    t.after(() => f.dispose()); await f.ready(); await microtasks(); f.flushFrames(); await microtasks()
    assert.equal(f.root.dataset.hapiReading, 'ready')
    assert.deepEqual(f.officialClicks, [])
    assert.deepEqual(f.writes, [], 'blank admission must not invent a Chat scroll owner')
    assert.deepEqual(f.loads, [])
})

test('a missing official latest action fails without a plugin scroll fallback', async t => {
    const f = fixture({ latestControl: 'missing' }); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
    await microtasks(); f.flushFrames(); await microtasks()
    assert.deepEqual(f.officialClicks, [])
    assert.deepEqual(f.writes, [])
    assert.equal(f.root.dataset.hapiReading, 'error')
})

test('reader input after latest commit cancels its queued official action', async t => {
    const f = fixture({ returnToLive: () => Promise.resolve(true) }); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
    await microtasks()
    f.gesture('wheel', { deltaY: -100 }); f.flushFrames(); await microtasks()
    assert.deepEqual(f.officialClicks, [])
    assert.deepEqual(f.writes, [])
})

test('a new pane destination cancels only that occurrence\'s pending official latest', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    const current = new AbortController(), sibling = new AbortController()
    const unregister = registerLatestCancellation(f.root as unknown as HTMLElement, () => current.abort())
    const other = registerLatestCancellation({} as HTMLElement, () => sibling.abort())
    t.after(unregister); t.after(other)
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
    assert.equal(current.signal.aborted, true, 'explicit destinations cancel before any source fetch')
    assert.equal(sibling.signal.aborted, false, 'another pane retains its own action')
    unregister()
    await microtasks(); f.flushFrames(); await microtasks()
})

for (const control of ['latest', 'turn'] as const) {
    test(`official ${control} navigation abandons the prior reconnect bookmark`, async t => {
        const f = fixture(); t.after(() => f.dispose()); await f.ready()
        const nav = { getAttribute: () => 'To bottom' }
        const button = { className: control === 'latest' ? 'official_toBottom' : 'official_mark',
            getAttribute: (name: string) => name === 'data-index' && control === 'turn' ? '20' : null,
            closest: (selector: string) => selector === 'button' ? button : selector === 'nav[aria-label]' && control === 'turn' ? nav : null }
        f.root.emit('click', button)
        f.shift(120); f.replace(); await microtasks()
        assert.deepEqual(f.loads, [], 'an intentional official navigation cannot restore the old source anchor')
        await f.complete()
        assert.deepEqual(f.writes, [], 'the official navigator alone places the new window')
    })
}

test('hiding a moving pane does not leave reconnect recovery permanently waiting for its old scrollend', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.scroll(340); f.replace(); f.shift(120)
    f.state.set({ visible: false, focused: false }); f.advance(500); await microtasks()
    assert.deepEqual(f.loads, [], 'hidden occurrences must not recover offscreen')
    f.state.set({ visible: true, focused: true }); await microtasks()
    assert.deepEqual(f.loads, [50], 'visible recovery must not depend on a scrollend from a hidden DOM')
    await f.complete()
    assert.deepEqual(f.nativeReveals, [{ key: 'message-50', seq: 50 }]); assert.deepEqual(f.writes, [])
})

test('recovery waits until after the official scrollend listeners and fresh motion cancels that frame', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace(); f.scroll(350)
    f.gesture('touchend', { touches: [] }); f.root.emit('scrollend', f.port)
    await microtasks()
    assert.deepEqual(f.loads, [], 'capture scrollend must not start recovery before the official listeners finish')
    f.scroll(390); await microtasks()
    assert.deepEqual(f.loads, [], 'a new compositor sample cancels the pending settlement frame')
    f.end(); await microtasks(); await f.complete()
    assert.deepEqual(f.loads, [50]); assert.deepEqual(f.writes, [])
})

test('a reader reaching the tail cancels deferred history recovery instead of being pulled back', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace()
    f.scroll(f.port.scrollHeight - f.port.clientHeight)
    f.gesture('touchend', { touches: [] }); f.end(); await microtasks()
    assert.deepEqual(f.loads, [], 'the reader deliberately reached the tail while the old row remained available')
    assert.deepEqual(f.writes, [])
    f.replace(); await microtasks()
    assert.deepEqual(f.loads, [], 'a later replace does not revive the history bookmark abandoned at the tail')
})

test('a replacement tail cannot masquerade as deliberate tail navigation after the bookmarked row disappeared', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace(); f.showRow(false)
    f.scroll(f.port.scrollHeight - f.port.clientHeight)
    f.gesture('touchend', { touches: [] }); f.end(); await microtasks()
    assert.deepEqual(f.loads, [50], 'the old history must still be recovered when replace removed it')
    f.showRow(true); await f.complete()
    assert.deepEqual(f.nativeReveals, [{ key: 'message-50', seq: 50 }]); assert.deepEqual(f.writes, [])
})

/** DOM-boundary fixture for the real binding: mutation delivery only reaches
 * explicitly observed seats, just as a footer mutation cannot reach a pane MO. */
function statusFixture() {
    const f = fixture()
    const css = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } })
    const observing = new Map<object, Map<object, MutationObserverInit>>()
    const callbacks = new Map<object, () => void>()
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class {
        constructor(callback: () => void) { callbacks.set(this, callback) }
        observe(target: object, options: MutationObserverInit) {
            if (!observing.has(this)) observing.set(this, new Map())
            observing.get(this)!.set(target, options)
        }
        disconnect() { observing.delete(this); callbacks.delete(this) }
    } })
    type TargetRow = { dataset: { hapiDeliveryId?: string; hapiRequestId?: string }; parentElement: object;
        tabIndex: number; scrollIntoView: () => void; focus: () => void }
    const select = (rows: TargetRow[], selector: string): TargetRow[] => rows.filter(row =>
        selector === '[data-hapi-delivery-id]' ? row.dataset.hapiDeliveryId !== undefined : row.dataset.hapiRequestId !== undefined)
    const rows: TargetRow[] = [], foreignRows: TargetRow[] = [], bodyRows: TargetRow[] = []
    const outerDetails = { tagName: 'DETAILS', parentElement: null, open: false }
    const menuContent = { tagName: 'DIV', parentElement: outerDetails }
    const footer = { tagName: 'DIV', parentElement: menuContent, querySelectorAll: (selector: string) => select(rows, selector),
        closest: (selector: string) => selector === '.hapi-pane-actions' ? outerDetails : null }
    const foreignFooter = { tagName: 'DIV', querySelectorAll: (selector: string) => select(foreignRows, selector) }
    const details = { tagName: 'DETAILS', parentElement: footer, open: false }
    const innerDetails = { tagName: 'DETAILS', parentElement: details, open: false }
    const queries: string[] = [], focused: TargetRow[] = [], scrolled: TargetRow[] = []
    const queryRows = f.root.querySelectorAll
    Object.assign(f.root, { querySelectorAll: (selector: string) => selector.includes('data-chat-anchor-key') ? queryRows(selector) : select(bodyRows, selector) })
    Object.assign(f.document, { querySelector: (selector: string) => {
        queries.push(selector)
        return selector === '.hapi-pane-status-slot[data-hapi-pane-mobile-status="pane"]' ? footer : foreignFooter
    } })
    const mutate = async (target: object): Promise<void> => {
        for (const [observer, targets] of observing) {
            if (targets.has(target)) queueMicrotask(callbacks.get(observer)!)
        }
        await microtasks()
    }
    const makeRow = (dataset: TargetRow['dataset'], parentElement: object): TargetRow => {
        const row = { dataset, parentElement, tabIndex: 0,
            scrollIntoView: () => { scrolled.push(row) }, focus: () => { focused.push(row) } }
        return row
    }
    return { ...f, footer, foreignFooter, outerDetails, details, innerDetails, queries, focused, scrolled,
        targets: () => [...observing.values()].flatMap(targets => [...targets.keys()]),
        makeRow,
        async insert(row: TargetRow, destination: 'footer' | 'foreign' | 'body' = 'footer') {
            ;(destination === 'footer' ? rows : destination === 'foreign' ? foreignRows : bodyRows).push(row)
            await mutate(destination === 'footer' ? footer : destination === 'foreign' ? foreignFooter : f.root)
        },
        dispose() {
            f.dispose()
            if (css) Object.defineProperty(globalThis, 'CSS', css)
            else Reflect.deleteProperty(globalThis, 'CSS')
        },
    }
}

test('delivery navigation observes its own footer and opens the outer pane menu and receipt details after asynchronous insertion', async t => {
    const f = statusFixture(); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'delivery', localId: 'receipt' } })
    await microtasks()
    assert.equal(f.root.dataset.hapiReading, 'loading')
    assert.deepEqual(f.targets(), [f.root, f.footer], 'only the originating pane and its exact footer seat are observed')
    assert.deepEqual(f.queries, ['.hapi-pane-status-slot[data-hapi-pane-mobile-status="pane"]'])
    const receipt = f.makeRow({ hapiDeliveryId: 'receipt' }, f.innerDetails)
    await f.insert(receipt)
    assert.equal(f.root.dataset.hapiReading, 'ready')
    assert.equal(f.outerDetails.open, true, 'the menu surrounding the footer seat must reveal the receipt')
    assert.equal(f.details.open, true); assert.equal(f.innerDetails.open, true)
    assert.deepEqual(f.focused, [receipt]); assert.deepEqual(f.scrolled, [receipt])
    assert.equal(receipt.tabIndex, -1)
    assert.deepEqual(f.targets(), [], 'resolved waits release both observers')
})

test('a sibling pane receipt with the same delivery ID cannot satisfy or wake this pane navigation', async t => {
    const f = statusFixture(); t.after(() => f.dispose()); await f.ready()
    const foreign = f.makeRow({ hapiDeliveryId: 'shared-id' }, f.foreignFooter)
    await f.insert(foreign, 'foreign')
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'delivery', localId: 'shared-id' } })
    await microtasks()
    assert.equal(f.root.dataset.hapiReading, 'loading')
    assert.deepEqual(f.focused, [])
    assert.ok(!f.targets().includes(f.foreignFooter))
    const own = f.makeRow({ hapiDeliveryId: 'shared-id' }, f.details)
    await f.insert(own)
    assert.deepEqual(f.focused, [own])
    assert.equal(f.root.dataset.hapiReading, 'ready')
})

test('approval navigation remains in the conversation body even when a footer has the same request ID', async t => {
    const f = statusFixture(); t.after(() => f.dispose()); await f.ready()
    await f.insert(f.makeRow({ hapiRequestId: 'approval' }, f.details))
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'approval', requestId: 'approval' } })
    await microtasks()
    assert.deepEqual(f.targets(), [f.root])
    assert.deepEqual(f.queries, [], 'approval lookup never queries a footer')
    assert.deepEqual(f.focused, [])
    const request = f.makeRow({ hapiRequestId: 'approval' }, f.root)
    await f.insert(request, 'body')
    assert.deepEqual(f.focused, [request])
    assert.equal(f.outerDetails.open, false)
    assert.equal(f.details.open, false)
})

test('hiding a pane cancels its footer wait and a late receipt cannot steal focus', async t => {
    const f = statusFixture(); t.after(() => f.dispose()); await f.ready()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'delivery', localId: 'receipt' } })
    await microtasks()
    f.state.set({ visible: false, focused: false }); await microtasks()
    assert.deepEqual(f.targets(), [])
    const receipt = f.makeRow({ hapiDeliveryId: 'receipt' }, f.details)
    await f.insert(receipt)
    assert.deepEqual(f.focused, [])
    f.state.set({ visible: true, focused: true }); await microtasks()
    assert.deepEqual(f.focused, [receipt], 'the retained explicit intent resumes when its own pane is visible again')
    assert.equal(f.root.dataset.hapiReading, 'ready')
})


test('an HHPI epoch replacement cannot restore an old raw sequence into the successor projection', async () => {
    const f = fixture({ sourceHistory: true, hhpi: true })
    try {
        await f.ready()
        f.replaceSourceEpoch('reading-epoch-2')
        await microtasks()
        assert.equal(f.root.dataset.hapiReading, 'error')
        assert.deepEqual(f.loads, [], 'no old raw seq is submitted to the replacement source epoch')
        assert.deepEqual(f.nativeReveals, [])
    } finally { f.dispose() }
})


test('an empty source latest destination waits for the official window without requiring a mounted Chat', async () => {
    const source = Promise.withResolvers<void>()
    const f = fixture({ hhpi: true, remoteBinding: true, emptyNative: true, nativePage: () => source.promise })
    try {
        f.reading.set({ revision: 1, sessionId: 'hhpi:reading-machine:reading-source:codex:reading-thread', target: { kind: 'latest' } })
        await f.ready()
        assert.equal(f.root.dataset.hapiReading, 'waiting')
        assert.deepEqual(f.nativeReads, [{ kind: 'latest' }])
        source.resolve(); await f.ready()
        assert.equal(f.root.dataset.hapiReading, 'ready')
        assert.deepEqual(f.nativeReveals, [])
        assert.equal(f.nativeReads.length, 1)
    } finally { f.dispose() }
})
