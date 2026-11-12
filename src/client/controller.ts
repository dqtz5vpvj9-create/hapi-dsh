import type { SourceNavigationApi } from '../workspace/source-navigation-api.ts'
import type { WorkspaceApplicationIdentity } from './application-identity.ts'
import { NoticeGate } from './error-policy.ts'
import { migrateCutoverDraft } from './draft-cutover.ts'
import { sameSourceGeneration } from './surface/generation-handoff.ts'
import { randomId } from './random-id.ts'
import { workspaceFocusesSinglePane, type WorkspaceViewportPolicy } from '../shared/workspace-presentation.ts'
/** Plugin-owned view references and durable geometry. No agent lifetime ownership. */
import type { ISessions, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReactNode } from 'react'
import { initialWorkspace, panes, parseWorkspaceState, WorkspaceStore, type PaneResource, type SplitAxis, type WorkspaceNode, type WorkspaceState } from './model.ts'
import { rebaseWorkspace, WorkspaceRebaseConflictError } from '../workspace/rebase.ts'
import { SidebarState } from '../workspace/sidebar-state.ts'
import { bindSourceAliases, legacyPaneReference, legacyReferenceKey, keepLocalView, sharedWorkspaceSignature, sharedWorkspaceState } from '../workspace/legacy.ts'
import { bindingFailureState, invalidPaneAddressState, isSourceDisplaySessionId, paneOpenState, waitForCatalogSession, type PaneOpenContext, type PaneOpenFailure, type PaneOpenState } from './catalog-readiness.ts'
import { remoteValue, type CatalogMachine } from '../client-api.ts'
import { parseDshPaneTarget, type DshPaneTarget, type NavigationValue } from '../workspace/dsh-view.ts'
import type { DockPosition } from '../workspace/drag.ts'
import { buildSidebarSearchIndex, compareSidebarSearch, type SidebarSearchIndex } from '../workspace/sidebar-search.ts'
import { CatalogDiscovery, type WorkspaceCatalogDiscovery } from '../workspace/catalog-discovery.ts'
import { sourceResolutionFailure, type SourceResolutionFailure, type SourceResolutionStatus } from './source-session-state.ts'
import { PaneReadingIntents, type PaneReadingIntent, type PaneReadingTarget } from './reading-intent.ts'
import { isSourceSessionId, parseSourceSessionId, sourceSessionId } from '../remote/protocol.ts'
import type { RemoteSessions } from './remote-sessions.ts'
import type { SourceExportApi } from './source-export-state.ts'
import type { AppSourceRoute } from '../workspace/app-service-types.ts'
import type { LegacySourceReference, RecoveryReference } from '../workspace/source-aliases.ts'
import { SourceAliasResolutionError } from './source-session-resolver.ts'
import { accountComposerDraftKey, hasStoredComposerDraft, hasStoredComposerAttachments } from './composer-autosave.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
    interface SessionReferenceSourceMap { hapiWorkspace: unknown }
}

export class WorkspaceDirectoryRequired extends Error {}

export interface WorkspacePersistence {
    /** Optional Hub-backed geometry store. Only validated layout documents cross this boundary. */
    load(signal: AbortSignal): Promise<unknown | null>
    save(state: WorkspaceState, signal: AbortSignal): Promise<void>
}

export interface WorkspaceOptions {
    sourceActions?: WorkspaceSourceActions
    sourceExporter?: SourceExportApi
    readHead?: import('./source-reading-head.ts').SourceReadHead
    sourceCreation?: Pick<RemoteSessions, 'api' | 'list' | 'createController'>
    locateSourcePosition?: SourceNavigationApi['locatePosition']
    resumeContext?: SourceNavigationApi['resumeContext']
    application?: Pick<WorkspaceApplicationIdentity, 'getSnapshot' | 'subscribe'>
    sessions: Pick<ISessions, 'list' | 'retain' | 'refresh' | 'using' | 'search' | 'create'> & Partial<Pick<RemoteSessions, 'capabilities' | 'captureWorkspaceAccess'>>
        & { resolveSession?: (id: SessionId, signal: AbortSignal) => Promise<void> }
    navigation: Pick<UiWorkspace, 'openSession' | 'startSession' | 'archiveSession' | 'unarchiveSession' | 'pinSession' | 'unpinSession' | 'forkSession'>
        & Partial<Pick<UiWorkspace, 'listDirectory' | 'pickDirectory' | 'createDirectory'>>
    storage?: Pick<Storage, 'getItem' | 'setItem'>
    storageKey: string
    persistence?: WorkspacePersistence
    nextId?: () => string
    /** Reveal the official conversation panel when an empty window becomes active. */
    reveal?: () => void
    workspaceState?: WorkspaceHost['workspaceState']
    workspaces?: Pick<IWorkspaces, 'create'> & Partial<Pick<IWorkspaces, 'initializeDefault'>>
    /** The Host's official directory-picker composition, not just the always-present RPC methods. */
    directoryBrowsing?: boolean
    sourceSessionQuery?: string
    /** Notification and shared links preserve the original Hub identity too. */
    sourceHubQuery?: string
    sourceMessageQuery?: string
    sourceRequestQuery?: string
    beforeRemove?: (resources: readonly PaneResource[]) => boolean
    /**
     * How long a restored pane waits for a calm catalog before an unresolved
     * target is reported instead of retried. Attaching a large source catalog
     * keeps emitting events; production default is 30s.
     */
    catalogSettleMs?: number
    /** Acquire restored session references only when their window first becomes
     * visible. References already acquired keep their draft/scroll lifetime. */
    deferHiddenSessions?: boolean
    /** Initial and later layout projection, available before restored leases. */
    viewport?: WorkspaceViewportPolicy
}

