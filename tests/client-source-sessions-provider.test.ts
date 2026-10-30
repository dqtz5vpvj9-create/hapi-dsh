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
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { SOURCE_SESSIONS_REALM } from '../src/client/source-sessions-composition.ts'
import { HHPI_REMOTE } from '../src/hhpi-api.ts'
import type {} from '../src/client/remote-sessions.ts'

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

async function fixture() {
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
  ctx.loader.internal = { version: 'client', import: (name: string) => ({ inject: ['sessions'], apply(owner: Context) {
    started.push({ name, owner: owner.sessions })
    if (name === '@deepseek-ai/dsh-client-ui-workspace' && owner.sessions === originalSessions) {
      originalRestoreCreates++
      return (owner.sessions as { create(): Promise<unknown> }).create()
    }
    return () => { stopped.push(name) }
  } }) } as unknown as NonNullable<Loader['internal']>
  const create = async () => Promise.all(names.map(async name => ctx.loader.resolve(await ctx.loader.create({ name }))))
  const setOriginalSessions = (sessions: unknown): void => { originalSessions = sessions }
  return { ctx, started, stopped, create, setOriginalSessions, get originalRestoreCreates() { return originalRestoreCreates }, catalog }
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('early hook isolates new consumers before a delayed original service becomes available', async () => {
  const { ctx, started, stopped, create } = await fixture()
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} }, refresh: async () => {} }
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
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} },
    create: async () => ({ id: 'unexpected' }) }
  f.setOriginalSessions(original)
  f.ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
  try {
    const installed = f.ctx.plugin(provider)
    const entries = await f.create()
    await installed
    await f.ctx.loader.await()
    assert.ok(entries.every(entry => entry.options.isolate?.sessions === SOURCE_SESSIONS_REALM))
    assert.equal(f.originalRestoreCreates, 0)
    assert.ok(f.ctx.get('hapiSourceSessions'))
  } finally { await f.ctx.fiber.dispose() }
})

test('official ClientRemote mount publishes remote.hhpi as a Cordis-injected service', async () => {
  const f = await fixture()
  try {
    assert.equal(f.ctx.get('remote.hhpi'), undefined)
    const remoteOwner = f.ctx.inject(['remote'], async owner => {
      const unmount = await owner.remote.$mount(HHPI_REMOTE)
      try {
        assert.equal(typeof f.ctx.get('remote.hhpi'), 'object')
        let namespace: unknown
        const dependency = owner.inject(['remote.hhpi'], scope => { namespace = scope.remote.hhpi })
        await dependency
        assert.equal(typeof (namespace as { catalog?: unknown }).catalog, 'function')
        await (namespace as { catalog(): Promise<unknown> }).catalog()
      } finally { await unmount() }
    })
    await remoteOwner
    await remoteOwner.dispose()
    assert.equal(f.ctx.get('remote.hhpi'), undefined)
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
    const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } }
    ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
    await ctx.loader.await()
    assert.equal(started.length, names.length)
    assert.ok(started.every(entry => entry.owner === original))
  } finally { await ctx.fiber.dispose() }
})

test('already-created pending consumers start once against the facade', async () => {
  const { ctx, started, stopped, create } = await fixture()
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } }
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
  const original = { kind: 'original', list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } }
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
