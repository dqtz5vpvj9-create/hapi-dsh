/** Real HHPI Session/history/action owner; remote RPC and upload resolution are the only fixtures. */
import assert from 'node:assert/strict'
import { before, test, type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPromptContentPart } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { SourcePage, SourceSession, SourceEntry, SourceReceipt } from '../src/remote/protocol.ts'
import type { RemoteSourceSession } from '../src/client/remote-sessions.ts'
import type { RemotePaneSession } from '../src/client/remote-reading-session.ts'
import type { ConversationHistoryViewV1, HistoryViewSnapshotV1 } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SourceWorkspaceApi } from '../src/workspace/source-api.ts'
import { RemoteOutbox } from '../src/client/remote-outbox.ts'
import type { CodexCall, CodexCallResult } from '../src/remote/codex-access.ts'
import { RemoteSourceHistory } from '../src/client/remote-history.ts'
import { SourceDirectory, type SourceDirectories } from '../src/client/source-capabilities.ts'
import { NativeActionOwner } from '../src/client/remote-native-actions.ts'
import type { NativeQueueItem } from '../src/client/remote-native-task-state.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'
import { officialChat } from './official-conversation-fixture.ts'
import { memoryOperations } from './fixtures/operation-transactions.ts'
let Session: typeof RemoteSourceSession
let Pane: typeof RemotePaneSession
before(async () => {
  const root = resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
  const output = await build({ stdin: { contents: `export { RemoteSourceSession } from './src/client/remote-sessions.ts'; export { RemotePaneSession } from './src/client/remote-reading-session.ts'`, resolveDir: root },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
    external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} as { RemoteSourceSession: typeof RemoteSourceSession; RemotePaneSession: typeof RemotePaneSession } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
  Session = module.exports.RemoteSourceSession
  Pane = module.exports.RemotePaneSession
})
const queueInbox = (face: RemoteSourceSession) => face.projections.faceOf('inbox').getSnapshot() as InboxState | undefined
const content: SessionPromptContentPart[] = [{ type: 'text', text: 'Use ' }, { type: 'reference', source: 'hhpi:codex:skill', ref: '/native/skill/SKILL.md', label: 'Review' }]
async function fixture(t: TestContext, call: (request: CodexCall) => Promise<CodexCallResult>, uploadInputs?: SourceWorkspaceApi['uploadInputs'], options: { outbox?: RemoteOutbox; offline?: boolean; receipt?: (request: CodexCall) => Promise<CodexCallResult>; queuedSteer?: boolean } = {}) {
  const session: SourceSession = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', nativeId: 'thread', engine: 'codex', title: 'Synthetic', cwd: '/native', updatedAt: 1,
    status: 'idle', activeTurnId: null, capabilities: { send: true, steer: true, cancel: true, approve: true, files: true, images: true }, codex: { model: 'fixture' } as SourceSession['codex'], pendingRequests: [] }
  if (options.offline) session.status = 'offline'
  if (options.queuedSteer) { session.status = 'running'; session.activeTurnId = 'exact-active-turn' }
  let page: SourcePage = { session, epoch: 'epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] }
  const history = new RemoteSourceHistory(session.id, { read: async () => page, async *changes() { throw new Error('No mounted reading view') } })
  let queue: readonly NativeQueueItem[] = []
  let queueReadError: Error | undefined
  const api = { async nativeCapabilities() { return { ok: true, value: { methods: { 'skills/list': 'read', 'thread/queue/add': 'write', 'thread/queue/list': 'read', 'thread/queue/update': 'write', 'thread/queue/delete': 'write', 'turn/steer': 'write' }, ...(options.queuedSteer ? { methods: { 'skills/list': 'read', 'thread/queue/add': 'write', 'thread/queue/list': 'read', 'thread/queue/update': 'write', 'thread/queue/delete': 'write', 'turn/steer': 'write', 'hhpi/queue/steer': 'write', 'hhpi/queue/list': 'read' } } : {}), unavailable: {} } } },
    async nativeCall(request: CodexCall) {
      if ((request.method === 'thread/queue/list' || request.method === 'hhpi/queue/list') && queueReadError) throw queueReadError
      return { ok: true, value: { status: 'accepted', result: (request.method === 'thread/queue/list' || request.method === 'hhpi/queue/list') ? { data: queue, nextCursor: null } : { data: [{ skills: [{ name: 'review', path: '/native/skill/SKILL.md', enabled: true }] }] } } }
    } } as unknown as HhpiRemoteApi
  const directory = new SourceDirectory(api, 'source'), actions = new NativeActionOwner({ call, async receipt(request) { return options.receipt?.(request) ?? { status: 'indeterminate', message: 'Original still unknown' } } })
  actions.setStorage({ storage: new BrowserStorage(), scope: 'session-input' })
  const outbox = options.outbox ?? { view: () => ({ getSnapshot: () => [], subscribe: () => () => {} }), onRetire: () => () => {}, get: () => undefined,
    enqueue() { throw new Error('Structured input must never be prematurely admitted as ordinary text') } } as unknown as RemoteOutbox
  const face = new Session(session.id as SessionId, session, history, api, outbox, { forSession: () => directory } as unknown as SourceDirectories, actions, uploadInputs ? { uploadInputs } : undefined)
  t.after(() => { face.dispose(); history.dispose(); actions.dispose(); directory.dispose() })
  await face.ready
  const observe = async (rpcId: string) => {
    const seq = page.entries.length ? page.entries[0]!.event.seq + 1 : 0
    const event = { type: 'user/message', seq, time: 1000 + seq, surfaceOp: 'append', data: { id: `native-message-${rpcId}`, role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text: 'Use Review' }] } } as unknown as SourceEntry['event']
    page = { ...page, entries: [{ type: 'event', event } as SourceEntry], before: seq, after: seq }
    await history.page({ around: seq }, new AbortController().signal)
  }
  const setQueue = async (rows: typeof queue) => {
    queue = rows
    face.update({ ...face.metadata.getSnapshot(), updatedAt: face.metadata.getSnapshot().updatedAt + 1 })
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { face, actions, observe, session, history, setQueue, entries: () => page.entries, failQueueReads(error: Error | undefined) { queueReadError = error } }
}

