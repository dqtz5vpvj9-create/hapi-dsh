import { sameSourceGeneration } from './surface/generation-handoff.ts'
import { randomId } from './random-id.ts'
/** Plugin-owned view references and durable geometry. No agent lifetime ownership. */
import type { ISessions, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReactNode } from 'react'
import { initialWorkspace, panes, parseWorkspaceState, WorkspaceStore, type PaneResource, type SplitAxis, type WorkspaceState } from './model.ts'
import { rebaseWorkspace, WorkspaceRebaseConflictError } from '../workspace/rebase.ts'
import { SidebarState } from '../workspace/sidebar-state.ts'
import { bindSourceResources, importLegacyWorkspace, isSourceChild, keepLocalView, sharedWorkspaceSignature, sharedWorkspaceState, sourceIdentity, sourceRow } from '../workspace/legacy.ts'
import { bindingFailureState, invalidPaneAddressState, isSourceDisplaySessionId, paneOpenState, type PaneOpenContext, type PaneOpenFailure, type PaneOpenState } from './catalog-readiness.ts'
import type { CatalogMachine, CatalogSession } from '../client-api.ts'
import { parseDshPaneTarget, type DshPaneTarget, type NavigationValue } from '../workspace/dsh-view.ts'
import type { DockPosition } from '../workspace/drag.ts'
import { buildSidebarSearchIndex, compareSidebarSearch, type SidebarSearchIndex } from '../workspace/sidebar-search.ts'
import { CatalogDiscovery, type WorkspaceCatalogDiscovery } from '../workspace/catalog-discovery.ts'
import { sourceResolutionFailure, type SourceResolutionFailure, type SourceResolutionStatus } from './source-session-state.ts'
import { PaneReadingIntents, type PaneReadingIntent, type PaneReadingTarget } from './reading-intent.ts'
import type { SourceDiscovery } from '../source-discovery-types.ts'

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
    sourceMessageQuery?: string
    sourceRequestQuery?: string
    beforeRemove?: (resources: readonly PaneResource[]) => boolean
    /**
     * How long a restored pane waits for a calm catalog before an unresolved
     * target is reported instead of retried. Attaching a large HAPI catalog
     * keeps emitting events; production default is 30s.
     */
    catalogSettleMs?: number
    /** Acquire restored session references only when their window first becomes
     * visible. References already acquired keep their draft/scroll lifetime. */
    deferHiddenSessions?: boolean
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
    /** Bounded read-only preparation for an explicit sidebar hover/focus. */
    readonly warmSession?: (sessionId: SessionId) => void
}

export interface WorkspaceRenderOptions {
    paneId: string
    focused: boolean
    visible?: boolean
    /** The workspace's own menu outlet. The pane's official actions keep
     * their original graph owner when their launcher is placed here. */
    toolsTarget?: HTMLElement | null
}

export interface WorkspaceViewOptions {
    sessionId?: string
    beside?: SplitAxis
    kind?: string
    params?: NavigationValue
    /** Restore the address of a real existing official tab occurrence. */
    address?: string
    title?: string
    /** Related singleton tabs share a utility pane; their official tabs remain retained. */
    reuseTabs?: readonly string[]
}

export interface WorkspaceCatalogRow extends SessionSummary {
    readonly hostId: string
    readonly hostLabel: string
    /** The pane graph for this Host is registered and the Host is reachable. */
    readonly hostOnline: boolean
    readonly sourceSessionId: string
    /** Original HAPI machine liveness, distinct from the serving DSH Host. */
    readonly sourceMachineOnline?: boolean
    /** Original HAPI Hub connectivity, distinct from `hostOnline`. */
    readonly sourceHubOnline?: boolean
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
    /** Read-only rendering bridge until a same-source successor has a reference. */
    readonly previousReference?: SessionReference
    readonly resource?: Exclude<PaneResource, { kind: 'empty' }>
    readonly status: 'opening' | 'ready' | 'failed'
    /** Human explanation plus next step; never a raw code or JSON dump. */
    readonly error?: string
    /** Typed cause of an unresolved/failed pane target. */
    readonly reason?: PaneOpenFailure
    /** The concrete action that can resolve this state. */
    readonly nextStep?: string
    /** Raw identifiers/transport text for diagnostics only. */
    readonly detail?: string
    /** A manual retry is meaningful after the stated condition changes. */
    readonly retryable?: boolean
    /** Catalog arrival can recover this lease without a user retry. */
    readonly waitingForCatalog?: boolean
    /** Localized original-Hub loading and failure states, independent of directory size. */
    readonly sourceResolution?: SourceResolutionStatus
}

