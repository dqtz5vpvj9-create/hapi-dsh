/** Official DSH Client graphs, isolated by Host and editable pane. */
import { Context } from '@deepseek-ai/cordis'
import { useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ClientModuleLoaderTarget, ClientModuleSystem, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { z } from 'zod'
import { remoteValue, type FederationHost } from '../client-api.ts'
import { errorMessage, parseSessionResourceId, sessionResourceId, type WorkspaceController, type WorkspaceRenderOptions } from './controller.ts'
import { panes } from './model.ts'
import { installRemotePane } from './remote-pane.tsx'
import { installNewSessionShortcut } from './shortcuts.ts'
import { waitForCatalogSession } from './catalog-readiness.ts'
import { createGraphStore, graphStorage, GRAPH_STORE_MODULE } from './runtime-store.ts'

const PLATFORM_MODULES = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    'zod', '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
] as const
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const bootstrapSchema = z.object({
    dshVersion: z.literal('0.2.1-rc.2'), graph: z.object({
        rev: z.string(), entries: z.array(z.object({ id: z.string(), url: z.string(), rev: z.string() }).passthrough()),
        batches: z.array(z.object({ phase: z.enum(['bootstrap', 'application']), url: z.string(), rev: z.string(), entries: z.array(z.string()) })),
        release: z.object({ version: z.literal('0.2.1-rc.2'), commit: z.string().optional() }).optional(),
    }), globals: z.record(z.string(), z.json()),
})
type Bootstrap = z.infer<typeof bootstrapSchema>

export function hostRequestUrl(basePath: string, input: string, origin: string): string {
    if (!basePath.startsWith('/hapi-dsh/machine/') || !basePath.endsWith('/')) throw new Error('Invalid federated Host base path')
    const url = new URL(input, `${origin}/`)
    if (url.origin !== origin) return url.href
    if (url.pathname.startsWith(basePath)) return url.href
    return new URL(`${basePath}${url.pathname.replace(/^\//, '')}${url.search}`, origin).href
}

interface KeyboardRegistration { listener: EventListenerOrEventListenerObject; capture: boolean; target: 'window' | 'document' }
interface GraphRuntime { ctx: Context; dispatch(event: KeyboardEvent, capture: boolean): void; stop(): Promise<void> }
interface HostRuntime { stop(): Promise<void> }
// Shared official primitives deliberately coordinate modal/focus ownership on
// element.ownerDocument. Their document listeners must receive pane events;
// only the primary application's later window shortcuts should be excluded.
const remoteKeyboardEvents = new WeakSet<KeyboardEvent>()
interface HostResources {
    payload: Bootstrap
    modulesExport: typeof import('@deepseek-ai/dsh-client-modules/client')
    staticModules: Record<string, unknown>
    /** Share immutable bytes, never factories, Contexts, references, or browser globals. */
    artifacts: Map<string, Promise<string>>
}

function transport(host: FederationHost, signal: AbortSignal): typeof fetch {
    const native = window.fetch.bind(window)
    return (input, init) => {
        const mapped = hostRequestUrl(host.basePath, input instanceof Request ? input.url : String(input), window.location.origin)
        const request = input instanceof Request ? new Request(mapped, input) : mapped
        return native(request, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })
    }
}

async function loadHostResources(root: Context, host: FederationHost, signal: AbortSignal): Promise<HostResources> {
    const response = await transport(host, signal)('hapi-dsh/bootstrap', { cache: 'no-store' })
    if (!response.ok) throw new Error(`${host.label}: DSH bootstrap returned HTTP ${response.status}`)
    const payload = bootstrapSchema.parse(await response.json())
    if (payload.graph.entries.some(row => row.id === 'hapi-dsh')) throw new Error('A Runner must use the Host-only hapi-dsh-runner bundle')
    const modulesExport = await root.modules.import(MODULES_ID, '', {}) as HostResources['modulesExport']
    if (typeof modulesExport.createClientModuleSystem !== 'function') throw new Error('The official DSH module bootstrap is unavailable')
    const staticModules = Object.fromEntries(await Promise.all(PLATFORM_MODULES.map(async id => [id, await root.modules.import(id, '', {})])))
    return { payload, modulesExport, staticModules, artifacts: new Map() }
}

