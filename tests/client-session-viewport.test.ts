/** Public Session faces and explicit frame/layout measurements are fixtures.
 * These test the admission policy, not official rendering or browser layout. */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SourceWindowPreparer, SourceWindowReader } from '../src/client/source-sessions.ts'
import { pinSourceViewport, sourceRetentionPlan } from '../src/client/source-window-retention.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { officialChat } from './official-conversation-fixture.ts'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import type { PaneReadingIntent } from '../src/client/reading-intent.ts'
import { installSessionViewHost, prepareCandidateViewport, prepareInitialViewport, readSourceWindowViewport, registerVisibleWindowReader, WindowPreparationCoordinator } from '../src/client/surface/session-view.tsx'

function fixture() {
    const spacer = { offsetHeight: 0 }
    const composer = { offsetHeight: 0 }
    const port = { clientHeight: 600, clientWidth: 800, scrollHeight: 600, scrollTop: 0, closest: () => null,
        querySelector(selector: string): { offsetHeight: number } | { getBoundingClientRect(): { height: number } } | null {
        if (selector === '[data-chat-turn-spacer]') return spacer
        if (selector === '[data-composer-seat]') return composer
        if (selector === '[data-chat-flow]:not([data-step-process-content])') return {
            getBoundingClientRect: () => ({ height: port.scrollHeight - spacer.offsetHeight - composer.offsetHeight }),
        }
        return null
    } }
    const editor = { present: true, copies: 1, editable: true, disabled: false, inert: false, hidden: false, width: 500, height: 36,
        getAttribute(name: string) { return name === 'contenteditable' ? String(this.editable)
            : name === 'aria-disabled' && this.disabled ? 'true' : null },
        hasAttribute: () => false,
        closest() { return this.inert || this.hidden ? {} : null },
        getClientRects() { return this.present ? [this.getBoundingClientRect()] : [] },
        getBoundingClientRect() { return { width: this.width, height: this.height } },
    }
    const state = { hasMore: true, loadingOlder: false, removed: false, subagent: null as SessionSnapshot['subagent'] }
    let block: ComposerBlock | undefined
    let first = 1_000, revision = 0, pages = 0, frames = 0, live = true, visible = true, time = 0
    let frameId = 0, suspended = false
    const pendingFrames = new Map<number, FrameRequestCallback>()
    const paneListeners = new Set<() => void>(), visibilityListeners = new Set<() => void>()
    let reading: PaneReadingIntent | undefined, readingState: string | null = null
    let frame: (() => void) | undefined, load: ((limit: number) => void | Promise<void>) | undefined
    const limits: number[] = []
    const renderFrame = (id: number): void => {
        if (suspended) return
        const callback = pendingFrames.get(id)
        if (!callback) return
        pendingFrames.delete(id)
        time += 16; frames++; frame?.(); callback(time)
    }
    const windowEvents = new EventTarget()
    const document = { visibilityState: 'visible' as DocumentVisibilityState,
        addEventListener(_type: string, listener: () => void) { visibilityListeners.add(listener) },
        removeEventListener(_type: string, listener: () => void) { visibilityListeners.delete(listener) },
        defaultView: { performance: { now: () => time, getEntriesByType: () => [] },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        addEventListener: windowEvents.addEventListener.bind(windowEvents),
        removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
        setTimeout, clearTimeout,
        requestAnimationFrame(callback: FrameRequestCallback) {
            const id = ++frameId
            pendingFrames.set(id, callback)
            queueMicrotask(() => renderFrame(id))
            return id
        }, cancelAnimationFrame(id: number) { pendingFrames.delete(id) },
        getComputedStyle: () => ({ visibility: 'hidden', pointerEvents: 'none' }) },
    }
    const target = {
        ownerDocument: document,
        querySelector: () => port,
        querySelectorAll: () => editor.present ? Array.from({ length: editor.copies }, () => editor) : [],
        getAttribute: () => readingState,
    } as unknown as HTMLElement
    const reference = { binding: {
        session: { getSnapshot: () => state, async loadOlder() { pages++; await load?.(20) },
            async loadViewportPage(limit = 20) { pages++; limits.push(limit); await load?.(limit) } },
        eventSource: { getSnapshot: () => ({ revision, entries: [{ event: { seq: first } }], change: { kind: 'replace' } }),
            subscribe: () => () => {} },
    } } as unknown as SessionReference
    const navigation = { state: { getSnapshot: () => ({ visible }), subscribe(listener: () => void) {
        paneListeners.add(listener); return () => { paneListeners.delete(listener) }
    } }, reading: { getSnapshot: () => reading } } as unknown as WorkspacePaneNavigation
    return {
        port, state, spacer, composer, editor, target, reference,
        run: (signal?: AbortSignal) => prepareInitialViewport(target, reference, navigation, () => live, () => block, signal),
        candidate: (signal = new AbortController().signal) => prepareCandidateViewport(target, reference, signal, navigation.state),
        pages: () => pages, limits,
        frames: () => frames,
        older: () => { first--; revision++ },
        append: () => { revision++ },
        onLoad: (next: (limit: number) => void | Promise<void>) => { load = next },
        onFrame: (next: () => void) => { frame = next },
        intent: (target: PaneReadingIntent['target']) => { reading = { revision: 1, sessionId: 'fixture', target } },
        readingState: (value: string | null) => { readingState = value },
        block: (value: ComposerBlock | undefined) => { block = value },
        visible(value: boolean) { visible = value; for (const listener of paneListeners) listener() },
        documentVisible(value: boolean) {
            document.visibilityState = value ? 'visible' : 'hidden'
            for (const listener of visibilityListeners) listener()
        },
        advance: (elapsed: number) => { time += elapsed },
        suspendFrames: () => { suspended = true },
        resumeFrames() { suspended = false; for (const id of pendingFrames.keys()) queueMicrotask(() => renderFrame(id)) },
        listeners: () => paneListeners.size + visibilityListeners.size,
        pendingFrames: () => pendingFrames.size,
        close: () => { live = false },
    }
}

