import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourceRoute, sourceDirectoryKey, sourceFeature } from '../src/shared/source-capability.ts'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'

const identity = { machineId: 'machine-a', sourceId: 'codex', engine: 'codex', nativeId: 'thread' }
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'task', cwd: '/work', updatedAt: 1,
  status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: false, steer: false, cancel: false, approve: false, files: true } }

test('source routes keep machine and Host binding; malformed HHPI cannot become local DSH', () => {
  const a = sourceRoute('host-a', session.id, 'host-a')
  const b = sourceRoute('host-b', session.id, 'host-a')
  assert.equal(a.kind, 'hhpi')
  assert.notEqual(sourceDirectoryKey('account', 1, a), sourceDirectoryKey('account', 1, b))
  assert.notEqual(sourceDirectoryKey('account', 1, a), sourceDirectoryKey('other', 1, a))
  assert.notEqual(sourceDirectoryKey('account', 1, a), sourceDirectoryKey('account', 2, a))
  assert.throws(() => sourceRoute('host-a', 'hhpi:broken', 'host-a'))
  assert.throws(() => sourceRoute('host-a', 'hapi-codex-' + 'a'.repeat(32), 'host-a'))
  assert.equal(sourceRoute('host-a', 'native', 'host-a').kind, 'local-dsh')
  assert.equal(sourceRoute('host-b', 'native', 'host-a').kind, 'federated-dsh')
})

test('history-only send/steer flags cannot disable an independently registered settings action', () => {
  const input = { session, online: true, authorized: true, integrated: true,
    native: { protocolVersion: '0.165.0' as const, runtime: 'codex', methods: { 'thread/settings/update': 'write' as const }, unavailable: {} } }
  assert.equal(sourceFeature('settings', input).availability, 'ready')
  assert.equal(sourceFeature('send', input).availability, 'unsupported')
  assert.equal(sourceFeature('files', input).availability, 'discovering')
  assert.equal(sourceFeature('files', { ...input, registered: true, configured: false }).availability, 'unconfigured')
  assert.equal(sourceFeature('files', { ...input, registered: true, integrated: false }).availability, 'not-integrated')
})

test('offline and authorization do not erase registered capabilities or imply source support', () => {
  const input = { session, online: true, authorized: true, integrated: true, registered: true }
  const denied = sourceFeature('terminal', { ...input, authorized: false })
  assert.equal(denied.registered, true)
  assert.equal(denied.availability, 'unauthorized')
  const offline = sourceFeature('terminal', { ...input, session: { ...session, connection: { state: 'offline', observedAt: 2 } } })
  assert.equal(offline.registered, true)
  assert.equal(offline.availability, 'offline')
  assert.equal(sourceFeature('terminal', { ...input, authorized: undefined }).availability, 'discovering')
})
