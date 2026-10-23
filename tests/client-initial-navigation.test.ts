/** Actual initial-history binding; DOM and Session boundaries are doubles. */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import type { PaneReadingIntent, PaneReadingTarget } from '../src/client/reading-intent.ts'
import { bindInitialHistory } from '../src/client/seamless/initial.ts'

function store<T>(initial: T) {
    let value = initial
    const listeners = new Set<() => void>()
    return { getSnapshot: () => value,
        subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
        set(next: T) { value = next; for (const listener of listeners) listener() } }
}

function fixture(t: TestContext) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    const observers = new Set<{ callback: () => void; target?: object }>()
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class {
        constructor(readonly callback: () => void) { observers.add(this) }
        target?: object
        observe(target: object) { this.target = target }
        disconnect() { observers.delete(this) }
    } })
    let sequence = 0, loadCount = 0
    const frames = new Map<number, FrameRequestCallback>()
    const document = { defaultView: { performance,
        requestAnimationFrame(run: FrameRequestCallback) { const id = ++sequence; frames.set(id, run); return id },
        cancelAnimationFrame(id: number) { frames.delete(id) },
    } }
    const sessionState = store({ openState: 'open', loadingOlder: false, hasMore: true })
    const events = store({ entries: [{ type: 'event', event: { type: 'assistant/message', seq: 100, data: { turn: 1 } } }] })
    const session = { ...sessionState, loadOlder: () => {
        loadCount++
        sessionState.set({ ...sessionState.getSnapshot(), loadingOlder: true })
        return new Promise<void>(() => {})
    } }
    const reference = { sessionId: 'fixture', ready: Promise.resolve(), binding: { session, eventSource: events } } as unknown as SessionReference
    const disposers: Array<() => void> = []
    const pane = (targetKind: PaneReadingTarget = { kind: 'latest' }) => {
        const state = store({ visible: true, focused: true })
        const reading = store<PaneReadingIntent | undefined>({ revision: 1, sessionId: 'fixture', target: targetKind })
        const attrs = new Map<string, string>()
        const target = { ownerDocument: document, isConnected: true, hidden: false,
            closest: () => null, addEventListener() {}, removeEventListener() {},
            getAttribute: (name: string) => attrs.get(name) ?? null,
            setAttribute(name: string, value: string) {
                attrs.set(name, value)
                if (name === 'data-hapi-reading') for (const observer of observers) if (observer.target === target) observer.callback()
            },
            removeAttribute(name: string) { attrs.delete(name) },
        }
        const navigation = { state, reading } as Pick<WorkspacePaneNavigation, 'state' | 'reading'>
        const stop = bindInitialHistory(target as unknown as HTMLElement, reference, navigation)
        disposers.push(stop)
        return { state, reading, stop, target,
            phase(value: string) { target.setAttribute('data-hapi-reading', value) },
            locate(value: PaneReadingTarget) { reading.set({ revision: reading.getSnapshot()!.revision + 1, sessionId: 'fixture', target: value }) },
        }
    }
    t.after(() => {
        for (const dispose of disposers) dispose()
        if (previous) Object.defineProperty(globalThis, 'MutationObserver', previous)
        else Reflect.deleteProperty(globalThis, 'MutationObserver')
    })
    return { pane, loads: () => loadCount,
        async tick() {
            await Promise.resolve()
            const batch = [...frames.values()]; frames.clear()
            for (const frame of batch) frame(performance.now())
            await new Promise<void>(resolve => setTimeout(resolve, 0))
        },
    }
}

test('explicit message navigation acquires history before initial context; retained completed target does not block it forever', async t => {
    const f = fixture(t), pane = f.pane({ kind: 'message', messageId: 'source', origin: 'link' })
    await f.tick(); assert.equal(f.loads(), 0)
    pane.phase('loading'); await f.tick(); assert.equal(f.loads(), 0)
    pane.phase('ready'); await f.tick()
    assert.equal(f.loads(), 1, 'normal previous-turn fill resumes after the target completes')
    assert.equal(pane.reading.getSnapshot()!.target.kind, 'message', 'completion need not erase the selected target')
})

test('ordinary latest opens still fill previous-turn context with one shared flight', async t => {
    const f = fixture(t)
    f.pane(); f.pane()
    await f.tick(); await f.tick()
    assert.equal(f.loads(), 1)
})

test('a visible sibling destination prevents another occurrence from taking its shared history flight', async t => {
    const f = fixture(t)
    f.pane()
    const destination = f.pane({ kind: 'approval', requestId: 'request' })
    await f.tick(); assert.equal(f.loads(), 0)
    destination.phase('ready'); await f.tick()
    assert.equal(f.loads(), 1)
})

test('a failed destination releases its sibling context without erasing the target available for retry', async t => {
    const f = fixture(t)
    f.pane()
    const destination = f.pane({ kind: 'message', messageId: 'source', origin: 'search' })
    destination.phase('loading')
    await f.tick(); assert.equal(f.loads(), 0)
    destination.phase('error'); await f.tick()
    assert.equal(f.loads(), 1, 'a completed failure no longer owns the shared history flight')
    assert.equal(destination.reading.getSnapshot()!.target.kind, 'message')
})

test('hidden or disposed destinations release background context for another visible occurrence', async t => {
    const f = fixture(t)
    f.pane()
    const hidden = f.pane({ kind: 'message', messageId: 'source', origin: 'search' })
    const disposed = f.pane({ kind: 'delivery', localId: 'delivery' })
    await f.tick(); assert.equal(f.loads(), 0)
    hidden.state.set({ visible: false, focused: false })
    await f.tick(); assert.equal(f.loads(), 0, 'another visible destination still owns navigation')
    disposed.stop(); await f.tick()
    assert.equal(f.loads(), 1)
})

test('an explicit target arriving before the scheduled background page wins; latest can resume it', async t => {
    const f = fixture(t), pane = f.pane()
    await Promise.resolve()
    pane.locate({ kind: 'message', messageId: 'source', origin: 'notification' })
    await f.tick(); assert.equal(f.loads(), 0)
    pane.locate({ kind: 'latest' }); await f.tick()
    assert.equal(f.loads(), 1)
})

test('reload restoration loading state also postpones initial fill without changing its selected latest intent', async t => {
    const f = fixture(t), pane = f.pane()
    pane.phase('loading')
    await f.tick(); assert.equal(f.loads(), 0)
    pane.phase('ready'); await f.tick()
    assert.equal(f.loads(), 1)
})
