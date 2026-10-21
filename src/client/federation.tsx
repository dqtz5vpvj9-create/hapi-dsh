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
import { panes, type PaneResource } from './model.ts'
import { installRemotePane } from './remote-pane.tsx'
import { installSourceVoice } from './source-voice/index.tsx'
import { installTurnSharing } from './turn-share.tsx'
import { installShareReceiver } from './share-receiver.tsx'
import { installSourceAppearance } from './appearance/index.tsx'
import { installSourceTerminalActions } from './source-terminal-actions.tsx'
import { installNewSessionShortcut } from './shortcuts.ts'
import { waitForCatalogSession } from './catalog-readiness.ts'
import { resolveOriginalSession } from './source-session-resolver.ts'
import { createGraphStore, graphStorage, GRAPH_STORE_MODULE } from './runtime-store.ts'
import type { WorkspacePaneNavigation } from './pane-navigation.ts'
import type {} from './native-integration.tsx'
import { createPaneInputRouter } from './pane-input.ts'
import { createPaneRetention } from './pane-retention.ts'
import { isPluginEventsRequest, pluginEventsOverWebSocket, SharedPluginEvents } from './plugin-events.ts'
import { documentPaneTarget } from '../workspace/artifacts.ts'
import { legacyTerminalPaneTarget } from './legacy-session-terminal.tsx'
import { createWorkspaceUiBridge } from './workspace-ui.ts'
import { browserValue } from './browser-value.ts'

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
    if (basePath === '/') return new URL(input, `${origin}/`).href
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
    events: SharedPluginEvents
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
    if (host.id !== 'local' && payload.graph.entries.some(row => row.id === 'hapi-dsh')) throw new Error('A Runner must use the Host-only hapi-dsh-runner bundle')
    const modulesExport = await root.modules.import(MODULES_ID, '', {}) as HostResources['modulesExport']
    if (typeof modulesExport.createClientModuleSystem !== 'function') throw new Error('The official DSH module bootstrap is unavailable')
    const staticModules = Object.fromEntries(await Promise.all(PLATFORM_MODULES.map(async id => [id, await root.modules.import(id, '', {})])))
    const eventsUrl = new URL('/hapi-dsh/plugin-events', window.location.origin)
    eventsUrl.protocol = eventsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    eventsUrl.searchParams.set('host', host.id)
    const eventsFetch: typeof fetch = (_input, init) => pluginEventsOverWebSocket(eventsUrl, init?.signal)
    return { payload, modulesExport, staticModules, artifacts: new Map(), events: new SharedPluginEvents(eventsFetch, 'plugins/events', signal) }
}

