/** Pinned public Cordis/Loader lifecycle with a real SourceSessions facade.
 * Session owners and consumers are protocol fixtures; no Host/browser starts. */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { apply as applyGateway, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { SOURCE_SESSIONS_REALM, sourceSessionsContext } from '../src/client/source-sessions-composition.ts'
import { HAPI_DSH_REMOTE } from '../src/shared/client-remote.ts'
import type {} from '../src/client/remote-sessions.ts'
import { SourceReadingCache } from '../src/client/remote-reading-cache.ts'
import { prepareOfficialBrowserLibrary, resolveOfficialBrowserDependency } from './contracts/official-browser-library.ts'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const eventContract = join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')),
  'lib/types/client/contract/events.js')
const names = ['hapi-dsh', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-workspace']
let provider: Plugin.Object

before(async () => {
  const result = await build({ entryPoints: [join(root, 'src/client/source-sessions-provider.ts')],
    alias: { '@deepseek-ai/dsh-api-session-controller/client': join(root, 'tests/fixtures/client-session-contract.ts') },
    external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false,
    logLevel: 'silent' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(require, module, module.exports)
  provider = module.exports as Plugin.Object
})

async function fixture({ mountHapiConsumer = false, standalone = false }: { mountHapiConsumer?: boolean; standalone?: boolean } = {}) {
  const ctx = new Context(), started: Array<{ name: string; owner: unknown }> = [], stopped: string[] = []
  let originalSessions: unknown
  let originalRestoreCreates = 0
  const catalog = { protocol: 1 as const, legacyHapi: false, sessions: [], sources: [] }
  await ctx.plugin(TypertRegistry)
  ctx.reflect.provide('connection', {
    interactions: 'answer', isLoopback: false,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call: async (_channel: string, endpoint: string) => {
      assert.equal(endpoint, 'hhpi/catalog')
      return { ok: true, value: catalog }
    }, open: () => { throw new Error('The provider contract must not open a stream.') } },
    openWebSocket: () => { throw new Error('The provider contract must not open a socket.') },
    reconnect: () => {}, registerGenerationSource: () => () => {}, start: () => ({ stop: () => {} }),
  } as unknown as ConnectionHandle)
  await ctx.plugin({ inject: gatewayInject, apply: applyGateway })
  await ctx.plugin(Loader)
  ctx.loader.internal = { version: 'client', import: (name: string) => ({ inject: name === 'hapi-dsh' && mountHapiConsumer
    ? ['remote', 'remote.hapi', 'remote.hhpi', 'sessions', 'hapiSourceSessions', 'hhpiSessions'] : ['sessions'], apply(owner: Context) {
    started.push({ name, owner: owner.sessions })
    if (name === 'hapi-dsh' && mountHapiConsumer) {
      assert.equal(typeof owner.remote.hapi.catalog, 'function')
      assert.equal(typeof owner.remote.hhpi.catalog, 'function')
    }
    if (name === '@deepseek-ai/dsh-client-ui-workspace' && owner.sessions === originalSessions) {
      originalRestoreCreates++
      return (owner.sessions as { create(): Promise<unknown> }).create()
    }
    return () => { stopped.push(name) }
  } }) } as unknown as NonNullable<Loader['internal']>
  const create = async () => Promise.all(names.filter(name => !standalone || name !== 'hapi-dsh').map(async name => ctx.loader.resolve(await ctx.loader.create({ name }))))
  const setOriginalSessions = (sessions: unknown): void => { originalSessions = sessions }
  return { ctx, started, stopped, create, setOriginalSessions, get originalRestoreCreates() { return originalRestoreCreates }, catalog }
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('a standalone plugin pane activates source files without waiting for the omitted workspace shell', { timeout: 2000 }, async () => {
  const f = await fixture({ standalone: true })
  const identity = { machineId: 'original-runner', sourceId: 'native-source', engine: 'codex', nativeId: 'original-thread' }
  const source: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Original native session', cwd: 'C:\\work', updatedAt: 1,
    status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: false, files: true } }
  ;(f.catalog.sessions as SourceSession[]).push(source)
  const original = { list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }), subscribe: () => () => {} }, refresh: async () => {} }
  f.ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
  try {
    const installed = f.ctx.plugin(provider)
    await f.create(); await installed; await f.ctx.loader.await()
    assert.equal(f.started.some(entry => entry.name === 'hapi-dsh'), false)
    assert.equal(f.started.length, names.length - 1)
    assert.ok(f.started.every(entry => entry.owner === f.ctx.hapiSourceSessions))
    assert.equal(typeof f.ctx.sourceFiles.resolve, 'function')
    assert.equal(f.ctx.sessions, original)
    await f.ctx.hapiSourceSessions.refresh()
    const row = f.ctx.hapiSourceSessions.list.getSnapshot().byId[source.id as SessionId]
    assert.equal(row?.projectionValues?.hhpiSource?.nativeId, identity.nativeId)
    assert.equal(row?.projectionValues?.hhpiSource?.capabilities.send, true,
      'a Runner facade reads its own authorized source row without the main workspace plugin')
  } finally { await f.ctx.fiber.dispose() }
})

