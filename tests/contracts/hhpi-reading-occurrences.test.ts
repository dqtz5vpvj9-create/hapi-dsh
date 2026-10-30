/** Installed production Session/Renderer/Conversation/Input/Chat contracts.
 * Only source RPC, settings, locale and unused workspace/file services are fixtures.
 * No production reading, assembly, input shell or scope provider is replaced. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { prepareOfficialBrowserLibrary, resolveOfficialBrowserDependency } from './official-browser-library.ts'
import { SourceEventIndex, type EventInput } from '../../src/remote/event-index.ts'
import { sourceSessionId, type SourceOperation, type SourceSession } from '../../src/remote/protocol.ts'
import type { SessionBinding, SessionReference, ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteSessions } from '../../src/client/remote-sessions.ts'
import type { SourceSessions } from '../../src/client/source-sessions.ts'
import type { RemotePaneSession } from '../../src/client/remote-reading-session.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../..')
function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set(next: T) { value = next; for (const fn of listeners) fn() } }
}
function official(name: string): { apply(ctx: Context): void; inject: string[]; [key: string]: unknown } {
  const metadata = require(`${name}/package.json`)
  assert.equal(metadata.version, '0.2.1-rc.3')
  assert.ok(metadata.hhpiSourceExtension, `${name} must be an installed source build`)
  let registration: { factory(resolve: typeof require): ReturnType<typeof official> } | undefined
  new Function('window', readFileSync(require.resolve(`${name}/client`), 'utf8'))({ __ModuleLoader__: { load(value: typeof registration) { registration = value } } })
  assert.ok(registration)
  return registration.factory(resolveOfficialBrowserDependency)
}
async function facadeClasses() {
  const output = await build({ stdin: { contents: "export { RemoteSessions } from './src/client/remote-sessions.ts'; export { SourceSessions } from './src/client/source-sessions.ts';", resolveDir: root, loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
    external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} as { RemoteSessions: typeof RemoteSessions; SourceSessions: typeof SourceSessions } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
  return module.exports
}
const identity = { machineId: 'occurrence-machine', sourceId: 'native-codex', engine: 'codex', nativeId: 'one-native-thread' }
const metadata: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic occurrence source', cwd: '/synthetic', updatedAt: 1000, status: 'idle', activeTurnId: null,
  capabilities: { send: true, steer: true, cancel: true, approve: true, files: false }, pendingRequests: [] }
const message = (id: number): EventInput => ({ type: 'user/message', time: id, surfaceOp: 'append', data: { id: `message-${id}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `body-${id}` }] } } as EventInput)

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://synthetic.invalid/', pretendToBeVisual: true })
  const restored: (() => void)[] = []
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'localStorage', 'sessionStorage', 'getComputedStyle', 'DOMRect', 'Range']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(dom.window, key) })
    restored.push(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) })
  }
  const ctx = new Context(), index = new SourceEventIndex(':memory:', metadata), calls: unknown[] = [], writes: SourceOperation[] = []
  index.edit(metadata, () => { for (let i = 1; i <= 1440; ++i) index.put(`item-${i}`, message(i)) })
  const { RemoteSessions, SourceSessions } = await facadeClasses()
  const controllerRoot = resolve(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'), '..')
  const { createWindowCommitFactory } = require(resolve(controllerRoot, 'lib/types/client/sessions/window-commit.js'))
  const original = { list: store({ ids: [], byId: {}, phase: 'ready' }), windowCommit: createWindowCommitFactory(),
    binding: () => undefined, scope: () => undefined, scopeOf: () => undefined, sessionOf: () => undefined,
    retainInfo: () => store({ referenceCount: 0, retainedBy: {} }), searchResultLimit: 100, refresh: async () => {} } as unknown as ISessions
  const remote = new RemoteSessions(ctx, original, {
    catalog: async () => ({ ok: true, value: { protocol: 1, legacyHapi: false, sessions: [metadata], sources: [] } }),
    read: async request => { calls.push(request); return { ok: true, value: index.read(request) } },
    changes: (request, signal) => index.changes(request, signal),
    operate: async operation => { writes.push(operation); return { ok: true, value: { sessionId: operation.sessionId, operationId: operation.operationId, status: 'accepted', message: 'Accepted at synthetic wire boundary' } } },
  } as HhpiRemoteApi)
  const sessions = new SourceSessions(remote), references: SessionReference[] = []
  t.after(async () => {
    for (const reference of references.reverse()) reference.release()
    sessions.dispose(); remote.dispose()
    await ctx.fiber.dispose(); index.dispose(); dom.window.close()
    for (const restore of restored.reverse()) restore()
  })
  await remote.refresh()
  assert.equal(sessions.windowCommit, remote.windowCommit, 'outer facade must retain the actual commit coordinator')
  ctx.reflect.provide('sessions', sessions)
  ctx.reflect.provide('remote', { $on: () => () => {} } as unknown as Context['remote'])
  ctx.reflect.provide('remote.session', {} as never)
  ctx.reflect.provide('remoteAccess', { source: () => store(true) } as unknown as Context['remoteAccess'])
  const localeState = store({ revision: 0, active: 'en' })
  const locale = { ...localeState, register: () => () => {}, bind: () => (key: string) => key }
  ctx.reflect.provide('locale', locale as unknown as Context['locale'])
  ctx.reflect.provide('configForms', { get: () => ({ ...store({ value: {} }), set: async () => {} }), developerTools: { enabled: store(false) } } as unknown as Context['configForms'])
  ctx.reflect.provide('uiWorkspace', { openSession: () => {}, openWorkspace: async () => {} } as unknown as Context['uiWorkspace'])
  ctx.reflect.provide('fileUpload', {} as Context['fileUpload'])
  ctx.reflect.provide('sidebarRight', { openResource: () => {}, openTab: () => {} } as unknown as Context['sidebarRight'])
  await prepareOfficialBrowserLibrary()
  await ctx.plugin(official('@deepseek-ai/dsh-client-ui-renderer'))
  ctx.slots.installLocale({ ...localeState, bind: () => (key: string) => key })
  await ctx.plugin(official('@deepseek-ai/dsh-client-ui-session'))
  await ctx.plugin(official('@deepseek-ai/dsh-client-ui-conversation'))
  await ctx.plugin(official('@deepseek-ai/dsh-client-ui-chat'))
  const canonical = sessions.retain(metadata.id as SessionBinding['sessionId'], { source: 'hapiWorkspace' }); references.push(canonical)
  await canonical.ready
  async function open(id: string) {
    const reference = sessions.openReadingView(canonical, id)
    assert.ok(reference); references.push(reference)
    const binding = reference.binding, conversation = ctx.uiConversation.binding(binding), reading = conversation.readingView
    assert.ok(reading)
    ;(binding.session as RemotePaneSession).attach(reading)
    await reference.ready
    const scoped = ctx.uiSession.bindingSource(reference).getSnapshot()
    return { reference, binding, conversation, reading, scoped, input: ctx.conversation.input.for(binding.ctx) }
  }
  const body = (value: Awaited<ReturnType<typeof open>>) => {
    const chat = value.conversation.target('chat').getSnapshot()
    assert.ok(chat)
    return chat.order.flatMap(key => {
      const node = chat.nodes.get(key)
      if (!node) return []
      const data = node.data as { content?: readonly { text?: string }[]; blocks?: readonly { text?: string }[] }
      return [...(data.content ?? []), ...(data.blocks ?? [])].flatMap(block => typeof block.text === 'string' ? [block.text] : [])
    })
  }
  return { ctx, sessions, remote, canonical, calls, writes, open, body, index, dom }
}

test('all official readers and input shells use exact independent occurrences of one canonical Session', { timeout: 15000 }, async t => {
  const f = await fixture(t), a = await f.open('pane-a'), b = await f.open('pane-b')
  assert.equal(a.binding.sessionId, f.canonical.sessionId)
  assert.equal(b.binding.sessionId, f.canonical.sessionId)
  assert.notEqual(a.binding, b.binding); assert.notEqual(a.binding.ctx, b.binding.ctx)
  assert.equal(f.sessions.binding(f.canonical.sessionId), f.canonical.binding)
  assert.equal(a.scoped.owner, a.binding); assert.equal(b.scoped.owner, b.binding)
  assert.equal(a.scoped.injectionKey, f.canonical.sessionId)
  assert.equal(a.scoped.key, JSON.stringify([f.canonical.sessionId, 'pane-a']))
  assert.notEqual(a.scoped.key, b.scoped.key)
  assert.equal(a.scoped.props.sessionBinding, a.binding)
  assert.equal(a.scoped.hooks.conversation!.getSnapshot(), a.conversation.snapshot.getSnapshot())
  assert.equal(a.scoped.hooks.chat!.getSnapshot(), a.conversation.target('chat').getSnapshot())
  assert.notEqual(a.scoped.hooks.input, b.scoped.hooks.input)
  a.input.setDraft('Independent draft A'); b.input.setDraft('Independent draft B')
  assert.equal(a.input.state.getSnapshot().draft, 'Independent draft A')
  assert.equal(b.input.state.getSnapshot().draft, 'Independent draft B')
  assert.equal(f.body(a).length, 160); assert.equal(f.body(b).length, 160)
  const checkpoints: string[] = []
  assert.ok(a.conversation.windowCommit)
  const stopReader = a.conversation.windowCommit.register(a.binding.viewId!, {
    id: 'actual-occurrence-checkpoint',
    measure: () => { checkpoints.push('measure'); return { revision: 1, anchor: null, following: false, scrollTop: 0, clientHeight: 600, scrollHeight: 10000, nodes: 0, available: false } },
    correct: () => { checkpoints.push('correct') },
  })
  for (let i = 0; i < 6; ++i) await a.binding.session.loadOlder()
  stopReader()
  assert.deepEqual(checkpoints, Array.from({ length: 6 }, () => ['measure', 'correct']).flat())
  assert.equal(f.body(a).length, 1120); assert.equal(f.body(b).length, 160)
  assert.equal(new Set(f.body(a)).size, 1120)
  assert.equal(a.scoped.hooks.chat!.getSnapshot(), a.conversation.target('chat').getSnapshot())
  const before = f.calls.length
  await b.binding.session.loadOlder()
  assert.equal(f.body(b).length, 320); assert.equal(f.calls.length, before)
  assert.equal(a.input.state.getSnapshot().draft, 'Independent draft A')
  assert.equal(b.input.state.getSnapshot().draft, 'Independent draft B')
  const pending = a.binding.session.beginSubmission({ text: 'Native target A', attachments: [], mode: 'queue' })
  const outcome = await a.binding.session.prompt([{ type: 'text', text: 'Native target A' }], 'queue', undefined, pending.requestId)
  assert.equal(outcome.ok, true)
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.sessionId, f.canonical.sessionId)
  const oldScope = a.binding.ctx, oldSession = a.binding.session
  a.reference.release()
  assert.equal(f.sessions.ownsBinding(a.binding), false)
  assert.equal(f.sessions.bindingOf(oldScope), undefined)
  assert.equal(f.sessions.sessionOf(oldScope), undefined)
  assert.throws(() => f.ctx.uiConversation.binding(a.binding), /inactive/)
  await assert.rejects(oldSession.loadOlder(), /released/)
  assert.equal(f.body(b).length, 320)
  assert.equal(f.writes.length, 1, 'closing a reader must not cancel or resend native execution')
})

test('manufactured presentation bindings fail closed and capability-off refuses only direct-source occurrences', { timeout: 15000 }, async t => {
  const f = await fixture(t), a = await f.open('pane-a')
  const foreign = { ...a.binding, viewId: 'manufactured' }
  assert.equal(f.sessions.ownsBinding(foreign), false)
  assert.throws(() => f.ctx.uiConversation.binding(foreign), /inactive/)
  assert.throws(() => f.ctx.uiSession.bindingSource({ ...a.reference, binding: foreign }), /not active/)
  const owner = f.remote.windowCommit!
  assert.equal(owner.readingOccurrences, 1)
  Reflect.set(globalThis, '__DSH_CLIENT_READING_OCCURRENCES', 'off')
  try {
    const controllerRoot = resolve(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'), '..')
    const { createWindowCommitFactory } = require(resolve(controllerRoot, 'lib/types/client/sessions/window-commit.js'))
    assert.equal(createWindowCommitFactory().readingOccurrences, undefined)
  } finally { Reflect.deleteProperty(globalThis, '__DSH_CLIENT_READING_OCCURRENCES') }
})
