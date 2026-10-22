/** Bounded, read-only warming through the official public reference lifetime. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
    interface SessionReferenceSourceMap { hapiWarmup: unknown }
}

interface WarmEntry {
    readonly id: SessionId
    phase: 'queued' | 'opening' | 'ready' | 'failed'
    abort?: AbortController | undefined
    reference?: SessionReference | undefined
}

export interface SessionWarmupSnapshot {
    readonly ids: readonly SessionId[]
    readonly queued: number
    readonly opening: number
    readonly ready: number
    readonly failed: number
    readonly retained: number
}

/**
 * Hold a small recent-session cache independently of pane ownership. A warm
 * eviction releases only this helper's reference; a visible pane keeps its own
 * reference, and the original Host agent owns execution throughout.
 *
 * Call update only after the visible pane is ready. Candidate discovery belongs
 * to the Host owner, which can exclude already visible or archived sessions.
 * Failure is remembered until that candidate leaves the list, avoiding a
 * catalog-update retry loop. The next deliberate navigation may still retry.
 */
export function createSessionWarmup(sessions: Pick<ISessions, 'retain'>, options: {
    limit?: number
    concurrency?: number
    onError?: (error: unknown, sessionId: SessionId) => void
} = {}): {
    update(recent: readonly SessionId[]): void
    getSnapshot(): SessionWarmupSnapshot
    dispose(): void
} {
    const bound = (value: number | undefined, fallback: number, maximum: number): number =>
        value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(maximum, Math.floor(value)))
    const limit = bound(options.limit, 5, 5)
    const concurrency = Math.max(1, bound(options.concurrency, 2, 2))
    const entries = new Map<SessionId, WarmEntry>()
    let disposed = false
    let pumping = false
    const release = (entry: WarmEntry): void => {
        entry.abort?.abort(); entry.abort = undefined
        const reference = entry.reference; entry.reference = undefined
        reference?.release()
    }
    const pump = (): void => {
        if (disposed || pumping) return
        pumping = true
        try {
            for (const entry of entries.values()) {
                if (entry.phase !== 'queued') continue
                if ([...entries.values()].filter(value => value.phase === 'opening').length >= concurrency) break
                entry.phase = 'opening'; entry.abort = new AbortController()
                try {
                    const reference = sessions.retain(entry.id, { source: 'hapiWarmup', signal: entry.abort.signal })
                    // retain may synchronously publish catalog ownership and
                    // cause the Host to replace its warm candidates.
                    if (disposed || entries.get(entry.id) !== entry) {
                        reference.release(); void reference.ready.catch(() => {}); continue
                    }
                    entry.reference = reference
                    void reference.ready.then(() => {
                        if (disposed || entries.get(entry.id) !== entry) return
                        entry.phase = 'ready'; pump()
                    }, error => {
                        if (disposed || entries.get(entry.id) !== entry) return
                        entry.phase = 'failed'; release(entry); pump()
                        options.onError?.(error, entry.id)
                    })
                } catch (error) {
                    entry.phase = 'failed'; release(entry)
                    options.onError?.(error, entry.id)
                }
            }
        } finally { pumping = false }
    }
    return {
        update(recent) {
            if (disposed) return
            const selected = [...new Set(recent)].slice(0, limit)
            const desired = new Set(selected)
            for (const [id, entry] of entries) if (!desired.has(id)) { entries.delete(id); release(entry) }
            for (const id of selected) if (!entries.has(id)) entries.set(id, { id, phase: 'queued' })
            pump()
        },
        getSnapshot() {
            const values = [...entries.values()]
            return { ids: values.map(entry => entry.id), queued: values.filter(entry => entry.phase === 'queued').length,
                opening: values.filter(entry => entry.phase === 'opening').length, ready: values.filter(entry => entry.phase === 'ready').length,
                failed: values.filter(entry => entry.phase === 'failed').length, retained: values.filter(entry => entry.reference !== undefined).length }
        },
        dispose() {
            if (disposed) return
            disposed = true
            for (const entry of entries.values()) release(entry)
            entries.clear()
        },
    }
}