test('production provider restores authorized source metadata from the authenticated bootstrap scope', async () => {
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, options: { url: string }) => { window: { localStorage: Storage; close(): void } } }
  const dom = new JSDOM('', { url: 'https://synthetic.invalid/' }), access = { storage: dom.window.localStorage, scope: 'synthetic-owner-installation' }
  const previous = ['localStorage', '__HHPI_STORAGE_SCOPE__'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: access.storage })
  Object.defineProperty(globalThis, '__HHPI_STORAGE_SCOPE__', { configurable: true, value: access.scope })
  const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread' }
  const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Saved native thread', cwd: '/synthetic', updatedAt: 1,
    status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
  const cache = new SourceReadingCache(access)
  cache.write({ session, epoch: 'epoch', version: 1, windows: [], head: { session, epoch: 'epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] } })
  cache.dispose()
  const f = await fixture()
  const original = { list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }), subscribe: () => () => {} }, refresh: async () => {} }
  f.ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
  try {
    const installed = f.ctx.plugin(provider)
    await f.create(); await installed; await f.ctx.loader.await(); await f.ctx.hhpiSessions.refresh()
    assert.equal(f.ctx.hhpiSessions.list.getSnapshot().byId[session.id as SessionId]?.title, session.title)
    assert.equal(typeof f.ctx.sourceFiles.resolve, 'function')
    const capture = f.ctx.hhpiSessions.captureWorkspaceAccess(session.id)
    assert.equal(capture.scope, access.scope); capture.assertCurrent()
    f.ctx.hhpiSessions.revokeReadingSource(session.id)
    assert.equal(capture.signal.aborted, true); assert.throws(capture.assertCurrent)
  } finally {
    await f.ctx.fiber.dispose(); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})

test('native Conversation control scopes resolve the same source facade and exact retained binding', async () => {
  const f = await fixture()
  const identity = { machineId: 'scope-machine', sourceId: 'scope-source', engine: 'codex', nativeId: 'scope-thread' }
  const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Own native task', cwd: '/synthetic', updatedAt: 1,
    status: 'waiting', activeTurnId: 'exact-native-turn', pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: false, files: false } }
  ;(f.catalog.sessions as SourceSession[]).push(session)
  const original = { list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }), subscribe: () => () => {} }, windowCommit: {},
    refresh: async () => {}, scope: () => undefined, binding: () => undefined }
  f.ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
  let release: (() => void) | undefined
  try {
    const installed = f.ctx.plugin(provider)
    await f.create(); await installed; await f.ctx.loader.await(); await f.ctx.hhpiSessions.refresh()
    const retained = f.ctx.hhpiSessions.retain(session.id as SessionId, { source: 'hapiWorkspace' })
    release = retained.release
    const scope = f.ctx.hhpiSessions.scope(session.id as SessionId)
    assert.ok(scope)
    assert.ok(scope.get('sessions') === f.ctx.hhpiSessions, 'official scoped Conversation controls must use the source service realm')
    assert.equal(scope.get('sessions')!.binding(session.id as SessionId), retained.binding)
    assert.equal(scope.get('sessions')!.scopeOf(scope), session.id)
    assert.equal(f.ctx.sessions, original, 'the original execution-owner service is preserved at the root')
  } finally { release?.(); await f.ctx.fiber.dispose() }
})