test('structured admission never enters ordinary text outbox and cached exact native identity retires its echo', async t => {
  const calls: CodexCall[] = []
  const f = await fixture(t, async request => { calls.push(request); return { status: 'accepted', message: 'Queued' } })
  let accepted = 0, retired = 0
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'Use Review', content, attachments: [], onAccept: () => accepted++, onRetire: () => retired++ })
  // Source history may arrive before the native receipt; subscribeEntries must inspect current resident data.
  await f.observe(pending.requestId)
  assert.equal((await f.face.prompt(content, 'queue', undefined, pending.requestId)).ok, true)
  assert.equal(calls.length, 1); assert.equal(accepted, 1); assert.equal(retired, 1)
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 0)
})

test('a failed file receipt resolver keeps attachments unaccepted and removes its unsent temporary echo', async t => {
  let writes = 0, accepted = 0, retired = 0
  const f = await fixture(t, async () => { writes++; return { status: 'accepted', message: 'Unexpected' } }, async () => { throw new Error('Source revoked the upload receipt') })
  const withFile = [...content, { type: 'file' as const, receiptId: '00000000-0000-4000-8000-000000000003' as never }]
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'Use Review', content: withFile, attachments: [], onAccept: () => accepted++, onRetire: () => retired++ })
  assert.equal((await f.face.prompt(withFile, 'queue', undefined, pending.requestId)).ok, false)
  assert.equal(writes, 0); assert.equal(accepted, 0); assert.equal(retired, 1)
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 0)
})

test('unknown structured delivery remains visible until its exact source event arrives without settling the unknown receipt', async t => {
  let accepted = 0
  const f = await fixture(t, async () => { throw new Error('lost receipt') })
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'Use Review', content, attachments: [], onAccept: () => accepted++ })
  assert.equal((await f.face.prompt(content, 'queue', undefined, pending.requestId)).ok, false)
  assert.equal(accepted, 0); assert.equal(f.face.getSnapshot().pendingSubmissions.length, 1)
  await f.observe('unrelated-id')
  assert.equal(accepted, 0)
  await f.observe(pending.requestId)
  assert.equal(accepted, 1); assert.equal(f.face.getSnapshot().pendingSubmissions.length, 0)
  assert.equal(f.actions.get(f.face.sessionId, 'composer')?.phase, 'confirming', 'an exact transcript event retires its echo; it does not forge a native operation receipt')
})

test('the actual Session inspects small-byte inline images before native admission and keeps failed preparation unsent', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  let writes = 0, inspected = 0
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { inspected++; throw new Error('Local image decoder unavailable') } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'createImageBitmap', original); else Reflect.deleteProperty(globalThis, 'createImageBitmap') })
  const f = await fixture(t, async () => { writes++; return { status: 'accepted', message: 'Unexpected' } })
  const smallImage: SessionPromptContentPart[] = [...content, { type: 'image', mediaType: 'image/png', data: 'AQID' }]
  let accepted = 0
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'Use Review', content: smallImage, attachments: [], onAccept: () => accepted++ })
  assert.equal((await f.face.prompt(smallImage, 'queue', undefined, pending.requestId)).ok, false)
  assert.equal(inspected, 1); assert.equal(writes, 0); assert.equal(accepted, 0)
  assert.equal(f.face.projections.faceOf('hhpiPreparingImages').getSnapshot(), false)
})

test('online plain text shares native queue admission and confirmed identity with structured input', async t => {
  const calls: CodexCall[] = []
  const f = await fixture(t, async request => { calls.push(request); return { status: 'accepted', message: 'Queued' } })
  const plain: SessionPromptContentPart[] = [{ type: 'text', text: 'Ordinary text' }]
  let accepted = 0
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'Ordinary text', content: plain, attachments: [], onAccept: () => accepted++ })
  assert.equal(accepted, 0, 'native ownership must be confirmed before clearing the draft')
  assert.equal((await f.face.prompt(plain, 'queue', undefined, pending.requestId)).ok, true)
  assert.equal(accepted, 1)
  assert.equal(calls[0]?.method, 'thread/queue/add')
  assert.equal(calls[0]?.operationId, pending.requestId)
  assert.equal(calls[0]?.params?.clientUserMessageId, pending.requestId)
  assert.equal(f.actions.get(f.session.id, 'composer')?.phase, 'accepted')
  assert.equal((await f.face.prompt(plain, 'queue', undefined, pending.requestId)).ok, true)
  assert.equal(calls.length, 1, 'rechecking accepted input is not another attempt')
  assert.equal((await f.face.prompt([{ type: 'text', text: 'Changed draft' }], 'queue', undefined, pending.requestId)).ok, false)
  assert.equal(calls.length, 1, 'a confirmed ID cannot clear or accept different text')
  assert.equal((await f.face.prompt(content, 'queue')).ok, true)
  assert.equal(calls.length, 2); assert.equal(calls[1]?.method, 'thread/queue/add')
})

