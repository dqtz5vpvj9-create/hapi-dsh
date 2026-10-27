/** Actual reading binding with DOM/Session boundary doubles; no browser claim. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import type { PaneReadingIntent } from '../src/client/reading-intent.ts'
import { bindPaneReading, registerLatestCancellation } from '../src/client/reading-view.ts'

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

function fixture(options: { scrollend?: boolean; returnToLive?: (signal?: AbortSignal) => boolean | Promise<boolean>;
    latestControl?: 'button' | 'following' | 'missing' } = {}) {
    const observer = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
    let now = 0, id = 0, top = 300, rowTop = 500, rowPresent = true
    const timers = new Map<number, { at: number; run: () => void }>(), frames = new Map<number, FrameRequestCallback>()
    const storage = new Map<string, string>(), writes: number[] = [], loads: number[] = [], officialClicks: number[] = []
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
        closest: (selector: string) => selector.includes('aria-hidden') ? null : root,
        querySelector: (selector: string) => selector === '[data-conversation-scroll]' ? port : null,
        querySelectorAll: (selector: string) => selector === 'button[aria-label]' ? (!options.latestControl || options.latestControl === 'button' ? [latestButton] : [])
            : selector.includes('data-chat-anchor-key') && rowPresent ? [row] : [],
        prepend: () => {},
    })
    const document = { defaultView: window, elementFromPoint: () => rowPresent ? row : null,
        createElement: () => ({ className: '', textContent: '', type: '', onclick: undefined, setAttribute() {}, append() {}, remove() {} }) }
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
    const state = store({ visible: true, focused: true }), reading = store<PaneReadingIntent | undefined>(undefined)
    const events = store({ revision: 0, change: { kind: 'append' } })
    const history = store({ openState: 'open', loadingOlder: false, removed: false })
    let completeLoad: (() => void) | undefined
    const reference = { sessionId: 'session', ready: Promise.resolve(), binding: { eventSource: events,
        session: { ...history, returnToLive: options.returnToLive,
            loadThrough(seq: number) { loads.push(seq); return new Promise<void>(resolve => { completeLoad = resolve }) } } } } as unknown as SessionReference
    const ctx = { sessions: { list: { getSnapshot: () => ({ byId: { session: {} } }) } },
        locale: { bind: () => () => 'To bottom', getSnapshot: () => ({ active: 'en' }) },
        uiConversation: { binding: () => ({ target: () => ({ getSnapshot: () => ({ nodes: new Map([['message-50', { anchorSeq: 50 }]]) }) }) }) } } as unknown as Context
    const navigation = { hostId: 'host', paneId: 'pane', state, reading } as unknown as WorkspacePaneNavigation
    const dispose = bindPaneReading(ctx, root as unknown as HTMLElement, reference, navigation)
    const framesNow = () => { const current = [...frames.values()]; frames.clear(); for (const run of current) run(now) }
    return {
        root, document, window, port, row, writes, loads, officialClicks, state, reading,
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