export interface WorkspaceSnapshot {
    readonly layout: WorkspaceState
    readonly catalog: WorkspaceCatalog
    /** Display labels survive a source's retired-to-successor Session gap. */
    readonly sourcePaneTitles: Readonly<Record<string, string>>
    /** Actual first source/Host discovery, independent of a temporarily empty catalog. */
    readonly catalogDiscovery: WorkspaceCatalogDiscovery
    readonly sourceDiscovery?: SourceDiscovery
    readonly leases: ReadonlyMap<string, PaneLease>
    readonly notice: string | null
    readonly persistence: 'local' | 'saving' | 'saved' | 'failed'
    readonly conflict: WorkspaceState | null
    readonly hasLayoutRecovery: boolean
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

type OriginalSource = { hubId: string; sourceSessionId: string }
interface SourceResolution {
    source: OriginalSource
    abort: AbortController
    phase: 'opening' | 'ready' | 'failed'
    work: Promise<void>
    error?: string
    failure?: SourceResolutionFailure
}
const originalSourceKey = (source: OriginalSource): string => JSON.stringify([source.hubId, source.sourceSessionId])

/** One user-facing sentence per unresolved pane; the raw detail stays separate. */
function paneFailureError(state: PaneOpenState): string {
    return `${state.message} ${state.nextStep}`
}

const sourceReference = (row: Pick<SessionSummary, 'projectionValues'> | undefined): { sourceSessionId: string; sourceHubId?: string } | null => {
    const source = sourceIdentity(row)
    return source ? { sourceSessionId: source.sessionId, ...(source.hubId ? { sourceHubId: source.hubId } : {}) } : null
}

/** The typed explanation that pairs with a structured original-source failure. */
function sourceResolutionTypedState(failure: SourceResolutionFailure): { reason: PaneOpenFailure; nextStep: string } {
    switch (failure) {
        case 'denied': return { reason: 'binding-denied', nextStep: 'Check the current account’s access to this original session, then retry.' }
        case 'removed': return { reason: 'source-not-found', nextStep: 'The original session was removed; close this pane or open another conversation from the sidebar.' }
        case 'not-found': return { reason: 'source-not-found', nextStep: 'Check the original Hub, then retry to continue opening the same conversation.' }
        case 'transport': return { reason: 'source-offline', nextStep: 'Restore the Hub/Runner connection, then retry.' }
        case 'not-ready': return { reason: 'source-not-found', nextStep: 'Retry to continue opening the same original conversation.' }
        case 'ambiguous': return { reason: 'source-hub-changed', nextStep: 'Choose the conversation from the unified sidebar.' }
        case 'identity': return { reason: 'source-hub-changed', nextStep: 'Open the conversation again from the unified sidebar to rebind this pane.' }
        default: return { reason: 'binding-failed', nextStep: 'Retry the pane; if it keeps failing, check the Host log.' }
    }
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
    private readonly previousLeases = new Map<string, { lease: PaneLease; timer: ReturnType<typeof setTimeout> }>()
    private readonly hosts = new Map<string, WorkspaceHost>()
    private readonly hostCatalogs = new Map<string, { label: string; catalog: SessionListState }>()
    private readonly hostUnsubscribers = new Map<string, Array<() => void>>()
    private readonly hostMainIds = new Map<string, string | undefined>()
    private readonly sourceCatalog = new Map<string, CatalogSession>()
    private readonly sourcePaneTitles = new Map<string, { sourceKey: string; title: string }>()
    private sourceCatalogRevision = 0
    private readonly aggregatedHosts = new Map<string, { inputs: readonly unknown[]; ids: SessionId[]; rows: WorkspaceCatalog['byId'] }>()
    private readonly discovery = new CatalogDiscovery()
    private discoveryCatalog: WorkspaceCatalog | undefined
    private sourceBindingsPending = 0
    private readonly paneCloseGuards = new Map<string, Set<() => boolean>>()
    private readonly reading = new PaneReadingIntents()
    private readonly lifetime = new AbortController()
    private snapshot: WorkspaceSnapshot
    private readonly unsubscribers: Array<() => void> = []
    private disposed = false
    private reconciling = false
    private navigationGuard = false
    private pendingNavigationResource: string | null = null
    private navigationRevision = 0
    private saving = false
    private remoteLoaded = false
    private remoteLoading = false
    private applyingRemote = false
    private confirmedLayout: WorkspaceState | undefined
    private recoveryLayout: WorkspaceState | undefined
    private readonly initialLayout: WorkspaceState
    private queuedSave: WorkspaceState | undefined
    private readonly restoredLocal: boolean
    private sharedSignature: string
    private pendingSourceSession: { sessionId: string; hubId?: string; target: PaneReadingTarget } | null
    private primarySourceHubId: string | null = null
    private sourceResolver: ((source: OriginalSource, signal: AbortSignal) => Promise<void>) | undefined
    private readonly sourceResolutions = new Map<string, SourceResolution>()
    private readonly sourceRequests = new Map<string, number>()
    private catalogChangedAt = Date.now()
    /** High-water mark of attached Sessions; only growth is catalog progress. */
    private catalogMaxIds = 0
    private settleTimer: ReturnType<typeof setTimeout> | undefined
    private readonly catalogSettleMs: number

    constructor(readonly options: WorkspaceOptions) {
        this.catalogSettleMs = Math.max(0, options.catalogSettleMs ?? 30_000)
        // The restore itself starts the settle window; a slow constructor must
        // not be mistaken for a calm catalog.
        this.catalogChangedAt = Date.now()
        const nextId = options.nextId ?? (() => randomId())
        let state = initialWorkspace(nextId)
        let notice: string | null = null
        let restored = false
        try {
            const raw = options.storage?.getItem(options.storageKey)
            if (raw) {
                const saved = JSON.parse(raw)
                state = parseWorkspaceState(saved); restored = true
                if (saved.syncBase) this.confirmedLayout = parseWorkspaceState(saved.syncBase)
                if (saved.layoutRecovery) this.recoveryLayout = parseWorkspaceState(saved.layoutRecovery)
            }
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
            target: options.sourceMessageQuery ? { kind: 'message', messageId: options.sourceMessageQuery, origin: 'link' }
                : options.sourceRequestQuery ? { kind: 'approval', requestId: options.sourceRequestQuery } : { kind: 'latest' },
            ...(options.sourceHubQuery === undefined ? {} : { hubId: options.sourceHubQuery }) } : null
        this.sidebar = new SidebarState(options.storage, `${options.storageKey}:sidebar`)
        this.hosts.set('local', { id: 'local', label: 'DSH', sessions: options.sessions, navigation: options.navigation,
            ...(options.workspaces ? { workspaces: options.workspaces } : {}),
            ...(options.workspaceState ? { workspaceState: options.workspaceState } : {}) })
        this.snapshot = {
            layout: this.store.getSnapshot(), catalog: this.aggregateCatalog(),
            sourcePaneTitles: {},
            catalogDiscovery: this.discovery.snapshot(options.sessions.list.getSnapshot().phase === 'ready'),
            leases: new Map(), notice, persistence: 'local', conflict: null, hasLayoutRecovery: Boolean(this.recoveryLayout),
            creation: null, creationContext: null, pickingSession: false, machines: [], nativePanel: null,
        }
        this.hostMainIds.set('local', this.selectedMain('local'))
        this.unsubscribers.push(this.store.subscribe(this.onLayout), options.sessions.list.subscribe(() => this.onCatalog('local')))
        if (options.workspaceState) this.unsubscribers.push(options.workspaceState.subscribe(() => this.publish({ catalog: this.aggregateCatalog() })))
        // The first classification must start from a fresh settle window even
        // when constructing the store took a while.
        this.catalogChangedAt = Date.now()
        this.reconcileLeases()
        // A restored workspace has deliberate selection; a first install follows
        // the already selected official Session, if there is one.
        const selected = this.hostMainIds.get('local')
        if (!restored && selected) this.openCatalogSession('local', selected)
        else this.syncNavigation()
        this.initialLayout = this.store.getSnapshot()
        if (options.persistence) void this.loadRemote()
        else { this.remoteLoaded = true; this.openPendingSource() }
    }

    getSnapshot = (): WorkspaceSnapshot => this.snapshot

    readingIntent = (paneId: string): PaneReadingIntent | undefined => this.reading.read(paneId)

    releaseHiddenHistory(paneId: string, reference: SessionReference): boolean {
        if (!this.options.deferHiddenSessions) return false
        const layout = this.store.getSnapshot(), active = layout.windows.find(window => window.id === layout.activeWindowId)
        const visible = active && panes(active.root).some(pane => pane.id === paneId
            && (!layout.zoomed[active.id] || layout.focused[active.id] === paneId))
        const lease = this.leases.get(paneId)
        if (visible || this.paneCloseGuards.get(paneId)?.size || lease?.reference?.binding !== reference.binding) return false
        this.leases.delete(paneId); lease.reference.release(); this.publish()
        return true
    }

    /** Explicit destinations belong to this view occurrence, never global focus. */
    locateInPane(paneId: string, sessionId: string, target: PaneReadingTarget): void {
        const pane = this.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.id === paneId)
        if (!pane || pane.resource.kind === 'empty' || pane.resource.sessionId !== sessionId) return
        this.navigationRevision++
        this.pendingSourceSession = null
        this.reading.request(paneId, sessionId, target)
        this.publish()
    }

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
        const focused = this.store.focusedPane().resource
        const creationContext = context ? { ...context }
            : this.snapshot.creation === 'choose' && engine !== 'choose' ? this.snapshot.creationContext
            : sessionCreationContext(focused.kind === 'empty' ? undefined : this.snapshot.catalog.byId[focused.sessionId])
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
    setMachines(machines: readonly CatalogMachine[]): void {
        // Machine identity, not a hostname shared by multiple real machines.
        const unique = new Map<string, CatalogMachine>()
        for (const machine of machines) {
            const previous = unique.get(machine.id)
            if (!previous || Number(machine.online) > Number(previous.online)
                || machine.online === previous.online && (machine.lastSeenAt ?? 0) >= (previous.lastSeenAt ?? 0)) unique.set(machine.id, machine)
        }
        this.snapshot = { ...this.snapshot, machines: [...unique.values()] }
        this.publish({ catalog: this.aggregateCatalog() })
    }
    setSourceCatalog(sessions: readonly CatalogSession[], hubId?: string, discovery?: {
        hosts: readonly { id: string; label: string; online: boolean }[]; connected: boolean; sourceDiscovery?: SourceDiscovery
    }): void {
        if (hubId) this.primarySourceHubId = hubId
        // Only real catalog movement resets the settle window; the 3s poll is
        // not itself progress.
        const connected = discovery?.connected ?? true
        const changed = sessions.length !== this.sourceCatalog.size
            || (connected ? 'ready' : 'unavailable') !== this.discovery.sourcePhase
            || sessions.some(session => {
                const previous = this.sourceCatalog.get(session.id)
                return previous === undefined || previous.displayRevision !== session.displayRevision
                    || previous.lifecycleState !== session.lifecycleState || previous.active !== session.active
            })
        this.sourceCatalogRevision++
        this.discoveryCatalog = undefined
        this.sourceCatalog.clear()
        for (const session of sessions) this.sourceCatalog.set(session.id, session)
        this.discovery.observe(discovery?.hosts ?? [], connected)
        if (discovery?.sourceDiscovery) this.snapshot = { ...this.snapshot, sourceDiscovery: discovery.sourceDiscovery }
        if (changed) this.catalogChangedAt = Date.now()
        this.publish({ catalog: this.aggregateCatalog() })
        const state = this.store.getSnapshot(), rebound = bindSourceResources(state, this.snapshot.catalog.byId, this.sourceBindingScope())
        if (rebound !== state) this.store.replace(rebound)
        else this.reconcileLeases()
        this.openPendingSource()
    }
    sourceCatalogFailed(error: unknown): void {
        this.discovery.sourceFailed(errorMessage(error))
        if (this.snapshot.sourceDiscovery) this.snapshot = { ...this.snapshot, sourceDiscovery: {
            ...this.snapshot.sourceDiscovery, phase: this.snapshot.sourceDiscovery.observedAt === null ? 'unavailable' : 'stale', error: errorMessage(error),
        } }
        this.catalogChangedAt = Date.now()
        this.publish()
        if (this.hasWaitingLeases()) this.reconcileLeases()
    }
    catalogHostReady(id: string, label: string): void {
        this.discovery.hostReady(id, label)
        this.catalogChangedAt = Date.now()
        this.publish()
    }
    catalogHostFailed(id: string, label: string, error: unknown): void {
        this.discovery.hostFailed(id, label, errorMessage(error))
        this.catalogChangedAt = Date.now()
        this.publish()
        if (this.hasWaitingLeases()) this.reconcileLeases()
    }
    private hasWaitingLeases(): boolean { return [...this.leases.values()].some(lease => lease.waitingForCatalog) }
    openNativeLibrary = (): void => { this.publish({ nativePanel: { kind: 'library' }, creation: null, creationContext: null, pickingSession: false }); this.options.reveal?.() }
    openNativeTools = (sessionId: string, initialAction?: 'fork' | 'archive' | 'reopen' | 'pin' | 'restart' | 'delete'): void => {
        this.publish({ nativePanel: { kind: 'session', sessionId, ...(initialAction ? { initialAction } : {}) }, pickingSession: false }); this.options.reveal?.()
    }
    closeNativePanel = (): void => { this.publish({ nativePanel: null }) }