test('a usable initial viewport needs no speculative older pages', async () => {
    const f = fixture()
    f.port.scrollHeight = 900
    assert.equal(await f.run(), true)
    assert.equal(f.pages(), 0)
})

for (const unavailable of ['missing', 'duplicate', 'disabled', 'inert', 'hidden', 'empty-layout'] as const) {
    test(`initial admission waits for the official composer to leave ${unavailable}`, async () => {
        const f = fixture()
        f.port.scrollHeight = 900
        if (unavailable === 'missing') f.editor.present = false
        if (unavailable === 'duplicate') f.editor.copies = 2
        if (unavailable === 'disabled') { f.editor.editable = false; f.editor.disabled = true }
        if (unavailable === 'inert') f.editor.inert = true
        if (unavailable === 'hidden') f.editor.hidden = true
        if (unavailable === 'empty-layout') f.editor.height = 0
        f.onFrame(() => {
            if (f.frames() !== 3) return
            Object.assign(f.editor, { present: true, copies: 1, editable: true, disabled: false, inert: false, hidden: false, height: 36 })
        })
        assert.equal(await f.run(), true)
        assert.equal(f.frames(), 3)
        assert.equal(f.pages(), 0, 'editor assembly must not manufacture history requests')
    })
}

test('measuring CSS keeps a real enabled composer eligible without enabling any DOM control', async () => {
    const f = fixture(); f.port.scrollHeight = 900
    assert.equal(await f.run(), true)
    assert.equal(f.frames(), 1)
    assert.equal(f.editor.editable, true)
})

test('a removed session never qualifies even with stale enabled editor DOM', async () => {
    const f = fixture(); f.port.scrollHeight = 900; f.state.removed = true
    await assert.rejects(f.run(), { message: 'The conversation was removed.' })
    assert.equal(f.pages(), 0)
})

test('an explicit official composer block preserves its exact reason without forcing editability', async () => {
    const f = fixture(); f.port.scrollHeight = 900
    f.editor.editable = false; f.editor.disabled = true
    f.block({ reason: 'The source engine currently owns input.' })
    await assert.rejects(f.run(), { message: 'The source engine currently owns input.' })
    assert.equal(f.editor.editable, false)
    assert.equal(f.editor.disabled, true)
    assert.equal(f.pages(), 0)
})

test('unresolved parent availability is pending, while an explicit offline parent keeps its reason', async () => {
    const f = fixture(); f.port.scrollHeight = 900
    f.state.subagent = { address: { mode: 'continuable' } } as unknown as SessionSnapshot['subagent']
    f.editor.editable = false; f.editor.disabled = true
    f.onFrame(() => {
        if (f.frames() !== 3) return
        f.state.subagent = { ...f.state.subagent!, parentAvailable: true }
        f.editor.editable = true; f.editor.disabled = false
    })
    assert.equal(await f.run(), true)
    assert.equal(f.frames(), 3)
    f.state.subagent = { ...f.state.subagent!, parentAvailable: false }
    await assert.rejects(f.run(), { message: 'The parent session is offline.' })
})

test('an editor that never becomes editable cannot qualify on a filled history viewport', async () => {
    const f = fixture(); f.port.scrollHeight = 900; f.editor.editable = false
    f.onFrame(() => { if (f.frames() === 4) f.close() })
    assert.equal(await f.run(), false)
    assert.equal(f.pages(), 0)
})

test('a measuring pane resumes the same admission after being parked beyond the visible budget', async () => {
    const f = fixture(); f.port.scrollHeight = 900; f.editor.editable = false
    f.onFrame(() => {
        if (f.frames() !== 1) return
        f.advance(4_000)
        f.visible(false); f.port.clientHeight = 0; f.suspendFrames()
    })
    const ready = f.run()
    await tick()
    f.advance(60_000)
    f.visible(true); f.port.clientHeight = 600; f.editor.editable = true; f.resumeFrames()
    assert.equal(await ready, true)
    assert.equal(f.pages(), 0)
    assert.equal(f.listeners(), 0)
})

test('parking pauses the budget instead of granting another five seconds when a pane returns', async () => {
    const f = fixture(); f.port.scrollHeight = 900; f.editor.editable = false
    f.onFrame(() => {
        if (f.frames() !== 1) return
        f.advance(4_000); f.visible(false); f.suspendFrames()
    })
    const ready = f.run()
    await tick()
    f.advance(60_000); f.visible(true)
    f.advance(1_000); f.editor.editable = true; f.resumeFrames()
    assert.equal(await ready, false, 'elapsed foreground time remains cumulative across the pause')
    assert.equal(f.listeners(), 0)
})

test('a latest candidate parked with its owning pane keeps the same remaining foreground budget', async () => {
    const f = fixture(); f.port.scrollHeight = 900
    f.visible(false); f.suspendFrames()
    const ready = f.candidate()
    await tick()
    f.advance(60_000)
    f.visible(true); f.resumeFrames()
    assert.equal(await ready, true, 'another visible pane must not spend this candidate\'s foreground budget')
    assert.equal(f.listeners(), 0)
})

for (const preparation of ['initial', 'candidate'] as const) {
    test(`${preparation} preparation excludes background suspension and releases its visibility listener`, async () => {
        const f = fixture(); f.port.scrollHeight = 900
        f.documentVisible(false); f.suspendFrames()
        const ready = preparation === 'initial' ? f.run() : f.candidate()
        await tick()
        assert.equal(f.pendingFrames(), 1)
        f.advance(60_000)
        f.documentVisible(true); f.resumeFrames()
        assert.equal(await ready, true)
        assert.equal(f.listeners(), 0)
    })

    test(`${preparation} preparation still rejects five seconds of real foreground work`, async () => {
        const f = fixture(); f.port.scrollHeight = 900
        f.onFrame(() => f.advance(5_000))
        assert.equal(await (preparation === 'initial' ? f.run() : f.candidate()), false)
        assert.equal(f.listeners(), 0)
    })

    test(`${preparation} disposal ends a suspended frame without waiting for foreground`, async () => {
        const f = fixture(), abort = new AbortController()
        f.documentVisible(false); f.suspendFrames()
        const ready = preparation === 'initial' ? f.run(abort.signal) : f.candidate(abort.signal)
        await tick()
        abort.abort()
        assert.equal(await ready, false)
        assert.equal(f.pendingFrames(), 0)
        assert.equal(f.listeners(), 0)
    })
}

