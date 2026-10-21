/** Source-only export preparation. Original preference semantics are from
 * HAPI 0f8ef697 web/src/lib/sessionExport/download.ts (AGPL-3.0-only). */
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import type { SourceExport } from '../session-extras-types.ts'
import type { WorkbenchSource } from '../workbench-types.ts'

export const SOURCE_EXPORT_FORMAT_KEY = 'hapi.sessionExportFormat'
export type SourceExportFormat = 'json' | 'markdown'
export interface SourceExportPreferences {
    getItem(key: typeof SOURCE_EXPORT_FORMAT_KEY): string | null
    setItem(key: typeof SOURCE_EXPORT_FORMAT_KEY, value: string): void
    subscribe?(listener: () => void): () => void
}
type Api = Pick<HapiRemoteApi, 'sourceExport'>
type ExportSnapshot = { format: SourceExportFormat; busy: boolean; result: SourceExport | null; error: string | null; persistenceError: string | null }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class SourceExportController {
    private state: ExportSnapshot
    private generation = 0
    private disposed = false
    private listeners = new Set<() => void>()
    constructor(private readonly api: Api, readonly source: WorkbenchSource, private readonly preferences?: SourceExportPreferences) {
        let format: SourceExportFormat = 'json'
        try { if (preferences?.getItem(SOURCE_EXPORT_FORMAT_KEY) === 'markdown') format = 'markdown' } catch { /* Export remains available when preferences cannot be read. */ }
        this.state = { format, busy: false, result: null, error: null, persistenceError: null }
    }
    getSnapshot = (): ExportSnapshot => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<ExportSnapshot>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
    setFormat(format: SourceExportFormat): void {
        if (this.disposed || this.state.busy || this.state.format === format) return
        this.generation++; this.publish({ format, result: null, error: null })
    }
    /** A warning does not authorize a larger export. Force is a separate click. */
    async prepare(force = false): Promise<Extract<SourceExport, { type: 'ready' }> | null> {
        if (this.disposed || this.state.busy || force && this.state.result?.type !== 'warning') return null
        const generation = ++this.generation, format = this.state.format
        let persistenceError: string | null = null
        try { this.preferences?.setItem(SOURCE_EXPORT_FORMAT_KEY, format) } catch (error) { persistenceError = message(error) }
        this.publish({ busy: true, error: null, persistenceError })
        try {
            const result = remoteValue(await this.api.sourceExport({ source: this.source, format, ...(force ? { force: true } : {}) }))
            if (this.disposed || generation !== this.generation) return null
            this.publish({ result })
            return result.type === 'ready' ? result : null
        } catch (error) { if (generation === this.generation) this.publish({ error: message(error) }); return null }
        finally { if (generation === this.generation) this.publish({ busy: false }) }
    }
    dispose(): void { this.disposed = true; this.generation++; this.listeners.clear() }
}

/** Original bytes are downloaded from the authenticated serving Host, never
 * reconstructed from the visible DSH transcript or another machine's path. */
export async function downloadPreparedSourceExport(result: Extract<SourceExport, { type: 'ready' }>, origin: string,
    fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted()
    const url = new URL(result.url, origin)
    if (url.origin !== new URL(origin).origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('The export must use this authenticated Host')
    const response = await fetcher(url.href, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...(signal ? { signal } : {}) })
    if (!response.ok) throw new Error(`Source export download failed (${response.status})`)
    const blob = await response.blob()
    if (blob.size !== result.bytes) throw new Error('The original export download was incomplete; prepare it again')
    return blob
}