test('early hook isolates new consumers before a delayed original service becomes available', async () => {
  const { ctx, started, stopped, create } = await fixture()
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }), subscribe: () => () => {} }, refresh: async () => {} }
  try {
    const installed = ctx.plugin(provider)
    await flush()
    const entries = await create()
    assert.deepEqual(started, [])
    assert.ok(entries.every(entry => entry.options.isolate?.sessions === SOURCE_SESSIONS_REALM))
    ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
    await installed
    await ctx.loader.await()
    const facade = ctx.hapiSourceSessions
    const hhpiSessions = ctx.hhpiSessions
    assert.equal(facade, hhpiSessions, 'the public view uses one native source provider without a legacy projection facade')
    await hhpiSessions.refresh()
    assert.deepEqual(hhpiSessions.capabilities.getSnapshot(), { catalogReady: true, legacyHapi: false })
    assert.notEqual(facade, original)
    assert.deepEqual(started, names.map(name => ({ name, owner: facade })))
    assert.deepEqual(stopped, [])
    assert.equal(ctx.sessions, original)
    const laterName = '@deepseek-ai/dsh-client-ui-chat'
    const later = ctx.loader.resolve(await ctx.loader.create({ name: laterName }))
    await later.fiber
    assert.equal(later.options.isolate?.sessions, SOURCE_SESSIONS_REALM)
    assert.deepEqual(started.at(-1), { name: laterName, owner: facade })
    assert.deepEqual(stopped, [])
  } finally { await ctx.fiber.dispose() }
})

test('registers the sessions boundary before yielding so workspace restore cannot create a DSH session', async () => {
  const f = await fixture()
  let explicitCreates = 0
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }), subscribe: () => () => {} },
    create: async () => { explicitCreates++; return 'explicit-ordinary' as SessionId } }
  f.setOriginalSessions(original)
  f.ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
  try {
    const installed = f.ctx.plugin(provider)
    const entries = await f.create()
    await installed
    await f.ctx.loader.await()
    assert.ok(entries.every(entry => entry.options.isolate?.sessions === SOURCE_SESSIONS_REALM))
    assert.equal(entries.find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-workspace')?.options.config?.restoreSelection, false)
    assert.equal(f.originalRestoreCreates, 0)
    assert.equal(explicitCreates, 0)
    assert.ok(f.ctx.get('hapiSourceSessions'))
    assert.equal(await f.ctx.hapiSourceSessions.create({ workspaceId: 'ordinary-workspace' as never }), 'explicit-ordinary')
    assert.equal(explicitCreates, 1, 'the public configuration does not intercept ordinary user creation')
  } finally { await f.ctx.fiber.dispose() }
})

test('provider and workspace consumer co-activate through one official composite ClientRemote mount', async () => {
  const f = await fixture({ mountHapiConsumer: true })
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }), subscribe: () => () => {} }, refresh: async () => {} }
  f.ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
  try {
    assert.equal(f.ctx.get('remote.hhpi'), undefined)
    assert.equal(f.ctx.get('remote.hapi'), undefined)
    const installed = f.ctx.plugin(provider)
    const entries = await f.create()
    await installed
    await f.ctx.loader.await()
    assert.ok(entries.every(entry => entry.options.isolate?.sessions === SOURCE_SESSIONS_REALM))
    assert.equal(typeof f.ctx.get('remote.hhpi'), 'object')
    assert.equal(typeof f.ctx.get('remote.hapi'), 'object')
    const registered = f.ctx.typert.remotes.list().filter(descriptor => descriptor.id.startsWith('hapi-dsh#'))
    assert.equal(registered.length, HAPI_DSH_REMOTE.descriptors.length)
    assert.ok(registered.some(descriptor => descriptor.id === 'hapi-dsh#hapi/catalog'))
    assert.ok(registered.some(descriptor => descriptor.id === 'hapi-dsh#hhpi/catalog'))
    assert.equal(f.started.length, names.length)
    assert.ok(f.started.every(entry => entry.owner === f.ctx.hapiSourceSessions))
    assert.equal(f.ctx.get('hapiSourceSessions'), f.ctx.hapiSourceSessions)
    assert.ok(f.ctx.get('hhpiSessions'))
    assert.equal(typeof f.ctx.sourceFiles.resolve, 'function')
    await f.ctx.hhpiSessions.refresh()
    await installed.dispose()
    assert.equal(f.ctx.get('remote.hhpi'), undefined)
    assert.equal(f.ctx.get('remote.hapi'), undefined)
    assert.equal(f.ctx.get('sourceFiles'), undefined)
  } finally { await f.ctx.fiber.dispose() }
})

