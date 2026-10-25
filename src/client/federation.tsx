import { sameSourceGeneration, canReuseGenerationSurface, replacementReady, stageGenerationSurface, revealGenerationSurface } from './surface/generation-handoff.ts'
import { RecentViews } from './surface/recent-views.ts'
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
import { mountPaneNative } from './pane-native.ts'
import { installRemotePane } from './remote-pane.tsx'
import { deferInitialWorkspaceStream } from './initial-workspace-stream.ts'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import { installEntrySessionNavigation } from './sidebar-navigation.ts'
import { installPaneChrome } from './surface/chrome.ts'
import { createPaneBootGate, shouldBootPane } from './surface/lazy-pane.ts'
import { PANE_GRAPH_POLICY, projectPluginEvents } from './surface/pane-graph.ts'
import { prefetchPaneArtifacts } from './surface/prefetch.ts'
import { installSourceVoice } from './source-voice/index.tsx'
import { installTurnSharing } from './turn-share.tsx'
import { installShareReceiver } from './share-receiver.tsx'
import { installSourceAppearance } from './appearance/index.tsx'
import { installSourceTerminalActions } from './source-terminal-actions.tsx'
import { installNewSessionShortcut } from './shortcuts.ts'
import { waitForCatalogSession } from './catalog-readiness.ts'
import { HostBootQueue } from './surface/host-boot-queue.ts'
import { observeForegroundActivity } from './foreground-activity.ts'
import { canReleaseHistory } from './surface/history-retention.ts'
import type { UserQuestionProjectionView } from '@deepseek-ai/dsh-user-questions/types'
import type { HapiProjection } from '../codex/projection-types.ts'
import type { HapiObservedProjection } from '../hapi-agent/projection-types.ts'
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
import { createGraphModules, graphStyleQueries } from './graph-document.ts'
import { installSessionViewHost, type SessionViewHandle } from './surface/session-view.tsx'
import { createSessionWarmup } from './surface/session-warmup.ts'
import { HostOpeningTiming, observePaneOpening } from './surface/pane-opening.ts'
import { bindInitialHistory } from './seamless/index.ts'
import { recordDiagnostic } from './diagnostics/index.ts'
import { workspaceBootGraph } from '../shared/boot-graph.ts'
import { installDeferredPlugins } from './deferred-plugins.ts'
import { withOpeningHistory } from './session-opening-stream.ts'