/** Public Loader and module-system instances execute unchanged upstream bundle bytes. */
async function bootGraph(root: Context, host: FederationHost, resources: HostResources, surface: HTMLElement, instanceId: string, signal: AbortSignal, navigation?: WorkspacePaneNavigation): Promise<GraphRuntime> {
    const origin = window.location.origin
    const baseUrl = new URL(host.basePath, origin).href
    const directFetch = transport(host, signal)
    const hostFetch: typeof fetch = (input, init) => isPluginEventsRequest(input, init, origin)
        ? resources.events.response(AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]))
        : directFetch(input, init)
    const target: ClientModuleLoaderTarget = {
        mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration) },
        create(options) { return resources.modulesExport.createClientModuleSystem(this, { id: MODULES_ID, exports: resources.modulesExport as unknown as Record<string, unknown> }, options) },
    }
    const keyboard: KeyboardRegistration[] = []
    const captured = new WeakSet<KeyboardEvent>()
    const bubbled = new WeakSet<KeyboardEvent>()
    const registrations: Array<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; installed: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }> = []
    const input = createPaneInputRouter({
        surface, visible: () => navigation?.state.getSnapshot().visible !== false && !surface.hidden,
        activeElement: () => document.activeElement,
        resetDrag() {
            // The original plugin owns the cleanup callback. Invoke only this
            // graph's global drag-end listeners when its drag leaves the pane.
            const event = new Event('dragend')
            for (const entry of [...registrations]) if (entry.target === window && entry.type === 'dragend') {
                if (typeof entry.listener === 'function') entry.listener.call(window, event)
                else entry.listener.handleEvent(event)
            }
        },
    })
    const unvisibility = navigation?.state.subscribe(() => { if (!navigation.state.getSnapshot().visible) input.reset() })
    const blur = (): void => { input.reset() }
    window.addEventListener('blur', blur)
    const addEvent = (eventTarget: Window | Document, targetName: 'window' | 'document', type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        if (type === 'keydown') { keyboard.push({ listener, capture, target: targetName }); return }
        const installed = targetName === 'document' ? (event: Event): void => {
            if (!input.accepts(event)) return
            if (typeof listener === 'function') listener.call(documentFacade, event)
            else listener.handleEvent(event)
        } : listener
        eventTarget.addEventListener(type, installed, options)
        registrations.push({ target: eventTarget, type, listener, installed, ...(options === undefined ? {} : { options }) })
    }
    const removeEvent = (eventTarget: Window | Document, targetName: 'window' | 'document', type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void => {
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        if (type === 'keydown') {
            const index = keyboard.findIndex(entry => entry.listener === listener && entry.capture === capture && entry.target === targetName)
            if (index !== -1) keyboard.splice(index, 1)
            return
        }
        const index = registrations.findIndex(entry => entry.target === eventTarget && entry.type === type && entry.listener === listener)
        if (index !== -1) { eventTarget.removeEventListener(type, registrations[index]!.installed, options); registrations.splice(index, 1) }
    }
    const localStorageFacade = graphStorage(window.localStorage, host.id, instanceId)
    const stopCheckpoint = navigation?.updates.register(`${host.label} · ${instanceId}`, async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        localStorageFacade.checkpoint()
    }, 'verify')
    // Keep browser-owned theme/title writes local. Disposing a remote theme
    // presenter must not retract the main shell's variables or attributes.
    const documentFacade = new Proxy(document, {
        get(current, property) {
            if (property === 'body' || property === 'documentElement' || property === 'head') return surface
            if (property === 'title') return host.label
            if (property === 'addEventListener') return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => addEvent(document, 'document', type, listener, options)
            if (property === 'removeEventListener') return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => removeEvent(document, 'document', type, listener, options)
            return browserValue(current, property)
        },
        set(_current, property) { return property === 'title' },
    })
    const socket = (input: string, protocols?: string | string[]): WebSocket => {
        const upstream = new URL(input, baseUrl)
        if (host.id === 'local') {
            upstream.protocol = upstream.protocol === 'https:' || upstream.protocol === 'wss:' ? 'wss:' : 'ws:'
            return new WebSocket(upstream, protocols)
        }
        const path = upstream.pathname.startsWith(host.basePath) ? `/${upstream.pathname.slice(host.basePath.length)}${upstream.search}` : `${upstream.pathname}${upstream.search}`
        const url = new URL('/hapi-dsh/socket', origin)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('machine', host.id); url.searchParams.set('path', path)
        return new WebSocket(url, protocols)
    }
    const overrides: Record<PropertyKey, unknown> = {
        ...resources.payload.globals, __ModuleLoader__: target, __DSH_BOOT__: resources.payload.graph, __HAPI_DSH_PANE__: true,
        localStorage: localStorageFacade, fetch: hostFetch, document: documentFacade,
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => addEvent(window, 'window', type, listener, options),
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => removeEvent(window, 'window', type, listener, options),
    }
    const facade: object = new Proxy(Object.create(null) as object, {
        get(_target, property) {
            if (property === 'window' || property === 'globalThis' || property === 'self') return facade
            if (Object.hasOwn(overrides, property)) return overrides[property]
            return browserValue(window, property)
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
    if (navigation) {
        ctx.reflect.provide('hapiWorkspacePane', navigation)
        ctx.reflect.provide('hapiWorkspaceUi', navigation)
    }
    let stopped = false
    const stop = async (): Promise<void> => {
        if (stopped) return
        stopped = true
        input.reset(); stopCheckpoint?.(); unvisibility?.(); window.removeEventListener('blur', blur)
        keyboard.length = 0
        try { await ctx.fiber.dispose() } finally {
            for (const entry of registrations) entry.target.removeEventListener(entry.type, entry.installed, entry.options)
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
async function bootHost(root: Context, workspace: WorkspaceController, host: FederationHost, signal: AbortSignal, sharedUi: ReturnType<typeof createWorkspaceUiBridge>): Promise<HostRuntime> {
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
    type Resource = Exclude<PaneResource, { kind: 'empty' }>
    interface PaneRuntime { sourceId: string; surface: HTMLDivElement; update(resource: Resource, options: WorkspaceRenderOptions): void; stop(force?: boolean): Promise<void> }
    const activePanes = new Map<string, PaneRuntime>()
    const allPanes = new Set<PaneRuntime>()
    const parking = document.createElement('div')
    parking.hidden = true; parking.dataset.hapiParkedHost = host.id
    document.body.append(parking)
    let unsubscribeLayout: (() => void) | undefined
    const createPane = (paneId: string, sourceId: string, resource: Resource, initial: WorkspaceRenderOptions): PaneRuntime => {
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
        let retired = false
        let lifetime: AbortController | undefined
        let runtime: GraphRuntime | undefined
        let reference: SessionReference | undefined
        let pane: ReturnType<typeof installRemotePane> | undefined
        let unsubscribe: (() => void) | undefined
        let unshortcut: (() => void) | undefined
        let voiceScope: ReturnType<Context['inject']> | undefined
        let generation = 0
        let currentResource = resource
        let presentation = { focused: initial.focused, visible: initial.visible !== false }
        const presentationListeners = new Set<() => void>()
        let menuTarget = initial.toolsTarget ?? null
        const menuListeners = new Set<() => void>()
        const toolsTarget = {
            getSnapshot: () => menuTarget,
            subscribe(listener: () => void) { menuListeners.add(listener); return () => { menuListeners.delete(listener) } },
        }
        const resourceId = sessionResourceId(host.id, sourceId)
        const ui = sharedUi.createScope()
        const navigation: WorkspacePaneNavigation = {
            paneId, hostId: host.id, preferences: ui.preferences, voice: ui.voice, sourceSummaries: ui.sourceSummaries,
            shareInbox: ui.shareInbox, handoffs: ui.handoffs, sourceScheduleDrafts: ui.sourceScheduleDrafts, sourceFileMutations: ui.sourceFileMutations, updates: ui.updates,
            readLegacyScratchlist: ui.readLegacyScratchlist,
            registerCloseGuard: guard => workspace.registerPaneCloseGuard(paneId, guard),
            retainForDraftTransfer: () => retention.retain(),
            openSuccessor: displaySessionId => workspace.openSuccessorSession(resourceId, sessionResourceId(host.id, displaySessionId), paneId),
            state: { getSnapshot: () => presentation, subscribe(listener) { presentationListeners.add(listener); return () => { presentationListeners.delete(listener) } } },
            catalog: { getSnapshot: () => workspace.getSnapshot().catalog.byId[resourceId], subscribe: workspace.subscribe },
            revealConversation: () => {
                workspace.store.focus(paneId)
                workspace.updateView(paneId, { type: 'conversation' }, workspace.getSnapshot().catalog.byId[resourceId]?.displayTitle ?? 'Conversation')
                runtime?.ctx.layout.selectPanel(null)
                if (runtime?.ctx.sidebarRight.isExpanded()) runtime.ctx.sidebarRight.toggleExpanded()
            },
            openResource: (address, options = {}) => workspace.openResource(address, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }),
            openTab: (kind, options = {}) => workspace.openTab(kind, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }),
            openPanel: (panelId, options = {}) => workspace.openPanel(panelId, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }),
            openView: (target, options = {}) => workspace.openView(target, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }),
        }
        const draw = (): void => {
            if (!pane || !reference || disposed) return
            try {
                let target = currentResource.kind === 'view' ? currentResource.target : undefined
                if (currentResource.kind === 'terminal') target = currentResource.target ?? legacyTerminalPaneTarget(currentResource)
                if (currentResource.kind === 'document') target = currentResource.target ?? documentPaneTarget(sourceId, currentResource.document,
                    currentResource.sourceSessionId ? { sourceSessionId: currentResource.sourceSessionId,
                        ...(currentResource.sourceHubId ? { sourceHubId: currentResource.sourceHubId } : {}),
                        ...(currentResource.document.kind === 'file' && currentResource.document.machineId ? { machineId: currentResource.document.machineId } : {}),
                    } : undefined)
                renderer.render(pane.renderView(reference, { target, ...presentation }))
            } catch (error) { renderer.render(<div className="hapi-empty" role="alert"><p>{errorMessage(error)}</p></div>) }
        }
        const capture = (event: KeyboardEvent): void => { runtime?.dispatch(event, true) }
        const bubble = (event: KeyboardEvent): void => { runtime?.dispatch(event, false) }
        surface.addEventListener('keydown', capture, true)
        surface.addEventListener('keydown', bubble)
        const release = async (): Promise<void> => {
            await ui.stopOwnedVoice().catch(workspace.report)
            lifetime?.abort(); unsubscribe?.(); unsubscribe = undefined
            unshortcut?.(); unshortcut = undefined
            await voiceScope?.dispose(); voiceScope = undefined
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
                const graph = await bootGraph(root, host, resources, surface, paneId, activeSignal, navigation)
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
                const integration = graph.ctx.get('hapiPaneNative')
                // An ordinary remote DSH Host need not install HAPI's source
                // plugin. The shared Hub supplies voice credentials/transport,
                // while the voice tool owner uses this graph's own binding.
                if (!integration) {
                    voiceScope = graph.ctx.inject(['slots', 'locale', 'sessions', 'uiSession', 'uiConversation', 'conversation', 'sidebarRight', 'hapiWorkspaceUi'],
                        owner => {
                            const disposers = [installSourceVoice(owner, root.remote.hapi), installTurnSharing(owner), installShareReceiver(owner), installSourceAppearance(owner), installSourceTerminalActions(owner, root.remote.hapi)]
                            return () => { for (const dispose of disposers.reverse()) dispose() }
                        })
                    await voiceScope
                    if (disposed || currentGeneration !== generation || activeSignal.aborted) return
                }
                pane = installRemotePane(graph.ctx, { hostLabel: host.label, toolsTarget,
                    ...(integration ? { native: integration.native, localeInstalled: true } : {}),
                    navigated: (target, title) => workspace.updateView(paneId, target, title), keyboard: {
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
                draw()
            } catch (reason) { fail(reason) }
        }
        const retention = createPaneRetention(() => {
            retired = true
            surface.hidden = true; surface.dataset.hapiFocused = 'false'; surface.dataset.hapiVisible = 'false'
            presentation = { focused: false, visible: false }
            for (const listener of presentationListeners) listener()
            unsubscribe?.(); unsubscribe = undefined; unshortcut?.(); unshortcut = undefined
            void ui.stopOwnedVoice().catch(workspace.report)
            parking.append(surface)
        }, async () => {
            if (disposed) return
            disposed = true; generation++
            surface.removeEventListener('keydown', capture, true)
            surface.removeEventListener('keydown', bubble)
            surface.remove(); renderer.unmount()
            presentationListeners.clear()
            menuListeners.clear()
            try { await release(); await ui.dispose().catch(workspace.report) }
            finally { allPanes.delete(result) }
        })
        const result: PaneRuntime = { sourceId, surface, update(resource, options) {
            if (retired) return
            currentResource = resource
            const nextMenuTarget = options.toolsTarget ?? null
            if (menuTarget !== nextMenuTarget) { menuTarget = nextMenuTarget; for (const listener of menuListeners) listener() }
            const next = { focused: options.focused, visible: options.visible !== false }
            surface.dataset.hapiFocused = next.focused ? 'true' : 'false'
            surface.dataset.hapiVisible = next.visible ? 'true' : 'false'
            if (presentation.focused !== next.focused || presentation.visible !== next.visible) {
                presentation = next; for (const listener of presentationListeners) listener()
            }
            draw()
        }, stop: retention.stop }
        allPanes.add(result)
        void start()
        return result
    }
    const getPane = (paneId: string, sourceId: string, resource: Resource, options: WorkspaceRenderOptions): PaneRuntime => {
        const current = activePanes.get(paneId)
        if (current?.sourceId === sourceId) { current.update(resource, options); return current }
        if (current) void current.stop()
        const next = createPane(paneId, sourceId, resource, options)
        activePanes.set(paneId, next)
        return next
    }
    const reconcilePanes = (): void => {
        const desired = new Map<string, string>()
        for (const window of workspace.store.getSnapshot().windows) for (const pane of panes(window.root)) {
            if (pane.resource.kind === 'empty') continue
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
        if (host.id !== 'local') catalog = await bootGraph(root, host, resources, catalogSurface, 'catalog', signal)
        function RemoteSession({ sourceId, resource, options }: { sourceId: string; resource: Resource; options: WorkspaceRenderOptions }) {
            const mount = useRef<HTMLDivElement>(null)
            const paneId = options.paneId
            useLayoutEffect(() => {
                const target = mount.current!
                const view = getPane(paneId, sourceId, resource, options)
                target.append(view.surface)
                return () => {
                    view.update(resource, { ...options, visible: false, focused: false })
                    if (view.surface.parentElement === target) parking.append(view.surface)
                }
            }, [sourceId, paneId])
            useLayoutEffect(() => { activePanes.get(paneId)?.update(resource, options) }, [paneId, resource, options.focused, options.visible, options.toolsTarget])
            return <div ref={mount} className="hapi-remote-mount" style={{ minHeight: 0, height: '100%', width: '100%' }}/>
        }
        const renderPane: NonNullable<import('./controller.ts').WorkspaceHost['renderPane']> = (reference, resource, options) => <RemoteSession sourceId={reference.sessionId} resource={resource} options={options}/>
        removeHost = host.id === 'local' ? workspace.bindRenderer('local', renderPane) : workspace.addHost({
            id: host.id, label: host.label, sessions: catalog!.ctx.sessions, navigation: catalog!.ctx.uiWorkspace, workspaces: catalog!.ctx.workspaces, workspaceState: catalog!.ctx.workspaces.list,
            renderPane, renderConversation: (reference, options) => <RemoteSession sourceId={reference.sessionId} resource={{ kind: 'chat', sessionId: sessionResourceId(host.id, reference.sessionId) }} options={options ?? { paneId: reference.sessionId, focused: true }}/>,
        })
        unsubscribeLayout = workspace.store.subscribe(reconcilePanes)
        await catalog?.ctx.sessions.refresh()
        let stopped = false
        return { async stop() {
            if (stopped) return
            stopped = true; unsubscribeLayout?.(); removeHost?.()
            await Promise.allSettled([...allPanes].map(graph => graph.stop(true)))
            activePanes.clear()
            await catalog?.stop(); catalogSurface.remove(); parking.remove()
        } }
    } catch (error) {
        unsubscribeLayout?.(); removeHost?.()
        await Promise.allSettled([...allPanes].map(graph => graph.stop(true)))
        await catalog?.stop(); catalogSurface.remove(); parking.remove(); throw error
    }
}

/** Reconcile paired Hosts and native display revisions in the single workspace. */
export function installFederation(ctx: Context, workspace: WorkspaceController): () => Promise<void> {
    const lifetime = new AbortController()
    const unresolveSource = workspace.installSourceResolver((source, signal) => resolveOriginalSession(ctx.remote.hapi, ctx.sessions, source, AbortSignal.any([lifetime.signal, signal])))
    let preferenceStorage: Storage | undefined
    let windowStorage: Storage | undefined
    try { preferenceStorage = localStorage } catch { /* The public preference face can remain in memory. */ }
    try { windowStorage = sessionStorage } catch { /* In-memory share ownership is still distinct for this window. */ }
    const sharedUi = createWorkspaceUiBridge(preferenceStorage, window, windowStorage)
    const unprovideUi = ctx.reflect.provide('hapiWorkspaceUi', sharedUi.root)
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
    const local: { abort: AbortController; runtime?: HostRuntime } = { abort: new AbortController() }
    running.set('local', local)
    void bootHost(ctx, workspace, { id: 'local', label: 'DSH', online: true, basePath: '/' }, AbortSignal.any([lifetime.signal, local.abort.signal]), sharedUi).then(async runtime => {
        if (lifetime.signal.aborted) await runtime.stop()
        else local.runtime = runtime
    }).catch(error => { if (!lifetime.signal.aborted) workspace.report(error) })
    const poll = async (): Promise<void> => {
        if (polling || lifetime.signal.aborted) return
        polling = true
        try {
            const catalog = remoteValue(await ctx.remote.hapi.catalog())
            workspace.setMachines(catalog.machines)
            workspace.setSourceCatalog(catalog.sessions, catalog.hubId, { hosts: catalog.hosts, connected: catalog.connected })
            for (const session of catalog.sessions) {
                const previous = logical.get(session.logicalSessionId)
                if (previous && previous !== session.id) workspace.replaceSession(previous, session.id)
                logical.set(session.logicalSessionId, session.id)
            }
            const online = new Set(['local', ...catalog.hosts.filter(host => host.online).map(host => host.id)])
            for (const [id, entry] of running) if (!online.has(id)) {
                running.delete(id); entry.abort.abort(); await entry.runtime?.stop()
            }
            for (const host of catalog.hosts) {
                if (!host.online || running.has(host.id)) continue
                const entry: { abort: AbortController; runtime?: HostRuntime } = { abort: new AbortController() }
                running.set(host.id, entry)
                void bootHost(ctx, workspace, host, AbortSignal.any([lifetime.signal, entry.abort.signal]), sharedUi).then(async runtime => {
                    if (entry.abort.signal.aborted || lifetime.signal.aborted) { await runtime.stop(); return }
                    entry.runtime = runtime; reported.delete(host.id); workspace.catalogHostReady(host.id, host.label)
                }).catch(error => {
                    if (running.get(host.id) === entry) running.delete(host.id)
                    if (entry.abort.signal.aborted || lifetime.signal.aborted) return
                    const message = errorMessage(error)
                    workspace.catalogHostFailed(host.id, host.label, message)
                    if (reported.get(host.id) !== message) { reported.set(host.id, message); workspace.report(message) }
                })
            }
        } catch (error) { if (!lifetime.signal.aborted) { workspace.sourceCatalogFailed(error); workspace.report(error) } }
        finally { polling = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 3000)
    return async () => {
        lifetime.abort(); clearInterval(timer)
        unresolveSource()
        document.removeEventListener('keydown', containShortcuts)
        for (const entry of running.values()) entry.abort.abort()
        await Promise.allSettled([...running.values()].map(entry => entry.runtime?.stop()))
        running.clear()
        try { await sharedUi.dispose() } finally { await unprovideUi() }
    }
}
