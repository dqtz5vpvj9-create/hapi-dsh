/** Browser transport fixtures; all writes remain explicit original-owner requests. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceDshChildController, type SourceDshChildStorage } from '../src/client/source-dsh-child-state.ts'
import { SourceDshChildCommand, type SourceChildCommandRequest } from '../src/client/source-dsh-child-command.ts'
import type { SourceDshChildInterrupt, SourceDshChildState } from '../src/hapi-agent/dsh-child-types.ts'

function sourceState(): SourceDshChildState {
  return { sessionId: 'display-child', logicalSessionId: 'logical-child', parentSessionId: 'display-parent',
    hubId: 'fixture-hub', sourceSessionId: 'hapi-parent', parentDshSessionId: 'dsh-parent', childDshSessionId: 'dsh-child', machineId: 'runner-one',
    descriptor: { sessionId: 'dsh-child', name: 'Original child', mode: 'continuable', activity: 'running', createdAt: 100 },
    readOnly: false, unavailableReason: null, history: { epoch: 'child-epoch', after: 2, loaded: 2, complete: true, truncated: false, lastReadAt: 200, error: null }, receipts: [] }
}
class Api {
  state = sourceState()
  writes: SourceDshChildInterrupt[] = []
  reads = 0
  failReply = false
  failRead = false
  accepted = false
  async sourceDshChild() { this.reads++; if (this.failRead) throw new Error('Source read unavailable'); return { ok: true as const, value: structuredClone(this.state) } }
  async sourceDshChildRefresh() { return this.sourceDshChild() }
  async sourceDshChildInterrupt(input: SourceDshChildInterrupt) {
    this.writes.push(structuredClone(input))
    this.state.receipts.push({ operationId: input.operationId, kind: 'interrupt', requestId: null, displayMessageId: null, text: null,
      delivery: null, status: this.accepted ? 'accepted' : 'unknown', sourceMessageId: null, createdAt: 300, updatedAt: 300,
      error: this.accepted ? null : 'The original source reply was lost' })
    if (this.failReply) throw new Error('Browser lost the host acknowledgement')
    return { ok: true as const, value: structuredClone(this.state) }
  }
}
function storage(): SourceDshChildStorage {
  const entries = new Map<string, string>()
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value) }, removeItem: key => { entries.delete(key) } }
}

test('visible child command admits one durable intent and a lost browser reply recovers only by exact command correlation', async () => {
  const api = new Api(), saved = storage(), calls: SourceChildCommandRequest[] = []
  const command = new SourceDshChildCommand('display-child', api, async input => {
    calls.push(input)
    api.state.receipts.push({ operationId: 'source-prompt-operation', kind: 'prompt', requestId: 'original-source-request',
      clientRequestId: input.requestId, displayMessageId: 'local-admitted-message', text: input.text, delivery: input.delivery,
      status: 'unknown', sourceMessageId: null, createdAt: 300, updatedAt: 300, error: 'Source acknowledgement lost' })
    throw new Error('Browser acknowledgement lost')
  }, saved, () => '11111111-1111-4111-8111-111111111111')
  command.observe(api.state)
  assert.equal((await command.submit('Original child task', 'queue')).kind, 'success')
  assert.equal(calls.length, 1); assert.match(calls[0]!.requestId, /^hapi-source-child:/)
  assert.equal(command.getSnapshot().pending, null)
  assert.equal(api.state.receipts[0]!.status, 'unknown', 'Local command settlement is not a source acknowledgement or invocation')
})

test('unknown child command survives a reload and Send only reads instead of creating another request or execution', async () => {
  const api = new Api(), saved = storage(), writes: SourceChildCommandRequest[] = []
  const submit = async (input: SourceChildCommandRequest): Promise<never> => { writes.push(input); throw new Error('No browser or source receipt') }
  let command = new SourceDshChildCommand('display-child', api, submit, saved, () => '22222222-2222-4222-8222-222222222222')
  command.observe(api.state); assert.equal((await command.submit('Uncertain original task', 'steer')).kind, 'error')
  assert.equal(command.getSnapshot().pending?.status, 'unknown')
  command = new SourceDshChildCommand('display-child', api, submit, saved)
  command.observe(api.state)
  assert.equal((await command.submit('Uncertain original task', 'steer')).kind, 'error')
  assert.equal((await command.submit('A different new task', 'queue')).kind, 'error')
  assert.equal(writes.length, 1)
  assert.throws(() => command.observe({ ...api.state, machineId: 'different-runner' }), /owner changed/)
  command.closeWaiting(); assert.equal(command.getSnapshot().pending, null)
  assert.equal(writes.length, 1, 'Closing waiting is not cancellation or resubmission')
})

test('child command requires writable source and durable browser identity before any prompt', async () => {
  const api = new Api(); let writes = 0
  const send = async () => { writes++; return { ok: true as const, messageId: 'accepted' } }
  const unavailable = new SourceDshChildCommand('display-child', api, send, undefined)
  unavailable.observe(api.state); assert.equal((await unavailable.submit('Retained draft', 'queue')).kind, 'error'); assert.equal(writes, 0)
  const sourceReadonly = new SourceDshChildCommand('display-child', api, send, storage())
  sourceReadonly.observe({ ...api.state, readOnly: true }); assert.equal((await sourceReadonly.submit('Retained draft', 'queue')).kind, 'error'); assert.equal(writes, 0)
  const broken = new SourceDshChildCommand('display-child', api, send, { ...storage(), getItem: () => '{invalid' })
  broken.observe(api.state); assert.equal((await broken.submit('Retained draft', 'queue')).kind, 'error'); assert.equal(writes, 0)
})

test('an uncertain child interrupt survives remount and only reads the same original operation', async () => {
  const api = new Api(), saved = storage(), initial = new SourceDshChildController(api, 'display-child', saved, () => 'stable-child-interrupt')
  await initial.refresh(); api.failReply = true; await initial.interrupt()
  assert.equal(api.writes.length, 1); assert.equal(initial.getSnapshot().pendingInterrupt, 'stable-child-interrupt')
  const recovered = new SourceDshChildController(api, 'display-child', saved)
  await recovered.refresh(); await recovered.interrupt(); await recovered.refresh(false)
  assert.equal(api.writes.length, 1); assert.equal(recovered.getSnapshot().pendingInterrupt, 'stable-child-interrupt')
  assert.equal(recovered.getSnapshot().data?.receipts[0]?.status, 'unknown')
  assert.ok(api.reads >= 3)
  recovered.closeInactiveIntent(); assert.equal(recovered.getSnapshot().pendingInterrupt, 'stable-child-interrupt')
  api.state.descriptor.activity = 'inactive'; await recovered.refresh(); recovered.closeInactiveIntent()
  assert.equal(recovered.getSnapshot().pendingInterrupt, null)
  assert.equal(recovered.getSnapshot().data?.receipts[0]?.status, 'unknown', 'Closing local waiting must not invent a source acknowledgement')
  assert.equal(api.writes.length, 1)
})

test('a lost browser acknowledgement can be recovered from the existing accepted receipt without another interrupt', async () => {
  const api = new Api(), saved = storage(); api.accepted = true; api.failReply = true
  const initial = new SourceDshChildController(api, 'display-child', saved, () => 'accepted-child-interrupt')
  await initial.refresh(); await initial.interrupt(); assert.equal(initial.getSnapshot().pendingInterrupt, 'accepted-child-interrupt')
  const recovered = new SourceDshChildController(api, 'display-child', saved)
  await recovered.refresh(); assert.equal(recovered.getSnapshot().pendingInterrupt, null)
  assert.equal(recovered.getSnapshot().data?.descriptor.activity, 'running', 'Acceptance is not a quiescence acknowledgement')
  assert.equal(api.writes.length, 1)
})

test('unreadable or unwritable recovery storage prevents a child mutation and source readonly cannot be bypassed', async () => {
  const api = new Api()
  const broken: SourceDshChildStorage = { getItem: () => '{corrupt', setItem: () => { throw new Error('Disk full') }, removeItem: () => {} }
  const unreadable = new SourceDshChildController(api, 'display-child', broken)
  await unreadable.refresh(); await unreadable.interrupt(); assert.equal(api.writes.length, 0)
  assert.match(unreadable.getSnapshot().error ?? '', /recovery record/)
  const unwritable = new SourceDshChildController(api, 'display-child', { ...broken, getItem: () => null })
  await unwritable.refresh(); await unwritable.interrupt(); assert.equal(api.writes.length, 0)
  assert.match(unwritable.getSnapshot().error ?? '', /Disk full/)
  const unavailable = new SourceDshChildController(api, 'display-child', undefined)
  await unavailable.refresh(); await unavailable.interrupt(); assert.equal(api.writes.length, 0)
  api.state.readOnly = true
  const readonly = new SourceDshChildController(api, 'display-child', storage())
  await readonly.refresh(); await readonly.interrupt(); assert.equal(api.writes.length, 0)
})

test('a child identity cannot be silently retargeted across parent, machine or source creation changes', async () => {
  for (const change of [
    (value: SourceDshChildState) => { value.machineId = 'runner-two' },
    (value: SourceDshChildState) => { value.parentDshSessionId = 'different-parent' },
    (value: SourceDshChildState) => { value.descriptor.createdAt++ },
    (value: SourceDshChildState) => { value.sessionId = 'display-next-generation' },
  ]) {
    const api = new Api(), controller = new SourceDshChildController(api, 'display-child', storage())
    await controller.refresh(); change(api.state)
    await controller.refresh()
    assert.match(controller.getSnapshot().error ?? '', /owner changed|different display generation/)
    assert.equal(controller.getSnapshot().data?.machineId, 'runner-one')
    assert.equal(api.writes.length, 0)
  }
})
