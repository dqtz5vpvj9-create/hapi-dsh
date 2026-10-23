/** Actual reading binding with DOM/Session boundary doubles; no browser claim. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import type { PaneReadingIntent } from '../src/client/reading-intent.ts'
import { bindPaneReading } from '../src/client/reading-view.ts'

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

function fixture(options: { scrollend?: boolean } = {}) {
    const observer = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
    let now = 0, id = 0, top = 300, rowTop = 500, rowPresent = true
    const timers = new Map<number, { at: number; run: () => void }>(), frames = new Map<number, FrameRequestCallback>()
    const storage = new Map<string, string>(), writes: number[] = [], loads: number[] = []
    const window = Object.assign(new Events(), {
        innerWidth: 390, innerHeight: 844,
        performance: { getEntriesByType: () => [] },
        sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
        setTimeout(run: () => void, delay: number) { const handle = ++id; timers.set(handle, { at: now + delay, run }); return handle },
        clearTimeout(handle: number) { timers.delete(handle) },
        requestAnimationFrame(run: FrameRequestCallback) { const handle = ++id; frames.set(handle, run); return handle },
        cancelAnimationFrame(handle: number) { frames.delete(handle) },
    })
    const root = Object.assign(new Events(), {
        dataset: {} as Record<string, string>, isConnected: true, hidden: false,
        closest: () => root,
        querySelector: (selector: string) => selector === '[data-conversation-scroll]' ? port : null,
        querySelectorAll: (selector: string) => selector.includes('data-chat-anchor-key') && rowPresent ? [row] : [],
    })
    const document = { defaultView: window, elementFromPoint: () => rowPresent ? row : null }
    const port = {
        ...(options.scrollend === false ? {} : { onscrollend: null }), ownerDocument: document,
        scrollHeight: 5000, clientHeight: 660,
        get scrollTop() { return top }, set scrollTop(value: number) { writes.push(value); top = value },
        getBoundingClientRect: () => ({ top: 40, bottom: 700, left: 0, right: 390, height: 660 }),
        contains: (element: unknown) => element === row,
        closest: (selector: string) => selector === '[data-conversation-scroll]' ? port : null,
        querySelectorAll: () => rowPresent ? [row] : [],
    }
    const row = {
        parentElement: root, dataset: { chatNodeKey: 'message-50', chatAnchorKey: 'message-50' }, tagName: 'DIV',
        getBoundingClientRect: () => ({ top: 40 + rowTop - top, bottom: 140 + rowTop - top, height: 100 }),
        getClientRects: () => rowPresent ? [row.getBoundingClientRect()] : [],
        closest: (selector: string) => selector === '[data-chat-node-key]' ? row : selector === '[data-conversation-scroll]' ? port : null,
        getAttribute: () => null, hasAttribute: () => false,
    }
    Object.assign(root, { ownerDocument: document })
    const state = store({ visible: true, focused: true }), reading = store<PaneReadingIntent | undefined>(undefined)
    const events = store({ revision: 0, change: { kind: 'append' } })
    const history = store({ openState: 'open', loadingOlder: false, removed: false })
    let completeLoad: (() => void) | undefined
    const reference = { sessionId: 'session', ready: Promise.resolve(), binding: { eventSource: events,
        session: { ...history, loadThrough(seq: number) { loads.push(seq); return new Promise<void>(resolve => { completeLoad = resolve }) } } } } as unknown as SessionReference
    const ctx = { sessions: { list: { getSnapshot: () => ({ byId: { session: {} } }) } },
        locale: { bind: () => () => 'To bottom' },
        uiConversation: { binding: () => ({ target: () => ({ getSnapshot: () => ({ nodes: new Map([['message-50', { anchorSeq: 50 }]]) }) }) }) } } as unknown as Context
    const navigation = { hostId: 'host', paneId: 'pane', state, reading } as unknown as WorkspacePaneNavigation
    const dispose = bindPaneReading(ctx, root as unknown as HTMLElement, reference, navigation)
    const framesNow = () => { const current = [...frames.values()]; frames.clear(); for (const run of current) run(now) }
    return {
        root, window, port, row, writes, loads, state, reading,
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
            if (observer) Object.defineProperty(globalThis, 'MutationObserver', observer)
            else Reflect.deleteProperty(globalThis, 'MutationObserver')
        },
    }
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
    assert.deepEqual(f.writes, [420], 'replacement geometry is corrected to the retained reading position')
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
    assert.deepEqual(f.writes, [420], 'a tap without reader motion does not discard the pre-replacement bookmark')
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
    assert.deepEqual(f.writes, [420])
})

test('explicit latest navigation supersedes a deferred reconnect bookmark', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.replace()
    f.reading.set({ revision: 1, sessionId: 'session', target: { kind: 'latest' } })
    await microtasks()
    assert.deepEqual(f.loads, [])
    assert.deepEqual(f.writes, [5000], 'a deliberate latest action is not held behind implicit recovery')
    f.gesture('touchend', { touches: [] }); f.end(); f.advance(500); await microtasks()
    assert.deepEqual(f.loads, [], 'settling does not resurrect the replaced recovery request')
})

test('hiding a moving pane does not leave reconnect recovery permanently waiting for its old scrollend', async t => {
    const f = fixture(); t.after(() => f.dispose()); await f.ready()
    f.gesture('touchstart', { touches: [{}] }); f.scroll(340); f.replace(); f.shift(120)
    f.state.set({ visible: false, focused: false }); f.advance(500); await microtasks()
    assert.deepEqual(f.loads, [], 'hidden occurrences must not recover offscreen')
    f.state.set({ visible: true, focused: true }); await microtasks()
    assert.deepEqual(f.loads, [50], 'visible recovery must not depend on a scrollend from a hidden DOM')
    await f.complete()
    assert.deepEqual(f.writes, [460])
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
    assert.deepEqual(f.writes, [300])
})