    /** One original-Hub loader; all saved panes share its exact source request. */
    installSourceResolver(resolve: (source: OriginalSource, signal: AbortSignal) => Promise<void>): () => void {
        if (this.sourceResolver) throw new Error('The original session resolver is already installed')
        this.sourceResolver = resolve
        this.reconcileLeases(); this.openPendingSource()
        return () => {
            if (this.sourceResolver !== resolve) return
            this.sourceResolver = undefined
            for (const entry of this.sourceResolutions.values()) entry.abort.abort()
            this.sourceResolutions.clear()
        }
    }

    private originalSource(resource: Exclude<PaneResource, { kind: 'empty' }>): OriginalSource | undefined {
        const hubId = resource.sourceHubId ?? this.primarySourceHubId
        return resource.sourceSessionId && hubId ? { hubId, sourceSessionId: resource.sourceSessionId } : undefined
    }

    private sourceBindingScope(): { primaryHubId?: string; requireHub: true } {
        return { requireHub: true, ...(this.primarySourceHubId ? { primaryHubId: this.primarySourceHubId } : {}) }
    }

    private resolveSource(source: OriginalSource): SourceResolution | undefined {
        const resolver = this.sourceResolver
        if (!resolver || this.disposed) return undefined
        const key = originalSourceKey(source), current = this.sourceResolutions.get(key)
        if (current) return current
        const entry: SourceResolution = { source: Object.freeze({ ...source }), abort: new AbortController(), phase: 'opening', work: Promise.resolve() }
        this.sourceResolutions.set(key, entry)
        const active = (): boolean => !this.disposed && !entry.abort.signal.aborted && this.sourceResolutions.get(key) === entry
        entry.work = Promise.resolve().then(() => {
            entry.abort.signal.throwIfAborted()
            return resolver(entry.source, AbortSignal.any([this.lifetime.signal, entry.abort.signal]))
        }).then(() => {
            if (!active()) return
            entry.phase = 'ready'
            const state = this.store.getSnapshot(), rebound = bindSourceResources(state, this.snapshot.catalog.byId, this.sourceBindingScope())
            if (rebound !== state) this.store.replace(rebound)
            else this.reconcileLeases()
            this.openPendingSource()
        }, error => {
            if (!active()) return
            entry.phase = 'failed'; entry.error = errorMessage(error); entry.failure = sourceResolutionFailure(error)
            this.reconcileLeases()
            throw error
        })
        // Restored panes are background callers; explicit navigation still awaits work.
        void entry.work.catch(() => {})
        return entry
    }

    private pruneSourceResolutions(resources: Iterable<Exclude<PaneResource, { kind: 'empty' }>>): void {
        const needed = new Set(this.sourceRequests.keys())
        for (const resource of resources) {
            const source = this.originalSource(resource)
            if (source) needed.add(originalSourceKey(source))
        }
        const pendingHub = this.pendingSourceSession?.hubId ?? this.primarySourceHubId
        if (this.pendingSourceSession && pendingHub) needed.add(originalSourceKey({ hubId: pendingHub, sourceSessionId: this.pendingSourceSession.sessionId }))
        for (const [key, entry] of this.sourceResolutions) if (!needed.has(key)) {
            this.sourceResolutions.delete(key); entry.abort.abort()
        }
    }