test('a page completing while its initial pane is hidden cannot fail on the parked zero-size viewport', async () => {
    const f = fixture(), read = deferred(), started = deferred()
    f.onLoad(() => {
        f.visible(false); f.port.clientHeight = 0; f.suspendFrames()
        started.resolve()
        return read.promise
    })
    const ready = f.run()
    await started.promise
    f.advance(60_000); read.resolve(); await tick()
    assert.equal(f.pages(), 1)
    f.port.clientHeight = 600; f.port.scrollHeight = 900
    f.visible(true); f.resumeFrames()
    assert.equal(await ready, true, 'the real post-page content qualifies only after visible layout returns')
    assert.equal(f.listeners(), 0)
})

test('folded pages may advance history without height growth until the viewport fills', async () => {
    const f = fixture()
    f.onLoad(() => {
        f.older()
        if (f.pages() === 4) f.port.scrollHeight = 900
    })
    assert.equal(await f.run(), true)
    assert.equal(f.pages(), 4)
    assert.equal(f.state.hasMore, true, 'filling the viewport must not drain the remaining archive')
})

test('the first visible window cannot qualify on synthetic tail spacer and composer height', async () => {
    const f = fixture()
    f.port.scrollHeight = 1_000
    f.spacer.offsetHeight = 700
    f.composer.offsetHeight = 150
    f.onLoad(() => {
        f.older()
        if (f.pages() === 2) f.port.scrollHeight = 1_400
    })
    assert.equal(await f.run(), true)
    assert.equal(f.pages(), 2, 'the initial reveal must use the same real-content requirement as atomic latest')
    assert.equal(f.state.hasMore, true)
})

test('a genuinely short conversation is ready only once older history is exhausted', async () => {
    const f = fixture()
    f.onLoad(() => {
        f.older()
        if (f.pages() === 3) f.state.hasMore = false
    })
    assert.equal(await f.run(), true)
    assert.equal(f.pages(), 3)
})

test('live revisions cannot disguise an older page that made no cursor progress', async () => {
    const f = fixture()
    f.onLoad(() => f.append())
    assert.equal(await f.run(), false)
    assert.equal(f.pages(), 1)
})

test('folded history is bounded and is never exposed as usable merely for exhausting the page budget', async () => {
    const f = fixture()
    f.onLoad(() => f.older())
    assert.equal(await f.run(), false)
    assert.equal(f.pages(), 12)
})

for (const preparation of ['initial', 'candidate'] as const) {
    test(`${preparation} batches folded source items without repeating small-page layout cycles`, async () => {
        const f = fixture()
        f.port.scrollHeight = 200
        let read = 0
        f.onLoad(limit => {
            read += limit; f.older()
            // The previous readable answer lies behind 120 folded source items.
            if (read >= 120) f.port.scrollHeight = 900
        })
        assert.equal(await (preparation === 'initial' ? f.run() : f.candidate()), true)
        assert.deepEqual(f.limits, [20, 50, 50])
        assert.equal(f.frames(), 7, 'two commit frames per page, without a third redundant frame')
    })

    test(`${preparation} uses measured content gain to request only the remaining viewport`, async () => {
        const f = fixture()
        f.port.scrollHeight = 100
        f.onLoad(limit => { f.older(); f.port.scrollHeight += limit * 10 })
        assert.equal(await (preparation === 'initial' ? f.run() : f.candidate()), true)
        assert.deepEqual(f.limits, [20, 31])
        assert.equal(f.port.scrollHeight, 610)
    })
}

for (const mode of ['latest', 'restoration'] as const) {
    test(`initial ${mode} must finish before exposing an otherwise scrollable viewport`, async () => {
        const f = fixture()
        f.port.scrollHeight = 900
        if (mode === 'latest') f.intent({ kind: 'latest' })
        f.readingState('loading')
        f.onFrame(() => { if (f.frames() === 4) f.readingState('ready') })
        assert.equal(await f.run(), true)
        assert.equal(f.frames(), 4)
        assert.equal(f.pages(), 0)
    })
}

test('failed reading placement cannot expose another position just because it has content', async () => {
    const f = fixture()
    f.port.scrollHeight = 900
    f.readingState('error')
    assert.equal(await f.run(), false)
    assert.equal(f.pages(), 0)
})

test('closing a pane during its next frame prevents an older-history request', async () => {
    const f = fixture()
    f.onFrame(() => f.close())
    assert.equal(await f.run(), false)
    assert.equal(f.pages(), 0)
})

test('an in-flight history load must finish before a scrollable viewport is ready', async () => {
    const f = fixture()
    f.port.scrollHeight = 900
    f.state.loadingOlder = true
    f.onFrame(() => { if (f.frames() === 3) f.state.loadingOlder = false })
    assert.equal(await f.run(), true)
    assert.equal(f.frames(), 3)
    assert.equal(f.pages(), 0)
})

test('latest preparation reads only viewport pages until real chat content fills its geometry', async () => {
    const f = fixture()
    f.spacer.offsetHeight = 500
    f.port.scrollHeight = 1_000
    f.onLoad(() => {
        f.older()
        if (f.pages() === 3) f.port.scrollHeight = 1_300
    })
    assert.equal(await f.candidate(), true)
    assert.equal(f.pages(), 3, 'the official tail spacer alone must not admit a short window')
    assert.equal(f.state.hasMore, true)
})

