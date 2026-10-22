/**
 * Cross-pane bounds for seamless history loading.
 *
 * One browser page can show many panes — several windows, several Hosts, and
 * even the same session in two panes. Each pane controller already bounds its
 * own requests (`EarlierLoadBudget`), but DOM automation across panes still
 * needs aggregate limits so one fast reader cannot multiply host-journal pages
 * across every visible conversation at once, and a per-session page ledger so
 * the accepted memory trade-off has an explicit, configurable ceiling.
 *
 * Both classes are pure time-ordered accounting (explicit `now`); the DOM
 * controller owns the requests. Cross-pane fairness policy is "first request
 * wins, later requests are dropped and retried by the next reader gesture" —
 * there is no queue, so a pane the reader is not touching cannot starve one
 * they are.
 */

/** Aggregate limits shared by every pane controller of one page. */
export interface AggregateLoadLimits {
    /** Automatic earlier-page requests allowed in flight across all panes. */
    readonly maxConcurrent: number
    /** Automatic earlier-page requests allowed to start within one window. */
    readonly maxStartsPerWindow: number
    /** Length of the aggregate start window. */
    readonly windowMs: number
}

/** Conservative defaults: human reading speed, not prefetch. */
export const AGGREGATE_LOAD_DEFAULTS: AggregateLoadLimits = {
    maxConcurrent: 2,
    maxStartsPerWindow: 4,
    windowMs: 1_000,
}

/** Decision for one aggregate request attempt. */
export type AggregateLoadVerdict =
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: 'concurrent' | 'rate' }

/** In-flight and window accounting for automatic earlier-page requests. */
export class AggregateLoadGate {
    readonly limits: AggregateLoadLimits
    private active = 0
    private readonly starts: number[] = []
    private readonly listeners = new Set<() => void>()

    /**
     * @param limits - overrides for the defaults.
     */
    constructor(limits: Partial<AggregateLoadLimits> = {}) {
        const merged = { ...AGGREGATE_LOAD_DEFAULTS, ...limits }
        for (const [name, value] of Object.entries(merged)) {
            if (!Number.isFinite(value) || value < 0) throw new Error(`AggregateLoadGate: invalid ${name}`)
        }
        if (merged.maxConcurrent < 1) throw new Error('AggregateLoadGate: maxConcurrent must be at least 1')
        if (merged.maxStartsPerWindow < 1) throw new Error('AggregateLoadGate: maxStartsPerWindow must be at least 1')
        if (merged.windowMs < 1) throw new Error('AggregateLoadGate: windowMs must be at least 1')
        this.limits = merged
    }

    /**
     * Reserve one aggregate slot and start ticket.
     *
     * @param now - monotonic milliseconds.
     * @returns whether the request may start; a refusal never queues.
     */
    tryStart(now: number): AggregateLoadVerdict {
        this.prune(now)
        if (this.active >= this.limits.maxConcurrent) return { allowed: false, reason: 'concurrent' }
        if (this.starts.length >= this.limits.maxStartsPerWindow) return { allowed: false, reason: 'rate' }
        this.active++
        this.starts.push(now)
        return { allowed: true }
    }

    /**
     * Release one aggregate in-flight slot. Idempotent at zero.
     */
    release(): void {
        if (this.active === 0) return
        this.active--
        for (const listener of this.listeners) listener()
    }

    /** Initial-window prefetch may retry after a real slot release, without polling. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    /**
     * Read aggregate state for diagnostics and tests.
     *
     * @param now - monotonic milliseconds.
     * @returns counts inside the current window.
     */
    snapshot(now: number): { readonly active: number; readonly startsInWindow: number } {
        this.prune(now)
        return { active: this.active, startsInWindow: this.starts.length }
    }

    /** Drop every ticket (installer teardown). */
    reset(): void {
        this.active = 0
        this.starts.length = 0
    }

    private prune(now: number): void {
        const cutoff = now - this.limits.windowMs
        while (this.starts.length > 0 && this.starts[0] !== undefined && this.starts[0] < cutoff) this.starts.shift()
    }
}

/**
 * Per-session ceiling on automatic earlier pages.
 *
 * The official client window is append-only: every committed page stays in the
 * retained session, and the pinned upstream exposes no trim API. The plugin
 * therefore bounds the *number of pages it will fetch on its own* per session
 * identity, and leaves further paging to the reader's explicit manual control.
 * The ledger is keyed by a caller-supplied identity so two panes of the same
 * source share one budget, while unrelated sessions never do.
 */
export class SessionPageLedger {
    readonly maxPagesPerSession: number
    private readonly counts = new Map<string, number>()

    /**
     * @param maxPagesPerSession - conservative default ceiling; must be >= 1.
     */
    constructor(maxPagesPerSession = 20) {
        if (!Number.isInteger(maxPagesPerSession) || maxPagesPerSession < 1) {
            throw new Error('SessionPageLedger: maxPagesPerSession must be a positive integer')
        }
        this.maxPagesPerSession = maxPagesPerSession
    }

    /**
     * Automatic pages already committed for one identity.
     *
     * @param identity - stable pane/session identity.
     * @returns committed automatic page count.
     */
    pages(identity: string): number {
        return this.counts.get(identity) ?? 0
    }

    /**
     * Whether the automatic ceiling was reached for one identity.
     *
     * @param identity - stable pane/session identity.
     * @returns true when no further automatic page may be fetched.
     */
    exhausted(identity: string): boolean {
        return this.pages(identity) >= this.maxPagesPerSession
    }

    /**
     * Record one committed automatic page.
     *
     * @param identity - stable pane/session identity.
     * @returns the new committed count.
     */
    spend(identity: string): number {
        const next = this.pages(identity) + 1
        this.counts.set(identity, next)
        return next
    }

    /** Forget every ceiling (installer teardown). */
    reset(): void {
        this.counts.clear()
    }
}
