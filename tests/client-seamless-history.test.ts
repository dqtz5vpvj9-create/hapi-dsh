/** Pure seams of seamless earlier-history loading: intent, budget, anchor, policy. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    anchor, budget, concurrency, intent, policy,
} from '../src/client/seamless/index.ts'
import type { AnchorCorrectionInput } from '../src/client/seamless/anchor.ts'
import type { EarlierViewState } from '../src/client/seamless/policy.ts'
import { InitialHistoryPlan, probeInitialWindow } from '../src/client/seamless/initial.ts'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { historyWindowWasReset, probeHistoryWindow } from '../src/client/seamless/controller.ts'

test('a retiring live-tail anchor does not cancel the pending older page', () => {
    const requested = { firstKey: 'turn-175:input', count: 148 }
    assert.equal(historyWindowWasReset(requested, { firstKey: 'turn-175:input', count: 147 }), false)
    assert.equal(historyWindowWasReset(requested, { firstKey: 'turn-173:input', count: 205 }), false,
        'the actual prepend can still commit after a transient tail contraction')
})

test('a genuinely shortened history window with a replacement head still resets paging', () => {
    const requested = { firstKey: 'turn-175:input', count: 148 }
    assert.equal(historyWindowWasReset(requested, { firstKey: 'turn-179:input', count: 48 }), true)
    assert.equal(historyWindowWasReset(requested, { firstKey: null, count: 0 }), true)
})

test('history progress probes identities once without requesting layout', () => {
    let queries = 0
    const row = (key: string | null, hidden = false) => ({
        getAttribute: () => key,
        closest: () => hidden ? {} : null,
        getBoundingClientRect: () => { throw new Error('Structural history probes must not force layout') },
    })
    const rows = [row('hidden', true), row(''), row(null), row('first-readable'), row('tail')]
    const column = { querySelectorAll() { queries++; return rows } } as unknown as HTMLElement
    assert.deepEqual(probeHistoryWindow(column), { firstKey: 'first-readable', count: 5 })
    assert.equal(queries, 1)
})

// ---------------------------------------------------------------------------
// Reader intent normalization
// ---------------------------------------------------------------------------

test('wheel intent follows the scrollport, not the wheel sign convention of the page', () => {
    assert.equal(intent.wheelIntent(-120), 'up')
    assert.equal(intent.wheelIntent(120), 'down')
    assert.equal(intent.wheelIntent(0), 'none')
    assert.equal(intent.wheelIntent(Number.NaN), 'none')
    // Line/page delta modes stay direction-preserving.
    assert.equal(intent.wheelIntent(-3, 1), 'up')
    assert.equal(intent.wheelIntent(-1, 2), 'up')
})

test('touch intent treats a downward finger drag as a request for earlier content', () => {
    assert.equal(intent.touchIntent(100, 140), 'up')
    assert.equal(intent.touchIntent(140, 100), 'down')
    assert.equal(intent.touchIntent(100, 100), 'none')
    assert.equal(intent.touchIntent(null, 100), 'none')
    assert.equal(intent.touchIntent(100, Number.NaN), 'none')
})

test('scroll intent only trusts positions, so equal or invalid samples carry none', () => {
    assert.equal(intent.scrollIntent(800, 200), 'up')
    assert.equal(intent.scrollIntent(200, 800), 'down')
    assert.equal(intent.scrollIntent(200, 200), 'none')
    assert.equal(intent.scrollIntent(Number.NaN, 200), 'none')
})

test('keyboard intent covers the scrolling keys and ignores claimed chords', () => {
    for (const key of ['PageUp', 'ArrowUp', 'Home']) assert.equal(intent.keyIntent(key), 'up')
    for (const key of ['PageDown', 'ArrowDown', 'End']) assert.equal(intent.keyIntent(key), 'down')
    assert.equal(intent.keyIntent('PageUp', { ctrlKey: true }), 'none')
    assert.equal(intent.keyIntent('PageUp', { metaKey: true }), 'none')
    assert.equal(intent.keyIntent('PageUp', { altKey: true }), 'none')
    assert.equal(intent.keyIntent('a'), 'none')
    assert.equal(intent.keyIntent(''), 'none')
})

// ---------------------------------------------------------------------------
// Request budget
// ---------------------------------------------------------------------------

const limits = (overrides: Partial<budget.EarlierLoadBudgetLimits> = {}): budget.EarlierLoadBudgetLimits => ({
    ...budget.EARLIER_LOAD_BUDGET_DEFAULTS,
    maxRequestsPerBurst: 3,
    burstWindowMs: 1_200,
    requestTimeoutMs: 12_000,
    failureCooldownMs: 1_000,
    failureCooldownCapMs: 4_000,
    maxAutomaticPages: 48,
    maxConsecutiveFailures: 3,
    ...overrides,
})

test('the budget keeps one request in flight at a time', () => {
    const subject = new budget.EarlierLoadBudget(limits())
    assert.deepEqual(subject.allow(0), { allowed: true })
    subject.requested(0)
    assert.deepEqual(subject.allow(10), { allowed: false, reason: 'pending' })
    subject.succeeded(20)
    assert.deepEqual(subject.allow(30), { allowed: true })
})

test('a hung request expires as a failure instead of blocking the reader forever', () => {
    const subject = new budget.EarlierLoadBudget(limits({ requestTimeoutMs: 500, failureCooldownMs: 100 }))
    subject.requested(0)
    assert.deepEqual(subject.allow(499), { allowed: false, reason: 'pending' })
    // The expiring call records a failure, so the same call reports the cooldown.
    assert.deepEqual(subject.allow(500), { allowed: false, reason: 'cooldown' })
    const view = subject.snapshot(500)
    assert.equal(view.pending, false)
    assert.equal(view.consecutiveFailures, 1)
    assert.deepEqual(subject.allow(600), { allowed: true })
})

test('the burst window bounds automatic pages and reopens after a quiet period', () => {
    const subject = new budget.EarlierLoadBudget(limits({ maxRequestsPerBurst: 2, burstWindowMs: 1_000 }))
    subject.requested(0); subject.succeeded(10)
    subject.requested(20); subject.succeeded(30)
    assert.deepEqual(subject.allow(40), { allowed: false, reason: 'burst' })
    assert.deepEqual(subject.allow(1_010), { allowed: true })
    assert.equal(subject.snapshot(1_010).requestsInBurst, 0)
})

test('the lifetime cap stops an endless automatic walk even when the reader keeps scrolling', () => {
    const subject = new budget.EarlierLoadBudget(limits({ maxRequestsPerBurst: 10, burstWindowMs: 1, maxAutomaticPages: 2 }))
    subject.requested(0); subject.succeeded(1)
    subject.requested(2); subject.succeeded(3)
    assert.deepEqual(subject.allow(4), { allowed: false, reason: 'exhausted' })
})

test('consecutive failures add a growing cooldown and a success clears the streak', () => {
    const subject = new budget.EarlierLoadBudget(limits({ burstWindowMs: 1, failureCooldownMs: 1_000, failureCooldownCapMs: 4_000 }))
    subject.requested(0); subject.failed(0)
    assert.deepEqual(subject.allow(999), { allowed: false, reason: 'cooldown' })
    assert.deepEqual(subject.allow(1_000), { allowed: true })
    subject.requested(1_000); subject.failed(1_000)
    assert.equal(subject.snapshot(1_000).cooldownRemainingMs, 2_000)
    subject.requested(4_000); subject.succeeded(4_000)
    assert.equal(subject.snapshot(4_000).consecutiveFailures, 0)
    assert.equal(subject.snapshot(4_000).cooldownRemainingMs, 0)
})

test('a failure streak suspends automatic loading until external progress resumes it', () => {
    const subject = new budget.EarlierLoadBudget(limits({
        burstWindowMs: 1, failureCooldownMs: 1, maxConsecutiveFailures: 2,
    }))
    subject.requested(0); subject.failed(0)
    subject.requested(2); subject.failed(2)
    assert.deepEqual(subject.allow(100), { allowed: false, reason: 'suspended' })
    assert.equal(subject.snapshot(100).suspended, true)
    // The reader's manual control or a delayed upstream page resumes automation.
    subject.resume()
    assert.deepEqual(subject.allow(100), { allowed: true })
    assert.equal(subject.snapshot(100).suspended, false)
})

test('abandoning an approved but unstarted request returns its budget', () => {
    const subject = new budget.EarlierLoadBudget(limits())
    subject.requested(0)
    subject.abandoned(1)
    const view = subject.snapshot(1)
    assert.equal(view.pending, false)
    assert.equal(view.automaticPages, 0)
    assert.equal(view.requestsInBurst, 0)
    assert.deepEqual(subject.allow(2), { allowed: true })
})

test('the budget rejects nonsensical limits at construction', () => {
    assert.throws(() => new budget.EarlierLoadBudget({ maxRequestsPerBurst: 0 }), /maxRequestsPerBurst/)
    assert.throws(() => new budget.EarlierLoadBudget({ maxAutomaticPages: 0 }), /maxAutomaticPages/)
    assert.throws(() => new budget.EarlierLoadBudget({ requestTimeoutMs: 0 }), /requestTimeoutMs/)
    assert.throws(() => new budget.EarlierLoadBudget({ burstWindowMs: 0 }), /burstWindowMs/)
})

// ---------------------------------------------------------------------------
// Residual anchor correction
// ---------------------------------------------------------------------------

const correction = (overrides: Partial<AnchorCorrectionInput> = {}): AnchorCorrectionInput => ({
    anchor: { key: 'row-anchor', offset: 20 },
    current: { key: 'row-anchor', offset: 20 },
    scrollTop: 1_000,
    scrollHeight: 9_000,
    clientHeight: 800,
    ...overrides,
})

test('an already-stable anchor is never shifted again by the plugin', () => {
    // Browser scroll anchoring (or upstream preserve()) already kept the row.
    assert.deepEqual(anchor.planAnchorCorrection(correction()), { apply: false, residual: 0 })
    assert.deepEqual(anchor.planAnchorCorrection(correction({ current: { key: 'row-anchor', offset: 20.5 } })),
        { apply: false, residual: 0.5 })
})

test('only the residual drift is corrected, never the whole prepended height', () => {
    const plan = anchor.planAnchorCorrection(correction({ current: { key: 'row-anchor', offset: 1_300 } }))
    assert.deepEqual(plan, { apply: true, targetScrollTop: 2_280, residual: 1_280 })
})

test('a correction cannot leave the real scroll range', () => {
    const floor = anchor.planAnchorCorrection(correction({
        current: { key: 'row-anchor', offset: 5_000 }, scrollTop: 0, scrollHeight: 1_000, clientHeight: 800,
    }))
    assert.deepEqual(floor, { apply: true, targetScrollTop: 200, residual: 4_980 })
    // A negative residual corrects toward the top but clamps at 0.
    const ceiling = anchor.planAnchorCorrection(correction({
        current: { key: 'row-anchor', offset: 0 }, scrollTop: 3,
    }))
    assert.deepEqual(ceiling, { apply: true, targetScrollTop: 0, residual: -20 })
})

test('a missing anchor (rewind or resync removed the row) means hands off', () => {
    assert.deepEqual(anchor.planAnchorCorrection(correction({ current: null })), { apply: false, residual: 0 })
})

test('residual correction is idempotent: planning after the applied write is a no-op', () => {
    const first = anchor.planAnchorCorrection(correction({ current: { key: 'row-anchor', offset: 1_300 } }))
    assert.equal(first.apply, true)
    if (!first.apply) return
    // Simulate the scroll write putting the row back at its captured offset.
    const second = anchor.planAnchorCorrection(correction({
        current: { key: 'row-anchor', offset: 20 + (first.targetScrollTop - 1_000) - (first.targetScrollTop - 1_000) },
        scrollTop: first.targetScrollTop,
    }))
    assert.deepEqual(second, { apply: false, residual: 0 })
})

// ---------------------------------------------------------------------------
// Load policy
// ---------------------------------------------------------------------------

const policyOptions = (overrides: Partial<policy.EarlierLoadPolicyOptions['budget']> = {}): policy.EarlierLoadPolicyOptions => ({
    budget: { maxRequestsPerBurst: 3, burstWindowMs: 1_200, requestTimeoutMs: 12_000, failureCooldownMs: 1_000, failureCooldownCapMs: 4_000, maxAutomaticPages: 48, maxConsecutiveFailures: 3, ...overrides },
})

const view = (overrides: Partial<EarlierViewState> = {}): EarlierViewState => ({
    hasMore: true,
    loading: false,
    open: true,
    followingTail: false,
    scrollTop: 120,
    clientHeight: 800,
    scrollHeight: 2400,
    fixated: false,
    ...overrides,
})

test('an explicit upward gesture near the top of an open, pageable window starts a request', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions())
    assert.deepEqual(subject.evaluate(view(), 'up', 0), { request: true })
})

test('the lead distance is one viewport capped at 600px', () => {
    assert.equal(policy.nearTopPixels(800), 600)
    assert.equal(policy.nearTopPixels(300), 300)
    assert.equal(policy.nearTopPixels(0), 0)
    const subject = new policy.EarlierLoadPolicy(policyOptions())
    assert.deepEqual(subject.evaluate(view({ clientHeight: 1_200, scrollTop: 600 }), 'up', 0), { request: true })
    assert.deepEqual(subject.evaluate(view({ clientHeight: 1_200, scrollTop: 601 }), 'up', 0), { request: false, reason: 'not-near-top' })
})

test('every reader-facing gate refuses before the budget is touched', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions())
    assert.deepEqual(subject.evaluate(view(), 'down', 0), { request: false, reason: 'no-intent' })
    assert.deepEqual(subject.evaluate(view(), 'none', 0), { request: false, reason: 'no-intent' })
    assert.deepEqual(subject.evaluate(view({ open: false }), 'up', 0), { request: false, reason: 'not-open' })
    assert.deepEqual(subject.evaluate(view({ hasMore: false }), 'up', 0), { request: false, reason: 'exhausted' })
    assert.deepEqual(subject.evaluate(view({ loading: true }), 'up', 0), { request: false, reason: 'loading' })
    assert.deepEqual(subject.evaluate(view({ followingTail: true }), 'up', 0), { request: false, reason: 'following-tail' })
    assert.deepEqual(subject.evaluate(view({ fixated: true }), 'up', 0), { request: false, reason: 'fixated' })
    assert.deepEqual(subject.evaluate(view({ scrollTop: 5_000 }), 'up', 0), { request: false, reason: 'not-near-top' })
    // No gate consumed a request: the first accepted evaluation still works.
    assert.deepEqual(subject.evaluate(view(), 'up', 0), { request: true })
})

for (const scrollHeight of [754, 774]) {
test(`a following window with ${scrollHeight - 754}px range can page upward at its actual top`, () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions())
    const short = view({ followingTail: true, scrollTop: 0, clientHeight: 754, scrollHeight })
    assert.deepEqual(subject.evaluate(short, 'up', 0), { request: true })
    assert.deepEqual(subject.evaluate({ ...short, scrollTop: 1 }, 'up', 0), { request: true })
    assert.deepEqual(subject.evaluate({ ...short, scrollTop: 1.1 }, 'up', 0), { request: false, reason: 'following-tail' })
    if (scrollHeight > short.clientHeight) assert.deepEqual(
        subject.evaluate({ ...short, scrollTop: scrollHeight - short.clientHeight }, 'up', 0),
        { request: false, reason: 'following-tail' }, 'the short window bottom is still protected until the reader reaches its top')
    assert.deepEqual(subject.evaluate(short, 'none', 0), { request: false, reason: 'no-intent' })
    assert.deepEqual(subject.evaluate(short, 'down', 0), { request: false, reason: 'no-intent' })
    assert.deepEqual(subject.evaluate({ ...short, open: false }, 'up', 0), { request: false, reason: 'not-open' })
    assert.deepEqual(subject.evaluate({ ...short, loading: true }, 'up', 0), { request: false, reason: 'loading' })
    assert.deepEqual(subject.evaluate({ ...short, hasMore: false }, 'up', 0), { request: false, reason: 'exhausted' })
    assert.deepEqual(subject.evaluate({ ...short, fixated: true }, 'up', 0), { request: false, reason: 'fixated' })
    subject.requested(0)
    assert.deepEqual(subject.evaluate(short, 'up', 1), { request: false, reason: 'budget' })
})
}

test('a long following window permits upward paging only at its actual top', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions())
    const long = view({ followingTail: true, scrollTop: 0, clientHeight: 754, scrollHeight: 2400 })
    assert.deepEqual(subject.evaluate(long, 'up', 0), { request: true })
    assert.deepEqual(subject.evaluate({ ...long, scrollTop: 120 }, 'up', 0), { request: false, reason: 'following-tail' },
        'being within the prefetch lead alone cannot override following')
    assert.deepEqual(subject.evaluate({ ...long, scrollTop: 1646 }, 'up', 0), { request: false, reason: 'following-tail' })
})

test('one in-flight request blocks a second request from scroll momentum', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions())
    subject.requested(1)
    assert.deepEqual(subject.evaluate(view(), 'up', 20), { request: false, reason: 'budget' })
    subject.committed(30)
    assert.deepEqual(subject.evaluate(view(), 'up', 40), { request: true })
})

test('the burst limit stops repeated automatic pages and reopens after the window', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions({ maxRequestsPerBurst: 1, burstWindowMs: 1_000 }))
    subject.requested(0); subject.committed(10)
    assert.deepEqual(subject.evaluate(view(), 'up', 20), { request: false, reason: 'budget' })
    assert.deepEqual(subject.evaluate(view(), 'up', 1_010), { request: true })
})

test('a failed page waits for its cooldown and then retries on the next gesture only', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions({ failureCooldownMs: 500 }))
    subject.requested(0); subject.failed(10)
    assert.deepEqual(subject.evaluate(view(), 'up', 200), { request: false, reason: 'budget' })
    assert.deepEqual(subject.evaluate(view(), 'up', 510), { request: true })
})

test('a request that never settles times out and counts as a retryable failure', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions({ requestTimeoutMs: 1_000, failureCooldownMs: 200 }))
    subject.requested(0)
    // Before the timeout the budget still reports the request as in flight.
    assert.deepEqual(subject.evaluate(view(), 'up', 500), { request: false, reason: 'budget' })
    assert.equal(subject.expire(999), false)
    assert.equal(subject.expire(1_000), true)
    assert.equal(subject.snapshot(1_000).consecutiveFailures, 1)
    assert.deepEqual(subject.evaluate(view(), 'up', 1_199), { request: false, reason: 'budget' })
    assert.deepEqual(subject.evaluate(view(), 'up', 1_200), { request: true })
})

test('a failure streak suspends the policy and manual progress resumes it', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions({
        burstWindowMs: 1, failureCooldownMs: 1, maxConsecutiveFailures: 2, maxRequestsPerBurst: 2,
    }))
    subject.requested(0); subject.failed(0)
    subject.requested(2); subject.failed(2)
    assert.deepEqual(subject.evaluate(view(), 'up', 100), { request: false, reason: 'suspended' })
    subject.resume()
    assert.deepEqual(subject.evaluate(view(), 'up', 100), { request: true })
})

test('replacing the conversation surface resets burst and failure state', () => {
    const subject = new policy.EarlierLoadPolicy(policyOptions({ maxRequestsPerBurst: 1, burstWindowMs: 60_000 }))
    subject.requested(0); subject.failed(10)
    assert.deepEqual(subject.evaluate(view(), 'up', 11), { request: false, reason: 'budget' })
    subject.reset()
    assert.deepEqual(subject.evaluate(view(), 'up', 12), { request: true })
})

// ---------------------------------------------------------------------------
// Cross-pane aggregate bounds and per-session page ceiling
// ---------------------------------------------------------------------------

test('the aggregate gate bounds concurrent and per-window automatic requests', () => {
    const gate = new concurrency.AggregateLoadGate({ maxConcurrent: 2, maxStartsPerWindow: 3, windowMs: 1_000 })
    assert.deepEqual(gate.tryStart(0), { allowed: true })
    assert.deepEqual(gate.tryStart(1), { allowed: true })
    assert.deepEqual(gate.tryStart(2), { allowed: false, reason: 'concurrent' })
    gate.release()
    assert.deepEqual(gate.tryStart(3), { allowed: true })
    gate.release()
    // Three starts already happened in this window; the slot is free but the rate is spent.
    assert.deepEqual(gate.tryStart(4), { allowed: false, reason: 'rate' })
    gate.release(); gate.release()
    assert.deepEqual(gate.tryStart(1_010), { allowed: true })
    assert.deepEqual(gate.snapshot(1_010), { active: 1, startsInWindow: 1 })
    gate.reset()
    assert.deepEqual(gate.snapshot(1_010), { active: 0, startsInWindow: 0 })
})

test('the aggregate gate validates its limits', () => {
    assert.throws(() => new concurrency.AggregateLoadGate({ maxConcurrent: 0 }), /maxConcurrent/)
    assert.throws(() => new concurrency.AggregateLoadGate({ maxStartsPerWindow: 0 }), /maxStartsPerWindow/)
    assert.throws(() => new concurrency.AggregateLoadGate({ windowMs: 0 }), /windowMs/)
})

test('the per-session page ledger is shared by identity and caps automatic pages', () => {
    const ledger = new concurrency.SessionPageLedger(2)
    assert.equal(ledger.exhausted('host|pane-a|session-1'), false)
    ledger.spend('host|pane-a|session-1')
    ledger.spend('host|pane-a|session-1')
    assert.equal(ledger.exhausted('host|pane-a|session-1'), true)
    assert.equal(ledger.pages('host|pane-a|session-1'), 2)
    // Another pane of the same conversation consumes the same identity budget.
    assert.equal(ledger.exhausted('host|pane-b|session-1'), false)
    ledger.spend('host|pane-b|session-1')
    assert.equal(ledger.pages('host|pane-b|session-1'), 1)
    ledger.reset()
    assert.equal(ledger.exhausted('host|pane-a|session-1'), false)
    assert.throws(() => new concurrency.SessionPageLedger(0), /positive integer/)
})

// ---------------------------------------------------------------------------
// Initial previous-Turn prefetch: unlike reader paging, it never navigates.
// ---------------------------------------------------------------------------

const initial = (patch: Partial<Parameters<InitialHistoryPlan['evaluate']>[0]> = {}) => ({
    visible: true, open: true, loading: false, hasMore: true, previousTurnIncluded: false, events: 0, ...patch,
})

test('initial history waits for visible open state and leaves an already complete window alone', () => {
    const subject = new InitialHistoryPlan()
    assert.equal(subject.evaluate(initial({ visible: false })), false)
    assert.equal(subject.evaluate(initial({ open: false })), false)
    assert.equal(subject.evaluate(initial({ loading: true })), false)
    assert.equal(subject.pages, 0)
    assert.equal(subject.evaluate(initial()), true)
    assert.equal(subject.evaluate(initial({ previousTurnIncluded: true })), false)
    assert.equal(subject.state, 'ready')
    assert.equal(subject.evaluate(initial()), false)
    const exhausted = new InitialHistoryPlan()
    assert.equal(exhausted.evaluate(initial({ hasMore: false })), false)
    assert.equal(exhausted.state, 'exhausted')
})

test('initial history shares one flight and stops after observing the previous Turn', () => {
    const subject = new InitialHistoryPlan()
    assert.equal(subject.evaluate(initial()), true)
    subject.requested()
    assert.equal(subject.evaluate(initial()), false)
    subject.settled({ firstSeq: 100, turns: 1, previousTurnIncluded: false }, { firstSeq: 50, turns: 2, previousTurnIncluded: true }, true)
    assert.equal(subject.state, 'ready')
    assert.equal(subject.pages, 1)
    assert.equal(subject.evaluate(initial()), false)
})

test('oversized initial Turns stop after two pages without claiming the previous input is loaded', () => {
    const subject = new InitialHistoryPlan()
    for (let i=0;i<2;i++) {
        assert.equal(subject.evaluate(initial()), true)
        subject.requested()
        subject.settled({ firstSeq: 5000-i*200, turns: 1, previousTurnIncluded: false }, { firstSeq: 4800-i*200, turns: 1, previousTurnIncluded: false }, true)
    }
    assert.equal(subject.state, 'limited')
    assert.equal(subject.evaluate(initial()), false)
    assert.equal(subject.pages, 2)
})

test('a tool-heavy initial page stops prefetch at its event budget even before two pages', () => {
    const subject = new InitialHistoryPlan()
    assert.equal(subject.evaluate(initial({ events: 1500 })), false)
    assert.equal(subject.pages, 0)
    assert.equal(subject.state, 'limited')
})

test('initial failure or live-only append never counts as prepend and never starts a retry loop', () => {
    const subject = new InitialHistoryPlan()
    subject.requested()
    subject.settled({ firstSeq: 100, turns: 1, previousTurnIncluded: false }, { firstSeq: 100, turns: 1, previousTurnIncluded: false }, true)
    assert.equal(subject.state, 'error')
    assert.equal(subject.evaluate(initial()), false)
    const rejected = new InitialHistoryPlan()
    rejected.requested(); rejected.failed()
    assert.equal(rejected.evaluate(initial()), false)
    assert.equal(rejected.state, 'error')
})

test('reader input suppresses initial prefetch and does not abort a shared in-flight page', () => {
    const subject = new InitialHistoryPlan()
    subject.interrupt()
    assert.equal(subject.evaluate(initial()), false)
    const running = new InitialHistoryPlan()
    running.requested(); running.interrupt()
    assert.equal(running.state, 'loading')
    running.settled({ firstSeq: 100, turns: 1, previousTurnIncluded: false }, { firstSeq: 50, turns: 1, previousTurnIncluded: false }, true)
    assert.equal(running.state, 'reader')
    assert.equal(running.evaluate(initial()), false)
})

test('initial history counts distinct durable Turn starts, excluding tools and transient text', () => {
    const entries = [
        { type: 'event', event: { type: 'turn/start', seq: 10, data: { turn: 1 } } },
        { type: 'event', event: { type: 'turn/start', seq: 11, data: { turn: 1 } } },
        { type: 'event', event: { type: 'tool/start', seq: 12, data: { turn: 1 } } },
        { type: 'transient', event: { type: 'assistant/live-chunk', seq: 12.5, data: { turn: 2 } } },
        { type: 'event', event: { type: 'turn/start', seq: 13, data: { turn: 2 } } },
    ] as unknown as SessionEventWindow['entries']
    assert.deepEqual(probeInitialWindow({ entries }), { firstSeq: 10, turns: 2, previousTurnIncluded: false })
    assert.deepEqual(probeInitialWindow({ entries: [] }), { firstSeq: null, turns: 0, previousTurnIncluded: false })
})

test('aggregate slot release wakes deferred initial views exactly once, and unsubscribe ends it', () => {
    const subject = new concurrency.AggregateLoadGate({ maxConcurrent: 1 })
    let releases = 0
    const unsubscribe = subject.subscribe(() => { releases++ })
    subject.tryStart(0); subject.release(); subject.release()
    assert.equal(releases, 1)
    subject.tryStart(1); unsubscribe(); subject.release()
    assert.equal(releases, 1)
})