test('disposing while the original service is absent removes the hook and restores pending consumers', async () => {
  const { ctx, started, create } = await fixture()
  try {
    const entries = await create()
    const installed = ctx.plugin(provider)
    await installed
    assert.ok(entries.every(entry => entry.options.isolate?.sessions === SOURCE_SESSIONS_REALM))
    await installed.dispose()
    assert.ok(entries.every(entry => entry.options.isolate?.sessions === undefined))
    assert.equal(ctx.get('hapiSourceSessions'), undefined)
    assert.equal(ctx.get('hhpiSessions'), undefined)
    const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }), subscribe: () => () => {} } }
    ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
    await ctx.loader.await()
    assert.equal(started.length, names.length)
    assert.ok(started.every(entry => entry.owner === original))
  } finally { await ctx.fiber.dispose() }
})

test('already-created pending consumers start once against the facade', async () => {
  const { ctx, started, stopped, create } = await fixture()
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }), subscribe: () => () => {} } }
  try {
    const entries = await create()
    assert.equal(started.length, 0)
    const installed = ctx.plugin(provider)
    await flush()
    assert.ok(entries.every(entry => entry.options.isolate?.sessions === SOURCE_SESSIONS_REALM))
    ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
    await installed
    await flush()
    await ctx.loader.await()
    assert.ok(ctx.get('hapiSourceSessions'))
    assert.equal(started.length, names.length)
    assert.ok(started.every(entry => entry.owner === ctx.hapiSourceSessions))
    assert.deepEqual(stopped, [])
    assert.equal(ctx.sessions, original)
  } finally { await ctx.fiber.dispose() }
})

test('already-active consumers use the public fallback and provider disposal restores their original realm', async () => {
  const { ctx, started, stopped, create } = await fixture()
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }), subscribe: () => () => {} } }
  try {
    ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
    const entries = await create()
    await ctx.loader.await()
    assert.equal(started.length, names.length)
    assert.ok(started.every(entry => entry.owner === original))
    const installed = ctx.plugin(provider)
    await installed
    await ctx.loader.await()
    const facade = ctx.hapiSourceSessions
    assert.equal(started.length, names.length * 2)
    assert.ok(started.slice(names.length).every(entry => entry.owner === facade))
    assert.deepEqual([...stopped].sort(), [...names].sort())
    assert.equal(ctx.sessions, original)

    await installed.dispose()
    await ctx.loader.await()
    assert.ok(entries.every(entry => entry.options.isolate?.sessions === undefined))
    assert.equal(ctx.get('hapiSourceSessions'), undefined)
    assert.equal(started.length, names.length * 3)
    assert.ok(started.slice(names.length * 2).every(entry => entry.owner === original))
  } finally { await ctx.fiber.dispose() }
})


