/** Plugin-owned view references and durable geometry. No agent lifetime ownership. */
import type { ISessions, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReactNode } from 'react'
import { initialWorkspace, panes, parseWorkspaceState, WorkspaceStore, type PaneResource, type SplitAxis, type WorkspaceState } from './model.ts'
import { SidebarState } from '../workspace/sidebar-state.ts'
import { bindSourceResources, importLegacyWorkspace, isSourceChild, keepLocalView, sharedWorkspaceSignature, sharedWorkspaceState, sourceIdentity, sourceRow } from '../workspace/legacy.ts'
import type { CatalogMachine, CatalogSession } from '../client-api.ts'
import { parseDshPaneTarget, type DshPaneTarget, type NavigationValue } from '../workspace/dsh-view.ts'
import type { DockPosition } from '../workspace/drag.ts'
import { buildSidebarSearchIndex, compareSidebarSearch, type SidebarSearchIndex } from '../workspace/sidebar-search.ts'
import { CatalogDiscovery, type WorkspaceCatalogDiscovery } from '../workspace/catalog-discovery.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
    interface SessionReferenceSourceMap { hapiWorkspace: unknown }
}

export interface WorkspacePersistence {
    /** Optional Hub-backed geometry store. Only validated layout documents cross this boundary. */
    load(signal: AbortSignal): Promise<unknown | null>
    save(state: WorkspaceState, signal: AbortSignal): Promise<void>
}

export interface WorkspaceOptions {
    sessions: Pick<ISessions, 'list' | 'retain' | 'refresh' | 'using' | 'search' | 'create'>
    navigation: Pick<UiWorkspace, 'openSession' | 'startSession' | 'archiveSession' | 'unarchiveSession' | 'pinSession' | 'unpinSession' | 'forkSession'>
        & Partial<Pick<UiWorkspace, 'listDirectory' | 'pickDirectory' | 'createDirectory'>>
    storage?: Pick<Storage, 'getItem' | 'setItem'>
    storageKey: string
    persistence?: WorkspacePersistence
    nextId?: () => string
    /** Reveal the official conversation panel when an empty window becomes active. */
    reveal?: () => void
    workspaceState?: WorkspaceHost['workspaceState']
    workspaces?: Pick<IWorkspaces, 'create'>
    legacy?: (signal: AbortSignal) => Promise<unknown>
    sourceSessionQuery?: string
    /** Notification and shared links preserve the original Hub identity too. */
    sourceHubQuery?: string
    beforeRemove?: (resources: readonly PaneResource[]) => boolean
}

export interface WorkspaceHost {
    readonly id: string
    readonly label: string
    readonly sessions: WorkspaceOptions['sessions']
    readonly navigation: WorkspaceOptions['navigation']
    readonly workspaces?: WorkspaceOptions['workspaces']
    readonly workspaceState?: {
        getSnapshot(): { archivedSessionIds: readonly string[]; pinnedSessionIds: readonly string[] }
        subscribe(listener: () => void): () => void
    }
    /** Must be implemented by this Host's own official SlotRenderer context. */
    readonly renderConversation?: (reference: SessionReference, options?: WorkspaceRenderOptions) => ReactNode
    /** Generic official plugin view, owned by the same isolated Client graph. */
    readonly renderPane?: (reference: SessionReference, resource: Exclude<PaneResource, { kind: 'empty' }>, options: WorkspaceRenderOptions) => ReactNode
}

export interface WorkspaceRenderOptions { paneId: string; focused: boolean; visible?: boolean }

export interface WorkspaceViewOptions {
    sessionId?: string
    beside?: SplitAxis
    kind?: string
    params?: NavigationValue
    /** Restore the address of a real existing official tab occurrence. */
    address?: string
    title?: string
}

export interface WorkspaceCatalogRow extends SessionSummary {
    readonly hostId: string
    readonly hostLabel: string
    readonly hostOnline: boolean
    readonly sourceSessionId: string
    readonly archived: boolean
    readonly pinned: boolean
    /** Original HAPI pin policy; independent of DSH display bookmarks. */
    readonly sourcePinMode?: 'none' | 'project' | 'global'
    readonly sourceActive?: boolean
    readonly sourceLifecycleState?: string | null
    readonly sourceSummary?: CatalogSession['sourceSummary']
    readonly sourceCreatedAt?: CatalogSession['sourceCreatedAt']
    readonly sourceLastActiveAt?: CatalogSession['sourceLastActiveAt']
    readonly sourceWorktree?: CatalogSession['sourceWorktree']
    readonly sourceSubagentSearch?: readonly string[]
    readonly sourceListFacts?: CatalogSession['sourceListFacts']
    readonly sourceRowState?: CatalogSession['sourceRowState']
}

export interface WorkspaceCatalog extends Omit<SessionListState, 'byId'> { byId: Record<string, WorkspaceCatalogRow> }

export function sessionResourceId(hostId: string, sessionId: string): string {
    return hostId === 'local' ? sessionId : `hapi-remote:${encodeURIComponent(hostId)}:${encodeURIComponent(sessionId)}`
}

export function parseSessionResourceId(value: string): { hostId: string; sessionId: string } {
    if (!value.startsWith('hapi-remote:')) return { hostId: 'local', sessionId: value }
    const separator = value.indexOf(':', 'hapi-remote:'.length)
    if (separator < 0) throw new Error('Invalid remote conversation address')
    const hostId = decodeURIComponent(value.slice('hapi-remote:'.length, separator))
    const sessionId = decodeURIComponent(value.slice(separator + 1))
    if (!hostId || !sessionId || hostId === 'local') throw new Error('Invalid remote conversation address')
    return { hostId, sessionId }
}

