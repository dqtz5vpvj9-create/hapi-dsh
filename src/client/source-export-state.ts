/** Explicit exports read independent official history windows, never a visible Pane snapshot. */
import type { ISessions, HistorySnapshotV1, SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { appSourceRouteSchema, type AppSourceRoute } from '../workspace/app-service-types.ts'
import { remoteValue } from '../client-api.ts'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { exportConversationMarkdown } from './source-export-markdown.ts'
export const SOURCE_EXPORT_FORMAT_KEY = 'hapi.sessionExportFormat'
export type SourceExportFormat = 'json' | 'markdown'
export interface SourceExportPreferences {
    getItem(key: typeof SOURCE_EXPORT_FORMAT_KEY): string | null
    setItem(key: typeof SOURCE_EXPORT_FORMAT_KEY, value: string): void
    subscribe?(listener: () => void): () => void
}
export type SourceExportWarning = { type: 'warning'; count: number; limit: number; estimatedBytes: number }
export type SourceExportReady = { type: 'ready'; fileName: string; bytes: number; blob: Blob }
export type PreparedSourceExport = SourceExportReady & { url: string }
export interface SourceExportApi {
    sourceExport(request: { source: AppSourceRoute; format: SourceExportFormat; force?: boolean }, signal: AbortSignal): Promise<SourceExportWarning | SourceExportReady>
    /** One bounded latest window for an explicit input reference, not a full export. */
    sourceReference?(source: AppSourceRoute, signal: AbortSignal): Promise<SourceReferencePage>
}
export interface OriginalExportWindow {
    title: string; feed: { initial: ExportPage; read(request: { kind: 'latest' } | { kind: 'before'; cursor: string }, envelope: typeof budget, signal: AbortSignal): Promise<ExportPage> }; assertCurrent(): void; release(): void
    /** HHPI can publish newly read native pages into its observation index. */
    materializesHistory?: true
}
export interface OriginalExportEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }
export interface ExportPage extends Omit<HistorySnapshotV1, 'entries'> { entries: readonly { type: 'event' | 'transient'; event: OriginalExportEvent }[] }
export interface SourceReferencePage extends ExportPage { title: string; latestSourceSeq: number | null; searchedPages: number }
export interface SourceReferenceMessage { role: 'user' | 'assistant'; seq: number; text: string }
/** Text context deliberately excludes plans, attachments, tool output and system instructions. */
export function sourceReferenceMessage(event: OriginalExportEvent): SourceReferenceMessage | undefined {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    const body = event.type === 'user/message' ? data : data.message
    if (!body || typeof body !== 'object' || !('content' in body) || !Array.isArray(body.content)) return
    const text = body.content.flatMap(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
    return text.trim() ? { role: event.type === 'user/message' ? 'user' : 'assistant', seq: event.seq, text } : undefined
}
export type OpenOriginalExport = (source: AppSourceRoute, signal: AbortSignal) => Promise<OriginalExportWindow>
const budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 }
const SOFT_EVENTS = 10_000, SOFT_BYTES = 16 * 1024 * 1024, MAX_BYTES = 100 * 1024 * 1024
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Each actual Host graph passes its authenticated official DSH and HHPI read namespaces. */
export function createSessionSourceExporter(sessions: Pick<ISessions, 'list'>, hostId: string, current: () => boolean,
    ordinary?: Pick<SessionRemote, 'events'>, hhpi?: Pick<HhpiRemoteApi, 'read'>): SourceExportApi {
    return new OriginalSourceExporter(async (source, signal) => {
        if (source.hostId !== hostId) throw new Error('The original export belongs to another Host graph')
        const assertCurrent = () => { signal.throwIfAborted(); if (!current()) throw new Error('The authenticated source generation changed during export') }
        assertCurrent()
        if (source.kind === 'hhpi') {
            if (!hhpi) throw new Error('The original source reader is unavailable')
            const first = remoteValue(await hhpi.read({ sessionId: source.sessionId, limit: 160 }, signal)); assertCurrent()
            const convert = (page: typeof first): ExportPage => {
                if (page.session.id !== source.sessionId) throw new Error('The export page belongs to another original source')
                if (page.epoch !== first.epoch) throw new Error('The original history changed during export. Prepare it again; no partial export was created')
                return { version: JSON.stringify([page.epoch, page.version]), entries: page.entries,
                    before: page.before === null ? null : String(page.before), after: page.after === null ? null : String(page.after),
                    hasBefore: page.hasBefore, hasAfter: page.hasAfter }
            }
            return { title: first.session.title, materializesHistory: true, assertCurrent, release() {}, feed: { initial: convert(first), async read(request, _budget, signal) {
                assertCurrent()
                const page = remoteValue(await hhpi.read({ sessionId: source.sessionId, epoch: first.epoch, limit: 160,
                    ...(request.kind === 'before' ? { before: Number(request.cursor) } : {}) }, signal))
                assertCurrent(); return convert(page)
            } } }
        }
        if (!ordinary) throw new Error('The official DSH source reader is unavailable')
        const address = { kind: 'session' as const, sessionId: source.sessionId as SessionId }
        const first = remoteValue(await ordinary.events({ address, maxMessages: 500 }, signal)); assertCurrent()
        const version = `dsh-cut:${first.cursor}`
        const convert = (page: typeof first): ExportPage => {
            if (page.cursor !== first.cursor) throw new Error('The original DSH history cut changed during export; no partial export was created')
            return { version, entries: page.records, before: page.records[0] ? String(page.records[0].event.seq) : null,
                after: page.records.at(-1) ? String(page.records.at(-1)!.event.seq) : null, hasBefore: page.hasMore, hasAfter: false }
        }
        return { title: sessions.list.getSnapshot().byId[source.sessionId as SessionId]?.displayTitle ?? source.sessionId,
            assertCurrent, release() {}, feed: { initial: convert(first), async read(request, _budget, signal) {
                assertCurrent()
                const page = remoteValue(await ordinary.events({ address, throughSeq: first.cursor, maxMessages: 500,
                    ...(request.kind === 'before' ? { beforeSeq: Number(request.cursor) } : {}) }, signal))
                assertCurrent(); return convert(page)
            } } }
    })
}

