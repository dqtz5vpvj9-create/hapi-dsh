/** Pure seams of seamless earlier-history loading: intent, budget, anchor, policy. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    anchor, budget, concurrency, intent, policy,
} from '../src/client/seamless/index.ts'
import type { AnchorCorrectionInput } from '../src/client/seamless/anchor.ts'
import type { EarlierViewState } from '../src/client/seamless/policy.ts'

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
