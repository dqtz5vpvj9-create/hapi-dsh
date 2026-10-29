/**
 * Load policy for seamless history loading.
 *
 * The policy answers exactly one question: may one automatic earlier-page
 * request start now? It receives the official conversation state as a plain
 * value (so both strategies — public `loadOlder()` and the official control —
 * can feed it) plus the normalized reader intent, and never touches DOM,
 * sessions, timers, or storage. Bounds live in {@link EarlierLoadBudget}; this
 * file only encodes the reader-facing gates around it.
 *
 * Gates, in evaluation order:
 * 1. the reader explicitly moved toward earlier content (`up` intent);
 * 2. the conversation view is open and its window actually has older history;
 * 3. no page is already loading;
 * 4. tail following blocks prefetch until the reader reaches the actual top;
 * 5. the reader has no active selection/fixation to interrupt;
 * 6. the scrollport is within the lead distance from the top;
 * 7. the request budget allows it (single flight, burst, backoff, cap).
 */

import { EarlierLoadBudget, type EarlierLoadBudgetLimits, type EarlierLoadBudgetSnapshot } from './budget.ts'
import type { ReaderIntent } from './intent.ts'

/** Official conversation state relevant to an automatic earlier-page request. */
export interface EarlierViewState {
    /** The official session window has more history before its first loaded row. */
    readonly hasMore: boolean
    /** One earlier page is already in flight (`SessionSnapshot.loadingOlder`). */
    readonly loading: boolean
    /** The conversation view finished opening its initial window. */
    readonly open: boolean
    /** The view is pinned to the tail and owns follow behaviour there. */
    readonly followingTail: boolean
    /** The conversation scrollport's current scrollTop. */
    readonly scrollTop: number
    /** The conversation scrollport's client height. */
    readonly clientHeight: number
    /** The full rendered scroll height, including the current short window. */
    readonly scrollHeight: number
    /** A text selection or equivalent reader fixation must not be interrupted. */
    readonly fixated: boolean
}

/** Default lead distance: one viewport, capped so tall screens do not prefetch far ahead. */
export const NEAR_TOP_MAX_PIXELS = 600

/**
 * Lead distance for one scrollport height.
 *
 * One viewport of runway hides the page round-trip, matching the reference
 * implementation; the cap keeps a very tall pane from auto-loading while the
 * reader is still far from the top.
 *
 * @param clientHeight - conversation scrollport height in CSS pixels.
 * @returns distance from top at which automatic loading starts.
 */
export function nearTopPixels(clientHeight: number): number {
    if (!Number.isFinite(clientHeight) || clientHeight <= 0) return 0
    return Math.min(clientHeight, NEAR_TOP_MAX_PIXELS)
}

/**
 * Whether the scrollport is close enough to the top to start loading.
 *
 * @param state - current conversation view state.
 * @returns true when scrollTop is inside the lead distance.
 */
export function isNearTop(state: Pick<EarlierViewState, 'scrollTop' | 'clientHeight'>): boolean {
    if (!Number.isFinite(state.scrollTop) || state.scrollTop < 0) return false
    return state.scrollTop <= nearTopPixels(state.clientHeight)
}

/** Policy tunables: the budget plus the near-top lead distance. */
export interface EarlierLoadPolicyOptions {
    readonly budget?: Partial<EarlierLoadBudgetLimits>
    /** Override the near-top lead distance; defaults to one viewport capped at 600px. */
    readonly nearTop?: (clientHeight: number) => number
    /** Override the reader/state gate; exposed for tests and strategy adapters. */
    readonly eligible?: (state: EarlierViewState) => boolean
}

/** Everything the controller must know after one evaluation. */
export type EarlierLoadDecision =
    | { readonly request: true }
    | {
        readonly request: false
        readonly reason:
            | 'no-intent'
            | 'not-open'
            | 'exhausted'
            | 'loading'
            | 'following-tail'
            | 'fixated'
            | 'not-near-top'
            | 'budget'
            | 'suspended'
    }

