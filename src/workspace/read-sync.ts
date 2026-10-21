import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import type { SourceReadState } from '../native-library-types.ts'
import type { WorkspaceController } from '../client/controller.ts'
import { sourceIdentity } from './legacy.ts'
import type { ReadIntent } from './sidebar-state.ts'

export type SourceReadStatus = 'pending' | 'ready' | 'error'

/** CAS bookmarks follow their original HAPI session across display generations. */
export class SourceReadSync {
    private readonly source = new Map<string, SourceReadState>()
    private readonly pending = new Map<string, ReadIntent>()
    private loaded = false
    private refreshing = false
    private flushing = false
    private disposed = false
    private readonly stops: Array<() => void>
    constructor(private readonly controller: WorkspaceController, private readonly api: Pick<HapiRemoteApi, 'sourceReadStates' | 'sourceReadStateWrite'>,
        private readonly status?: (value: SourceReadStatus) => void) {
        try {
            const raw: unknown = JSON.parse(controller.options.storage?.getItem(`${controller.options.storageKey}:native-read-outbox`) ?? '[]')
            if (Array.isArray(raw)) for (const item of raw) {
                if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && item[0].length <= 256
                    && item[1] && typeof item[1] === 'object' && typeof item[1].id === 'string'
                    && ['seen', 'unread'].includes(item[1].kind) && Number.isFinite(item[1].at) && item[1].at >= 0) {
                    this.pending.set(item[0], item[1] as ReadIntent)
                }
            }
        } catch { /* Invalid local recovery metadata does not alter source bookmarks. */ }
        this.stops = [controller.sidebar.onReadIntent(intent => {
            const row = controller.getSnapshot().catalog.byId[intent.id]
            const source = row?.hostId === 'local' ? sourceIdentity(row) : null
            if (!source) return
            this.pending.set(source.sessionId, intent)
            this.persistPending()
            void this.flush()
        }), controller.subscribe(() => this.adopt())]
    }
    private persistPending(): void {
        try { this.controller.options.storage?.setItem(`${this.controller.options.storageKey}:native-read-outbox`, JSON.stringify([...this.pending])) }
        catch { /* Continue live sync when this browser blocks storage. */ }
    }
    private adopt(): void {
        if (this.disposed) return
        this.controller.sidebar.mergeSource(Object.values(this.controller.getSnapshot().catalog.byId).flatMap(row => {
            const identity = row.hostId === 'local' ? sourceIdentity(row) : null
            const state = identity && !this.pending.has(identity.sessionId) ? this.source.get(identity.sessionId) : undefined
            return state ? [{ id: row.id, seenAt: state.seenAt, manualUnreadAt: state.manualUnreadAt }] : []
        }))
    }
    async refresh(): Promise<void> {
        if (this.disposed || this.refreshing) return
        this.refreshing = true
        this.status?.('pending')
        try {
            const states = remoteValue(await this.api.sourceReadStates({}))
            if (this.disposed) return
            for (const [id, state] of Object.entries(states)) if (state.version >= (this.source.get(id)?.version ?? -1)) this.source.set(id, state)
            this.loaded = true; this.adopt(); this.status?.('ready')
        } catch (error) { if (!this.disposed) { this.status?.('error'); this.controller.report(error) } }
        finally { this.refreshing = false }
        await this.flush()
    }
    private async flush(): Promise<void> {
        if (this.disposed || !this.loaded || this.flushing) return
        this.flushing = true
        try {
            for (const [sourceId] of this.pending) {
                let conflicts = 0
                while (!this.disposed && this.pending.has(sourceId)) {
                    const intent = this.pending.get(sourceId)!
                    const previous = this.source.get(sourceId) ?? { version: 0, seenAt: 0, manualUnreadAt: null }
                    const result = remoteValue(await this.api.sourceReadStateWrite({ sourceSessionId: sourceId, expectedVersion: previous.version,
                        seenAt: intent.kind === 'seen' ? Math.max(previous.seenAt, intent.at) : previous.seenAt,
                        manualUnreadAt: intent.kind === 'unread' ? intent.at : null,
                    }))
                    if (this.disposed) return
                    this.source.set(sourceId, result.state)
                    if (result.applied && this.pending.get(sourceId) === intent) { this.pending.delete(sourceId); this.persistPending() }
                    if (!result.applied && ++conflicts >= 4) break
                }
            }
            this.adopt()
        } catch (error) {
            // A later read reconciles a lost reply. The bookmark intent remains
            // queued; no native execution mutation is involved in this retry.
            if (!this.disposed) this.controller.report(error)
        } finally { this.flushing = false }
    }
    dispose(): void { this.disposed = true; for (const stop of this.stops) stop(); this.pending.clear() }
}

export function installSourceReadSync(controller: WorkspaceController, api: HapiRemoteApi, status?: (value: SourceReadStatus) => void): () => void {
    const sync = new SourceReadSync(controller, api, status)
    void sync.refresh()
    const timer = setInterval(() => { void sync.refresh() }, 15000)
    return () => { clearInterval(timer); sync.dispose() }
}
