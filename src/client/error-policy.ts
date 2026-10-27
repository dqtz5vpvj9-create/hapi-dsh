/**
 * User-visible error policy for the HAPI workspace.
 *
 * Ported from HAPI's reconnecting/notice semantics: background cancellations
 * stay silent, transient transport failures show one delayed notice only if
 * they persist, and authentication or user-operation failures stay explicit.
 * Internal Remote endpoint names never reach the notice text.
 */

export type ClientErrorKind = 'cancel' | 'transient' | 'auth' | 'operation'

const CANCELLED = /was (aborted|cancelled)|gateway\/cancelled|abort(ed)?\b/i
const AUTH = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|token|credential|auth/i
const TRANSIENT = /disconnect|connect(ion)? (failed|lost)|network|fetch failed|ECONN|socket|reconnect|timed? ?out|timeout/i

/**
 * Classify one client failure by its code and message, not by endpoint name.
 * @param error - rejected client error.
 * @returns policy class for the notice gate.
 */
export function classifyClientError(error: unknown): ClientErrorKind {
    const message = error instanceof Error ? error.message : String(error)
    const code = (error as { code?: unknown } | null)?.code
    const operation = (error as { hapiOperation?: unknown } | null)?.hapiOperation
    const text = `${typeof code === 'string' ? code : ''} ${message}`
    if (CANCELLED.test(text)) return 'cancel'
    if (AUTH.test(text)) return 'auth'
    if (TRANSIENT.test(text)) return 'transient'
    // Background source reads/recovery are retried by their owners; a single
    // miss must not flash an error while the next attempt is already running.
    if (typeof operation === 'string' && BACKGROUND_OPERATION.test(operation)) return 'transient'
    return 'operation'
}

/** Operations whose failures are retried in the background on the user's behalf. */
const BACKGROUND_OPERATION = /^hapi\/(source(ReadStates|DisplayLease|SessionResolve|History|Display|Machine|Catalog|Companion|Legacy|Window|Attachment)|nativeTerminal|observed|native(?!Settings|Fork))/

/** HAPI keeps a reconnect banner off screen for this long before showing it. */
export const TRANSIENT_NOTICE_DELAY_MS = 4_000

/** A user-facing message without internal Remote endpoint names. */
export function noticeText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    // The gateway prefixes every failure with its internal endpoint. Strip the
    // whole "client api: …" segment before any user sees it.
    const stripped = message
        .replace(/^\s*client api:\s*.*?(?::\s*)?/i, '')
        .replace(/^hapi\/[A-Za-z]+\s*(failed|was (aborted|cancelled))?:?\s*/i, '')
        .trim()
    if (!stripped || /^(failed|failed to fetch)\.?$/i.test(stripped)) return '连接中断，正在重连…'
    return stripped
}

/**
 * Gate one workspace's notices so transient failures cannot flash internal
 * errors while a reconnect is already recovering.
 */
export class NoticeGate {
    private timer: ReturnType<typeof setTimeout> | undefined
    private shown: string | undefined
    private ready = false

    /**
     * @param publish - emits the final user-visible notice text.
     * @param clear - removes a notice this gate previously published.
     */
    constructor(private readonly publish: (text: string) => void,
        private readonly clear: () => void) {}

    /**
     * Apply the notice policy to one failure.
     * @param error - rejected client error.
     */
    report(error: unknown): void {
        const kind = classifyClientError(error)
        if (kind === 'cancel') return
        if (kind === 'transient') {
            // Before the first catalog success the workspace is still starting
            // up; background read failures there are expected and stay silent.
            if (!this.ready) return
            if (this.timer !== undefined) return
            this.timer = setTimeout(() => {
                this.timer = undefined
                this.shown = noticeText(error)
                this.publish(this.shown)
            }, TRANSIENT_NOTICE_DELAY_MS)
            return
        }
        // A real auth or operation failure replaces any pending transient notice.
        this.recovered()
        this.shown = noticeText(error)
        this.publish(this.shown)
    }

    /** The workspace reached a usable state; transient notices may surface now. */
    markReady(): void { this.ready = true }

    /** A successful connect/read cancels a pending or shown transient notice. */
    recovered(): void {
        if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
        if (this.shown !== undefined) { this.shown = undefined; this.clear() }
    }

    /** Release the pending timer with the owner. */
    dispose(): void {
        this.recovered()
    }
}
