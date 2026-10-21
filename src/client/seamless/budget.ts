/**
 * Request budget for seamless history loading.
 *
 * The official session controller gates concurrent `loadOlder()` calls
 * (`loadingOlder`), but a plugin that reacts to every scroll sample can still
 * start a page per animation frame on a fast trackpad, or hammer a source that
 * keeps failing. This budget owns those bounds and nothing else: it does not
 * know DOM, sessions, or how a page is requested. Every transition is explicit
 * so the controller — and its tests — can reason about time without sleeping.
 *
 * Bounds:
 * - **single flight**: one request in flight; a stale request expires instead of
 *   blocking the reader forever (the official controller swallows transport
 *   failures, so a hung page is otherwise invisible).
 * - **burst**: at most a few automatic pages per short window, so scroll
 *   momentum cannot turn into an unbounded prefetch.
 * - **backoff**: consecutive failures add a growing cooldown; the next explicit
 *   upward gesture retries after it, never a timer.
 * - **lifetime cap**: a session can only auto-load a bounded number of pages
 *   even if the reader scrolls through an enormous transcript.
 */

/** Tunables of the automatic earlier-page budget. */
export interface EarlierLoadBudgetLimits {
    /** Automatic pages allowed within one burst window. */
    readonly maxRequestsPerBurst: number
    /** Length of the sliding burst window. */
    readonly burstWindowMs: number
    /** A request that has not settled after this long counts as failed. */
    readonly requestTimeoutMs: number
    /** First consecutive-failure cooldown; later failures scale linearly. */
    readonly failureCooldownMs: number
    /** Upper bound on the scaled failure cooldown. */
    readonly failureCooldownCapMs: number
    /** Automatic pages allowed for one mounted conversation surface. */
    readonly maxAutomaticPages: number
    /** Consecutive failures after which automatic loading suspends until manual progress. */
    readonly maxConsecutiveFailures: number
}

/** Defaults chosen for a chat reader, not for a prefetcher. */
export const EARLIER_LOAD_BUDGET_DEFAULTS: EarlierLoadBudgetLimits = {
    maxRequestsPerBurst: 3,
    burstWindowMs: 1_200,
    requestTimeoutMs: 12_000,
    failureCooldownMs: 1_000,
    failureCooldownCapMs: 4_000,
    maxAutomaticPages: 48,
    maxConsecutiveFailures: 3,
}

/** Immutable public view of one budget's current state. */
export interface EarlierLoadBudgetSnapshot {
    /** Whether one request is currently in flight. */
    readonly pending: boolean
    /** Automatic pages started in the current burst window. */
    readonly requestsInBurst: number
    /** Automatic pages started since the surface mounted. */
    readonly automaticPages: number
    /** Failures since the last successful page. */
    readonly consecutiveFailures: number
    /** Wall-clock time of the latest failure, or null. */
    readonly lastFailureAt: number | null
    /** Milliseconds still required before another request may start. */
    readonly cooldownRemainingMs: number
    /** Automatic loading is suspended after too many consecutive failures. */
    readonly suspended: boolean
}

/** Result of asking the budget whether one more request may start. */
export type EarlierLoadBudgetVerdict =
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: 'pending' | 'burst' | 'cooldown' | 'exhausted' | 'suspended' }

/**
 * Time-ordered request budget for one conversation surface.
 *
 * All methods take an explicit `now` (monotonic milliseconds) so tests control
 * time directly and the controller can pass `performance.now()`.
 */
export class EarlierLoadBudget {
    readonly limits: EarlierLoadBudgetLimits
    private pending = false
    private requestedAt = 0
    private burstStart: number | null = null
    private burstCount = 0
    private automaticPages = 0
    private failures = 0
    private lastFailureAt: number | null = null

    /**
     * @param limits - overrides for the defaults; every field is optional.
     */
    constructor(limits: Partial<EarlierLoadBudgetLimits> = {}) {
        const merged = { ...EARLIER_LOAD_BUDGET_DEFAULTS, ...limits }
        for (const [name, value] of Object.entries(merged)) {
            if (!Number.isFinite(value) || value < 0) throw new Error(`EarlierLoadBudget: invalid ${name}`)
        }
        if (merged.maxRequestsPerBurst < 1) throw new Error('EarlierLoadBudget: maxRequestsPerBurst must be at least 1')
        if (merged.maxAutomaticPages < 1) throw new Error('EarlierLoadBudget: maxAutomaticPages must be at least 1')
        if (merged.requestTimeoutMs < 1) throw new Error('EarlierLoadBudget: requestTimeoutMs must be at least 1')
        if (merged.maxConsecutiveFailures < 1) throw new Error('EarlierLoadBudget: maxConsecutiveFailures must be at least 1')
        if (merged.burstWindowMs < 1) throw new Error('EarlierLoadBudget: burstWindowMs must be at least 1')
        this.limits = merged
    }

