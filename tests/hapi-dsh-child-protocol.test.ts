/** Pinned original DSH-child REST protocol fixtures; no model credentials are used. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.js'
import { NativeHistoryChangedError } from '../src/codex/projector.js'
import { SourceDshChildDelivery } from '../src/hapi-agent/dsh-child-delivery.js'
import { readSourceDshChildHistory, sourceDshChildBinding, sourceDshChildCatalog, sourceDshChildItems,
  sourceDshChildPath, validateSourceDshChild } from '../src/hapi-agent/dsh-child-protocol.js'
import type { SourceDshChildBinding, SourceDshChildDescriptor, SourceDshChildMessage } from '../src/hapi-agent/dsh-child-types.js'

const descriptor: SourceDshChildDescriptor = { sessionId: 'child/one', mode: 'continuable', activity: 'inactive', createdAt: 1000, lastTurnCompleted: true }
function parent(): HapiSession {
  return { id: 'parent/one', namespace: 'fixture-owner', seq: 1, createdAt: 500, updatedAt: 1000,
    active: true, activeAt: 1000, thinking: false, thinkingAt: 1000, metadataVersion: 1, agentStateVersion: 1,
    metadata: Object.assign({ flavor: 'dsh', path: '/fixture/project', machineId: 'runner-one', dshSessionId: 'original-parent-dsh' },
      { dshSubagents: [structuredClone(descriptor)] }), agentState: { requests: {}, completedRequests: {} } }
}
const binding = (): SourceDshChildBinding => sourceDshChildBinding('fixture-hub', parent(), descriptor)
const message = (text = 'Original child task') => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
function transcript(size: number): SourceDshChildMessage[] {
  return Array.from({ length: size }, (_, index) => ({ id: `${descriptor.sessionId}:${index}`,
    role: index % 2 ? 'assistant' : 'user', kind: 'message', text: `Original row ${index}`, createdAt: 1000 + index }))
}
class HistorySource {
  rows = transcript(250)
  epoch = 'child-epoch:1000'
  paths: string[] = []
  transform: ((value: Record<string, unknown>) => unknown) | undefined
  async request(path: string): Promise<unknown> {
    this.paths.push(path)
    const url = new URL(path, 'https://fixture.invalid')
    assert.equal(url.pathname, sourceDshChildPath(binding(), 'messages'))
    const limit = Number(url.searchParams.get('limit')), epoch = url.searchParams.get('epoch')
    const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
    const reset = epoch !== null && epoch !== this.epoch || after !== undefined && after > this.rows.length
    const start = !reset && after !== undefined ? after : Math.max(0, (before ?? this.rows.length) - limit)
    const end = !reset && after !== undefined ? Math.min(this.rows.length, after + limit) : before ?? this.rows.length
    const value = { sessionId: descriptor.sessionId, epoch: this.epoch, messages: structuredClone(this.rows.slice(start, end)),
      before: start > 0 ? start : null, hasMore: start > 0, after: after !== undefined && !reset ? end : this.rows.length,
      hasLater: after !== undefined && !reset && end < this.rows.length, reset, truncated: this.rows.some(row => row.truncated) }
    return this.transform ? this.transform(value) : value
  }
}

test('source child ownership binds Hub, parent namespace, Runner, native parent, durable child and creation identity', () => {
  const source = parent(), owner = binding()
  assert.deepEqual(sourceDshChildCatalog(source), [descriptor])
  assert.equal(validateSourceDshChild(owner, source, true).sessionId, descriptor.sessionId)
  for (const mutate of [
    (value: HapiSession) => { value.id = 'another-parent' },
    (value: HapiSession) => { value.namespace = 'another-owner' },
    (value: HapiSession) => { value.metadata!.machineId = 'another-runner' },
    (value: HapiSession) => { value.metadata!.dshSessionId = 'another-dsh-parent' },
    (value: HapiSession) => { Object.assign(value.metadata!, { dshSubagents: [{ ...descriptor, sessionId: 'another-child' }] }) },
    (value: HapiSession) => { Object.assign(value.metadata!, { dshSubagents: [{ ...descriptor, createdAt: 2000 }] }) },
  ]) { const changed = structuredClone(source); mutate(changed); assert.throws(() => validateSourceDshChild(owner, changed, true), /original parent and Runner/) }
  for (const mode of ['one-shot', 'external', 'unknown'] as const) {
    Object.assign(source.metadata!, { dshSubagents: [{ ...descriptor, mode }] })
    assert.equal(validateSourceDshChild(owner, source).mode, mode)
    assert.throws(() => validateSourceDshChild(owner, source, true), /continuable/)
  }
  source.active = false
  assert.throws(() => validateSourceDshChild(owner, source), /active Runner/)
  assert.equal(sourceDshChildPath(owner, 'prompt'), '/api/sessions/parent%2Fone/dsh-subagents/child%2Fone/prompt')
})

test('real ordinal pages read complete history, catch up gaps, reject foreign identities and signal authoritative epoch or content replacement', async () => {
  const source = new HistorySource(), owner = binding()
  const first = await readSourceDshChildHistory(source, owner)
  assert.equal(first.rows.length, 250); assert.equal(first.after, 250); assert.equal(source.paths.length, 3)
  assert.ok(source.paths.some(path => path.includes('before=150')))
  source.rows = transcript(510)
  const next = await readSourceDshChildHistory(source, owner, first)
  assert.equal(next.rows.length, 510); assert.equal(next.after, 510)
  assert.ok(source.paths.some(path => path.includes('after=250')))
  source.rows[2] = { ...source.rows[2]!, text: 'Corrected original history' }
  await assert.rejects(readSourceDshChildHistory(source, owner, next, true), NativeHistoryChangedError)
  source.epoch = 'replacement-epoch'
  await assert.rejects(readSourceDshChildHistory(source, owner, next), NativeHistoryChangedError)
  source.transform = value => ({ ...value, sessionId: 'other-child' })
  await assert.rejects(readSourceDshChildHistory(source, owner), /another DSH child/)
  source.transform = value => ({ ...value, messages: [{ id: 'other-child:0', role: 'user', text: 'foreign', createdAt: 1 }] })
  await assert.rejects(readSourceDshChildHistory(source, owner), /unrelated row identity/)
})

test('neutral child rows preserve actual tool input, result errors and text without guessing turn completion or delivery identity', async () => {
  const source = new HistorySource(); source.rows = [
    { id: `${descriptor.sessionId}:0`, role: 'user', kind: 'message', text: 'Original prompt [File: report.pdf]', createdAt: 1000 },
    { id: `${descriptor.sessionId}:1`, role: 'assistant', kind: 'reasoning', text: 'Original reasoning', createdAt: 1100 },
    { id: `${descriptor.sessionId}:2`, role: 'tool', kind: 'tool-call', text: 'bash\n{"command":"false"}', callId: 'native-tool', toolName: 'bash', input: { command: 'false' }, createdAt: 1200 },
    { id: `${descriptor.sessionId}:3`, role: 'tool', kind: 'tool-result', text: 'exit 1', callId: 'native-tool', output: 'exit 1', isError: true, truncated: true, createdAt: 1300 },
    { id: `${descriptor.sessionId}:4`, role: 'assistant', kind: 'message', text: 'Original answer', createdAt: 1400 },
  ]
  const history = await readSourceDshChildHistory(source, binding()), items = sourceDshChildItems(history, descriptor.sessionId)
  assert.equal(history.truncated, true)
  assert.deepEqual(items.map(item => item.kind), ['user', 'assistant', 'tool-call', 'tool-result', 'assistant'])
  assert.ok(items.every(item => item.localId === null && item.scopeId === `dsh-child:${descriptor.sessionId}`))
  assert.ok(!items.some(item => item.kind === 'end'))
  assert.deepEqual(items[2]!.kind === 'tool-call' ? items[2]!.input : undefined, { command: 'false' })
  assert.equal(items[3]!.kind === 'tool-result' && items[3]!.isError, true)
})

test('durable child prompts use one immutable original requestId and keep accepted separate from executed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-child-delivery-')), calls: Array<{ path: string; body: unknown }> = []
  let validations = 0
  try {
    const transport = { request: async (path: string, options?: { body?: unknown }) => { calls.push({ path, body: options?.body }); return { messageId: 'original-user-message-id' } } }
    const journal = new SourceDshChildDelivery(directory, binding(), transport, async () => { validations++ }, () => {})
    const input = message(), first = journal.prompt(input, 'queue')
    assert.equal(first.status, 'prepared')
    journal.prompt(input, 'queue'); await journal.settled()
    assert.equal(calls.length, 1); assert.equal(validations, 1)
    assert.deepEqual(calls[0], { path: sourceDshChildPath(binding(), 'prompt'), body: { text: 'Original child task', delivery: 'queue', requestId: first.requestId } })
    assert.equal(journal.read(first.operationId)?.status, 'accepted'); assert.equal(journal.read(first.operationId)?.sourceMessageId, 'original-user-message-id')
    assert.throws(() => journal.prompt(input, 'steer'), /different immutable input/)
    const restarted = new SourceDshChildDelivery(directory, binding(), transport, async () => { throw new Error('Read must not validate or send') }, () => {})
    assert.equal(restarted.prompt(input, 'queue').status, 'accepted'); await restarted.settled(); assert.equal(calls.length, 1)
    const attachment = createUserMessage({ content: [{ type: 'text', text: 'Do not drop file' }, { type: 'file', attachment: { attachmentId: 'fixture-file' as never, bytes: 4, name: 'file.txt' } }], source: { kind: 'user' } })
    assert.throws(() => restarted.prompt(attachment, 'queue'), /text only/); assert.equal(calls.length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('401 and source 409 remain unknown after the five-minute source cache and workspace restart; reads never repost', async () => {
  for (const status of [401, 409]) {
    const directory = await mkdtemp(join(tmpdir(), `dsh-child-unknown-${status}-`)), calls: string[] = []
    try {
      const transport = { request: async (path: string) => { calls.push(path); throw new HapiRequestError('Original response lost after source admission', 'indeterminate', status) } }
      const journal = new SourceDshChildDelivery(directory, binding(), transport, async () => {}, () => {}), input = message()
      const first = journal.prompt(input, 'steer'); await journal.settled(); assert.equal(journal.read(first.operationId)?.status, 'unknown')
      const file = join(directory, (await readdir(directory))[0]!)
      const saved = JSON.parse(await readFile(file, 'utf8')); saved.entries[0].receipt.createdAt = Date.now() - 10 * 60_000
      await writeFile(file, JSON.stringify(saved))
      const restarted = new SourceDshChildDelivery(directory, binding(), transport, async () => { throw new Error('Unknown cannot replay') }, () => {})
      assert.equal(restarted.prompt(input, 'steer').status, 'unknown'); assert.equal(restarted.list()[0]?.requestId, first.requestId)
      await restarted.settled(); assert.equal(calls.length, 1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('a persisted in-flight child prompt recovers as unknown without another owner submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-child-flight-')), recovery = await mkdtemp(join(tmpdir(), 'dsh-child-recovered-'))
  let resolve!: (value: unknown) => void, submitted!: () => void
  const entered = new Promise<void>(done => { submitted = done }), wait = new Promise<unknown>(done => { resolve = done })
  let calls = 0
  const transport = { request: async () => { calls++; submitted(); return wait } }
  const journal = new SourceDshChildDelivery(directory, binding(), transport, async () => {}, () => {}), input = message()
  try {
    const first = journal.prompt(input, 'queue'); await entered
    await cp(directory, recovery, { recursive: true })
    const restarted = new SourceDshChildDelivery(recovery, binding(), transport, async () => {}, () => {})
    assert.equal(restarted.prompt(input, 'queue').status, 'unknown'); await restarted.settled(); assert.equal(calls, 1)
    assert.match(restarted.read(first.operationId)?.error ?? '', /restarted/)
  } finally { resolve({}); await journal.settled(); await rm(directory, { recursive: true, force: true }); await rm(recovery, { recursive: true, force: true }) }
})

test('an unavailable durable intent or changed parent never crosses a child mutation boundary; interrupts are journaled once too', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-child-storage-'))
  let calls = 0
  try {
    const transport = { request: async () => { calls++; return { accepted: true } } }
    const blocked = new SourceDshChildDelivery(directory, binding(), transport, async () => { throw new Error('Original membership changed') }, () => {})
    const rejected = blocked.interrupt('interrupt-membership'); await blocked.settled()
    assert.equal(blocked.read(rejected.operationId)?.status, 'rejected'); assert.equal(calls, 0)
    const good = new SourceDshChildDelivery(directory, binding(), transport, async () => {}, () => {})
    const receipt = good.interrupt('interrupt-explicit'); await good.settled()
    assert.equal(good.read(receipt.operationId)?.status, 'accepted'); good.interrupt('interrupt-explicit'); await good.settled(); assert.equal(calls, 1)
    await rm(directory, { recursive: true, force: true })
    assert.throws(() => good.prompt(message(), 'queue')); await good.settled(); assert.equal(calls, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
