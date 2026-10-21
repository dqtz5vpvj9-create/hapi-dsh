import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * An official refresh can resolve with a folded transport failure before the
 * Peer connects. Only this graph's observable catalog proves a retain target.
 * Retry reads while connecting; never infer ownership from another graph.
 */
export function waitForCatalogSession(
    sessions: Pick<ISessions, 'list' | 'refresh'>,
    sessionId: SessionId,
    signal: AbortSignal,
    options: { timeoutMs?: number; retryMs?: number; accept?: (session: SessionSummary) => boolean } = {},
): Promise<void> {
    signal.throwIfAborted()
    const available = (): boolean => {
        const row = sessions.list.getSnapshot().byId[sessionId]
        return row !== undefined && (options.accept?.(row) ?? true)
    }
    if (available()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
        let done = false
        let retry: ReturnType<typeof setTimeout> | undefined
        let unsubscribe: (() => void) | undefined
        let lastFailure: unknown
        const settle = (error?: unknown): void => {
            if (done) return
            done = true
            clearTimeout(timeout)
            if (retry !== undefined) clearTimeout(retry)
            unsubscribe?.()
            signal.removeEventListener('abort', abort)
            if (error === undefined) resolve()
            else reject(error)
        }
        const check = (): boolean => {
            if (done) return true
            if (!available()) return false
            settle()
            return true
        }
        const abort = (): void => { settle(signal.reason ?? new Error('Conversation opening was cancelled')) }
        const timeout = setTimeout(() => {
            settle(new Error(`The Host has not made this conversation available: ${sessionId}`, lastFailure === undefined ? undefined : { cause: lastFailure }))
        }, options.timeoutMs ?? 30_000)
        const refresh = async (): Promise<void> => {
            if (check()) return
            try { await sessions.refresh() }
            catch (error) { lastFailure = error }
            if (!check()) retry = setTimeout(() => { void refresh() }, options.retryMs ?? 1_000)
        }
        signal.addEventListener('abort', abort, { once: true })
        unsubscribe = sessions.list.subscribe(check)
        if (signal.aborted) abort()
        else void refresh()
    })
}