    private publish(patch: Partial<WorkspaceSnapshot> = {}): void {
        if (this.disposed) return
        const leases = new Map(this.leases)
        for (const [paneId, previous] of this.previousLeases) {
            const lease = leases.get(paneId)
            if (lease?.reference || lease?.status === 'failed' || !lease) this.releasePreviousLease(paneId)
            else leases.set(paneId, { ...lease, previousReference: previous.lease.reference! })
        }
        this.snapshot = { ...this.snapshot, ...patch, layout: this.store.getSnapshot(), leases }
        this.rememberSourcePaneTitles()
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

    private rememberSourcePaneTitles(): void {
        const titles: Record<string, string> = {}, present = new Set<string>()
        for (const pane of this.snapshot.layout.windows.flatMap(window => panes(window.root))) {
            present.add(pane.id)
            const resource = pane.resource
            if (resource.kind === 'empty') { this.sourcePaneTitles.delete(pane.id); continue }
            const row = this.snapshot.catalog.byId[resource.sessionId], identity = sourceIdentity(row)
            const hubId = resource.sourceHubId ?? identity?.hubId, sourceSessionId = resource.sourceSessionId ?? identity?.sessionId
            if (!hubId || !sourceSessionId) { this.sourcePaneTitles.delete(pane.id); continue }
            const sourceKey = originalSourceKey({ hubId, sourceSessionId }), previous = this.sourcePaneTitles.get(pane.id)
            let source = hubId === this.primarySourceHubId ? this.sourceCatalog.get(resource.sessionId) : undefined
            if (source?.hapiSessionId !== sourceSessionId) source = undefined
            if (!source && hubId === this.primarySourceHubId) {
                for (const candidate of this.sourceCatalog.values()) if (candidate.hapiSessionId === sourceSessionId) { source = candidate; break }
            }
            const sourceTitle = source?.title.trim()
            const sameSource = identity ? identity.hubId === hubId && identity.sessionId === sourceSessionId
                : previous?.sourceKey === sourceKey || source?.id === row?.sourceSessionId
            const currentTitle = sameSource ? row?.title?.trim() : undefined
            const title = currentTitle || (previous?.sourceKey === sourceKey ? previous.title : undefined)
                || (sourceTitle && sourceTitle !== sourceSessionId && sourceTitle !== source!.id ? sourceTitle : undefined)
            if (title) { this.sourcePaneTitles.set(pane.id, { sourceKey, title }); titles[pane.id] = title }
            else this.sourcePaneTitles.delete(pane.id)
        }
        for (const paneId of this.sourcePaneTitles.keys()) if (!present.has(paneId)) this.sourcePaneTitles.delete(paneId)
        this.snapshot = { ...this.snapshot, sourcePaneTitles: titles }
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
        // Attaching a Session is catalog progress; an update to an existing
        // row (tokens, titles, retainedBy) is not and must not keep a genuinely
        // deleted pane in the loading state forever.
        if (catalog.ids.length > this.catalogMaxIds) {
            this.catalogMaxIds = catalog.ids.length
            this.catalogChangedAt = Date.now()
        }
        this.publish({ catalog })
        if (this.navigationGuard || this.reconciling) return
        const current = this.store.getSnapshot()
        const rebound = bindSourceResources(current, catalog.byId, this.sourceBindingScope())
        if (current !== rebound) this.store.replace(rebound)
        if (this.openPendingSource()) return
        this.reconcileLeases()
        const focused = this.store.focusedPane().resource
        // Catalog hydration on another Host is not an explicit pane selection.
        if (focused.kind !== 'empty') {
            try {
                if (parseSessionResourceId(focused.sessionId).hostId !== hostId) {
                    this.hostMainIds.set(hostId, this.selectedMain(hostId))
                    return
                }
            } catch { return /* The failed lease already explains the invalid saved address. */ }
        }
        if (focused.kind !== 'empty' && focused.sessionId === this.pendingNavigationResource) {
            try {
                if (parseSessionResourceId(focused.sessionId).hostId === hostId) {
                    // Restoration owns this selection until its own catalog
                    // arrives and confirms its main reference. An initial
                    // official main-view restore must not replace any saved
                    // terminal, document or plugin resource with a chat pane.
                    this.syncNavigation()
                    return
                }
            } catch { /* Invalid saved addresses already have a failed lease. */ }
        }
        const mainId = this.selectedMain(hostId)
        // Releasing an old main reference before an asynchronous replacement
        // arrives is not a navigation command or a request to clear a pane.
        if (!mainId || mainId === this.hostMainIds.get(hostId)) return
        this.hostMainIds.set(hostId, mainId)
        const resourceId = sessionResourceId(hostId, mainId)
        // A restored document, terminal or plugin pane for this same Session is
        // not a request to replace it with a chat pane.
        if (focused.kind !== 'empty' && focused.sessionId === resourceId) return
        this.openCatalogSession(hostId, mainId)
    }

    /** Opening from any catalog path persists the original identity when known. */
    private openCatalogSession(hostId: string, sessionId: string): void {
        const resourceId = sessionResourceId(hostId, sessionId)
        const reference = sourceReference(this.snapshot.catalog.byId[resourceId])
        this.store.openResource({ kind: 'chat', sessionId: resourceId, ...(reference ?? {}) })
    }

    private aggregateCatalog(): WorkspaceCatalog {
        for (const host of this.hosts.values()) this.hostCatalogs.set(host.id, { label: host.label, catalog: host.sessions.list.getSnapshot() })
        const ids: SessionId[] = []
        const byId: WorkspaceCatalog['byId'] = {}
        let phase: SessionListState['phase'] = 'ready'
        for (const [hostId, cached] of this.hostCatalogs) {
            const host = this.hosts.get(hostId)
            if (host && cached.catalog.phase === 'pending') phase = 'pending'
            // `hostOnline` is registration plus reachability, never registration alone:
            // a pane graph can outlive the machine's catalog connection briefly.
            const hostOnline = host !== undefined && (hostId === 'local' || this.discovery.host(hostId)?.phase !== 'unavailable')
            const workspace = host?.workspaceState?.getSnapshot()
            const inputs = [cached.catalog, cached.label, hostOnline, workspace,
                hostId === 'local' ? this.sourceCatalogRevision : 0,
                hostId === 'local' ? this.snapshot?.machines : undefined,
                hostId === 'local' ? this.discovery.sourcePhase : undefined]
            const previous = this.aggregatedHosts.get(hostId)
            if (previous && inputs.every((value, index) => value === previous.inputs[index])) {
                Object.assign(byId, previous.rows); ids.push(...previous.ids); continue
            }
            const hostRows: WorkspaceCatalog['byId'] = {}
            const archived = new Set(workspace?.archivedSessionIds ?? [])
            const pinned = new Set(workspace?.pinnedSessionIds ?? [])
            for (const [sourceSessionId, row] of Object.entries(cached.catalog.byId)) {
                const resourceId = sessionResourceId(hostId, sourceSessionId)
                const source = hostId === 'local' ? this.sourceCatalog.get(sourceSessionId) : undefined
                const sourceOwned = hostId === 'local' && (sourceIdentity(row) !== null || isSourceChild(row))
                // Reconnection clears official projections before their new
                // baseline arrives. Keep a source display's title through
                // that gap: current durable title, source catalog, then its
                // last known title. This changes labels only, never identity.
                const sourceTitle = source?.title.trim()
                const title = hostId === 'local' && (source !== undefined || isSourceDisplaySessionId(sourceSessionId))
                    ? row.title?.trim() || (sourceTitle && sourceTitle !== source!.hapiSessionId && sourceTitle !== source!.id ? sourceTitle : undefined)
                        || previous?.rows[resourceId]?.title
                    : undefined
                const sourceLocation = sourceOwned ? sessionLocation(row) : undefined
                const sourceMachine = sourceLocation?.machineId ? (this.snapshot?.machines ?? []).find(machine => machine.id === sourceLocation.machineId) : undefined
                hostRows[resourceId] = { ...row, id: resourceId as SessionId, hostId, hostLabel: cached.label, hostOnline,
                    ...(title ? { title, displayTitle: title } : {}),
                    ...(sourceOwned ? { sourceHubOnline: this.discovery.sourcePhase !== 'unavailable',
                        ...(sourceMachine ? { sourceMachineOnline: sourceMachine.online } : {}) } : {}),
                    ...(sourceOwned && Number.isFinite(source?.updatedAt) ? { updatedAt: source!.updatedAt! } : {}),
                    ...(sourceOwned && typeof source?.active === 'boolean' ? { sourceActive: source.active } : {}),
                    ...(sourceOwned && source?.lifecycleState !== undefined ? { sourceLifecycleState: source.lifecycleState } : {}),
                    ...(sourceOwned && source ? { sourceCreatedAt: source.sourceCreatedAt ?? null, sourceLastActiveAt: source.sourceLastActiveAt ?? null, sourceSummary: source.sourceSummary ?? null, sourceWorktree: source.sourceWorktree ?? null, sourceSubagentSearch: source.sourceSubagentSearch ?? [],
                        ...(source.sourceListFacts ? { sourceListFacts: source.sourceListFacts } : {}),
                        ...(source.sourceRowState ? { sourceRowState: source.sourceRowState } : {}) } : {}),
                    sourceSessionId,
                    // A source-owned row is archived by the original HAPI lifecycle,
                    // not by a DSH display bookmark that never applies to it.
                    archived: sourceOwned ? source?.lifecycleState === 'archived' : archived.has(sourceSessionId),
                    pinned: sourceOwned ? source?.pinMode === 'project' || source?.pinMode === 'global' : pinned.has(sourceSessionId),
                    ...(sourceOwned ? { sourcePinMode: source?.pinMode ?? 'none' } : {}),
                }
            }
            const hostIds = cached.catalog.ids.map(id => sessionResourceId(hostId, id) as SessionId)
            this.aggregatedHosts.set(hostId, { inputs, ids: hostIds, rows: hostRows })
            Object.assign(byId, hostRows); ids.push(...hostIds)
        }
        for (const id of this.aggregatedHosts.keys()) if (!this.hostCatalogs.has(id)) this.aggregatedHosts.delete(id)
        const previous = this.snapshot?.catalog
        if (previous && phase === previous.phase && ids.length === previous.ids.length
            && ids.every((id, index) => id === previous.ids[index])
            && Object.keys(byId).length === Object.keys(previous.byId).length
            && Object.entries(byId).every(([id, row]) => row === previous.byId[id])) return previous
        return { ids, byId, phase, projectionsBySession: {} }
    }

    /** Add an independently booted Host; never pass its reference into another Host's provider. */
    addHost(host: WorkspaceHost): () => void {
        if (this.disposed) throw new Error('The workspace is disposed')
        if (!host.id || host.id === 'local' || this.hosts.has(host.id)) throw new Error('Duplicate or invalid Host identity')
        if (!host.renderConversation) throw new Error('A remote Host must provide its own Conversation renderer')
        this.hosts.set(host.id, host)
        this.hostMainIds.set(host.id, this.selectedMain(host.id))
        this.catalogChangedAt = Date.now()
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
            this.catalogChangedAt = Date.now()
            for (const [paneId, lease] of this.leases) {
                if (lease.hostId !== host.id) continue
                // The machine disconnected. A view that was already open keeps
                // its reference; an unresolved target explains the reconnect path.
                const failure = paneOpenState({ kind: 'display', label: host.label,
                    hostId: host.id, sessionId: lease.sessionId, sourcePhase: this.discovery.sourcePhase, currentHubId: this.primarySourceHubId,
                    localPhase: 'ready', hostRegistered: false, hostOnline: false, settled: true })
                this.leases.set(paneId, { hostId: host.id, sessionId: lease.sessionId, status: 'failed',
                    error: paneFailureError(failure), reason: failure.reason, nextStep: failure.nextStep, detail: failure.detail,
                    retryable: true, waitingForCatalog: true })
                lease.reference?.release()
            }
            this.publish({ catalog: this.aggregateCatalog() })
        }
    }