export interface PaneLease {
    readonly hostId: string
    readonly sessionId: string
    readonly reference?: SessionReference
    readonly status: 'opening' | 'ready' | 'failed'
    readonly error?: string
    /** Catalog arrival can recover this lease without a user retry. */
    readonly waitingForCatalog?: boolean
}

export interface WorkspaceSnapshot {
    readonly layout: WorkspaceState
    readonly catalog: WorkspaceCatalog
    /** Actual first source/Host discovery, independent of a temporarily empty catalog. */
    readonly catalogDiscovery: WorkspaceCatalogDiscovery
    readonly leases: ReadonlyMap<string, PaneLease>
    readonly notice: string | null
    readonly persistence: 'local' | 'saving' | 'saved' | 'failed'
    readonly conflict: WorkspaceState | null
    readonly creation: 'choose' | 'dsh' | 'codex' | 'source' | null
    readonly creationContext: WorkspaceCreationContext | null
    readonly pickingSession: boolean
    readonly machines: readonly CatalogMachine[]
    readonly nativePanel: { kind: 'library' } | { kind: 'session'; sessionId: string; initialAction?: 'fork' | 'archive' | 'reopen' | 'pin' | 'restart' | 'delete' } | null
}

/** An explicit source folder selection, never inferred from the serving Hub's cwd. */
export interface WorkspaceCreationContext {
    readonly hostId: string
    readonly directory: string
    readonly machineId?: string
    readonly engine?: string
    readonly sourceHubId?: string
    readonly sourceSessionId?: string
}

export function sessionCreationContext(row: WorkspaceCatalogRow | undefined, directory = row?.cwd): WorkspaceCreationContext | null {
    if (!row || !directory?.trim() || isSourceChild(row)) return null
    const source = sourceIdentity(row), location = sessionLocation(row)
    return { hostId: row.hostId, directory,
        ...(source ? { sourceSessionId: source.sessionId,
            ...(source.hubId ? { sourceHubId: source.hubId } : {}),
            ...(location.machineId ? { machineId: location.machineId } : {}), engine: location.engine,
        } : {}) }
}

export interface SessionLocation {
    engine: string
    machineId?: string
    machineName?: string
    hubId?: string
    nativeId?: string
}

/** Unknown upstream/custom projections must never be treated as trusted UI records. */
export function sessionLocation(summary: Pick<SessionSummary, 'projectionValues'> | undefined): SessionLocation {
    const projection: unknown = summary?.projectionValues && (Reflect.get(summary.projectionValues, 'hapi') ?? Reflect.get(summary.projectionValues, 'hapiObserved'))
    const hostId: unknown = summary && Reflect.get(summary, 'hostId')
    const hostLabel: unknown = summary && Reflect.get(summary, 'hostLabel')
    const fallback: SessionLocation = {
        engine: 'dsh',
        ...(typeof hostId === 'string' && hostId !== 'local' ? { machineId: hostId } : {}),
        ...(typeof hostLabel === 'string' && hostId !== 'local' ? { machineName: hostLabel } : {}),
    }
    if (typeof projection !== 'object' || projection === null) return fallback
    const field = (name: string): string | undefined => {
        const value: unknown = Reflect.get(projection, name)
        return typeof value === 'string' && value.length > 0 ? value : undefined
    }
    return {
        ...fallback, engine: field('flavor') ?? field('engine') ?? 'dsh',
        ...(field('machineId') ? { machineId: field('machineId')! } : {}),
        ...(field('machineName') ? { machineName: field('machineName')! } : {}),
        ...(field('hubId') ? { hubId: field('hubId')! } : {}),
        ...(field('nativeId') ? { nativeId: field('nativeId')! } : {}),
    }
}

