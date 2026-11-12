import { useEffect, useState } from 'react'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { CodexCapabilities } from '../remote/codex-access.ts'
import { parseSourceSessionId, sourceSessionId } from '../remote/protocol.ts'
import { nativeThreadSchema, nativeThreadTitle } from '../remote/codex-native.ts'
import { boundedSourceRead } from './remote-read-recovery.ts'
import type { AppEventPosition } from '../workspace/app-service-types.ts'

/** Cancel the previous timer when the reader changes the search phrase. */
export function useDebouncedSidebarQuery(input: string, delay = 180): string {
    const [query, setQuery] = useState(input)
    useEffect(() => {
        if (!input) { setQuery(''); return }
        const timer = setTimeout(() => setQuery(input), delay)
        return () => clearTimeout(timer)
    }, [input, delay])
    return query
}

export interface NativeSourceRoute { hostId: string; machineId: string; sourceId: string; engine: string }
export interface NativeHistoryTarget {
    hostId: string; sessionId: string
    position?: AppEventPosition
    /** Opaque native turn anchor; it is never a projected sequence number. */
    turnCursor?: string
}
export interface NativeThreadSummary {
    nativeId: string; sessionId: string; title: string; cwd: string; updatedAt: number; status: string
    parentThreadId: string | null; nickname: string | null; snippet: string
}
export interface NativeSearchOccurrence { turnId: string; itemId: string; turnCursor: string; snippet: string; start: number; end: number }
export type NativeSourceQueryApi = Pick<HhpiRemoteApi, 'nativeCall' | 'nativeCapabilities'>
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const NATIVE_HISTORY_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'] as const
const readMethods = new Set(['thread/search', 'thread/searchOccurrences', 'thread/list', 'thread/read', 'thread/turns/list'])

/** Read-only native pages belong to a captured Host/account generation. */
export class NativeSourceReads {
    private readonly lifetime = new AbortController()
    private capabilities: Promise<CodexCapabilities> | undefined
    constructor(readonly route: NativeSourceRoute, private readonly api: NativeSourceQueryApi, private readonly current: () => boolean, private readonly invalidated: () => void = () => {}) {}
    isCurrent(): boolean { return !this.lifetime.signal.aborted && this.current() }
    assertCurrent(): void {
        this.lifetime.signal.throwIfAborted()
        if (!this.current()) {
            const error = new Error('This source account or connection changed. Open its current search again.')
            this.dispose(error); this.invalidated(); throw error
        }
    }
    async call(method: string, params: Record<string, unknown>, callerSignal?: AbortSignal): Promise<unknown> {
        return boundedSourceRead(async signal => {
        this.assertCurrent(); signal?.throwIfAborted()
        if (!readMethods.has(method)) throw new Error('This history browser only performs native reads.')
        if (!this.api.nativeCapabilities || !this.api.nativeCall) throw new Error('Native history search is not connected.')
        if (!this.capabilities) {
            const work = boundedSourceRead(signal => this.api.nativeCapabilities!({ sourceId: this.route.sourceId }, signal), this.lifetime.signal).then(response => {
                this.assertCurrent()
                if (!response.ok) throw response.error
                return response.value
            })
            this.capabilities = work
            void work.catch(() => { if (this.capabilities === work) this.capabilities = undefined })
        }
        const capabilities = await this.capabilities
        this.assertCurrent(); signal?.throwIfAborted()
        if (capabilities.methods[method] !== 'read') throw new Error(capabilities.unavailable[method] ?? 'This source does not provide this history read.')
        const response = await this.api.nativeCall({ sourceId: this.route.sourceId, method, params }, signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal)
        this.assertCurrent(); signal?.throwIfAborted()
        if (!response.ok) throw response.error
        if (response.value.status !== 'accepted') throw new Error(response.value.message)
        return response.value.result
        }, callerSignal ? AbortSignal.any([callerSignal, this.lifetime.signal]) : this.lifetime.signal)
    }
    dispose(reason: unknown = new DOMException('The source history scope was released.', 'AbortError')): void { this.lifetime.abort(reason); this.capabilities = undefined }
}