const PLATFORM_MODULES = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    'zod', '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
] as const
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const bootstrapSchema = z.object({
    dshVersion: z.literal('0.2.1-rc.3'), graph: z.object({
        rev: z.string(), entries: z.array(z.object({ id: z.string(), url: z.string(), rev: z.string() }).passthrough()),
        batches: z.array(z.object({ phase: z.enum(['bootstrap', 'application']), url: z.string(), rev: z.string(), entries: z.array(z.string()) })),
        release: z.object({ version: z.literal('0.2.1-rc.3'), commit: z.string().optional() }).optional(),
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
    /** Refreshed before every pane boot so a later graph revision is not stale. */
    payload: Bootstrap
    staticModules: Record<string, unknown>
    /** Share immutable bytes, never factories, Contexts, references, or browser globals. */
    artifacts: Map<string, Promise<string>>
    /**
     * Compiled bundle wrappers, shared by every pane graph of this Host. The
     * wrapper takes the pane's globals as parameters, so one compilation serves
     * all panes while each execution still closes over its own facades. Without
     * this cache every pane retains its own copy of the bundle source.
     */
    compiled: Map<string, (...args: unknown[]) => unknown>
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
    const staticModules = Object.fromEntries(await Promise.all(PLATFORM_MODULES.map(async id => [id, await root.modules.import(id, '', {})])))
    const eventsUrl = new URL('/hapi-dsh/plugin-events', window.location.origin)
    eventsUrl.protocol = eventsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    eventsUrl.searchParams.set('host', host.id)
    const eventsFetch: typeof fetch = (_input, init) => pluginEventsOverWebSocket(eventsUrl, init?.signal)
    return { payload, staticModules, artifacts: new Map(), compiled: new Map(), events: new SharedPluginEvents(eventsFetch, 'plugins/events', signal) }
}

/**
 * Refresh the cached Host bootstrap before binding a new pane. The graph rows a
 * pane boots come from this snapshot, so a pane opened after a Host graph
 * rebuild must not inherit the revision fetched at page start. The previous
 * snapshot stays usable when the refresh fails; the pane boot then fails on its
 * own if the Host is genuinely unreachable.
 */
async function refreshBootstrap(host: FederationHost, resources: HostResources, signal: AbortSignal): Promise<void> {
    try {
        const response = await transport(host, signal)('hapi-dsh/bootstrap', { cache: 'no-store' })
        if (!response.ok) return
        const payload = bootstrapSchema.parse(await response.json())
        if (host.id !== 'local' && payload.graph.entries.some(row => row.id === 'hapi-dsh')) return
        resources.payload = payload
    } catch { /* Keep the last known graph; a failing Host surfaces on the pane itself. */ }
}

/**
 * Public Loader and module-system instances execute unchanged upstream bundle bytes.
 *
 * `projectEvents` is the pane projection: the Host still answers one official
 * `/plugins/events` stream per Context, but graph syncs and rebuilds are
 * rewritten/dropped so a filtered pane can never restore an excluded row.
 *
 * `prefetchBundles` warms the shared per-Host artifact cache with bounded
 * parallel fetches while the loader resolves dependency chains, so a pane graph
 * over a slow Host or the Hub reverse tunnel is limited by throughput instead of
 * by the longest serial arrival chain. The loader still owns compilation
 * (`resources.compiled` is unchanged and one wrapper per Host URL).
 */
async function bootGraph(root: Context, host: FederationHost, resources: HostResources, boot: WebBootGraph, surface: HTMLElement, instanceId: string, signal: AbortSignal, navigation?: WorkspacePaneNavigation, pluginEvents = true, projectEvents = false, prefetchBundles = false, sharedHost = false, initialSession?: SessionId): Promise<GraphRuntime> {
    const origin = window.location.origin
    const baseUrl = new URL(host.basePath, origin).href
    const directFetch = transport(host, signal)
    let releaseInitialCatalog = (): void => {}
    const initialCatalog = initialSession ? new Promise<void>(resolve => { releaseInitialCatalog = resolve }) : undefined
    const initialLifetime = new AbortController()
    const hostFetch: typeof fetch = (input, init) => isPluginEventsRequest(input, init, origin)
        ? (pluginEvents
            ? resources.events.response(AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]))
                .then(response => projectEvents ? projectPluginEvents(response) : response)
            : new Promise<Response>(() => {}))
        : directFetch(input, init)
    const target: ClientModuleLoaderTarget = {
        mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration) },
        create(options) { return modulesExport.createClientModuleSystem(this, { id: MODULES_ID, exports: modulesExport as unknown as Record<string, unknown> }, options) },
    }
    const keyboard: KeyboardRegistration[] = []
    const captured = new WeakSet<KeyboardEvent>()
    const bubbled = new WeakSet<KeyboardEvent>()
    const registrations: Array<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; installed: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }> = []
    const inputSurface = sharedHost ? Object.assign(new EventTarget(), { contains(node: Node | null): boolean {
        if (surface.contains(node)) return true
        const element = node instanceof Element ? node : node?.parentElement
        const pane = element?.closest<HTMLElement>('[data-hapi-host]')
        return pane?.dataset.hapiHost === host.id && pane.dataset.hapiGraph === 'shared' && pane.dataset.hapiVisible === 'true'
    } }) : surface
    const input = createPaneInputRouter({
        surface: inputSurface, visible: () => navigation?.state.getSnapshot().visible !== false && !surface.hidden,
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
    const styleQueries = graphStyleQueries(document, surface)
    const documentFacade = new Proxy(document, {
        get(current, property) {
            if (property === 'body' || property === 'documentElement' || property === 'head') return surface
            if (property === 'querySelector' || property === 'querySelectorAll') return styleQueries[property]
            if (property === 'title') return host.label
            if (property === 'addEventListener') return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => addEvent(document, 'document', type, listener, options)
            if (property === 'removeEventListener') return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => removeEvent(document, 'document', type, listener, options)
            return browserValue(current, property)
        },
        set(_current, property) { return property === 'title' },
    })
    const modulesExport = createGraphModules(documentFacade)
    const openedHistories = new Set<string>()
    const socket = (input: string, protocols?: string | string[]): ConnectionWebSocket => {
        const wrap = (socket: WebSocket): ConnectionWebSocket => {
            const history = withOpeningHistory(socket, openedHistories)
            return initialCatalog ? deferInitialWorkspaceStream(history, initialCatalog, AbortSignal.any([signal, initialLifetime.signal])) : history
        }
        const upstream = new URL(input, baseUrl)
        if (host.id === 'local') {
            upstream.protocol = upstream.protocol === 'https:' || upstream.protocol === 'wss:' ? 'wss:' : 'ws:'
            return wrap(new WebSocket(upstream, protocols))
        }
        const path = upstream.pathname.startsWith(host.basePath) ? `/${upstream.pathname.slice(host.basePath.length)}${upstream.search}` : `${upstream.pathname}${upstream.search}`
        const url = new URL('/hapi-dsh/socket', origin)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('machine', host.id); url.searchParams.set('path', path)
        return wrap(new WebSocket(url, protocols))
    }
    const overrides: Record<PropertyKey, unknown> = {
        ...resources.payload.globals, __ModuleLoader__: target, __DSH_BOOT__: boot, __HAPI_DSH_PANE__: true,
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
    const fetchBundle = async (url: string): Promise<string> => {
        const started = performance.now()
        // Official artifact URLs carry their revision and the Host serves them
        // immutable. Revalidation here redownloads every remote bundle because
        // those responses have no ETag, even on an otherwise cached reload.
        const result = await hostFetch(url)
        if (!result.ok) throw new Error(`${host.label}: plugin artifact returned HTTP ${result.status}`)
        const source = await result.text()
        recordDiagnostic({ source: 'performance', event: 'pane.opening', method: 'host.bundle.loaded',
            durationMs: performance.now() - started, identity: { hostId: host.id }, outcome: 'ready' })
        return source
    }
    const loadBundle = async (url: string): Promise<void> => {
        const key = new URL(url, baseUrl).href
        let bytes = resources.artifacts.get(key)
        if (!bytes) {
            bytes = fetchBundle(url)
            resources.artifacts.set(key, bytes)
            void bytes.catch(() => { if (resources.artifacts.get(key) === bytes) resources.artifacts.delete(key) })
        }
        let execute = resources.compiled.get(key)
        if (execute === undefined) {
            const source = await bytes
            signal.throwIfAborted()
            execute = new Function('window', 'globalThis', 'self', 'fetch', 'location', 'localStorage', 'document', `${source}\n//# sourceURL=${key}`) as (...args: unknown[]) => unknown
            resources.compiled.set(key, execute)
        } else {
            await bytes
            signal.throwIfAborted()
        }
        execute(facade, facade, facade, hostFetch, window.location, localStorageFacade, documentFacade)
    }
    overrides.__DSH_TRANSPORT__ = { fetch: hostFetch, createWebSocket: socket, streamBaseUrl: baseUrl, loadBundle }
    if (prefetchBundles) {
        void prefetchPaneArtifacts({
            // The loader initially requests published phase batches, not row
            // fallbacks. Optional Settings entries join only on demand.
            entries: boot.batches, baseUrl, artifacts: resources.artifacts,
            // Local Hosts can saturate the browser's connections; a paired Host
            // usually crosses the Hub reverse tunnel, where a smaller burst is
            // friendlier and still replaces the loader's serialized arrival chain.
            concurrency: host.id === 'local' ? 12 : 6,
            load: fetchBundle,
        })
    }
    // The official Web seed's store engine closes over primary localStorage.
    // Its unmodified npm source is separately bundled and evaluated against
    // this graph's persistence facade; all plugin consumers get that instance.
    const modules: ClientModuleSystem = target.create({ boot,
        staticModules: { ...resources.staticModules, [GRAPH_STORE_MODULE]: createGraphStore(localStorageFacade) }, loadBundle })
    const ctx = new Context()
    // An explicit pane already has a session. Bind it as soon as the public
    // navigation service activates, before its catalog restoration chooses a
    // workspace blank and potentially resets that unrelated blank's preset.
    const initialNavigation = initialSession ? ctx.inject(['uiWorkspace', 'sessions'], async owner => {
        await waitForCatalogSession(owner.sessions, initialSession, signal)
        owner.uiWorkspace.openSession(initialSession)
        releaseInitialCatalog()
    }) : undefined
    if (navigation) {
        ctx.reflect.provide('hapiWorkspacePane', navigation)
        ctx.reflect.provide('hapiWorkspaceUi', navigation)
    }
    let stopped = false
    let stopDeferred = (): void => {}
    const stop = async (): Promise<void> => {
        if (stopped) return
        stopped = true
        stopDeferred()
        initialLifetime.abort(); releaseInitialCatalog()
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
        await initialNavigation
        await ctx.loader.await()
        signal.throwIfAborted()
        for (const entry of ctx.loader.entries()) {
            const error = modules.importError(entry.options.name)
            if (error) throw new Error(`${host.label}: ${entry.options.name}: ${error.message}`)
        }
        if (!ctx.get('sessions') || !ctx.get('uiWorkspace') || !ctx.get('uiRenderer')) throw new Error(`${host.label}: official DSH Client services did not activate`)
        if (sharedHost) stopDeferred = installDeferredPlugins(ctx, {
            signal,
            async loadGraph(requestSignal) {
                const response = await hostFetch('hapi-dsh/bootstrap', { cache: 'no-store', signal: requestSignal })
                if (!response.ok) throw new Error(`${host.label}: plugin graph HTTP ${response.status}`)
                const payload = bootstrapSchema.parse(await response.json())
                resources.payload = payload
                return payload.graph as WebBootGraph
            },
            preload: graph => prefetchPaneArtifacts({ entries: graph.batches, baseUrl,
                artifacts: resources.artifacts, concurrency: 6, load: fetchBundle }),
        })
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
async function bootHost(root: Context, workspace: WorkspaceController, host: FederationHost, signal: AbortSignal, sharedUi: ReturnType<typeof createWorkspaceUiBridge>, shared = false): Promise<HostRuntime> {
    const timing = new HostOpeningTiming(host.id)
    // A local shared view uses the already activated primary graph. Fetch the
    // bootstrap only when a compatibility plugin-view graph actually needs it.
    let resourcesPromise: Promise<HostResources> | undefined
    const resourcesForHost = (): Promise<HostResources> => resourcesPromise ??= loadHostResources(root, host, signal)
    const catalogSurface = document.createElement('div')
    catalogSurface.hidden = true; catalogSurface.dataset.hapiCatalogHost = host.id
    document.body.append(catalogSurface)
    let catalog: GraphRuntime | undefined
    let sessionViews: ReturnType<typeof installSessionViewHost> | undefined
    let hostRenderer: ReturnType<typeof createRoot> | undefined
    let renderHostRoot: (() => void) | undefined
    let warmup: ReturnType<typeof createSessionWarmup> | undefined
    let unwarmup: (() => void) | undefined
    let warmFrame: number | undefined
    let warmTimer: ReturnType<typeof setTimeout> | undefined
    let warming = false
    let hostUiScope: ReturnType<Context['inject']> | undefined
    let unprovideHostUi: (() => void) | undefined
    let unhostChrome: (() => void) | undefined
    let uninitialCatalog = (): void => {}
    let removeHost: (() => void) | undefined
    // Pane roots outlive their position in the workspace React tree. Moving a
    // pane, hiding a window, or visiting a primary Host plugin page must preserve
    // its editor, dialogs, Client Context, and SessionReference. The layout owns
    // these roots; component unmount only parks their DOM.
    type Resource = Exclude<PaneResource, { kind: 'empty' }>
    interface PaneRuntime {
        sourceId: string; resource: Resource; shared?: boolean; surface: HTMLDivElement
        update(resource: Resource, options: WorkspaceRenderOptions): void
        activate(): void; park?(): boolean; stop(force?: boolean): Promise<void>
        suspend?(): void; isSuspended?(): boolean; ready?(): boolean
        previous?: PaneRuntime | undefined
        cancelHandoff?: (() => void) | undefined
        restoreFocus?: boolean | undefined
    }
    const activePanes = new Map<string, PaneRuntime>()
    const allPanes = new Set<PaneRuntime>()
    const recentViews = new RecentViews<PaneRuntime>(2, entry => { void entry.stop().catch(workspace.report) })
    const clearHandoff = (entry: PaneRuntime): void => {
        entry.cancelHandoff?.(); entry.cancelHandoff = undefined
        if (entry.previous) { void entry.previous.stop().catch(workspace.report); entry.previous = undefined }
        if (entry.surface.dataset.hapiHandoff === 'preparing') revealGenerationSurface(entry.surface)
    }
    const parkPane = (paneId: string, entry: PaneRuntime): void => {
        clearHandoff(entry)
        if (entry.park?.()) recentViews.park(paneId, entry.sourceId, entry)
        else void entry.stop().catch(workspace.report)
    }
    const parking = document.createElement('div')
    parking.hidden = true; parking.dataset.hapiParkedHost = host.id
    document.body.append(parking)
    let unsubscribeLayout: (() => void) | undefined
    let sharedViewSequence = 0
    const focusConversation = (resourceId: string, target?: Parameters<WorkspacePaneNavigation['locate']>[0]): string => {
        const existing = workspace.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane =>
            pane.resource.kind !== 'empty' && pane.resource.sessionId === resourceId
            && (pane.resource.kind === 'chat' || pane.resource.kind === 'view' && pane.resource.target.type === 'conversation'))
        if (existing) workspace.store.focus(existing.id)
        else workspace.openSession(resourceId, 'horizontal')
        const paneId = workspace.store.focusedPane().id
        if (target) workspace.locateInPane(paneId, resourceId, target)
        return paneId
    }
    const recentlyViewed: SessionId[] = []
    const sharedConversation = (resource: Resource): boolean => shared && (resource.kind === 'chat' || resource.kind === 'view' && resource.target.type === 'conversation')
    const warmRecent = (): void => {
        if (!warming || !warmup) return
        const context = catalog?.ctx ?? root
        const rows = Object.values(context.sessions.list.getSnapshot().byId)
        const archived = new Set(context.workspaces.list.getSnapshot().archivedSessionIds)
        const eligible = rows.filter(row => !archived.has(row.id))
        const ids = new Set(eligible.map(row => row.id))
        // Keep the warm lease while a pane is visible. Otherwise closing its
        // final view retires the official binding before the catalog can notify
        // warmup, turning a return visit into another cold session open.
        // Catalog notifications maintain deliberate visits only. Adding the
        // five newest rows here fights hover eviction and opens unrelated logs.
        warmup.update(recentlyViewed.filter(id => ids.has(id)))
    }
    const warmSession = (id: SessionId): void => {
        if (!warmup || signal.aborted) return
        const context = catalog?.ctx ?? root
        if (!context.sessions.list.getSnapshot().byId[id] || context.workspaces.list.getSnapshot().archivedSessionIds.includes(id)) return
        const previous = recentlyViewed.indexOf(id)
        if (previous !== -1) recentlyViewed.splice(previous, 1)
        recentlyViewed.unshift(id); recentlyViewed.length = Math.min(recentlyViewed.length, 5)
        // Deliberate hover/focus warms the requested sessions only. Do not
        // attach five unrelated histories while a foreground pane is opening.
        warmup.update(recentlyViewed)
    }
    const cancelWarmStart = (): void => {
        if (warmFrame !== undefined) cancelAnimationFrame(warmFrame)
        if (warmTimer !== undefined) clearTimeout(warmTimer)
    }
    const scheduleWarmStart = (): void => {
        cancelWarmStart()
        warmFrame = requestAnimationFrame(() => {
            warmFrame = requestAnimationFrame(() => {
                warmFrame = undefined
                warmTimer = setTimeout(() => {
                    warmTimer = undefined
                    if (!signal.aborted) { warming = true; warmRecent() }
                }, 0)
            })
        })
    }
    const createSessionPane = (paneId: string, sourceId: string, resource: Resource, initial: WorkspaceRenderOptions): PaneRuntime => {
        const context = catalog?.ctx ?? root
        const surface = document.createElement('div')
        surface.className = 'hapi-remote-pane hapi-shared-pane'
        surface.dataset.hapiHost = host.id; surface.dataset.hapiPaneInstance = paneId
        surface.dataset.hapiGraph = 'shared'
        Object.assign(surface.style, { display: 'flex', flexDirection: 'column', minHeight: '0', height: '100%', width: '100%', overflow: 'hidden' })
        parking.append(surface)
        const ui = sharedUi.createScope()
        const resourceId = sessionResourceId(host.id, sourceId)
        const lifetime = new AbortController()
        const activeSignal = AbortSignal.any([signal, lifetime.signal])
        let presentation = { focused: initial.focused, visible: initial.visible !== false }
        const listeners = new Set<() => void>()
        let reference: SessionReference | undefined
        let view: SessionViewHandle | undefined
        let opening: ReturnType<typeof observePaneOpening> | undefined
        let starting = false, disposed = false, retired = false, suspended = false
        let referenceReady = false
        let historyTimer: ReturnType<typeof setTimeout> | undefined
        const historySubscriptions: Array<() => void> = []
        const scheduleHistoryRelease = (): void => {
            if (historyTimer !== undefined || presentation.visible || disposed || retired || !reference) return
            historyTimer = setTimeout(() => {
                historyTimer = undefined
                if (!reference || disposed || retired || !view || ui.voice.getSnapshot()
                    || !surface.querySelector('[data-chat-following-tail]')) return
                const binding = reference.binding, session = binding.session.getSnapshot()
                const input = context.conversation.input.for(binding.ctx).state.getSnapshot()
                const source = (binding.session.projections.faceOf('hapi').getSnapshot() as HapiProjection)
                    ?? (binding.session.projections.faceOf('hapiObserved').getSnapshot() as HapiObservedProjection)
                const questions = binding.session.projections.faceOf('userQuestions').getSnapshot() as UserQuestionProjectionView | undefined
                if (!canReleaseHistory({ visible: presentation.visible, events: binding.eventSource.getSnapshot().entries.length,
                    running: session.running, pending: session.pendingSubmissions.length + (source?.pendingRequests.length ?? 0),
                    draft: input.draft, attachments: input.attachmentIds.length, phase: input.phase, questions: questions?.active.length ?? 0 })) return
                if (workspace.releaseHiddenHistory(paneId, reference)) {
                    activePanes.delete(paneId)
                    void result.stop().catch(workspace.report)
                }
            }, 1_000)
        }
        const navigationAllowed = (): boolean => !disposed && !retired && workspace.store.getSnapshot().windows
            .flatMap(window => panes(window.root)).some(pane => pane.id === paneId && pane.resource.kind !== 'empty' && pane.resource.sessionId === resourceId)
        const navigation: WorkspacePaneNavigation = {
            ...ui, paneId, hostId: host.id,
            state: { getSnapshot: () => presentation, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } },
            catalog: { getSnapshot: () => workspace.getSnapshot().catalog.byId[resourceId], subscribe: workspace.subscribe },
            reading: { getSnapshot: () => {
                const intent = workspace.readingIntent(paneId)
                return intent?.sessionId === resourceId ? intent : undefined
            }, subscribe: workspace.subscribe },
            locate: target => { if (navigationAllowed()) workspace.locateInPane(paneId, resourceId, target) },
            registerCloseGuard: guard => workspace.registerPaneCloseGuard(paneId, guard),
            retainForDraftTransfer: () => retention.retain(),
            focusConversation: target => { if (!navigationAllowed()) throw new Error('The original pane was replaced'); return focusConversation(resourceId, target) },
            openSuccessor: async id => { if (!navigationAllowed()) throw new Error('The original pane was replaced'); await workspace.openSuccessorSession(resourceId, sessionResourceId(host.id, id), paneId) },
            openSession: (id, options) => { if (!navigationAllowed()) return; workspace.store.focus(paneId); workspace.openSession(sessionResourceId(host.id, id), options?.beside, options?.target) },
            revealConversation: () => { if (!navigationAllowed()) return; workspace.store.focus(paneId); workspace.updateView(paneId, { type: 'conversation' }, workspace.getSnapshot().catalog.byId[resourceId]?.displayTitle ?? 'Conversation') },
            openResource: (address, options = {}) => { if (navigationAllowed()) workspace.openResource(address, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }) },
            openTab: (kind, options = {}) => { if (navigationAllowed()) workspace.openTab(kind, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }) },
            openPanel: (panelId, options = {}) => { if (navigationAllowed()) workspace.openPanel(panelId, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }) },
            openView: (target, options = {}) => { if (navigationAllowed()) workspace.openView(target, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }) },
        }
        // Primary graph shortcuts already receive DOM events once. Only a
        // remote Host needs its facade's captured listeners dispatched here.
        const capture = (event: KeyboardEvent): void => { catalog?.dispatch(event, true) }
        const bubble = (event: KeyboardEvent): void => { catalog?.dispatch(event, false) }
        // Portal events bubble through shell.overlay's React tree, not through
        // WorkspacePane. Native ownership follows the actual DOM occurrence.
        const focus = (): void => { if (!disposed && !retired && presentation.visible) workspace.store.focus(paneId) }
        surface.addEventListener('keydown', capture, true); surface.addEventListener('keydown', bubble)
        surface.addEventListener('pointerdown', focus, true); surface.addEventListener('focusin', focus, true)
        const activate = (): void => {
            if (disposed || retired || starting || view) return
            starting = true; delete surface.dataset.hapiPaneDeferred; surface.dataset.hapiPaneBooting = 'true'
            opening = observePaneOpening(surface, { hostId: host.id, sessionId: sourceId },
                context.sessions.binding(sourceId as SessionId)?.session.getSnapshot().openState === 'open')
            void (async () => {
                try {
                    await waitForCatalogSession(context.sessions, sourceId as SessionId, activeSignal)
                    if (disposed || retired || activeSignal.aborted) return
                    reference = context.sessions.retain(sourceId as SessionId, { source: 'hapiWorkspace' })
                    historySubscriptions.push(reference.binding.eventSource.subscribe(scheduleHistoryRelease), reference.binding.session.subscribe(scheduleHistoryRelease))
                    void reference.ready.then(binding => { referenceReady = true; opening?.referenceReady(binding.session.getSnapshot().blank) }, () => opening?.stop('error'))
                    renderHostRoot?.()
                    view = sessionViews!.mount({ paneId, instanceId: `${paneId}:${++sharedViewSequence}`, reference, target: surface, navigation,
                        onReady: () => {
                            delete surface.dataset.hapiPaneBooting; surface.dataset.hapiPaneBooted = 'true'
                            const id = sourceId as SessionId, previous = recentlyViewed.indexOf(id)
                            if (previous !== -1) recentlyViewed.splice(previous, 1)
                            recentlyViewed.unshift(id); recentlyViewed.length = Math.min(recentlyViewed.length, 5)
                            // Retain the current session immediately; unrelated
                            // history preparation waits until after its paint.
                            warmup?.update(recentlyViewed)
                            scheduleWarmStart()
                        },
                        onError: error => { opening?.stop('error'); if (!disposed && !activeSignal.aborted) workspace.report(error) },
                    })
                } catch (error) {
                    opening?.stop('error')
                    if (!disposed && !activeSignal.aborted) { surface.textContent = errorMessage(error); surface.setAttribute('role', 'alert'); workspace.report(error) }
                } finally { starting = false }
            })()
        }
        const update = (resource: Resource, options: WorkspaceRenderOptions): void => {
            if (retired || disposed) return
            if (resource.sessionId === resourceId) result.resource = resource
            const next = { focused: options.focused && !suspended && surface.dataset.hapiHandoff !== 'preparing', visible: options.visible !== false }
            if (!next.visible) opening?.stop('hidden')
            surface.dataset.hapiFocused = String(next.focused); surface.dataset.hapiVisible = String(next.visible)
            if (presentation.focused !== next.focused || presentation.visible !== next.visible) {
                presentation = next; for (const listener of listeners) listener()
            }
            surface.hidden = !next.visible
            if (next.visible) activate()
            else if (!view) surface.dataset.hapiPaneDeferred = 'true'
            if (!next.visible) scheduleHistoryRelease()
        }
        const retention = createPaneRetention(() => {
            clearHandoff(result)
            opening?.stop()
            retired = true; presentation = { focused: false, visible: false }
            for (const listener of listeners) listener()
            surface.hidden = true; parking.append(surface)
            void ui.stopOwnedVoice().catch(workspace.report)
        }, async () => {
            if (disposed) return
            disposed = true; lifetime.abort()
            clearTimeout(historyTimer); for (const stop of historySubscriptions) stop()
            surface.removeEventListener('keydown', capture, true); surface.removeEventListener('keydown', bubble)
            surface.removeEventListener('pointerdown', focus, true); surface.removeEventListener('focusin', focus, true)
            try {
                await view?.dispose(); view = undefined
                reference?.release(); reference = undefined
                await ui.dispose()
            } finally { listeners.clear(); surface.remove(); allPanes.delete(result) }
        })
        const result: PaneRuntime = { sourceId, resource, shared: true, surface, activate, update, stop: retention.stop,
            isSuspended: () => suspended,
            suspend: () => {
                if (suspended) return
                const active = surface.ownerDocument.activeElement
                result.restoreFocus = Boolean(active && surface.contains(active) && active.closest('[data-composer-input]'))
                view?.suspendReading(); suspended = true; surface.inert = true
                surface.dataset.hapiHandoff = 'previous'
                presentation = { ...presentation, focused: false }; for (const listener of listeners) listener()
            },
            ready: () => {
                const session = reference?.binding.session.getSnapshot()
                const editor = surface.querySelector<HTMLElement>('[data-composer-input]')
                const content = surface.querySelector<HTMLElement>('[data-chat-node-key]')
                return replacementReady({ referenceReady, open: session?.openState === 'open', blank: session?.blank === true,
                    editor: Boolean(editor && editor.getBoundingClientRect().height > 0),
                    content: Boolean(content && content.getBoundingClientRect().height > 0), reading: surface.dataset.hapiReading })
            },
            park: () => {
                // Bound retained histories as well as view count. No hidden
                // cold open or source execution is initiated by this cache.
                if (!view || !reference || disposed || retired || suspended || reference.binding.eventSource.getSnapshot().entries.length > 1500) return false
                update({ kind: 'chat', sessionId: resourceId }, { ...initial, focused: false, visible: false })
                parking.append(surface)
                void ui.stopOwnedVoice().catch(workspace.report)
                return true
            } }
        allPanes.add(result)
        update(resource, initial)
        return result
    }
    const createPane = (paneId: string, sourceId: string, resource: Resource, initial: WorkspaceRenderOptions): PaneRuntime => {
        const surface = document.createElement('div')
        surface.className = 'hapi-remote-pane'
        surface.dataset.hapiHost = host.id; surface.dataset.hapiPaneInstance = paneId
        // A pane in a parked/retained window renders its surface but must not
        // fetch bundles or evaluate an official graph until its window is shown.
        if (initial.visible === false) surface.dataset.hapiPaneDeferred = 'true'
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
        let uninitialHistory: (() => void) | undefined
        let unsubscribe: (() => void) | undefined
        let unshortcut: (() => void) | undefined
        let voiceScope: ReturnType<Context['inject']> | undefined
        let nativeDispose: (() => Promise<void>) | undefined
        let chromeDispose: (() => void) | undefined
        let entryNavigationDispose: (() => Promise<void>) | undefined
        let generation = 0
        /** At most one boot attempt; success is a one-way latch, failure reopens it. */
        const boot = createPaneBootGate()
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
        const navigationAllowed = (): boolean => !disposed && !retired && workspace.store.getSnapshot().windows
            .flatMap(window => panes(window.root)).some(pane => pane.id === paneId && pane.resource.kind !== 'empty' && pane.resource.sessionId === resourceId)
        const navigation: WorkspacePaneNavigation = {
            paneId, hostId: host.id, preferences: ui.preferences, voice: ui.voice, sourceSummaries: ui.sourceSummaries,
            shareInbox: ui.shareInbox, handoffs: ui.handoffs, sourceScheduleDrafts: ui.sourceScheduleDrafts, sourceFileMutations: ui.sourceFileMutations, updates: ui.updates,
            readLegacyScratchlist: ui.readLegacyScratchlist,
            registerCloseGuard: guard => workspace.registerPaneCloseGuard(paneId, guard),
            retainForDraftTransfer: () => retention.retain(),
            focusConversation: target => { if (!navigationAllowed()) throw new Error('The original pane was replaced'); return focusConversation(resourceId, target) },
            openSession: (id, options) => { if (!navigationAllowed()) return; workspace.store.focus(paneId); workspace.openSession(sessionResourceId(host.id, id), options?.beside, options?.target) },
            openSuccessor: async displaySessionId => { if (!navigationAllowed()) throw new Error('The original pane was replaced'); await workspace.openSuccessorSession(resourceId, sessionResourceId(host.id, displaySessionId), paneId) },
            state: { getSnapshot: () => presentation, subscribe(listener) { presentationListeners.add(listener); return () => { presentationListeners.delete(listener) } } },
            catalog: { getSnapshot: () => workspace.getSnapshot().catalog.byId[resourceId], subscribe: workspace.subscribe },
            reading: { getSnapshot: () => {
                const intent = workspace.readingIntent(paneId)
                return intent?.sessionId === resourceId ? intent : undefined
            }, subscribe: workspace.subscribe },
            locate: target => { if (navigationAllowed()) workspace.locateInPane(paneId, resourceId, target) },
            revealConversation: () => {
                if (!navigationAllowed()) return
                workspace.store.focus(paneId)
                workspace.updateView(paneId, { type: 'conversation' }, workspace.getSnapshot().catalog.byId[resourceId]?.displayTitle ?? 'Conversation')
                runtime?.ctx.layout.selectPanel(null)
                if (runtime?.ctx.sidebarRight.isExpanded()) runtime.ctx.sidebarRight.toggleExpanded()
            },
            openResource: (address, options = {}) => { if (navigationAllowed()) workspace.openResource(address, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }) },
            openTab: (kind, options = {}) => { if (navigationAllowed()) workspace.openTab(kind, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }) },
            openPanel: (panelId, options = {}) => { if (navigationAllowed()) workspace.openPanel(panelId, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }) },
            openView: (target, options = {}) => { if (navigationAllowed()) workspace.openView(target, { ...options, sessionId: resourceId, beside: options.beside ?? 'horizontal' }) },
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
            uninitialHistory?.(); uninitialHistory = undefined
            // Unmount the rendered pane first: its React tree stops issuing
            // calls before the Context contributions and the graph go away.
            pane?.dispose(); pane = undefined
            try { await nativeDispose?.() } catch (error) { workspace.report(error) }
            nativeDispose = undefined
            chromeDispose?.(); chromeDispose = undefined
            await entryNavigationDispose?.(); entryNavigationDispose = undefined
            await voiceScope?.dispose(); voiceScope = undefined
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
                renderer.render(<div className="hapi-empty" role="alert"><p>{errorMessage(reason)}</p><button type="button" onClick={() => { if (boot.begin()) { surface.dataset.hapiPaneBooting = 'true'; void start() } }}>Retry</button></div>)
            }
            try {
                const resources = await resourcesForHost()
                // Refresh the cached Host snapshot first: the rows a pane boots come
                // from it, so a pane opened after a Host graph revision must not boot
                // the stale revision fetched when the page started.
                await refreshBootstrap(host, resources, activeSignal)
                if (disposed || currentGeneration !== generation || activeSignal.aborted) return
                // A pane boots the Host's chat-surface subset: chrome-only rows and
                // this plugin's own bundle are excluded, and the shared plugin-event
                // stream is projected onto the same subset (graph syncs rewritten,
                // rebuilds of excluded rows dropped).
                const graph = await bootGraph(root, host, resources, PANE_GRAPH_POLICY.transform(resources.payload.graph as WebBootGraph), surface, paneId, activeSignal, navigation, true, true, true, false, sourceId as SessionId)
                if (disposed || currentGeneration !== generation || activeSignal.aborted) { await graph.stop(); return }
                runtime = graph
                // Window-level chrome is owned once by the primary graph. Empty
                // shadows remove the official sidebar and leading seats from the pane.
                chromeDispose = installPaneChrome(graph.ctx)
                if (shared) {
                    const navigationOwner = catalog?.ctx ?? root
                    const disposeEntryNavigation = await installEntrySessionNavigation(graph.ctx, {
                        startSession: (workspaceId, options) => {
                            if (!navigationAllowed()) return
                            workspace.store.focus(paneId)
                            navigationOwner.uiWorkspace.startSession(workspaceId, options)
                        },
                    })
                    if (disposed || currentGeneration !== generation || activeSignal.aborted) { await disposeEntryNavigation(); return }
                    entryNavigationDispose = disposeEntryNavigation
                }
                // The pane graph excludes this plugin's own client bundle: the root
                // graph installs the pane-only HAPI surfaces on this Context, so the
                // ~4 MB bundle is evaluated once per page, not once per pane. The
                // installer is generation-checked: a pane closed during the awaited
                // install disposes it immediately instead of leaking it.
                if (host.id === 'local' && !graph.ctx.get('hapiPaneNative')) {
                    const disposeNative = await mountPaneNative(graph.ctx)
                    if (disposed || currentGeneration !== generation || activeSignal.aborted) { await disposeNative(); return }
                    nativeDispose = disposeNative
                }
                // Every official hook and SessionProvider is bound to this
                // graph's own reference, never the Host catalog reference.
                // Activation only starts the catalog poll. Its first response
                // can still be in flight even when the Host's separate catalog
                // graph already lists this session.
                await waitForCatalogSession(graph.ctx.sessions, sourceId as SessionId, activeSignal)
                if (disposed || currentGeneration !== generation || activeSignal.aborted) return
                reference = graph.ctx.sessions.retain(sourceId as SessionId, { source: 'hapiWorkspace' })
                if (resource.kind === 'chat' || resource.kind === 'view' && resource.target.type === 'conversation') {
                    uninitialHistory = bindInitialHistory(surface, reference, navigation)
                }
                void reference.ready.catch(fail)
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
                boot.succeed()
                delete surface.dataset.hapiPaneBooting
                surface.dataset.hapiPaneBooted = 'true'
            } catch (reason) {
                fail(reason)
            } finally {
                // A failed or superseded attempt must not latch the pane shut: a
                // later visibility flip (or the Retry button) may try again. Only
                // the successful path keeps the booted phase and marker.
                if (currentGeneration === generation && boot.phase() !== 'booted') {
                    boot.fail()
                    delete surface.dataset.hapiPaneBooting
                }
            }
        }
        /**
         * Start the official graph at most once per successful boot. The attempt
         * is tracked separately from success so a failure leaves the pane
         * retryable; later visibility flips never unload a booted graph.
         */
        const activate = (): void => {
            if (disposed || retired || !boot.begin()) return
            delete surface.dataset.hapiPaneDeferred
            surface.dataset.hapiPaneBooting = 'true'
            void start()
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
        const result: PaneRuntime = { sourceId, resource, surface, activate, update(resource, options) {
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
            // A parked window becoming active starts its panes; a booted pane is
            // never unloaded, so this is a one-way transition.
            if (shouldBootPane(options, boot.phase() === 'booted')) activate()
            draw()
        }, stop: retention.stop }
        allPanes.add(result)
        if (shouldBootPane(initial, false)) activate()
        return result
    }
    const resourceForPane = (paneId: string): Resource | undefined => {
        const resource = workspace.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.id === paneId)?.resource
        return resource?.kind === 'empty' ? undefined : resource
    }
    const getPane = (paneId: string, sourceId: string, resource: Resource, options: WorkspaceRenderOptions): PaneRuntime => {
        const current = activePanes.get(paneId)
        if (current?.sourceId === sourceId && Boolean(current.shared) === sharedConversation(resource)) {
            if (!canReuseGenerationSurface(sessionResourceId(host.id, current.sourceId), resource.sessionId, current.isSuspended?.() === true)) {
                activePanes.delete(paneId); clearHandoff(current)
                void current.stop().catch(workspace.report)
                return getPane(paneId, sourceId, resource, options)
            }
            if (sameSourceGeneration(current.resource, resource)) current.suspend?.()
            current.update(resource, options); return current
        }
        const predecessor = current?.previous ?? current
        const replace = Boolean(predecessor?.shared && sharedConversation(resource)
            && sameSourceGeneration(predecessor.resource, resource) && options.visible !== false)
        if (current) {
            if (replace) {
                current.cancelHandoff?.(); current.cancelHandoff = undefined; current.previous = undefined
                if (current !== predecessor) void current.stop().catch(workspace.report)
                predecessor!.suspend?.()
            } else parkPane(paneId, current)
        }
        const cached = sharedConversation(resource) ? recentViews.take(paneId, sourceId) : undefined
        const next = cached ?? (sharedConversation(resource) ? createSessionPane(paneId, sourceId, resource, options) : createPane(paneId, sourceId, resource, options))
        if (cached) cached.update(resource, options)
        if (replace) next.previous = predecessor
        activePanes.set(paneId, next)
        return next
    }
    const reconcilePanes = (): void => {
        const desired = new Map<string, Resource>()
        for (const window of workspace.store.getSnapshot().windows) for (const pane of panes(window.root)) {
            if (pane.resource.kind === 'empty') continue
            try {
                const source = parseSessionResourceId(pane.resource.sessionId)
                if (source.hostId === host.id) desired.set(pane.id, pane.resource)
            } catch { /* The controller presents malformed saved addresses. */ }
        }
        recentViews.prune(new Set(desired.keys()))
        for (const [paneId, entry] of activePanes) if (desired.get(paneId)?.sessionId !== sessionResourceId(host.id, entry.sourceId)) {
            if (entry.shared && sameSourceGeneration(entry.resource, desired.get(paneId))) { entry.suspend?.(); continue }
            activePanes.delete(paneId)
            if (desired.has(paneId)) parkPane(paneId, entry)
            else { clearHandoff(entry); void entry.stop() }
        }
    }
    try {
        if (host.id !== 'local') {
            const resources = await resourcesForHost()
            timing.mark('resources')
            if (shared) { catalogSurface.hidden = false; catalogSurface.style.display = 'contents'; catalogSurface.dataset.hapiSharedHost = host.id }
            const graph = resources.payload.graph as WebBootGraph
            catalog = await bootGraph(root, host, resources, shared ? workspaceBootGraph(graph) : graph, catalogSurface, shared ? 'shared' : 'catalog', signal, undefined, true, false, true, shared)
            timing.mark('graph')
        }
        if (shared) {
            const context = catalog?.ctx ?? root
            sessionViews = installSessionViewHost(context)
            warmup = createSessionWarmup(context.sessions, { prepare: reference => { context.uiConversation.binding(reference.binding) } })
            unwarmup = context.sessions.list.subscribe(warmRecent)
            // No speculative histories at Host startup. Each online Host used
            // to open five, competing with the selected pane on cold reload.
            if (catalog) {
                unprovideHostUi = context.reflect.provide('hapiWorkspaceUi', sharedUi.root)
                const unchrome = installPaneChrome(context)
                // AppFrame installs the public scope once, but its implicit
                // current-session composer must not duplicate a portal editor.
                const unmain = context.slots.inject('main', () => context.slots.register({ name: 'main', key: 'conversation', priority: -100 }, () => null))
                unhostChrome = () => { unmain(); unchrome() }
                hostUiScope = context.inject(['slots', 'locale', 'sessions', 'uiSession', 'uiConversation', 'conversation', 'sidebarRight', 'hapiWorkspaceUi'], owner => {
                    const disposers = [installSourceVoice(owner, root.remote.hapi), installTurnSharing(owner), installShareReceiver(owner), installSourceAppearance(owner), installSourceTerminalActions(owner, root.remote.hapi)]
                    return () => { for (const dispose of disposers.reverse()) dispose() }
                })
                await hostUiScope
                timing.mark('ui')
                renderHostRoot = () => {
                    if (hostRenderer) return
                    const mount = document.createElement('div'); mount.hidden = true; catalogSurface.append(mount)
                    hostRenderer = createRoot(mount)
                    hostRenderer.render(context.slots.renderSlot('root', {}))
                }
            }
        }
        function RemoteSession({ sourceId, resource, options }: { sourceId: string; resource: Resource; options: WorkspaceRenderOptions }) {
            const mount = useRef<HTMLDivElement>(null)
            const latestOptions = useRef(options); latestOptions.current = options
            const paneId = options.paneId
            const sharedView = sharedConversation(resource)
            useLayoutEffect(() => {
                const target = mount.current!
                const view = getPane(paneId, sourceId, resource, options)
                target.append(view.surface)
                if (view.previous) {
                    view.cancelHandoff?.(); view.cancelHandoff = undefined
                    const previous = view.previous
                    target.append(previous.surface)
                    const commit = (): void => {
                        if (activePanes.get(paneId) !== view || resourceForPane(paneId)?.sessionId !== sessionResourceId(host.id, view.sourceId)) return
                        const focus = previous.restoreFocus && workspace.store.focusedPane().id === paneId
                            && (!document.activeElement || document.activeElement === document.body || previous.surface.contains(document.activeElement))
                        clearHandoff(view)
                        revealGenerationSurface(view.surface)
                        view.update(resource, latestOptions.current)
                        if (focus && latestOptions.current.visible !== false) view.surface.querySelector<HTMLElement>('[data-composer-input]')?.focus({ preventScroll: true })
                    }
                    view.cancelHandoff = stageGenerationSurface({ previous: previous.surface, next: view.surface,
                        ready: () => view.ready?.() === true, commit, timeout: commit })
                    view.update(resource, options)
                }
                return () => {
                    const after = resourceForPane(paneId)
                    if (view.shared && sameSourceGeneration(view.resource, after) && target.isConnected) {
                        view.suspend?.()
                        // A prop replacement reuses this mount. A real unmount
                        // must still release its staged predecessor and park.
                        queueMicrotask(() => {
                            if (target.isConnected) return
                            clearHandoff(view)
                            if (activePanes.get(paneId) === view) activePanes.delete(paneId)
                            void view.stop().catch(workspace.report)
                        })
                        return
                    }
                    clearHandoff(view)
                    view.update(resource, { ...options, visible: false, focused: false })
                    if (view.surface.parentElement === target) parking.append(view.surface)
                }
            }, [sourceId, resource.sessionId, paneId, sharedView])
            useLayoutEffect(() => { activePanes.get(paneId)?.update(resource, options) }, [paneId, resource, options.focused, options.visible, options.toolsTarget])
            return <div ref={mount} className="hapi-remote-mount" style={{ position: 'relative', minHeight: 0, height: '100%', width: '100%' }}/>
        }
        const renderPane: NonNullable<import('./controller.ts').WorkspaceHost['renderPane']> = (reference, resource, options) => <RemoteSession sourceId={reference.sessionId} resource={resource} options={options}/>
        removeHost = host.id === 'local' ? workspace.bindRenderer('local', renderPane, shared ? warmSession : undefined) : workspace.addHost({
            id: host.id, label: host.label, sessions: catalog!.ctx.sessions, navigation: catalog!.ctx.uiWorkspace, workspaces: catalog!.ctx.workspaces, workspaceState: catalog!.ctx.workspaces.list,
            renderPane, renderConversation: (reference, options) => <RemoteSession sourceId={reference.sessionId} resource={{ kind: 'chat', sessionId: sessionResourceId(host.id, reference.sessionId) }} options={options ?? { paneId: reference.sessionId, focused: true }}/>,
            ...(shared ? { warmSession } : {}),
        })
        unsubscribeLayout = workspace.store.subscribe(reconcilePanes)
        // The official connection generation owns the initial list pull. A
        // refresh here races handleConnected(), which discards that in-flight
        // pull and starts another full catalog scan on large remote Hosts.
        const list = (catalog?.ctx ?? root).sessions.list
        const catalogReady = (): void => {
            if (list.getSnapshot().phase !== 'ready') return
            timing.mark('catalog'); uninitialCatalog()
        }
        uninitialCatalog = list.subscribe(catalogReady)
        catalogReady()
        let stopped = false
        return { async stop() {
            if (stopped) return
            stopped = true; unsubscribeLayout?.(); uninitialCatalog(); removeHost?.()
            await Promise.allSettled([...allPanes].map(graph => graph.stop(true)))
            activePanes.clear()
            cancelWarmStart(); unwarmup?.(); warmup?.dispose(); sessionViews?.dispose(); hostRenderer?.unmount(); await hostUiScope?.dispose(); unhostChrome?.(); unprovideHostUi?.()
            await catalog?.stop(); catalogSurface.remove(); parking.remove()
        } }
    } catch (error) {
        timing.mark('failed')
        unsubscribeLayout?.(); uninitialCatalog(); removeHost?.()
        await Promise.allSettled([...allPanes].map(graph => graph.stop(true)))
        cancelWarmStart(); unwarmup?.(); warmup?.dispose(); sessionViews?.dispose(); hostRenderer?.unmount(); await hostUiScope?.dispose(); unhostChrome?.(); unprovideHostUi?.()
        await catalog?.stop(); catalogSurface.remove(); parking.remove(); throw error
    }
}