for (const first of ['plain', 'structured'] as const) test(`uncertain ${first} input cannot be replaced through the other composer carrier`, async t => {
  const calls: CodexCall[] = [], receipts: CodexCall[] = []
  const f = await fixture(t, async request => { calls.push(request); return { status: 'indeterminate', message: 'Original still unknown' } }, undefined,
    { receipt: async request => { receipts.push(request); return { status: 'indeterminate', message: 'Original still unknown' } } })
  const plain: SessionPromptContentPart[] = [{ type: 'text', text: 'Ordinary text' }]
  const original = first === 'plain' ? plain : content, replacement = first === 'plain' ? content : plain
  const initial = f.face.beginSubmission({ mode: 'queue', text: first, content: original, attachments: [] })
  assert.equal((await f.face.prompt(original, 'queue', undefined, initial.requestId)).ok, false)
  let accepted = 0
  const next = f.face.beginSubmission({ mode: 'queue', text: 'Replacement', content: replacement, attachments: [], onAccept: () => accepted++ })
  assert.equal((await f.face.prompt(replacement, 'queue', undefined, next.requestId)).ok, false)
  assert.equal(calls.length, 1); assert.equal(accepted, 0); assert.equal(receipts.length, 0)
  assert.equal(f.actions.get(f.session.id, 'composer')?.request.operationId, initial.requestId)
  assert.equal((await f.face.prompt(original, 'queue', undefined, initial.requestId)).ok, false)
  assert.deepEqual(receipts, [calls[0]], 'only the original immutable request is queried')
  assert.equal(calls.length, 1)
})

test('offline admitted plain text keeps its original outbox carrier after reconnect instead of also using native composer', async t => {
  const operations: string[] = [], native: CodexCall[] = [], accepted = Promise.withResolvers<void>()
  const outbox = new RemoteOutbox(async operation => { operations.push(operation.operationId); accepted.resolve(); return {
    operationId: operation.operationId, sessionId: operation.sessionId, status: 'accepted', message: 'Native queue accepted',
    ownerAdmission: { localId: operation.operationId, state: 'queued' },
  } })
  outbox.setStorage({ storage: new BrowserStorage(), scope: 'offline-text-carrier' })
  t.after(() => outbox.dispose())
  const f = await fixture(t, async request => { native.push(request); return { status: 'accepted', message: 'Unexpected second carrier' } }, undefined, { outbox, offline: true })
  outbox.acceptCatalog([f.session])
  const plain: SessionPromptContentPart[] = [{ type: 'text', text: 'Saved offline' }]
  let draftAccepted = 0
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'Saved offline', content: plain, attachments: [], onAccept: () => draftAccepted++ })
  assert.equal(draftAccepted, 1); assert.equal(outbox.get(pending.requestId)?.attempts, 0)
  assert.equal((await f.face.prompt(plain, 'queue', undefined, pending.requestId)).ok, true)
  assert.deepEqual(operations, []); assert.deepEqual(native, [])
  const online = { ...f.session, status: 'idle' as const }
  f.face.update(online); outbox.acceptCatalog([online])
  // Calling prompt again while the original ID is saved cannot open another carrier.
  assert.equal((await f.face.prompt(plain, 'queue', undefined, pending.requestId)).ok, true)
  await accepted.promise
  assert.deepEqual(operations, [pending.requestId]); assert.deepEqual(native, [])
  assert.equal(f.actions.get(f.session.id, 'composer'), undefined)
})

test('confirmed input stays in the native QueueDock through queue ownership and consumption without resending', async t => {
  let writes = 0
  const f = await fixture(t, async () => { writes++; return { status: 'accepted', message: 'Saved in native queue' } })
  let accepted = 0, retired = 0
  const plain: SessionPromptContentPart[] = [{ type: 'text', text: 'Manage this through native Queue' }]
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'Manage this through native Queue', content: plain, attachments: [],
    onAccept: () => accepted++, onRetire: () => retired++ })
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 1)
  assert.equal((await f.face.prompt(plain, 'queue', undefined, pending.requestId)).ok, true)
  assert.equal(accepted, 1); assert.equal(retired, 0)
  assert.equal(f.face.getSnapshot().pendingSubmissions[0]?.placement, 'queued')
  assert.equal(f.face.getSnapshot().pendingSubmissions[0]?.text, 'Manage this through native Queue')
  const queued = { id: 'original-native-queue-id', clientUserMessageId: pending.requestId, input: [{ type: 'text', text: 'Manage this through native Queue', text_elements: [] as never[] }] }
  await f.setQueue([queued])
  const inbox = queueInbox(f.face)
  assert.equal((inbox?.['next-turn'][0] as { id?: string } | undefined)?.id, queued.id)
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 1, 'the original dock deduplicates an exact queue rpcId while the fallback survives source handoff')
  const external = 'Edited by the native source owner'
  await f.setQueue([{ ...queued, input: [{ type: 'text', text: external, text_elements: [] }] }])
  assert.deepEqual(queueInbox(f.face)?.['next-turn'][0]?.content, [{ type: 'text', text: external }])
  assert.equal(f.face.getSnapshot().pendingSubmissions[0]?.text, external, 'handoff fallback follows a confirmed source edit')
  await f.setQueue([])
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 1, 'queue removal before the native body arrives is not a disappearing message')
  await f.observe('unrelated-id')
  assert.equal(retired, 0)
  await f.observe(pending.requestId)
  assert.equal(retired, 1); assert.equal(f.face.getSnapshot().pendingSubmissions.length, 0)
  await f.setQueue([queued])
  assert.equal(queueInbox(f.face)?.['next-turn'].length, 0, 'a late stale queue read cannot duplicate the native message')
  assert.equal(writes, 1)
  assert.equal(f.actions.get(f.session.id, 'composer')?.request.operationId, pending.requestId)
  assert.equal(f.actions.get(f.session.id, 'composer')?.phase, 'accepted')
})

