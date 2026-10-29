/** Real HHPI Session face and history owner; only the remote wire is a fixture.
 * Public DSH event/scope code is imported through the same thin boundary as the
 * existing provider contracts. No renderer, execution engine or UI is faked. */
import assert from 'node:assert/strict'
import { before, test, type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import type { BeginSubmissionInput, PendingSubmissionRetirement } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { RemoteSourceSession } from '../src/client/remote-sessions.ts'
import { RemoteSourceHistory } from '../src/client/remote-history.ts'
import { sourceSessionId, type SourceOperation, type SourcePage, type SourceReceipt, type SourceSession } from '../src/remote/protocol.ts'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..')
let Session: typeof RemoteSourceSession
before(async () => {
  const output = await build({ entryPoints: [resolve(root, 'src/client/remote-sessions.ts')],
    alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
    external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} as { RemoteSourceSession?: typeof RemoteSourceSession } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
  assert.ok(module.exports.RemoteSourceSession)
  Session = module.exports.RemoteSourceSession
})
function metadata(): SourceSession {
  const identity = { machineId: 'test-machine', sourceId: 'test-source', engine: 'codex', nativeId: 'test-thread' }
  return { ...identity, id: sourceSessionId(identity), title: 'Synthetic source', cwd: '/synthetic', updatedAt: 1,
    status: 'running', activeTurnId: 'native-turn', capabilities: { send: true, steer: true, cancel: true, approve: true, files: false }, pendingRequests: [] }
}
function accepted(operation: SourceOperation): SourceReceipt {
  return { operationId: operation.operationId, sessionId: operation.sessionId, status: 'accepted', message: 'Native source accepted.' }
}
function fixture(t: TestContext, value = metadata(), operation: (request: SourceOperation) => Promise<SourceReceipt> = async request => accepted(request), readGate?: Promise<void>) {
  const calls: SourceOperation[] = [], retirements: PendingSubmissionRetirement[] = []
  const page: SourcePage = { session: value, epoch: 'synthetic-epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] }
  const history = new RemoteSourceHistory(value.id, {
    read: async () => { await readGate; return page },
    async *changes() { throw new Error('Opening a Session face must not create an execution or a reading view') },
  })
  const api = { operate: async (request: SourceOperation) => { calls.push(request); return { ok: true as const, value: await operation(request) } } } as HhpiRemoteApi
  const session = new Session(value.id as SessionId, value, history, api)
  t.after(() => { session.dispose(); history.dispose() })
  function submit(mode: BeginSubmissionInput['mode'] = 'queue') {
    return session.beginSubmission({ mode, text: 'Keep this draft', attachments: [], onRetire: value => { retirements.push(value) } })
  }
  return { session, calls, retirements, submit }
}
const content = [{ type: 'text' as const, text: 'Keep this draft' }]

test('unsupported Steer clears pending echo and retires the draft as failed without sending', async t => {
  const value = metadata(); value.capabilities.steer = false
  const { session, calls, retirements, submit } = fixture(t, value)
  await session.ready
  const pending = submit('steer')
  const outcome = await session.prompt(content, 'steer', undefined, pending.requestId)
  assert.equal(outcome.ok, false)
  assert.equal(calls.length, 0)
  assert.equal(session.getSnapshot().pendingSubmissions.length, 0, 'unsupported capability must retire its optimistic submission')
  assert.deepEqual(retirements.map(item => item.reason), ['failed'])
  assert.ok(session.getSnapshot().promptError)
})

test('Steer without a native turn is rejected locally and preserves draft retirement', async t => {
  const value = metadata(); value.activeTurnId = null
  const { session, calls, retirements, submit } = fixture(t, value)
  await session.ready
  const pending = submit('steer')
  assert.equal((await session.prompt(content, 'steer', undefined, pending.requestId)).ok, false)
  assert.equal(calls.length, 0, 'a missing native turn must not become an unscoped steer')
  assert.deepEqual(retirements.map(item => item.reason), ['failed'])
})

test('a pre-cancelled submission retires pending state without a source operation', async t => {
  const { session, calls, retirements, submit } = fixture(t)
  await session.ready
  const pending = submit(), abort = new AbortController(); abort.abort()
  await assert.rejects(session.prompt(content, 'queue', abort.signal, pending.requestId), { name: 'AbortError' })
  assert.equal(calls.length, 0)
  assert.equal(session.getSnapshot().pendingSubmissions.length, 0, 'cancelled input must not remain stuck in the composer')
  assert.deepEqual(retirements.map(item => item.reason), ['failed'])
})

test('a receipt for another native session cannot acknowledge this draft', async t => {
  const { session, calls, retirements, submit } = fixture(t, metadata(), async request => ({ ...accepted(request), sessionId: 'hhpi:other:source:codex:thread' }))
  await session.ready
  const pending = submit()
  const outcome = await session.prompt(content, 'queue', undefined, pending.requestId)
  assert.equal(calls.length, 1)
  assert.equal(outcome.ok, false, 'a cross-session receipt must not acknowledge the current submission')
  assert.deepEqual(retirements.map(item => item.reason), ['failed'])
  assert.ok(session.getSnapshot().promptError)
})

test('the same operation identity deduplicates equal payloads and rejects conflicting decisions', async t => {
  const gate = Promise.withResolvers<void>()
  const { session, calls } = fixture(t, metadata(), async request => { await gate.promise; return accepted(request) })
  await session.ready
  const request: SourceOperation = { sessionId: session.sessionId, operationId: 'approval:request', kind: 'approve', requestId: 'request', decision: 'accept' }
  const first = session.operate(request), duplicate = session.operate({ ...request })
  assert.equal(first, duplicate)
  const conflict = session.operate({ ...request, decision: 'decline' })
  gate.resolve()
  await assert.rejects(conflict, /different arguments|different payload/i)
  assert.equal((await first).status, 'accepted')
  assert.equal(await session.operate({ ...request }), await first)
  assert.equal(calls.length, 1)
})

test('dispatch owns an immutable copy of the operation and preserves the native turn', async t => {
  const gate = Promise.withResolvers<void>(), received: string[] = []
  const { session } = fixture(t, metadata(), async request => { await gate.promise; received.push(request.text!); return accepted(request) })
  await session.ready
  const request: SourceOperation = { sessionId: session.sessionId, operationId: 'steer-copy', kind: 'steer', text: 'original', turnId: 'native-turn' }
  const dispatched = session.operate(request)
  request.text = 'changed after dispatch'; gate.resolve()
  await dispatched
  assert.deepEqual(received, ['original'], 'caller mutation must not change an already identified source write')
})

test('uncertain writes retain the same failed promise and never automatically resend', async t => {
  const { session, calls } = fixture(t, metadata(), async () => { throw new Error('Acknowledgement lost') })
  await session.ready
  const operation: SourceOperation = { sessionId: session.sessionId, operationId: 'uncertain', kind: 'send', text: 'once' }
  const first = session.operate(operation)
  await assert.rejects(first, /Acknowledgement lost/)
  const retry = session.operate({ ...operation })
  assert.equal(retry, first)
  await assert.rejects(retry, /Acknowledgement lost/)
  assert.equal(calls.length, 1)
})

test('a released Session face cannot dispatch a new source write or reopen on late history', async t => {
  const gate = Promise.withResolvers<void>()
  const { session, calls } = fixture(t, metadata(), undefined, gate.promise)
  let notifications = 0
  const stop = session.subscribe(() => { notifications++ })
  t.after(stop)
  session.dispose(); const afterDispose = notifications
  const operation: SourceOperation = { sessionId: session.sessionId, operationId: 'late-write', kind: 'send', text: 'not sent' }
  await assert.rejects(session.operate(operation), /released|disposed/i)
  gate.resolve()
  await assert.rejects(session.ready, { name: 'AbortError' })
  assert.equal(calls.length, 0)
  assert.equal(notifications, afterDispose, 'a released source face must not publish a late open or error')
})

test('an offline source rejects new prompt submission without losing retirement state', async t => {
  const value = metadata(); value.status = 'offline'
  const { session, calls, submit, retirements } = fixture(t, value)
  await session.ready
  const pending = submit()
  assert.equal((await session.prompt(content, 'queue', undefined, pending.requestId)).ok, false)
  assert.equal(calls.length, 0)
  assert.deepEqual(retirements.map(item => item.reason), ['failed'])
})