/**
 * One conversation surface's automatic earlier-page policy.
 *
 * The controller calls {@link evaluate} on reader input, then reports the
 * outcome of the request it started with {@link requested}/{@link committed}/
 * {@link failed}/{@link abandoned}. Time is always passed explicitly.
 */
export class EarlierLoadPolicy {
    readonly budget: EarlierLoadBudget
    private readonly nearTop: (clientHeight: number) => number
    private readonly eligible: (state: EarlierViewState) => boolean

    /**
     * @param options - budget and lead-distance overrides.
     */
    constructor(options: EarlierLoadPolicyOptions = {}) {
        this.budget = new EarlierLoadBudget(options.budget)
        this.nearTop = options.nearTop ?? nearTopPixels
        this.eligible = options.eligible ?? defaultEligible
    }

    /**
     * Decide whether to start one automatic earlier-page request.
     *
     * A stale in-flight request is expired here (through the budget) instead of
     * blocking the reader forever; that expiry counts as a failure and the next
     * explicit gesture retries after the cooldown.
     *
     * @param state - current official conversation state.
     * @param intent - normalized direction of the reader input being handled.
     * @param now - monotonic milliseconds.
     * @returns `request` or the first gate that refused.
     */
    evaluate(state: EarlierViewState, intent: ReaderIntent, now: number, budgeted = true): EarlierLoadDecision {
        if (intent !== 'up') return { request: false, reason: 'no-intent' }
        if (!state.open) return { request: false, reason: 'not-open' }
        if (!state.hasMore) return { request: false, reason: 'exhausted' }
        if (state.loading) return { request: false, reason: 'loading' }
        // A short window can remain within official bottom-follow tolerance
        // even at its top. An explicit upward gesture there may use the
        // official Load earlier action, which owns follow release and anchoring.
        if (state.followingTail && state.scrollTop > 1)
            return { request: false, reason: 'following-tail' }
        if (state.fixated) return { request: false, reason: 'fixated' }
        if (!this.eligible(state)) return { request: false, reason: 'not-open' }
        const lead = this.nearTop(state.clientHeight)
        if (!(state.scrollTop <= lead)) return { request: false, reason: 'not-near-top' }
        if (!budgeted) return { request: true }
        const verdict = this.budget.allow(now)
        if (!verdict.allowed) return { request: false, reason: verdict.reason === 'suspended' ? 'suspended' : 'budget' }
        return { request: true }
    }

    /**
     * Record that the approved request actually reached the loader.
     *
     * @param now - monotonic milliseconds.
     */
    requested(now: number): void {
        this.budget.requested(now)
    }

    /**
     * Record that the request committed an older page.
     *
     * @param now - monotonic milliseconds.
     */
    committed(now: number): void {
        this.budget.succeeded(now)
    }

    /**
     * Record that the request failed (error, timeout, or no committed page).
     *
     * @param now - monotonic milliseconds.
     */
    failed(now: number): void {
        this.budget.failed(now)
    }

    /**
     * Return an approved request that never reached the loader.
     *
     * @param now - monotonic milliseconds.
     */
    abandoned(now: number): void {
        this.budget.abandoned(now)
    }

    /**
     * Expire a hung in-flight request.
     *
     * @param now - monotonic milliseconds.
     * @returns whether the request timed out.
     */
    expire(now: number): boolean {
        return this.budget.expired(now)
    }

    /**
     * Resume automatic loading after progress was observed outside our own
     * request (manual control or a delayed upstream page).
     */
    resume(): void {
        this.budget.resume()
    }

    /**
     * Reset burst/backoff state when the surface starts a new conversation.
     */
    reset(): void {
        this.budget.reset()
    }

    /**
     * Read the budget snapshot for diagnostics.
     *
     * @param now - monotonic milliseconds.
     * @returns immutable budget state.
     */
    snapshot(now: number): EarlierLoadBudgetSnapshot {
        return this.budget.snapshot(now)
    }
}

/** The state gates that do not depend on policy options. */
function defaultEligible(_state: EarlierViewState): boolean {
    return true
}
