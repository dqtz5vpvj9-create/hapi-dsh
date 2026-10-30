/** Real React DOM, pinned SlotRenderer and SessionProvider. The public
 * Conversation factory/slot leaf and its geometry are lifecycle fixtures;
 * complete Chat layout remains the official Host browser test's scope. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import { test, type TestContext } from 'node:test'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { act, createElement, useLayoutEffect } from 'react'
import type { SessionBinding, SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationContentProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SourcePreparationReference, SourceWindowPreparer, SourceWindowReader } from '../src/client/source-sessions.ts'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import type { RemotePaneViews } from '../src/client/remote-reading-session.ts'
import type { ConversationHistoryViewV1, HistoryViewSnapshotV1 } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sourceSessionId, type SourceChanges, type SourceChangesRequest, type SourceOperation, type SourcePage, type SourceSession } from '../src/remote/protocol.ts'
import { installSessionViewHost } from '../src/client/surface/session-view.tsx'

const require = createRequire(import.meta.url)
const projectRoot = resolvePath(import.meta.dirname, '..')
const { createWindow } = require('@mixmark-io/domino') as { createWindow(html: string, url: string): Window & typeof globalThis }
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

type SourceClasses = {
    RemotePaneViews: typeof import('../src/client/remote-reading-session.ts').RemotePaneViews
    RemoteSourceHistory: typeof import('../src/client/remote-history.ts').RemoteSourceHistory
    RemoteSourceSession: typeof import('../src/client/remote-sessions.ts').RemoteSourceSession
}
let sourceClasses: Promise<SourceClasses> | undefined
function loadSourceClasses(): Promise<SourceClasses> {
    sourceClasses ??= build({
        stdin: { contents: "export { RemotePaneViews } from './src/client/remote-reading-session.ts'; export { RemoteSourceHistory } from './src/client/remote-history.ts'; export { RemoteSourceSession } from './src/client/remote-sessions.ts'", resolveDir: projectRoot, loader: 'ts' },
        alias: { '@deepseek-ai/dsh-api-session-controller/client': resolvePath(projectRoot, 'tests/fixtures/client-session-contract.ts') },
        external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent',
    }).then(output => {
        const module = { exports: {} as SourceClasses }
        new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
        return module.exports
    })
    return sourceClasses
}

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

function observable<T>(initial: T) {
    let value = initial
    const listeners = new Set<() => void>()
    return { getSnapshot: () => value,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        set(next: T) { value = next; for (const listener of listeners) listener() },
        subscribers: () => listeners.size,
    }
}

function official(name: string): { apply(ctx: Context): void; inject: string[] } {
    assert.equal(require(`${name}/package.json`).version, '0.2.1-rc.3')
    let registration: { factory(resolve: typeof require): { apply(ctx: Context): void; inject: string[] } } | undefined
    new Function('window', readFileSync(require.resolve(`${name}/client`), 'utf8'))({
        __ModuleLoader__: { load(value: typeof registration) { registration = value } },
    })
    assert.ok(registration)
    return registration.factory(require)
}

async function fixture(t: TestContext, options: { fillPage?: boolean; hhpiPane?: boolean } = {}) {
    const window = createWindow('<!doctype html><html><body><main id="app"></main><section id="pane"></section></body></html>', 'https://fixture.invalid/')
    const document = window.document
    const restorers: Array<() => void> = []
    const root = new Context()
    let host: ReturnType<typeof installSessionViewHost> | undefined
    let unmount: (() => void) | undefined
    t.after(async () => {
        try {
            await act(() => { host?.dispose(); unmount?.() })
            await root.fiber.dispose()
        } finally { for (const restore of restorers.reverse()) restore() }
    })
    const define = (target: object, key: string, descriptor: PropertyDescriptor): void => {
        const prior = Object.getOwnPropertyDescriptor(target, key)
        Object.defineProperty(target, key, { configurable: true, ...descriptor })
        restorers.push(() => { if (prior) Object.defineProperty(target, key, prior); else Reflect.deleteProperty(target, key) })
    }
    const install = (target: object, key: string, value: unknown): void => define(target, key, { writable: true, value })
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'Event'] as const)
        install(globalThis, key, key === 'window' ? window : key === 'document' ? document : window[key])
    install(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
    install(globalThis, 'MutationObserver', class { observe() {} disconnect() {} })
    install(document, 'visibilityState', 'visible')
    let elapsed = 0
    install(window, 'performance', { now: () => elapsed, getEntriesByType: () => [] })
    install(window, 'sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    install(window, 'requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
    install(window, 'cancelAnimationFrame', (id: number) => { frames.delete(id) })
    // Domino supplies DOM identity, parsing, mutation, selectors and React's
    // events. Only the browser's layout and missing modern conveniences are seats.
    const elementPrototype = window.HTMLElement.prototype
    define(elementPrototype, 'clientHeight', { get() { return 600 } })
    define(elementPrototype, 'clientWidth', { get() { return 800 } })
    // Candidate geometry borrows dimensions and typography from the visible
    // pane; Domino has neither layout nor an iterable computed declaration.
    install(window, 'getComputedStyle', () => Object.assign([], { font: '16px sans-serif', letterSpacing: 'normal', getPropertyValue: () => '' }))
    if (!('isConnected' in elementPrototype)) define(elementPrototype, 'isConnected', {
        get(this: HTMLElement) { return this.ownerDocument.documentElement.contains(this) },
    })
    if (!('dataset' in elementPrototype)) define(elementPrototype, 'dataset', {
        get(this: HTMLElement) {
            const element = this
            return new Proxy({}, { get: (_target, key) => element.getAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`) ?? undefined,
                set: (_target, key, value) => { element.setAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(value)); return true } })
        },
    })
    if (!('remove' in elementPrototype)) install(elementPrototype, 'remove', function(this: HTMLElement) { this.parentNode?.removeChild(this) })
    install(elementPrototype, 'getClientRects', function(this: HTMLElement) { return [this.getBoundingClientRect()] })
    install(elementPrototype, 'getBoundingClientRect', function(this: HTMLElement) {
        const height = this.hasAttribute('data-composer-input') ? 36 : this.hasAttribute('data-chat-flow') ? 100 : 600
        return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON() {} }
    })
    const querySelector = elementPrototype.querySelector
    install(elementPrototype, 'querySelector', function(this: HTMLElement, selector: string) { return querySelector.call(this, selector) ?? null })
    const id = (options.hhpiPane ? sourceSessionId({ machineId: 'preparation-machine', sourceId: 'native', engine: 'codex', nativeId: 'preparation-thread' })
        : 'preparation-fixture') as SessionBinding['sessionId']
    const preparation = deferred<SessionBinding>(), ready = deferred<SessionBinding>(), chatMounted = deferred<void>()
    const readingSnapshot = observable({ phase: 'loading' as 'loading' | 'ready', viewId: 'preparation-pane', version: undefined as number | undefined,
        before: null as string | null, after: null as string | null, hasBefore: false, hasAfter: false, busy: false, entries: [] as never[] })
    const readingView = { viewId: 'preparation-pane', snapshot: readingSnapshot, read: async () => readingSnapshot.getSnapshot() }
    const state = observable<SessionSnapshot>({ sessionId: id, pendingSubmissions: [], running: false, subagent: null,
        removed: false, openState: 'open', openError: null, hasMore: options.fillPage === true, loadingOlder: false,
        promptError: null, blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false })
    const events = observable({ entries: [], revision: 0, hasMore: false, change: { kind: 'replace', entries: [] } })
    const preparers = new Set<SourceWindowPreparer>(), readers = new Set<SourceWindowReader>()
    const counts = { mounts: 0, unmounts: 0, pages: 0, retains: 0, releases: 0, ready: 0 }
    const errors: unknown[] = []
    const session = { sessionId: id, getSnapshot: state.getSnapshot, subscribe: state.subscribe,
        projections: { faceOf: () => observable(undefined) },
        async loadOlder() { counts.pages++; state.set({ ...state.getSnapshot(), hasMore: false }) },
        async loadViewportPage() { counts.pages++; state.set({ ...state.getSnapshot(), hasMore: false }) },
        registerWindowPreparer(value: SourceWindowPreparer) { preparers.add(value); return () => { preparers.delete(value) } },
        registerWindowReader(value: SourceWindowReader) { readers.add(value); return () => { readers.delete(value) } },
    } as unknown as SessionBinding['session']
    const binding: SessionBinding = { sessionId: id, session, eventSource: events as unknown as SessionBinding['eventSource'], ctx: root as SessionBinding['ctx'] }
    const bindings = new Map<string, SessionBinding>([[id, binding]])
    const RemotePaneViewsClass = options.hhpiPane ? (await loadSourceClasses()).RemotePaneViews : undefined
    const paneViews = RemotePaneViewsClass ? new RemotePaneViewsClass() : undefined
    let paneReference: SessionReference | undefined, paneReady = false
    const paneOwner = { ...session, historyRead: { version: 1, openView: async () => ({}) },
        metadata: observable({}), history: { sourceEpoch: 'preparation-epoch' } }
    const held = { sessionId: id, binding: { ...binding, session: paneOwner } as unknown as SessionBinding, ready: preparation.promise,
        release() {}, [Symbol.dispose]() {} } as SessionReference
    const sessions = { list: observable({ byId: {}, ids: [], phase: 'ready' }), binding: (key: string) => bindings.get(key),
        ownsBinding: (candidate: SessionBinding) => paneViews?.owns(candidate) === true || bindings.get(candidate.sessionId) === candidate,
        openReadingView: (_reference: SessionReference, viewId: string) => {
            if (!paneViews) return undefined
            const opened = paneViews.open(held, viewId)
            paneReference = opened
            void opened.ready.then(() => { paneReady = true }, () => { paneReady = true })
            return opened
        },
        retain() { counts.retains++; throw new Error('A borrowed SessionProvider must not retain another reference') },
        retainInfo: () => observable({ retainedBy: {} }),
    }
    root.reflect.provide('sessions', sessions as unknown as Context['sessions'])
    root.reflect.provide('uiConversation', { binding: () => ({ readingView }) } as unknown as Context['uiConversation'])
    root.reflect.provide('remote', { $on: () => () => {} } as unknown as Context['remote'])
    root.reflect.provide('remoteAccess', { source: () => observable(undefined) } as unknown as Context['remoteAccess'])
    await root.plugin(official('@deepseek-ai/dsh-client-ui-renderer'))
    await root.plugin(official('@deepseek-ai/dsh-client-ui-session'))
    const conversation = observable({ activeTargets: new Set(['chat']) })
    const composerBlock = observable(undefined)
    root.uiSession.provide({ hooks: ['conversation'], resolve: () => ({ hooks: { conversation } }) })
    await root.plugin({ name: 'preparation-public-slot-fixture', inject: ['slots'], apply(ctx: Context) {
        ctx.slots.installLocale({ ...observable({ revision: 0 }), bind: () => key => key })
        ctx.slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } },
            ({ renderSlot }: PropsRenderSlots<'shell.overlay'>) => renderSlot('shell.overlay', {}))
        ctx.slots.registerFactory({ name: 'conversation.content', scope: 'session-maybe', locale: 'conversation',
            inject: () => ({ hooks: { composerBlock }, async selectWorkspace() {
                throw new Error('Workspace selection is outside the session preparation fixture')
            } }),
            children: {
                'conversation.session': { kind: 'single', scope: 'session' },
                'conversation.composer': { kind: 'chain', scope: 'session' },
                'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
                'conversation.input.dock': { kind: 'list', scope: 'session' },
                'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
                'conversation.hero.workspace': { kind: 'single', scope: 'root' },
                'conversation.hero.agentPreset': { kind: 'single', scope: 'session-maybe' },
                'conversation.hero.options': { kind: 'list', scope: 'session' },
            }, slots: { views: { scope: 'session' }, widthControls: { scope: 'root' } },
        }, ({ sessionId, useFactorySlot }: Pick<ConversationContentProps, 'sessionId' | 'useFactorySlot'>) => {
            const Views = useFactorySlot('views', () => null)
            return createElement('div', { 'data-conversation-content': '', 'data-conversation-session': sessionId },
                createElement('div', { 'data-conversation-scroll': '', ref: (port: HTMLElement | null) => {
                    if (!port) return
                    Object.defineProperties(port, { clientHeight: { configurable: true, value: 600 }, clientWidth: { configurable: true, value: 800 },
                        scrollHeight: { configurable: true, value: 600 }, scrollTop: { configurable: true, writable: true, value: 0 } })
                } }, createElement(Views), createElement('div', { 'data-composer-card': '' },
                    createElement('div', { 'data-composer-input': '', contentEditable: true, suppressContentEditableWarning: true }, 'Draft'))))
        })
        ctx.slots.register({ name: 'conversation.session' }, ({ sessionId, useSession }: PropsRuntime<'conversation.session'>) => {
            assert.equal(useSession(snapshot => snapshot.sessionId), sessionId)
            useLayoutEffect(() => { counts.mounts++; chatMounted.resolve(); return () => { counts.unmounts++ } }, [])
            return createElement('div', { 'data-chat-flow': '', 'data-preparation-slot': sessionId }, 'Source body')
        })
    } })
    await root.plugin({ name: 'preparation-host', inject: ['slots', 'sessions', 'uiConversation'], apply(ctx: Context) { host = installSessionViewHost(ctx); return () => host!.dispose() } })
    await act(() => { unmount = root.uiRenderer.mount(document.getElementById('app')!) })
    const reference: SourcePreparationReference = { sessionId: id, binding, preparationReady: preparation.promise, ready: ready.promise,
        release() { counts.releases++ }, [Symbol.dispose]() { counts.releases++ } }
    const navigation = { hostId: 'local', paneId: 'pane', state: observable({ visible: true, focused: true }),
        reading: observable(undefined) } as unknown as WorkspacePaneNavigation
    const target = document.getElementById('pane')!
    assert.ok(host)
    const installedHost = host
    let handle!: ReturnType<typeof installedHost.mount>
    await act(() => { handle = installedHost.mount({ paneId: 'pane', target, reference, navigation,
        onReady: () => { counts.ready++ }, onError: error => { errors.push(error) } }) })
    const candidate = (name: string) => {
        const sessionId = name as SessionBinding['sessionId']
        const source = observable({ ...state.getSnapshot(), sessionId, hasMore: true })
        const page = deferred<void>(), started = deferred<void>()
        const candidateBinding = { ...binding, sessionId, session: { ...session, sessionId,
            getSnapshot: source.getSnapshot, subscribe: source.subscribe,
            async loadViewportPage() {
                started.resolve(); await page.promise
                source.set({ ...source.getSnapshot(), hasMore: false })
            },
        } } as SessionBinding
        bindings.set(sessionId, candidateBinding)
        const candidateReference: SessionReference = { sessionId, binding: candidateBinding, ready: Promise.resolve(candidateBinding),
            release() { throw new Error('Candidate references remain owned by the source') },
            [Symbol.dispose]() { throw new Error('Candidate references remain owned by the source') } }
        return { reference: candidateReference, started: started.promise, finish: () => page.resolve() }
    }
    return { target, document, host: installedHost, handle, binding, reference, preparation, ready, chatMounted, readingSnapshot, paneReference: () => paneReference,
        paneReady: () => paneReady, paneViews, counts, errors, preparers, readers, candidate,
        failProvider(error: Error) {
            // The official SlotRenderer contains plugin-slot errors itself.
            // Lose the borrowed binding at the public SessionProvider boundary
            // to exercise the surrounding occurrence's terminal cleanup.
            Object.defineProperty(reference, 'binding', { configurable: true, get() { throw error } })
            handle.update({ navigation: { ...navigation } })
        },
        async addPane(paneId: string) {
            const nextTarget = document.createElement('section'); document.body.appendChild(nextTarget)
            let nextHandle!: typeof handle
            await act(async () => {
                nextHandle = installedHost.mount({ paneId, target: nextTarget, reference,
                    navigation: { ...navigation, paneId, state: observable({ visible: true, focused: true }) },
                    onReady: () => { counts.ready++ }, onError: error => { errors.push(error) } })
                await tick()
            })
            return { target: nextTarget, handle: nextHandle }
        },
        frames: () => frames.size,
        async frame(milliseconds = 16) { await act(async () => {
            elapsed += milliseconds
            const current = [...frames.values()]; frames.clear()
            for (const callback of current) callback(elapsed)
            await tick()
        }) },
        async settle(work: () => void) { await act(async () => { work(); await tick() }) },
    }
}

test('HHPI reference mounts through the real Host before its official reading window can become ready', async t => {
    const f = await fixture(t, { hhpiPane: true })
    const reference = f.paneReference()
    assert.ok(reference, 'the source Session must open its pane-scoped RemotePaneViews reference')
    assert.ok('preparationReady' in reference, 'RemotePaneViews must expose source-body readiness separately')
    assert.equal(f.counts.mounts, 0, 'the Host must keep the Chat unmounted while source body readiness is pending')
    await f.settle(() => f.preparation.resolve(f.binding))
    await f.chatMounted
    assert.ok(f.target.querySelector('[data-preparation-slot]'), 'source-body readiness must render the actual Host-owned Chat slot')
    assert.equal(f.paneReady(), false, 'the full pane reference still waits for the official reader to commit')
    assert.equal(f.readingSnapshot.getSnapshot().phase, 'loading')
    await f.settle(() => f.readingSnapshot.set({ ...f.readingSnapshot.getSnapshot(), phase: 'ready', version: 1 }))
    await reference.ready
    assert.equal(f.paneReady(), true)
    assert.deepEqual(f.errors, [])
})

test('RemotePaneSession attaches before a delayed RemoteSourceHistory baseline without reading its missing epoch', async t => {
    const { RemotePaneViews, RemoteSourceHistory, RemoteSourceSession } = await loadSourceClasses()
    const identity = { machineId: 'delayed-machine', sourceId: 'native', engine: 'codex', nativeId: 'delayed-thread' }
    const id = sourceSessionId(identity) as SessionBinding['sessionId']
    const metadata: SourceSession = { ...identity, id, title: 'Delayed baseline', cwd: '/synthetic', updatedAt: 1,
        status: 'idle', activeTurnId: null, capabilities: { send: true, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] }
    const baseline = deferred<SourcePage>()
    const history = new RemoteSourceHistory(id, {
        read: () => baseline.promise,
        changes: async function* (_request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
            await new Promise<void>(resolve => {
                if (signal?.aborted) { resolve(); return }
                signal?.addEventListener('abort', () => resolve(), { once: true })
            })
        },
    })
    const owner = new RemoteSourceSession(id, metadata, history, { operate: async (operation: SourceOperation) => ({
        sessionId: operation.sessionId, operationId: operation.operationId, status: 'accepted', message: 'accepted',
    }) } as never)
    const root = new Context()
    const binding = { sessionId: id, session: owner, eventSource: owner.eventSource, ctx: root } as unknown as SessionBinding
    const held: SessionReference = { sessionId: id, binding, ready: owner.ready.then(() => binding), release() {}, [Symbol.dispose]() {} }
    const panes = new RemotePaneViews()
    const reference = panes.open(held, 'delayed-pane')
    const pane = reference.binding.session as import('../src/client/remote-reading-session.ts').RemotePaneSession
    const opening = observable<HistoryViewSnapshotV1>({ revision: 0, phase: 'opening', failure: null, busy: false, hasBefore: false,
        hasAfter: false, headChanged: false, version: null, entries: [], correction: 'applied', correctionError: null })
    const reading = { version: 1, viewId: 'delayed-pane', snapshot: opening, reads: {} as never,
        read: async () => opening.getSnapshot(), refresh: async () => opening.getSnapshot(), release() {} } as ConversationHistoryViewV1
    t.after(async () => { panes.dispose(); owner.dispose(); history.dispose(); await root.fiber.dispose() })

    assert.throws(() => history.sourceEpoch, /Source baseline is not open/)
    assert.doesNotThrow(() => pane.attach(reading), 'Host attaches its official reader synchronously before source readiness')
    assert.equal(pane.sourceWindow.getSnapshot().historyId, undefined, 'no history identity exists before an accepted reader window')

    baseline.resolve({ session: metadata, epoch: 'delayed-epoch', version: 1, entries: [], before: null, after: null,
        hasBefore: false, hasAfter: false, context: [] })
    await reference.preparationReady
    assert.equal(pane.sourceWindow.getSnapshot().historyId, undefined, 'a source baseline alone is not an accepted pane window')
    const feed = await history.openView('delayed-pane', { events: 100, bytes: 1024 * 1024, nodes: 100 })
    opening.set({ ...opening.getSnapshot(), phase: 'ready', version: feed.initial.version })
    await reference.ready
    assert.equal(pane.sourceWindow.getSnapshot().historyId, JSON.stringify([id, 'delayed-pane', 'delayed-epoch']))
})

test('source preparation mounts the real scoped slot hidden before outline readiness and reveals the same DOM once', async t => {
    const f = await fixture(t, { fillPage: true })
    assert.equal(f.counts.mounts, 0)
    await f.settle(() => f.preparation.resolve(f.binding))
    const body = f.target.querySelector('[data-preparation-slot]')
    assert.ok(body, 'the pinned renderer and SessionProvider must actually commit the slot to DOM')
    const reveal = f.target.querySelector<HTMLElement>('[data-hapi-session-reveal]')!
    assert.equal(reveal.style.visibility, 'hidden')
    assert.equal(reveal.style.pointerEvents, 'none')
    assert.equal(reveal.getAttribute('data-hapi-session-reveal'), 'pending')
    assert.equal(f.preparers.size, 1)
    await f.frame(); await f.frame()
    assert.equal(f.counts.pages, 0, 'initial viewport paging still waits for the complete outline')
    assert.equal(f.counts.ready, 0)
    assert.equal(f.readers.size, 0)
    await f.settle(() => f.ready.resolve(f.binding))
    for (let step = 0; step < 5 && f.counts.ready === 0; step++) await f.frame()
    assert.equal(f.counts.pages, 1)
    assert.equal(f.counts.ready, 1)
    assert.equal(f.target.querySelector('[data-preparation-slot]'), body)
    assert.equal(f.target.querySelector('[data-hapi-session-reveal]'), reveal)
    assert.equal(reveal.style.visibility, 'visible')
    assert.equal(f.counts.mounts, 1)
    assert.equal(f.counts.unmounts, 0)
    await f.frame()
    assert.equal(f.counts.ready, 1)
    assert.equal(f.counts.retains, 0)
    assert.equal(f.counts.releases, 0)
    assert.deepEqual(f.errors, [])
})

test('two panes prepare latest windows concurrently without replacing either official occurrence', async t => {
    const f = await fixture(t)
    await f.settle(() => { f.preparation.resolve(f.binding); f.ready.resolve(f.binding) })
    await f.frame()
    const second = await f.addPane('second')
    await f.frame()
    assert.equal(f.counts.ready, 2)
    const originalEditors = [f.target, second.target].map(target => target.querySelector('[data-composer-input]'))
    const [firstPreparer, secondPreparer] = [...f.preparers]
    assert.ok(firstPreparer && secondPreparer)
    const alpha = f.candidate('latest-alpha'), beta = f.candidate('latest-beta')
    let first!: Promise<boolean>, last!: Promise<boolean>
    await f.settle(() => { first = firstPreparer.prepare(alpha.reference, new AbortController().signal) })
    await f.frame(); await alpha.started
    await f.settle(() => { last = secondPreparer.prepare(beta.reference, new AbortController().signal) })
    await f.frame(); await beta.started
    assert.equal(f.document.querySelectorAll('[data-hapi-window-preparation]').length, 2)
    assert.ok(f.document.querySelector('[data-preparation-slot="latest-alpha"]'), 'opening B cannot unmount A\'s in-flight official candidate')
    assert.ok(f.document.querySelector('[data-preparation-slot="latest-beta"]'))
    await f.settle(beta.finish)
    for (let index = 0; index < 3; index++) await f.frame()
    assert.equal(await last, true)
    assert.ok(f.document.querySelector('[data-preparation-slot="latest-alpha"]'), 'finishing B cannot dispose A\'s candidate')
    assert.equal(f.document.querySelectorAll('[data-hapi-window-preparation]').length, 1)
    await f.settle(alpha.finish)
    for (let index = 0; index < 3; index++) await f.frame()
    assert.equal(await first, true)
    assert.equal(f.document.querySelectorAll('[data-hapi-window-preparation]').length, 0)
    assert.deepEqual([f.target, second.target].map(target => target.querySelector('[data-composer-input]')), originalEditors,
        'candidate measurement preserves both original composer nodes')
    assert.equal(f.counts.ready, 2)
    assert.deepEqual(f.errors, [])
})

test('closing one pane cancels only its candidate and waits for its official unmount', async t => {
    const f = await fixture(t)
    await f.settle(() => { f.preparation.resolve(f.binding); f.ready.resolve(f.binding) })
    await f.frame()
    const second = await f.addPane('second')
    await f.frame()
    const [firstPreparer, secondPreparer] = [...f.preparers]
    assert.ok(firstPreparer && secondPreparer)
    const alpha = f.candidate('closing-alpha'), beta = f.candidate('surviving-beta')
    let first!: Promise<boolean>, last!: Promise<boolean>, closed!: Promise<void>
    await f.settle(() => {
        first = firstPreparer.prepare(alpha.reference, new AbortController().signal)
        last = secondPreparer.prepare(beta.reference, new AbortController().signal)
    })
    await f.frame(); await Promise.all([alpha.started, beta.started])
    await f.settle(() => { closed = f.handle.dispose() })
    await closed
    assert.equal(await first, false)
    assert.equal(f.document.querySelector('[data-hapi-window-preparation="closing-alpha"]') ?? null, null)
    assert.ok(f.document.querySelector('[data-preparation-slot="surviving-beta"]'))
    assert.ok(second.target.querySelector('[data-composer-input]'))
    await f.settle(beta.finish)
    for (let index = 0; index < 3; index++) await f.frame()
    assert.equal(await last, true)
    assert.equal(f.document.querySelectorAll('[data-hapi-window-preparation]').length, 0)
    assert.deepEqual(f.errors, [])
})

test('Host initial admission stops after one foreground budget and only user retry resumes the same editor', async t => {
    const f = await fixture(t)
    await f.settle(() => { f.preparation.resolve(f.binding); f.ready.resolve(f.binding) })
    const editor = f.target.querySelector('[data-composer-input]')!
    editor.setAttribute('contenteditable', 'false')
    editor.textContent = 'Unsent draft survives admission'
    await f.frame(5_001)
    assert.equal(f.errors.length, 1, 'exhausted admission must fail now, not sleep and obtain another five seconds')
    assert.equal(f.counts.ready, 0)
    assert.equal(f.target.querySelector('[data-composer-input]'), editor)
    assert.equal(f.target.querySelector<HTMLElement>('[data-hapi-session-reveal]')!.style.visibility, 'hidden')
    assert.match(f.target.querySelector('[role="alert"]')!.textContent!, /usable editor and first history viewport/)
    assert.equal(f.readers.size, 0)
    assert.equal(f.frames(), 0, 'no new admission or measurement survives the failed occurrence')
    assert.equal(f.counts.pages, 0)
    editor.setAttribute('contenteditable', 'true')
    const retry = f.target.querySelector<HTMLButtonElement>('[role="alert"] button')!
    assert.equal(retry.textContent, '重试打开')
    await f.settle(() => { retry.click(); retry.click() })
    await f.frame()
    assert.equal(f.counts.ready, 1)
    assert.equal(f.target.querySelector('[data-composer-input]'), editor)
    assert.equal(editor.textContent, 'Unsent draft survives admission')
    assert.equal(f.counts.mounts, 1, 'retry must not rebuild the official conversation or its editor')
    assert.equal(f.target.querySelector<HTMLElement>('[data-hapi-session-reveal]')!.style.visibility, 'visible')
    assert.equal(f.errors.length, 1)
})

test('a renderer failure during retryable admission becomes terminal and releases its preparation owner', async t => {
    const f = await fixture(t)
    await f.settle(() => { f.preparation.resolve(f.binding); f.ready.resolve(f.binding) })
    f.target.querySelector('[data-composer-input]')!.setAttribute('contenteditable', 'false')
    await f.frame(5_001)
    assert.ok(f.target.querySelector('[role="alert"] button'))
    assert.equal(f.preparers.size, 1)
    const error = new Error('official renderer failed while admission was paused')
    await f.settle(() => f.failProvider(error))
    assert.equal(f.errors.at(-1), error, 'the terminal failure cannot be ignored because the previous phase was already error')
    assert.equal(f.target.querySelector('[role="alert"]')?.textContent, error.message)
    assert.equal(f.target.querySelector('[role="alert"] button'), null)
    assert.equal(f.target.querySelector('[data-composer-input]'), null)
    assert.equal(f.preparers.size, 0)
    assert.equal(f.readers.size, 0)
    assert.equal(f.frames(), 0)
    assert.equal(f.counts.ready, 0)
})

test('outline failure unmounts the hidden scoped slot and clears its preparation without releasing the borrowed reference', async t => {
    const f = await fixture(t)
    await f.settle(() => f.preparation.resolve(f.binding))
    assert.equal(f.counts.mounts, 1)
    const error = new Error('source outline unavailable')
    await f.settle(() => f.ready.reject(error))
    assert.equal(f.target.querySelector('[data-preparation-slot]'), null)
    assert.equal(f.counts.unmounts, 1)
    assert.equal(f.preparers.size, 0)
    assert.equal(f.readers.size, 0)
    assert.equal(f.counts.ready, 0)
    assert.equal(f.counts.pages, 0)
    assert.equal(f.target.querySelector('[role="alert"]')?.textContent, error.message)
    assert.deepEqual(f.errors, [error])
    assert.equal(f.counts.retains, 0)
    assert.equal(f.counts.releases, 0)
})

test('outline failure before preparation settles prevents a late preparation from mounting the slot', async t => {
    const f = await fixture(t)
    const error = new Error('outline failed before the Session opened')
    await f.settle(() => f.ready.reject(error))
    assert.deepEqual(f.errors, [error])
    assert.equal(f.counts.mounts, 0)
    await f.settle(() => f.preparation.resolve(f.binding))
    await f.frame()
    assert.equal(f.target.querySelector('[data-preparation-slot]'), null)
    assert.equal(f.counts.mounts, 0)
    assert.equal(f.counts.ready, 0)
    assert.equal(f.counts.pages, 0)
    assert.equal(f.preparers.size, 0)
    assert.equal(f.readers.size, 0)
    assert.equal(f.counts.retains, 0)
    assert.equal(f.counts.releases, 0)
    assert.deepEqual(f.errors, [error])
})

for (const prepared of [false, true]) {
    test(`disposing ${prepared ? 'a hidden prepared' : 'an unopened'} occurrence prevents a late completion from mounting or revealing it`, async t => {
        const f = await fixture(t)
        if (prepared) await f.settle(() => f.preparation.resolve(f.binding))
        let removed!: Promise<void>
        await f.settle(() => { removed = f.handle.dispose() })
        await removed
        assert.equal(f.host.size(), 0)
        assert.equal(f.target.querySelector('[data-hapi-session-view]'), null)
        await f.settle(() => { f.preparation.resolve(f.binding); f.ready.resolve(f.binding) })
        await f.frame()
        assert.equal(f.target.querySelector('[data-hapi-session-view]'), null)
        assert.equal(f.counts.mounts, prepared ? 1 : 0)
        assert.equal(f.counts.unmounts, prepared ? 1 : 0)
        assert.equal(f.counts.ready, 0)
        assert.equal(f.counts.pages, 0)
        assert.equal(f.preparers.size, 0)
        assert.equal(f.readers.size, 0)
        assert.equal(f.counts.retains, 0)
        assert.equal(f.counts.releases, 0)
        assert.deepEqual(f.errors, [])
    })
}
