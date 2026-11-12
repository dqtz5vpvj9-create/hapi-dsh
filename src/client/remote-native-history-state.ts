/** Source-owned native task history reads; no execution or composer ownership. */
import { NativeSourceReads, NATIVE_HISTORY_SOURCE_KINDS, nativeCursorPage, nativeThreadSummary,
    type NativeHistoryTarget, type NativeSourceQueryApi, type NativeSourceRoute, type NativeThreadSummary } from './sidebar-search-query.ts'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
interface NativeTaskDetail { row: NativeThreadSummary; lastTurn: { id: string; status: string; error: string | null } | null }
export interface NativeThreadHistorySnapshot {
    nativeId: string; root: NativeThreadSummary | null; archived: boolean; children: readonly NativeThreadSummary[]; nextCursor: string | null
    busy: boolean; error: string; detail: NativeTaskDetail | null; detailBusy: boolean; detailError: string; origin: NativeHistoryTarget | null
}
export class NativeThreadHistory {
    private state: NativeThreadHistorySnapshot = { nativeId: '', root: null, archived: false, children: [], nextCursor: null, busy: false, error: '', detail: null, detailBusy: false, detailError: '', origin: null }
    private readonly listeners = new Set<() => void>()
    private readonly reads: NativeSourceReads
    private abort: AbortController | undefined
    private detailAbort: AbortController | undefined
    private readonly cursors = new Set<string>()
    constructor(readonly route: NativeSourceRoute, api: NativeSourceQueryApi, current: () => boolean) { this.reads = new NativeSourceReads(route, api, current, () => this.dispose()) }
    getSnapshot = (): NativeThreadHistorySnapshot => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<NativeThreadHistorySnapshot>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
    private async thread(nativeId: string, signal?: AbortSignal): Promise<NativeThreadSummary> {
        const response = await this.reads.call('thread/read', { threadId: nativeId, includeTurns: false }, signal)
        if (!object(response) || !object(response.thread) || response.thread.id !== nativeId) throw new Error('The source did not return the exact native task.')
        return nativeThreadSummary(this.route, response.thread)
    }
    async refresh(nativeId: string, archived = this.state.archived): Promise<void> {
        this.abort?.abort(); this.detailAbort?.abort(); this.cursors.clear()
        this.publish({ nativeId, archived, root: null, children: [], nextCursor: null, detail: null, detailBusy: false, detailError: '', error: '', busy: false })
        await this.page(null)
    }
    async next(): Promise<void> { if (!this.state.busy && this.state.nextCursor) await this.page(this.state.nextCursor) }
    private async page(cursor: string | null): Promise<void> {
        const abort = new AbortController(); this.abort = abort
        const { nativeId, archived } = this.state
        this.publish({ busy: true, error: '' })
        try {
            const [root, result] = await Promise.all([
                cursor ? Promise.resolve(this.state.root!) : this.thread(nativeId, abort.signal),
                this.reads.call('thread/list', { parentThreadId: nativeId, archived, cursor, limit: 50, sourceKinds: [...NATIVE_HISTORY_SOURCE_KINDS] }, abort.signal),
            ])
            if (this.abort !== abort || abort.signal.aborted) return
            const page = nativeCursorPage(result)
            if (page.nextCursor && (page.nextCursor === cursor || this.cursors.has(page.nextCursor))) throw new Error('The source task cursor did not advance.')
            const children = page.data.map(value => nativeThreadSummary(this.route, value))
            if (children.some(child => child.parentThreadId !== nativeId)) throw new Error('The source returned a task with a different native parent.')
            if (page.nextCursor) this.cursors.add(page.nextCursor)
            const previous = cursor ? this.state.children : [], seen = new Set(previous.map(child => child.nativeId))
            this.publish({ root, children: [...previous, ...children.filter(child => !seen.has(child.nativeId))], nextCursor: page.nextCursor })
        } catch (cause) { if (!this.reads.isCurrent()) this.dispose(); else if (this.abort === abort && !abort.signal.aborted) this.publish({ error: message(cause) }) }
        finally { if (this.abort === abort) this.publish({ busy: false }) }
    }
    async inspect(row: NativeThreadSummary): Promise<void> {
        this.assertRow(row)
        this.detailAbort?.abort()
        const abort = new AbortController(); this.detailAbort = abort
        this.publish({ detail: null, detailBusy: true, detailError: '' })
        try {
            const [current, turns] = await Promise.all([this.thread(row.nativeId, abort.signal), this.reads.call('thread/turns/list', { threadId: row.nativeId, cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'summary' }, abort.signal)])
            if (this.detailAbort !== abort || abort.signal.aborted) return
            const last = nativeCursorPage(turns).data[0]
            if (last !== undefined && (!object(last) || typeof last.id !== 'string' || !['completed', 'interrupted', 'failed', 'inProgress'].includes(String(last.status)))) throw new Error('The source returned an invalid native task state.')
            this.publish({ detail: { row: current, lastTurn: object(last) ? { id: String(last.id), status: String(last.status), error: object(last.error) && typeof last.error.message === 'string' ? last.error.message : null } : null } })
        } catch (cause) { if (!this.reads.isCurrent()) this.dispose(); else if (this.detailAbort === abort && !abort.signal.aborted) this.publish({ detailError: message(cause) }) }
        finally { if (this.detailAbort === abort) this.publish({ detailBusy: false }) }
    }
    private assertRow(row: NativeThreadSummary): void {
        if (![this.state.root, ...this.state.children].some(value => value?.sessionId === row.sessionId && value.nativeId === row.nativeId)) throw new Error('This task belongs to another source or an earlier task page.')
    }
    async open(row: NativeThreadSummary, navigate: (target: NativeHistoryTarget) => void | Promise<void>, origin?: NativeHistoryTarget): Promise<void> {
        this.assertRow(row)
        const current = await this.thread(row.nativeId)
        this.assertRow(row); this.reads.assertCurrent()
        this.publish({ origin: origin ?? this.state.origin })
        await navigate({ hostId: this.route.hostId, sessionId: current.sessionId })
    }
    async parent(navigate: (target: NativeHistoryTarget) => void | Promise<void>, origin?: NativeHistoryTarget): Promise<void> {
        const nativeId = this.state.root?.parentThreadId
        if (!nativeId) return
        const parent = await this.thread(nativeId)
        if (this.state.root?.parentThreadId !== nativeId) throw new Error('The native parent changed while it was being opened.')
        this.reads.assertCurrent(); this.publish({ origin: origin ?? this.state.origin })
        await navigate({ hostId: this.route.hostId, sessionId: parent.sessionId })
    }
    async returnToOrigin(navigate: (target: NativeHistoryTarget) => void | Promise<void>): Promise<void> { this.reads.assertCurrent(); if (this.state.origin) await navigate(this.state.origin) }
    closeDetail(): void { this.detailAbort?.abort(); this.detailAbort = undefined; this.publish({ detail: null, detailBusy: false, detailError: '' }) }
    dispose(): void {
        this.abort?.abort(); this.detailAbort?.abort(); this.reads.dispose(); this.abort = undefined; this.detailAbort = undefined
        this.publish({ nativeId: '', root: null, children: [], nextCursor: null, busy: false, error: '', detail: null, detailBusy: false, detailError: '', origin: null })
        this.listeners.clear()
    }
}
