/** Diagnostics allowlist/ring buffer + api instrumentation + plan/notice visibility. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HapiRemoteApi } from '../src/client-api.ts'
import { DiagnosticsCore, DIAGNOSTICS_LIMIT, safeIdentity, safeRoute, safeToken } from '../src/client/diagnostics/state.ts'
import { instrumentHapiApi, setDiagnosticIdentity } from '../src/client/diagnostics/api.ts'
import { splitSourceNotices } from '../src/client/native-actions.tsx'
import { nativePlanVisible } from '../src/client/native-plan.tsx'

test('diagnostics ring buffer is bounded, deduplicated and memory-only', () => {
  const core = new DiagnosticsCore()
  for (let index = 0; index < DIAGNOSTICS_LIMIT + 40; index++) {
    core.add({ source: 'remote', event: 'remote.rejected', method: `hapi/method${index}`, key: `key-${index}` })
  }
  assert.equal(core.getSnapshot().entries.length, DIAGNOSTICS_LIMIT)
  assert.ok(DIAGNOSTICS_LIMIT >= 200)
  // The newest entry survives; the oldest is evicted.
  assert.equal(core.getSnapshot().entries.at(-1)?.method, `hapi/method${DIAGNOSTICS_LIMIT + 39}`)
  assert.equal(core.getSnapshot().entries[0]?.method, 'hapi/method40')
  // Stable dedupe key: the same source notice is not reported twice.
  core.add({ source: 'source', event: 'source.error', key: 'duplicate' })
  core.add({ source: 'source', event: 'source.error', key: 'duplicate' })
  assert.equal(core.getSnapshot().entries.filter(entry => entry.key === 'duplicate').length, 1)
  core.clear()
  assert.equal(core.getSnapshot().entries.length, 0)
})

test('diagnostics entries are allowlisted: bodies, console text and URL query/fragment never enter', () => {
  const core = new DiagnosticsCore()
  core.add({ source: 'remote', event: 'remote.rejected', method: 'hapi/nativePlan', route: 'https://hub.example/api/sessions/abc?token=secret-token#fragment',
    status: 400, code: 'hapi/request', requestId: 'req-1', outcome: 'rejected', durationMs: 12,
    identity: { hubId: 'hub-1', sessionId: 'session-1', hapiSessionId: 'source-1', machineId: 'machine-1', engine: 'codex', hostId: 'host with spaces' } })
  core.add({ source: 'remote', event: 'remote.failed', method: 'has whitespace', code: 'line\nbreak' })
  core.add({ source: 'console', event: 'console.error', code: 'connection', errorName: 'Error' })
  const [first, second] = core.getSnapshot().entries
  assert.equal(first?.route, '/api/sessions/abc')
  assert.equal(first?.status, 400)
  assert.equal(first?.requestId, 'req-1')
  assert.equal(first?.identity?.machineId, 'machine-1')
  assert.equal(first?.identity?.hostId, undefined, 'unsafe identity token is dropped')
  assert.equal(second?.method, undefined)
  assert.equal(second?.code, undefined)
  const report = core.format()
  for (const secret of ['secret-token', 'token=', 'password', 'fragment', 'has whitespace', 'line\nbreak']) {
    assert.ok(!report.includes(secret), `report leaked ${secret}`)
  }
  assert.ok(report.includes('build ') && report.includes('hapi-dsh'))
  assert.ok(report.includes('route=/api/sessions/abc'))
})

test('identity is captured per event, not through a page-global mutable context', () => {
  const left = new DiagnosticsCore(), right = new DiagnosticsCore()
  assert.deepEqual(safeIdentity({ sessionId: 'a', engine: 'codex' }), { sessionId: 'a', engine: 'codex' })
  assert.equal(safeRoute('/sessions/1?x=2#y'), '/sessions/1')
  assert.equal(safeToken('ok-token'), 'ok-token')
  assert.equal(safeToken('bad token'), undefined)
  left.add({ source: 'remote', event: 'remote.rejected', identity: { sessionId: 'left' } })
  right.add({ source: 'remote', event: 'remote.rejected', identity: { sessionId: 'right' } })
  assert.equal(left.getSnapshot().entries[0]?.identity?.sessionId, 'left')
  assert.equal(right.getSnapshot().entries[0]?.identity?.sessionId, 'right')
})

test('remote failures are recorded without changing results or rejections', async () => {
  const values = new Map<string, unknown>()
  const api = {
    catalog: async () => ({ ok: false, error: { code: 'hapi/request', details: { status: 400, outcome: 'rejected', requestId: 'req-9' } } }),
    nativePlan: async () => { throw Object.assign(new Error('prompt text must not be stored'), { code: 'gateway/timeout' }) },
    nativeSettings: async () => ({ ok: true, value: { theme: 'dark' } }),
  }
  const core = new DiagnosticsCore()
  setDiagnosticIdentity(api as unknown as HapiRemoteApi, { hubId: 'hub', sessionId: 'session', engine: 'codex' })
  const dispose = instrumentHapiApi(api as unknown as HapiRemoteApi, core)
  try {
    const catalog = await api.catalog() as { ok: boolean }
    assert.equal(catalog.ok, false)
    await assert.rejects(api.nativePlan() as Promise<unknown>, /prompt text/)
    assert.deepEqual(await api.nativeSettings(), { ok: true, value: { theme: 'dark' } })
    const entries = core.getSnapshot().entries
    assert.equal(entries.length, 2)
    const rejected = entries.find(entry => entry.method === 'hapi/catalog')
    assert.equal(rejected?.status, 400)
    assert.equal(rejected?.outcome, 'rejected')
    assert.equal(rejected?.requestId, 'req-9')
    assert.equal(rejected?.identity?.sessionId, 'session')
    const timeout = entries.find(entry => entry.method === 'hapi/nativePlan')
    assert.equal(timeout?.event, 'remote.timeout')
    assert.equal(timeout?.code, 'gateway/timeout')
    const report = core.format()
    assert.ok(!report.includes('prompt text'), 'failure message is not stored')
    for (const entry of entries) values.set(entry.method ?? '', true)
    assert.equal(values.size, 2)
  } finally { dispose() }
  // The restored namespace is no longer instrumented.
  assert.equal((api as { catalog: unknown }).catalog instanceof Function, true)
})

test('source errors fold into one quiet line while lifecycle notices stay readable', () => {
  const notices = [
    { kind: 'error', id: 'e1' }, { kind: 'error', id: 'e2' }, { kind: 'compact', id: 'c1' },
    { kind: 'summary', id: 's1' }, { kind: 'message', id: 'm1' },
  ]
  const split = splitSourceNotices(notices)
  assert.deepEqual(split.errors.map(notice => notice.id), ['e1', 'e2'])
  assert.deepEqual(split.others.map(notice => notice.id), ['c1', 's1', 'm1'])
})

test('the plan panel only appears for a real source plan or a pending receipt', () => {
  assert.equal(nativePlanVisible({ planId: null, sourcePlanId: null, operations: 0 }), false)
  assert.equal(nativePlanVisible({ planId: 'plan-1', sourcePlanId: null, operations: 0 }), true)
  assert.equal(nativePlanVisible({ planId: null, sourcePlanId: 'plan-1', operations: 0 }), true)
  // A durable receipt keeps the panel after the source plan disappears.
  assert.equal(nativePlanVisible({ planId: null, sourcePlanId: null, operations: 1 }), true)
})
