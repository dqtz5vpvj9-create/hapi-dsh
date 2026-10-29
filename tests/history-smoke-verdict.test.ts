import test from 'node:test'
import assert from 'node:assert/strict'
import { assessOlderPage, assessCommittedPages, assessPageLimits, assessReading, olderCursor, requestPolicy, streamPolicy, sourceTarget, isTargetHistoryRpc } from '../scripts/test-history-smoke.mjs'

test('history release verdict requires real source progress, committed pages and observable return reading', () => {
  const request = { beforeAt: 300, beforeSeq: 30 }
  const response = before => ({ result: { ok: true, value: { frames: [{ key: 'source-row' }], before } } })
  assert.equal(assessOlderPage(request, response({ at: 200, seq: 20 }), undefined), null)
  assert.equal(assessOlderPage(request, response({ at: 300, seq: 30 }), undefined), 'cursor-did-not-advance')
  assert.equal(assessOlderPage(request, response({ at: 200, seq: 20 }), { at: 200, seq: 20 }), 'cursor-repeated-or-reversed')
  assert.equal(assessOlderPage(request, { result: { ok: false } }, undefined), 'empty-or-failed-page')
  assert.equal(assessOlderPage(request, { result: { ok: true, value: { frames: [], before: { at: 200, seq: 20 } } } }, undefined), 'empty-or-failed-page')
  assert.equal(olderCursor({ at: 300, seq: 30 }, { at: 300, seq: 29 }), true)
  assert.equal(olderCursor({ at: 300, seq: 30 }, { at: 301, seq: 1 }), false)
  const pages = [{ error: null }, { error: null }, { error: null }]
  const checks = pages.map(() => ({ retained: true, rawDrift: 120, readerDelta: 120, drift: 0, ambiguous: false }))
  // Three committed pages may follow one gesture. Reader movement is diagnostic,
  // while an uncompensated jump, lost anchor or ambiguous mixed frame still fails.
  assert.equal(assessCommittedPages(pages, checks, { requested: 3, committed: 3 }), null)
  assert.equal(assessCommittedPages([...pages, { error: null }], checks, { requested: 3, committed: 3 }), null,
    'a completed prefetched page is not mistaken for an uncommitted reader page')
  assert.equal(assessCommittedPages(pages, checks.slice(1), { committed: 2 }), 'page-not-committed')
  assert.equal(assessCommittedPages(pages.slice(1), checks, { committed: 3 }), 'insufficient-real-pages')
  assert.equal(assessCommittedPages(pages, [{ ...checks[0], drift: 120 }, ...checks.slice(1)], {}), 'page-reading-anchor-jumped')
  assert.equal(assessCommittedPages(pages, [{ ...checks[0], ambiguous: true }, ...checks.slice(1)], {}), 'page-anchor-sample-overlapped-input')
  assert.equal(assessCommittedPages(pages, [{ ...checks[0], retained: false }, ...checks.slice(1)], {}), 'page-reading-anchor-lost')
  assert.equal(assessCommittedPages(pages, checks, { failed: 1, committed: 3 }), 'seamless-page-failed')
  assert.equal(assessPageLimits([{ limit: 20 }, { limit: 50 }]), null)
  assert.equal(assessPageLimits([{ limit: 200 }]), 'source-page-limit-exceeded')
  assert.equal(assessPageLimits([{ limit: undefined }]), 'source-page-limit-exceeded')
  const reading = { retained: true, sameOrder: true, returned: true, up: 360, down: 540,
    reverse: 0, jumpRatio: .3, maxFrameGapMs: 67, frameOver50ms: 1,
    blankFrames: 0, unpairedFrames: 0, duplicateReads: 0, roundTrip: 180 }
  assert.equal(assessReading(reading), null, 'unequal touch distances can revisit the same reading point')
  assert.equal(assessReading({ ...reading, returned: false }), 'read-anchor-not-revisited')
  assert.equal(assessReading({ ...reading, sameOrder: false }), 'read-window-changed')
  assert.equal(assessReading({ ...reading, reverse: 49 }), 'reading-jump-or-blank')
  assert.equal(assessReading({ ...reading, jumpRatio: .71 }), 'reading-jump-or-blank')
  assert.equal(assessReading({ ...reading, unpairedFrames: 1 }), 'reading-motion-unobservable')
  assert.equal(assessReading({ ...reading, maxFrameGapMs: 81 }), 'reading-frame-hitch')
  assert.equal(assessReading({ ...reading, duplicateReads: 1 }), 'loaded-range-read-again')
})

