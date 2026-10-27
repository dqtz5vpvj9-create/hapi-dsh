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
import { SOURCE_SESSIONS_REALM } from '../src/client/source-sessions-composition.ts'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const eventContract = join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')),
  'lib/types/client/contract/events.js')
const names = ['hapi-dsh', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-conversation']
let provider: Plugin.Object

before(async () => {
  const result = await build({ entryPoints: [join(root, 'src/client/source-sessions-provider.ts')],
    alias: { '@deepseek-ai/dsh-api-session-controller/client': eventContract },
    external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false,
    logLevel: 'silent' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(require, module, module.exports)
  provider = module.exports as Plugin.Object
})

async function fixture() {
  const ctx = new Context(), started: Array<{ name: string; owner: unknown }> = [], stopped: string[] = []
  await ctx.plugin(Loader)
  ctx.loader.internal = { version: 'client', import: (name: string) => ({ inject: ['sessions'], apply(owner: Context) {
    started.push({ name, owner: owner.sessions })
    return () => { stopped.push(name) }
  } }) } as unknown as NonNullable<Loader['internal']>
  const create = async () => Promise.all(names.map(async name => ctx.loader.resolve(await ctx.loader.create({ name }))))
  return { ctx, started, stopped, create }
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('early hook isolates new consumers before a delayed original service becomes available', async () => {
  const { ctx, started, stopped, create } = await fixture()
  const original = { kind: 'original' }
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
    const original = { kind: 'original' }
    ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
    await ctx.loader.await()
    assert.equal(started.length, names.length)
    assert.ok(started.every(entry => entry.owner === original))
  } finally { await ctx.fiber.dispose() }
})

test('already-created pending consumers start once against the facade', async () => {
  const { ctx, started, stopped, create } = await fixture()
  const original = { kind: 'original' }
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
  const original = { kind: 'original' }
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