/** Public Loader and module-system instances execute unchanged upstream bundle bytes. */
async function bootGraph(root: Context, host: FederationHost, resources: HostResources, surface: HTMLElement, instanceId: string, signal: AbortSignal): Promise<GraphRuntime> {
    const origin = window.location.origin
    const baseUrl = new URL(host.basePath, origin).href
    const hostFetch = transport(host, signal)
    const target: ClientModuleLoaderTarget = {
        mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration) },
        create(options) { return resources.modulesExport.createClientModuleSystem(this, { id: MODULES_ID, exports: resources.modulesExport as unknown as Record<string, unknown> }, options) },
    }
    const keyboard: KeyboardRegistration[] = []
    const captured = new WeakSet<KeyboardEvent>()
    const bubbled = new WeakSet<KeyboardEvent>()
    const registrations: Array<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }> = []
    const addEvent = (eventTarget: Window | Document, targetName: 'window' | 'document', type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        if (type === 'keydown') { keyboard.push({ listener, capture, target: targetName }); return }
        eventTarget.addEventListener(type, listener, options)
        registrations.push({ target: eventTarget, type, listener, ...(options === undefined ? {} : { options }) })
    }
    const removeEvent = (eventTarget: Window | Document, targetName: 'window' | 'document', type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void => {
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        if (type === 'keydown') {
            const index = keyboard.findIndex(entry => entry.listener === listener && entry.capture === capture && entry.target === targetName)
            if (index !== -1) keyboard.splice(index, 1)
            return
        }
        eventTarget.removeEventListener(type, listener, options)
        const index = registrations.findIndex(entry => entry.target === eventTarget && entry.type === type && entry.listener === listener)
        if (index !== -1) registrations.splice(index, 1)
    }
    const localStorageFacade = graphStorage(window.localStorage, host.id, instanceId)
    // Keep browser-owned theme/title writes local. Disposing a remote theme
    // presenter must not retract the main shell's variables or attributes.
    const documentFacade = new Proxy(document, {
        get(current, property) {
            if (property === 'body' || property === 'documentElement' || property === 'head') return surface
            if (property === 'title') return host.label
            if (property === 'addEventListener') return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => addEvent(document, 'document', type, listener, options)
            if (property === 'removeEventListener') return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => removeEvent(document, 'document', type, listener, options)
            const value: unknown = Reflect.get(current, property, current)
            return typeof value === 'function' ? value.bind(current) : value
        },
        set(_current, property) { return property === 'title' },
    })
    const socket = (input: string, protocols?: string | string[]): WebSocket => {
        const upstream = new URL(input, baseUrl)
        const path = upstream.pathname.startsWith(host.basePath) ? `/${upstream.pathname.slice(host.basePath.length)}${upstream.search}` : `${upstream.pathname}${upstream.search}`
        const url = new URL('/hapi-dsh/socket', origin)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('machine', host.id); url.searchParams.set('path', path)
        return new WebSocket(url, protocols)
    }
    const overrides: Record<PropertyKey, unknown> = {
        ...resources.payload.globals, __ModuleLoader__: target, __DSH_BOOT__: resources.payload.graph,
        localStorage: localStorageFacade, fetch: hostFetch, document: documentFacade,
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => addEvent(window, 'window', type, listener, options),
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => removeEvent(window, 'window', type, listener, options),
    }
    const facade: object = new Proxy(Object.create(null) as object, {
        get(_target, property) {
            if (property === 'window' || property === 'globalThis' || property === 'self') return facade
            if (Object.hasOwn(overrides, property)) return overrides[property]
            const value: unknown = Reflect.get(window, property)
            return typeof value === 'function' ? value.bind(window) : value
        },
        set(_target, property, value) { overrides[property] = value; return true },
        has(_target, property) { return Object.hasOwn(overrides, property) || property in window },
    })
    const loadBundle = async (url: string): Promise<void> => {
        const key = new URL(url, baseUrl).href
        let bytes = resources.artifacts.get(key)
        if (!bytes) {
            bytes = hostFetch(url, { cache: 'no-cache' }).then(async result => {
                if (!result.ok) throw new Error(`${host.label}: plugin artifact returned HTTP ${result.status}`)
                return result.text()
            })
            resources.artifacts.set(key, bytes)
            void bytes.catch(() => { if (resources.artifacts.get(key) === bytes) resources.artifacts.delete(key) })
        }
        const source = await bytes
        signal.throwIfAborted()
        const execute = new Function('window', 'globalThis', 'self', 'fetch', 'location', 'localStorage', 'document', `${source}\n//# sourceURL=${key}`)
        execute(facade, facade, facade, hostFetch, window.location, localStorageFacade, documentFacade)
    }
    overrides.__DSH_TRANSPORT__ = { fetch: hostFetch, createWebSocket: socket, streamBaseUrl: baseUrl, loadBundle }
    // The official Web seed's store engine closes over primary localStorage.
    // Its unmodified npm source is separately bundled and evaluated against
    // this graph's persistence facade; all plugin consumers get that instance.
    const modules: ClientModuleSystem = target.create({ boot: resources.payload.graph as WebBootGraph,
        staticModules: { ...resources.staticModules, [GRAPH_STORE_MODULE]: createGraphStore(localStorageFacade) }, loadBundle })
    const ctx = new Context()
    let stopped = false
    const stop = async (): Promise<void> => {
        if (stopped) return
        stopped = true
        keyboard.length = 0
        try { await ctx.fiber.dispose() } finally {
            for (const entry of registrations) entry.target.removeEventListener(entry.type, entry.listener, entry.options)
            registrations.length = 0
        }
    }
    try {
        const OfficialLoader = root.loader.constructor as typeof Loader
        await ctx.plugin(OfficialLoader)
        ctx.loader.internal = modules as never
        await modules.entries.start(ctx.loader, modules.manifest)
        await ctx.loader.await()
        signal.throwIfAborted()
        for (const entry of ctx.loader.entries()) {
            const error = modules.importError(entry.options.name)
            if (error) throw new Error(`${host.label}: ${entry.options.name}: ${error.message}`)
        }
        if (!ctx.get('sessions') || !ctx.get('uiWorkspace') || !ctx.get('uiRenderer')) throw new Error(`${host.label}: official DSH Client services did not activate`)
        return { ctx, stop, dispatch(event, capture) {
            const seen = capture ? captured : bubbled
            if (seen.has(event)) return
            seen.add(event); remoteKeyboardEvents.add(event)
            for (const targetName of capture ? ['window', 'document'] : ['document', 'window']) {
                for (const entry of [...keyboard]) {
                    if (entry.capture !== capture || entry.target !== targetName) continue
                    if (typeof entry.listener === 'function') entry.listener.call(facade, event)
                    else entry.listener.handleEvent(event)
                }
            }
        } }
    } catch (error) { await stop(); throw error }
}