test('latest preparation accepts genuinely exhausted short history without inventing another read', async () => {
    const f = fixture()
    f.state.hasMore = false
    assert.equal(await f.candidate(), true)
    assert.equal(f.pages(), 0)
})

test('latest preparation caps folded pages and rejects source reads without older progress', async () => {
    const folded = fixture()
    folded.onLoad(() => folded.older())
    assert.equal(await folded.candidate(), false)
    assert.equal(folded.pages(), 12)
    const unchanged = fixture()
    unchanged.onLoad(() => unchanged.append())
    assert.equal(await unchanged.candidate(), false)
    assert.equal(unchanged.pages(), 1)
})

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>(yes => { resolve = yes })
    return { promise, resolve }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('aborting an unresolved candidate page unmounts it without waiting for the network', async () => {
    const f = fixture(), read = deferred(), started = deferred(), abort = new AbortController()
    const coordinator = new WindowPreparationCoordinator()
    let mounted = 0, removed = 0
    f.onLoad(() => { started.resolve(); return read.promise })
    const ready = coordinator.prepare(f.reference, abort.signal, () => {
        mounted++
        return { target: f.target, async dispose() { removed++ } }
    })
    await started.promise
    abort.abort()
    assert.equal(await ready, false)
    assert.equal(mounted, 1)
    assert.equal(removed, 1)
    read.resolve(); await tick()
    assert.equal(removed, 1, 'a late page completion cannot remount or publish its discarded occurrence')
    await coordinator.dispose()
})

test('supersession waits for official unmount and never holds two candidate chat occurrences', async () => {
    const first = fixture(), last = fixture(), started = deferred(), unmount = deferred()
    const coordinator = new WindowPreparationCoordinator()
    first.onLoad(() => { started.resolve(); return new Promise<void>(() => {}) })
    last.port.scrollHeight = 900
    let resident = 0, peak = 0, mounts = 0
    const one = coordinator.prepare(first.reference, new AbortController().signal, () => {
        resident++; peak = Math.max(peak, resident); mounts++
        return { target: first.target, async dispose() { await unmount.promise; resident-- } }
    })
    await started.promise
    const skipped = coordinator.prepare(last.reference, new AbortController().signal, () => {
        throw new Error('A superseded queued preparation must never mount')
    })
    const latest = coordinator.prepare(last.reference, new AbortController().signal, () => {
        resident++; peak = Math.max(peak, resident); mounts++
        return { target: last.target, async dispose() { resident-- } }
    })
    await tick()
    assert.equal(resident, 1)
    assert.equal(mounts, 1)
    unmount.resolve()
    assert.deepEqual(await Promise.all([one, skipped, latest]), [false, false, true])
    assert.equal(peak, 1)
    assert.equal(mounts, 2)
    assert.equal(resident, 0)
    await coordinator.dispose()
})

test('readiness waits for unmount and cancellation during cleanup prevents publication', async () => {
    const f = fixture(), removing = deferred(), unmount = deferred(), abort = new AbortController()
    f.port.scrollHeight = 900
    const coordinator = new WindowPreparationCoordinator()
    let settled = false
    const ready = coordinator.prepare(f.reference, abort.signal, () => ({ target: f.target, async dispose() {
        removing.resolve(); await unmount.promise
    } })).then(value => { settled = true; return value })
    await removing.promise
    assert.equal(settled, false, 'the source owner must not dispose the alias while official chat is mounted')
    abort.abort(); unmount.resolve()
    assert.equal(await ready, false)
    await coordinator.dispose()
})

test('Host disposal cancels preparation and refuses future temporary occurrences', async () => {
    const f = fixture(), started = deferred()
    f.onLoad(() => { started.resolve(); return new Promise<void>(() => {}) })
    const coordinator = new WindowPreparationCoordinator()
    let removed = 0
    const ready = coordinator.prepare(f.reference, new AbortController().signal, () => ({
        target: f.target, async dispose() { removed++ },
    }))
    await started.promise
    await coordinator.dispose()
    assert.equal(await ready, false)
    assert.equal(removed, 1)
    assert.equal(await coordinator.prepare(f.reference, new AbortController().signal, () => {
        throw new Error('Disposed Host cannot mount')
    }), false)
})

test('renderer failure discards its candidate before any additional source request', async () => {
    const f = fixture(), coordinator = new WindowPreparationCoordinator()
    let removed = 0
    assert.equal(await coordinator.prepare(f.reference, new AbortController().signal, fail => {
        fail()
        return { target: f.target, async dispose() { removed++ } }
    }), false)
    assert.equal(f.pages(), 0)
    assert.equal(removed, 1)
    await coordinator.dispose()
})