    /**
     * Decide whether one automatic request may start now.
     *
     * A pending request older than `requestTimeoutMs` is first expired as a
     * failure; the same call then reports the resulting cooldown instead of
     * silently allowing a second request. Expiring is a real state transition so
     * `expired(now)` is the only intended way to recover a hung request.
     *
     * @param now - monotonic milliseconds.
     * @returns whether a request may start, with the blocking reason when not.
     */
    allow(now: number): EarlierLoadBudgetVerdict {
        this.expired(now)
        if (this.pending) return { allowed: false, reason: 'pending' }
        if (this.automaticPages >= this.limits.maxAutomaticPages) return { allowed: false, reason: 'exhausted' }
        if (this.failures >= this.limits.maxConsecutiveFailures) return { allowed: false, reason: 'suspended' }
        const cooldown = this.cooldownMs()
        if (this.lastFailureAt !== null && now - this.lastFailureAt < cooldown) {
            return { allowed: false, reason: 'cooldown' }
        }
        this.rollBurst(now)
        if (this.burstCount >= this.limits.maxRequestsPerBurst) return { allowed: false, reason: 'burst' }
        return { allowed: true }
    }

    /**
     * Record that one automatic request started now.
     *
     * @param now - monotonic milliseconds.
     * @throws when called while the budget reports no allowance (callers must
     *   gate on {@link allow} first; a double start would break single flight).
     */
    requested(now: number): void {
        const verdict = this.allow(now)
        if (!verdict.allowed) throw new Error(`EarlierLoadBudget.requested: ${verdict.reason}`)
        this.pending = true
        this.requestedAt = now
        this.rollBurst(now)
        this.burstCount++
        this.automaticPages++
    }

    /**
     * Record that the in-flight request committed an older page.
     *
     * Clears all failure state: recovery is not latched.
     *
     * @param now - monotonic milliseconds.
     */
    succeeded(now: number): void {
        if (!this.pending) return
        this.pending = false
        this.requestedAt = now
        this.failures = 0
        this.lastFailureAt = null
    }

    /**
     * Record that the in-flight request failed (transport error, timeout, or an
     * observed request with no committed page).
     *
     * @param now - monotonic milliseconds.
     */
    failed(now: number): void {
        if (!this.pending) return
        this.pending = false
        this.requestedAt = now
        this.failures++
        this.lastFailureAt = now
    }

    /**
     * Give back an in-flight or about-to-start request that never reached the
     * official loader (for example the surface disappeared between the policy
     * decision and the strategy call).
     *
     * @param now - monotonic milliseconds.
     */
    abandoned(now: number): void {
        if (!this.pending) return
        this.pending = false
        this.requestedAt = now
        if (this.burstCount > 0) this.burstCount--
        if (this.automaticPages > 0) this.automaticPages--
    }

    /**
     * Expire one in-flight request after the timeout.
     *
     * @param now - monotonic milliseconds.
     * @returns whether a pending request was marked failed by this call.
     */
    expired(now: number): boolean {
        if (!this.pending) return false
        if (now - this.requestedAt < this.limits.requestTimeoutMs) return false
        this.failed(now)
        return true
    }

    /**
     * Cooldown required after the current failure streak.
     *
     * @returns milliseconds of cooldown, capped by the limit.
     */
    cooldownMs(): number {
        if (this.failures === 0) return 0
        return Math.min(this.limits.failureCooldownMs * this.failures, this.limits.failureCooldownCapMs)
    }

    /**
     * Forget every transient bound on surface replacement.
     *
     * Used when the conversation view or session changes under the same pane:
     * the new window is a new reader context, so burst/backoff state must not
     * carry over. The lifetime page cap is reset too; a new mounted surface
     * needs its own budget.
     */
    reset(): void {
        this.pending = false
        this.requestedAt = 0
        this.burstStart = null
        this.burstCount = 0
        this.automaticPages = 0
        this.failures = 0
        this.lastFailureAt = null
    }

    /**
     * Read the current budget state for policy tests and diagnostics.
     *
     * @param now - monotonic milliseconds, used for cooldown remaining.
     * @returns immutable snapshot.
     */
    snapshot(now: number): EarlierLoadBudgetSnapshot {
        const untilFailure = this.lastFailureAt === null ? 0 : this.cooldownMs() - (now - this.lastFailureAt)
        return {
            pending: this.pending,
            requestsInBurst: this.burstCount,
            automaticPages: this.automaticPages,
            consecutiveFailures: this.failures,
            lastFailureAt: this.lastFailureAt,
            cooldownRemainingMs: Math.max(0, untilFailure),
            suspended: this.failures >= this.limits.maxConsecutiveFailures,
        }
    }

    /**
     * Clear the failure streak after progress was observed outside our own
     * request (the reader used the manual control, or a slow upstream page
     * finally landed). Page and burst accounting stays untouched.
     */
    resume(): void {
        this.failures = 0
        this.lastFailureAt = null
    }

    /** Slide the burst window when it elapsed, so a quiet period restores allowance. */
    private rollBurst(now: number): void {
        if (this.burstStart === null || now - this.burstStart >= this.limits.burstWindowMs) {
            this.burstStart = now
            this.burstCount = 0
        }
    }
}