/** One catalog graph per Host and one independently owned UI graph per editable pane. */
async function bootHost(root: Context, workspace: WorkspaceController, host: FederationHost, signal: AbortSignal): Promise<HostRuntime> {
    const resources = await loadHostResources(root, host, signal)
    const catalogSurface = document.createElement('div')
    catalogSurface.hidden = true; catalogSurface.dataset.hapiCatalogHost = host.id
    document.body.append(catalogSurface)
    let catalog: GraphRuntime | undefined
    let removeHost: (() => void) | undefined
    // Pane roots outlive their position in the workspace React tree. Moving a
    // pane, hiding a window, or visiting a primary Host plugin page must preserve
    // its editor, dialogs, Client Context, and SessionReference. The layout owns
    // these roots; component unmount only parks their DOM.
    interface PaneRuntime { sourceId: string; surface: HTMLDivElement; stop(): Promise<void> }
    const activePanes = new Map<string, PaneRuntime>()
    const parking = document.createElement('div')
    parking.hidden = true; parking.dataset.hapiParkedHost = host.id
    document.body.append(parking)
    let unsubscribeLayout: (() => void) | undefined
    const createPane = (paneId: string, sourceId: string): PaneRuntime => {
        const surface = document.createElement('div')
        surface.className = 'hapi-remote-pane'
        surface.dataset.hapiHost = host.id; surface.dataset.hapiPaneInstance = paneId
        Object.assign(surface.style, { display: 'flex', flexDirection: 'column', minHeight: '0', height: '100%', width: '100%', overflow: 'hidden' })
        // Runtime style/portal nodes are siblings of the React mount, so neither
        // React nor document-facade style insertion can erase the other's DOM.
        const mount = document.createElement('div')
        Object.assign(mount.style, { minHeight: '0', height: '100%', width: '100%' })
        surface.append(mount); parking.append(surface)
        const renderer = createRoot(mount)
        let disposed = false
        let lifetime: AbortController | undefined
        let runtime: GraphRuntime | undefined
        let reference: SessionReference | undefined
        let pane: ReturnType<typeof installRemotePane> | undefined
        let unsubscribe: (() => void) | undefined
        let unshortcut: (() => void) | undefined
        let generation = 0
        const capture = (event: KeyboardEvent): void => { runtime?.dispatch(event, true) }
        const bubble = (event: KeyboardEvent): void => { runtime?.dispatch(event, false) }
        surface.addEventListener('keydown', capture, true)
        surface.addEventListener('keydown', bubble)
        const release = async (): Promise<void> => {
            lifetime?.abort(); unsubscribe?.(); unsubscribe = undefined
            unshortcut?.(); unshortcut = undefined
            pane?.dispose(); pane = undefined
            reference?.release(); reference = undefined
            const graph = runtime; runtime = undefined
            await graph?.stop()
        }
        const start = async (): Promise<void> => {
            const currentGeneration = ++generation
            renderer.render(<div className="hapi-loading" role="status">{host.label} · Connecting…</div>)
            await release()
            if (disposed || currentGeneration !== generation) return
            lifetime = new AbortController()
            const activeSignal = AbortSignal.any([signal, lifetime.signal])
            const fail = (reason: unknown): void => {
                if (disposed || currentGeneration !== generation || activeSignal.aborted) return
                renderer.render(<div className="hapi-empty" role="alert"><p>{errorMessage(reason)}</p><button type="button" onClick={() => { void start() }}>Retry</button></div>)
            }
            try {
                const graph = await bootGraph(root, host, resources, surface, paneId, activeSignal)
                if (disposed || currentGeneration !== generation || activeSignal.aborted) { await graph.stop(); return }
                runtime = graph
                // Every official hook and SessionProvider is bound to this
                // graph's own reference, never the Host catalog reference.
                // Activation only starts the catalog poll. Its first response
                // can still be in flight even when the Host's separate catalog
                // graph already lists this session.
                await waitForCatalogSession(graph.ctx.sessions, sourceId as SessionId, activeSignal)
                if (disposed || currentGeneration !== generation || activeSignal.aborted) return
                reference = graph.ctx.sessions.retain(sourceId as SessionId, { source: 'hapiWorkspace' })
                void reference.ready.catch(fail)
                graph.ctx.uiWorkspace.openSession(sourceId as SessionId)
                const shortcuts = graph.ctx.get('shortcuts')
                if (shortcuts) unshortcut = installNewSessionShortcut(shortcuts, workspace.requestNewSession)
                pane = installRemotePane(graph.ctx, { hostLabel: host.label, keyboard: {
                    capture: event => graph.dispatch(event, true), bubble: event => graph.dispatch(event, false),
                } })
                let currentMain = sourceId
                unsubscribe = graph.ctx.sessions.list.subscribe(() => {
                    const candidates = Object.values(graph.ctx.sessions.list.getSnapshot().byId).filter(row => (row.retainedBy.mainView ?? 0) > 0)
                    const next = candidates.find(row => row.id !== currentMain)?.id ?? candidates[0]?.id
                    if (!next || next === currentMain || activeSignal.aborted) return
                    currentMain = next
                    workspace.store.focus(paneId)
                    workspace.openSession(sessionResourceId(host.id, next))
                })
                renderer.render(pane.renderConversation(reference))
            } catch (reason) { fail(reason) }
        }
        const result: PaneRuntime = { sourceId, surface, async stop() {
            if (disposed) return
            disposed = true; generation++
            surface.removeEventListener('keydown', capture, true)
            surface.removeEventListener('keydown', bubble)
            surface.remove(); renderer.unmount()
            await release()
        } }
        void start()
        return result
    }
    const getPane = (paneId: string, sourceId: string): PaneRuntime => {
        const current = activePanes.get(paneId)
        if (current?.sourceId === sourceId) return current
        if (current) void current.stop()
        const next = createPane(paneId, sourceId)
        activePanes.set(paneId, next)
        return next
    }
    const reconcilePanes = (): void => {
        const desired = new Map<string, string>()
        for (const window of workspace.store.getSnapshot().windows) for (const pane of panes(window.root)) {
            if (pane.resource.kind !== 'chat') continue
            try {
                const source = parseSessionResourceId(pane.resource.sessionId)
                if (source.hostId === host.id) desired.set(pane.id, source.sessionId)
            } catch { /* The controller presents malformed saved addresses. */ }
        }
        for (const [paneId, entry] of activePanes) if (desired.get(paneId) !== entry.sourceId) {
            activePanes.delete(paneId); void entry.stop()
        }
    }
    try {
        catalog = await bootGraph(root, host, resources, catalogSurface, 'catalog', signal)
        function RemoteSession({ sourceId, options }: { sourceId: string; options?: WorkspaceRenderOptions }) {
            const mount = useRef<HTMLDivElement>(null)
            const paneId = options?.paneId ?? sourceId
            useLayoutEffect(() => {
                const target = mount.current!
                const view = getPane(paneId, sourceId)
                target.append(view.surface)
                return () => {
                    if (view.surface.parentElement === target) parking.append(view.surface)
                }
            }, [sourceId, paneId])
            useLayoutEffect(() => { const view = activePanes.get(paneId); if (view) view.surface.dataset.hapiFocused = options?.focused ? 'true' : 'false' }, [paneId, options?.focused])
            return <div ref={mount} className="hapi-remote-mount" style={{ minHeight: 0, height: '100%', width: '100%' }}/>
        }
        removeHost = workspace.addHost({
            id: host.id, label: host.label, sessions: catalog.ctx.sessions, navigation: catalog.ctx.uiWorkspace, workspaces: catalog.ctx.workspaces, workspaceState: catalog.ctx.workspaces.list,
            renderConversation: (reference, options) => <RemoteSession sourceId={reference.sessionId} {...(options ? { options } : {})}/>,
        })
        unsubscribeLayout = workspace.store.subscribe(reconcilePanes)
        await catalog.ctx.sessions.refresh()
        let stopped = false
        return { async stop() {
            if (stopped) return
            stopped = true; unsubscribeLayout?.(); removeHost?.()
            await Promise.allSettled([...activePanes.values()].map(graph => graph.stop()))
            activePanes.clear()
            await catalog?.stop(); catalogSurface.remove(); parking.remove()
        } }
    } catch (error) {
        unsubscribeLayout?.(); removeHost?.()
        await Promise.allSettled([...activePanes.values()].map(graph => graph.stop()))
        await catalog?.stop(); catalogSurface.remove(); parking.remove(); throw error
    }
}