test('native source observation cannot retire the dock before the submitting official Pane body publishes', async t => {
  const f = await fixture(t, async () => ({ status: 'accepted', message: 'Queued' }))
  const chat = officialChat()
  t.after(() => chat.close())
  chat.assembler.replaceWindow([], false); chat.assembler.activateTarget('chat'); chat.assembler.flush()
  const pane = new Pane(f.face, Promise.resolve({} as never), 'submitting-pane')
  t.after(() => pane.dispose())
  let state: HistoryViewSnapshotV1 = { revision: 1, phase: 'ready', failure: null, busy: false, hasBefore: false, hasAfter: false,
    headChanged: false, version: 'original-body-window', entries: [], correction: 'applied', correctionError: null }
  const listeners = new Set<() => void>()
  pane.attach({ reads: { get: () => chat.assembler.snapshot('chat') }, snapshot: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } } as unknown as ConversationHistoryViewV1)
  let accepted = 0, retired = 0
  const text = 'Keep this visible until the original native body publishes'
  const pending = pane.beginSubmission({ mode: 'queue', text, attachments: [], onAccept: () => accepted++, onRetire: () => retired++ })
  assert.equal((await pane.prompt([{ type: 'text', text }], 'queue', undefined, pending.requestId)).ok, true)
  assert.equal(accepted, 1)
  await f.observe(pending.requestId)
  assert.equal(retired, 0)
  assert.equal(pane.getSnapshot().pendingSubmissions[0]?.text, text, 'canonical delivery is not an official Pane publication')
  state = { ...state, revision: 2, version: 'committed-native-body-window', entries: f.entries() }
  for (const listener of [...listeners]) listener()
  assert.equal(retired, 0, 'a reading-page entry without the official exact node payload cannot retire the dock')
  chat.assembler.replaceWindow(f.entries(), false); chat.assembler.flush()
  for (const listener of [...listeners]) listener()
  assert.equal(retired, 1)
  assert.equal(pane.getSnapshot().pendingSubmissions.length, 0)
})

test('restored owner admission occupies one native queue row until the exact official body takes over', async t => {
  let writes = 0, nativeWrites = 0
  const outbox = new RemoteOutbox(async operation => {
    writes++
    return { sessionId: operation.sessionId, operationId: operation.operationId, status: 'accepted', message: 'Internal owner receipt',
      ownerAdmission: { localId: operation.operationId, state: 'queued' } }
  }, undefined, undefined, memoryOperations)
  t.after(() => outbox.dispose())
  outbox.setStorage({ storage: new BrowserStorage(), scope: 'restored-owner-delivery' })
  const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVwAAAABJRU5ErkJggg==' }
  const saved = { sessionId: 'hhpi:machine:source:codex:thread', operationId: 'previously-admitted-native-input', kind: 'send' as const, text: 'Keep the original text in native Queue', images: [image] }
  const f = await fixture(t, async () => { nativeWrites++; throw new Error('Restored input must never use another carrier') }, undefined, { outbox })
  outbox.acceptCatalog([f.session]); await outbox.admit(saved); outbox.start(saved.operationId)
  const view = outbox.view(saved.sessionId)
  await new Promise<void>(resolve => { const stop = view.subscribe(() => { if (outbox.get(saved.operationId)?.state === 'owner-accepted') { stop(); resolve() } }) })

  // Construct another real Session face from the same persisted owner receipt.
  const restored = await fixture(t, async () => { nativeWrites++; throw new Error('Restored input must never use another carrier') }, undefined, { outbox })
  const chat = officialChat(); t.after(() => chat.close())
  chat.assembler.replaceWindow([], false); chat.assembler.activateTarget('chat'); chat.assembler.flush()
  const pane = new Pane(restored.face, Promise.resolve({} as never), 'restored-delivery-pane'); t.after(() => pane.dispose())
  let state: HistoryViewSnapshotV1 = { revision: 1, phase: 'ready', failure: null, busy: false, hasBefore: false, hasAfter: false,
    headChanged: false, version: 'restored-body-window', entries: [], correction: 'applied', correctionError: null }
  const listeners = new Set<() => void>()
  pane.attach({ reads: { get: () => chat.assembler.snapshot('chat') }, snapshot: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } } as unknown as ConversationHistoryViewV1)
  assert.equal(pane.getSnapshot().pendingSubmissions[0]?.text, saved.text)
  assert.equal(pane.getSnapshot().pendingSubmissions[0]?.placement, 'queued')
  assert.deepEqual(pane.getSnapshot().pendingSubmissions[0]?.attachments, [{ type: 'image', value: { previewUrl: `data:${image.mediaType};base64,${image.data}` } }], 'a restored image keeps its actual retained bytes in the native pending row')
  const row = { id: 'native-owner-queue-id', clientUserMessageId: saved.operationId, input: [{ type: 'text', text: saved.text, text_elements: [] as never[] }] }
  await restored.setQueue([row])
  assert.equal(queueInbox(restored.face)?.['next-turn'][0]?.source.rpcId, saved.operationId)
  await restored.setQueue([])
  assert.equal(pane.getSnapshot().pendingSubmissions[0]?.text, saved.text)
  await restored.observe(saved.operationId)
  outbox.observe(saved.sessionId, restored.entries())
  assert.equal(pane.getSnapshot().pendingSubmissions[0]?.text, saved.text, 'receipt retirement cannot remove the only visible occurrence')
  state = { ...state, revision: 2, entries: restored.entries() }
  for (const listener of [...listeners]) listener()
  assert.equal(pane.getSnapshot().pendingSubmissions.length, 1, 'source page arrival is not official body publication')
  chat.assembler.replaceWindow(restored.entries(), false); chat.assembler.flush()
  for (const listener of [...listeners]) listener()
  assert.equal(pane.getSnapshot().pendingSubmissions.length, 0)
  assert.equal(queueInbox(restored.face)?.['next-turn'].length, 0)
  assert.equal(writes, 1); assert.equal(nativeWrites, 0)
})

