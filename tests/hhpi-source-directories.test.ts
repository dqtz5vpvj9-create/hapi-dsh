import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceDirectories } from '../src/client/source-capabilities.ts'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'

function session(nativeId: string): SourceSession {
  const id = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId }
  return { ...id, id: sourceSessionId(id), title: '', cwd: '', updatedAt: 0, status: 'idle', activeTurnId: null, pendingRequests: [],
    capabilities: { send: false, steer: false, cancel: false, approve: false, files: false } }
}
test('two Pane menus share directory work; cancelling one does not cancel the other', async () => {
  let calls = 0, capabilityCalls = 0
  let finish!: (value: Awaited<ReturnType<NonNullable<HhpiRemoteApi['nativeCall']>>>) => void
  const api: Pick<HhpiRemoteApi, 'nativeCall' | 'nativeCapabilities'> = {
    nativeCapabilities: async () => { capabilityCalls++; return { ok: true, value: { protocolVersion: '0.165.0', runtime: 'codex', methods: { 'model/list': 'read' }, unavailable: {} } } },
    nativeCall: async request => { assert.equal(request.operationId, undefined); calls++; return new Promise(resolve => { finish = resolve }) },
  }
  const directories = new SourceDirectories(api, 'host', 'account', 1)
  const a = directories.forSession(session('a')), b = directories.forSession(session('b'))
  assert.equal(a, b)
  const abort = new AbortController()
  const left = a.read('model/list', {}, abort.signal), right = b.read('model/list')
  abort.abort()
  await assert.rejects(left, { name: 'AbortError' })
  finish({ ok: true, value: { status: 'accepted', message: '', result: { data: ['model'] } } })
  assert.deepEqual(await right, { data: ['model'] })
  assert.equal(calls, 1); assert.equal(capabilityCalls, 1)
  await assert.rejects(a.read('thread/resume'), /not a source directory/)
  directories.dispose()
})

test('late directory replies from a replaced account cannot populate the new generation', async () => {
  let finish!: (value: Awaited<ReturnType<NonNullable<HhpiRemoteApi['nativeCapabilities']>>>) => void
  const api: Pick<HhpiRemoteApi, 'nativeCapabilities'> = { nativeCapabilities: () => new Promise(resolve => { finish = resolve }) }
  const directories = new SourceDirectories(api, 'host', 'old-account', 1)
  const old = directories.forSession(session('a')), read = old.capabilities()
  directories.reset('new-account', 2)
  finish({ ok: true, value: { protocolVersion: '0.165.0', runtime: 'old', methods: {}, unavailable: {} } })
  await assert.rejects(read, { name: 'AbortError' })
  assert.notEqual(directories.forSession(session('a')), old)
  directories.dispose()
})
