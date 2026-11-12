/** Pure original time semantics plus server rendering of source-only row facts. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'
import { SessionRowState } from '../src/client/sidebar-row-state.tsx'
import { en, type WorkspaceTranslate } from '../src/client/locales.ts'
import { sessionRelativeTime, sourceTimeMilliseconds } from '../src/workspace/sidebar-row.ts'
import { sessionActivity } from '../src/workspace/presentation.ts'

const t: WorkspaceTranslate = (key, params) => en[key].replace(/\{(\w+)\}/g, (_, field: string) => String(params?.[field] ?? field))
const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread' }
const source: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Source', cwd: '/source', updatedAt: 1,
    status: 'running', activeTurnId: 'turn', capabilities: { send: true, steer: true, cancel: true, approve: true, files: true }, pendingRequests: [] }
const render = (source: SourceSession | undefined) => renderToStaticMarkup(createElement(SessionRowState, { source, t }))

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

test('row facts show only current native requests and do not fabricate source tasks or schedules', () => {
    assert.equal(render(undefined), '')
    assert.equal(render(source), '')
    const pending = { ...source, pendingRequests: [{ id: 'request', method: 'item/commandExecution/requestApproval', turnId: 'turn', itemId: null, params: {} }] }
    assert.ok(render(pending).includes('1 pending request'))
    const row = { sourceSessionId: source.id, running: true, hostOnline: true, projectionValues: { hhpiSource: source } } satisfies Pick<WorkspaceCatalogRow, 'sourceSessionId' | 'running' | 'hostOnline' | 'projectionValues'>
    assert.deepEqual(sessionActivity(row), { kind: 'running', running: true, pending: false, compacting: false })
    assert.equal(sessionActivity({ ...row, hostOnline: false }).kind, 'offline')
    assert.equal(sessionActivity({ ...row, projectionValues: { hhpiSource: { ...source, status: 'idle' } } }).kind, 'idle')
})