test('restored consumed admission retires before the current committed window only in its confirmed source epoch', async t => {
  let writes = 0, lookups = 0, disconnected = true
  let proof: SourceReceipt['observed'] | undefined
  const saved = { sessionId: 'hhpi:machine:source:codex:thread', operationId: 'old-consumed-admission', kind: 'send' as const, text: 'Old already-consumed input' }
  const outbox = new RemoteOutbox(async operation => {
    writes++
    return { sessionId: operation.sessionId, operationId: operation.operationId, status: 'accepted', message: 'Owner receipt',
      ownerAdmission: { localId: operation.operationId, state: 'queued' } }
  }, async operation => {
    lookups++
    if (disconnected) throw new Error('Original receipt connection interrupted')
    return proof ? { sessionId: operation.sessionId, operationId: operation.operationId, status: 'accepted', message: 'Consumed', observed: proof } : null
  }, undefined, memoryOperations)
  t.after(() => outbox.dispose())
  outbox.setStorage({ storage: new BrowserStorage(), scope: 'old-consumed-admission' })
  const original = await fixture(t, async () => { throw new Error('No native submission is allowed') }, undefined, { outbox })
  outbox.acceptCatalog([original.session]); await outbox.admit(saved); outbox.start(saved.operationId)
  const delivery = outbox.view(saved.sessionId)
  await new Promise<void>(resolve => { const stop = delivery.subscribe(() => {
    if (outbox.get(saved.operationId)?.state === 'owner-accepted') { stop(); resolve() }
  }) })
  original.face.dispose()
  const restored = await fixture(t, async () => { throw new Error('Restoring must never replay input') }, undefined, { outbox })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(lookups, 1, 'reopening performs one coalesced read-only receipt check')
  assert.equal(restored.face.getSnapshot().pendingSubmissions[0]?.text, saved.text, 'unknown consumption retains the original pending content')
  await restored.observe('earlier-unrelated-input')
  await restored.observe('current-official-input')
  const feed = await restored.history.openView('old-admission-pane', { events: 100, bytes: 100000, nodes: 100 }, undefined,
    'old-admission-pane', { kind: 'around', seq: 1 })
  const chat = officialChat(); t.after(() => chat.close())
  chat.assembler.replaceWindow(feed.initial.entries, false); chat.assembler.activateTarget('chat'); chat.assembler.flush()
  assert.equal(feed.initial.entries[0]?.event.seq, 1)
  const pane = new Pane(restored.face, Promise.resolve({} as never), 'old-admission-pane'); t.after(() => pane.dispose())
  const state: HistoryViewSnapshotV1 = { revision: 1, phase: 'ready', failure: null, busy: false, hasBefore: false, hasAfter: false,
    headChanged: false, version: feed.initial.version, entries: feed.initial.entries, correction: 'applied', correctionError: null }
  const listeners = new Set<() => void>()
  pane.attach({ viewId: feed.viewId, reads: { get: () => chat.assembler.snapshot('chat') },
    snapshot: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } } as unknown as ConversationHistoryViewV1)
  disconnected = false; proof = { epoch: 'epoch', seq: 0 }
  restored.face.update({ ...restored.face.metadata.getSnapshot(), updatedAt: restored.face.metadata.getSnapshot().updatedAt + 1 })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(lookups, 2, 'the existing successful metadata refresh rechecks the original receipt after a disconnected lookup without reopening')
  assert.equal(pane.getSnapshot().pendingSubmissions.length, 1, 'an arrived body page and assembled nodes without official publication cannot retire the old item')
  proof = { epoch: 'different-epoch', seq: 0 }; await outbox.checkOwnerAdmission(saved.operationId)
  feed.publication!.accept(feed.initial.version)
  for (const listener of [...listeners]) listener()
  assert.equal(pane.getSnapshot().pendingSubmissions.length, 1, 'a position from another source epoch cannot settle the restored input')
  proof = { epoch: 'epoch', seq: 0 }; await outbox.checkOwnerAdmission(saved.operationId)
  assert.equal(pane.getSnapshot().pendingSubmissions.length, 0, 'the same source consumed this old item before the current official committed window')
  assert.equal(outbox.get(saved.operationId), undefined, 'the settled old receipt cannot resurrect on the next reopen')
  assert.equal(writes, 1, 'only the original admission dispatched input; all recovery checks were read-only')
})

