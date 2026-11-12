/** Production task controller/operation owner; native RPC and source state are explicit fixtures. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { CodexCall, CodexCallResult } from '../src/remote/codex-access.ts'
import type { SourceSession } from '../src/remote/protocol.ts'
import type { RemoteSourceSession } from '../src/client/remote-sessions.ts'
import { NativeActionOwner } from '../src/client/remote-native-actions.ts'
import { SourceDirectory } from '../src/client/source-capabilities.ts'
import { RemoteNativeTasks, remoteNativeTasks } from '../src/client/remote-native-task-state.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'
const metadata = { id: 'hhpi:machine:source:codex:thread', sourceId: 'source', nativeId: 'thread', engine: 'codex', status: 'idle', codex: { model: 'fixture' } } as SourceSession
const row = (id: string) => ({ id, clientUserMessageId: `client-${id}`, input: [{ type: 'text', text: 'Original', text_elements: [] }, { type: 'skill', name: 'review', path: '/skills/SKILL.md' }, { type: 'localImage', path: '/native/exact.png' }] })
function fixture(t: TestContext) {
  let rows = [row('first'), row('second')], goal: unknown = { threadId: 'thread', objective: 'Current goal', status: 'active', tokenBudget: 100, tokensUsed: 5, timeUsedSeconds: 2 }
  const reads: CodexCall[] = [], writes: CodexCall[] = [], receipts: CodexCall[] = []
  let write: (request: CodexCall) => Promise<CodexCallResult> = async () => ({ status: 'accepted', message: 'source accepted' })
  const api = { async nativeCapabilities() { return { ok: true, value: { methods: Object.fromEntries(['thread/queue/list', 'thread/goal/get', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/start', 'thread/queue/reorder', 'thread/goal/set', 'thread/goal/clear'].map(method => [method, method.endsWith('/list') || method.endsWith('/get') ? 'read' : 'write'])), unavailable: {} } } },
    async nativeCall(request: CodexCall) { reads.push(request); return { ok: true, value: { status: 'accepted', result: request.method === 'thread/queue/list' ? { data: rows, nextCursor: null } : { goal } } } } } as unknown as HhpiRemoteApi
  const storage = new BrowserStorage(), directory = new SourceDirectory(api, 'source')
  const actions = new NativeActionOwner({ async call(request) { writes.push(request); return write(request) }, async receipt(request) { receipts.push(request); return { status: 'accepted', message: 'original receipt' } } })
  actions.setStorage({ storage, scope: 'tasks' })
  const session = { sessionId: metadata.id, metadata: { getSnapshot: () => metadata, subscribe: () => () => {} }, nativeActions: actions, sourceDirectory: () => directory } as unknown as RemoteSourceSession
  const controller = new RemoteNativeTasks(session, api)
  t.after(() => { actions.dispose(); directory.dispose() })
  return { controller, actions, session, api, reads, writes, receipts, storage, change: (next: typeof rows) => { rows = next }, setGoal: (next: unknown) => { goal = next }, onWrite: (next: typeof write) => { write = next } }
}

test('task refresh reads native queue and Goal without writing or replaying a restored action', async t => {
  const f = fixture(t)
  await f.controller.refresh()
  assert.deepEqual(f.controller.getSnapshot().queue?.map(row => row.id), ['first', 'second'])
  assert.deepEqual(f.controller.getSnapshot().goal, { objective: 'Current goal', status: 'active', tokenBudget: 100, tokensUsed: 5, timeUsedSeconds: 2 })
  assert.equal(f.writes.length, 0); assert.equal(f.receipts.length, 0)
  assert.ok(f.reads.every(request => request.params?.threadId === 'thread' && request.sourceId === 'source'))
  assert.equal(remoteNativeTasks(f.session, f.api), remoteNativeTasks({ ...f.session } as RemoteSourceSession, f.api), 'Pane faces share the canonical metadata store and task controller')
})

test('queue edits preserve structured inputs and images while updating only the exact native item', async t => {
  const f = fixture(t); await f.controller.refresh()
  const original = f.controller.getSnapshot().queue![0]!
  const outcome = await f.controller.edit(original, ['Changed'])
  assert.equal(outcome.phase, 'accepted')
  assert.deepEqual(f.writes[0]?.params, { threadId: 'thread', queuedSubmissionId: 'first', input: [
    { type: 'text', text: 'Changed', text_elements: [] }, { type: 'skill', name: 'review', path: '/skills/SKILL.md' }, { type: 'localImage', path: '/native/exact.png' },
  ] })
  assert.equal(f.writes[0]?.method, 'thread/queue/update')
})

test('a queue item that started during editing is never restored or added again', async t => {
  const f = fixture(t); await f.controller.refresh()
  const original = f.controller.getSnapshot().queue![0]!
  f.change([])
  await assert.rejects(f.controller.edit(original, ['Keep my edit']), /started or left/)
  assert.equal(f.writes.length, 0)
  f.change([row('first')])
  f.onWrite(async () => { f.change([]); return { status: 'rejected', message: 'Native queue item was already consumed' } })
  const rejected = await f.controller.edit(original, ['Keep my edit'])
  assert.equal(rejected.phase, 'rejected'); assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0]?.method, 'thread/queue/update'); assert.deepEqual(f.controller.getSnapshot().queue, [])
})

test('unknown queue cancellation restores one original receipt across controllers and never resends it', async t => {
  const f = fixture(t); f.onWrite(async () => { throw new Error('lost native acknowledgement') })
  const pending = await f.controller.remove('first')
  assert.equal(pending.phase, 'confirming')
  const remount = new RemoteNativeTasks(f.session, f.api)
  f.change([]); await remount.refresh()
  assert.equal(f.writes.length, 1); assert.equal(f.receipts.length, 0)
  await remount.check('queue:first')
  assert.deepEqual(f.receipts, f.writes); assert.equal(f.writes.length, 1)
})

test('queue order and start preserve exact native queue IDs', async t => {
  const f = fixture(t); await f.controller.refresh()
  await f.controller.move('second', -1)
  assert.deepEqual(f.writes[0]?.params, { threadId: 'thread', queuedSubmissionIds: ['second', 'first'] })
  await f.controller.start('second')
  assert.deepEqual(f.writes[1]?.params, { threadId: 'thread', queuedSubmissionId: 'second' })
})

test('Goal changes carry explicit user provenance, real native status and token budget without a synthetic prompt', async t => {
  const f = fixture(t); await f.controller.refresh()
  await f.controller.setGoal('Explicit objective', 250, 'paused')
  assert.deepEqual(f.writes[0]?.params, { threadId: 'thread', objective: 'Explicit objective', tokenBudget: 250, status: 'paused', origin: 'user' })
  await f.controller.clearGoal()
  assert.deepEqual(f.writes[1]?.params, { threadId: 'thread', origin: 'user' })
  assert.deepEqual(f.writes.map(request => request.method), ['thread/goal/set', 'thread/goal/clear'])
  assert.throws(() => f.controller.setGoal('Bad budget', -1), /positive/)
})

test('account replacement invalidates old task controllers and their subsequent source writes', async t => {
  const f = fixture(t); await f.controller.refresh()
  f.actions.setStorage({ storage: f.storage, scope: 'another-account' })
  assert.equal(f.controller.current(), false)
  await assert.rejects(f.controller.remove('first'), /scope changed/)
  const next = remoteNativeTasks(f.session, f.api)
  assert.notEqual(next, f.controller); assert.equal(next?.getSnapshot().queue, undefined)
  assert.equal(f.writes.length, 0)
})

test('an account change clears visible task data and releases an in-flight read without a late publication or replay', async t => {
  const f = fixture(t); await f.controller.refresh()
  let begin!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  f.api.nativeCall = async () => { begin(); await held; return { ok: true, value: { status: 'accepted', message: 'late previous account', result: { data: [row('private-old-item')], nextCursor: null } } } }
  const pending = f.controller.refresh(); await started
  try {
    f.actions.setStorage({ storage: f.storage, scope: 'another-account' })
    assert.equal(f.controller.getSnapshot().queue, undefined, 'an open old-account task panel must immediately drop its rows')
    assert.equal(f.controller.getSnapshot().goal, undefined)
    assert.equal(f.controller.getSnapshot().loading, false)
    await pending
    await assert.doesNotReject(f.controller.refresh())
  } finally { release(); await pending }
  assert.equal(f.controller.getSnapshot().queue, undefined)
  assert.equal(f.writes.length, 0); assert.equal(f.receipts.length, 0)
})