export interface WorkspaceHost {
    readonly sourceActions?: WorkspaceSourceActions
    readonly sourceExporter?: SourceExportApi
    readonly readHead?: import('./source-reading-head.ts').SourceReadHead
    readonly id: string
    readonly label: string
    readonly sessions: WorkspaceOptions['sessions']
    readonly navigation: WorkspaceOptions['navigation']
    readonly sourceCreation?: WorkspaceOptions['sourceCreation']
    readonly locateSourcePosition?: SourceNavigationApi['locatePosition']
    readonly resumeContext?: SourceNavigationApi['resumeContext']
    readonly workspaces?: WorkspaceOptions['workspaces']
    readonly directoryBrowsing?: boolean
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

/** Native source operations confirm their own receipts; they do not invent DSH event seq. */
export interface WorkspaceSourceActions {
    rename(sessionId: SessionId, title: string): Promise<void>
    archive(sessionId: SessionId, archived: boolean): Promise<void>
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
    readonly archived: boolean
    readonly pinned: boolean
}

export interface WorkspaceCatalog extends Omit<SessionListState, 'byId'> { byId: Record<string, WorkspaceCatalogRow> }

import { sessionResourceId, parseSessionResourceId } from '../shared/session-resource-id.ts'
export { sessionResourceId, parseSessionResourceId }

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
    readonly leases: ReadonlyMap<string, PaneLease>
    readonly notice: string | null
    readonly persistence: 'local' | 'saving' | 'saved' | 'failed'
    readonly conflict: WorkspaceState | null
    readonly hasLayoutRecovery: boolean
    readonly creation: 'choose' | 'dsh' | 'codex' | 'source' | null
    readonly creationContext: WorkspaceCreationContext | null
    readonly pickingSession: boolean
    readonly machines: readonly CatalogMachine[]
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
    if (!row || !directory?.trim()) return null
    if (isSourceSessionId(row.sourceSessionId)) {
        const source = parseSourceSessionId(row.sourceSessionId)
        return { hostId: row.hostId, directory, machineId: source.machineId, engine: source.engine, sourceSessionId: row.sourceSessionId }
    }
    return { hostId: row.hostId, directory }
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
    const hostId: unknown = summary && Reflect.get(summary, 'hostId')
    const hostLabel: unknown = summary && Reflect.get(summary, 'hostLabel')
    const fallback: SessionLocation = {
        engine: 'dsh',
        ...(typeof hostId === 'string' && hostId !== 'local' ? { machineId: hostId } : {}),
        ...(typeof hostLabel === 'string' && hostId !== 'local' ? { machineName: hostLabel } : {}),
    }
    const id: unknown = summary && (Reflect.get(summary, 'sourceSessionId') ?? Reflect.get(summary, 'id'))
    if (typeof id !== 'string' || !isSourceSessionId(id)) return fallback
    try {
        const source = parseSourceSessionId(id)
        return { ...fallback, engine: source.engine, machineId: source.machineId, nativeId: source.nativeId }
    } catch { return fallback }

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

type OriginalSource = LegacySourceReference
interface CatalogTargetResolution {
    hostId: string
    sessions: WorkspaceOptions['sessions']
    abort: AbortController
    phase: 'opening' | 'ready' | 'failed'
    error?: unknown
}

interface SourceResolution {
    source: OriginalSource
    target?: AppSourceRoute
    abort: AbortController
    phase: 'opening' | 'ready' | 'failed'
    work: Promise<void>
    error?: string
    failure?: SourceResolutionFailure
    recovery?: readonly RecoveryReference[]
}
const originalSourceKey = legacyReferenceKey
const sameNativeRoute = (before: string, after: string): boolean => {
    try {
        const original = parseSessionResourceId(before).sessionId
        return isSourceSessionId(original) && original === parseSessionResourceId(after).sessionId
    } catch { return false }
}
const sourceTitleKey = (hubId: string, sessionId: string): string => JSON.stringify([hubId, sessionId])

/** One user-facing sentence per unresolved pane; the raw detail stays separate. */
function paneFailureError(state: PaneOpenState): string {
    return `${state.message} ${state.nextStep}`
}

/** The typed explanation that pairs with a structured original-source failure. */
function sourceResolutionTypedState(failure: SourceResolutionFailure): { reason: PaneOpenFailure; nextStep: string } {
    switch (failure) {
        case 'denied': return { reason: 'binding-denied', nextStep: 'Check the current account’s access to this original session, then retry.' }
        case 'removed': return { reason: 'source-not-found', nextStep: 'The original session was removed; close this pane or open another conversation from the sidebar.' }
        case 'not-found': return { reason: 'source-not-found', nextStep: 'Check the original Hub, then retry to continue opening the same conversation.' }
        case 'transport': return { reason: 'source-offline', nextStep: 'Restore the Hub/Runner connection, then retry.' }
        case 'not-connected': return { reason: 'source-offline', nextStep: 'Connect the original source to this HHPI Host, then reopen this saved conversation.' }
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
    private readonly omittedAttachmentDrafts = new Map<string, { layout: WorkspaceState; protected: boolean }>()
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
    private readonly sourcePaneTitles = new Map<string, { sourceKey: string; title: string }>()
    /** Last known source titles, so restored window tabs never show "Untitled". */
    private readonly titleCache = new Map<string, string>()
    private readonly aggregatedHosts = new Map<string, { inputs: readonly unknown[]; ids: SessionId[]; rows: WorkspaceCatalog['byId'] }>()
    private aggregateParts: readonly object[] = []
    private aggregateValue?: WorkspaceCatalog
    private readonly discovery = new CatalogDiscovery()
    private readonly sourceRouteCheckpoints = new Map<string, { sessionId: string; transfer(target: { hostId: string; scope: string }): boolean }>()
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
    private nativeSourceLink: AbortController | undefined
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
    private sourceResolver: ((source: OriginalSource, signal: AbortSignal) => Promise<AppSourceRoute>) | undefined
    private catalogRefresh: (() => Promise<void>) | undefined
    private readonly catalogTargets = new Map<string, CatalogTargetResolution>()
    private readonly sourceResolutions = new Map<string, SourceResolution>()
    private readonly sourceRequests = new Map<string, number>()
    private catalogChangedAt = Date.now()
    /** High-water mark of attached Sessions; only growth is catalog progress. */
    private catalogMaxIds = 0
    private settleTimer: ReturnType<typeof setTimeout> | undefined
    private readonly catalogSettleMs: number
    private compactViewport: boolean

    constructor(readonly options: WorkspaceOptions) {
        this.compactViewport = options.viewport?.getSnapshot() ?? false
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
            ...(options.directoryBrowsing === undefined ? {} : { directoryBrowsing: options.directoryBrowsing }),
            ...(options.sourceActions ? { sourceActions: options.sourceActions } : {}),
            ...(options.sourceExporter ? { sourceExporter: options.sourceExporter } : {}),
            ...(options.readHead ? { readHead: options.readHead } : {}),
            ...(options.sourceCreation ? { sourceCreation: options.sourceCreation } : {}),
            ...(options.locateSourcePosition ? { locateSourcePosition: options.locateSourcePosition } : {}),
            ...(options.resumeContext ? { resumeContext: options.resumeContext } : {}),
            ...(options.workspaces ? { workspaces: options.workspaces } : {}),
            ...(options.workspaceState ? { workspaceState: options.workspaceState } : {}) })
        this.snapshot = {
            layout: this.store.getSnapshot(), catalog: this.aggregateCatalog(),
            sourcePaneTitles: {},
            catalogDiscovery: this.catalogDiscovery(),
            leases: new Map(), notice, persistence: 'local', conflict: null, hasLayoutRecovery: Boolean(this.recoveryLayout),
            creation: null, creationContext: null, pickingSession: false, machines: [],
        }
        this.restoreCachedTitles()
        this.hostMainIds.set('local', this.selectedMain('local'))
        this.unsubscribers.push(this.store.subscribe(this.onLayout), options.sessions.list.subscribe(() => this.onCatalog('local')))
        if (options.sessions.capabilities) this.unsubscribers.push(options.sessions.capabilities.subscribe(() => this.publish()))
        if (options.workspaceState) this.unsubscribers.push(options.workspaceState.subscribe(() => this.publish({ catalog: this.aggregateCatalog() })))
        if (options.viewport) this.unsubscribers.push(options.viewport.subscribe(() => {
            const compact = options.viewport!.getSnapshot()
            if (this.disposed || compact === this.compactViewport) return
            this.compactViewport = compact
            this.reconcileLeases()
            this.publish()
        }))
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
        if (options.application) this.unsubscribers.push(options.application.subscribe(() => this.onCatalog('local')))
    }