test('native dock edit and remove mutate only the original source row and update the handoff fallback', async t => {
  const calls: CodexCall[] = []
  const f = await fixture(t, async request => {
    calls.push(request)
    if (request.method === 'thread/queue/update') await f.setQueue([{ ...row, input: request.params?.input as typeof row.input }])
    return { status: 'accepted', message: 'Native item updated' }
  })
  const original = 'Original queued input', edited = 'Edited original queued input'
  const pending = f.face.beginSubmission({ mode: 'queue', text: original, content: [{ type: 'text', text: original }], attachments: [] })
  await f.face.prompt([{ type: 'text', text: original }], 'queue', undefined, pending.requestId)
  const row = { id: 'native-item-edit-remove', clientUserMessageId: pending.requestId,
    input: [{ type: 'text', text: original, text_elements: [] as never[] }] }
  await f.setQueue([row])
  assert.equal((await f.face.updateQueue(row.id as never, { kind: 'steer' })).ok, false)
  assert.equal(calls.length, 1, 'queue/start is never substituted for running-turn steer')
  assert.equal((await f.face.updateQueue(row.id as never, { kind: 'edit', content: [{ type: 'text', text: edited }] })).ok, true)
  assert.deepEqual(calls[1]?.params, { threadId: 'thread', queuedSubmissionId: row.id, input: [{ type: 'text', text: edited, text_elements: [] }] })
  assert.equal(calls[1]?.method, 'thread/queue/update')
  assert.equal(f.face.getSnapshot().pendingSubmissions[0]?.text, edited)
  await f.setQueue([{ ...row, input: [{ type: 'text', text: edited, text_elements: [] }] }])
  assert.equal((await f.face.updateQueue(row.id as never, { kind: 'remove' })).ok, true)
  assert.equal(calls[2]?.method, 'thread/queue/delete')
  assert.deepEqual(calls[2]?.params, { threadId: 'thread', queuedSubmissionId: row.id })
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 0)
  assert.equal(queueInbox(f.face)?.['next-turn'].length, 0, 'late queue reads cannot resurrect an explicitly removed original')
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1)
})

test('native dock edits attachment text without dropping or flattening original native parts', async t => {
  const calls: CodexCall[] = []
  let sourceRow: NativeQueueItem
  const f = await fixture(t, async request => {
    calls.push(request)
    if (request.method === 'thread/queue/update') {
      sourceRow = { ...sourceRow, input: request.params!.input as NativeQueueItem['input'] }
      await f.setQueue([sourceRow])
    }
    return { status: 'accepted', message: 'Native item updated' }
  })
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'before', attachments: [
    { type: 'file', value: { attachmentId: 'original-file' as never, name: 'owned.txt', bytes: 12 } },
  ] })
  await f.face.prompt([{ type: 'text', text: 'before' }], 'queue', undefined, pending.requestId)
  const image = { type: 'localImage', path: '/source/original.png', detail: 'original' }
  const skill = { type: 'skill', name: 'Review', path: '/source/SKILL.md' }
  const mention = { type: 'mention', name: 'Original file', path: '/source/owned.txt' }
  sourceRow = { id: 'native-mixed', clientUserMessageId: pending.requestId,
    input: [image, { type: 'text', text: 'before', text_elements: [] }, skill, mention] }
  await f.setQueue([sourceRow])
  const availability = f.face.projections.faceOf('queueActions').getSnapshot()?.[sourceRow.id]
  assert.equal(availability?.edit, true, 'attachments do not blanket-disable native queue editing')
  assert.equal(availability?.editText, 'before', 'display labels are not editable native text')
  assert.equal((await f.face.updateQueue(sourceRow.id as never, { kind: 'edit', content: [{ type: 'text', text: 'after' }] })).ok, true)
  assert.deepEqual(calls.at(-1)?.params?.input, [image, { type: 'text', text: 'after', text_elements: [] }, skill, mention])
  assert.equal(calls.at(-1)?.params?.queuedSubmissionId, 'native-mixed')
  assert.equal(f.face.getSnapshot().pendingSubmissions[0]?.attachments[0]?.type, 'file')
  assert.equal((await f.face.updateQueue(sourceRow.id as never, { kind: 'remove' })).ok, true)
  assert.equal(calls.at(-1)?.method, 'thread/queue/delete')
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1)
})

