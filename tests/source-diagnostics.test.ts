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
    nativePlan: async (_request: { sessionId: string }) => { throw Object.assign(new Error('prompt text must not be stored'), { code: 'gateway/timeout' }) },
    nativeSettings: async () => ({ ok: true, value: { theme: 'dark' } }),
  }
  const core = new DiagnosticsCore()
  setDiagnosticIdentity(api as unknown as HapiRemoteApi, { hubId: 'hub', sessionId: 'session', engine: 'codex' })
  const dispose = instrumentHapiApi(api as unknown as HapiRemoteApi, core)
  try {
    const catalog = await api.catalog() as { ok: boolean }
    assert.equal(catalog.ok, false)
    await assert.rejects(api.nativePlan({ sessionId: 'session' }) as Promise<unknown>, /prompt text/)
    assert.deepEqual(await api.nativeSettings(), { ok: true, value: { theme: 'dark' } })
    const entries = core.getSnapshot().entries
    assert.equal(entries.length, 2)
    const rejected = entries.find(entry => entry.method === 'hapi/catalog')
    assert.equal(rejected?.status, 400)
    assert.equal(rejected?.outcome, 'rejected')
    assert.equal(rejected?.requestId, 'req-9')
    assert.equal(rejected?.identity, undefined, 'Host-wide catalog failure has no pane owner')
    const timeout = entries.find(entry => entry.method === 'hapi/nativePlan')
    assert.equal(timeout?.event, 'remote.timeout')
    assert.equal(timeout?.code, 'gateway/timeout')
    assert.equal(timeout?.identity?.sessionId, 'session')
    const report = core.format()
    assert.ok(!report.includes('prompt text'), 'failure message is not stored')
    for (const entry of entries) values.set(entry.method ?? '', true)
    assert.equal(values.size, 2)
  } finally { dispose() }
  // The restored namespace is no longer instrumented.
  assert.equal((api as { catalog: unknown }).catalog instanceof Function, true)
})

test('shared API failures keep the invocation session across concurrent panes and identity updates', async () => {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>()
  const globalResult = { ok: false, error: { code: 'fixture/global' } }
  const api = {
    nativePlan(request: { sessionId: string }): Promise<unknown> {
      assert.equal(this, api, 'Instrumentation must preserve the API receiver')
      return new Promise((resolve, reject) => { pending.set(request.sessionId, { resolve, reject }) })
    },
    catalog: () => globalResult,
  }
  const remote = api as unknown as HapiRemoteApi, core = new DiagnosticsCore()
  const identityA = { sessionId: 'pane-a', hubId: 'hub-a', hapiSessionId: 'source-a', engine: 'codex' }
  setDiagnosticIdentity(remote, identityA)
  identityA.hubId = 'changed-caller-object'
  const dispose = instrumentHapiApi(remote, core)
  try {
    const requestA = { sessionId: 'pane-a' }
    const callA = api.nativePlan(requestA)
    setDiagnosticIdentity(remote, { sessionId: 'pane-b', hubId: 'hub-b', engine: 'pi' })
    const callB = api.nativePlan({ sessionId: 'pane-b' })
    const callUnknown = api.nativePlan({ sessionId: 'not-yet-known' })
    requestA.sessionId = 'pane-b'
    setDiagnosticIdentity(remote, { sessionId: 'pane-a', hubId: 'new-hub-a', engine: 'changed-engine' })
    setDiagnosticIdentity(remote, { sessionId: 'not-yet-known', hubId: 'late-hub' })

    const resultB = { ok: false, error: { code: 'fixture/b', details: { requestId: 'request-b' } } }
    pending.get('pane-b')!.resolve(resultB)
    assert.equal(await callB, resultB)
    const failureA = Object.assign(new Error('private request failure'), { code: 'gateway/timeout', requestId: 'request-a' })
    const rejectedA = assert.rejects(callA, error => error === failureA)
    pending.get('pane-a')!.reject(failureA)
    await rejectedA
    const unknownResult = { ok: false, error: { code: 'fixture/unknown' } }
    pending.get('not-yet-known')!.resolve(unknownResult)
    assert.equal(await callUnknown, unknownResult)
    assert.equal(api.catalog(), globalResult)

    const entries = core.getSnapshot().entries
    assert.deepEqual(entries.find(entry => entry.requestId === 'request-a')?.identity,
      { sessionId: 'pane-a', hubId: 'hub-a', hapiSessionId: 'source-a', engine: 'codex' })
    assert.deepEqual(entries.find(entry => entry.requestId === 'request-b')?.identity,
      { sessionId: 'pane-b', hubId: 'hub-b', engine: 'pi' })
    assert.equal(entries.find(entry => entry.code === 'fixture/unknown')?.identity, undefined,
      'A later identity announcement cannot retroactively claim an unknown request')
    assert.equal(entries.find(entry => entry.method === 'hapi/catalog')?.identity, undefined)
    assert.ok(!core.format().includes('private request failure'))
  } finally { dispose() }
})

