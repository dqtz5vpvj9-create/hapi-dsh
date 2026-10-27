import assert from 'node:assert/strict'
import test from 'node:test'
import { coldOpeningIssues, type ColdOpeningHistoryOperation, type ColdOpeningResult, type ColdOpeningState } from '../scripts/cold-opening-observer.mjs'

function operation(id: number, changes: Partial<ColdOpeningHistoryOperation> = {}): ColdOpeningHistoryOperation {
    return { id, scopeRevision: 1, origin: 'requested', intentRevision: 1, intentAt: 100,
        requestAt: 110 + id * 100, commitAt: 150 + id * 100, status: 'committed',
        domAt: 140 + id * 100, domPrepend: true, anchorAt: 140 + id * 100,
        anchorKeyHash: 1, anchorOffset: 20, anchorRetained: true, anchorDriftPx: 0, ...changes }
}

function historyIssues(operations: ColdOpeningHistoryOperation[], changes: Record<string, unknown> = {}): string[] {
    // Other opening capabilities are outside these pure correlation checks.
    // The browser controls exercise how the observer obtains these records.
    const trace = { verifiedFreshness: true, verifiedTitle: true, expectedViewSupplied: true,
        fullCapabilities: true, requireHistoryAction: true, states: [], titles: [],
        first: { full: 10, stable: 20 }, history: {
            intents: 1, intentAt: 100, lastIntentAt: 100, requestRevision: operations.length,
            requestAt: operations.at(-1)?.requestAt ?? null,
            commitRevision: operations.filter(row => row.status === 'committed').length,
            commitAt: operations.findLast(row => row.status === 'committed')?.commitAt ?? null,
            operations, violations: [], ...changes,
        } } as unknown as ColdOpeningResult
    return coldOpeningIssues(trace)
}

test('a pending second request is reported as pending, without pairing it with the first commit', () => {
    const issues = historyIssues([operation(1), operation(2, { status: 'pending', commitAt: null })])
    assert.ok(issues.includes('Source page request did not commit a source page'))
    assert.ok(!issues.includes('Source page commit predates its request'))
})

test('each completed request is evaluated with its own commit despite later summary counters', () => {
    assert.deepEqual(historyIssues([operation(1), operation(2)], { requestAt: 9000, commitAt: 8000 }), [])
})

test('an actually reversed request/commit pair is still rejected', () => {
    assert.ok(historyIssues([operation(1, { commitAt: 205 })]).includes('Source page commit predates its request'))
})

test('a missing source operation cannot be replaced by last-request/commit or DOM counters', () => {
    assert.ok(historyIssues([], { requestRevision: 4, commitRevision: 4, domPrependRevision: 4, requestAt: 110, commitAt: 120 })
        .includes('Trusted history paging did not issue a source page request'))
})

test('a source pair needs independent DOM and retained anchor evidence', () => {
    const issues = historyIssues([operation(1, { domPrepend: false, anchorAt: null, anchorRetained: null, anchorDriftPx: null })])
    assert.ok(issues.includes('Source page commit had no independently observed DOM prepend'))
    assert.ok(issues.includes('Older-page commit did not measure a retained reading anchor'))
})

test('the inclusive 2 px limit is unchanged and applies to every retained operation', () => {
    assert.deepEqual(historyIssues([operation(1, { anchorDriftPx: 2 }), operation(2, { anchorDriftPx: -2 })]), [])
    assert.ok(historyIssues([operation(1, { anchorDriftPx: -2.01 }), operation(2)])
        .some(issue => issue.startsWith('Older-page commit drifted the reading anchor')))
})

test('orphan, duplicate and prior anchor failures survive eviction of completed records', () => {
    const violations = [
        'Source page commit had no matching request in its pane/session/identity',
        'Source page request overlapped an unresolved request; correlation is ambiguous',
        'Older-page commit drifted the reading anchor beyond 2 px',
    ]
    const recent = Array.from({ length: 128 }, (_, index) => operation(index + 2))
    assert.deepEqual(historyIssues(recent, { violations }), violations)
})

function identityIssues(states: Partial<ColdOpeningState>[]): string[] {
    return coldOpeningIssues({ verifiedFreshness: true, verifiedTitle: true, expectedViewSupplied: true,
        fullCapabilities: false, first: { full: 20, stable: 30 }, titles: [], states,
    } as unknown as ColdOpeningResult).filter(issue => issue.startsWith('Visible session view did not match'))
}

test('navigation and an empty opening pane do not claim a presented session identity', () => {
    assert.deepEqual(identityIssues([
        { at: 0, paneVisible: false, viewMatches: false, bodyVisible: false, editorVisible: false },
        { at: 10, paneVisible: true, viewMatches: false, bodyVisible: false, editorVisible: false, opening: true },
        { at: 20, paneVisible: true, viewMatches: true, bodyVisible: true, editorVisible: true },
    ]), [])
})

test('wrong first body or editor identity is rejected even when the target later appears', () => {
    for (const exposure of [{ bodyVisible: true }, { editorVisible: true }]) {
        assert.equal(identityIssues([
            { at: 10, paneVisible: true, viewMatches: false, ...exposure },
            { at: 20, paneVisible: true, viewMatches: true, bodyVisible: true, editorVisible: true },
        ]).length, 1)
    }
})

test('a presented target losing its identity is rejected even with no remaining body', () => {
    assert.equal(identityIssues([
        { at: 10, viewMatches: true, bodyVisible: true, editorVisible: true },
        { at: 20, viewMatches: false, bodyVisible: false, editorVisible: false },
    ]).length, 1)
})