test('source-owned queued steering uses original queue identity and keeps the native dock until exact body handoff', async t => {
  const calls: CodexCall[] = []
  const f = await fixture(t, async request => {
    calls.push(request)
    if (request.method === 'hhpi/queue/steer') await f.setQueue([{ ...row, hhpiDelivery: 'sending' } as unknown as NativeQueueItem])
    return { status: 'accepted', message: 'Native transfer accepted' }
  }, undefined, { queuedSteer: true })
  const pending = f.face.beginSubmission({ mode: 'queue', text: 'Steer original', attachments: [] })
  assert.equal(f.face.projections.faceOf('queueActions').getSnapshot()?.[pending.requestId]?.delivery, 'sending')
  await f.face.prompt([{ type: 'text', text: 'Steer original' }], 'queue', undefined, pending.requestId)
  const row = { id: 'native-steer-original', clientUserMessageId: pending.requestId, input: [{ type: 'text', text: 'Steer original', text_elements: [] }] }
  await f.setQueue([row])
  assert.equal(f.face.projections.faceOf('queueActions').getSnapshot()?.[row.id]?.steer, true)
  assert.equal((await f.face.updateQueue(row.id as never, { kind: 'steer' })).ok, true)
  assert.deepEqual(calls.at(-1)?.params, { threadId: 'thread', expectedTurnId: 'exact-active-turn', queuedSubmissionId: row.id,
    clientUserMessageId: pending.requestId, input: row.input })
  assert.equal(queueInbox(f.face)?.['next-turn'][0]?.id, row.id)
  assert.equal(f.face.projections.faceOf('queueActions').getSnapshot()?.[row.id]?.delivery, 'sending')
  assert.equal(f.face.projections.faceOf('queueActions').getSnapshot()?.[row.id]?.steer, false)
  assert.equal((await f.face.updateQueue(row.id as never, { kind: 'remove' })).ok, false, 'an in-flight transfer is not a second queue write')
  await f.observe(pending.requestId)
  assert.equal(queueInbox(f.face)?.['next-turn'].length, 0)
  assert.equal(f.face.getSnapshot().pendingSubmissions.length, 0)
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1)
  assert.equal(calls.filter(call => call.method === 'hhpi/queue/steer').length, 1)
})

test('an original source transfer can continue its never-attempted step after the captured turn becomes idle', async t => {
  const calls: CodexCall[] = []
  const f = await fixture(t, async request => { calls.push(request); return { status: 'accepted', message: 'Original transfer continued' } }, undefined, { queuedSteer: true })
  const row = { id: 'resume-original-item', clientUserMessageId: 'original-client', input: [{ type: 'text', text: 'Original transfer input', text_elements: [] }],
    hhpiResumeOperationId: 'source-retained-transfer', hhpiResumeTurnId: 'original-captured-turn', hhpiTransferHeld: true }
  f.face.update({ ...f.face.metadata.getSnapshot(), status: 'idle', activeTurnId: null,
    capabilities: { ...f.face.metadata.getSnapshot().capabilities, steer: false } })
  await f.setQueue([row])
  assert.equal(f.face.getSnapshot().running, false)
  const actions = f.face.projections.faceOf('queueActions').getSnapshot()?.[row.id]
  assert.equal(actions?.steer, true)
  assert.equal(actions?.edit, false); assert.equal(actions?.remove, false)
  assert.equal((await f.face.updateQueue(row.id as never, { kind: 'steer' })).ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.params, { threadId: 'thread', queuedSubmissionId: row.id, expectedTurnId: 'original-captured-turn',
    clientUserMessageId: 'original-client', input: row.input, resumeOperationId: 'source-retained-transfer' })
})

test('a failed fresh queue read keeps confirmed text visible and prevents a stale write', async t => {
  const calls: CodexCall[] = []
  const f = await fixture(t, async request => { calls.push(request); return { status: 'accepted', message: 'Unexpected mutation' } })
  const row = { id: 'source-existing', clientUserMessageId: 'foreign-original-id', input: [{ type: 'text', text: 'Existing queue text', text_elements: [] as never[] }] }
  await f.setQueue([row])
  f.failQueueReads(new Error('Queue read transport interrupted'))
  const result = await f.face.updateQueue(row.id as never, { kind: 'remove' })
  assert.equal(result.ok, false)
  assert.equal(queueInbox(f.face)?.['next-turn'][0]?.id, row.id)
  assert.equal(calls.length, 0)
})

test('source queue reconstruction and reconnect only read and uncertain native removal is never retried', async t => {
  const calls: CodexCall[] = []
  const f = await fixture(t, async request => { calls.push(request); return { status: 'indeterminate', message: 'Original outcome unknown' } })
  const row = { id: 'source-owned-before-mount', clientUserMessageId: 'original-before-mount', input: [{ type: 'text', text: 'Already queued', text_elements: [] as never[] }] }
  await f.setQueue([row])
  f.face.update({ ...f.face.metadata.getSnapshot(), status: 'offline' })
  await f.setQueue([row])
  f.face.update({ ...f.face.metadata.getSnapshot(), status: 'idle' })
  await f.setQueue([row])
  assert.equal(calls.length, 0)
  assert.equal(queueInbox(f.face)?.['next-turn'][0]?.id, row.id)
  assert.equal((await f.face.updateQueue(row.id as never, { kind: 'remove' })).ok, false)
  assert.equal((await f.face.updateQueue(row.id as never, { kind: 'remove' })).ok, false)
  assert.equal(calls.length, 1)
  assert.equal(queueInbox(f.face)?.['next-turn'][0]?.id, row.id)
})

