import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HapiApprovalAnswer, HapiCancelResult, HapiEvent, HapiMessage, HapiMessagesPage, HapiQueuedState, HapiSendMessage, HapiSession, HapiTransport } from '../src/codex/contracts.js'
import { HapiRequestError } from '../src/codex/contracts.js'
import { queuedEditCandidate } from '../src/codex/queued-edit-candidate.js'
import { queuedEditRestoreSchedule, queuedEditRestoreText } from '../src/codex/queued-edit-types.js'
import { SourceQueuedEdits, type SourceQueuedEditAgent } from '../src/hapi/queued-edit.js'

const operation = '11111111-1111-4111-8111-111111111111'
const secondOperation = '22222222-2222-4222-8222-222222222222'
const sourceSession: HapiSession = { id: 'original-session', namespace: 'fixture', seq: 1, createdAt: 1, updatedAt: 1,
  active: true, activeAt: 1, thinking: false, thinkingAt: 1, metadataVersion: 1, agentStateVersion: 1, agentState: null,
  metadata: { path: '/runner/project', flavor: 'codex', codexNativeSession: true, codexSessionId: 'original-thread', machineId: 'original-runner', codexHome: '/runner/home' } }
function queuedRow(): HapiMessage {
  return { id: 'source-row-uuid', localId: 'original-local', seq: 2, createdAt: 1000, invokedAt: null, scheduledAt: Date.now() + 60_000,
    content: { role: 'user', content: { type: 'text', text: '@"/runner/queue/file a.txt"\nOriginal text',
      attachments: [{ id: 'original-upload', filename: 'file a.txt', path: '/runner/queue/file a.txt', size: 10, mimeType: 'text/plain' }] } } }
}
/** Explicit original Hub protocol fixture, not a running native model. */
class QueueSource implements HapiTransport {
  readonly hubId = 'queued-edit-fixture'
  source = structuredClone(sourceSession)
  row = queuedRow()
  queue: HapiQueuedState = { queuedLocalIds: ['original-local'], invokedLocalMessages: [] }
  response: HapiCancelResult | Error = { status: 'cancelled', localId: 'original-local' }
  readonly cancellations: Array<{ sessionId: string; messageId: string }> = []
  readonly listeners = new Set<(event: HapiEvent) => void>()
  onCancel: (() => void | Promise<void>) | undefined
  async listSessions() { return [this.source] }
  async getSession() { return structuredClone(this.source) }
  async getQueuedState() { return structuredClone(this.queue) }
  async cancelQueuedMessage(sessionId: string, messageId: string) {
    this.cancellations.push({ sessionId, messageId }); await this.onCancel?.()
    if (this.response instanceof Error) throw this.response
    return structuredClone(this.response)
  }
  async readMessages(): Promise<HapiMessagesPage> { throw new Error('The fixture agent owns original queued row preparation') }
  async sendMessage(_id: string, _message: HapiSendMessage): Promise<void> { throw new Error('Editing must never send a replacement') }
  async steerQueuedMessage(): Promise<never> { throw new Error('Editing must not steer') }
  async retryIndeterminateMessage(): Promise<never> { throw new Error('Editing must not retry message delivery') }
  async abortSession(): Promise<void> { throw new Error('Editing must not abort') }
  async approve(_id: string, _request: string, _answer: HapiApprovalAnswer): Promise<void> { throw new Error('Editing must not approve') }
  async deny(): Promise<void> { throw new Error('Editing must not deny') }
  subscribe(listener: (event: HapiEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: HapiEvent) { for (const listener of this.listeners) listener(event) }
}
function fixture(source: QueueSource): SourceQueuedEditAgent {
  const snapshot = structuredClone(sourceSession)
  return { id: 'hapi-codex-current', logicalSessionId: 'hapi-codex-logical', sourceSession: snapshot,
    queuedEditCandidate: localId => localId === source.row.localId ? queuedEditCandidate(source.row, 'Must use original payload') : undefined,
    refresh: async () => {},
  }
}
function mount(source: QueueSource, agent: SourceQueuedEditAgent, directory: string) {
  return new SourceQueuedEdits(source, { get: id => id === agent.id ? agent : undefined }, directory)
}
const request = { sessionId: 'hapi-codex-current', operationId: operation, localId: 'original-local' }

test('queue restoration retains original attachment references and absolute schedule, and rejects dispatching or invoked rows', () => {
  const row = queuedRow(), candidate = queuedEditCandidate(row, 'Short display preview')!
  assert.ok(candidate); assert.equal(candidate.text, '@"/runner/queue/file a.txt"\nOriginal text')
  assert.deepEqual(candidate.attachmentNames, ['file a.txt']); assert.equal(queuedEditRestoreText(candidate), candidate.text)
  assert.equal(queuedEditRestoreSchedule(candidate, candidate.scheduledAt! - 1), candidate.scheduledAt)
  assert.equal(queuedEditRestoreSchedule(candidate, candidate.scheduledAt!), null)
  assert.equal(queuedEditRestoreText({ text: '', attachmentNames: ['image.png'] }), 'image.png')
  assert.equal(queuedEditCandidate({ ...row, localId: null }, 'echo'), undefined)
  assert.equal(queuedEditCandidate({ ...row, invokedAt: 2000 }, 'consumed'), undefined)
  assert.equal(queuedEditCandidate({ ...row, deliveryState: 'dispatching' }, 'live dispatch'), undefined)
  assert.equal(queuedEditCandidate({ ...row, content: { message: row.content } }, 'wrapper')?.text, candidate.text)
})

test('an edit persists original payload then cancels the exact source row once, including duplicate concurrent RPCs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-queue-edit-')), source = new QueueSource(), agent = fixture(source), service = mount(source, agent, directory)
  try {
    const [first, again] = await Promise.all([service.execute(request), service.execute(request)])
    assert.equal(first.status, 'cancelled'); assert.equal(first.proof, 'source-reply'); assert.deepEqual(first, again)
    assert.deepEqual(source.cancellations, [{ sessionId: 'original-session', messageId: 'source-row-uuid' }])
    assert.equal(first.candidate.scheduledAt, source.row.scheduledAt)
    assert.equal(first.candidate.text, '@"/runner/queue/file a.txt"\nOriginal text')
    assert.deepEqual(service.list(agent.id), [first])
    assert.deepEqual(await service.execute(request), first); assert.equal(source.cancellations.length, 1)
    await assert.rejects(service.execute({ ...request, localId: 'different-input' }), /different immutable input/)
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('busy and already-invoked source outcomes retain text but never authorize edit restoration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-queue-edit-race-')), source = new QueueSource(), agent = fixture(source), service = mount(source, agent, directory)
  try {
    source.response = { status: 'busy', localId: 'original-local' }
    assert.equal((await service.execute(request)).status, 'busy')
    source.response = { status: 'invoked', message: { ...source.row, invokedAt: 2000 } }
    const consumed = await service.execute({ ...request, operationId: secondOperation })
    assert.equal(consumed.status, 'invoked'); assert.equal(consumed.proof, 'source-reply')
    assert.equal(consumed.candidate.text, '@"/runner/queue/file a.txt"\nOriginal text')
    assert.equal(source.cancellations.length, 2)
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('a lost 401 cancellation reply survives restart, absence stays unknown, and reads never repeat DELETE', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-queue-edit-unknown-')), source = new QueueSource(), agent = fixture(source)
  let service = mount(source, agent, directory)
  try {
    source.response = new HapiRequestError('Original reply lost', 'indeterminate', 401)
    const unknown = await service.execute(request); assert.equal(unknown.status, 'unknown')
    await service.dispose(); service = mount(source, agent, directory)
    source.queue = { queuedLocalIds: [], invokedLocalMessages: [] }
    assert.equal((await service.read(request))?.status, 'unknown')
    assert.equal((await service.execute(request)).status, 'unknown')
    await assert.rejects(service.execute({ ...request, operationId: secondOperation }), /no longer reports|unresolved cancellation/)
    assert.equal(source.cancellations.length, 1)
    source.emit({ type: 'message-cancelled', sessionId: source.source.id, messageId: source.row.id, localId: source.row.localId! })
    const resolved = await service.read(request); assert.equal(resolved?.status, 'cancelled'); assert.equal(resolved?.proof, 'source-event')
    assert.equal(resolved?.candidate.text, unknown.candidate.text); assert.equal(source.cancellations.length, 1)
    source.emit({ type: 'messages-consumed', sessionId: source.source.id, localIds: [source.row.localId!], invokedAt: 3000 })
    assert.equal((await service.read(request))?.status, 'invoked')
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('an exact source cancel event outranks a lost HTTP reply, while an invocation read prevents duplicate prefill', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-queue-edit-events-')), source = new QueueSource(), agent = fixture(source), service = mount(source, agent, directory)
  try {
    source.response = new HapiRequestError('Reply disappeared', 'indeterminate', 401)
    source.onCancel = () => { source.emit({ type: 'message-cancelled', sessionId: source.source.id, messageId: source.row.id, localId: source.row.localId! }) }
    const value = await service.execute(request); assert.equal(value.status, 'cancelled'); assert.equal(value.proof, 'source-event')
    source.onCancel = undefined
    const unknown = await service.execute({ ...request, operationId: secondOperation }); assert.equal(unknown.status, 'unknown')
    source.queue = { queuedLocalIds: [], invokedLocalMessages: [{ localId: source.row.localId!, invokedAt: 5000 }] }
    const read = await service.read({ sessionId: agent.id, operationId: secondOperation })
    assert.equal(read?.status, 'invoked'); assert.equal(read?.proof, 'source-invoked-read'); assert.equal(source.cancellations.length, 2)
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('a source binding change or unavailable recovery storage blocks cancellation before the original mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-queue-edit-binding-')), source = new QueueSource(), agent = fixture(source), service = mount(source, agent, directory)
  try {
    source.source.metadata!.codexSessionId = 'different-original-thread'
    const changed = await service.execute(request); assert.equal(changed.status, 'rejected'); assert.equal(source.cancellations.length, 0)
    source.source = structuredClone(sourceSession)
    await rm(directory, { recursive: true }); await writeFile(directory, 'A regular file cannot contain a durable journal')
    await assert.rejects(service.execute({ ...request, operationId: secondOperation }))
    assert.equal(source.cancellations.length, 0)
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('display replacement keeps same-source edit receipts readable without retargeting a new cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-queue-edit-generation-')), source = new QueueSource()
  let current = fixture(source)
  const service = new SourceQueuedEdits(source, { get: id => id === current.id ? current : undefined }, directory)
  try {
    const original = await service.execute(request)
    current = { ...fixture(source), id: 'hapi-codex-next-display' }
    assert.deepEqual(service.list(current.id), [original])
    assert.deepEqual(await service.read({ sessionId: current.id, operationId: operation }), original)
    await assert.rejects(service.execute({ ...request, operationId: secondOperation }), /current original source session/)
    assert.equal(source.cancellations.length, 1)
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})