    host(hostId: string): WorkspaceHost | undefined { return this.hosts.get(hostId) }
    /** Replace only a Host's rendering face; catalogs and references stay owned. */
    bindRenderer(hostId: string, renderPane: NonNullable<WorkspaceHost['renderPane']>, warmSession?: WorkspaceHost['warmSession']): () => void {
        const previous = this.hosts.get(hostId)
        if (!previous) throw new Error('The pane Host is unavailable')
        const host = { ...previous, renderPane, ...(warmSession ? { warmSession } : {}) }
        this.hosts.set(hostId, host); this.publish()
        return () => { if (this.hosts.get(hostId) === host) { this.hosts.set(hostId, previous); this.publish() } }
    }
    availableHosts(): Array<{ id: string; label: string }> { return [...this.hosts.values()].map(({ id, label }) => ({ id, label })) }

    /** Preparation never changes selection, creates a pane, or sends a task. */
    preloadSession = (resourceId: string): void => {
        if (this.disposed) return
        try {
            const { host, sessionId } = this.source(resourceId)
            host.warmSession?.(sessionId as SessionId)
        } catch { /* The deliberate open owns any unavailable-Host error. */ }
    }

    source(resourceId: string): { host: WorkspaceHost; sessionId: string } {
        const { hostId, sessionId } = parseSessionResourceId(resourceId)
        const host = this.hosts.get(hostId)
        if (!host) throw new Error(`Host is offline: ${this.hostCatalogs.get(hostId)?.label ?? hostId}`)
        return { host, sessionId }
    }

    private onLayout = (): void => {
        const state = this.store.getSnapshot()
        const previous = new Map(this.snapshot.layout.windows.flatMap(window => panes(window.root).map(pane => [pane.id, pane.resource] as const)))
        // A reconciled display generation still represents the same original
        // source. Keep an explicit destination when bindSourceResources moves
        // that pane, before its replacement SessionReference is published.
        for (const pane of state.windows.flatMap(window => panes(window.root))) {
            const before = previous.get(pane.id), after = pane.resource, intent = this.reading.read(pane.id)
            if (!before || before.kind === 'empty' || after.kind === 'empty' || !intent || intent.target.kind === 'latest'
                || intent.sessionId !== before.sessionId || before.sessionId === after.sessionId) continue
            if (before.sourceSessionId && before.sourceSessionId === after.sourceSessionId && before.sourceHubId === after.sourceHubId) {
                this.reading.request(pane.id, after.sessionId, intent.target)
            }
        }
        this.reconcileLeases()
        this.syncNavigation()
        this.reading.retain(new Set(state.windows.flatMap(window => panes(window.root).map(pane => pane.id))))
        this.saveLocal()
        const signature = sharedWorkspaceSignature(state)
        if (!this.applyingRemote && this.options.persistence && signature !== this.sharedSignature) {
            this.queuedSave = sharedWorkspaceState(state)
            if (this.remoteLoaded) void this.flushRemote()
        }
        this.sharedSignature = signature
        this.publish()
    }

    /** True once no catalog event has arrived for the settle window. */
    private catalogSettled(now = Date.now()): boolean {
        return now - this.catalogChangedAt >= this.catalogSettleMs
    }

    /**
     * A restored pane that is not listed yet stays `opening` while the catalog
     * is still busy; only a calm catalog turns an absence into a reported
     * cause. The timer exists solely to convert that last transient state.
     */
    private scheduleSettleCheck(): void {
        if (this.disposed || this.settleTimer !== undefined) return
        const waiting = [...this.leases.values()].some(lease => lease.waitingForCatalog)
        if (!waiting || this.catalogSettled()) return
        const delay = Math.max(0, this.catalogSettleMs - (Date.now() - this.catalogChangedAt)) + 10
        this.settleTimer = setTimeout(() => {
            this.settleTimer = undefined
            this.reconcileLeases()
        }, delay)
    }

    private hostLabel(hostId: string): string {
        return this.hosts.get(hostId)?.label ?? this.hostCatalogs.get(hostId)?.label ?? this.discovery.host(hostId)?.label ?? ''
    }

