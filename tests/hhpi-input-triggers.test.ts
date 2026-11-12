import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { SourceSession } from '../src/remote/protocol.ts'
import type { CodexCall } from '../src/remote/codex-access.ts'
import { NativeActionOwner } from '../src/client/remote-native-actions.ts'
import { SourceDirectory } from '../src/client/source-capabilities.ts'
import type { RemoteSourceSession } from '../src/client/remote-sessions.ts'
import { BrowserStorage } from './fixtures/browser-storage.ts'
import { codexInputSources } from '../src/client/remote-input-triggers.ts'
const id = 'hhpi:machine:source:codex:thread' as SessionId
const source: SourceSession = { id, machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread', cwd: '/workspace',
  title: 'Fixture input', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [],
  capabilities: { send: true, steer: false, cancel: false, approve: false, files: true },
  codex: { model: 'fixture', reasoningEffort: 'medium', parentThreadId: null, agentNickname: null } }
const signal = new AbortController().signal
const session = { sessionId: id }

test('native slash submission preserves the original request after a lost reply and never blindly resends', async t => {
  const calls: CodexCall[] = [], receipts: CodexCall[] = []
  const api = { async nativeCapabilities() { return { ok: true, value: { methods: { 'thread/compact/start': 'write' }, unavailable: {} } } }, async nativeCall(request: CodexCall) { calls.push(request); throw new Error('lost reply') },
    async nativeReceipt(request: CodexCall) { receipts.push(request); return { ok: true, value: { status: 'accepted', message: 'confirmed' } } } } as unknown as HhpiRemoteApi
  const owner = new NativeActionOwner({ call: async request => { const result = await api.nativeCall!(request); if (!result.ok) throw result.error; return result.value }, receipt: async request => { const result = await api.nativeReceipt!(request); if (!result.ok) throw result.error; return result.value } })
  owner.setStorage({ storage: new BrowserStorage(), scope: 'commands' })
  const directory = new SourceDirectory(api, 'source')
  t.after(() => { owner.dispose(); directory.dispose() })
  const sessionOwner = { nativeActions: owner, sourceDirectory: () => directory } as unknown as RemoteSourceSession
  const [slash] = codexInputSources(api, value => value === id ? source : undefined, () => true, () => sessionOwner)
  const picked = slash!.onPick({ session, candidate: { name: 'compact' }, position: 'leading', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 0 } })
  assert.ok(picked && picked !== 'handled' && 'claim' in picked)
  const ctx = {} as Context
  assert.equal((await picked.claim.submit('', ctx, [])).kind, 'error')
  assert.equal((await picked.claim.submit('changed', ctx, []))?.kind, 'error')
  assert.equal((await picked.claim.submit('', ctx, []))?.kind, 'success')
  assert.equal(calls.length, 1); assert.deepEqual(receipts, calls)
  assert.equal(calls[0]?.params?.threadId, 'thread')
  assert.deepEqual(await slash!.candidates({ sessionId: 'ordinary' as SessionId }, { query: '', position: 'leading', drilled: false, signal }), [])
})

test('at-reference candidates read the native workspace and serialize the selected path through the official codec', async () => {
  const calls: CodexCall[] = []
  const api = { async nativeCall(request: CodexCall) { calls.push(request); return { ok: true, value: { status: 'accepted', result: request.method === 'fs/readDirectory'
    ? { entries: [{ fileName: 'hello world.txt', isFile: true, isDirectory: false }] }
    : { files: [{ path: 'src/index.ts', root: '/workspace' }] } } } } } as unknown as HhpiRemoteApi
  const [, at] = codexInputSources(api, () => source, () => true)
  const rows = await at!.candidates(session, { query: '', position: 'inline', drilled: false, signal })
  const pick = at!.onPick({ session, candidate: rows[0]!, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 0 } })
  assert.ok(pick && pick !== 'handled' && 'insert' in pick)
  assert.equal(pick.insert.ref, '/workspace/hello world.txt')
  assert.equal(await at!.codec!.serialize(pick.insert.ref, signal), 'Referenced workspace path: "/workspace/hello world.txt"')
  await at!.candidates(session, { query: 'index', position: 'inline', drilled: false, signal })
  assert.deepEqual(calls.map(call => [call.method, call.params]), [['fs/readDirectory', { path: '/workspace' }], ['fuzzyFileSearch', { query: 'index', roots: ['/workspace'] }]])
})


