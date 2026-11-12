/** Durable read intents use account-scoped original routes and actual reader coordinates. */
import { remoteValue } from '../client-api.ts'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceCatalogRow, WorkspaceController } from '../client/controller.ts'
import { appReadStateSchema, appScopeKey, appSourceKey, appServiceInputs,
    type AppAccountScope, type AppReadIntent, type AppReadPosition, type AppReadState,
    type AppServiceApi, type AppSourceRoute } from './app-service-types.ts'

export type SourceReadStatus = 'pending' | 'ready' | 'error'
export type AppReadApi = Pick<AppServiceApi, 'appReadState' | 'appReadStates' | 'appReadStateWrite'>
export interface SourceReadSyncOptions {
    scope: AppAccountScope
    deviceId: string
    routeForRow(row: WorkspaceCatalogRow): AppSourceRoute | null
    /** Query the exact original event head; a catalog timestamp alone is insufficient. */
    headForRow(row: WorkspaceCatalogRow, signal: AbortSignal): Promise<{ position: AppReadPosition; at: number } | null>
    /** Browser connectivity only suspends retries; it never grants source access. */
    isOnline?(): boolean
}
type Pending = { source: AppSourceRoute; operationId: string; intent: AppReadIntent }
type RouteStatus = { source: AppSourceRoute; status: SourceReadStatus | 'unavailable' }
type CatalogRows = ReturnType<WorkspaceController['getSnapshot']>['catalog']['byId']
type ReadHead = { position: AppReadPosition; at: number }
type CachedHead = { updatedAt: number; value: ReadHead | null }