test('remote identity lookup reads only a safe own session data field and preserves sync outcomes', () => {
  const failure = { ok: false, error: { code: 'fixture/rejected', message: 'private failure text' } }
  const thrown = Object.assign(new Error('private synchronous error'), { code: 'fixture/thrown' })
  const api = { nativePlan: (_request: unknown) => failure, nativeCancel: (_request: unknown) => { throw thrown } }
  const remote = api as unknown as HapiRemoteApi, core = new DiagnosticsCore()
  setDiagnosticIdentity(remote, { sessionId: 'known', hubId: 'known-hub' })
  let sessionReads = 0, bodyReads = 0
  const accessor = Object.defineProperty({}, 'sessionId', { get() { sessionReads++; throw new Error('private getter text') } })
  const known = Object.defineProperty({ sessionId: 'known' }, 'prompt', { get() { bodyReads++; throw new Error('private prompt text') } })
  const dispose = instrumentHapiApi(remote, core)
  try {
    for (const request of [undefined, 'known', { sessionId: 'unknown' }, { sessionId: 'known?token=private' },
      { sourceSessionId: 'known' }, Object.create({ sessionId: 'known' }), accessor]) {
      assert.equal(api.nativePlan(request), failure)
    }
    assert.ok(core.getSnapshot().entries.every(entry => entry.identity === undefined))
    assert.equal(api.nativePlan(known), failure)
    assert.deepEqual(core.getSnapshot().entries.at(-1)?.identity, { sessionId: 'known', hubId: 'known-hub' })
    assert.throws(() => api.nativeCancel(known), error => error === thrown)
    assert.equal(sessionReads, 0, 'Identity lookup must not execute request accessors')
    assert.equal(bodyReads, 0, 'Diagnostics must not inspect request bodies')
    assert.ok(!core.format().includes('private'))
  } finally { dispose() }
})

test('diagnostic identity retention is bounded without changing an in-flight snapshot', async () => {
  let rejectOld!: (error: unknown) => void, first = true
  const failure = { ok: false, error: { code: 'fixture/rejected' } }
  const api = { nativePlan(request: { sessionId: string }): unknown {
    if (request.sessionId === 'oldest' && first) { first = false; return new Promise((_resolve, reject) => { rejectOld = reject }) }
    return failure
  } }
  const remote = api as unknown as HapiRemoteApi, core = new DiagnosticsCore()
  setDiagnosticIdentity(remote, { sessionId: 'oldest', hubId: 'old-hub' })
  const dispose = instrumentHapiApi(remote, core)
  try {
    const oldCall = api.nativePlan({ sessionId: 'oldest' }) as Promise<unknown>
    for (let index = 0; index < DIAGNOSTICS_LIMIT; index++) setDiagnosticIdentity(remote, { sessionId: `session-${index}`, hubId: 'new-hub' })
    assert.equal(api.nativePlan({ sessionId: 'oldest' }), failure)
    assert.equal(core.getSnapshot().entries.at(-1)?.identity, undefined, 'An evicted session cannot borrow another identity')
    api.nativePlan({ sessionId: `session-${DIAGNOSTICS_LIMIT - 1}` })
    assert.equal(core.getSnapshot().entries.at(-1)?.identity?.sessionId, `session-${DIAGNOSTICS_LIMIT - 1}`)
    const late = Object.assign(new Error('late original failure'), { code: 'fixture/late' })
    const rejected = assert.rejects(oldCall, error => error === late)
    rejectOld(late); await rejected
    assert.deepEqual(core.getSnapshot().entries.at(-1)?.identity, { sessionId: 'oldest', hubId: 'old-hub' })
  } finally { dispose() }
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