/** Reconcile paired Hosts and native display revisions in the single workspace. */
export function installFederation(ctx: Context, workspace: WorkspaceController): () => void {
    const lifetime = new AbortController()
    const running = new Map<string, { abort: AbortController; runtime?: HostRuntime }>()
    const logical = new Map<string, string>()
    const reported = new Map<string, string>()
    const containShortcuts = (event: KeyboardEvent): void => {
        if (remoteKeyboardEvents.has(event) || event.composedPath().some(node => node instanceof Element && node.matches('[data-hapi-host]'))) {
            // stopPropagation still allows every listener on this Document to
            // run: official Modal's Escape/Tab and Menu's navigation retain
            // their normal behavior. No primary window command sees the key.
            event.stopPropagation()
        }
    }
    document.addEventListener('keydown', containShortcuts)
    let polling = false
    const poll = async (): Promise<void> => {
        if (polling || lifetime.signal.aborted) return
        polling = true
        try {
            const catalog = remoteValue(await ctx.remote.hapi.catalog())
            for (const session of catalog.sessions) {
                const previous = logical.get(session.logicalSessionId)
                if (previous && previous !== session.id) workspace.replaceSession(previous, session.id)
                logical.set(session.logicalSessionId, session.id)
            }
            const online = new Set(catalog.hosts.filter(host => host.online).map(host => host.id))
            for (const [id, entry] of running) if (!online.has(id)) {
                running.delete(id); entry.abort.abort(); await entry.runtime?.stop()
            }
            for (const host of catalog.hosts) {
                if (!host.online || running.has(host.id)) continue
                const entry: { abort: AbortController; runtime?: HostRuntime } = { abort: new AbortController() }
                running.set(host.id, entry)
                void bootHost(ctx, workspace, host, AbortSignal.any([lifetime.signal, entry.abort.signal])).then(async runtime => {
                    if (entry.abort.signal.aborted || lifetime.signal.aborted) { await runtime.stop(); return }
                    entry.runtime = runtime; reported.delete(host.id)
                }).catch(error => {
                    if (running.get(host.id) === entry) running.delete(host.id)
                    if (entry.abort.signal.aborted || lifetime.signal.aborted) return
                    const message = errorMessage(error)
                    if (reported.get(host.id) !== message) { reported.set(host.id, message); workspace.report(message) }
                })
            }
        } catch (error) { if (!lifetime.signal.aborted) workspace.report(error) }
        finally { polling = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 3000)
    return () => {
        lifetime.abort(); clearInterval(timer)
        document.removeEventListener('keydown', containShortcuts)
        for (const entry of running.values()) { entry.abort.abort(); void entry.runtime?.stop() }
        running.clear()
    }
}