test('retained Pane command candidates use their bound source even without a canonical owner in the installer context', async () => {
  const [slash] = codexInputSources({} as HhpiRemoteApi, () => undefined, () => true)
  const binding = { session: { metadata: { getSnapshot: () => source } } } as unknown as import('@deepseek-ai/dsh-api-session-controller/client').SessionBinding
  const rows = await slash!.candidates({ sessionId: id, binding }, { query: 'compact', position: 'leading', drilled: false, signal })
  assert.deepEqual(rows.map(row => row.name), ['compact'])
})


test('effort slash command uses the native effort field through the shared settings intent', async t => {
  const calls: CodexCall[] = []
  const api = { async nativeCapabilities() { return { ok: true, value: { methods: { 'thread/settings/update': 'write' }, unavailable: {} } } } } as unknown as HhpiRemoteApi
  const actions = new NativeActionOwner({ async call(request) { calls.push(request); return { status: 'accepted', message: 'updated' } }, async receipt() { throw new Error('unused') } })
  actions.setStorage({ storage: new BrowserStorage(), scope: 'effort' })
  const directory = new SourceDirectory(api, 'source')
  t.after(() => { actions.dispose(); directory.dispose() })
  const [slash] = codexInputSources(api, () => source, () => true, () => ({ nativeActions: actions, sourceDirectory: () => directory }) as unknown as RemoteSourceSession)
  // nativeCall is supplied by the canonical action owner, not by the command surface.
  api.nativeCall = async () => { throw new Error('The command must not bypass its operation owner') }
  const pick = slash!.onPick({ session, candidate: { name: 'effort' }, position: 'leading', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 0 } })
  assert.ok(pick && pick !== 'handled' && 'claim' in pick)
  assert.equal((await pick.claim.submit('xhigh', {} as Context, [])).kind, 'success')
  assert.deepEqual(calls[0]?.params, { threadId: 'thread', effort: 'xhigh' })
  assert.equal(actions.get(id, 'settings')?.request.operationId, calls[0]?.operationId)
})

test('skill and plugin picks keep typed references bound to their own Pane and exclude disabled entries', async t => {
  const calls: CodexCall[] = []
  const api = { async nativeCapabilities() { return { ok: true, value: { methods: { 'skills/list': 'read', 'plugin/installed': 'read' }, unavailable: {} } } },
    async nativeCall(request: CodexCall) { calls.push(request); return { ok: true, value: { status: 'accepted', result: request.method === 'skills/list'
      ? { data: [{ cwd: '/workspace', skills: [{ name: 'review', path: '/skills/exact/SKILL.md', enabled: true, description: 'Review source' }, { name: 'disabled', path: '/skills/disabled/SKILL.md', enabled: false }] }] }
      : { marketplaces: [{ name: 'team', plugins: [{ name: 'mail', installed: true, enabled: true, availability: 'AVAILABLE' }, { name: 'off', installed: true, enabled: false, availability: 'AVAILABLE' }] }] } } } } } as unknown as HhpiRemoteApi
  const directory = new SourceDirectory(api, 'source')
  t.after(() => directory.dispose())
  const binding = { session: { metadata: { getSnapshot: () => source }, sourceDirectory: () => directory } } as unknown as import('@deepseek-ai/dsh-api-session-controller/client').SessionBinding
  const bound = { sessionId: id, binding }
  const sources = codexInputSources(api, () => { throw new Error('A Pane must not use the canonical source') }, () => true)
  for (const [name, expected] of [['codex-skills', { type: 'reference', source: 'hhpi:codex:skill', ref: '/skills/exact/SKILL.md', label: 'review' }],
    ['codex-plugins', { type: 'reference', source: 'hhpi:codex:plugin', ref: 'plugin://mail@team', label: 'mail' }]] as const) {
    const provider = sources.find(value => value.name === name)!
    const rows = await provider.candidates(bound, { query: '', position: 'inline', drilled: false, signal })
    assert.equal(rows.length, 1)
    const pick = provider.onPick({ session: bound, candidate: rows[0]!, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 0 } })
    assert.ok(pick && pick !== 'handled' && 'insert' in pick)
    assert.deepEqual(await provider.codec!.serialize(pick.insert.ref, signal, bound), expected)
  }
  assert.deepEqual(calls.map(call => [call.method, call.params]), [['skills/list', { cwds: ['/workspace'] }], ['plugin/installed', { cwds: ['/workspace'] }]])
})