export class SourceReadSync {
    private readonly source = new Map<string, AppReadState>()
    private readonly pending = new Map<string, Pending>()
    private readonly available = new Set<string>()
    private refreshing = false
    private flushing = false
    private started = false
    private refreshRequested = false
    private retryAttempt = 0
    private timer: ReturnType<typeof setTimeout> | undefined
    private readonly failed = new Set<string>()
    private readonly requests = new Set<AbortController>()
    private readonly lifetime = new AbortController()
    private readonly stops: Array<() => void>
    private readonly outboxKey: string
    private catalog: CatalogRows | undefined
    private readonly rowRoutes = new Map<string, { source: AppSourceRoute; key: string }>()
    private readonly sourceRows = new Map<string, { source: AppSourceRoute; ids: string[] }>()
    private readonly heads = new Map<string, CachedHead>()
    private readonly headRequests = new Map<string, Promise<ReadHead | null>>()
    private readonly intentVersions = new Map<string, number>()
    private headCursor = 0
    private resolvingHeads: Promise<void> | undefined
    constructor(private readonly controller: WorkspaceController, private readonly api: AppReadApi,
        private readonly options: SourceReadSyncOptions, private readonly status?: (value: SourceReadStatus) => void) {
        this.outboxKey = `${controller.options.storageKey}:app-read-outbox:${appScopeKey(options.scope)}:${options.deviceId}`
        try {
            const raw: unknown = JSON.parse(controller.options.storage?.getItem(this.outboxKey) ?? '[]')
            if (Array.isArray(raw)) for (const item of raw) {
                const parsed = appServiceInputs.appReadStateWrite.safeParse({ ...item, deviceId: options.deviceId, expectedRevision: 0 })
                if (parsed.success) {
                    const { source, operationId, intent } = parsed.data
                    this.pending.set(this.key(source), { source, operationId, intent })
                }
            }
        } catch { /* Invalid optional recovery metadata cannot alter server watermarks. */ }
        this.stops = [controller.sidebar.onReadIntent(intent => {
            // A local display timestamp is never evidence that source content was read.
            if (intent.kind !== 'unread') return
            const source = this.route(intent.id)?.source
            if (source) this.enqueue({ source, operationId: crypto.randomUUID(), intent: { kind: 'unread', at: Date.now() } })
        }), controller.sidebar.installReadActions({
            canMarkSeen: id => {
                return !this.lifetime.signal.aborted && !!this.route(id)
                    && controller.sidebar.getSnapshot().readStatus[id] !== 'unavailable'
            },
            markSeen: id => { void this.markSeen(id) },
        }), controller.subscribe(() => {
            if (this.catalog !== controller.getSnapshot().catalog.byId) this.adopt()
        })]
    }
    private row(id: string): WorkspaceCatalogRow | undefined { return this.controller.getSnapshot().catalog.byId[id] }
    private key(source: AppSourceRoute): string { return appSourceKey(this.options.scope, source) }
    /** Routes belong to this account owner and the current catalog publication. */
    private indexRoutes(): void {
        const catalog = this.controller.getSnapshot().catalog.byId
        if (this.catalog === catalog) return
        this.catalog = catalog; this.rowRoutes.clear(); this.sourceRows.clear()
        for (const row of Object.values(catalog)) {
            const source = this.options.routeForRow(row)
            if (!source) continue
            const key = this.key(source), existing = this.sourceRows.get(key)
            this.rowRoutes.set(row.id, { source, key })
            if (existing) existing.ids.push(row.id)
            else this.sourceRows.set(key, { source, ids: [row.id] })
        }
        for (const key of this.heads.keys()) if (!this.sourceRows.has(key)) this.heads.delete(key)
    }
    private route(id: string): { source: AppSourceRoute; key: string } | undefined { this.indexRoutes(); return this.rowRoutes.get(id) }
    private persistPending(): void {
        try { this.controller.options.storage?.setItem(this.outboxKey, JSON.stringify([...this.pending.values()])) }
        catch { /* Live synchronization remains available when browser storage is blocked. */ }
    }
    private enqueue(value: Pending): void {
        this.intentVersions.set(this.key(value.source), (this.intentVersions.get(this.key(value.source)) ?? 0) + 1)
        this.pending.set(this.key(value.source), value); this.persistPending()
        this.adopt(); this.setRouteStatus(value.source, 'pending'); void this.flush()
    }
    private setRouteStatus(source: AppSourceRoute, status: SourceReadStatus | 'unavailable'): void {
        this.setRouteStatuses([{ source, status }])
    }
    private setRouteStatuses(records: readonly RouteStatus[]): void {
        this.indexRoutes()
        this.controller.sidebar.setReadStatuses(records.flatMap(({ source, status }) =>
            (this.sourceRows.get(this.key(source))?.ids ?? []).map(id => ({ id, value: status }))))
    }
    private accept(value: AppReadState, expected: AppSourceRoute): void {
        const state = appReadStateSchema.parse(value), key = this.key(expected)
        if (this.key(state.source) !== key || appScopeKey(state.scope) !== appScopeKey(this.options.scope)) throw new Error('The reading state belongs to another account or original source')
        if (state.revision >= (this.source.get(key)?.revision ?? -1)) this.source.set(key, state)
    }
    private adopt(): void {
        if (this.lifetime.signal.aborted) return
        this.indexRoutes()
        this.controller.sidebar.mergeSource([...this.rowRoutes].flatMap(([id, { key }]) => {
            const intent = this.pending.get(key)?.intent
            if (intent) return [{ id, seenAt: intent.kind === 'seen' ? intent.at
                : this.source.get(key)?.seen?.at ?? this.controller.sidebar.getSnapshot().seen[id] ?? 0,
                manualUnreadAt: intent.kind === 'unread' ? intent.at : null }]
            const state = this.available.has(key) && !this.pending.has(key) ? this.source.get(key) : undefined
            return state ? [{ id, seenAt: state.seen?.at ?? 0, manualUnreadAt: state.manualUnreadAt }] : []
        }))
        this.controller.sidebar.setSourceUnread([...this.rowRoutes].flatMap(([id, { key }]) => {
            const row = this.row(id), head = this.heads.get(key), state = this.available.has(key) ? this.source.get(key) : undefined
            const intent = this.pending.get(key)?.intent
            const seen = intent?.kind === 'seen' ? intent : state?.seen
            if (!row || !head?.value || head.updatedAt !== row.updatedAt || !seen) return []
            // Explicit unread remains in sidebar.unread; it always takes precedence.
            const comparable = sameGeneration(seen.position, head.value.position)
            return [{ id, updatedAt: row.updatedAt, unread: !comparable || seen.position.seq < head.value.position.seq }]
        }))
    }
    /** A metadata version is only a cache key; the original readable event decides unread. */
    private async readHead(row: WorkspaceCatalogRow, source: AppSourceRoute): Promise<ReadHead | null> {
        const key = this.key(source), updatedAt = row.updatedAt, cached = this.heads.get(key)
        if (cached?.updatedAt === updatedAt) return cached.value
        const requestKey = JSON.stringify([key, updatedAt]), existing = this.headRequests.get(requestKey)
        if (existing) return existing
        const request = this.invoke(signal => this.options.headForRow(row, signal)).then(head => {
            if (!this.lifetime.signal.aborted && this.route(row.id)?.key === key && this.row(row.id)?.updatedAt === updatedAt)
                this.heads.set(key, { updatedAt, value: head })
            return head
        }).finally(() => { this.headRequests.delete(requestKey) })
        this.headRequests.set(requestKey, request)
        return request
    }
    /** At most four necessary sources per refresh, with two bounded original-head requests in flight. */
    private resolveHeads(): Promise<void> {
        return this.resolvingHeads ??= this.resolveHeadBatch().finally(() => { this.resolvingHeads = undefined })
    }
    private async resolveHeadBatch(): Promise<void> {
        this.indexRoutes()
        const focused = this.controller.store.focusedPane().resource
        const unresolved = [...this.sourceRows].flatMap(([key, { source, ids }]) => {
            const state = this.available.has(key) ? this.source.get(key) : undefined
            const row = ids.map(id => this.row(id)).find(value => value !== undefined)
            if (!row || !state?.seen || state.manualUnreadAt !== null || this.pending.get(key)?.intent.kind === 'unread'
                || row.updatedAt <= state.seen.at || this.heads.get(key)?.updatedAt === row.updatedAt) return []
            return [{ row, source, priority: focused.kind !== 'empty' && ids.includes(focused.sessionId) ? 0 : 1 }]
        })
        const focusedCandidate = unresolved.find(candidate => candidate.priority === 0)
        const candidates = focusedCandidate ? [focusedCandidate] : []
        const rest = unresolved.filter(candidate => candidate !== focusedCandidate)
        if (rest.length) {
            const start = this.headCursor % rest.length, count = Math.min(4 - candidates.length, rest.length)
            for (let offset = 0; offset < count; offset++) candidates.push(rest[(start + offset) % rest.length]!)
            // A failed prefix must not occupy all future refresh slots.
            this.headCursor = (start + count) % rest.length
        }
        let next = 0
        await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
            while (!this.lifetime.signal.aborted) {
                const candidate = candidates[next++]
                if (!candidate) return
                try { await this.readHead(candidate.row, candidate.source) }
                catch { /* No original content head means unknown, never a successful mark as read. */ }
            }
        }))
        this.adopt()
    }
    /** Called only after the mounted reader commits a visible original event position. */
    commitReading(rowId: string, source: AppSourceRoute, position: AppReadPosition, at: number): void {
        if (this.lifetime.signal.aborted) return
        const route = this.route(rowId)?.source
        if (!route || this.key(route) !== this.key(source)) return
        const request = appServiceInputs.appReadStateWrite.parse({ deviceId: this.options.deviceId, source,
            operationId: crypto.randomUUID(), expectedRevision: 0, intent: { kind: 'seen', position, at } })
        const previousIntent = this.pending.get(this.key(source))?.intent
        const previousSeen = this.source.get(this.key(source))?.seen
        const oldPosition = previousIntent?.kind === 'seen' ? previousIntent.position : previousIntent ? undefined : previousSeen?.position
        if (oldPosition && sameGeneration(oldPosition, position) && oldPosition.seq > position.seq) return
        if (previousIntent?.kind === 'seen' && oldPosition && sameGeneration(oldPosition, position)
            && oldPosition.seq === position.seq && previousIntent.at >= at) return
        if (!previousIntent && previousSeen && oldPosition && sameGeneration(oldPosition, position) && oldPosition.seq === position.seq
            && previousSeen.at >= at && this.source.get(this.key(source))?.manualUnreadAt === null) return
        this.enqueue({ source, operationId: request.operationId, intent: request.intent })
    }
    private async markSeen(id: string): Promise<void> {
        const row = this.row(id), route = this.route(id)?.source
        if (!row || !route || this.lifetime.signal.aborted) return
        this.controller.sidebar.setReadStatus(id, 'pending')
        try {
            const key = this.key(route), intentVersion = this.intentVersions.get(key) ?? 0, revision = this.source.get(key)?.revision
            const head = await this.readHead(row, route)
            if (this.lifetime.signal.aborted) return
            if (this.route(id)?.key !== key || this.row(id)?.updatedAt !== row.updatedAt) return
            if ((this.intentVersions.get(key) ?? 0) !== intentVersion || this.source.get(key)?.revision !== revision) {
                this.adopt(); return
            }
            if (!head) { this.controller.sidebar.setReadStatus(id, 'unavailable'); return }
            this.commitReading(id, route, head.position, head.at)
            if (!this.pending.has(this.key(route))) this.setRouteStatus(route, this.available.has(this.key(route)) ? 'ready' : 'error')
        } catch {
            if (!this.lifetime.signal.aborted && this.route(id)?.key === this.key(route)) this.controller.sidebar.setReadStatus(id, 'error')
        }
    }
    /** One bounded poll/retry owner, shared by all panes of this application account. */
    start(): void { if (!this.started) { this.started = true; void this.refresh() } }
    reconnect(): void {
        this.retryAttempt = 0
        if (this.refreshing || this.flushing) {
            this.refreshRequested = true
            for (const request of this.requests) request.abort(new DOMException('Reading synchronization is reconnecting', 'AbortError'))
            return
        }
        void this.refresh()
    }
    /** A half-open unary fetch must not keep the account outbox stuck across reconnect. */
    private async invoke<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const request = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, request.signal])
        this.requests.add(request)
        let timer: ReturnType<typeof setTimeout> | undefined
        const stop = (): void => rejectAbort?.(signal.reason)
        let rejectAbort: ((reason: unknown) => void) | undefined
        try {
            signal.throwIfAborted()
            return await new Promise<T>((resolve, reject) => {
                rejectAbort = reject; signal.addEventListener('abort', stop, { once: true })
                timer = setTimeout(() => request.abort(new DOMException('Reading synchronization timed out', 'TimeoutError')), 30_000)
                timer.unref?.()
                // Attach both handlers even if the carrier ignores cancellation and settles late.
                Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal) }).then(resolve, reject)
            })
        } finally {
            if (timer !== undefined) clearTimeout(timer)
            signal.removeEventListener('abort', stop); this.requests.delete(request)
        }
    }
    private schedule(): void {
        if (!this.started || this.lifetime.signal.aborted || this.refreshing || this.flushing) return
        if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
        if (this.options.isOnline?.() === false) return
        if (this.refreshRequested) { this.refreshRequested = false; void this.refresh(); return }
        const delay = this.failed.size ? Math.min(60_000, 1000 * 2 ** Math.min(this.retryAttempt++, 6)) : 15_000
        if (!this.failed.size) this.retryAttempt = 0
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh() }, delay)
        this.timer.unref?.()
    }
    async refresh(): Promise<void> {
        if (this.lifetime.signal.aborted || this.refreshing) return
        if (this.flushing) { this.refreshRequested = true; return }
        if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
        if (this.options.isOnline?.() === false) return
        this.refreshing = true; this.status?.('pending')
        const routes = new Map([...this.pending.values()].map(item => [this.key(item.source), item.source]))
        const statuses = new Map<string, RouteStatus>()
        try {
            this.indexRoutes()
            for (const [key, { source }] of this.sourceRows) routes.set(key, source)
            const all = [...routes.values()]
            for (const key of this.available) if (!routes.has(key)) this.available.delete(key)
            for (const key of this.failed) if (!routes.has(key)) this.failed.delete(key)
            let failed = false
            const accept = (state: AppReadState | null, source: AppSourceRoute) => {
                this.accept(state ?? { scope: this.options.scope, source, revision: 0, seen: null, manualUnreadAt: null, lastOperationId: null }, source)
                this.available.add(this.key(source))
                this.failed.delete(this.key(source))
                if (!this.pending.has(this.key(source))) statuses.set(this.key(source), { source, status: 'ready' })
            }
            for (let offset = 0; offset < all.length; offset += 200) {
                const sources = all.slice(offset, offset + 200)
                try {
                    const states = remoteValue(await this.invoke(signal => this.api.appReadStates({ sources }, signal)))
                    if (this.lifetime.signal.aborted) return
                    if (states.length !== sources.length) throw new Error('The reading state batch does not match its original sources')
                    states.forEach((state, index) => accept(state, sources[index]!))
                } catch (error) {
                    if (this.lifetime.signal.aborted) return
                    if (invocationEnded(error) || readTransportFailure(error)) throw error
                    // The Host admits a complete batch before returning it. An
                    // unavailable original source must not hide unrelated states.
                    let next = 0, terminal: { error: unknown } | undefined
                    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
                        while (!this.lifetime.signal.aborted && !terminal) {
                            const source = sources[next++]
                            if (!source) return
                            try {
                                const state = remoteValue(await this.invoke(signal => this.api.appReadState({ source }, signal)))
                                if (this.lifetime.signal.aborted) return
                                accept(state, source)
                            } catch (failure) {
                                if (this.lifetime.signal.aborted) return
                                if (invocationEnded(failure) || readTransportFailure(failure)) { terminal = { error: failure }; return }
                                failed = true; this.available.delete(this.key(source)); this.failed.add(this.key(source)); statuses.set(this.key(source), { source, status: 'error' })
                            }
                        }
                    }))
                    if (terminal) throw terminal.error
                }
                this.setRouteStatuses([...statuses.values()]); statuses.clear()
            }
            if (this.lifetime.signal.aborted) return
            this.adopt(); this.status?.(failed ? 'error' : 'ready')
        } catch { if (!this.lifetime.signal.aborted) {
            for (const route of routes.values()) { this.available.delete(this.key(route)); this.failed.add(this.key(route)) }
            this.setRouteStatuses([...routes.values()].map(source => ({ source, status: 'error' })))
            this.status?.('error')
        } }
        finally { this.refreshing = false }
        await this.flush(true)
        // Optional content-head reads must not hold durable outbox recovery or the next state poll.
        void this.resolveHeads().catch(() => {})
        this.schedule()
    }
    private async flush(fromRefresh = false): Promise<void> {
        if (this.lifetime.signal.aborted || !this.available.size || this.flushing || this.refreshing) return
        if (this.options.isOnline?.() === false) return
        this.flushing = true
        try {
            for (const [key] of this.pending) {
                if (!this.available.has(key)) continue
                try {
                    let conflicts = 0
                    while (!this.lifetime.signal.aborted && this.pending.has(key)) {
                        const item = this.pending.get(key)!, previous = this.source.get(key)
                        const result = remoteValue(await this.invoke(signal => this.api.appReadStateWrite({ ...item, deviceId: this.options.deviceId,
                            expectedRevision: previous?.revision ?? 0 }, signal)))
                        if (this.lifetime.signal.aborted) return
                        this.accept(result.state, item.source)
                        if (this.pending.get(key) !== item) continue
                        if (!result.applied && item.intent.kind === 'seen' && result.state.manualUnreadAt !== null) {
                            // A read based on the earlier revision cannot retry over a newer explicit unread intent.
                            this.pending.delete(key); this.persistPending(); this.setRouteStatus(item.source, 'ready'); break
                        }
                        const changedGeneration = item.intent.kind === 'seen' && result.state.seen
                            && !sameGeneration(item.intent.position, result.state.seen.position)
                        if (result.applied || changedGeneration) {
                            this.failed.delete(key)
                            this.pending.delete(key); this.persistPending(); this.setRouteStatus(item.source, 'ready')
                        } else if (++conflicts >= 4) { this.failed.add(key); break }
                    }
                } catch (error) {
                    if (this.lifetime.signal.aborted) return
                    if (invocationEnded(error) || readTransportFailure(error)) throw error
                    this.available.delete(key); this.failed.add(key)
                    const item = this.pending.get(key)
                    if (item) this.setRouteStatus(item.source, 'error')
                    this.status?.('error')
                }
            }
            this.adopt()
        } catch {
            // The same durable operation identity reconciles an unknown acknowledgement.
            if (!this.lifetime.signal.aborted) {
                this.available.clear()
                for (const key of this.pending.keys()) this.failed.add(key)
                this.setRouteStatuses([...this.pending.values()].map(({ source }) => ({ source, status: 'error' })))
                this.status?.('error')
            }
        } finally { this.flushing = false; if (!fromRefresh) this.schedule() }
    }
    dispose(): void {
        this.lifetime.abort(); if (this.timer !== undefined) clearTimeout(this.timer)
        for (const stop of this.stops) stop(); this.pending.clear()
        this.heads.clear(); this.intentVersions.clear()
    }
}
/** Pinned Gateway wraps fetch failures; neither a source denial nor malformed data is a carrier outage. */
function readTransportFailure(error: unknown): boolean {
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) return true
    const remote = remoteErrorOf(error)
    if (remote && (remote.code !== 'gateway/internal'
        || !/^client api: appServices\/appReadState(?:s|Write)? failed: /u.test(remote.message))) return false
    const message = remote?.message ?? (error instanceof Error ? error.message : '')
    const http = /HTTP (\d{3})\b/u.exec(message)
    if (http) return true // The common app transport failed before a source-specific result existed.
    return remote ? /fetch|network|connection|socket|offline|timed? ?out/iu.test(message)
        : /^(?:Failed to fetch|Load failed|NetworkError\b|Network request failed|offline$)/iu.test(message)
}
function invocationEnded(error: unknown): boolean {
    const remote = remoteErrorOf(error)
    return remote?.code === 'gateway/cancelled' || remote?.code === 'remote-access/denied'
        && (remote.details.action === 'appServices' || remote.details.action.startsWith('appServices/'))
}
function sameGeneration(left: AppReadPosition, right: AppReadPosition): boolean {
    return left.kind === right.kind && (left.kind !== 'hhpi' || right.kind === 'hhpi' && left.epoch === right.epoch)
}
export function installSourceReadSync(controller: WorkspaceController, api: AppReadApi, options: SourceReadSyncOptions,
    status?: (value: SourceReadStatus) => void): () => void {
    const sync = new SourceReadSync(controller, api, options, status)
    sync.start()
    return () => { sync.dispose() }
}