test('the pinned public composition delegates chat through the existing factory child authorization', async () => {
    const require = createRequire(import.meta.url)
    let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-client-ui-renderer/client') } | undefined
    new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({
        __ModuleLoader__: { load(value: typeof published) { published = value } },
    })
    const { SlotRegistry } = published!.factory(require)
    const root = new Context()
    new SlotRegistry(root)
    const official = () => null
    await root.plugin({ name: 'candidate-public-shell', apply(ctx: Context) {
        ctx.slots.register({ name: 'root', children: {
            'shell.overlay': { kind: 'list', scope: 'root' }, 'conversation.session': { kind: 'single', scope: 'session' },
        } }, ({ renderSlot }: PropsRenderSlots<'shell.overlay' | 'conversation.session'>) => renderSlot('shell.overlay', {}))
        ctx.slots.register({ name: 'conversation.session', children: { 'conversation.view': { kind: 'list', scope: 'session' } } },
            ({ renderSlot }: PropsRenderSlots<'conversation.view'>) => { void renderSlot; return null })
        ctx.slots.register({ name: 'conversation.view', id: 'chat' }, official)
    } })
    let host!: ReturnType<typeof installSessionViewHost>
    const plugin = root.plugin({ name: 'candidate-public-chat', apply(ctx: Context) {
        host = installSessionViewHost(ctx)
        return () => host.dispose()
    } })
    await plugin
    try {
        const entries = root.slots.entries('hapi.workspace.session-view')
        assert.equal(entries.length, 1)
        assert.equal(root.slots.entries('conversation.view')[0]!.component, official)
        assert.equal(root.slots.entries('conversation.view').length, 1, 'the official chat slot must not be redeclared or replaced')
        let localViews: ComponentType<{ renderSlot: (...args: unknown[]) => unknown }> | undefined
        const render = entries[0]!.component as (props: object) => unknown
        render({
            sessionId: 'visible', useConversation: () => false, useSessions: () => false, useSession: () => 'active',
            renderFactorySlot(name: string, _props: unknown, options: { slots: { views: typeof localViews } }) {
                assert.equal(name, 'conversation.content')
                localViews = options.slots.views
                return null
            },
        })
        assert.ok(localViews)
        const calls: unknown[][] = []
        const result = renderToStaticMarkup(createElement(localViews, {
            renderSlot(...args: unknown[]) { calls.push(args); return createElement('div', null, 'official chat seat') },
        }))
        assert.equal(result, '<div>official chat seat</div>')
        assert.deepEqual(calls, [['conversation.session', { view: 'chat' }]], 'the local views position requests no composer or second factory')
        assert.equal(host.size(), 0, 'registering candidate rendering creates no Session view or retain')
        await plugin.dispose()
        assert.equal(root.slots.entries('hapi.workspace.session-view').length, 0)
        assert.equal(root.slots.entries('conversation.view')[0]!.component, official)
    } finally { await root.fiber.dispose() }
})

/** Explicit geometry, with the same public outer-row attributes as Chat. */
function readerFixture(count = 100, offset = 20) {
    let measures = 0, queries = 0, hits = true, tail = false, visibility = 'visible'
    const composer = { offsetHeight: 0 }
    const nodes = new Map<string, ChatConversationViewNode>()
    const rows = Array.from({ length: count }, (_, index) => {
        const key = `row-${index}`
        nodes.set(key, { key, kind: 'user', id: key, target: 'chat', anchorSeq: index * 10,
            visibility: 'visible', location: { kind: 'session' }, data: { seq: index * 10 } })
        return { dataset: { chatNodeKey: key, chatFlowKey: key },
            closest(selector: string) { return selector.startsWith('[data-chat-node-key]') ? this : null },
            compareDocumentPosition(other: HTMLElement) { return Number(other.dataset.chatNodeKey!.slice(4)) > index ? 4 : 2 },
            getBoundingClientRect() {
                measures++
                return { top: 100 + (index - offset) * 20, bottom: 120 + (index - offset) * 20, height: 20 }
            },
        } as unknown as HTMLElement
    })
    const port = { clientHeight: 600, clientWidth: 800,
        getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 50, right: 850 }),
        contains: (row: HTMLElement) => rows.includes(row),
        querySelector: (selector: string) => selector === '[data-composer-seat]' ? composer : tail ? {} : null,
        querySelectorAll: () => { queries++; return rows },
    }
    const target = { isConnected: true, hidden: false, closest: () => null, querySelector: () => port,
        ownerDocument: {
            defaultView: { innerHeight: 1000, innerWidth: 1000, getComputedStyle: () => ({ visibility }) },
            elementFromPoint(_x: number, y: number) { return hits ? rows[Math.floor((y - 100) / 20) + offset] ?? null : null },
        },
    } as unknown as HTMLElement
    const snapshot = { nodes: { get: (key: string) => nodes.get(key) } } as unknown as ChatSnapshot
    return { target, port, rows, nodes, snapshot, composer, read: () => readSourceWindowViewport(target, snapshot, count * 10),
        measures: () => measures, queries: () => queries, gaps: () => { hits = false },
        followingTail: () => { tail = true }, hide: () => { visibility = 'hidden' } }
}

test('reader pins both visible boundaries without measuring the retained archive', () => {
    const f = readerFixture(4096, 2048)
    assert.deepEqual(f.read(), { firstSeq: 20480, lastSeq: 20770, followingTail: false,
        overscan: { firstSeq: 20470, lastSeq: 20770 } })
    assert.ok(f.measures() <= 30, 'one geometry margin is found without measuring the retained archive')
    f.followingTail()
    assert.equal(f.read()?.followingTail, true, 'tail ownership comes from the official Chat marker')
})

test('gaps use logarithmic boundary measurements and preserve an unknown hidden viewport', () => {
    const f = readerFixture(4096, 2048)
    f.gaps()
    assert.deepEqual(f.read(), { firstSeq: 20480, lastSeq: 20770, followingTail: false,
        overscan: { firstSeq: 20470, lastSeq: 20770 } })
    assert.ok(f.measures() <= 30, `binary fallback measured ${f.measures()} of 4096 retained rows`)
    f.hide()
    assert.equal(f.read(), undefined)
    Object.defineProperty(f.target, 'isConnected', { value: false })
    assert.equal(f.read(), undefined)
})

test('reader bounds stop above the sticky composer instead of pinning the rows covered by the editor', () => {
    const f = readerFixture(4096, 2048)
    f.composer.offsetHeight = 180
    assert.deepEqual(f.read(), { firstSeq: 20480, lastSeq: 20680, followingTail: false,
        overscan: { firstSeq: 20470, lastSeq: 20680 } })
    assert.ok(f.measures() <= 30, 'editor occlusion must not force a linear archive boundary search')
})

