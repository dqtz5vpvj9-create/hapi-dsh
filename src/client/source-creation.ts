import { randomId } from './random-id.ts'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { createSourceSessionSchema, type CreateSourceSession, type SourceCreationFlavor, type SourceCreationState } from '../hapi-agent/creation-types.ts'
import { errorMessage } from './controller.ts'
import { saveLaunchIntent } from './launch-drafts.ts'

export type SourceLaunchFields = {
    agent: SourceCreationFlavor; machineId: string; directory: string; model: string; effort: string;
    reasoning: string; permission: string; startingMode: 'remote' | 'pty'; copilotMode: string;
    worktree: boolean; worktreeName: string; cursorBase?: string | undefined
}

/** Omitted options stay owned by the original Runner, including model defaults. */
export function sourceCreationRequest(fields: SourceLaunchFields, requestId: string): CreateSourceSession {
    return createSourceSessionSchema.parse({
        requestId, agent: fields.agent, machineId: fields.machineId, directory: fields.directory.trim(),
        ...(fields.model.trim() ? { model: fields.model.trim() } : {}),
        ...(fields.effort ? { effort: fields.effort } : {}),
        ...(fields.reasoning ? { modelReasoningEffort: fields.reasoning } : {}),
        ...(fields.permission ? { permissionMode: fields.permission } : {}),
        ...(fields.copilotMode ? { copilotAgentMode: fields.copilotMode } : {}),
        startingMode: fields.startingMode, sessionType: fields.worktree ? 'worktree' : 'simple',
        ...(fields.worktree && fields.worktreeName.trim() ? { worktreeName: fields.worktreeName.trim() } : {}),
    })
}

type Api = Pick<HapiRemoteApi, 'createSourceSession' | 'sourceCreations' | 'sourceCreationOperation'>
type Snapshot = {
    request: CreateSourceSession | null; rows: SourceCreationState[]; busy: boolean; loading: boolean; error: string | null
}
type RecoveryStore = { getItem(key: string): string | null; setItem(key: string, value: string): void }
const final = (row: SourceCreationState): boolean => row.status === 'ready' || row.status === 'rejected'

/**
 * A source launch is one immutable, durable request. Browser refresh/poll only
 * observes it. An explicit recovery may repeat only that source request ID.
 */
export class SourceCreationController {
    private state: Snapshot = { request: null, rows: [], busy: false, loading: false, error: null }
    private readonly listeners = new Set<() => void>()
    private reading: Promise<void> | undefined
    constructor(private readonly api: Api, private readonly nextId: () => string = () => randomId(),
        private readonly storage?: RecoveryStore, private readonly storageKey = 'hapi-dsh:source-launch') {
        try {
            const parsed = createSourceSessionSchema.safeParse(JSON.parse(storage?.getItem(storageKey) ?? 'null'))
            if (parsed.success) this.state.request = parsed.data
        } catch { /* A damaged browser draft must not dispatch a launch. */ }
    }
    getSnapshot = (): Snapshot => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<Snapshot>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
    private saveRequest(request: CreateSourceSession | null): void {
        saveLaunchIntent(this.storage, this.storageKey, request)
        this.publish({ request })
    }
    private accept(rows: SourceCreationState[]): void {
        const merged = new Map(this.state.rows.map(row => [row.requestId, row]))
        for (const row of rows) {
            const old = merged.get(row.requestId)
            if (old && (old.updatedAt > row.updatedAt || old.status === 'ready' && row.status !== 'ready')) continue
            merged.set(row.requestId, row)
        }
        this.publish({ rows: [...merged.values()] })
        const current = this.current()
        if (current?.status === 'rejected') this.saveRequest(null)
    }
    current(): SourceCreationState | undefined { return this.state.rows.find(row => row.requestId === this.state.request?.requestId) }
    acknowledgeOpened(requestId: string): void {
        if (this.state.request?.requestId === requestId && this.current()?.status === 'ready') this.saveRequest(null)
    }
    async start(fields: SourceLaunchFields, beforeSubmit?: (request: CreateSourceSession) => Promise<void>): Promise<SourceCreationState | null> {
        if (this.state.busy || this.state.request && this.current()?.status !== 'ready') return null
        let request: CreateSourceSession
        try {
            request = sourceCreationRequest(fields, this.nextId()); this.saveRequest(request)
            this.publish({ busy: true }); await beforeSubmit?.(request)
        } catch (error) { this.publish({ busy: false, error: errorMessage(error) }); return null }
        return this.submit(request)
    }
    private async submit(request: CreateSourceSession): Promise<SourceCreationState | null> {
        this.publish({ busy: true, error: null })
        try {
            const row = remoteValue(await this.api.createSourceSession(request))
            this.accept([row]); return row
        } catch (error) {
            const details: unknown = error && typeof error === 'object' ? Reflect.get(error, 'details') : undefined
            if (details && typeof details === 'object' && Reflect.get(details, 'outcome') === 'rejected') this.saveRequest(null)
            this.publish({ error: errorMessage(error) }); return null
        }
        finally { this.publish({ busy: false }) }
    }
    /** Never replays a launch. It also recovers requests started in another browser. */
    refresh = (): Promise<void> => {
        if (this.reading) return this.reading
        this.publish({ loading: true })
        this.reading = (async () => {
            try {
                const source = remoteValue(await this.api.sourceCreations())
                const rows = await Promise.all(source.map(async row => {
                    if (final(row)) return row
                    try { return remoteValue(await this.api.sourceCreationOperation({ requestId: row.requestId, action: 'read' })) }
                    catch { return row }
                }))
                this.accept(rows); this.publish({ error: null })
            } catch (error) { this.publish({ error: errorMessage(error) }) }
            finally { this.reading = undefined; this.publish({ loading: false }) }
        })()
        return this.reading
    }
    async inspect(requestId: string, action: 'read' | 'reconcile'): Promise<SourceCreationState | null> {
        if (this.state.busy) return null
        this.publish({ busy: true, error: null })
        try {
            const row = remoteValue(await this.api.sourceCreationOperation({ requestId, action }))
            this.accept([row]); return row
        } catch (error) { this.publish({ error: errorMessage(error) }); return null }
        finally { this.publish({ busy: false }) }
    }
    recover = async (): Promise<SourceCreationState | null> => {
        const request = this.state.request
        if (!request || this.state.busy) return null
        if (this.current()) return this.inspect(request.requestId, 'reconcile')
        // The reply may have been lost before the workspace recorded a receipt.
        // Its create route reads an existing request and never launches it twice.
        return this.submit(request)
    }
}