export class OriginalSourceExporter implements SourceExportApi {
    constructor(private readonly open: OpenOriginalExport) {}
    async sourceReference(source: AppSourceRoute, signal: AbortSignal): Promise<SourceReferencePage> {
        const window = await this.open(appSourceRouteSchema.parse(source), signal)
        let page = window.feed.initial
        const latestSourceSeq = page.entries.at(-1)?.event.seq ?? null, cursors = new Set<string>()
        try {
            for (let searchedPages = 1; searchedPages <= 4; searchedPages++) {
                signal.throwIfAborted(); window.assertCurrent()
                if (page.entries.some(entry => entry.type === 'event' && sourceReferenceMessage(entry.event))) {
                    return { ...page, title: window.title, latestSourceSeq, searchedPages }
                }
                if (searchedPages === 4 || !page.hasBefore || !page.before || cursors.has(page.before)) break
                cursors.add(page.before)
                page = await window.feed.read({ kind: 'before', cursor: page.before }, budget, signal)
            }
            throw new Error('No conversation text was found within the four-page reference limit. Open the original conversation and quote the relevant text; your draft has been kept.')
        }
        finally { window.release() }
    }
    async sourceExport(request: { source: AppSourceRoute; format: SourceExportFormat; force?: boolean }, signal: AbortSignal): Promise<SourceExportWarning | SourceExportReady> {
        const source = appSourceRouteSchema.parse(request.source), window = await this.open(source, signal)
        const events = new Map<number, OriginalExportEvent>(), cursors = new Set<string>(), encoder = new TextEncoder()
        let bytes = 0, page: ExportPage = window.feed.initial
        const version = page.version
        type Read = Parameters<typeof window.feed.read>[0]
        const pages: Array<{ request: Read; before: string | null; after: string | null; hasBefore: boolean; hasAfter: boolean; sequences: number[] }> = []
        let read: Read = { kind: 'latest' }, materialized = false
        const changed = () => new Error('The original history changed during export. Prepare it again; no partial export was created')
        const matches = (current: ExportPage, original: typeof pages[number]): boolean => current.before === original.before && current.after === original.after
            && current.hasBefore === original.hasBefore && current.hasAfter === original.hasAfter && current.entries.length === original.sequences.length
            && current.entries.every((entry, index) => entry.type === 'event' && entry.event.seq === original.sequences[index]
                && JSON.stringify(entry.event) === JSON.stringify(events.get(entry.event.seq)))
        try {
            for (;;) {
                signal.throwIfAborted(); window.assertCurrent()
                if (page.version !== version) {
                    if (!window.materializesHistory) throw changed()
                    materialized = true
                }
                if (window.materializesHistory) pages.push({ request: read, before: page.before, after: page.after,
                    hasBefore: page.hasBefore, hasAfter: page.hasAfter, sequences: page.entries.map(entry => entry.event.seq) })
                for (const entry of page.entries) if (entry.type === 'event' && !events.has(entry.event.seq)) {
                    bytes += encoder.encode(JSON.stringify(entry.event)).byteLength
                    if (bytes > MAX_BYTES) throw new Error('The original conversation exceeds the 100 MiB export limit')
                    events.set(entry.event.seq, entry.event)
                }
                if (!request.force && (events.size > SOFT_EVENTS || bytes > SOFT_BYTES)) return { type: 'warning', count: events.size, limit: SOFT_EVENTS, estimatedBytes: bytes }
                if (!page.hasBefore) break
                if (!page.before || cursors.has(page.before)) throw new Error('The original history cursor did not advance; no partial export was created')
                cursors.add(page.before)
                read = { kind: 'before', cursor: page.before }
                page = await window.feed.read(read, budget, signal)
            }
            // Confirm the same source revision after walking all original pages.
            const latest = await window.feed.read({ kind: 'latest' }, budget, signal)
            window.assertCurrent(); signal.throwIfAborted()
            if (window.materializesHistory && (materialized || latest.version !== version)) {
                // One stable pass distinguishes cold index population from a
                // changed source without retaining a second copy of its events.
                // There is no retry: any later publication or changed row fails.
                const stable = latest.version
                if (!matches(latest, pages[0]!)) throw changed()
                for (const original of pages) {
                    const current = await window.feed.read(original.request, budget, signal)
                    window.assertCurrent(); signal.throwIfAborted()
                    if (current.version !== stable || !matches(current, original)) throw changed()
                }
                const confirmed = await window.feed.read({ kind: 'latest' }, budget, signal)
                window.assertCurrent(); signal.throwIfAborted()
                if (confirmed.version !== stable || !matches(confirmed, pages[0]!)) throw changed()
            } else if (latest.version !== version) throw changed()
            const ordered = [...events.values()].sort((left, right) => left.seq - right.seq)
            const data = request.format === 'json' ? JSON.stringify({ format: 'hhpi-source-events-v1', source, title: window.title, events: ordered }, null, 2)
                : exportConversationMarkdown(window.title, source, ordered)
            const blob = new Blob([data], { type: request.format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' })
            if (blob.size > MAX_BYTES) throw new Error('The formatted conversation exceeds the 100 MiB export limit')
            const leaf = window.title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim().slice(0, 120) || 'conversation'
            return { type: 'ready', fileName: `${leaf}.${request.format === 'json' ? 'json' : 'md'}`, bytes: blob.size, blob }
        } finally { window.release() }
    }
}

type ExportSnapshot = { format: SourceExportFormat; busy: boolean; result: SourceExportWarning | PreparedSourceExport | null; error: string | null; persistenceError: string | null }
export class SourceExportController {
    private state: ExportSnapshot
    private readonly lifetime = new AbortController()
    private generation = 0
    private listeners = new Set<() => void>()
    constructor(private readonly api: SourceExportApi, readonly source: AppSourceRoute, private readonly preferences?: SourceExportPreferences) {
        let format: SourceExportFormat = 'json'
        try { if (preferences?.getItem(SOURCE_EXPORT_FORMAT_KEY) === 'markdown') format = 'markdown' } catch { /* Export remains available when preference storage is blocked. */ }
        this.state = { format, busy: false, result: null, error: null, persistenceError: null }
    }
    getSnapshot = (): ExportSnapshot => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<ExportSnapshot>): void { if (this.lifetime.signal.aborted) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
    private clearUrl(): void { if (this.state.result?.type === 'ready') URL.revokeObjectURL(this.state.result.url) }
    setFormat(format: SourceExportFormat): void {
        if (this.lifetime.signal.aborted || this.state.busy || this.state.format === format) return
        this.generation++; this.clearUrl(); this.publish({ format, result: null, error: null })
    }
    async prepare(force = false): Promise<PreparedSourceExport | null> {
        if (this.lifetime.signal.aborted || this.state.busy || force && this.state.result?.type !== 'warning') return null
        const generation = ++this.generation, format = this.state.format
        let persistenceError: string | null = null
        try { this.preferences?.setItem(SOURCE_EXPORT_FORMAT_KEY, format) } catch (error) { persistenceError = message(error) }
        this.publish({ busy: true, error: null, persistenceError })
        try {
            const result = await this.api.sourceExport({ source: this.source, format, ...(force ? { force: true } : {}) }, this.lifetime.signal)
            if (this.lifetime.signal.aborted || generation !== this.generation) return null
            this.clearUrl()
            const prepared = result.type === 'ready' ? { ...result, url: URL.createObjectURL(result.blob) } : result
            this.publish({ result: prepared }); return prepared.type === 'ready' ? prepared : null
        } catch (error) { if (generation === this.generation) this.publish({ error: message(error) }); return null }
        finally { if (generation === this.generation) this.publish({ busy: false }) }
    }
    dispose(): void { this.clearUrl(); this.lifetime.abort(); this.generation++; this.listeners.clear() }
}
export async function downloadPreparedSourceExport(result: PreparedSourceExport, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted(); return result.blob
}