test('a short visible tail pins enough measured outer history above folded source rows to remain scrollable', () => {
    const f = readerFixture(100, 80)
    f.followingTail()
    // Twenty 20px outer rows occupy only 400px of a 600px viewport. The
    // official tail spacer leaves the remaining area blank. Each outer row
    // also owns nine folded source rows, which contribute no readable height.
    const records = Array.from({ length: 1000 }, (_, seq) => ({ type: 'event',
        source: { messageId: `source-${seq}`, at: seq, seq }, event: {
            seq, type: seq % 10 === 0 ? 'assistant/message' : 'tool/call', time: seq, data: {},
        } })) as unknown as Parameters<typeof pinSourceViewport>[0]
    const viewport = f.read()!
    assert.deepEqual([viewport.firstSeq, viewport.lastSeq, viewport.followingTail], [800, 990, true],
        'the actual reader boundary remains separate from geometry retained above it')
    const pin = pinSourceViewport(records, viewport)!
    const overscan = viewport.overscan && pinSourceViewport(records, { ...viewport.overscan, followingTail: false })
    const pins = [pin, { ...pin, followingTail: false }, ...(overscan ? [overscan] : [])]
    const budget = { events: 1500, bytes: 12 * 1024 * 1024, size: () => 1 }
    const plan = sourceRetentionPlan(records, pins, 'newer', budget)
    const readableHeight = records.slice(plan.first, plan.last).filter(row => row.event.type === 'assistant/message').length * 20
    assert.ok(readableHeight > f.port.clientHeight,
        `retained outer history is only ${readableHeight}px; folded source overscan cannot fill a ${f.port.clientHeight}px viewport`)
    assert.deepEqual([plan.first, plan.last], [0, records.length],
        'measuring a short viewport cannot discard already loaded history below the safety budget')
    const pressured = sourceRetentionPlan(records, pins, 'newer', { ...budget, events: 500 })
    assert.equal(pressured.fits, true)
    assert.ok(pressured.last - pressured.first <= 500, 'actual pressure still enforces the retained event budget')
    assert.ok(records.slice(pressured.first, pressured.last).filter(row => row.event.type === 'assistant/message').length * 20 > f.port.clientHeight,
        'a safety trim must preserve the measured readable height above folded tool rows')
    assert.ok(f.measures() <= 35, 'finding the earlier readable boundary uses bounded layout work')
})

test('visible tool output pins its result and nested result dependencies without reading the output body', () => {
    const f = readerFixture(1, 0), row = f.rows[0]!
    row.getBoundingClientRect = () => ({ top: -1000, bottom: 2000, height: 3000 } as DOMRect)
    f.target.ownerDocument.elementFromPoint = () => row
    f.nodes.set('row-0', { key: 'row-0', kind: 'tool-call', id: 'call', target: 'chat', anchorSeq: 100,
        visibility: 'visible', location: { kind: 'session' }, data: { root: { kind: 'tool-result', seq: 900,
            get content() { throw new Error('Viewport retention must not inspect tool output bytes') },
            subCalls: [{ kind: 'tool-result', seq: 950, subCalls: [] }],
        } } })
    assert.deepEqual(f.read(), { firstSeq: 100, lastSeq: 950, followingTail: false })
    assert.equal(f.queries(), 0, 'one oversized visible node needs no transcript enumeration')
})

test('the unchanged official Chat tool node retains the call-to-result source interval', async () => {
    const chat = officialChat()
    try {
        const event = (seq: number, type: string, data: unknown) => ({ type: 'event' as const,
            event: { seq, time: seq, type, data, ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}) } as SessionEvent })
        chat.assembler.replaceWindow([
            event(10, 'turn/start', { turn: 1 }), event(20, 'step/start', { turn: 1, step: 1 }),
            event(100, 'tool/call', { turn: 1, step: 1, callId: 'visible-call', name: 'fixture', arguments: '{}' }),
            event(900, 'tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'tool',
                source: { kind: 'tool', callId: 'visible-call' }, toolCallId: 'visible-call', content: [{ type: 'text', text: 'synthetic long output' }] } }),
        ], true)
        chat.assembler.activateTarget('chat'); chat.assembler.flush()
        const snapshot = chat.assembler.snapshot('chat') as unknown as ChatSnapshot
        const tool = snapshot.order.map(key => snapshot.nodes.get(key)).find(node => node?.kind === 'tool-call')!
        assert.ok(tool)
        assert.equal(tool.anchorSeq, 100)
        const f = readerFixture(1, 0), row = f.rows[0]!
        row.dataset.chatNodeKey = tool.key
        row.getBoundingClientRect = () => ({ top: -1000, bottom: 2000, height: 3000 } as DOMRect)
        f.target.ownerDocument.elementFromPoint = () => row
        assert.deepEqual(readSourceWindowViewport(f.target, snapshot, 900), { firstSeq: 100, lastSeq: 900, followingTail: false })
    } finally { await chat.close() }
})

test('official process controls pin their real event, not the synthetic position before sparse seqs', async () => {
    const chat = officialChat()
    try {
        const event = (seq: number, type: string, data: unknown) => ({ type: 'event' as const,
            event: { seq, time: seq, type, data } as SessionEvent })
        const entries = [event(10, 'turn/start', { turn: 1 }), event(20, 'step/start', { turn: 1, step: 1 }),
            event(100, 'tool/call', { turn: 1, step: 1, callId: 'fixture-call', name: 'fixture', arguments: '{}' })]
        chat.assembler.replaceWindow(entries, true)
        chat.assembler.activateTarget('chat'); chat.assembler.flush()
        const snapshot = chat.assembler.snapshot('chat') as unknown as ChatSnapshot
        const control = snapshot.order.map(key => snapshot.nodes.get(key)).find(node => node?.kind === 'turn-process')!
        assert.ok(control)
        assert.equal(control.anchorSeq, 99.9, 'the pinned renderer uses a presentation position before the call')
        const f = readerFixture(1, 0), row = f.rows[0]!
        row.dataset.chatNodeKey = control.key
        row.getBoundingClientRect = () => ({ top: -1000, bottom: 2000, height: 3000 } as DOMRect)
        f.target.ownerDocument.elementFromPoint = () => row
        const viewport = readSourceWindowViewport(f.target, snapshot, 100)
        assert.deepEqual(viewport, { firstSeq: 100, lastSeq: 100, followingTail: false })
        assert.ok(pinSourceViewport(entries, viewport!), 'a real visible control must not fall back to unknown geometry')
    } finally { await chat.close() }
})