    /** Pending canonical navigation outranks passive restored resource views. */
    get pendingStartupSourceId(): string | undefined { return this.pendingSourceSession?.sessionId }

    cancelStartupFocus(): void {
        if (!this.pendingSourceSession && !this.nativeSourceLink) return
        this.pendingSourceSession = null
        this.nativeSourceLink?.abort(); this.nativeSourceLink = undefined
        this.navigationRevision++
        this.publish()
    }

    /** Explicit pointer selection supersedes startup intent, even on the same Pane. */
    focusPane(paneId: string): void {
        if (!this.store.getSnapshot().windows.some(window => panes(window.root).some(pane => pane.id === paneId))) return
        this.cancelStartupFocus()
        this.store.focus(paneId)
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
    registerSourceRouteCheckpoint(paneId: string, checkpoint: { sessionId: string; transfer(target: { hostId: string; scope: string }): boolean }): () => void {
        this.sourceRouteCheckpoints.set(paneId, checkpoint)
        queueMicrotask(() => { if (!this.disposed && this.sourceRouteCheckpoints.get(paneId) === checkpoint) this.onCatalog('local') })
        return () => { if (this.sourceRouteCheckpoints.get(paneId) === checkpoint) this.sourceRouteCheckpoints.delete(paneId) }
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
        this.notices.markReady()
        this.notices.recovered()
        this.publish({ catalog: this.aggregateCatalog() })
    }
    /** An actual paired-Host inventory updates reachability without replacing Session owners. */
    setHostDiscovery(hosts: readonly { id: string; label: string; online: boolean }[]): void {
        this.discovery.observe(hosts, true)
        this.onCatalog('local')
    }
    /** Inventory transport failure does not revoke any loaded Host or Session. */
    catalogDiscoveryFailed(message: string): void {
        this.discovery.sourceFailed(message)
        this.publish()
    }
    /** Reuse the sidebar's refresh action for the same background inventory owner. */
    installCatalogRefresh(refresh: () => Promise<void>): () => void {
        if (this.catalogRefresh) throw new Error('Catalog refresh is already installed')
        this.catalogRefresh = refresh
        return () => { if (this.catalogRefresh === refresh) this.catalogRefresh = undefined }
    }
    catalogHostReady(id: string, label: string): void {
        this.discovery.hostReady(id, label)
        this.catalogChangedAt = Date.now()
        this.onCatalog(id)
    }
    catalogHostFailed(id: string, label: string, error: unknown): void {
        this.discovery.hostFailed(id, label, errorMessage(error))
        this.catalogChangedAt = Date.now()
        this.publish()
        if (this.hasWaitingLeases()) this.reconcileLeases()
    }
    private hasWaitingLeases(): boolean { return [...this.leases.values()].some(lease => lease.waitingForCatalog) }
    /** Finite offline aliases share one cancellable request per exact saved reference. */
    installSourceResolver(resolve: (source: OriginalSource, signal: AbortSignal) => Promise<AppSourceRoute>): () => void {
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
        return legacyPaneReference(resource)
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
        }).then(target => {
            if (!active()) return
            entry.target = target
            entry.phase = 'ready'
            const state = this.store.getSnapshot(), rebound = this.bindLayout(state)
            if (rebound !== state) this.store.replace(rebound)
            else this.reconcileLeases()
            this.openPendingSource()
        }, error => {
            if (!active()) return
            entry.phase = 'failed'; entry.error = errorMessage(error); entry.failure = sourceResolutionFailure(error)
            if (error instanceof SourceAliasResolutionError) entry.recovery = error.recovery
            this.reconcileLeases()
            this.openPendingSource()
            throw error
        })
        // Restored panes are background callers; explicit navigation still awaits work.
        void entry.work.catch(() => {})
        return entry
    }

    /** Directory membership is discovery, not proof that an exact HHPI target is gone. */
    private resolveCatalogTarget(host: WorkspaceHost, id: string): CatalogTargetResolution | undefined {
        if (!id.startsWith('hhpi:') || !host.sessions.resolveSession) return undefined
        const key = sessionResourceId(host.id, id), previous = this.catalogTargets.get(key)
        if (previous && previous.sessions === host.sessions && previous.phase !== 'ready') return previous
        previous?.abort.abort()
        const entry: CatalogTargetResolution = { hostId: host.id, sessions: host.sessions, abort: new AbortController(), phase: 'opening' }
        this.catalogTargets.set(key, entry)
        const active = () => !this.disposed && !entry.abort.signal.aborted && this.catalogTargets.get(key) === entry
            && this.hosts.get(host.id)?.sessions === entry.sessions
        void Promise.resolve().then(() => waitForCatalogSession(host.sessions, id as SessionId,
            AbortSignal.any([this.lifetime.signal, entry.abort.signal]))).then(() => {
            if (!active()) return
            entry.phase = 'ready'; this.reconcileLeases()
        }, error => {
            if (!active()) return
            entry.phase = 'failed'; entry.error = error; this.reconcileLeases()
        })
        return entry
    }

    private pruneCatalogTargets(resources: Iterable<Exclude<PaneResource, { kind: 'empty' }>>): void {
        const needed = new Set([...resources].map(resource => resource.sessionId))
        for (const [key, entry] of this.catalogTargets) {
            if (needed.has(key) && this.hosts.get(entry.hostId)?.sessions === entry.sessions) continue
            this.catalogTargets.delete(key); entry.abort.abort()
        }
    }

    private pruneSourceResolutions(resources: Iterable<Exclude<PaneResource, { kind: 'empty' }>>): void {
        const needed = new Set(this.sourceRequests.keys())
        for (const resource of resources) {
            const source = this.originalSource(resource)
            if (source) needed.add(originalSourceKey(source))
        }
        const pendingHub = this.pendingSourceSession?.hubId
        if (this.pendingSourceSession && pendingHub) needed.add(originalSourceKey({ kind: 'hapi-session', hubId: pendingHub, sessionId: this.pendingSourceSession.sessionId }))
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
        this.snapshot = { ...this.snapshot, catalogDiscovery: this.catalogDiscovery() }
        for (const listener of [...this.listeners]) listener()
    }

    private catalogDiscovery(): WorkspaceCatalogDiscovery {
        const localReady = this.options.sessions.list.getSnapshot().phase === 'ready'
        const snapshot = this.discovery.snapshot(localReady)
        const hosts = snapshot.hosts.map(host => this.hosts.get(host.id)?.sessions.capabilities?.getSnapshot().catalogReady === false
            && host.phase !== 'unavailable' ? { ...host, phase: 'pending' as const } : host)
        const source = snapshot.source === 'unavailable' ? 'unavailable'
            : localReady && this.options.sessions.capabilities?.getSnapshot().catalogReady !== false ? 'ready' : 'pending'
        return { ...snapshot, hosts, source, sourceBindingsPending: 0,
            phase: source === 'pending' || hosts.some(host => host.phase === 'pending') ? 'pending'
                : source === 'unavailable' || hosts.some(host => host.phase === 'unavailable') ? 'partial' : 'ready' }
    }

    private titleCacheKey(): string { return `${this.options.storageKey}:pane-titles:v1` }

    /** Seed restored panes with the last observed source titles before the catalog exists. */
    private restoreCachedTitles(): void {
        try {
            const raw = this.options.storage?.getItem(this.titleCacheKey())
            if (!raw) return
            const saved = JSON.parse(raw) as { version?: unknown; titles?: unknown }
            if (saved.version !== 1 || !saved.titles || typeof saved.titles !== 'object') return
            for (const [sourceKey, title] of Object.entries(saved.titles as Record<string, unknown>)) {
                if (typeof title === 'string' && title.trim()) this.titleCache.set(sourceKey, title.trim())
            }
        } catch { /* a corrupted cache simply falls back to the catalog */ }
        const restored: Record<string, string> = {}
        for (const pane of this.snapshot.layout.windows.flatMap(window => panes(window.root))) {
            const resource = pane.resource
            if (resource.kind === 'empty') continue
            const hubId = resource.sourceHubId, sourceSessionId = resource.sourceSessionId
            if (!hubId || !sourceSessionId) continue
            const sourceKey = sourceTitleKey(hubId, sourceSessionId), title = this.titleCache.get(sourceKey)
            if (!title) continue
            this.sourcePaneTitles.set(pane.id, { sourceKey, title })
            restored[pane.id] = title
        }
        if (Object.keys(restored).length) this.snapshot = { ...this.snapshot, sourcePaneTitles: { ...restored } }
    }

    private rememberSourcePaneTitles(): void {
        const titles: Record<string, string> = {}, present = new Set<string>()
        for (const pane of this.snapshot.layout.windows.flatMap(window => panes(window.root))) {
            present.add(pane.id)
            const resource = pane.resource
            if (resource.kind === 'empty') { this.sourcePaneTitles.delete(pane.id); continue }
            const hubId = resource.sourceHubId, sourceSessionId = resource.sourceSessionId
            if (!hubId || !sourceSessionId) { this.sourcePaneTitles.delete(pane.id); continue }
            const sourceKey = sourceTitleKey(hubId, sourceSessionId), previous = this.sourcePaneTitles.get(pane.id)
            // This cache belongs only to the saved reference. A live catalog
            // row cannot rename it or imply that an offline reference resolved.
            const title = (previous?.sourceKey === sourceKey ? previous.title : undefined) ?? this.titleCache.get(sourceKey)
            if (title) {
                this.sourcePaneTitles.set(pane.id, { sourceKey, title }); titles[pane.id] = title
            } else this.sourcePaneTitles.delete(pane.id)
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
        const rebound = this.bindLayout(current)
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
        this.openSession(sessionResourceId(hostId, sessionId))
    }

    /** Only an authenticated original Host's own exact native row outranks a local shadow. */
    private preferredSourceResource(resourceId: string): string {
        try {
            const address = parseSessionResourceId(resourceId)
            if (address.hostId !== 'local' || !isSourceSessionId(address.sessionId)) return resourceId
            const identity = parseSourceSessionId(address.sessionId), host = this.hosts.get(identity.machineId)
            if (!host || host.id === 'local' || this.discovery.host(host.id)?.phase === 'unavailable') return resourceId
            const catalog = host.sessions.list.getSnapshot(), row = catalog.byId[address.sessionId as SessionId]
            const source = row?.projectionValues?.hhpiSource
            if (row?.id !== address.sessionId || source?.id !== address.sessionId
                || source.machineId !== identity.machineId || source.sourceId !== identity.sourceId
                || source.engine !== identity.engine || source.nativeId !== identity.nativeId
                || (source.connection ? source.connection.state !== 'online' : source.status === 'offline')) return resourceId
            const access = host.sessions.captureWorkspaceAccess?.(address.sessionId)
            if (!access || access.signal.aborted) return resourceId
            access.assertCurrent()
            return sessionResourceId(host.id, address.sessionId)
        } catch { return resourceId }
    }

    private aggregateCatalog(): WorkspaceCatalog {
        const opened = new Set(this.store.getSnapshot().windows.flatMap(window => panes(window.root)).flatMap(pane => pane.resource.kind === 'empty' ? [] : [pane.resource.sessionId]))
        for (const host of this.hosts.values()) this.hostCatalogs.set(host.id, { label: host.label, catalog: host.sessions.list.getSnapshot() })
        const parts: Array<{ ids: SessionId[]; rows: WorkspaceCatalog['byId'] }> = []
        let phase: SessionListState['phase'] = 'ready'
        for (const [hostId, cached] of this.hostCatalogs) {
            const host = this.hosts.get(hostId)
            if (host && cached.catalog.phase === 'pending') phase = 'pending'
            // `hostOnline` is registration plus reachability, never registration alone:
            // a pane graph can outlive the machine's catalog connection briefly.
            const hostOnline = host !== undefined && (hostId === 'local' || this.discovery.host(hostId)?.phase !== 'unavailable')
            const workspace = host?.workspaceState?.getSnapshot()
            // Omitted rows remain exact-addressable. An existing Pane or this
            // account's draft keeps its entry without re-advertising the source.
            const kept = Object.keys(cached.catalog.byId).filter(id => !cached.catalog.ids.includes(id as SessionId)
                && isSourceSessionId(id) && this.keepOmittedSource(hostId, id, opened))
            const inputs = [cached.catalog, cached.label, hostOnline, workspace, JSON.stringify(kept)]
            const previous = this.aggregatedHosts.get(hostId)
            if (previous && inputs.every((value, index) => value === previous.inputs[index])) {
                parts.push(previous); continue
            }
            const hostRows: WorkspaceCatalog['byId'] = {}
            const previousCatalog = previous?.inputs[0] as SessionListState | undefined
            const archived = new Set(workspace?.archivedSessionIds ?? [])
            const pinned = new Set(workspace?.pinnedSessionIds ?? [])
            for (const [sourceSessionId, row] of Object.entries(cached.catalog.byId)) {
                const resourceId = sessionResourceId(hostId, sourceSessionId)
                const old = previous?.rows[resourceId]
                const isArchived = isSourceSessionId(sourceSessionId) ? row.projectionValues?.hhpiArchived ?? archived.has(sourceSessionId) : archived.has(sourceSessionId)
                const isPinned = pinned.has(sourceSessionId)
                if (old && previousCatalog?.byId[sourceSessionId as SessionId] === row && old.hostLabel === cached.label
                    && old.hostOnline === hostOnline && old.archived === isArchived && old.pinned === isPinned) {
                    hostRows[resourceId] = old
                    continue
                }
                hostRows[resourceId] = { ...row, id: resourceId as SessionId, hostId, hostLabel: cached.label, hostOnline,
                    sourceSessionId, archived: isArchived, pinned: isPinned }

            }
            const hostIds = !kept.length && previous && previousCatalog?.ids.length === cached.catalog.ids.length
                && cached.catalog.ids.every((id, index) => id === previousCatalog.ids[index])
                && previous.inputs[4] === '[]'
                ? previous.ids : [...cached.catalog.ids, ...kept].map(id => sessionResourceId(hostId, id) as SessionId)
            const part = { inputs, ids: hostIds, rows: hostRows }
            this.aggregatedHosts.set(hostId, part)
            parts.push(part)
        }
        for (const id of this.aggregatedHosts.keys()) if (!this.hostCatalogs.has(id)) this.aggregatedHosts.delete(id)
        // Retaining a lease can synchronously publish a catalog update. Keep
        // the second reconciliation, but do not copy every row again when all
        // Host snapshots and their presentation inputs are still identical.
        if (this.aggregateValue && phase === this.aggregateValue.phase && parts.length === this.aggregateParts.length
            && parts.every((part, index) => part === this.aggregateParts[index])) return this.aggregateValue
        this.aggregateParts = parts
        const ids: SessionId[] = []
        const byId: WorkspaceCatalog['byId'] = {}
        for (const part of parts) { Object.assign(byId, part.rows); ids.push(...part.ids) }
        // One native identity has one directory entry, even while its original
        // Host is offline. All exact rows/permissions stay with their own Host.
        const winners = new Map<string, SessionId>()
        const rank = (id: SessionId): number => {
            const row = byId[id]!, identity = parseSourceSessionId(row.sourceSessionId)
            const source = row.projectionValues?.hhpiSource
            if (source && (source.id !== row.sourceSessionId || sourceSessionId(source) !== row.sourceSessionId)) return -1
            const original = row.hostId === identity.machineId
            const online = row.hostOnline && source && (source.connection ? source.connection.state === 'online' : source.status !== 'offline')
            if (online) {
                try {
                    const access = this.hosts.get(row.hostId)?.sessions.captureWorkspaceAccess?.(row.sourceSessionId)
                    if (access && !access.signal.aborted) { access.assertCurrent(); return original ? 4 : 3 }
                } catch { /* Keep the other exact route; never combine grants. */ }
            }
            return !source && row.hostOnline ? 2 : source && original ? 1 : 0
        }
        for (const id of ids) {
            const nativeId = byId[id]!.sourceSessionId
            if (!isSourceSessionId(nativeId)) continue
            const prior = winners.get(nativeId)
            if (!prior || rank(id) > rank(prior)) winners.set(nativeId, id)
        }
        const visibleIds = ids.filter(id => !isSourceSessionId(byId[id]!.sourceSessionId) || winners.get(byId[id]!.sourceSessionId) === id)
        const previous = this.snapshot?.catalog
        if (previous && phase === previous.phase && visibleIds.length === previous.ids.length
            && visibleIds.every((id, index) => id === previous.ids[index])
            && Object.keys(byId).length === Object.keys(previous.byId).length
            && Object.entries(byId).every(([id, row]) => row === previous.byId[id])) return this.aggregateValue = previous
        return this.aggregateValue = { ids: visibleIds, byId, phase, projectionsBySession: {} }
    }

    private keepOmittedSource(hostId: string, id: string, opened: ReadonlySet<string>): boolean {
        if (opened.has(sessionResourceId(hostId, id))) return true
        const account = this.options.application?.getSnapshot(), storage = this.options.storage
        // Unknown account/storage cannot establish that an unsent draft is absent.
        if (!account || account.signal.aborted || !storage) return true
        try {
            const access = this.hosts.get(hostId)?.sessions.captureWorkspaceAccess?.(id)
            if (!access || access.signal.aborted) return true
            access.assertCurrent()
            const key = accountComposerDraftKey(JSON.stringify([account.scope, access.scope]), hostId, id)
            if (hasStoredComposerDraft(storage, key)) return true
            const layout = this.store.getSnapshot(), attachments = this.omittedAttachmentDrafts.get(key)
            if (attachments?.layout === layout) return attachments.protected
            const pending = { layout, protected: true }
            this.omittedAttachmentDrafts.set(key, pending)
            void hasStoredComposerAttachments(key).then(protectedDraft => {
                if (this.disposed || this.omittedAttachmentDrafts.get(key) !== pending) return
                pending.protected = protectedDraft
                this.publish({ catalog: this.aggregateCatalog() })
            })
            return true
        } catch { return true }
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
        if (host.sessions.capabilities) subscriptions.push(host.sessions.capabilities.subscribe(() => this.publish()))
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
            for (const [key, entry] of this.catalogTargets) if (entry.hostId === host.id) {
                this.catalogTargets.delete(key); entry.abort.abort()
            }
            for (const unsubscribe of this.hostUnsubscribers.get(host.id) ?? []) unsubscribe()
            this.hostUnsubscribers.delete(host.id)
            this.hostMainIds.delete(host.id)
            this.hostCatalogs.delete(host.id)
            this.discovery.hostRemoved(host.id)
            this.catalogChangedAt = Date.now()
            for (const [paneId, lease] of this.leases) {
                if (lease.hostId !== host.id) continue
                // Unregister only on explicit removal or runtime disposal.
                // A temporary disconnect keeps this Host and its references.
                const failure = paneOpenState({ kind: 'display', label: host.label,
                    hostId: host.id, sessionId: lease.sessionId, sourcePhase: this.options.sessions.list.getSnapshot().phase === 'ready' ? 'ready' : 'pending', currentHubId: null,
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
            if (before.sourceSessionId && before.sourceSessionId === after.sourceSessionId && before.sourceHubId === after.sourceHubId
                || sameNativeRoute(before.sessionId, after.sessionId)) {
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
            currentHubId: null,
            sourcePhase: this.options.sessions.list.getSnapshot().phase === 'ready' ? 'ready' : 'pending',
            sourceError: null,
            localPhase,
            hostRegistered: host !== undefined,
            hostOnline: host !== undefined && (hostId === 'local' || this.discovery.host(hostId)?.phase !== 'unavailable'),
            settled: this.catalogSettled(),
            ...(archived ? { archived: true } : {}),
            ...(machine ? { machineLabel: machine.label, machineOnline: machine.online } : {}),
        }
    }

    private markPaneUnavailable(paneId: string, hostId: string, sessionId: string, resource: Exclude<PaneResource, { kind: 'empty' }>,
        resolution?: SourceResolution, ambiguous = false): void {
        const state = paneOpenState(this.paneOpenContext(hostId, sessionId, resource))
        if (legacyPaneReference(resource) && resolution === undefined && !ambiguous) {
            this.leases.set(paneId, { hostId, sessionId, status: 'failed', sourceResolution: 'not-ready', reason: 'source-not-found',
                error: 'This saved reference has not resolved to its original source. Its identifiers are preserved.',
                nextStep: 'Retry the original reference after its offline mapping is available, or export the saved reference for recovery.',
                detail: state.detail, retryable: true, waitingForCatalog: true })
            return
        }
        if (legacyPaneReference(resource) && (resolution !== undefined || ambiguous)) {
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
            // Re-bind saved identities before classifying anything: only an exact offline
            // alias can replace a legacy address. Display suffixes and catalog
            // metadata cannot establish the original source identity.
            const current = this.store.getSnapshot()
            const rebound = this.bindLayout(current)
            if (rebound !== current) this.store.replace(rebound)
            const layout = this.store.getSnapshot()
            const expected = new Map(layout.windows.flatMap(window => panes(window.root))
                .flatMap(pane => pane.resource.kind !== 'empty' ? [[pane.id, pane.resource] as const] : []))
            const active = layout.windows.find(window => window.id === layout.activeWindowId)
            const visible = new Set((active ? panes(active.root) : []).filter(pane => !workspaceFocusesSinglePane(this.compactViewport, layout.zoomed[layout.activeWindowId])
                || pane.id === layout.focused[layout.activeWindowId]).map(pane => pane.id))
            this.pruneSourceResolutions(expected.values())
            this.pruneCatalogTargets(expected.values())
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
                    if (source) {
                        if (resource.kind !== 'chat') {
                            this.leases.set(paneId, { hostId, sessionId, status: 'failed', reason: 'binding-failed',
                                error: 'This saved resource still needs its exact resource migration. Its original reference is preserved.',
                                nextStep: 'Recover or export the original resource; a conversation alias cannot replace a file or terminal identity.', retryable: false })
                        } else this.markPaneUnavailable(paneId, hostId, sessionId, resource, this.resolveSource(source))
                        continue
                    }
                    if (resource.sourceSessionId) {
                        this.leases.set(paneId, { hostId, sessionId, status: 'failed', reason: 'source-hub-changed',
                            error: 'This saved source reference is incomplete. Its original reference is preserved.',
                            nextStep: 'Recover or export the saved reference and choose its exact source before restoring it.', retryable: false })
                        continue
                    }
                    if (!host) {
                        this.markPaneUnavailable(paneId, hostId, sessionId, resource)
                        continue
                    }
                    const catalog = host.sessions.list.getSnapshot()
                    if (!catalog.byId[sessionId as SessionId]) {
                        const target = this.resolveCatalogTarget(host, sessionId)
                        if (target) {
                            if (target.phase === 'failed') {
                                const failure = bindingFailureState({ ...this.paneOpenContext(hostId, sessionId, resource), error: errorMessage(target.error) })
                                this.leases.set(paneId, { hostId, sessionId, status: 'failed', reason: failure.reason,
                                    error: paneFailureError(failure), nextStep: failure.nextStep, detail: failure.detail, retryable: true, waitingForCatalog: true })
                            } else this.leases.set(paneId, { hostId, sessionId, status: 'opening', reason: 'catalog-loading',
                                nextStep: 'Resolving this conversation directly with its original source.', retryable: true, waitingForCatalog: true })
                            continue
                        }
                        this.markPaneUnavailable(paneId, hostId, sessionId, resource)
                        continue
                    }
                    if (resource.kind === 'chat' && resource.draftOrigin && this.options.storage) {
                        migrateCutoverDraft(this.options.storage, resource.draftOrigin, sessionId, paneId, hostId)
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
        sessionId = this.preferredSourceResource(sessionId)
        // A sidebar/deep link must not bypass the existing same-native input's safety checkpoint.
        const shadow = this.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.resource.kind === 'chat'
            && pane.resource.sessionId !== sessionId && this.preferredSourceResource(pane.resource.sessionId) === sessionId)
        if (shadow) {
            this.store.focus(shadow.id)
            this.store.replace(this.bindLayout(this.store.getSnapshot()))
            const current = this.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.id === shadow.id)
            if (current?.resource.kind !== 'chat' || current.resource.sessionId !== sessionId) return
            beside = undefined
        }
        this.nativeSourceLink?.abort(); this.nativeSourceLink = undefined
        this.navigationRevision++
        this.pendingSourceSession = null
        this.store.openResource({ kind: 'chat', sessionId }, beside)
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

    /** A source notification never treats its original id as a DSH display id
     * or silently opens another Hub's same-named session. */
    /**
     * A pending source resolution must produce a visible outcome: either it
     * settles, it times out with an actionable error, or the caller aborts. A
     * silently hanging "opening" row is not an acceptable state.
     * @param entry - resolution shared by all callers of this source.
     */
    private async awaitResolution(entry: SourceResolution): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                entry.work,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Resolving the source conversation timed out; retry opening it')), 15_000)
                }),
            ])
        } catch (error) {
            if (entry.phase === 'opening' && !entry.abort.signal.aborted) entry.abort.abort(error)
            this.report(error)
            throw error
        } finally {
            if (timer !== undefined) clearTimeout(timer)
        }
    }

    async openSourceSession(source: { hubId: string; sessionId: string; messageId?: string; requestId?: string }): Promise<void> {
        if (!source.hubId.trim() || !source.sessionId.trim()) throw new Error('A source conversation requires both its Hub and session identity')
        const revision = ++this.navigationRevision
        const target: PaneReadingTarget = source.messageId ? { kind: 'message', messageId: source.messageId, origin: 'notification' }
            : source.requestId ? { kind: 'approval', requestId: source.requestId } : { kind: 'latest' }
        const original: OriginalSource = { kind: 'hapi-session', hubId: source.hubId, sessionId: source.sessionId }
        const key = originalSourceKey(original), failed = this.sourceResolutions.get(key)
        if (failed?.phase === 'failed') { this.sourceResolutions.delete(key); failed.abort.abort() }
        if (!this.sourceResolver) throw new Error('Saved reference recovery is not connected. Its original reference is preserved.')
        this.sourceRequests.set(key, (this.sourceRequests.get(key) ?? 0) + 1)
        const resolution = this.resolveSource(original)!
        try {
            await this.awaitResolution(resolution)
            if (this.disposed) throw new Error('The workspace is closed')
            const route = resolution.target!
            const id = sessionResourceId(route.hostId, route.sessionId)
            if (!this.snapshot.catalog.byId[id]) await this.refresh()
            if (this.disposed) throw new Error('The workspace is closed')
            if (!this.snapshot.catalog.byId[id]) throw new Error('The mapped conversation is not listed by its exact Host. Reconnect that Host and retry; the original reference is preserved.')
            if (revision === this.navigationRevision) this.openSession(id, undefined, target)
        } finally {
            const count = (this.sourceRequests.get(key) ?? 1) - 1
            if (count) this.sourceRequests.set(key, count)
            else this.sourceRequests.delete(key)
        }
    }

    /** Native sidebar drag uses the same catalog identity as normal opening. */
    dockSession(sessionId: string, targetPaneId: string, position: DockPosition): void {
        const row = this.snapshot.catalog.byId[sessionId]
        if (!row) return
        this.store.dockResource({ kind: 'chat', sessionId }, targetPaneId, position)
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
        this.cancelStartupFocus()
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
        }, options.beside)
        this.options.reveal?.()
    }

    /** Persist what the actual official occurrence navigated to, never a guessed content id. */
    updateView(paneId: string, target: DshPaneTarget, title?: string): void {
        this.store.updateView(paneId, parseDshPaneTarget(target), title)
    }

    /** Source deep links wait for their real native binding; no guessed display ID. */
    private openPendingSource(): boolean {
        if (this.disposed || !this.pendingSourceSession) return false
        const hubId = this.pendingSourceSession.hubId
        if (!hubId && isSourceSessionId(this.pendingSourceSession.sessionId)) {
            // Current HHPI links already carry their exact native identity. The
            // local Host resolves it through its ordinary acquisition path even
            // when the sidebar has not discovered this conversation yet.
            if (!this.remoteLoaded) return false
            const { sessionId, target } = this.pendingSourceSession
            try { parseSourceSessionId(sessionId) }
            catch (error) { this.pendingSourceSession = null; this.report(error); return false }
            return this.openPendingSourceTarget('local', sessionId, target)
        }
        if (!hubId) return false
        const reference: OriginalSource = { kind: 'hapi-session', hubId, sessionId: this.pendingSourceSession.sessionId }
        const resolution = this.resolveSource(reference)
        if (resolution?.phase === 'failed' && this.remoteLoaded) {
            // A shared reference needs the same recovery surface as a restored
            // pane. Keep its exact identity; never leave unrelated content on
            // screen while silently abandoning the requested conversation.
            this.pendingSourceSession = null
            this.navigationRevision++
            this.store.openResource({ kind: 'chat', sessionId: reference.sessionId,
                sourceSessionId: reference.sessionId, sourceHubId: reference.hubId })
            this.closeSessionPicker()
            this.options.reveal?.()
            return true
        }
        if (resolution?.phase !== 'ready' || !resolution.target || !this.remoteLoaded) return false
        const route = resolution.target, id = sessionResourceId(route.hostId, route.sessionId)
        const row = this.snapshot.catalog.byId[id]
        if (!row) return false
        const target = this.pendingSourceSession.target
        return this.openPendingSourceTarget(route.hostId, route.sessionId, target)
    }

    /** Resolve an original native content id through this exact authenticated Host. */
    private openPendingSourceTarget(hostId: string, sessionId: string, target: PaneReadingTarget): boolean {
        if (target.kind !== 'message' || !target.messageId.startsWith('codex:')) {
            this.openSession(sessionResourceId(hostId, sessionId), undefined, target)
            return true
        }
        const identity = this.options.application?.getSnapshot()
        if (this.options.application && !identity) return false
        const host = this.hosts.get(hostId)
        try {
            const source = parseSourceSessionId(sessionId), parts = target.messageId.split(':')
            if (parts.length !== 4 || source.engine !== 'codex') throw new Error('The original native message reference is invalid.')
            const [nativeId, turnId, itemId] = parts.slice(1).map(decodeURIComponent)
            if (nativeId !== source.nativeId || !turnId || !itemId) throw new Error('The native message reference belongs to another source conversation.')
            if (!host?.locateSourcePosition) throw new Error('The original source cannot resolve this message position.')
            this.pendingSourceSession = null
            this.nativeSourceLink?.abort()
            const abort = new AbortController(), revision = ++this.navigationRevision
            this.nativeSourceLink = abort
            const signal = AbortSignal.any([abort.signal, this.lifetime.signal, ...(identity ? [identity.signal] : [])])
            void host.locateSourcePosition({ sessionId, position: { turnId, itemId } }, signal).then(result => {
                signal.throwIfAborted()
                if (this.disposed || this.navigationRevision !== revision || this.hosts.get(hostId) !== host
                    || this.options.application?.getSnapshot() !== identity) return
                const position = remoteValue(result)
                this.nativeSourceLink = undefined
                this.openSession(sessionResourceId(hostId, sessionId), undefined, { ...target, messageId: String(position.seq), epoch: position.epoch })
            }).catch(error => { if (!signal.aborted && !this.disposed && this.navigationRevision === revision) this.report(error) })
                .finally(() => { if (this.nativeSourceLink === abort) this.nativeSourceLink = undefined })
            return true
        } catch (error) { this.pendingSourceSession = null; this.report(error); return false }
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
            let workspace
            if (!directory.trim()) workspace = await host.workspaces.initializeDefault?.()
            if (!workspace) {
                const path = directory.trim() || (host.directoryBrowsing !== false ? (await host.navigation.listDirectory?.())?.path : undefined)
                if (!path) throw new WorkspaceDirectoryRequired('Choose a working directory on the selected Host')
                // Official blank Conversation requires Workspace membership.
                // Adopt only the explicit path or the browse backend's home.
                workspace = await host.workspaces.create({ path })
            }
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
        const targetKey = sessionResourceId(lease.hostId, lease.sessionId), target = this.catalogTargets.get(targetKey)
        if (target?.phase === 'failed') { this.catalogTargets.delete(targetKey); target.abort.abort() }
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
    // HAPI parity: cancellations stay silent, a transient transport failure shows
    // one delayed notice, and auth/operation failures remain explicit and human.
    private readonly notices = new NoticeGate(text => this.publish({ notice: text }), () => this.publish({ notice: null }))

    report = (error: unknown): void => { this.notices.report(error) }

    /** Cancel a pending transient notice after a successful connect or read. */
    recovered = (): void => { this.notices.recovered() }

    async refresh(): Promise<void> {
        const results = await Promise.allSettled([this.catalogRefresh?.(), ...[...this.hosts.values()].map(host => host.sessions.refresh())])
        for (const result of results) if (result.status === 'rejected') this.report(result.reason)
    }

    async renameSession(sessionId: string, title: string): Promise<void> {
        const normalized = title.trim()
        if (!normalized) throw new Error('A session title cannot be empty')
        const source = this.source(sessionId)
        if (isSourceSessionId(source.sessionId)) {
            if (!source.host.sourceActions) throw new Error('Native source rename is not connected on this Host. The original title is unchanged.')
            await source.host.sourceActions.rename(source.sessionId as SessionId, normalized)
            if (this.disposed || this.hosts.get(source.host.id) !== source.host) throw new Error('The source Host disconnected before its rename confirmation could be applied.')
            await source.host.sessions.refresh()
            return
        }
        const result = await source.host.sessions.using(source.sessionId as SessionId, { source: 'hapiWorkspace' }, reference => reference.binding.session.rename(normalized))
        if (!result.ok) throw new Error(result.error.message)
    }

    async sessionAction(sessionId: string, action: 'pin' | 'unpin' | 'archive' | 'unarchive' | 'fork'): Promise<void> {
        const { host, sessionId: sourceSessionId } = this.source(sessionId)
        const id = sourceSessionId as SessionId
        if (action === 'fork') { this.openSession(sessionResourceId(host.id, await host.navigation.forkSession(id))); return }
        if (action === 'pin') return host.navigation.pinSession(id)
        if (action === 'unpin') return host.navigation.unpinSession(id)
        if (isSourceSessionId(sourceSessionId)) {
            if (!host.sourceActions) throw new Error('Native source archive is not connected on this Host. The conversation remains open.')
            await host.sourceActions.archive(id, action === 'archive')
            if (this.disposed || this.hosts.get(host.id) !== host) throw new Error('The source Host disconnected before its archive confirmation could be applied. The saved pane is preserved.')
        }
        if (action === 'unarchive') {
            if (isSourceSessionId(sourceSessionId)) return
            return host.navigation.unarchiveSession(id)
        }
        // Native source receipts own HHPI archive state. The ordinary Host
        // workspace registry cannot archive a thread it does not execute.
        if (!isSourceSessionId(sourceSessionId)) await host.navigation.archiveSession(id)
        // Archive is an explicit action. Retire its views after the Host confirms.
        for (const window of this.store.getSnapshot().windows) {
            for (const pane of panes(window.root)) {
                if (pane.resource.kind === 'chat' && pane.resource.sessionId === sessionId) this.store.closePane(pane.id)
            }
        }
    }

    /** Export the selected original resource and finite recovery coordinates without resolving or dispatching it. */
    exportSavedPaneReference(paneId: string): string {
        const pane = this.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(value => value.id === paneId)
        if (!pane || pane.resource.kind === 'empty') throw new Error('The saved pane is no longer available to export')
        const reference = legacyPaneReference(pane.resource)
        const resolution = reference ? this.sourceResolutions.get(originalSourceKey(reference)) : undefined
        return JSON.stringify({ version: 1, resource: pane.resource, reference: reference ?? null, recovery: resolution?.recovery ?? [] }, null, 2)
    }

    /** Save the complete local recovery envelope before an application update. */
    checkpoint(signal: AbortSignal): void {
        signal.throwIfAborted()
        if (this.disposed) throw new Error('The workspace is closed')
        if (!this.options.storage) throw new Error('Workspace storage is unavailable; keep this workspace open and retry before updating')
        this.saveLocal(true)
        signal.throwIfAborted()
    }

    /** Layout and its last confirmed baseline are one atomic browser write. */
    private saveLocal(strict = false): void {
        try {
            this.options.storage?.setItem(this.options.storageKey, JSON.stringify({ ...this.store.getSnapshot(),
                ...(this.confirmedLayout ? { syncBase: this.confirmedLayout } : {}),
                ...(this.recoveryLayout ? { layoutRecovery: this.recoveryLayout } : {}),
            }))
        } catch (error) {
            this.publish({ notice: `Workspace save failed: ${errorMessage(error)}`, persistence: 'failed' })
            if (strict) throw error
        }
    }

    private bindLayout(state: WorkspaceState): WorkspaceState {
        const aliased = bindSourceAliases(state, reference => {
            const resolution = this.sourceResolutions.get(originalSourceKey(reference))
            return resolution?.phase === 'ready' ? resolution.target : undefined
        })
        let changed = false
        const node = (value: WorkspaceNode): WorkspaceNode => {
            if (value.type === 'split') {
                const children = value.children.map(node)
                return children.every((child, index) => child === value.children[index]) ? value : { ...value, children }
            }
            if (value.resource.kind !== 'chat') return value
            const sessionId = this.preferredSourceResource(value.resource.sessionId)
            if (sessionId === value.resource.sessionId) return value
            const checkpoint = this.sourceRouteCheckpoints.get(value.id), account = this.options.application?.getSnapshot()
            if (!checkpoint || !account || account.signal.aborted) return value
            try {
                const address = parseSessionResourceId(sessionId), access = this.hosts.get(address.hostId)?.sessions.captureWorkspaceAccess?.(address.sessionId)
                if (!access || access.signal.aborted || checkpoint.sessionId !== address.sessionId) return value
                access.assertCurrent()
                for (const guard of this.paneCloseGuards.get(value.id) ?? []) if (!guard()) return value
                if (!checkpoint.transfer({ hostId: address.hostId, scope: JSON.stringify([account.scope, access.scope]) })) return value
                changed = true
                return { ...value, resource: { ...value.resource, sessionId } }
            } catch { return value }
        }
        const windows = aliased.windows.map(window => {
            const root = node(window.root); return root === window.root ? window : { ...window, root }
        })
        return changed ? { ...aliased, windows, revision: aliased.revision + 1 } : aliased
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
        try { performance.clearMarks('hapi-dsh:workspace:load-remote-start'); performance.mark('hapi-dsh:workspace:load-remote-start') } catch {}
        this.remoteLoading = true
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
                this.queuedSave = sharedWorkspaceState(this.store.getSnapshot())
                this.saveLocal()
            }
            this.remoteLoaded = true
        } catch (error) {
            if (!this.disposed) this.publish({ notice: `Workspace sync failed: ${errorMessage(error)}`, persistence: 'failed' })
        } finally {
            this.remoteLoading = false
            try { performance.clearMarks('hapi-dsh:workspace:load-remote-end'); performance.mark('hapi-dsh:workspace:load-remote-end') } catch {}
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
        this.notices.dispose()
        if (this.disposed) return
        this.disposed = true
        this.lifetime.abort()
        for (const entry of this.sourceResolutions.values()) entry.abort.abort()
        this.sourceResolutions.clear(); this.sourceRequests.clear(); this.sourceResolver = undefined
        this.catalogRefresh = undefined
        for (const entry of this.catalogTargets.values()) entry.abort.abort()
        this.catalogTargets.clear()
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
