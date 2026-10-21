import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { AttachmentAdmissionPart, AdmittedPromptContentPart } from '@deepseek-ai/dsh-attachment'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { HapiRequestError, type HapiAttachment, type HapiEvent, type HapiMessagesPage, type HapiQueuedState,
  type HapiSendMessage, type HapiSession } from '../src/codex/contracts.js'
import { CodexService } from '../src/codex/service.js'
import { HapiAgentService, type HapiObservedTransport } from '../src/hapi-agent/index.js'
import type { SourceInitialTask } from '../src/hapi-agent/initial-task-types.js'
import { SourceInitialTasks, type SourceInitialTaskAgent, type SourceInitialTaskCreationLookup } from '../src/hapi/source-initial-task.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'

/** Source protocol fixture only: every Session, Agent, file receipt and attachment store below is official DSH. */
class SourceFixture implements HapiObservedTransport {
  readonly hubId = 'initial-task-fixture-hub'
  readonly sources = new Map<string, HapiSession>()
  readonly listeners = new Set<(event: HapiEvent) => void>()
  readonly sent: Array<{ sourceId: string; value: HapiSendMessage }> = []
  readonly uploads: Array<{ sourceId: string; name: string; bytes: Buffer }> = []
  readonly queues = new Map<string, HapiQueuedState>()
  sendFailure: Error | undefined
  uploadFailure: Error | undefined
  readFailure: Error | undefined
  afterUpload: (() => Promise<void>) | undefined
  add(id: string, flavor: string, native = false): HapiSession {
    const source: HapiSession = { id, namespace: 'fixture', seq: 1, createdAt: 1000, updatedAt: 1000,
      active: true, activeAt: 1000, thinking: false, thinkingAt: 1000, metadataVersion: 1, agentStateVersion: 1,
      metadata: { path: '/fixture/project', machineId: 'runner-one', flavor,
        ...(native ? { codexNativeSession: true, codexNativeConnection: 'attached', codexSessionId: `${id}-thread`, codexHome: '/fixture/codex-home', codexHomeId: 'home' }
          : flavor === 'claude' ? { claudeSessionId: `${id}-thread` } : {}),
      }, agentState: { requests: {}, completedRequests: {} }, model: 'fixture-model' }
    this.sources.set(id, source); this.queues.set(id, { queuedLocalIds: [], invokedLocalMessages: [] }); return source
  }
  async listSessions() { return [...this.sources.values()].map(source => structuredClone(source)) }
  async getSession(id: string) {
    if (this.readFailure) throw this.readFailure
    const source = this.sources.get(id); if (!source) throw new HapiRequestError('Missing fixture source', 'rejected', 404)
    return structuredClone(source)
  }
  async readMessages(): Promise<HapiMessagesPage> { return { messages: [], page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
    nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } } }
  async sendMessage(sourceId: string, value: HapiSendMessage) {
    this.sent.push({ sourceId, value: structuredClone(value) }); if (this.sendFailure) throw this.sendFailure
  }
  async getQueuedState(sourceId: string) { return structuredClone(this.queues.get(sourceId) ?? { queuedLocalIds: [], invokedLocalMessages: [] }) }
  async cancelQueuedMessage(_id: string, localId: string) { return { status: 'cancelled' as const, localId } }
  async steerQueuedMessage(_id: string, localId: string) { return { status: 'steered' as const, localId } }
  async retryIndeterminateMessage(_id: string, localId: string) { return { status: 'retried' as const, localId } }
  async abortSession() { throw new Error('Initial task delivery must never abort the source') }
  async approve() { throw new Error('Initial task delivery must not resolve approvals') }
  async deny() { throw new Error('Initial task delivery must not resolve approvals') }
  async request() { return { success: true } }
  subscribe(listener: (event: HapiEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
}

/** Instrument only the public admission seam, preserving the official on-disk implementation. */
class CountedAttachments extends LocalAttachmentStore {
  admissions = 0
  beforeAdmission: (() => Promise<void>) | undefined
  override async admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]> {
    this.admissions++; await this.beforeAdmission?.(); return super.admitPromptContent(content)
  }
}