test('a middle visible tool result may extend beyond the bottom row ordering anchor', () => {
    const f = readerFixture()
    const middle = f.nodes.get('row-30')!
    f.nodes.set(middle.key, { ...middle, kind: 'tool-call', data: { root: { kind: 'tool-result', seq: 900, subCalls: [] } } })
    assert.deepEqual(f.read(), { firstSeq: 200, lastSeq: 900, followingTail: false,
        overscan: { firstSeq: 190, lastSeq: 900 } })
})

test('an unsettled assistant pins its complete step prefix through the current event tail', () => {
    const f = readerFixture()
    const middle = f.nodes.get('row-30')!
    f.nodes.set(middle.key, { ...middle, kind: 'assistant-step', anchorSeq: 300.5, data: { status: 'running', blocks: [] },
        location: { kind: 'step', turn: {} as never, step: { start: { seq: 150 }, end: undefined } as never } })
    assert.deepEqual(f.read(), { firstSeq: 150, lastSeq: 1000, followingTail: false })
    f.nodes.set(middle.key, { ...middle, kind: 'extension-with-unknown-dependencies' })
    assert.equal(f.read(), undefined, 'an unrecognized public payload cannot authorize destructive trimming')
})

test('an unusually dense visible set remains untrimmed instead of exceeding the reader work budget', () => {
    const f = readerFixture(100, 0)
    for (const [index, row] of f.rows.entries()) {
        row.getBoundingClientRect = () => ({ top: 100 + index * 5, bottom: 105 + index * 5, height: 5 } as DOMRect)
    }
    f.gaps()
    assert.equal(f.read(), undefined)
})

test('reader registration is occurrence-local, ignores unavailable views, and releases its callback', () => {
    const f = readerFixture(), readers = new Set<SourceWindowReader>()
    let available = true, bindings = 0
    const reference = { binding: { session: { registerWindowReader(reader: SourceWindowReader) {
        readers.add(reader); return () => { readers.delete(reader) }
    } }, eventSource: { getSnapshot: () => ({ entries: [{ event: { seq: 1000 } }] }) } } } as unknown as SessionReference
    const ctx = { uiConversation: { binding(binding: unknown) {
        assert.equal(binding, reference.binding); bindings++
        return { target: (name: string) => { assert.equal(name, 'chat'); return { getSnapshot: () => f.snapshot } } }
    } } } as unknown as Context
    const stop = registerVisibleWindowReader(ctx, f.target, reference, () => available)
    const reader = [...readers][0]!
    assert.equal(bindings, 0, 'registering does not activate or retain another renderer')
    assert.deepEqual(reader.read(), { firstSeq: 200, lastSeq: 490, followingTail: false,
        overscan: { firstSeq: 190, lastSeq: 490 } })
    available = false
    assert.equal(reader.available(), false)
    assert.equal(reader.read(), undefined)
    assert.equal(bindings, 1, 'a parked view does not touch Conversation state')
    available = true; f.port.clientHeight = 0
    assert.equal(reader.available(), true)
    assert.equal(reader.read(), undefined, 'visible unknown geometry is distinct from an unavailable pane')
    stop()
    assert.equal(readers.size, 0)
})

async function viewHostFixture(t: TestContext) {
    const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
    t.after(() => {
        if (previousObserver) Object.defineProperty(globalThis, 'MutationObserver', previousObserver)
        else Reflect.deleteProperty(globalThis, 'MutationObserver')
    })
    const require = createRequire(import.meta.url)
    let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-client-ui-renderer/client') } | undefined
    new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({
        __ModuleLoader__: { load(value: typeof published) { published = value } },
    })
    const root = new Context()
    root.reflect.provide('sessions', { list: { getSnapshot: () => ({ byId: {} }) } } as unknown as Context['sessions'])
    new (published!.factory(require).SlotRegistry)(root)
    await root.plugin({ name: 'reader-public-shell', inject: ['slots'], apply(ctx: Context) {
        ctx.slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } },
            ({ renderSlot }: PropsRenderSlots<'shell.overlay'>) => renderSlot('shell.overlay', {}))
    } })
    let host!: ReturnType<typeof installSessionViewHost>
    const plugin = root.plugin({ name: 'reader-public-views', inject: ['slots', 'sessions'], apply(ctx: Context) {
        host = installSessionViewHost(ctx); return () => host.dispose()
    } })
    await plugin
    return { root, host, plugin }
}

function measuringTarget(geometry: ReturnType<typeof fixture>, readingState?: () => string | null): HTMLElement {
    // No React/browser mounting is simulated: only explicit official geometry
    // and the public reading status participate in this admission fixture.
    const events = new EventTarget(), dataset: Record<string, string> = {}
    const latest = { className: 'official_toBottom', disabled: false, getClientRects: () => [{}],
        click() { geometry.port.scrollTop = geometry.port.scrollHeight - geometry.port.clientHeight } }
    return { ...geometry.target, isConnected: true, hidden: false, dataset, closest: () => null,
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
        getAttribute: (name: string) => name === 'data-hapi-reading' ? readingState?.() ?? dataset.hapiReading ?? null : null,
        querySelectorAll: (selector: string) => selector === '[data-composer-card] [data-composer-input]'
            ? geometry.target.querySelectorAll(selector) : selector === 'button[aria-label]' ? [latest] : [],
    } as unknown as HTMLElement
}

const emptyEvents = () => ({ getSnapshot: () => ({ entries: [], revision: 0, hasMore: false, change: { kind: 'replace' } }),
    subscribe: () => () => {} })