export function nativeThreadSummary(route: NativeSourceRoute, value: unknown, snippet = ''): NativeThreadSummary {
    const thread = nativeThreadSchema.parse(value)
    return { nativeId: thread.id, sessionId: sourceSessionId({ machineId: route.machineId, sourceId: route.sourceId, engine: route.engine, nativeId: thread.id }),
        title: nativeThreadTitle(thread), cwd: thread.cwd, updatedAt: thread.updatedAt * 1000, status: thread.status.type,
        parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null,
        nickname: typeof thread.agentNickname === 'string' ? thread.agentNickname : null, snippet }
}
export function nativeCursorPage(value: unknown): { data: unknown[]; nextCursor: string | null } {
    if (!object(value) || !Array.isArray(value.data) || value.nextCursor != null && typeof value.nextCursor !== 'string') throw new Error('The source returned an invalid native page.')
    return { data: value.data, nextCursor: typeof value.nextCursor === 'string' && value.nextCursor ? value.nextCursor : null }
}
const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
export type NativeSearchScope = 'source' | 'conversation'
export interface NativeSourceSearchSnapshot {
    scope: NativeSearchScope
    query: string; archived: boolean; rows: readonly NativeThreadSummary[]; nextCursor: string | null; busy: boolean; complete: boolean; error: string
    selected: NativeThreadSummary | null; occurrences: readonly NativeSearchOccurrence[]; occurrenceCursor: string | null; occurrenceBusy: boolean; occurrenceError: string
    origin: NativeHistoryTarget | null
}

