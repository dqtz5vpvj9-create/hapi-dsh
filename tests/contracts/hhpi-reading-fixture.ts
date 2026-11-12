import { memoryOperations } from '../fixtures/operation-transactions.ts'
/** Installed production Session/Renderer/Conversation/Input/Chat contracts.
 * Only source RPC, settings, locale and unused workspace/file services are fixtures.
 * No production reading, assembly, input shell or scope provider is replaced. */
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { prepareOfficialBrowserLibrary, resolveOfficialBrowserDependency } from './official-browser-library.ts'
import { SourceEventIndex, type EventInput } from '../../src/remote/event-index.ts'
import { sourceSessionId, type SourceOperation, type SourceSession } from '../../src/remote/protocol.ts'
import type { SessionBinding, SessionReference, ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-file-drag/client'
import type { RemoteSessions } from '../../src/client/remote-sessions.ts'
import type { RemotePaneSession } from '../../src/client/remote-reading-session.ts'
import type { SourceReadRequest } from '../../src/remote/protocol.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '../..')
function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set(next: T) { value = next; for (const fn of listeners) fn() } }
}
function official(name: string, extension = true, rendering = true): { apply(ctx: Context): void; inject: string[]; [key: string]: unknown } {
  const metadata = require(`${name}/package.json`)
  assert.equal(metadata.version, '0.2.2-rc.1')
  if (extension) assert.ok(metadata.hhpiSourceExtension, `${name} must be an installed source build`)
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
  return registration.factory(rendering ? resolveOfficialBrowserDependency : Object.assign((id: string) => {
    if (id !== '@deepseek-ai/dsh-client-ui-primitives') return require(id)
    return new Proxy({}, { get: (_target, key) => () => { throw new Error(`The assembly-only fixture cannot render ${String(key)}.`) } })
  }, { asset: (id: string) => id }))
}
/** Compile a freshly prepared pinned Chat package without mutating the installed extension. */
async function preparedChat(source: string): Promise<ReturnType<typeof official>> {
  const output = await build({ entryPoints: [resolve(source, 'packages/client/ui-chat/src/client/index.ts')], nodePaths: [resolve(root, 'node_modules')],
    bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node24', write: false, outfile: resolve(root, '.tmp/reading-memory-chat.cjs'),
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: true, jsx: 'react-jsx' } },
    loader: { '.css': 'css', '.module.css': 'local-css', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent' })
  const script = output.outputFiles.find(file => file.path.endsWith('.cjs'))
  assert.ok(script)
  const module = { exports: {} as ReturnType<typeof official> }
  new Function('require', 'module', 'exports', script.text)(resolveOfficialBrowserDependency, module, module.exports)
  return module.exports
}
async function facadeClasses() {
  const fault = process.env.HHPI_HISTORY_FAULT
  const output = await build({ stdin: { contents: "export { RemoteSessions } from './src/client/remote-sessions.ts';", resolveDir: root, loader: 'ts' },
    alias: { '@deepseek-ai/dsh-api-session-controller/client': resolve(root, 'tests/fixtures/client-session-contract.ts') },
    plugins: fault ? [{ name: 'history-fault', setup(builder) { builder.onLoad({ filter: /remote-history\.ts$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8')
      const mutations = {
        'short-client-page': ['const PAGE_EVENTS = 160', 'const PAGE_EVENTS = 20'],
        'evict-resident-history': ['entriesBySeq(extending ? [...this.state.entries, ...page.entries] : page.entries)', 'entriesBySeq(page.entries)'],
        'reuse-stale-tail': ['if (!this.state.hasAfter && !this.error && this.seqs.length > 0 && this.stateEpoch === epoch)', 'if (!this.error && this.seqs.length > 0 && this.stateEpoch === epoch)'],
      } as const
      const mutation = mutations[fault as keyof typeof mutations]
      assert.ok(mutation && contents.includes(mutation[0]), 'the selected fault must match the current production seam')
      contents = contents.replace(mutation[0], mutation[1])
      return { contents, loader: 'ts' }
    }) } }] : [],
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-gateway/client'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
  const module = { exports: {} as { RemoteSessions: typeof RemoteSessions } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(require, module, module.exports)
  return module.exports
}
const identity = { machineId: 'occurrence-machine', sourceId: 'native-codex', engine: 'codex', nativeId: 'one-native-thread' }
const metadata: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic occurrence source', cwd: '/synthetic', updatedAt: 1000, status: 'idle', activeTurnId: null,
  capabilities: { send: true, steer: true, cancel: true, approve: true, files: false }, pendingRequests: [] }
const message = (id: number): EventInput => ({ type: 'user/message', time: id, surfaceOp: 'append', data: { id: `message-${id}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `body-${id}` }] } } as EventInput)

export async function fixture(t: TestContext, options: { preparedChatSource?: string | undefined; restrictedOwner?: boolean; send?: boolean; rendering?: boolean; seed?: (index: SourceEventIndex, session: SourceSession) => void } = {}) {
  const rendering = options.rendering !== false
  const plugin = (name: string, extension = true) => official(name, extension, rendering)
  const sourceMetadata = options.send === undefined ? metadata : { ...metadata, capabilities: { ...metadata.capabilities, send: options.send } }
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
  const ctx = new Context(), index = new SourceEventIndex(':memory:', sourceMetadata), calls: SourceReadRequest[] = [], writes: SourceOperation[] = []
  const dispatched = Promise.withResolvers<void>()
  if (options.seed) options.seed(index, sourceMetadata)
  else index.edit(sourceMetadata, () => { for (let i = 1; i <= 1440; ++i) index.put(`item-${i}`, message(i)) })
  const { RemoteSessions } = await facadeClasses()
  const controllerRoot = resolve(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'), '..')
  const { createWindowCommitFactory } = require(resolve(controllerRoot, 'lib/types/client/sessions/window-commit.js'))
  const initialList: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const original = { list: store(initialList), windowCommit: createWindowCommitFactory(),
    binding: () => undefined, scope: () => undefined, scopeOf: () => undefined, sessionOf: () => undefined,
    retainInfo: () => store({ referenceCount: 0, retainedBy: {} }), searchResultLimit: 100, refresh: async () => {} } as unknown as ISessions
  // Production keeps its native Session owner in a separate realm from the
  // consumers. The memory provider must validate the facade's bindings.
  const originalOwner = ctx.isolate('sessions', Symbol('synthetic-native-session-owner'))
  originalOwner.reflect.provide('sessions', original)
  let ownerContext = originalOwner
  if (options.restrictedOwner) {
    const injectedOwner = originalOwner.inject(['sessions'], owner => { ownerContext = owner })
    await injectedOwner
  }
  const remote = new RemoteSessions(ownerContext, original, {
    catalog: async () => ({ ok: true, value: { protocol: 1, legacyHapi: false, storageScope: 'synthetic-reading', sessions: [sourceMetadata], sources: [] } }),
    read: async (request: SourceReadRequest) => { calls.push(request); return { ok: true, value: index.read(request) } },
    changes: (request: import('../../src/remote/protocol.ts').SourceChangesRequest, signal?: AbortSignal) => index.changes(request, signal),
    create: async () => { throw new Error('This reading fixture cannot create a source session.') },
    resource: async () => { throw new Error('This reading fixture has no source resource provider.') },
    operate: async (operation: SourceOperation) => { writes.push(operation); dispatched.resolve(); return { ok: true, value: { sessionId: operation.sessionId, operationId: operation.operationId, status: 'accepted', message: 'Accepted at synthetic wire boundary' } } },
  } as unknown as HhpiRemoteApi, { storage: dom.window.localStorage, scope: 'synthetic-reading' }, memoryOperations)
  const sessions = remote, references: SessionReference[] = []
  t.after(async () => {
    for (const reference of references.reverse()) reference.release()
    remote.dispose()
    await ctx.fiber.dispose(); index.dispose(); dom.window.close()
    for (const restore of restored.reverse()) restore()
  })
  await remote.refresh()
  ctx.reflect.provide('sessions', sessions)
  const { RemoteStream } = require('@deepseek-ai/dsh-api-gateway/client') as typeof import('@deepseek-ai/dsh-api-gateway/client')
  const generation = store({} as never)
  ctx.reflect.provide('remote', { $on: () => () => {}, $stream: <Item>(options: import('@deepseek-ai/dsh-api-gateway/client').RemoteStreamOptions<Item>) => new RemoteStream({ generation }, options) } as unknown as Context['remote'])
  ctx.reflect.provide('remote.session', {} as never)
  ctx.reflect.provide('remoteAccess', { source: () => store(true) } as unknown as Context['remoteAccess'])
  const localeState = store({ revision: 0, active: 'en' })
  const locale = { ...localeState, register: () => () => {}, bind: () => (key: string) => key }
  ctx.reflect.provide('locale', locale as unknown as Context['locale'])
  ctx.reflect.provide('configForms', { get: () => ({ ...store({ value: {} }), set: async () => {} }), developerTools: { enabled: store(false) } } as unknown as Context['configForms'])
  ctx.reflect.provide('uiWorkspace', { openSession: () => {}, openWorkspace: async () => {} } as unknown as Context['uiWorkspace'])
  ctx.reflect.provide('fileUpload', {} as Context['fileUpload'])
  ctx.reflect.provide('connection', { state: store('connected' as const) } as unknown as import('@deepseek-ai/dsh-client-connection/client').ConnectionHandle)
  ctx.reflect.provide('fileDrag', { actions: {} } as Context['fileDrag'])
  ctx.reflect.provide('sidebarRight', { openResource: () => {}, openTab: () => {} } as unknown as Context['sidebarRight'])
  if (rendering) await prepareOfficialBrowserLibrary()
  await ctx.plugin(plugin('@deepseek-ai/dsh-client-ui-renderer'))
  if (rendering) {
    await ctx.plugin(plugin('@deepseek-ai/dsh-client-shortcuts', false))
    await ctx.plugin(plugin('@deepseek-ai/dsh-client-ui-context-menu', false))
  }
  ctx.slots.installLocale({ ...localeState, bind: () => (key: string) => key })
  await ctx.plugin(plugin('@deepseek-ai/dsh-client-ui-session'))
  await ctx.plugin(plugin('@deepseek-ai/dsh-client-ui-conversation'))
  await ctx.plugin(options.preparedChatSource ? await preparedChat(options.preparedChatSource) : plugin('@deepseek-ai/dsh-client-ui-chat'))
  const canonical = sessions.retain(sourceMetadata.id as SessionBinding['sessionId'], { source: 'hapiWorkspace' }); references.push(canonical)
  await canonical.ready
  async function open(id: string, cacheId = id) {
    const reference = sessions.openReadingView(canonical, id)
    assert.ok(reference); references.push(reference)
    const binding = reference.binding
    ;(binding.session as RemotePaneSession).bindReadingCache(cacheId)
    const conversation = ctx.uiConversation.binding(binding), reading = conversation.readingView
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
  return { ctx, sessions, remote, canonical, calls, writes, dispatched: dispatched.promise, open, body, index, dom, officialPlugin: official }
}