test('ready Session occurrences use the committed event window without registering a second reader', async t => {
    const { root, host, plugin } = await viewHostFixture(t)
    try {
        const readers = new Set<SourceWindowReader>(), ready = deferred<SessionReference['binding']>()
        let releases = 0
        const binding = { session: { getSnapshot: () => ({ hasMore: false, loadingOlder: false }),
            registerWindowReader(reader: SourceWindowReader) { readers.add(reader); return () => { readers.delete(reader) } },
        }, eventSource: emptyEvents() } as unknown as SessionReference['binding']
        const reference = { sessionId: 'same-owner', binding, ready: ready.promise, release() { releases++ } } as unknown as SessionReference
        const visible = { current: true }
        const mount = (paneId: string) => host.mount({ paneId, reference,
            target: measuringTarget(fixture()),
            navigation: { state: { getSnapshot: () => ({ visible: visible.current }), subscribe: () => () => {} }, reading: { getSnapshot: () => undefined, subscribe: () => () => {} } } as unknown as WorkspacePaneNavigation,
        })
        const first = mount('first'), second = mount('second')
        assert.equal(readers.size, 0, 'loading views have no usable geometry yet')
        ready.resolve(binding); await tick()
        assert.equal(readers.size, 0, 'the source window no longer trims against per-pane viewport pins')
        await first.dispose()
        assert.equal(readers.size, 0)
        await plugin.dispose()
        assert.equal(readers.size, 0)
        await second.dispose()
        assert.equal(releases, 0, 'pin registration never owns a native or public Session retain')
    } finally { await root.fiber.dispose() }
})

test('a reused source can select its new measuring preparer before latest reading becomes ready', async t => {
    const { root, host } = await viewHostFixture(t)
    const preparers = new Set<SourceWindowPreparer>()
    const binding = { session: { getSnapshot: () => ({ hasMore: false, loadingOlder: false, removed: false }),
        registerWindowPreparer(preparer: SourceWindowPreparer) { preparers.add(preparer); return () => { preparers.delete(preparer) } },
    }, eventSource: emptyEvents() } as unknown as SessionReference['binding']
    const reference = { sessionId: 'reused-source', binding, ready: Promise.resolve(binding) } as unknown as SessionReference
    let oldVisible = true, checkedBeforeReady = false, newReady = 0
    const navigation = (visible: () => boolean, latest = false) => ({
        state: { getSnapshot: () => ({ visible: visible() }), subscribe: () => () => {} },
        reading: { getSnapshot: () => latest ? { revision: 1, sessionId: 'reused-source', target: { kind: 'latest' } } : undefined,
            subscribe: () => () => {} },
    }) as unknown as WorkspacePaneNavigation
    try {
        const old = host.mount({ paneId: 'old', reference, target: measuringTarget(fixture()), navigation: navigation(() => oldVisible) })
        await tick()
        assert.equal(preparers.size, 1)
        oldVisible = false
        const newer = host.mount({ paneId: 'new', reference, navigation: navigation(() => true, true),
            target: measuringTarget(fixture(), () => {
                if (checkedBeforeReady) return 'ready'
                assert.equal(preparers.size, 2, 'new geometry must be registered while its initial reading is pending')
                assert.deepEqual([...preparers].map(preparer => preparer.available()), [false, true],
                    'the hidden old reader cannot be the sole candidate supplier')
                checkedBeforeReady = true
                return 'loading'
            }),
            onReady: () => { newReady++ },
        })
        await tick()
        assert.equal(checkedBeforeReady, true)
        assert.equal(newReady, 0, 'this DOM boundary fixture does not claim a real React reveal')
        await newer.dispose()
        assert.equal(preparers.size, 1)
        await old.dispose()
        assert.equal(preparers.size, 0)
    } finally { await root.fiber.dispose() }
})

test('composer admission errors use the existing error channel and unregister measuring preparation', async t => {
    const { root, host } = await viewHostFixture(t)
    const preparers = new Set<SourceWindowPreparer>(), errors: unknown[] = []
    let ready = 0
    const binding = { session: { getSnapshot: () => ({ hasMore: false, loadingOlder: false, removed: true }),
        registerWindowPreparer(preparer: SourceWindowPreparer) { preparers.add(preparer); return () => { preparers.delete(preparer) } },
    }, eventSource: emptyEvents() } as unknown as SessionReference['binding']
    const reference = { sessionId: 'removed-source', binding, ready: Promise.resolve(binding) } as unknown as SessionReference
    try {
        const view = host.mount({ paneId: 'removed', reference, target: measuringTarget(fixture()),
            navigation: { state: { getSnapshot: () => ({ visible: true }), subscribe: () => () => {} }, reading: { getSnapshot: () => undefined, subscribe: () => () => {} } } as unknown as WorkspacePaneNavigation,
            onReady: () => { ready++ }, onError: error => { errors.push(error) },
        })
        await tick()
        assert.equal(ready, 0)
        assert.equal(errors.length, 1)
        assert.equal((errors[0] as Error).message, 'The conversation was removed.')
        assert.equal(preparers.size, 0)
        await view.dispose()
    } finally { await root.fiber.dispose() }
})

test('disposing the whole Host cancels initial admission while the browser has no active frames', async t => {
    const { root, host } = await viewHostFixture(t)
    const f = fixture()
    f.documentVisible(false); f.suspendFrames()
    const binding = f.reference.binding
    const reference = { sessionId: 'suspended-host', binding, ready: Promise.resolve(binding) } as unknown as SessionReference
    try {
        host.mount({ paneId: 'suspended', reference, target: measuringTarget(f),
            navigation: { state: { getSnapshot: () => ({ visible: true }), subscribe: () => () => {} },
                reading: { getSnapshot: () => undefined, subscribe: () => () => {} } } as unknown as WorkspacePaneNavigation,
        })
        await tick()
        assert.equal(f.pendingFrames(), 1)
        assert.equal(f.listeners(), 1)
        host.dispose(); await tick()
        assert.equal(f.pendingFrames(), 0)
        assert.equal(f.listeners(), 0)
    } finally { await root.fiber.dispose() }
})