async function mount(source: SourceFixture, directory: string, creations = new Map<string, Awaited<ReturnType<SourceInitialTaskCreationLookup>>>()) {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(CommandRuntime)
  const attachments = new CountedAttachments(ctx, { dshHome: join(directory, 'attachments-home') })
  // HTTP carrier registration is outside this test. The actual FileUploads
  // receiver-scoped staging/binding/retirement implementation runs unchanged.
  ctx.provide('connection', { fetch: { register: () => () => {} } } as unknown as Context['connection'])
  await ctx.plugin(FileUploads)
  const resolveAttachments = async (sourceId: string, message: UserMessage): Promise<HapiAttachment[]> => {
    if (source.uploadFailure) throw source.uploadFailure
    const result: HapiAttachment[] = []
    for (const block of message.content) {
      if (block.type === 'text') continue
      if (block.type !== 'file' && block.type !== 'image') throw new Error('Unexpected input block')
      let bytes: Buffer
      if (block.type === 'image') bytes = Buffer.from((await attachments.readImage(block.attachment)).data)
      else {
        const chunks: Uint8Array[] = []; for await (const chunk of attachments.readFileStream(block.attachment)) chunks.push(chunk)
        bytes = Buffer.concat(chunks)
      }
      const name = block.attachment.name ?? 'image.png'
      source.uploads.push({ sourceId, name, bytes })
      result.push({ id: `upload-${source.uploads.length}`, filename: name, mimeType: block.type === 'image' ? block.attachment.mediaType : 'application/octet-stream',
        size: bytes.byteLength, path: `/fixture/runner-upload/${source.uploads.length}` })
    }
    await source.afterUpload?.(); return result
  }
  let native: CodexService | undefined, observed: HapiAgentService | undefined, tasks: SourceInitialTasks | undefined
  await ctx.plugin(Object.assign(async (owner: Context) => {
    native = new CodexService(owner, source, { stateDirectory: directory, resolveAttachments }); await native.start()
    observed = new HapiAgentService(owner, source, { stateDirectory: directory, resolveAttachments }); await observed.start()
    tasks = new SourceInitialTasks(owner, {
      get: id => native!.get(id) ?? observed!.get(id), byHapiSession: id => native!.byHapiSession(id) ?? observed!.byHapiSession(id),
    }, async (_kind, id) => structuredClone(creations.get(id)), { stateDirectory: directory, hubId: source.hubId })
  }, { inject: ['sessions', 'agents', 'sessionProjections', 'attachments', 'fileUploads'] }))
  assert.ok(native && observed && tasks)
  const services = { native, observed, tasks }
  function request(agent: SourceInitialTaskAgent, text = 'First source task', attachments: SourceInitialTask['attachments'] = []): SourceInitialTask {
    const creationRequestId = randomUUID()
    creations.set(creationRequestId, { requestId: creationRequestId, status: 'ready', sourceSessionId: agent.binding.hapiSessionId, sessionId: agent.id })
    return { sessionId: agent.id, operationId: randomUUID(), creationRequestId, text, attachments }
  }
  return { ctx, attachments, ...services, creations, request,
    async close() { await services.tasks.settled(); await services.observed.dispose(); await services.native.dispose(); await ctx.fiber.dispose() } }
}