test('the real source Conversation installer activates under the shared Host public service scope', async () => {
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis } }
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://synthetic.invalid/' })
  const globals = ['window', 'document', 'HTMLElement', 'localStorage'] as const
  const previous = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
  const f = await fixture({ standalone: true }), registered: string[] = []
  let ctx = f.ctx
  const noop = () => () => {}
  const slots = { entries: () => [], entriesOfSlot: () => [], subscribe: noop, inject: (_name: string, callback: () => () => void) => callback(),
    register: (options: { name: string }) => { registered.push(options.name); return () => {} } }
  const locale = { register: noop, bind: () => (key: string) => key, getSnapshot: () => ({ active: 'en' }), subscribe: noop }
  const sourceFiles = { resolve: async () => { throw new Error('No source operation is allowed in this installer contract') } }
  const ui = { readCommits: { subscribe: noop }, application: { subscribe: noop, getSnapshot: () => undefined },
    sourceFileMutations: {}, updates: { registerCheckpoint: noop }, handoffs: { subscribe: noop }, shareInbox: { wake() {} }, preferences: {} }
  const services: Record<string, unknown> = { slots, locale, sourceFiles, hhpiSessions: {}, remote: { hhpi: {} }, fileUpload: { registerProvider: () => { registered.push('source-upload'); return () => {} } },
    fileDrag: { actions: {} }, layout: {}, shortcuts: { observeFixedInput: noop }, sidebarRightTabs: { register: noop }, sidebarRight: {}, sessions: {}, uiSession: {},
    uiConversation: { events: { register: noop } }, conversation: {}, hapiWorkspaceUi: ui, resources: { register: noop }, documentPreviews: {}, inputTriggers: { registerSource: noop } }
  try {
    await prepareOfficialBrowserLibrary()
    const result = await build({ entryPoints: [join(root, 'src/client/source-conversation.ts')], external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime'],
      alias: { '@deepseek-ai/dsh-api-session-controller/client': join(root, 'tests/fixtures/client-session-contract.ts') },
      bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(resolveOfficialBrowserDependency, module, module.exports)
    const contribution = module.exports as { SOURCE_CONVERSATION_SERVICES: readonly string[]; installSourceConversation(owner: Context, composer: { checkpointUpload(): Promise<void> }, navigation: { hostId: string; navigate(): Promise<void> }): () => void }
    const original = { list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }), subscribe: noop }, refresh: async () => {} }
    ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
    const installed = ctx.plugin(provider)
    await f.create(); await installed; await ctx.loader.await()
    ctx = await sourceSessionsContext(ctx)
    for (const [key, value] of Object.entries(services)) if (!['sessions', 'hhpiSessions', 'remote', 'sourceFiles'].includes(key)) ctx.reflect.provide(key, value as never)
    assert.equal(ctx.get('hhpiSessions'), f.ctx.hhpiSessions)
    assert.ok(ctx.get('sourceFiles'))
    const base = ['slots', 'locale', 'sessions', 'uiSession', 'uiConversation', 'conversation', 'sidebarRight', 'hapiWorkspaceUi']
    const missing = ctx.inject(base, owner => assert.throws(() => contribution.installSourceConversation(owner,
      { checkpointUpload: async () => {} }, { hostId: 'original-runner', navigate: async () => {} }), /sourceFiles.*without inject/))
    await missing; await missing.dispose()
    const ordinary = new Context(); let ordinaryReady = false
    for (const key of base) ordinary.reflect.provide(key, services[key] as never)
    const ordinaryScope = ordinary.inject(base, owner => { ordinaryReady = true; assert.equal(owner.get('sourceFiles'), undefined); assert.ok(owner.slots) })
    await ordinaryScope; assert.equal(ordinaryReady, true, 'ordinary Host UI activates without any source-provider service')
    await ordinary.fiber.dispose()
    const scope = ctx.inject([...base, ...contribution.SOURCE_CONVERSATION_SERVICES], owner =>
      contribution.installSourceConversation(owner, { checkpointUpload: async () => {} }, { hostId: 'original-runner', navigate: async () => {} }))
    await scope; await flush()
    assert.ok(registered.includes('source-upload'), 'the full source installer reaches its source upload provider')
    assert.ok(registered.includes('hapi.source.composer-tools'), 'native task controls are registered in the same source scope')
    assert.ok(registered.includes('conversation.input.dock'))
    await scope.dispose()
  } finally {
    await f.ctx.fiber.dispose(); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
