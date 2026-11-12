/** Real native action owner and source directory; only authenticated RPC/receipt and upload IO are fixtures. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { SessionPromptContentPart } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { SourceSession } from '../src/remote/protocol.ts'
import type { CodexCall, CodexCallResult } from '../src/remote/codex-access.ts'
import { NativeActionOwner } from '../src/client/remote-native-actions.ts'
import { SourceDirectory } from '../src/client/source-capabilities.ts'
import { CODEX_SKILL_REFERENCE, CODEX_PLUGIN_REFERENCE, submitRemoteStructuredInput, type NativeComposerInput } from '../src/client/remote-structured-input.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'

const metadata = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', nativeId: 'thread', cwd: '/workspace', engine: 'codex', status: 'running',
  activeTurnId: 'exact-turn', codex: { model: 'fixture' } } as SourceSession
const content = (): SessionPromptContentPart[] => [{ type: 'text', text: 'Use ' }, { type: 'reference', source: CODEX_SKILL_REFERENCE, ref: '/skills/review/SKILL.md', label: 'Review' },
  { type: 'reference', source: CODEX_PLUGIN_REFERENCE, ref: 'plugin://mail@team', label: 'Mail' }, { type: 'image', mediaType: 'image/png', data: 'YQ==' }]
const catalog = (method: string): unknown => method === 'skills/list' ? { data: [{ cwd: '/workspace', skills: [{ name: 'review', path: '/skills/review/SKILL.md', enabled: true, description: 'Review code' }] }] }
  : { marketplaces: [{ name: 'team', plugins: [{ name: 'mail', enabled: true, installed: true, availability: 'AVAILABLE', interface: { displayName: 'Mail' } }] }] }
function fixture(t: TestContext, call: (request: CodexCall) => Promise<CodexCallResult> = async () => ({ status: 'accepted', message: 'native queue accepted' })) {
  const calls: CodexCall[] = [], receipts: CodexCall[] = [], storage = new BrowserStorage()
  const api = { async nativeCapabilities() { return { ok: true, value: { methods: { 'skills/list': 'read', 'plugin/installed': 'read', 'thread/queue/add': 'write', 'turn/steer': 'write' }, unavailable: {} } } },
    async nativeCall(request: CodexCall) { return { ok: true, value: { status: 'accepted', result: catalog(request.method) } } } } as unknown as HhpiRemoteApi
  const directory = new SourceDirectory(api, 'source')
  const transport = { async call(request: CodexCall) { calls.push(request); return call(request) }, async receipt(request: CodexCall) { receipts.push(request); return { status: 'accepted' as const, message: 'Original confirmed' } } }
  const actions = new NativeActionOwner(transport)
  actions.setStorage({ storage, scope: 'structured' })
  t.after(() => { actions.dispose(); directory.dispose() })
  return { actions, directory, calls, receipts, storage, transport, owner: { nativeActions: actions, sourceDirectory: () => directory } }
}

test('structured references, exact upload inputs and images enter one native queue request without text downgrades', async t => {
  const f = fixture(t), requests: Array<{receipts: string[]; operationId?: string}> = []
  const parts = [...content(), { type: 'file' as const, receiptId: '00000000-0000-4000-8000-000000000001' as never }]
  await submitRemoteStructuredInput(f.owner, metadata, parts, 'queue', 'composer-1', async (receipts, _signal, operationId) => {
    requests.push({ receipts: [...receipts], ...(operationId ? { operationId } : {}) }); return [{ type: 'localImage', path: '/native/uploads/exact.png' }]
  })
  assert.deepEqual(requests, [{ receipts: ['00000000-0000-4000-8000-000000000001'], operationId: 'composer-1' }])
  assert.deepEqual(f.calls, [{ sourceId: 'source', operationId: 'composer-1', method: 'thread/queue/add', params: { threadId: 'thread', clientUserMessageId: 'composer-1', input: [
    { type: 'text', text: 'Use ', text_elements: [] }, { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
    { type: 'mention', name: 'mail', path: 'plugin://mail@team' }, { type: 'image', url: 'data:image/png;base64,YQ==' }, { type: 'localImage', path: '/native/uploads/exact.png' },
  ] } }])
})

test('lost acknowledgement survives owner restart with image bytes in the transaction ledger and only original receipt recovery', async t => {
  const f = fixture(t, async () => { throw new Error('lost response') }), parts = content()
  ;(parts[3] as { data: string }).data = 'YQ=='.repeat(65_536)
  await assert.rejects(submitRemoteStructuredInput(f.owner, metadata, parts, 'queue', 'original-id', async () => []), /unknown/)
  const before = f.calls[0]!
  for (let i = 0; i < f.storage.length; i++) assert.ok(f.storage.getItem(f.storage.key(i)!)!.length < 300, 'localStorage holds pointers, not the image payload')
  f.actions.dispose()
  const restored = new NativeActionOwner(f.transport)
  restored.setStorage({ storage: f.storage, scope: 'structured' }); await restored.restore()
  t.after(() => restored.dispose())
  assert.equal(f.calls.length, 1); assert.equal(f.receipts.length, 0, 'restore must never send or reconcile by itself')
  assert.deepEqual(restored.get(metadata.id, 'composer')?.request, before)
  await submitRemoteStructuredInput({ ...f.owner, nativeActions: restored }, metadata, parts, 'queue', 'new-composer-attempt', async () => [])
  assert.equal(f.calls.length, 1); assert.deepEqual(f.receipts, [before]); assert.equal(restored.get(metadata.id, 'composer')?.phase, 'accepted')
})

test('a changed draft cannot replace uncertain native input, even when source metadata looks equal', async t => {
  const f = fixture(t, async () => ({ status: 'indeterminate', message: 'uncertain' }))
  await assert.rejects(submitRemoteStructuredInput(f.owner, metadata, content(), 'queue', 'original', async () => []), /uncertain/)
  const changed = content(); changed[0] = { type: 'text', text: 'Different instructions ' }
  await assert.rejects(submitRemoteStructuredInput(f.owner, { ...metadata }, changed, 'queue', 'replacement', async () => []), /original result/)
  assert.equal(f.calls.length, 1); assert.equal(f.receipts.length, 0); assert.equal(f.actions.get(metadata.id, 'composer')?.phase, 'confirming')
})

test('upload resolution failure or source revocation during resolution never dispatches the native write', async t => {
  const f = fixture(t), parts = [...content(), { type: 'file' as const, receiptId: '00000000-0000-4000-8000-000000000002' as never }]
  await assert.rejects(submitRemoteStructuredInput(f.owner, metadata, parts, 'queue', 'unresolved', async () => { throw new Error('receipt belongs to another session') }), /another session/)
  assert.equal(f.calls.length, 0); assert.equal(f.actions.get(metadata.id, 'composer'), undefined)
  const waiting = Promise.withResolvers<NativeComposerInput[]>(), entered = Promise.withResolvers<void>()
  const pending = submitRemoteStructuredInput(f.owner, metadata, parts, 'queue', 'revoked', async () => { entered.resolve(); return waiting.promise })
  await entered.promise; await f.actions.revokeSession(metadata.id); waiting.resolve([{ type: 'localImage', path: '/old/path' }])
  await assert.rejects(pending, /revoked/)
  assert.equal(f.calls.length, 0); assert.equal(f.actions.get(metadata.id, 'composer'), undefined)
})

test('native steering keeps the exact active turn and refuses a different delivery intent after uncertainty', async t => {
  const f = fixture(t, async () => ({ status: 'indeterminate', message: 'uncertain' }))
  await assert.rejects(submitRemoteStructuredInput(f.owner, metadata, content(), 'steer', 'steer-1', async () => []), /uncertain/)
  assert.equal(f.calls[0]?.method, 'turn/steer'); assert.equal(f.calls[0]?.params?.expectedTurnId, 'exact-turn')
  await assert.rejects(submitRemoteStructuredInput(f.owner, metadata, content(), 'queue', 'queue-1', async () => []), /different delivery mode/)
  assert.equal(f.calls.length, 1)
})

test('an account switch during upload resolution cannot admit the old draft into the new scope', async t => {
  const f = fixture(t), gate = Promise.withResolvers<NativeComposerInput[]>(), entered = Promise.withResolvers<void>()
  const pending = submitRemoteStructuredInput(f.owner, metadata, content(), 'queue', 'old-account', async () => { entered.resolve(); return gate.promise })
  await entered.promise
  f.actions.setStorage({ storage: f.storage, scope: 'another-account' })
  gate.resolve([])
  await assert.rejects(pending, /scope changed/)
  assert.equal(f.calls.length, 0); assert.equal(f.actions.get(metadata.id, 'composer'), undefined)
})
