import type { ISession, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

type HistorySession = Pick<ISession, 'loadThrough'> & {
    getSnapshot(): Pick<SessionSnapshot, 'openState' | 'loadingOlder' | 'removed'>
    subscribe(listener: () => void): () => void
}

/**
 * The official loadThrough resolves without loading if loadOlder owns the
 * flight. Wait on its public snapshot, then check and invoke in the same turn.
 * Cancelling this destination does not cancel another reader's shared page.
 */
export function loadHistoryThrough(
    session: HistorySession,
    seq: SessionSeq,
    signal: AbortSignal,
    current: () => boolean = () => true,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let started = false, finished = false
        let unsubscribe = (): void => {}
        const cleanup = (): void => { unsubscribe(); signal.removeEventListener('abort', abort) }
        const fail = (error: unknown): void => { if (!finished) { finished = true; cleanup(); reject(error) } }
        const abort = (): void => fail(signal.reason ?? new Error('History navigation cancelled'))
        const valid = (): void => {
            signal.throwIfAborted()
            if (!current()) throw new Error('The conversation was replaced while loading history.')
            const state = session.getSnapshot()
            if (state.removed || state.openState === 'error') throw new Error('The conversation is no longer open in this pane.')
        }
        const check = (): void => {
            if (started || finished) return
            try {
                valid()
                const state = session.getSnapshot()
                // Reconnect publishes its replacement window before doOpen
                // flips loading -> open. That public transition also wakes us.
                if (state.openState !== 'open' || state.loadingOlder) return
                started = true
                unsubscribe()
                // No await between checking the public busy bit and invoking
                // the official verb: another subscription cannot steal it.
                void session.loadThrough(seq).then(() => {
                    if (finished) return
                    try {
                        valid()
                        if (session.getSnapshot().openState !== 'open') throw new Error('The conversation was replaced while loading history.')
                        finished = true; cleanup(); resolve()
                    } catch (error) { fail(error) }
                }, fail)
            } catch (error) { fail(error) }
        }
        signal.addEventListener('abort', abort, { once: true })
        unsubscribe = session.subscribe(check)
        if (started || finished) unsubscribe()
        else check()
    })
}