test('one concurrent native first task admits real files/images once and never equates HTTP admission with execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-initial-')), source = new SourceFixture(); source.add('native', 'codex', true)
  const app = await mount(source, directory)
  try {
    const agent = app.native.list()[0]!
    const upload = await app.ctx.fileUploads.upload(agent, { name: 'first.txt', data: Buffer.from('Original file bytes').toString('base64') }, new AbortController().signal)
    const request = app.request(agent, 'Read both attachments', [{ type: 'file', receiptId: upload.receiptId }, { type: 'image', name: 'first.png', mediaType: 'image/png', data: PNG }])
    const [left, right] = await Promise.all([app.tasks.submit(request), app.tasks.submit(request)])
    assert.equal(left.localId, right.localId); assert.equal(left.messageId, `hapi-initial-task:${request.operationId}`)
    await app.tasks.settled()
    assert.equal(app.attachments.admissions, 1); assert.equal(source.sent.length, 1)
    assert.deepEqual(source.uploads.map(value => value.sourceId), ['native', 'native'])
    assert.equal(source.uploads[0]!.bytes.toString(), 'Original file bytes'); assert.deepEqual(source.uploads[1]!.bytes, Buffer.from(PNG, 'base64'))
    assert.equal(agent.journal.get(left.localId)?.message.content[1]?.type, 'file')
    assert.equal(agent.journal.get(left.localId)?.message.content[2]?.type, 'image')
    const accepted = await app.tasks.read({ operationId: request.operationId })
    assert.equal(accepted?.status, 'accepted'); assert.equal(accepted.sourceConfirmed, false); assert.equal(accepted.canRetry, false)
    await assert.rejects(app.tasks.retry({ operationId: request.operationId }), /unsubmitted|rejected/)
    await assert.rejects(app.tasks.submit({ ...request, text: 'Changed task' }), /different input/)
    await assert.rejects(app.tasks.submit({ ...request, operationId: randomUUID() }), /already has an initial task/)
    source.queues.set('native', { queuedLocalIds: [left.localId], invokedLocalMessages: [] })
    assert.equal((await app.tasks.read({ operationId: request.operationId }))?.sourceConfirmed, true)
    source.queues.set('native', { queuedLocalIds: [], invokedLocalMessages: [{ localId: left.localId, invokedAt: Date.now() }] })
    assert.equal((await app.tasks.read({ operationId: request.operationId }))?.status, 'invoked')
    await app.tasks.submit(request); assert.equal(app.attachments.admissions, 1); assert.equal(source.sent.length, 1)
    const savedFile = (await readdir(directory)).find(name => name.startsWith('initial-tasks-'))!
    const saved = await readFile(join(directory, savedFile), 'utf8')
    assert.ok(!saved.includes(PNG)); assert.ok(saved.includes('sha256:')); assert.ok(!saved.includes(upload.receiptId))
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('attachment-only source task survives Host restart and retries only a confirmed rejection using its original admitted bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-initial-')), source = new SourceFixture(); source.add('claude', 'claude')
  let app = await mount(source, directory)
  try {
    const agent = app.observed.list()[0]!
    const upload = await app.ctx.fileUploads.upload(agent, { name: 'only.txt', data: Buffer.from('Attachment-only task').toString('base64') }, new AbortController().signal)
    const request = app.request(agent, '', [{ type: 'file', receiptId: upload.receiptId }])
    source.sendFailure = new HapiRequestError('Source rejected admission', 'rejected', 403)
    await app.tasks.submit(request); await app.tasks.settled()
    const rejected = await app.tasks.read({ operationId: request.operationId })
    assert.equal(rejected?.status, 'rejected'); assert.equal(rejected.canRetry, true); assert.equal(source.sent[0]?.value.text, '')
    const originalMessage = agent.journal.get(rejected.localId)?.message
    const creations = app.creations; await app.close(); app = await mount(source, directory, creations)
    const restored = app.observed.list()[0]!
    assert.equal(app.ctx.fileUploads.resolve(restored, upload.receiptId), undefined)
    assert.equal(app.tasks.list({ creationRequestId: request.creationRequestId }).length, 1)
    source.sendFailure = undefined
    await app.tasks.submit(request); assert.equal(source.sent.length, 1)
    await app.tasks.retry({ operationId: request.operationId }); await app.tasks.settled()
    assert.equal(source.sent.length, 2); assert.equal(source.sent[0]?.value.localId, source.sent[1]?.value.localId)
    assert.deepEqual(restored.journal.get(rejected.localId)?.message, originalMessage)
    assert.equal(app.attachments.admissions, 0); assert.equal(source.uploads[1]?.bytes.toString(), 'Attachment-only task')
    assert.equal((await app.tasks.read({ operationId: request.operationId }))?.status, 'accepted')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('unknown first-task outcomes including masked 401 are read-only across restart, disconnect and repeated submissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-initial-')), source = new SourceFixture(); source.add('native', 'codex', true)
  let app = await mount(source, directory)
  try {
    const request = app.request(app.native.list()[0]!)
    source.sendFailure = new HapiRequestError('Source authorization response may mask an admitted write', 'indeterminate', 401)
    await app.tasks.submit(request); await app.tasks.settled()
    const receipt = await app.tasks.read({ operationId: request.operationId })
    assert.equal(receipt?.status, 'indeterminate'); assert.equal(receipt.canRetry, false)
    const creations = app.creations; await app.close(); app = await mount(source, directory, creations)
    source.sources.get('native')!.active = false
    assert.equal((await app.tasks.read({ operationId: request.operationId }))?.sourceAvailable, false)
    assert.equal(app.tasks.list({ creationRequestId: request.creationRequestId })[0]?.localId, receipt.localId)
    source.sources.get('native')!.active = true; source.sendFailure = undefined
    await app.tasks.submit(request); await assert.rejects(app.tasks.retry({ operationId: request.operationId }), /unsubmitted|rejected/)
    assert.equal(source.sent.length, 1)
    source.queues.set('native', { queuedLocalIds: [receipt.localId], invokedLocalMessages: [] })
    assert.equal((await app.tasks.read({ operationId: request.operationId }))?.status, 'queued')
    assert.equal(source.sent.length, 1); assert.equal(app.attachments.admissions, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('creation, Session-scoped file authority and immutable source identity are checked before task dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-initial-')), source = new SourceFixture()
  source.add('first', 'claude'); source.add('other', 'claude')
  const app = await mount(source, directory)
  try {
    const first = app.observed.byHapiSession('first')!, other = app.observed.byHapiSession('other')!
    const upload = await app.ctx.fileUploads.upload(other, { name: 'foreign.txt', data: Buffer.from('Foreign source file').toString('base64') }, new AbortController().signal)
    const foreign = app.request(first, '', [{ type: 'file', receiptId: upload.receiptId }])
    await assert.rejects(app.tasks.submit(foreign), /not staged/)
    assert.equal(source.sent.length, 0); assert.equal(app.tasks.list().length, 0)
    const unready = app.request(first); app.creations.get(unready.creationRequestId)!.status = 'accepted'
    await assert.rejects(app.tasks.submit(unready), /matching ready receipt/)
    app.creations.get(unready.creationRequestId)!.status = 'ready'; app.creations.get(unready.creationRequestId)!.sourceSessionId = 'other'
    await assert.rejects(app.tasks.submit(unready), /matching ready receipt/)
    const request = app.request(first); source.sendFailure = new HapiRequestError('Confirmed rejection', 'rejected', 400)
    await app.tasks.submit(request); await app.tasks.settled()
    source.readFailure = new Error('Source is offline')
    assert.equal((await app.tasks.read({ operationId: request.operationId }))?.canRetry, false)
    await assert.rejects(app.tasks.retry({ operationId: request.operationId }), /original writable source/)
    source.readFailure = undefined
    source.sources.get('first')!.metadata!.claudeSessionId = 'replacement-thread'; source.sources.get('first')!.metadataVersion++
    await assert.rejects(app.tasks.retry({ operationId: request.operationId }), /original writable source/)
    await app.observed.reconcileSource('first')
    const receipt = await app.tasks.read({ operationId: request.operationId })
    assert.equal(receipt?.sessionId, null); assert.equal(receipt?.sourceAvailable, false)
    assert.equal(source.sent.length, 1)
    const replacement = app.observed.byHapiSession('first')!
    assert.notEqual(replacement.id, first.id)
    const stale = app.request(replacement); stale.sessionId = first.id
    await assert.rejects(app.tasks.submit(stale), /exact ready source display/)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('prepared task restores from its admitted content and never admits it again after a writable-source race', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-initial-')), source = new SourceFixture(); source.add('native', 'codex', true)
  let app = await mount(source, directory)
  try {
    const agent = app.native.list()[0]!, request = app.request(agent, '', [{ type: 'image', mediaType: 'image/png', data: PNG }])
    app.attachments.beforeAdmission = async () => {
      source.sources.get('native')!.active = false; await agent.refresh()
    }
    const prepared = await app.tasks.submit(request)
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.canRetry, false); assert.equal(source.sent.length, 0)
    const creations = app.creations; await app.close(); source.sources.get('native')!.active = true; app = await mount(source, directory, creations)
    assert.equal((await app.tasks.read({ operationId: request.operationId }))?.canRetry, true)
    await app.tasks.retry({ operationId: request.operationId }); await app.tasks.settled()
    assert.equal(source.sent.length, 1); assert.equal(source.sent[0]?.value.localId, prepared.localId)
    assert.equal(source.sent[0]?.value.text, ''); assert.equal(source.sent[0]?.value.attachments?.length, 1)
    assert.equal(app.attachments.admissions, 0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a stale prepared snapshot is reconciled against the durable Agent journal before offering retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-initial-')), source = new SourceFixture(); source.add('claude', 'claude')
  let app = await mount(source, directory)
  try {
    const request = app.request(app.observed.list()[0]!)
    await app.tasks.submit(request); await app.tasks.settled()
    const filename = join(directory, (await readdir(directory)).find(name => name.startsWith('initial-tasks-'))!)
    const creations = app.creations; await app.close()
    const saved = JSON.parse(await readFile(filename, 'utf8')) as { entries: Array<{ receipt: { status: string; delivery: unknown; sourceConfirmed: boolean } }> }
    saved.entries[0]!.receipt.status = 'prepared'; saved.entries[0]!.receipt.delivery = null; saved.entries[0]!.receipt.sourceConfirmed = false
    await writeFile(filename, JSON.stringify(saved))
    app = await mount(source, directory, creations)
    const read = await app.tasks.read({ operationId: request.operationId })
    assert.equal(read?.status, 'accepted'); assert.equal(read?.canRetry, false)
    await assert.rejects(app.tasks.retry({ operationId: request.operationId }), /unsubmitted|rejected/)
    assert.equal(source.sent.length, 1)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