test('release probe blocks execution and unknown writes while preserving genuine read RPC', () => {
  for (const method of ['session/prompt', 'session/cancel', 'session/control', 'session/updateQueue',
    'hapi/nativeAnswer', 'hapi/nativeCancel', 'hapi/sourceOperation', 'hapi/sourceQueuedEdit',
    'hapi/nativeApplySetting', 'session/initializeDefaultModel', 'hapi/futureMutation']) {
    assert.equal(requestPolicy(method, {}), 'block', method)
  }
  assert.equal(requestPolicy('hapi/sourceHistoryWindowPage', {}), 'read')
  assert.equal(requestPolicy('hapi/sourceHistoryOutlinePage', {}), 'read')
  assert.equal(requestPolicy('hapi/workspacePut', {}), 'isolate-workspace')
  assert.equal(requestPolicy('hapi/sourceReadStateWrite', {}), 'isolate-read-state')
  for (const method of ['credentials/describe', 'dynamicCordisRunner/inventory', 'cotTranslation/limits', 'hapi/sourceAdministration']) {
    assert.equal(requestPolicy(method, {}), 'read')
  }
  assert.equal(requestPolicy('dynamicCordisRunner/syncInspectManifest', { payload: { args: { providers: [] } } }), 'isolate-inspect-manifest')
  assert.equal(requestPolicy('dynamicCordisRunner/syncInspectManifest', { payload: { args: { providers: [], execute: true } } }), 'block')
  assert.equal(requestPolicy('dynamicCordisRunner/syncInspectManifest', { payload: { args: { providers: [{ id: 'sample', description: 'read', methods: [], execute: true }] } } }), 'block')
  assert.equal(streamPolicy('/hapi-dsh/remote.mux', { type: 'open', endpoint: 'workspace/follow' }), 'read')
  assert.equal(streamPolicy('/hapi-dsh/remote.mux', { type: 'open', endpoint: 'session/control' }), 'read')
  assert.equal(streamPolicy('/hapi-dsh/remote.mux', { type: 'item', streamId: 'control', value: { action: 'cancel' } }), 'block')
  assert.equal(streamPolicy('/hapi-dsh/notifications', { type: 'presence', visibility: 'visible' }), 'isolate-presence')
  assert.equal(streamPolicy('/hapi-dsh/notifications', { type: 'presence', visibility: 'hidden', operation: 'cancel' }), 'block')
  assert.equal(streamPolicy('/hapi-dsh/remote.mux', { type: 'presence', visibility: 'visible' }), 'block')
  assert.equal(streamPolicy('/hapi-dsh/notifications', { type: 'approval', answer: 'yes' }), 'block')
  assert.equal(requestPolicy('session/create', { payload: { args: { request: {} } } }), 'block')
  assert.equal(requestPolicy('hapi/sourceSummarySettings', {}), 'read')
  assert.equal(isTargetHistoryRpc('hapi/sourceHistoryWindowPage', { request: { sessionId: 'target' } }, 'target'), true)
  assert.equal(isTargetHistoryRpc('session/follow', { request: { address: { sessionId: 'target' } } }, 'target'), true)
  assert.equal(isTargetHistoryRpc('hapi/sourceHistoryWindowPage', { request: { sessionId: 'other' } }, 'target'), false)
  assert.equal(isTargetHistoryRpc('account/getProfile', {}, 'target'), false)
})

test('display admission permits only resolve and view lease shapes, never source operations', () => {
  const body = request => ({ payload: { args: { request } } })
  const identity = { hubId: 'test-hub', sourceSessionId: 'test-source' }
  assert.equal(requestPolicy('hapi/sourceSessionResolve', body(identity)), 'display-lease')
  assert.equal(requestPolicy('hapi/sourceSessionResolve', body({ ...identity, prompt: 'do not send' })), 'block')
  assert.equal(requestPolicy('hapi/sourceDisplayLease', body({ ...identity, leaseId: 'view', action: 'acquire' })), 'display-lease')
  assert.equal(requestPolicy('hapi/sourceDisplayLease', body({ ...identity, leaseId: 'view', action: 'cancel' })), 'block')
  const catalog = { hubId: 'test-hub', sessions: [{ title: 'Target', hapiSessionId: 'test-source' }],
    sourceDiscovery: { sessions: [{ title: 'Target', ...identity }] } }
  assert.deepEqual(sourceTarget(catalog, 'Target'), identity)
  assert.throws(() => sourceTarget(catalog, 'Missing'), /target-title-missing/)
  const duplicate = { ...catalog, sessions: [...catalog.sessions, { title: 'Target', hapiSessionId: 'another-source' }] }
  assert.throws(() => sourceTarget(duplicate, 'Target'), /target-title-ambiguous/)
  assert.deepEqual(sourceTarget(duplicate, 'Target', 1), { hubId: 'test-hub', sourceSessionId: 'another-source' })
  assert.throws(() => sourceTarget(duplicate, 'Target', 2), /target-occurrence-out-of-range/)
})
