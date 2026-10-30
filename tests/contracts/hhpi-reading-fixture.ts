/** Installed production Session/Renderer/Conversation/Input/Chat contracts.
 * Only source RPC, settings, locale and unused workspace/file services are fixtures.
 * No production reading, assembly, input shell or scope provider is replaced. */
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
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
  let registration: { factory(resolve: (id: string) => unknown): ReturnType<typeof official> } | undefined
  // Client factories retain their lexical Window. Give them the actual DOM
  // Window, with only the loader registration boundary supplied by this test.
  const target = globalThis.window
  const previous = Object.getOwnPropertyDescriptor(target, '__ModuleLoader__')
  Object.defineProperty(target, '__ModuleLoader__', { configurable: true,
    value: { load(value: typeof registration) { registration = value } } })
  try { new Function('window', readFileSync(require.resolve(`${name}/client`), 'utf8'))(target) }
  finally {
    if (previous) Object.defineProperty(target, '__ModuleLoader__', previous)
    else Reflect.deleteProperty(target, '__ModuleLoader__')
  }
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

export async function fixture(t: TestContext) {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://synthetic.invalid/', pretendToBeVisual: true })
  // jsdom has no font loader. Composer layout observes this external boundary;
  // DOM geometry is supplied separately by the mounted-component contract.
  Object.defineProperty(dom.window.document, 'fonts', { configurable: true,
    value: Object.assign(new dom.window.EventTarget(), { ready: Promise.resolve(), status: 'loaded', check: () => true }) })
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
