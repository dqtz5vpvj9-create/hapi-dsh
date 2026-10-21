/** Source binding and inventory for the public official ClientTerminals model.
 * No emulator, private model construction, or input replay is implemented here. */
import type { ClientTerminals, TerminalRemote, TerminalView, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { isLegacyTerminalId, legacyTerminalStateSchema, type LegacyTerminalApi, type LegacyTerminalOpenRequest, type LegacyTerminalState } from '../legacy-terminal-types.ts'
import { remoteValue } from '../client-api.ts'
import type { WorkbenchSource } from '../workbench-types.ts'
import type { LegacyTerminalParams } from './legacy-session-terminal.tsx'
import { sourcePathAddress } from './source-path-actions.tsx'

/** The pane's own Session projection must agree with every saved source part. */
export function legacyTerminalSource(params: LegacyTerminalParams, projection: unknown, child: boolean): WorkbenchSource | null {
    if (child) throw new Error('A source child session cannot own an imported root SessionTerminal')
    const source = sourcePathAddress(projection)
    if (!source) return null
    if (params.sourceSessionId !== undefined && params.sourceSessionId !== source.sourceSessionId
        || params.sourceHubId !== undefined && params.sourceHubId !== source.sourceHubId) {
        throw new Error('This terminal’s saved original source does not match the pane’s Session binding')
    }
    return source
}

function failure(message: string): RemoteError<'terminal/unavailable'> {
    return new RemoteError('terminal/unavailable', message, {})
}
function parsedState(value: LegacyTerminalState, sessionId: string): LegacyTerminalState {
    const state = legacyTerminalStateSchema.parse(value)
    if (state.sessionId !== sessionId) throw failure('The legacy terminal belongs to a different display Session')
    return state
}
function ownedState(value: LegacyTerminalState, request: LegacyTerminalOpenRequest): LegacyTerminalState {
    const state = parsedState(value, request.sessionId)
    if (state.terminalId !== request.terminalId || state.source.sourceSessionId !== request.source.sourceSessionId
        || request.source.sourceHubId !== undefined && state.source.sourceHubId !== request.source.sourceHubId
        || request.source.machineId !== undefined && state.source.machineId !== request.source.machineId) {
        throw failure('The legacy terminal response does not match its original source binding')
    }
    return state
}
async function result<T>(read: () => Promise<T>): Promise<RemoteResult<T>> {
    try { return { ok: true, value: await read() } }
    catch (error) { return { ok: false, error: error instanceof RemoteError ? error : failure(error instanceof Error ? error.message : String(error)) } }
}

/** The legacy inventory is separate from the machine-terminal inventory.
 * Standard retained stream/rename routes dispatch by the exact reserved ID on
 * the Host. Pre-existing nonlegacy close intents keep their original owner. */
export function legacyTerminalRemote(api: LegacyTerminalApi, original: TerminalRemote): TerminalRemote {
    const list = async (sessionId: SessionId): Promise<LegacyTerminalState[]> => {
        const states = remoteValue(await api.sourceLegacyTerminals({ sessionId }))
        return states.map(value => parsedState(value, sessionId))
    }
    const requireLegacy = (id: string): void => { if (!isLegacyTerminalId(id)) throw failure('This view cannot attach a nonlegacy terminal identity') }
    return {
        environment: (sessionId, signal) => result(async () => {
            signal?.throwIfAborted()
            const environment = (await list(sessionId)).find(state => state.environment !== null)?.environment
            signal?.throwIfAborted()
            if (!environment) throw failure('Open the exact original source terminal before loading its adapter environment')
            return environment
        }),
        list: sessionId => result(async () => (await list(sessionId)).flatMap(state => state.info ? [state.info] : [])),
        shells: async () => ({ ok: true, value: [] }),
        create: async () => ({ ok: false, error: failure('Legacy terminal views require an explicit original source binding; a new shell cannot be substituted') }),
        attach: (sessionId, id, signal) => { requireLegacy(id); return original.attach(sessionId, id, signal) },
        retain: (sessionId, id, signal) => { requireLegacy(id); return original.retain(sessionId, id, signal) },
        rename: (sessionId, id, title) => { requireLegacy(id); return original.rename(sessionId, id, title) },
        // ClientTerminals owns a durable close journal shared by its module's
        // storage scope. Never falsely acknowledge and erase another owner's
        // recorded close, and never create a source-kill path for this kind.
        close: (sessionId, id) => isLegacyTerminalId(id)
            ? Promise.resolve({ ok: false, error: failure('Closing a legacy terminal view only detaches it; source termination is not confirmed by this protocol') })
            : original.close(sessionId, id),
    }
}

export interface LegacyTerminalViewState {
    readonly phase: 'waiting' | 'opening' | 'ready' | 'failed'
    readonly source: LegacyTerminalState | null
    readonly error: string | null
}

/** Public per-occurrence capability supplied to legacy body/title registrations. */
export interface LegacyTerminalOccurrence {
    readonly state: HostObservable<LegacyTerminalViewState>
    readonly terminal: HostObservable<TerminalViewState>
    /** A real ClientTerminals.view, available only after exact source admission. */
    view(): TerminalView
    mount(request: LegacyTerminalOpenRequest): () => void
    /** Explicitly reload bounded source replay, without resending any input. */
    reload(): Promise<void>
    /** Read current adapter facts; never opens a terminal. */
    read(): Promise<void>
}

class Occurrence implements LegacyTerminalOccurrence {
    readonly state = createSnapshotStore<LegacyTerminalViewState>({ phase: 'waiting', source: null, error: null })
    readonly terminal = createSnapshotStore<TerminalViewState>({ phase: 'idle', writable: false })
    private model: TerminalView | undefined
    private unmodel: (() => void) | undefined
    private request: LegacyTerminalOpenRequest | undefined
    private opening: { controller: AbortController; promise: Promise<void> } | undefined
    private reading: Promise<void> | undefined
    private timer: ReturnType<typeof setTimeout> | undefined
    private holders = 0
    private disposed = false
    private generation = 0
    constructor(private readonly api: LegacyTerminalApi, private readonly models: ClientTerminals,
        readonly sessionId: SessionId, readonly key: string, readonly contentId: string,
        private readonly reconcile: () => void) {}

    view(): TerminalView {
        if (!this.model) throw failure('The exact original terminal has not finished source admission')
        return this.model
    }
    mount(request: LegacyTerminalOpenRequest): () => void {
        if (this.disposed || request.sessionId !== this.sessionId) throw failure('The terminal occurrence belongs to another Session or is disposed')
        if (this.request && (this.request.sessionId !== request.sessionId || this.request.terminalId !== request.terminalId
            || this.request.source.sourceHubId !== request.source.sourceHubId || this.request.source.sourceSessionId !== request.source.sourceSessionId
            || this.request.source.machineId !== request.source.machineId)) {
            throw failure('An existing terminal occurrence cannot be rebound to a different original source')
        }
        this.request = request; this.holders++
        if (!this.model || !this.state.getSnapshot().source) void this.reload()
        else this.poll()
        let released = false
        return () => {
            if (released) return
            released = true; this.holders--
            if (this.holders === 0) { clearTimeout(this.timer); this.timer = undefined; this.opening?.controller.abort() }
            // Official model.mount and window holds own detach. This path
            // never writes a close intent and never terminates a source PTY.
        }
    }
    reload(): Promise<void> {
        if (this.opening) return this.opening.controller.signal.aborted
            ? this.opening.promise.then(() => this.reload()) : this.opening.promise
        if (!this.request || this.disposed || this.holders === 0) return Promise.resolve()
        const request = this.request, controller = new AbortController()
        this.generation++
        this.state.set({ ...this.state.getSnapshot(), phase: 'opening', error: null })
        const promise = (async () => {
            const response = ownedState(remoteValue(await this.api.sourceLegacyTerminalOpen(request, controller.signal)), request)
            controller.signal.throwIfAborted()
            if (!response.info || !response.environment) throw failure(response.error ?? 'The original source did not confirm terminal readiness')
            if (this.model && this.model.id !== response.id) throw failure('Reload returned a different legacy terminal identity')
            // A new legacy source may have appeared after the official
            // Session inventory was cached. Refresh through its public API.
            await this.models.recover(this.sessionId, true)
            controller.signal.throwIfAborted()
            if (!this.model) {
                this.model = this.models.view(this.sessionId, this.key, this.contentId, response.id)
                const publish = (): void => { if (!this.disposed) this.terminal.set(this.model!.state.getSnapshot()) }
                this.unmodel = this.model.state.subscribe(publish); publish()
            }
            // The first view() also starts this same public refresh. Await its
            // settlement so a tab removed during delayed environment lookup
            // cannot leave a newly adopted window hold behind.
            try { await this.model.refresh() } finally { this.reconcile() }
            controller.signal.throwIfAborted()
            this.state.set({ phase: 'ready', source: response, error: null })
        })().catch(error => {
            if (!this.disposed && !controller.signal.aborted) this.state.set({ ...this.state.getSnapshot(), phase: 'failed', error: error instanceof Error ? error.message : String(error) })
        }).finally(() => { if (this.opening?.controller === controller) this.opening = undefined; this.poll() })
        this.opening = { controller, promise }
        return promise
    }
    read(): Promise<void> {
        if (this.reading) return this.reading
        const request = this.request, current = this.state.getSnapshot().source, generation = this.generation
        if (!request || !current || this.disposed) return Promise.resolve()
        const reading = (async () => {
            const raw = remoteValue(await this.api.sourceLegacyTerminalRead({ sessionId: this.sessionId, id: current.id }))
            if (this.disposed || generation !== this.generation || this.state.getSnapshot().source?.id !== current.id) return
            if (!raw) throw failure('The source adapter no longer lists this original terminal')
            const source = ownedState(raw, request)
            if (source.id !== current.id) throw failure('The terminal facts belong to a different compatibility identity')
            const previous = this.state.getSnapshot()
            if (JSON.stringify(previous.source) !== JSON.stringify(source) || previous.error) this.state.set({ ...previous, source, error: previous.phase === 'failed' ? previous.error : null })
        })().catch(error => {
            if (!this.disposed && generation === this.generation) this.state.set({ ...this.state.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
        }).finally(() => { if (this.reading === reading) this.reading = undefined })
        this.reading = reading
        return reading
    }
    private poll(): void {
        if (this.timer || this.disposed || this.holders === 0 || this.opening || !this.model) return
        this.timer = setTimeout(() => { this.timer = undefined; void this.read().finally(() => this.poll()) }, 1500)
    }
    dispose(): void {
        if (this.disposed) return
        this.disposed = true; this.generation++; clearTimeout(this.timer); this.opening?.controller.abort(); this.unmodel?.()
    }
}

/** One registry of source bindings beside one isolated official model service.
 * View/plugin selection remains entirely in sidebarRightTabs and public slots. */
export class LegacyTerminalViews {
    private readonly occurrences = new Map<string, Occurrence>()
    private openTabs: Parameters<ClientTerminals['retainTabs']>[0] = []
    constructor(private readonly api: LegacyTerminalApi, readonly models: ClientTerminals) {}
    retainTabs(tabs: Parameters<ClientTerminals['retainTabs']>[0]): void { this.openTabs = tabs; this.models.retainTabs(tabs) }
    occurrence(sessionId: SessionId, key: string, contentId: string): LegacyTerminalOccurrence {
        const address = JSON.stringify([sessionId, key]), existing = this.occurrences.get(address)
        if (existing) {
            if (existing.contentId !== contentId) throw failure('A legacy terminal occurrence cannot change its original content identity')
            return existing
        }
        const value = new Occurrence(this.api, this.models, sessionId, key, contentId, () => this.models.retainTabs(this.openTabs))
        this.occurrences.set(address, value); return value
    }
    dispose(): void { for (const occurrence of this.occurrences.values()) occurrence.dispose(); this.occurrences.clear(); this.retainTabs([]) }
}
