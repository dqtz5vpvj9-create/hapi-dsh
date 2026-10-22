/** Pure original time semantics plus server rendering of source-only row facts. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CatalogSession } from '../src/client-api.ts'
import { hapiProjectionSchema } from '../src/codex/projection-types.ts'
import { SessionRowState } from '../src/client/sidebar-row-state.tsx'
import { en, type WorkspaceTranslate } from '../src/client/locales.ts'
import { sessionRelativeTime, sourceTimeMilliseconds } from '../src/workspace/sidebar-row.ts'
import { sessionActivity, sessionCompletedAt } from '../src/workspace/presentation.ts'

const t: WorkspaceTranslate = (key, params) => en[key].replace(/\{(\w+)\}/g, (_, field: string) => String(params?.[field] ?? field))
const empty: NonNullable<CatalogSession['sourceRowState']> = { todoProgress: null, futureScheduledMessageCount: null, nextScheduledAt: null,
    serviceTier: null, backgroundTaskCount: null, pendingRequestsCount: null }
const render = (state: CatalogSession['sourceRowState'], detailed = true) => renderToStaticMarkup(createElement(SessionRowState, { state, detailed, t }))

test('source time accepts original seconds or milliseconds and has exact minute/day cutoffs without changing sorting', () => {
    const now = new Date(2026, 9, 20, 12).getTime()
    assert.equal(sourceTimeMilliseconds(now / 1000), now)
    assert.equal(sessionRelativeTime(now + 1000, t, now), 'Now')
    assert.equal(sessionRelativeTime(now - 59_999, t, now), 'Now')
    assert.equal(sessionRelativeTime(now - 60_000, t, now), '1m ago')
    assert.equal(sessionRelativeTime(now - 3600_000, t, now), '1h ago')
    assert.equal(sessionRelativeTime(now - 86400_000, t, now), '1d ago')
    assert.equal(sessionRelativeTime(new Date(2026, 9, 1).getTime(), t, now), '2026/10/01')
    assert.equal(sessionRelativeTime(Number.NaN, t, now), null)
    assert.equal(sessionRelativeTime(Number.MAX_VALUE, t, now), null)
})

test('unknown counts are not fabricated; mobile standard retains tasks, fast and pending while details show source schedule', () => {
    assert.equal(render(undefined), '')
    assert.equal(render(empty), '')
    const state = { ...empty, todoProgress: { completed: 1, total: 3 }, serviceTier: 'fast', pendingRequestsCount: 2, backgroundTaskCount: 4,
        futureScheduledMessageCount: 5, nextScheduledAt: new Date(2026, 9, 21, 12).getTime() }
    const compact = render(state, false), detailed = render(state)
    for (const text of ['Fast service tier', 'Tasks: 1/3', '2 pending requests']) assert.ok(compact.includes(text))
    assert.ok(!compact.includes('scheduled messages')); assert.ok(!compact.includes('background tasks'))
    assert.ok(detailed.includes('5 scheduled messages')); assert.ok(detailed.includes('4 background tasks'))
    assert.equal(render({ ...empty, todoProgress: { completed: 3, total: 3 }, futureScheduledMessageCount: 0, pendingRequestsCount: 0, backgroundTaskCount: 0, serviceTier: 'standard' }), '')
})

test('a real connected background task keeps running status, but a disconnected source never appears active', () => {
    const row = { running: false, hostOnline: true, sourceRowState: { ...empty, backgroundTaskCount: 2, pendingRequestsCount: 1 } }
    assert.deepEqual(sessionActivity(row), { kind: 'background', running: true, pending: true, compacting: false })
    assert.deepEqual(sessionActivity({ ...row, hostOnline: false }), { kind: 'offline', running: false, pending: true, compacting: false })
    assert.equal(sessionActivity({ ...row, sourceRowState: empty }).kind, 'idle')
})

test('completion needs an original completion timestamp after the latest start', () => {
    const source = hapiProjectionSchema.parse({ engine: 'codex', nativeConnection: 'attached', pendingRequests: [], error: null,
        hubId: 'hub', hapiSessionId: 'source', logicalSessionId: 'display', displayRevision: 1, machineId: null, machineName: null,
        nativeId: 'thread', nativeHome: null, readOnly: false, model: 'astra', reasoningEffort: null, delivery: [], resolvedRequests: [],
        execution: { owner: 'native', generation: 'one', sequence: 1, turnId: 'turn', status: 'idle', waitingOn: [], startedAt: 100, completedAt: 200 } })!
    const row = { running: false, hostOnline: true, projectionValues: { hapi: source } }
    assert.equal(sessionCompletedAt(row), 200)
    assert.equal(sessionActivity(row).kind, 'completed')
    assert.equal(sessionActivity({ ...row, hostOnline: false }).kind, 'offline')
    source.execution!.completedAt = 50
    assert.equal(sessionCompletedAt(row), undefined)
    assert.equal(sessionActivity(row).kind, 'idle')
    source.execution!.status = 'active'
    assert.equal(sessionActivity(row).kind, 'running')
    assert.equal(sessionCompletedAt(row), undefined)
})