    private paneOpenContext(hostId: string, sessionId: string, resource: Exclude<PaneResource, { kind: 'empty' }>): PaneOpenContext {
        const catalogRow = this.snapshot.catalog.byId[sessionId]
        const host = this.hosts.get(hostId)
        const machineId = catalogRow ? sessionLocation(catalogRow).machineId : undefined
        const machine = machineId ? this.snapshot.machines.find(entry => entry.id === machineId) : undefined
        const localPhase = this.options.sessions.list.getSnapshot().phase === 'ready' ? 'ready' : 'pending'
        const archived = catalogRow?.archived === true
            || (host?.workspaceState?.getSnapshot().archivedSessionIds ?? []).includes(sessionId)
        return {
            kind: resource.sourceSessionId ? 'source' : 'display',
            label: this.hostLabel(hostId),
            hostId, sessionId,
            ...(resource.sourceSessionId ? { sourceSessionId: resource.sourceSessionId } : {}),
            ...(resource.sourceHubId ? { savedHubId: resource.sourceHubId } : {}),
            currentHubId: this.primarySourceHubId,
            sourcePhase: this.discovery.sourcePhase,
            sourceError: this.discovery.sourceFailure,
            localPhase,
            hostRegistered: host !== undefined,
            hostOnline: host !== undefined && (hostId === 'local' || this.discovery.host(hostId)?.phase !== 'unavailable'),
            settled: this.catalogSettled(),
            ...(archived ? { archived: true } : {}),
            ...(catalogRow?.sourceLifecycleState !== undefined ? { sourceLifecycle: catalogRow.sourceLifecycleState } : {}),
            ...(machine ? { machineLabel: machine.label, machineOnline: machine.online } : {}),
        }
    }

    private markPaneUnavailable(paneId: string, hostId: string, sessionId: string, resource: Exclude<PaneResource, { kind: 'empty' }>,
        resolution?: SourceResolution, ambiguous = false): void {
        const state = paneOpenState(this.paneOpenContext(hostId, sessionId, resource))
        if (resource.sourceSessionId && (resolution !== undefined || ambiguous)) {
            // Structured original-source acquisition owns this pane's copy. The
            // typed message/next step stays on the lease for other surfaces; the
            // raw resolver error is the expandable technical detail.
            if (ambiguous) {
                const typed = sourceResolutionTypedState('ambiguous')
                this.leases.set(paneId, { hostId, sessionId, status: 'failed', sourceResolution: 'ambiguous',
                    error: `This original session has multiple display bindings. Its saved reference is preserved.${state.detail ? ` · ${state.detail}` : ''}`,
                    reason: typed.reason, nextStep: typed.nextStep, detail: state.detail, retryable: true, waitingForCatalog: true })
                return
            }
            if (resolution!.phase === 'failed') {
                const failure = resolution!.failure ?? 'unknown'
                const typed = sourceResolutionTypedState(failure)
                this.leases.set(paneId, { hostId, sessionId, status: 'failed', sourceResolution: failure,
                    error: resolution!.error ?? failure, reason: typed.reason, nextStep: typed.nextStep, detail: state.detail,
                    retryable: true, waitingForCatalog: true })
                return
            }
            if (resolution!.phase === 'opening' || !this.catalogSettled()) {
                this.leases.set(paneId, { hostId, sessionId, status: 'opening', sourceResolution: 'loading',
                    reason: state.reason, nextStep: state.nextStep, detail: state.detail, retryable: true, waitingForCatalog: true })
                return
            }
            // The exact source was acquired, but this graph's own official catalog
            // has not projected its display yet. A retry continues the same request.
            this.leases.set(paneId, { hostId, sessionId, status: 'failed', sourceResolution: 'not-ready',
                error: state.detail || state.message, reason: 'source-not-found', nextStep: 'Retry to continue opening the same original conversation.',
                detail: state.detail, retryable: true, waitingForCatalog: true })
            return
        }
        // Without a structured resolver the typed classifier owns the copy; an
        // installed resolver still uses its localized loading state while waiting.
        const loading: SourceResolutionStatus | undefined = resource.sourceSessionId && this.sourceResolver && state.transient ? 'loading' : undefined
        this.leases.set(paneId, state.transient
            ? { hostId, sessionId, status: 'opening', reason: state.reason, nextStep: state.nextStep, detail: state.detail, retryable: state.retryable, waitingForCatalog: true,
                ...(loading ? { sourceResolution: loading } : {}) }
            : { hostId, sessionId, status: 'failed', error: paneFailureError(state), reason: state.reason, nextStep: state.nextStep, detail: state.detail, retryable: state.retryable, waitingForCatalog: state.retryable })
    }

    private releasePreviousLease(paneId: string): void {
        const previous = this.previousLeases.get(paneId)
        if (!previous) return
        this.previousLeases.delete(paneId); clearTimeout(previous.timer); previous.lease.reference?.release()
    }

    private reconcileLeases(): void {
        if (this.disposed || this.reconciling) return
        this.reconciling = true
        try {
            // Re-bind saved identities before classifying anything: a display
            // generation (`-rN`) is a resolvable rename, an imported legacy
            // identity may receive its confirmed Hub, and neither is a deleted
            // session. An already-saved Hub is never replaced.
            const current = this.store.getSnapshot()
            const rebound = bindSourceResources(current, this.snapshot.catalog.byId, this.sourceBindingScope())
            if (rebound !== current) this.store.replace(rebound)
            const layout = this.store.getSnapshot()
            const expected = new Map(layout.windows.flatMap(window => panes(window.root))
                .flatMap(pane => pane.resource.kind !== 'empty' ? [[pane.id, pane.resource] as const] : []))
            const active = layout.windows.find(window => window.id === layout.activeWindowId)
            const visible = new Set((active ? panes(active.root) : []).filter(pane => !layout.zoomed[layout.activeWindowId]
                || pane.id === layout.focused[layout.activeWindowId]).map(pane => pane.id))
            this.pruneSourceResolutions(expected.values())
            for (const [id, previous] of this.previousLeases) {
                if (!sameSourceGeneration(previous.lease.resource, expected.get(id))) this.releasePreviousLease(id)
            }
            // A same-source generation can have a short catalog gap. Keep one
            // read-only rendering reference; the surface owns the later swap.
            for (const [id, lease] of this.leases) {
                if (expected.get(id)?.sessionId !== sessionResourceId(lease.hostId, lease.sessionId)) {
                    this.leases.delete(id)
                    if (lease.reference && lease.status === 'ready' && sameSourceGeneration(lease.resource, expected.get(id))) {
                        this.releasePreviousLease(id)
                        const timer = setTimeout(() => { this.releasePreviousLease(id); this.publish() }, 30_000)
                        this.previousLeases.set(id, { lease, timer })
                    } else lease.reference?.release()
                } else if (lease.reference && lease.resource !== expected.get(id)) {
                    this.leases.set(id, { ...lease, resource: expected.get(id)! })
                }
            }
            for (const [paneId, resource] of expected) {
                const previous = this.leases.get(paneId)
                // Parked restore entries retain their durable resource identity
                // without opening history, invoking a source resolver, or
                // reporting a missing-session failure before first visibility.
                // An already retained pane keeps its generation while hidden.
                if (this.options.deferHiddenSessions && !visible.has(paneId) && !previous?.reference) continue
                if (previous && !previous.waitingForCatalog) continue
                let hostId = 'local'
                let sessionId = resource.sessionId
                try {
                    ;({ hostId, sessionId } = parseSessionResourceId(resource.sessionId))
                } catch (error) {
                    const failure = invalidPaneAddressState(resource.sessionId, error)
                    this.leases.set(paneId, { hostId, sessionId, status: 'failed', error: paneFailureError(failure),
                        reason: failure.reason, nextStep: failure.nextStep, detail: failure.detail, retryable: false })
                    continue
                }
                const host = this.hosts.get(hostId)
                try {
                    const source = this.originalSource(resource)
                    if (resource.sourceSessionId && (!source || !sourceRow({ ...resource, sourceHubId: source.hubId }, this.snapshot.catalog.byId))) {
                        const matches = source ? this.sourceMatches({ sessionId: source.sourceSessionId, hubId: source.hubId }) : []
                        // A saved Hub that is not the configured Hub is a different identity:
                        // never request it, and never adopt another Hub's same-id session.
                        const foreignHub = source !== undefined && resource.sourceHubId !== undefined
                            && this.primarySourceHubId !== null && resource.sourceHubId !== this.primarySourceHubId
                        const resolution = source && !foreignHub && matches.length === 0 ? this.resolveSource(source) : undefined
                        this.markPaneUnavailable(paneId, hostId, sessionId, resource, resolution, matches.length > 1)
                        continue
                    }
                    if (!host) {
                        this.markPaneUnavailable(paneId, hostId, sessionId, resource)
                        continue
                    }
                    const catalog = host.sessions.list.getSnapshot()
                    if (!catalog.byId[sessionId as SessionId]) {
                        this.markPaneUnavailable(paneId, hostId, sessionId, resource)
                        continue
                    }
                    const reference = host.sessions.retain(sessionId as SessionId, { source: 'hapiWorkspace' })
                    const lease: PaneLease = { hostId, sessionId, reference, resource, status: 'opening' }
                    this.leases.set(paneId, lease)
                    void reference.ready.then(() => {
                        const current = this.leases.get(paneId)
                        if (this.disposed || current?.reference !== reference) return
                        this.leases.set(paneId, { ...current, status: 'ready' })
                        this.publish()
                    }, error => {
                        const current = this.leases.get(paneId)
                        if (this.disposed || current?.reference !== reference) return
                        const failure = bindingFailureState({ ...this.paneOpenContext(hostId, sessionId, resource), error: errorMessage(error) })
                        this.leases.set(paneId, { ...current, status: 'failed', error: paneFailureError(failure),
                            reason: failure.reason, nextStep: failure.nextStep, detail: failure.detail, retryable: true, waitingForCatalog: true })
                        this.publish()
                    })
                } catch (error) {
                    const failure = bindingFailureState({ ...this.paneOpenContext(hostId, sessionId, resource), error: errorMessage(error) })
                    this.leases.set(paneId, { hostId, sessionId, status: 'failed', error: paneFailureError(failure),
                        reason: failure.reason, nextStep: failure.nextStep, detail: failure.detail, retryable: true, waitingForCatalog: true })
                }
            }
        } finally { this.reconciling = false }
        this.publish({ catalog: this.aggregateCatalog() })
        this.scheduleSettleCheck()
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
        const confirmed = (): boolean => (host.sessions.list.getSnapshot().byId[id as SessionId]?.retainedBy.mainView ?? 0) > 0
        if (this.hostMainIds.get(hostId) === id) {
            this.pendingNavigationResource = confirmed() ? null : focused.resource.sessionId
            return
        }
        const previous = this.hostMainIds.get(hostId)
        // openSession starts an asynchronous public SessionReference. Keep
        // the restore intent until the catalog observes that actual reference.
        this.pendingNavigationResource = focused.resource.sessionId
        this.hostMainIds.set(hostId, id)
        this.navigationGuard = true
        try { host.navigation.openSession(id as SessionId) }
        catch (error) { this.hostMainIds.set(hostId, previous); this.publish({ notice: errorMessage(error) }) }
        finally {
            this.navigationGuard = false
            if (this.hostMainIds.get(hostId) === id && confirmed()) this.pendingNavigationResource = null
        }
    }