for (const settlement of ['remove', 'body'] as const) test(`same-draft unknown retry keeps one native identity through edit and ${settlement}`, async t => {
  const calls: CodexCall[] = [], receipts: CodexCall[] = []
  let queued: { id: string; clientUserMessageId: string; input: Array<{ type: string; text: string; text_elements: never[] }> }
  const f = await fixture(t, async request => {
    calls.push(request)
    if (request.method === 'thread/queue/add') return { status: 'indeterminate', message: 'Original receipt lost' }
    if (request.method === 'thread/queue/update') {
      queued = { ...queued, input: request.params?.input as typeof queued.input }
      await f.setQueue([queued])
    }
    return { status: 'accepted', message: 'Original queue item changed' }
  }, undefined, { receipt: async request => { receipts.push(request); return { status: 'accepted', message: 'Original admission confirmed' } } })
  const chat = officialChat(), pane = new Pane(f.face, Promise.resolve({} as never), 'retrying-pane')
  t.after(() => { pane.dispose(); return chat.close() })
  chat.assembler.replaceWindow([], false); chat.assembler.activateTarget('chat'); chat.assembler.flush()
  let window: HistoryViewSnapshotV1 = { revision: 1, phase: 'ready', failure: null, busy: false, hasBefore: false, hasAfter: false,
    headChanged: false, version: 'before-retried-body', entries: [], correction: 'applied', correctionError: null }
  const listeners = new Set<() => void>()
  pane.attach({ reads: { get: () => chat.assembler.snapshot('chat') }, snapshot: { getSnapshot: () => window,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } } as unknown as ConversationHistoryViewV1)
  const text = 'Same retained draft after an unknown send', prompt: SessionPromptContentPart[] = [{ type: 'text', text }]
  const accepted: string[] = [], retired: string[] = []
  const original = pane.beginSubmission({ mode: 'queue', text, content: prompt, attachments: [], onAccept: () => accepted.push('A'), onRetire: () => retired.push('A') })
  assert.equal((await pane.prompt(prompt, 'queue', undefined, original.requestId)).ok, false)
  const retry = pane.beginSubmission({ mode: 'queue', text, content: prompt, attachments: [], onAccept: () => accepted.push('B'), onRetire: () => retired.push('B') })
  assert.notEqual(retry.requestId, original.requestId)
  assert.equal((await pane.prompt(prompt, 'queue', undefined, retry.requestId)).ok, true)
  assert.deepEqual(accepted, ['A', 'B'])
  assert.deepEqual(receipts, [calls[0]], 'retry only checks the original immutable operation')
  assert.deepEqual(pane.getSnapshot().pendingSubmissions.map(item => item.requestId), [original.requestId], 'B is an alias, never a second sending row')
  queued = { id: 'native-original-after-unknown', clientUserMessageId: original.requestId, input: [{ type: 'text', text, text_elements: [] }] }
  await f.setQueue([queued])
  assert.equal(queueInbox(f.face)?.['next-turn'].length, 1)
  assert.equal(queueInbox(f.face)?.['next-turn'][0]?.source.kind === 'user' && 'rpcId' in queueInbox(f.face)!['next-turn'][0]!.source
    ? (queueInbox(f.face)!['next-turn'][0]!.source as { rpcId: string }).rpcId : undefined, original.requestId)
  assert.deepEqual(pane.getSnapshot().pendingSubmissions.map(item => item.requestId), [original.requestId], 'the native source row deduplicates every local retry')
  assert.equal((await pane.prompt(prompt, 'queue', undefined, retry.requestId)).ok, true)
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1, 'a confirmed B handle still resolves to original A')
  const edited = 'Edited the one original native item'
  assert.equal((await pane.updateQueue(queued.id as never, { kind: 'edit', content: [{ type: 'text', text: edited }] })).ok, true)
  assert.equal(calls.at(-1)?.params?.queuedSubmissionId, queued.id)
  assert.equal(pane.getSnapshot().pendingSubmissions[0]?.text, edited)
  if (settlement === 'remove') {
    assert.equal((await pane.updateQueue(queued.id as never, { kind: 'remove' })).ok, true)
    assert.equal(calls.at(-1)?.params?.queuedSubmissionId, queued.id)
    assert.equal(queueInbox(f.face)?.['next-turn'].length, 0)
  } else {
    await f.setQueue([])
    await f.observe(original.requestId)
    assert.deepEqual(retired, [])
    assert.equal(pane.getSnapshot().pendingSubmissions[0]?.text, edited)
    window = { ...window, entries: f.entries(), revision: 2, version: 'retried-native-body-committed' }
    for (const listener of [...listeners]) listener()
    assert.deepEqual(retired, [], 'raw body delivery cannot retire either local alias')
    chat.assembler.replaceWindow(f.entries(), false); chat.assembler.flush()
    for (const listener of [...listeners]) listener()
  }
  assert.deepEqual(retired, ['A', 'B'], 'the original removal/body settles every local callback exactly once')
  assert.deepEqual(pane.getSnapshot().pendingSubmissions, [])
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1)
})
