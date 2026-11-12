import test from 'node:test'
import assert from 'node:assert/strict'
import { requestPolicy, streamPolicy } from '../scripts/smoke-read-policy.mjs'

test('release probe blocks execution and unknown writes while preserving genuine read RPC', () => {
  for (const method of ['session/prompt', 'session/cancel', 'session/control', 'session/updateQueue',
    'hapi/nativeAnswer', 'hapi/nativeCancel', 'hapi/sourceOperation', 'hapi/sourceQueuedEdit',
    'hapi/nativeApplySetting', 'session/initializeDefaultModel', 'hapi/futureMutation']) {
    assert.equal(requestPolicy(method, {}), 'block', method)
  }
  assert.equal(requestPolicy('hhpi/read', {}), 'read')
  assert.equal(requestPolicy('sourceAliases/resolve', {}), 'read')
  const position = { payload: { args: { request: { sessionId: 'hhpi:machine:source:codex:native', position: { turnId: 'turn', itemId: 'item' } } } } }
  assert.equal(requestPolicy('sourceNavigation/locatePosition', position), 'read')
  assert.equal(requestPolicy('sourceNavigation/locatePosition', {}), 'block')
  assert.equal(requestPolicy('sourceNavigation/locatePosition', { payload: { args: { request: { ...position.payload.args.request, execute: true } } } }), 'block')

  assert.equal(requestPolicy('hapi/workspacePut', {}), 'isolate-workspace')
  assert.equal(requestPolicy('hapi/sourceReadStateWrite', {}), 'block')
  for (const method of ['credentials/describe', 'dynamicCordisRunner/inventory', 'cotTranslation/limits']) {
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
})


test('retired HAPI display and source routes cannot reach a live source through acceptance probes', () => {
  const body = { payload: { args: { request: { hubId: 'old-hub', sourceSessionId: 'old-source', leaseId: 'view', action: 'acquire' } } } }
  for (const method of ['hapi/sourceSessionResolve', 'hapi/sourceDisplayLease', 'hapi/sourceHistoryWindowPage',
    'hapi/sourceHistoryOutlinePage', 'hapi/sourceReadStateWrite', 'hapi/sourceSummarySettings', 'hapi/sourceAdministration']) {
    assert.equal(requestPolicy(method, body), 'block', method)
  }
  assert.equal(streamPolicy('/hapi-dsh/remote.mux', { type: 'open', endpoint: 'hapi/sourceWindow' }), 'block')
  assert.equal(streamPolicy('/hapi-dsh/remote.mux', { type: 'open', endpoint: 'hhpi/changes' }), 'read')
  assert.equal(requestPolicy('hhpi/resolve', {}), 'read')
  assert.equal(requestPolicy('hapi/catalog', {}), 'read')
})