export function filterSessions<T extends SessionSummary>(rows: readonly T[], query: string, engine = '', machine = '', searchIndex?: SidebarSearchIndex): T[] {
    const hasQuery = Boolean(query.trim()), index = searchIndex ?? buildSidebarSearchIndex(rows, query, sessionLocation)
    return rows.filter(row => {
        const location = sessionLocation(row)
        if (engine && location.engine !== engine) return false
        if (machine && (location.machineId ?? location.machineName ?? '') !== machine) return false
        return !hasQuery || index.matchedIds.has(row.id)
    }).sort((a, b) => hasQuery ? compareSidebarSearch(a, b, index) : b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (error && typeof error === 'object' && typeof Reflect.get(error, 'message') === 'string') return String(Reflect.get(error, 'message'))
    return String(error)
}

/**
 * Own references at plugin scope, not React mount scope. Opening an official
 * plugin page, switching windows, zooming, and resizing therefore preserve the
 * same generation, Conversation state, and official composer draft.
 */
export class WorkspaceController {
    readonly store: WorkspaceStore
    readonly sidebar: SidebarState
    private readonly listeners = new Set<() => void>()
    private readonly createdListeners = new Set<(sessionId: string) => void>()
    private successorHandler: ((from: import('./draft-handoff.ts').HandoffAddress, to: import('./draft-handoff.ts').HandoffAddress, paneId?: string) => Promise<void>) | undefined
    private readonly leases = new Map<string, PaneLease>()
    private readonly hosts = new Map<string, WorkspaceHost>()
    private readonly hostCatalogs = new Map<string, { label: string; catalog: SessionListState }>()
    private readonly hostUnsubscribers = new Map<string, Array<() => void>>()
    private readonly hostMainIds = new Map<string, string | undefined>()
    private readonly sourceCatalog = new Map<string, CatalogSession>()
    private readonly discovery = new CatalogDiscovery()
    private discoveryCatalog: WorkspaceCatalog | undefined
    private sourceBindingsPending = 0
    private readonly paneCloseGuards = new Map<string, Set<() => boolean>>()
    private readonly lifetime = new AbortController()
    private snapshot: WorkspaceSnapshot
    private readonly unsubscribers: Array<() => void> = []
    private disposed = false
    private reconciling = false
    private navigationGuard = false
    private pendingNavigationResource: string | null = null
    private saving = false
    private remoteLoaded = false
    private queuedSave: WorkspaceState | undefined
    private readonly restoredLocal: boolean
    private sharedSignature: string
    private pendingSourceSession: { sessionId: string; hubId?: string } | null
    private primarySourceHubId: string | null = null

    constructor(readonly options: WorkspaceOptions) {
        const nextId = options.nextId ?? (() => crypto.randomUUID())
        let state = initialWorkspace(nextId)
        let notice: string | null = null
        let restored = false
        try {
            const raw = options.storage?.getItem(options.storageKey)
            if (raw) { state = parseWorkspaceState(JSON.parse(raw)); restored = true }
        } catch (error) {
            notice = `Workspace restore failed: ${errorMessage(error)}`
        }
        this.restoredLocal = restored
        this.store = new WorkspaceStore(state, nextId, resources => {
            const removing = new Set(resources)
            for (const pane of this.store.getSnapshot().windows.flatMap(window => panes(window.root))) {
                if (!removing.has(pane.resource)) continue
                for (const guard of this.paneCloseGuards.get(pane.id) ?? []) {
                    try { if (!guard()) return false }
                    catch (error) { this.report(error); return false }
                }
            }
            return options.beforeRemove?.(resources) !== false
        })
        this.sharedSignature = sharedWorkspaceSignature(this.store.getSnapshot())
        this.pendingSourceSession = options.sourceSessionQuery ? { sessionId: options.sourceSessionQuery,
            ...(options.sourceHubQuery === undefined ? {} : { hubId: options.sourceHubQuery }) } : null
        this.sidebar = new SidebarState(options.storage, `${options.storageKey}:sidebar`)
        this.hosts.set('local', { id: 'local', label: 'DSH', sessions: options.sessions, navigation: options.navigation,
            ...(options.workspaces ? { workspaces: options.workspaces } : {}),
            ...(options.workspaceState ? { workspaceState: options.workspaceState } : {}) })
        this.snapshot = {
            layout: this.store.getSnapshot(), catalog: this.aggregateCatalog(),
            catalogDiscovery: this.discovery.snapshot(options.sessions.list.getSnapshot().phase === 'ready'),
            leases: new Map(), notice, persistence: 'local', conflict: null,
            creation: null, creationContext: null, pickingSession: false, machines: [], nativePanel: null,
        }
        this.hostMainIds.set('local', this.selectedMain('local'))
        this.unsubscribers.push(this.store.subscribe(this.onLayout), options.sessions.list.subscribe(() => this.onCatalog('local')))
        if (options.workspaceState) this.unsubscribers.push(options.workspaceState.subscribe(() => this.publish({ catalog: this.aggregateCatalog() })))
        this.reconcileLeases()
        // A restored workspace has deliberate selection; a first install follows
        // the already selected official Session, if there is one.
        const selected = this.hostMainIds.get('local')
        if (!restored && selected) this.store.openSession(selected)
        else this.syncNavigation()
        if (options.persistence) void this.loadRemote()
        else { this.remoteLoaded = true; this.openPendingSource() }
    }

    getSnapshot = (): WorkspaceSnapshot => this.snapshot

    /** Each plugin owns its own guard and disposer, never another graph's state. */
    registerPaneCloseGuard(paneId: string, guard: () => boolean): () => void {
        let guards = this.paneCloseGuards.get(paneId)
        if (!guards) { guards = new Set(); this.paneCloseGuards.set(paneId, guards) }
        guards.add(guard)
        return () => {
            guards.delete(guard)
            if (!guards.size && this.paneCloseGuards.get(paneId) === guards) this.paneCloseGuards.delete(paneId)
        }
    }
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }
    /** Only a successfully created or explicitly recovered creation emits here. */
    subscribeCreated = (listener: (sessionId: string) => void): (() => void) => {
        this.createdListeners.add(listener)
        return () => { this.createdListeners.delete(listener) }
    }

    /** One entry point for the official sidebar and this workspace's controls. */
    requestNewSession = (engine: 'choose' | 'dsh' | 'codex' | 'source' = 'choose', context?: WorkspaceCreationContext): void => {
        const creationContext = context ? { ...context }
            : this.snapshot.creation === 'choose' && engine !== 'choose' ? this.snapshot.creationContext : null
        this.publish({ creation: engine, creationContext })
        this.options.reveal?.()
    }

    requestNewSessionInDirectory = (sessionId: string, directory?: string): void => {
        const context = sessionCreationContext(this.snapshot.catalog.byId[sessionId], directory)
        if (context) this.requestNewSession('choose', context)
    }

    closeNewSession = (): void => { this.publish({ creation: null, creationContext: null }) }

    requestSessionPicker = (): void => {
        this.publish({ pickingSession: true })
        this.options.reveal?.()
    }
    closeSessionPicker = (): void => { this.publish({ pickingSession: false }) }
    setMachines(machines: readonly CatalogMachine[]): void { this.publish({ machines }) }
    setSourceCatalog(sessions: readonly CatalogSession[], hubId?: string, discovery?: {
        hosts: readonly { id: string; label: string; online: boolean }[]; connected: boolean
    }): void {
        if (hubId) this.primarySourceHubId = hubId
        this.sourceCatalog.clear()
        for (const session of sessions) this.sourceCatalog.set(session.id, session)
        this.discovery.observe(discovery?.hosts ?? [], discovery?.connected ?? true)
        this.publish({ catalog: this.aggregateCatalog() })
        this.openPendingSource()
    }
    sourceCatalogFailed(error: unknown): void { this.discovery.sourceFailed(errorMessage(error)); this.publish() }
    catalogHostReady(id: string, label: string): void { this.discovery.hostReady(id, label); this.publish() }
    catalogHostFailed(id: string, label: string, error: unknown): void { this.discovery.hostFailed(id, label, errorMessage(error)); this.publish() }
    openNativeLibrary = (): void => { this.publish({ nativePanel: { kind: 'library' }, creation: null, creationContext: null, pickingSession: false }); this.options.reveal?.() }
    openNativeTools = (sessionId: string, initialAction?: 'fork' | 'archive' | 'reopen' | 'pin' | 'restart' | 'delete'): void => {
        this.publish({ nativePanel: { kind: 'session', sessionId, ...(initialAction ? { initialAction } : {}) }, pickingSession: false }); this.options.reveal?.()
    }
    closeNativePanel = (): void => { this.publish({ nativePanel: null }) }

    private publish(patch: Partial<WorkspaceSnapshot> = {}): void {
        if (this.disposed) return
        this.snapshot = { ...this.snapshot, ...patch, layout: this.store.getSnapshot(), leases: new Map(this.leases) }
        if (this.discoveryCatalog !== this.snapshot.catalog) {
            this.discoveryCatalog = this.snapshot.catalog
            const listed = new Set(this.snapshot.catalog.ids)
            this.sourceBindingsPending = [...this.sourceCatalog.values()].filter(source => {
                const identity = sourceIdentity(this.snapshot.catalog.byId[source.id])
                return !listed.has(source.id as SessionId) || !identity?.hubId || identity.sessionId !== source.hapiSessionId
                    || this.primarySourceHubId !== null && identity.hubId !== this.primarySourceHubId
            }).length
        }
        this.snapshot = { ...this.snapshot, catalogDiscovery: this.discovery.snapshot(this.options.sessions.list.getSnapshot().phase === 'ready', this.sourceBindingsPending) }
        for (const listener of [...this.listeners]) listener()
    }

    private selectedMain(hostId: string): string | undefined {
        const host = this.hosts.get(hostId)
        if (!host) return undefined
        const rows = Object.values(host.sessions.list.getSnapshot().byId)
        const retained = rows.filter(row => (row.retainedBy.mainView ?? 0) > 0)
        // DSH retains the next main reference before releasing the previous one.
        return retained.find(row => row.id !== this.hostMainIds.get(hostId))?.id ?? retained[0]?.id
    }

    private onCatalog = (hostId: string): void => {
        if (this.disposed) return
        const catalog = this.aggregateCatalog()
        this.publish({ catalog })
        if (this.navigationGuard || this.reconciling) return
        const current = this.store.getSnapshot()
        const rebound = bindSourceResources(current, catalog.byId)
        if (current !== rebound) this.store.replace(rebound)
        if (this.openPendingSource()) return
        this.reconcileLeases()
        const focused = this.store.focusedPane().resource
        if (focused.kind === 'chat' && focused.sessionId === this.pendingNavigationResource) {
            try {
                if (parseSessionResourceId(focused.sessionId).hostId === hostId) {
                    // Restoration owns this selection until its own catalog
                    // arrives. An initial official main-view restore must not
                    // replace the saved workspace while it is still loading.
                    this.syncNavigation()
                    return
                }
            } catch { /* Invalid saved addresses already have a failed lease. */ }
        }
        const mainId = this.selectedMain(hostId)
        if (mainId === this.hostMainIds.get(hostId)) return
        this.hostMainIds.set(hostId, mainId)
        if (mainId) this.store.openSession(sessionResourceId(hostId, mainId))
    }

    private aggregateCatalog(): WorkspaceCatalog {
        for (const host of this.hosts.values()) this.hostCatalogs.set(host.id, { label: host.label, catalog: host.sessions.list.getSnapshot() })
        const ids: SessionId[] = []
        const byId: WorkspaceCatalog['byId'] = {}
        let phase: SessionListState['phase'] = 'ready'
        for (const [hostId, cached] of this.hostCatalogs) {
            const host = this.hosts.get(hostId)
            if (host && cached.catalog.phase === 'pending') phase = 'pending'
            const workspace = host?.workspaceState?.getSnapshot()
            const archived = new Set(workspace?.archivedSessionIds ?? [])
            const pinned = new Set(workspace?.pinnedSessionIds ?? [])
            for (const [sourceSessionId, row] of Object.entries(cached.catalog.byId)) {
                const resourceId = sessionResourceId(hostId, sourceSessionId)
                const source = hostId === 'local' ? this.sourceCatalog.get(sourceSessionId) : undefined
                const sourceOwned = hostId === 'local' && (sourceIdentity(row) !== null || isSourceChild(row))
                byId[resourceId] = { ...row, id: resourceId as SessionId, hostId, hostLabel: cached.label, hostOnline: host !== undefined,
                    ...(sourceOwned && Number.isFinite(source?.updatedAt) ? { updatedAt: source!.updatedAt! } : {}),
                    ...(sourceOwned && typeof source?.active === 'boolean' ? { sourceActive: source.active } : {}),
                    ...(sourceOwned && source?.lifecycleState !== undefined ? { sourceLifecycleState: source.lifecycleState } : {}),
                    ...(sourceOwned && source ? { sourceCreatedAt: source.sourceCreatedAt ?? null, sourceLastActiveAt: source.sourceLastActiveAt ?? null, sourceSummary: source.sourceSummary ?? null, sourceWorktree: source.sourceWorktree ?? null, sourceSubagentSearch: source.sourceSubagentSearch ?? [],
                        ...(source.sourceListFacts ? { sourceListFacts: source.sourceListFacts } : {}),
                        ...(source.sourceRowState ? { sourceRowState: source.sourceRowState } : {}) } : {}),
                    sourceSessionId, archived: !sourceOwned && archived.has(sourceSessionId),
                    pinned: sourceOwned ? source?.pinMode === 'project' || source?.pinMode === 'global' : pinned.has(sourceSessionId),
                    ...(sourceOwned ? { sourcePinMode: source?.pinMode ?? 'none' } : {}),
                }
            }
            for (const id of cached.catalog.ids) ids.push(sessionResourceId(hostId, id) as SessionId)
        }
        return { ids, byId, phase, projectionsBySession: {} }
    }

    /** Add an independently booted Host; never pass its reference into another Host's provider. */
    addHost(host: WorkspaceHost): () => void {
        if (this.disposed) throw new Error('The workspace is disposed')
        if (!host.id || host.id === 'local' || this.hosts.has(host.id)) throw new Error('Duplicate or invalid Host identity')
        if (!host.renderConversation) throw new Error('A remote Host must provide its own Conversation renderer')
        this.hosts.set(host.id, host)
        this.hostMainIds.set(host.id, this.selectedMain(host.id))
        const subscriptions = [host.sessions.list.subscribe(() => this.onCatalog(host.id))]
        if (host.workspaceState) subscriptions.push(host.workspaceState.subscribe(() => this.publish({ catalog: this.aggregateCatalog() })))
        this.hostUnsubscribers.set(host.id, subscriptions)
        for (const [paneId, lease] of this.leases) {
            if (lease.hostId === host.id && lease.status === 'failed') { this.leases.delete(paneId); lease.reference?.release() }
        }
        this.reconcileLeases()
        this.syncNavigation()
        this.publish({ catalog: this.aggregateCatalog() })
        return () => {
            if (this.hosts.get(host.id) !== host) return
            this.hosts.delete(host.id)
            for (const unsubscribe of this.hostUnsubscribers.get(host.id) ?? []) unsubscribe()
            this.hostUnsubscribers.delete(host.id)
            this.hostMainIds.delete(host.id)
            for (const [paneId, lease] of this.leases) {
                if (lease.hostId === host.id) {
                    this.leases.set(paneId, { hostId: host.id, sessionId: lease.sessionId, status: 'failed', error: `Host is offline: ${host.label}` })
                    lease.reference?.release()
                }
            }
            this.publish({ catalog: this.aggregateCatalog() })
        }
    }

    host(hostId: string): WorkspaceHost | undefined { return this.hosts.get(hostId) }
    /** Replace only a Host's rendering face; catalogs and references stay owned. */
    bindRenderer(hostId: string, renderPane: NonNullable<WorkspaceHost['renderPane']>): () => void {
        const previous = this.hosts.get(hostId)
        if (!previous) throw new Error('The pane Host is unavailable')
        const host = { ...previous, renderPane }
        this.hosts.set(hostId, host); this.publish()
        return () => { if (this.hosts.get(hostId) === host) { this.hosts.set(hostId, previous); this.publish() } }
    }
    availableHosts(): Array<{ id: string; label: string }> { return [...this.hosts.values()].map(({ id, label }) => ({ id, label })) }

    source(resourceId: string): { host: WorkspaceHost; sessionId: string } {
        const { hostId, sessionId } = parseSessionResourceId(resourceId)
        const host = this.hosts.get(hostId)
        if (!host) throw new Error(`Host is offline: ${this.hostCatalogs.get(hostId)?.label ?? hostId}`)
        return { host, sessionId }
    }

    private onLayout = (): void => {
        this.reconcileLeases()
        this.syncNavigation()
        const state = this.store.getSnapshot()
        try { this.options.storage?.setItem(this.options.storageKey, JSON.stringify(state)) }
        catch (error) { this.publish({ notice: `Workspace save failed: ${errorMessage(error)}`, persistence: 'failed' }) }
        const signature = sharedWorkspaceSignature(state)
        if (this.options.persistence && signature !== this.sharedSignature) {
            this.queuedSave = sharedWorkspaceState(state)
            if (this.remoteLoaded) void this.flushRemote()
        }
        this.sharedSignature = signature
        this.publish()
    }

    private reconcileLeases(): void {
        if (this.disposed || this.reconciling) return
        this.reconciling = true
        try {
            const expected = new Map(this.store.getSnapshot().windows.flatMap(window => panes(window.root))
                .flatMap(pane => pane.resource.kind !== 'empty' ? [[pane.id, pane.resource] as const] : []))
            // Release only retired occurrences. No cancel, abort, or archive call.
            for (const [id, lease] of this.leases) {
                if (expected.get(id)?.sessionId !== sessionResourceId(lease.hostId, lease.sessionId)) {
                    this.leases.delete(id)
                    lease.reference?.release()
                }
            }
            for (const [paneId, resource] of expected) {
                const resourceId = resource.sessionId
                const previous = this.leases.get(paneId)
                if (previous && !previous.waitingForCatalog) continue
                let hostId = 'local'
                let sessionId = resourceId
                try {
                    if (resource.sourceSessionId && !sourceRow(resource, this.snapshot.catalog.byId)) {
                        this.leases.set(paneId, { hostId, sessionId, status: 'failed', waitingForCatalog: true,
                            error: `Original HAPI session ${resource.sourceSessionId} is not available yet. Its pane and source identity are preserved; it will attach when the source becomes available.` })
                        continue
                    }
                    ;({ hostId, sessionId } = parseSessionResourceId(resourceId))
                    const { host } = this.source(resourceId)
                    const catalog = host.sessions.list.getSnapshot()
                    if (!catalog.byId[sessionId as SessionId]) {
                        this.leases.set(paneId, { hostId, sessionId, waitingForCatalog: true,
                            status: catalog.phase === 'pending' ? 'opening' : 'failed',
                            ...(catalog.phase === 'pending' ? {} : { error: 'This session is not currently listed by its Host. It will reopen when the Host makes it available.' }),
                        })
                        continue
                    }
                    const reference = host.sessions.retain(sessionId as SessionId, { source: 'hapiWorkspace' })
                    const lease: PaneLease = { hostId, sessionId, reference, status: 'opening' }
                    this.leases.set(paneId, lease)
                    void reference.ready.then(() => {
                        if (this.disposed || this.leases.get(paneId) !== lease) return
                        this.leases.set(paneId, { hostId, sessionId, reference, status: 'ready' })
                        this.publish()
                    }, error => {
                        if (this.disposed || this.leases.get(paneId) !== lease) return
                        this.leases.set(paneId, { hostId, sessionId, reference, status: 'failed', error: errorMessage(error) })
                        this.publish()
                    })
                } catch (error) {
                    this.leases.set(paneId, { hostId, sessionId, status: 'failed', error: errorMessage(error) })
                }
            }
        } finally { this.reconciling = false }
        this.publish({ catalog: this.aggregateCatalog() })
    }

    private syncNavigation(): void {
        const focused = this.store.focusedPane()
        if (focused.resource.kind === 'empty') { this.pendingNavigationResource = null; return }
        let source: { hostId: string; sessionId: string }
        try { source = parseSessionResourceId(focused.resource.sessionId) }
        catch (error) { this.publish({ notice: errorMessage(error) }); return }
        const { hostId, sessionId: id } = source
        const host = this.hosts.get(hostId)
        if (!host || !host.sessions.list.getSnapshot().byId[id as SessionId]) {
            this.pendingNavigationResource = focused.resource.sessionId
            return
        }
        this.pendingNavigationResource = null
        if (this.hostMainIds.get(hostId) === id) return
        const previous = this.hostMainIds.get(hostId)
        this.hostMainIds.set(hostId, id)
        this.navigationGuard = true
        try { host.navigation.openSession(id as SessionId) }
        catch (error) { this.hostMainIds.set(hostId, previous); this.publish({ notice: errorMessage(error) }) }
        finally { this.navigationGuard = false }
    }

    openSession(sessionId: string, beside?: SplitAxis): void {
        const source = sourceIdentity(this.snapshot.catalog.byId[sessionId])
        const existing = source && this.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.resource.kind === 'chat'
            && pane.resource.sourceSessionId === source.sessionId && (!pane.resource.sourceHubId || pane.resource.sourceHubId === source.hubId))
        if (existing) {
            const state = this.store.getSnapshot()
            const rebound = bindSourceResources(state, this.snapshot.catalog.byId)
            if (rebound !== state) this.store.replace(rebound)
            this.store.focus(existing.id)
        } else this.store.openSession(sessionId, beside)
        this.closeSessionPicker()
        this.options.reveal?.()
    }

    openCreatedSession(sessionId: string): void {
        if (this.disposed) return
        this.openSession(sessionId)
        for (const listener of [...this.createdListeners]) listener(sessionId)
    }

    /** The root owns this narrow, source-aware hand-off. Ordinary navigation,
     * imports and forks never imply a successor relationship. */
    installSuccessorHandler(handler: NonNullable<WorkspaceController['successorHandler']>): () => void {
        if (this.successorHandler) throw new Error('The successor draft handler is already installed')
        this.successorHandler = handler
        return () => { if (this.successorHandler === handler) this.successorHandler = undefined }
    }

    async openSuccessorSession(fromId: string, toId: string, paneId?: string): Promise<void> {
        const previous = this.snapshot.catalog.byId[fromId], from = sourceIdentity(previous)
        if (!previous || !from?.hubId || isSourceChild(previous)) throw new Error('The original source identity is unavailable. Its draft has not been moved.')
        await this.refresh()
        const next = this.snapshot.catalog.byId[toId], to = sourceIdentity(next)
        if (this.disposed) throw new Error('The workspace is closed')
        if (!next || !to?.hubId || isSourceChild(next) || from.hubId !== to.hubId || previous.hostId !== next.hostId) {
            throw new Error('The confirmed successor is not yet listed on the original Hub and Host. The old draft remains available; inspect the source operation receipt before trying again.')
        }
        if (from.sessionId === to.sessionId) { this.openSession(toId); return }
        if (!this.successorHandler) throw new Error('The source draft receiver is not ready. The old draft remains available.')
        await this.successorHandler({ hubId: from.hubId, sessionId: from.sessionId, displayId: previous.sourceSessionId, hostId: previous.hostId },
            { hubId: to.hubId, sessionId: to.sessionId, displayId: next.sourceSessionId, hostId: next.hostId }, paneId)
    }

    /** A source notification never treats its original id as a DSH display id
     * or silently opens another Hub's same-named session. */
    async openSourceSession(source: { hubId: string; sessionId: string }): Promise<void> {
        if (!source.hubId.trim() || !source.sessionId.trim()) throw new Error('A source conversation requires both its Hub and session identity')
        let matches = this.sourceMatches(source)
        if (matches.length !== 1) { await this.refresh(); matches = this.sourceMatches(source) }
        if (this.disposed) throw new Error('The workspace is closed')
        if (matches.length !== 1) throw new Error(matches.length > 1
            ? 'This source conversation has multiple display bindings. Choose its Host in the unified sidebar.'
            : 'This conversation is not available from the requested source Hub. Reconnect that Hub and try again.')
        this.openSession(matches[0]!.id)
    }

    private sourceMatches(source: { sessionId: string; hubId?: string }): WorkspaceCatalogRow[] {
        return Object.values(this.snapshot.catalog.byId).filter(row => {
            const identity = sourceIdentity(row)
            return identity?.sessionId === source.sessionId && (source.hubId === undefined || identity.hubId === source.hubId)
        })
    }

    /** Native sidebar drag uses the same catalog identity as normal opening. */
    dockSession(sessionId: string, targetPaneId: string, position: DockPosition): void {
        const row = this.snapshot.catalog.byId[sessionId]
        if (!row) return
        const source = sourceIdentity(row)
        const existing = this.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.resource.kind === 'chat'
            && (pane.resource.sessionId === sessionId || source && pane.resource.sourceSessionId === source.sessionId && (!pane.resource.sourceHubId || pane.resource.sourceHubId === source.hubId)))
        if (existing) { this.openSession(sessionId); return }
        this.store.dockResource({ kind: 'chat', sessionId, ...(source ? { sourceSessionId: source.sessionId, ...(source.hubId ? { sourceHubId: source.hubId } : {}) } : {}) }, targetPaneId, position)
        this.closeSessionPicker(); this.options.reveal?.()
    }

    /** Thin navigation face; DSH continues to own every protocol and viewer. */
    openResource(address: string, options: WorkspaceViewOptions = {}): void {
        this.openView({ type: 'resource', address, ...(options.kind ? { kind: options.kind } : {}), ...(options.params === undefined ? {} : { params: options.params }) }, options)
    }

    openTab(kind: string, options: WorkspaceViewOptions = {}): void {
        this.openView({ type: 'tab', kind, ...(options.address ? { address: options.address } : {}), ...(options.params === undefined ? {} : { params: options.params }) }, options)
    }

    openPanel(panelId: string, options: WorkspaceViewOptions = {}): void { this.openView({ type: 'panel', panelId }, options) }

    openView(input: DshPaneTarget, options: WorkspaceViewOptions = {}): void {
        const target = parseDshPaneTarget(input)
        const focused = this.store.focusedPane().resource
        const sessionId = options.sessionId ?? (focused.kind === 'empty' ? undefined : focused.sessionId)
        if (!sessionId) throw new Error('Choose a conversation to provide the plugin view’s Host, machine and working directory')
        const source = sourceIdentity(this.snapshot.catalog.byId[sessionId])
        // Resource opens reveal an existing address. Independent page instances
        // keep their official multiple semantics when no address exists yet.
        const existing = this.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => {
            if (pane.resource.kind !== 'view' || pane.resource.sessionId !== sessionId) return false
            const previous = pane.resource.target
            if (target.type === 'resource') return previous.type === 'resource' && previous.address === target.address && previous.kind === target.kind
            if (target.type === 'tab') return target.address !== undefined && previous.type === 'tab' && previous.address === target.address && previous.kind === target.kind
            if (target.type === 'panel') return previous.type === 'panel' && previous.panelId === target.panelId
            return false
        })
        if (existing) { this.store.updateView(existing.id, target, options.title); this.store.focus(existing.id) }
        else this.store.openResource({ kind: 'view', sessionId, viewId: this.options.nextId?.() ?? crypto.randomUUID(), target,
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(source ? { sourceSessionId: source.sessionId, ...(source.hubId ? { sourceHubId: source.hubId } : {}) } : {}),
        }, options.beside)
        this.options.reveal?.()
    }

    /** Persist what the actual official occurrence navigated to, never a guessed content id. */
    updateView(paneId: string, target: DshPaneTarget, title?: string): void {
        this.store.updateView(paneId, parseDshPaneTarget(target), title)
    }

    /** Source deep links wait for their real native binding; no guessed display ID. */
    private openPendingSource(): boolean {
        if (!this.remoteLoaded || !this.pendingSourceSession) return false
        const hubId = this.pendingSourceSession.hubId ?? this.primarySourceHubId
        // Legacy /sessions links belong to the configured original Hub. Wait
        // for its real catalog identity instead of guessing from an early row
        // while other Host catalogs are still arriving.
        if (!hubId) return false
        const matches = this.sourceMatches({ ...this.pendingSourceSession, hubId })
        // Notification links always include their Hub and never take a first hit.
        if (matches.length !== 1) return false
        const row = matches[0]!
        this.pendingSourceSession = null
        this.openSession(row.id)
        return true
    }

    replaceSession(previousId: string, nextId: string, hostId = 'local'): void {
        this.store.replaceSession(sessionResourceId(hostId, previousId), sessionResourceId(hostId, nextId))
    }

    startSession = (): void => {
        this.options.navigation.startSession()
    }

    async createSession(hostId: string, directory: string, requestedId: string): Promise<string> {
        const host = this.hosts.get(hostId)
        if (!host) throw new Error('The selected Host is offline')
        // A response may have been lost after creation. If the named Session is
        // already visible, opening it also remains safe after it became active;
        // invoking DSH create again would intentionally allocate another Session
        // once that named Session is no longer a reusable blank.
        await host.sessions.refresh()
        const catalog = host.sessions.list.getSnapshot()
        if (catalog.phase !== 'ready') throw new Error('The selected Host conversation list is not ready. Retry when it reconnects.')
        let sourceId = catalog.byId[requestedId as SessionId]?.id
        if (!sourceId) {
            if (!host.workspaces) throw new Error('The selected Host does not expose the official Workspace service')
            const path = directory.trim() || (await host.navigation.listDirectory?.())?.path
            if (!path) throw new Error('Choose a working directory on the selected Host')
            // Official blank Conversation requires Workspace membership. A raw
            // cwd-only Session is valid on the Host but leaves its hero composer
            // inert. Workspace adoption is idempotent by the canonical path.
            const workspace = await host.workspaces.create({ path })
            sourceId = await host.sessions.create({ sessionId: requestedId as SessionId, workspaceId: workspace.workspaceId })
        }
        const id = sessionResourceId(hostId, sourceId)
        this.openCreatedSession(id)
        await host.sessions.refresh()
        return id
    }

    retryPane(paneId: string): void {
        const lease = this.leases.get(paneId)
        if (!lease || lease.status !== 'failed') return
        this.leases.delete(paneId)
        lease.reference?.release()
        this.reconcileLeases()
    }

    clearNotice = (): void => { this.publish({ notice: null }) }
    report = (error: unknown): void => { this.publish({ notice: errorMessage(error) }) }

    async refresh(): Promise<void> {
        const results = await Promise.allSettled([...this.hosts.values()].map(host => host.sessions.refresh()))
        for (const result of results) if (result.status === 'rejected') this.report(result.reason)
    }

    async renameSession(sessionId: string, title: string): Promise<void> {
        const normalized = title.trim()
        if (!normalized) throw new Error('A session title cannot be empty')
        const source = this.source(sessionId)
        const result = await source.host.sessions.using(source.sessionId as SessionId, { source: 'hapiWorkspace' }, reference => reference.binding.session.rename(normalized))
        if (!result.ok) throw new Error(result.error.message)
    }

    async sessionAction(sessionId: string, action: 'pin' | 'unpin' | 'archive' | 'unarchive' | 'fork'): Promise<void> {
        const { host, sessionId: sourceSessionId } = this.source(sessionId)
        const id = sourceSessionId as SessionId
        if (action === 'fork') { this.openSession(sessionResourceId(host.id, await host.navigation.forkSession(id))); return }
        if (action === 'pin') return host.navigation.pinSession(id)
        if (action === 'unpin') return host.navigation.unpinSession(id)
        if (action === 'unarchive') return host.navigation.unarchiveSession(id)
        await host.navigation.archiveSession(id)
        // Archive is an explicit action. Retire its views after the Host confirms.
        for (const window of this.store.getSnapshot().windows) {
            for (const pane of panes(window.root)) {
                if (pane.resource.kind === 'chat' && pane.resource.sessionId === sessionId) this.store.closePane(pane.id)
            }
        }
    }

    private async loadRemote(): Promise<void> {
        const initialRevision = this.store.getSnapshot().revision
        try {
            const loaded = await this.options.persistence!.load(this.lifetime.signal)
            if (this.disposed) return
            if (loaded !== null) {
                const restored = bindSourceResources(parseWorkspaceState(loaded), this.snapshot.catalog.byId)
                if (!this.restoredLocal && this.store.getSnapshot().revision === initialRevision) this.store.replace(keepLocalView(restored, this.store.getSnapshot()))
                else if (sharedWorkspaceSignature(restored) !== sharedWorkspaceSignature(this.store.getSnapshot())) {
                    this.queuedSave = sharedWorkspaceState(this.store.getSnapshot())
                    this.publish({ conflict: restored, persistence: 'failed', notice: 'The saved server layout differs from this browser. Choose which layout to keep.' })
                }
            } else if (!this.restoredLocal && this.options.legacy && this.store.getSnapshot().revision === initialRevision) {
                const legacy = await this.options.legacy(this.lifetime.signal)
                if (!this.disposed && this.store.getSnapshot().revision === initialRevision) {
                    const migrated = importLegacyWorkspace(legacy, this.snapshot.catalog.byId)
                    if (migrated) this.store.replace(migrated)
                }
            }
        } catch (error) {
            if (!this.disposed) this.publish({ notice: `Workspace sync failed: ${errorMessage(error)}`, persistence: 'failed' })
        } finally {
            this.remoteLoaded = true
            this.openPendingSource()
            if (this.queuedSave && !this.disposed) void this.flushRemote()
        }
    }

    private async flushRemote(): Promise<void> {
        if (this.saving || this.disposed || !this.options.persistence || this.snapshot.conflict) return
        this.saving = true
        try {
            while (this.queuedSave && !this.disposed) {
                const state = this.queuedSave
                this.queuedSave = undefined
                this.publish({ persistence: 'saving' })
                try {
                    await this.options.persistence.save(state, this.lifetime.signal)
                    this.publish({ persistence: 'saved' })
                } catch (error) {
                    const latest: unknown = error && typeof error === 'object' && Reflect.get(error, 'name') === 'WorkspaceConflictError' ? Reflect.get(error, 'latest') : null
                    this.publish({ notice: `Workspace sync failed: ${errorMessage(error)}`, persistence: 'failed', conflict: latest === null ? null : parseWorkspaceState(latest) })
                    // Preserve the latest geometry. A retry is explicit; no busy loop.
                    this.queuedSave ??= state
                    return
                }
            }
        } finally { this.saving = false }
    }

    retryPersistence = (): void => { if (this.remoteLoaded) void this.flushRemote() }

    resolveConflict(choice: 'local' | 'server'): void {
        const server = this.snapshot.conflict
        this.publish({ conflict: null, notice: null })
        if (choice === 'server' && server) {
            this.queuedSave = undefined
            this.store.replace(keepLocalView(server, this.store.getSnapshot()))
        } else void this.flushRemote()
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.lifetime.abort()
        for (const unsubscribe of this.unsubscribers) unsubscribe()
        for (const subscriptions of this.hostUnsubscribers.values()) for (const unsubscribe of subscriptions) unsubscribe()
        this.hostUnsubscribers.clear()
        for (const lease of this.leases.values()) lease.reference?.release()
        this.leases.clear()
        this.paneCloseGuards.clear()
        this.listeners.clear()
        this.createdListeners.clear()
        this.successorHandler = undefined
    }
}