    openSession(sessionId: string, beside?: SplitAxis, target: PaneReadingTarget = { kind: 'latest' }): void {
        this.navigationRevision++
        this.pendingSourceSession = null
        this.store.openResource({ kind: 'chat', sessionId, ...(sourceReference(this.snapshot.catalog.byId[sessionId]) ?? {}) }, beside)
        const pane = this.store.focusedPane()
        // A dirty document may veto replacement. A denied navigation must not
        // move its scroll position or leave work scheduled for another view.
        if (pane.resource.kind !== 'chat' || pane.resource.sessionId !== sessionId) return
        this.reading.request(pane.id, sessionId, target)
        this.publish()
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
    async openSourceSession(source: { hubId: string; sessionId: string; messageId?: string; requestId?: string }): Promise<void> {
        if (!source.hubId.trim() || !source.sessionId.trim()) throw new Error('A source conversation requires both its Hub and session identity')
        const revision = ++this.navigationRevision
        const target: PaneReadingTarget = source.messageId ? { kind: 'message', messageId: source.messageId, origin: 'notification' }
            : source.requestId ? { kind: 'approval', requestId: source.requestId } : { kind: 'latest' }
        let matches = this.sourceMatches(source)
        if (matches.length === 0 && this.sourceResolver) {
            const original = { hubId: source.hubId, sourceSessionId: source.sessionId }, key = originalSourceKey(original)
            const failed = this.sourceResolutions.get(key)
            if (failed?.phase === 'failed') { this.sourceResolutions.delete(key); failed.abort.abort() }
            this.sourceRequests.set(key, (this.sourceRequests.get(key) ?? 0) + 1)
            try { await this.resolveSource(original)!.work }
            finally {
                const count = (this.sourceRequests.get(key) ?? 1) - 1
                if (count) this.sourceRequests.set(key, count)
                else this.sourceRequests.delete(key)
            }
            matches = this.sourceMatches(source)
        }
        if (this.disposed) throw new Error('The workspace is closed')
        if (matches.length !== 1) { await this.refresh(); matches = this.sourceMatches(source) }
        if (this.disposed) throw new Error('The workspace is closed')
        if (matches.length !== 1) throw new Error(matches.length > 1
            ? 'This source conversation has multiple display bindings. Choose its Host in the unified sidebar.'
            : 'This conversation is not available from the requested source Hub. Reconnect that Hub and try again.')
        if (revision === this.navigationRevision) this.openSession(matches[0]!.id, undefined, target)
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
        const candidates = this.store.getSnapshot().windows.flatMap(window => panes(window.root))
        const existing = candidates.find(pane => {
            if (pane.resource.kind !== 'view' || pane.resource.sessionId !== sessionId) return false
            const previous = pane.resource.target
            if (target.type === 'resource') return previous.type === 'resource' && previous.address === target.address && previous.kind === target.kind
            if (target.type === 'tab') return target.address !== undefined && previous.type === 'tab' && previous.address === target.address && previous.kind === target.kind
            if (target.type === 'panel') return previous.type === 'panel' && previous.panelId === target.panelId
            return false
        }) ?? (target.type === 'tab' && options.reuseTabs?.includes(target.kind) ? candidates.find(pane =>
            pane.resource.kind === 'view' && pane.resource.sessionId === sessionId && pane.resource.target.type === 'tab'
            && options.reuseTabs!.includes(pane.resource.target.kind)) : undefined)
        if (existing) { this.store.updateView(existing.id, target, options.title); this.store.focus(existing.id) }
        else this.store.openResource({ kind: 'view', sessionId, viewId: this.options.nextId?.() ?? randomId(), target,
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
        if (matches.length !== 1) {
            if (matches.length === 0) this.resolveSource({ hubId, sourceSessionId: this.pendingSourceSession.sessionId })
            return false
        }
        const row = matches[0]!
        const target = this.pendingSourceSession.target
        this.pendingSourceSession = null
        this.openSession(row.id, undefined, target)
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
        const resource = this.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.id === paneId)?.resource
        const source = resource && resource.kind !== 'empty' ? this.originalSource(resource) : undefined
        if (source) {
            const key = originalSourceKey(source), failed = this.sourceResolutions.get(key)
            if (failed?.phase === 'failed') { this.sourceResolutions.delete(key); failed.abort.abort() }
        }
        // An explicit retry grants a fresh catalog settle window instead of
        // immediately repeating the same authoritative conclusion.
        this.catalogChangedAt = Date.now()
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

    /** Layout and its last confirmed baseline are one atomic browser write. */
    private saveLocal(): void {
        try {
            this.options.storage?.setItem(this.options.storageKey, JSON.stringify({ ...this.store.getSnapshot(),
                ...(this.confirmedLayout ? { syncBase: this.confirmedLayout } : {}),
                ...(this.recoveryLayout ? { layoutRecovery: this.recoveryLayout } : {}),
            }))
        } catch (error) { this.publish({ notice: `Workspace save failed: ${errorMessage(error)}`, persistence: 'failed' }) }
    }

    private bindLayout(state: WorkspaceState): WorkspaceState {
        return bindSourceResources(state, this.snapshot.catalog.byId, this.sourceBindingScope())
    }

    /** Receiving shared state must not create another shared write. */
    private replaceFromServer(state: WorkspaceState): boolean {
        this.applyingRemote = true
        try { this.store.replace(state) } finally { this.applyingRemote = false }
        // An open dirty editor may veto removal. Keep its view and the pending
        // layout choice accessible instead of marking an unapplied state saved.
        return sharedWorkspaceSignature(this.store.getSnapshot()) === sharedWorkspaceSignature(state)
    }

    private retainLayoutRecovery(state: WorkspaceState): void {
        this.recoveryLayout = state
        this.publish({ hasLayoutRecovery: true })
        this.saveLocal()
    }

    private receiveLayout(remote: WorkspaceState, base: WorkspaceState): boolean {
        const current = this.store.getSnapshot(), bound = this.bindLayout(remote)
        let merged: WorkspaceState
        try { merged = rebaseWorkspace(this.bindLayout(base), current, bound) }
        catch (error) {
            if (!(error instanceof WorkspaceRebaseConflictError)) throw error
            this.publish({ conflict: remote, persistence: 'failed', notice: null })
            return false
        }
        if (!this.replaceFromServer(merged)) {
            this.publish({ conflict: remote, persistence: 'failed', notice: null })
            return false
        }
        this.confirmedLayout = remote
        this.queuedSave = sharedWorkspaceSignature(merged) === sharedWorkspaceSignature(bound)
            ? undefined : sharedWorkspaceState(merged)
        this.publish({ conflict: null, persistence: this.queuedSave ? 'local' : 'saved', notice: null })
        this.saveLocal()
        return true
    }

    private async loadRemote(): Promise<void> {
        if (this.remoteLoading || this.disposed) return
        this.remoteLoading = true
        const initialRevision = this.store.getSnapshot().revision
        try {
            const loaded = await this.options.persistence!.load(this.lifetime.signal)
            if (this.disposed) return
            if (loaded !== null) {
                const remote = parseWorkspaceState(loaded)
                // Older builds saved no acknowledged baseline. Preserve that
                // browser layout once, then use the server without asking on
                // every open. Changes made during this GET still replay below.
                if (!this.confirmedLayout && this.restoredLocal
                    && sharedWorkspaceSignature(this.bindLayout(this.initialLayout)) !== sharedWorkspaceSignature(this.bindLayout(remote))) {
                    this.retainLayoutRecovery(this.initialLayout)
                }
                this.receiveLayout(remote, this.confirmedLayout ?? this.initialLayout)
            } else {
                this.confirmedLayout ??= this.initialLayout
                if (!this.restoredLocal && this.options.legacy && this.store.getSnapshot().revision === initialRevision) {
                    const legacy = await this.options.legacy(this.lifetime.signal)
                    if (this.disposed) return
                    if (this.store.getSnapshot().revision === initialRevision) {
                        const migrated = importLegacyWorkspace(legacy, this.snapshot.catalog.byId, this.sourceBindingScope())
                        if (migrated) this.store.replace(migrated)
                    }
                }
                this.queuedSave = sharedWorkspaceState(this.store.getSnapshot())
                this.saveLocal()
            }
            this.remoteLoaded = true
        } catch (error) {
            if (!this.disposed) this.publish({ notice: `Workspace sync failed: ${errorMessage(error)}`, persistence: 'failed' })
        } finally {
            this.remoteLoading = false
            this.openPendingSource()
            if (this.remoteLoaded && this.queuedSave && !this.disposed) void this.flushRemote()
        }
    }

    private async flushRemote(): Promise<void> {
        if (this.saving || this.disposed || !this.options.persistence || this.snapshot.conflict) return
        this.saving = true
        let rebases = 0
        try {
            while (this.queuedSave && !this.disposed) {
                const state = this.queuedSave
                this.queuedSave = undefined
                this.publish({ persistence: 'saving' })
                try {
                    await this.options.persistence.save(state, this.lifetime.signal)
                    if (this.disposed) return
                    this.confirmedLayout = state
                    this.saveLocal()
                    this.publish({ persistence: 'saved', notice: null })
                } catch (error) {
                    if (this.disposed) return
                    const latest: unknown = error && typeof error === 'object' && Reflect.get(error, 'name') === 'WorkspaceConflictError' ? Reflect.get(error, 'latest') : null
                    this.queuedSave ??= state
                    if (latest !== null) {
                        const remote = parseWorkspaceState(latest)
                        if (!this.receiveLayout(remote, this.confirmedLayout ?? this.initialLayout)) return
                        // Normal races rebase immediately. Continuous concurrent
                        // edits stop after three attempts; the pending edit stays
                        // durable and can be retried from the layout menu.
                        if (++rebases < 3 || !this.queuedSave) continue
                    }
                    this.publish({ notice: `Workspace sync failed: ${errorMessage(error)}`, persistence: 'failed' })
                    return
                }
            }
        } finally { this.saving = false }
    }

    retryPersistence = (): void => {
        if (this.remoteLoaded) void this.flushRemote()
        else void this.loadRemote()
    }

    restoreLayoutRecovery = (): void => {
        const recovered = this.recoveryLayout
        if (!recovered) return
        const current = this.store.getSnapshot()
        this.store.replace(keepLocalView(this.bindLayout(recovered), current))
        if (sharedWorkspaceSignature(this.store.getSnapshot()) === sharedWorkspaceSignature(this.bindLayout(recovered))) {
            this.recoveryLayout = undefined
            this.publish({ hasLayoutRecovery: false })
            this.saveLocal()
        }
    }

    resolveConflict(choice: 'local' | 'server'): void {
        const server = this.snapshot.conflict
        if (!server) return
        if (choice === 'server') {
            this.retainLayoutRecovery(this.store.getSnapshot())
            if (!this.replaceFromServer(keepLocalView(this.bindLayout(server), this.store.getSnapshot()))) return
            this.queuedSave = undefined
        } else this.queuedSave = sharedWorkspaceState(this.store.getSnapshot())
        this.confirmedLayout = server
        this.publish({ conflict: null, notice: null, persistence: this.queuedSave ? 'local' : 'saved' })
        this.saveLocal()
        if (this.queuedSave) void this.flushRemote()
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.lifetime.abort()
        for (const entry of this.sourceResolutions.values()) entry.abort.abort()
        this.sourceResolutions.clear(); this.sourceRequests.clear(); this.sourceResolver = undefined
        if (this.settleTimer !== undefined) { clearTimeout(this.settleTimer); this.settleTimer = undefined }
        for (const unsubscribe of this.unsubscribers) unsubscribe()
        for (const subscriptions of this.hostUnsubscribers.values()) for (const unsubscribe of subscriptions) unsubscribe()
        this.hostUnsubscribers.clear()
        for (const lease of this.leases.values()) lease.reference?.release()
        this.leases.clear()
        for (const paneId of this.previousLeases.keys()) this.releasePreviousLease(paneId)
        this.paneCloseGuards.clear()
        this.sourcePaneTitles.clear()
        this.listeners.clear()
        this.createdListeners.clear()
        this.successorHandler = undefined
    }
}