/** Reconcile paired Hosts and native display revisions in the single workspace. */
export function installFederation(ctx: Context, workspace: WorkspaceController): () => Promise<void> {
    // Every chat occurrence shares its Host graph. Resource panes retain their official view graph.
    const shared = true
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
    const activity = observeForegroundActivity(document)
    const boots = new HostBootQueue(() => {
        const resource = workspace.store.focusedPane().resource
        return resource.kind === 'empty' ? undefined : parseSessionResourceId(resource.sessionId).hostId
    }, () => {
        const pane = workspace.store.focusedPane()
        if (pane.resource.kind === 'empty') return activity.busy()
        const lease = workspace.getSnapshot().leases.get(pane.id)
        if (lease?.status === 'failed') return activity.busy()
        // Do not evaluate an unrelated Host's complete plugin graph while the
        // selected conversation is binding and painting its initial history.
        const surface = document.querySelector(`[data-hapi-pane-instance="${CSS.escape(pane.id)}"]`)
        const opening = surface?.getAttribute('data-hapi-pane-opening')
        const pending = opening ? opening === 'loading' || opening === 'painting' : !surface?.hasAttribute('data-hapi-pane-booted')
        if (pending) activity.defer()
        return pending || activity.busy()
    })
    const unprioritize = workspace.store.subscribe(boots.prioritize)
    const containShortcuts = (event: KeyboardEvent): void => {
        if (remoteKeyboardEvents.has(event) || event.composedPath().some(node => node instanceof Element && node.matches('[data-hapi-host]:not([data-hapi-graph="shared"])'))) {
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
    void bootHost(ctx, workspace, { id: 'local', label: 'DSH', online: true, basePath: '/' }, AbortSignal.any([lifetime.signal, local.abort.signal]), sharedUi, shared).then(async runtime => {
        if (lifetime.signal.aborted) await runtime.stop()
        else local.runtime = runtime
    }).catch(error => { if (!lifetime.signal.aborted) workspace.report(error) })
    const poll = async (): Promise<void> => {
        if (polling || lifetime.signal.aborted) return
        polling = true
        try {
            const catalog = remoteValue(await ctx.remote.hapi.catalog())
            workspace.setMachines(catalog.machines)
            workspace.setSourceCatalog(catalog.sessions, catalog.hubId, catalog)
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
                boots.add(host.id, async () => {
                if (entry.abort.signal.aborted || lifetime.signal.aborted) return
                await bootHost(ctx, workspace, host, AbortSignal.any([lifetime.signal, entry.abort.signal]), sharedUi, shared).then(async runtime => {
                    if (entry.abort.signal.aborted || lifetime.signal.aborted) { await runtime.stop(); return }
                    entry.runtime = runtime; reported.delete(host.id); workspace.catalogHostReady(host.id, host.label)
                }).catch(error => {
                    if (running.get(host.id) === entry) running.delete(host.id)
                    if (entry.abort.signal.aborted || lifetime.signal.aborted) return
                    const message = errorMessage(error)
                    workspace.catalogHostFailed(host.id, host.label, message)
                    if (reported.get(host.id) !== message) { reported.set(host.id, message); workspace.report(message) }
                })
                })
            }
        } catch (error) { if (!lifetime.signal.aborted) { workspace.sourceCatalogFailed(error); workspace.report(error) } }
        finally { polling = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 3000)
    return async () => {
        lifetime.abort(); clearInterval(timer); unprioritize(); boots.dispose(); activity.dispose()
        unresolveSource()
        document.removeEventListener('keydown', containShortcuts)
        for (const entry of running.values()) entry.abort.abort()
        await Promise.allSettled([...running.values()].map(entry => entry.runtime?.stop()))
        running.clear()
        try { await sharedUi.dispose() } finally { await unprovideUi() }
    }
}
