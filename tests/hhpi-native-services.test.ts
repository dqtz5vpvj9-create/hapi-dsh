import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteNativeServices } from '../src/client/remote-native-services-state.ts'
import { nativeServicesFixture, mcpServer } from './fixtures/native-services.ts'

test('connection and background pages read the exact original source and retain real empty state without native writes', async t => {
  const f = nativeServicesFixture(), controller = new RemoteNativeServices(f.session, f.api, f.captureAccess)
  t.after(() => { controller.dispose(); f.close() })
  await controller.refresh()
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(call => call.sourceId === 'original-source' && call.params?.threadId === 'original-thread' && call.operationId === undefined))
  assert.equal(f.calls.find(call => call.method === 'mcpServerStatus/list')?.params?.detail, 'toolsAndAuthOnly')
  assert.deepEqual(controller.getSnapshot().background, { rows: [], loaded: true, loading: false, nextCursor: null, issue: null })
  assert.equal(controller.getSnapshot().mcp.rows[0]?.runtimeStatus, 'connected')
  assert.equal(controller.getSnapshot().mcp.rows[0]?.authStatus, 'bearerToken')
  assert.equal(f.writes.length, 0)
})

test('method registration does not turn an actual native method-not-found into an accepted empty result; healthy section survives', async t => {
  const f = nativeServicesFixture(), controller = new RemoteNativeServices(f.session, f.api, f.captureAccess)
  t.after(() => { controller.dispose(); f.close() })
  f.onRead(async request => request.method === 'mcpServerStatus/list'
    ? { status: 'rejected', message: 'Unknown method', error: { code: -32601, message: 'Unknown method' } }
    : { status: 'accepted', message: 'Read', result: { data: [], nextCursor: null } })
  await controller.refresh()
  assert.equal(controller.getSnapshot().mcp.issue, 'unsupported')
  assert.equal(controller.getSnapshot().mcp.loaded, false)
  assert.equal(controller.getSnapshot().background.loaded, true)
  f.onRead(async () => ({ status: 'accepted', message: 'Read', result: { data: [mcpServer()], nextCursor: null } }))
  await controller.read('mcp'); assert.equal(controller.getSnapshot().mcp.issue, null)
})

test('pagination is explicit, retains source cursors, and rejects a repeated cursor without draining the source', async t => {
  const f = nativeServicesFixture(), controller = new RemoteNativeServices(f.session, f.api, f.captureAccess)
  t.after(() => { controller.dispose(); f.close() })
  f.onRead(async request => ({ status: 'accepted', message: 'Read', result: { data: [mcpServer(request.params?.cursor ? 'Second service' : 'First service')], nextCursor: 'opaque-source-cursor' } }))
  await controller.read('mcp')
  assert.equal(f.calls.length, 1); assert.equal(controller.getSnapshot().mcp.nextCursor, 'opaque-source-cursor')
  await controller.read('mcp', true)
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]?.params?.cursor, 'opaque-source-cursor')
  assert.equal(controller.getSnapshot().mcp.issue, 'invalid')
  assert.deepEqual(controller.getSnapshot().mcp.rows.map(row => row.name), ['First service'])
  assert.equal(f.writes.length, 0)
})

test('account replacement clears the page and rejects a delayed source response', async t => {
  const f = nativeServicesFixture(), controller = new RemoteNativeServices(f.session, f.api, f.captureAccess)
  const delayed = Promise.withResolvers<Awaited<ReturnType<NonNullable<typeof f.api.nativeCall>>>>()
  let signal: AbortSignal | undefined
  t.after(() => { controller.dispose(); f.close() })
  await controller.read('mcp')
  f.api.nativeCall = async (_request, requestSignal) => { signal = requestSignal; return delayed.promise }
  const reading = controller.read('background')
  for (let i = 0; i < 10; i++) await Promise.resolve()
  f.application.set({ accountId: 'another-account', origin: 'https://fixture.invalid' }, 'device')
  assert.equal(signal?.aborted, true)
  assert.equal(controller.getSnapshot().current, false); assert.deepEqual(controller.getSnapshot().mcp.rows, [])
  delayed.resolve({ ok: true, value: { status: 'accepted', message: 'late', result: { data: [], nextCursor: null } } })
  await reading; assert.equal(controller.getSnapshot().background.loaded, false); assert.equal(f.writes.length, 0)
})

test('offline does no source IO and explicit refresh after reconnect recovers without replaying actions', async t => {
  const f = nativeServicesFixture(), controller = new RemoteNativeServices(f.session, f.api, f.captureAccess)
  t.after(() => { controller.dispose(); f.close() })
  f.offline(); await controller.refresh()
  assert.equal(f.calls.length, 0); assert.equal(controller.getSnapshot().mcp.issue, 'offline')
  f.online(); await controller.refresh()
  assert.equal(controller.getSnapshot().mcp.issue, null); assert.equal(controller.getSnapshot().background.loaded, true)
  assert.equal(f.calls.length, 2); assert.equal(f.writes.length, 0)
})