/** A catalog filter is separate from this source's real full-text search and wire cursors. */
export class NativeSourceSearch {
    private state: NativeSourceSearchSnapshot = { scope: 'source', query: '', archived: false, rows: [], nextCursor: null, busy: false, complete: false, error: '', selected: null, occurrences: [], occurrenceCursor: null, occurrenceBusy: false, occurrenceError: '', origin: null }
    private readonly listeners = new Set<() => void>()
    private readonly reads: NativeSourceReads
    private searchAbort: AbortController | undefined
    private occurrenceAbort: AbortController | undefined
    private readonly searchCursors = new Set<string>()
    private readonly occurrenceCursors = new Set<string>()
    constructor(readonly route: NativeSourceRoute, api: NativeSourceQueryApi, current: () => boolean) { this.reads = new NativeSourceReads(route, api, current, () => this.dispose()) }
    getSnapshot = (): NativeSourceSearchSnapshot => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<NativeSourceSearchSnapshot>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
    setScope(scope: NativeSearchScope): void {
        if (scope === this.state.scope) return
        this.cancelSearch(); this.cancelOccurrences(); this.searchCursors.clear(); this.occurrenceCursors.clear()
        this.publish({ scope, rows: [], nextCursor: null, complete: false, selected: null, occurrences: [], occurrenceCursor: null, error: '', occurrenceError: '' })
    }
    /** Resolve metadata only, then search this exact native thread's visible history. */
    async searchConversation(query: string, sessionId: string): Promise<void> {
        this.setScope('conversation')
        this.cancelSearch(); this.cancelOccurrences(); this.occurrenceCursors.clear()
        this.publish({ query, rows: [], nextCursor: null, error: '', selected: null, occurrences: [], occurrenceCursor: null, occurrenceError: '' })
        if (!query.trim()) return
        const abort = new AbortController(); this.searchAbort = abort
        this.publish({ busy: true })
        try {
            const identity = parseSourceSessionId(sessionId)
            if (identity.machineId !== this.route.machineId || identity.sourceId !== this.route.sourceId || identity.engine !== this.route.engine)
                throw new Error('This conversation belongs to another original source.')
            const response = await this.reads.call('thread/read', { threadId: identity.nativeId, includeTurns: false }, abort.signal)
            if (this.searchAbort !== abort || abort.signal.aborted) return
            if (!object(response) || !object(response.thread) || response.thread.id !== identity.nativeId) throw new Error('The source did not resolve the exact current conversation.')
            const row = nativeThreadSummary(this.route, response.thread)
            if (row.sessionId !== sessionId) throw new Error('The source returned another conversation.')
            this.publish({ rows: [row], selected: row })
            await this.occurrencePage(null)
        } catch (cause) { if (!this.reads.isCurrent()) this.dispose(); else if (this.searchAbort === abort && !abort.signal.aborted) this.publish({ error: failure(cause), nextCursor: null }) }
        finally { if (this.searchAbort === abort) this.publish({ busy: false }) }
    }
    async search(query: string, archived = false): Promise<void> {
        this.setScope('source')
        this.searchAbort?.abort(); this.occurrenceAbort?.abort(); this.searchCursors.clear(); this.occurrenceCursors.clear()
        this.publish({ query, archived, rows: [], nextCursor: null, complete: false, error: '', busy: false, selected: null, occurrences: [], occurrenceCursor: null, occurrenceError: '', occurrenceBusy: false })
        if (query.trim()) await this.page(null)
    }
    async next(): Promise<void> { if (!this.state.busy && this.state.nextCursor) await this.page(this.state.nextCursor) }
    cancelSearch(): void { this.searchAbort?.abort(); this.searchAbort = undefined; this.publish({ busy: false, nextCursor: null }) }
    cancelOccurrences(): void { this.occurrenceAbort?.abort(); this.occurrenceAbort = undefined; this.publish({ occurrenceBusy: false }) }
    private async page(cursor: string | null): Promise<void> {
        const abort = new AbortController(); this.searchAbort = abort
        const { query, archived } = this.state
        this.publish({ busy: true, error: '' })
        try {
            // One explicit query consumes small source-local scan pages. Empty
            // intermediate batches are progress, never a full-source no-match.
            while (!abort.signal.aborted && this.searchAbort === abort) {
                const page = nativeCursorPage(await this.reads.call('thread/search', { searchTerm: query, archived, cursor, limit: 50, sourceKinds: [...NATIVE_HISTORY_SOURCE_KINDS] }, abort.signal))
                if (this.searchAbort !== abort || abort.signal.aborted) return
                if (page.nextCursor && (page.nextCursor === cursor || this.searchCursors.has(page.nextCursor))) throw new Error('The source search cursor did not advance.')
                const rows = page.data.map(value => {
                    if (!object(value) || !object(value.thread) || typeof value.snippet !== 'string') throw new Error('The source returned an invalid thread search result.')
                    return nativeThreadSummary(this.route, value.thread, value.snippet)
                })
                if (page.nextCursor) this.searchCursors.add(page.nextCursor)
                const prior = cursor ? this.state.rows : [], seen = new Set(prior.map(row => row.nativeId))
                this.publish({ rows: [...prior, ...rows.filter(row => !seen.has(row.nativeId))], nextCursor: page.nextCursor, complete: page.nextCursor === null })
                if (page.nextCursor === null) break
                cursor = page.nextCursor
            }
        } catch (cause) { if (!this.reads.isCurrent()) this.dispose(); else if (this.searchAbort === abort && !abort.signal.aborted) this.publish({ error: failure(cause), nextCursor: null }) }
        finally { if (this.searchAbort === abort) this.publish({ busy: false }) }
    }
    async select(row: NativeThreadSummary): Promise<void> {
        this.assertRow(row)
        this.occurrenceAbort?.abort(); this.occurrenceCursors.clear()
        this.publish({ selected: row, occurrences: [], occurrenceCursor: null, occurrenceError: '', occurrenceBusy: false })
        await this.occurrencePage(null)
    }
    async nextOccurrences(): Promise<void> { if (!this.state.occurrenceBusy && this.state.occurrenceCursor) await this.occurrencePage(this.state.occurrenceCursor) }
    private async occurrencePage(cursor: string | null): Promise<void> {
        const selected = this.state.selected
        if (!selected) return
        const abort = new AbortController(); this.occurrenceAbort = abort
        this.publish({ occurrenceBusy: true, occurrenceError: '' })
        try {
            const page = nativeCursorPage(await this.reads.call('thread/searchOccurrences', { threadId: selected.nativeId, searchTerm: this.state.query, cursor, limit: 50 }, abort.signal))
            if (this.occurrenceAbort !== abort || abort.signal.aborted) return
            if (page.nextCursor && (page.nextCursor === cursor || this.occurrenceCursors.has(page.nextCursor))) throw new Error('The source occurrence cursor did not advance.')
            const rows = page.data.map(value => {
                if (!object(value) || typeof value.turnId !== 'string' || typeof value.itemId !== 'string' || typeof value.turnCursor !== 'string' || typeof value.snippet !== 'string'
                    || !object(value.snippetMatchRange) || !Number.isInteger(value.snippetMatchRange.start) || !Number.isInteger(value.snippetMatchRange.end)) throw new Error('The source returned an invalid native message occurrence.')
                return { turnId: value.turnId, itemId: value.itemId, turnCursor: value.turnCursor, snippet: value.snippet, start: Number(value.snippetMatchRange.start), end: Number(value.snippetMatchRange.end) }
            })
            if (page.nextCursor) this.occurrenceCursors.add(page.nextCursor)
            const prior = cursor ? this.state.occurrences : [], seen = new Set(prior.map(row => JSON.stringify([row.turnId, row.itemId])))
            this.publish({ occurrences: [...prior, ...rows.filter(row => !seen.has(JSON.stringify([row.turnId, row.itemId])))], occurrenceCursor: page.nextCursor })
        } catch (cause) { if (!this.reads.isCurrent()) this.dispose(); else if (this.occurrenceAbort === abort && !abort.signal.aborted) this.publish({ occurrenceError: failure(cause) }) }
        finally { if (this.occurrenceAbort === abort) this.publish({ occurrenceBusy: false }) }
    }
    async open(row: NativeThreadSummary, occurrence: NativeSearchOccurrence | undefined, navigate: (target: NativeHistoryTarget) => void | Promise<void>, origin?: NativeHistoryTarget): Promise<void> {
        this.assertRow(row)
        this.reads.assertCurrent()
        const query = this.state.query
        const assertOccurrence = () => {
            if (occurrence && (this.state.query !== query || this.state.selected?.nativeId !== row.nativeId
                || !this.state.occurrences.some(value => value.turnId === occurrence.turnId && value.itemId === occurrence.itemId && value.turnCursor === occurrence.turnCursor))) throw new Error('This message match belongs to an earlier search. Select its exact current result again.')
        }
        assertOccurrence()
        if (this.state.scope === 'source') this.cancelSearch()
        const response = await this.reads.call('thread/read', { threadId: row.nativeId, includeTurns: false })
        if (!object(response) || !object(response.thread) || response.thread.id !== row.nativeId) throw new Error('The source did not resolve the exact native thread.')
        this.assertRow(row); assertOccurrence()
        this.publish({ origin: origin ?? this.state.origin })
        this.reads.assertCurrent()
        await navigate({ hostId: this.route.hostId, sessionId: row.sessionId,
            ...(occurrence ? { position: { kind: 'native', turnId: occurrence.turnId, itemId: occurrence.itemId }, turnCursor: occurrence.turnCursor } : {}) })
    }
    private assertRow(row: NativeThreadSummary): void {
        if (row.sessionId !== sourceSessionId({ machineId: this.route.machineId, sourceId: this.route.sourceId, engine: this.route.engine, nativeId: row.nativeId })
            || !this.state.rows.some(value => value.sessionId === row.sessionId)) throw new Error('This thread result belongs to another source or an earlier query.')
    }
    closeOccurrences(): void { this.occurrenceAbort?.abort(); this.occurrenceAbort = undefined; this.publish({ selected: null, occurrences: [], occurrenceCursor: null, occurrenceBusy: false, occurrenceError: '' }) }
    async returnToOrigin(navigate: (target: NativeHistoryTarget) => void | Promise<void>, fallback?: NativeHistoryTarget): Promise<void> {
        this.reads.assertCurrent(); this.cancelSearch(); this.cancelOccurrences()
        const origin = this.state.origin ?? fallback
        if (origin) await navigate(origin)
    }
    dispose(): void {
        this.searchAbort?.abort(); this.occurrenceAbort?.abort(); this.reads.dispose()
        this.searchAbort = undefined; this.occurrenceAbort = undefined
        this.publish({ query: '', rows: [], nextCursor: null, busy: false, complete: false, selected: null, occurrences: [], occurrenceCursor: null, occurrenceBusy: false, error: '', occurrenceError: '', origin: null })
        this.listeners.clear()
    }
}
