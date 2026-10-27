/** Real public Cordis/Loader lifecycle; Session services and UI consumers are protocol fixtures. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SOURCE_SESSIONS_REALM, sourceInitialNavigation, sourceSessionsContext, sourceSessionsLoader } from '../src/client/source-sessions-composition.ts'

const sessionConsumer = '@deepseek-ai/dsh-client-ui-session'
const workspaceConsumer = '@deepseek-ai/dsh-client-ui-workspace'
const chatConsumer = '@deepseek-ai/dsh-client-ui-chat'

async function graph(original: object, imports: (name: string) => unknown | Promise<unknown>) {
  const ctx = new Context()
  await ctx.plugin(sourceSessionsLoader(Loader))
  ctx.reflect.provide('sessions', original as Context['sessions'])
  ctx.loader.internal = { version: 'client', import: imports } as unknown as NonNullable<Loader['internal']>
  return ctx
}

async function provideFacade(ctx: Context, symbol: symbol, facade: object) {
  return await ctx.isolate('sessions', symbol).plugin({ apply(owner: Context) {
    owner.reflect.provide('sessions', facade as Context['sessions'])
  } })
}

test('initial and later consumers start once in the facade realm while ordinary entries retain the owner', async () => {
  const original = { kind: 'original' }, facade = { kind: 'facade' }
  const started: Array<{ name: string; sessions: unknown; config: unknown }> = [], stopped: string[] = []
  const ctx = await graph(original, name => ({ inject: ['sessions'], apply(owner: Context, config: unknown) {
    started.push({ name, sessions: owner.sessions, config })
    return () => { stopped.push(name) }
  } }))
  try {
    const id = await ctx.loader.create({ name: sessionConsumer, isolate: { quota: 'existing-quota' }, config: { marker: 7 } })
    const consumer = ctx.loader.resolve(id)
    assert.deepEqual(consumer.options.isolate, { quota: 'existing-quota', sessions: SOURCE_SESSIONS_REALM })
    assert.equal(started.length, 0)
    const ordinaryId = await ctx.loader.create({ name: 'fixture-ordinary' })
    await ctx.loader.resolve(ordinaryId).fiber
    assert.equal(started[0]?.sessions, original)
    assert.equal(ctx.sessions, original)

    await provideFacade(ctx, consumer.context[Context.isolate].sessions!, facade)
    await consumer.fiber
    assert.deepEqual(started.filter(item => item.name === sessionConsumer), [{ name: sessionConsumer, sessions: facade, config: { marker: 7 } }])
    assert.deepEqual(stopped, [])

    const laterId = await ctx.loader.create({ name: chatConsumer })
    const later = ctx.loader.resolve(laterId)
    await later.fiber
    assert.equal(later.context[Context.isolate].sessions, consumer.context[Context.isolate].sessions)
    assert.equal(started.filter(item => item.name === chatConsumer).length, 1)
    assert.equal(started.at(-1)?.sessions, facade)
    assert.deepEqual(stopped, [])
  } finally { await ctx.fiber.dispose() }
})

test('public refresh completes a pending consumer import without activating it against the original sessions', async () => {
  let release!: (value: unknown) => void
  const imported = new Promise<unknown>(resolve => { release = resolve })
  let starts = 0
  const ctx = await graph({ kind: 'original' }, () => imported)
  try {
    const creation = ctx.loader.create({ name: sessionConsumer })
    const entry = [...ctx.loader.entries()][0]!
    assert.equal(entry.options.isolate?.sessions, SOURCE_SESSIONS_REALM)
    assert.equal(entry.context[Context.isolate].sessions, ctx[Context.isolate].sessions, 'unfinished imports still inherit the owner realm')
    const refreshed = entry.refresh()
    release({ inject: ['sessions'], apply() { starts++ } })
    await Promise.all([creation, refreshed])
    assert.equal(starts, 0)
    assert.equal(typeof entry.context[Context.isolate].sessions, 'symbol')
    assert.notEqual(entry.context[Context.isolate].sessions, ctx[Context.isolate].sessions)
    await provideFacade(ctx, entry.context[Context.isolate].sessions!, { kind: 'facade' })
    await entry.fiber
    assert.equal(starts, 1)
  } finally { await ctx.fiber.dispose() }
})

test('the same configuration label creates separate realms and owners for separate Host graphs', async () => {
  const owners = [{ host: 'one' }, { host: 'two' }], facades = [{ source: 'one' }, { source: 'two' }]
  const seen: unknown[][] = [[], []]
  const graphs = await Promise.all(owners.map((owner, index) => graph(owner, () => ({ inject: ['sessions'], apply(ctx: Context) {
    seen[index]!.push(ctx.sessions)
  } }))))
  try {
    const entries = await Promise.all(graphs.map(async ctx => ctx.loader.resolve(await ctx.loader.create({ name: sessionConsumer }))))
    assert.notEqual(entries[0]!.context[Context.isolate].sessions, entries[1]!.context[Context.isolate].sessions)
    await Promise.all(entries.map((entry, index) => provideFacade(graphs[index]!, entry.context[Context.isolate].sessions!, facades[index]!)))
    await Promise.all(entries.map(entry => entry.fiber))
    assert.deepEqual(seen, [[facades[0]], [facades[1]]])
    assert.equal(graphs[0]!.sessions, owners[0]); assert.equal(graphs[1]!.sessions, owners[1])
    await graphs[0]!.fiber.dispose()
    assert.equal(entries[1]!.fiber!.ctx.sessions, facades[1])
  } finally { await Promise.all(graphs.map(ctx => ctx.fiber.dispose())) }
})

test('initial navigation waits for the same facade as Workspace without hiding the root Session owner', async () => {
  const id = 'hapi-codex-composition-fixture' as SessionId
  let originalReads = 0, facadeReads = 0, ready = 0
  const original = { list: { getSnapshot() { originalReads++; return { byId: {} } } }, refresh() { throw new Error('Navigation used the original owner catalog') } }
  const facade = { list: { getSnapshot() { facadeReads++; return { byId: { [id]: { sessionId: id } } } } }, refresh() { throw new Error('The fixture facade catalog is already ready') } }
  const opened: SessionId[] = []
  const ctx = await graph(original, () => ({ inject: ['sessions'], apply(owner: Context) {
    assert.equal(owner.sessions, facade)
    owner.reflect.provide('uiWorkspace', { openSession(target: SessionId) { opened.push(target) } } as Context['uiWorkspace'])
  } }))
  try {
    const navigation = sourceInitialNavigation(ctx, id, new AbortController().signal, () => { ready++ })
    const entry = ctx.loader.resolve(await ctx.loader.create({ name: workspaceConsumer }))
    assert.deepEqual(opened, [])
    ctx.reflect.provide('hapiSourceSessions', facade as unknown as Context['hapiSourceSessions'])
    assert.deepEqual(opened, [])
    await provideFacade(ctx, entry.context[Context.isolate].sessions!, facade)
    await navigation
    assert.deepEqual(opened, [id]); assert.equal(ready, 1)
    assert.equal(originalReads, 0); assert.equal(facadeReads, 1)
    assert.equal(ctx.sessions, original)
  } finally { await ctx.fiber.dispose() }
})

test('shared Host view context resolves the consumer facade and retains the original graph owner', async () => {
  const original = { kind: 'original' }, facade = { kind: 'facade' }, workspace = { kind: 'workspace' }
  const ctx = await graph(original, () => ({ inject: ['sessions'], apply(owner: Context) {
    assert.equal(owner.sessions, facade)
    owner.reflect.provide('uiWorkspace', workspace as unknown as Context['uiWorkspace'])
  } }))
  try {
    const entry = ctx.loader.resolve(await ctx.loader.create({ name: sessionConsumer }))
    const scope = await sourceSessionsContext(ctx)
    await scope.plugin({ apply(owner: Context) { owner.reflect.provide('sessions', facade as unknown as Context['sessions']) } })
    await entry.fiber
    const sharedHost = await sourceSessionsContext(ctx)
    assert.equal(sharedHost.sessions, facade)
    assert.equal(sharedHost.get('sessions'), facade)
    assert.equal(sharedHost.uiWorkspace, workspace)
    assert.equal([...sharedHost.loader.entries()][0]?.options.id, entry.options.id)
    assert.equal(ctx.sessions, original)
    assert.equal(entry.fiber!.ctx.sessions, sharedHost.sessions)
  } finally { await ctx.fiber.dispose() }
})

test('compatibility graphs without a source provider navigate with their original sessions service', async () => {
  const id = 'hapi-codex-compatibility-fixture' as SessionId
  const original = { list: { getSnapshot() { return { byId: { [id]: { sessionId: id } } } } } }
  const opened: SessionId[] = []
  let ready = 0
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    ctx.reflect.provide('sessions', original as unknown as Context['sessions'])
    ctx.loader.internal = { version: 'client', import: () => ({ inject: ['sessions'], apply(owner: Context) {
      assert.equal(owner.sessions, original)
      owner.reflect.provide('uiWorkspace', { openSession(target: SessionId) { opened.push(target) } } as Context['uiWorkspace'])
    } }) } as unknown as NonNullable<Loader['internal']>
    const navigation = sourceInitialNavigation(ctx, id, new AbortController().signal, () => { ready++ }, false)
    const entry = ctx.loader.resolve(await ctx.loader.create({ name: workspaceConsumer }))
    await navigation
    assert.deepEqual(opened, [id]); assert.equal(ready, 1)
    assert.equal(entry.options.isolate?.sessions, undefined)
    assert.equal(ctx.sessions, original)
    assert.equal(ctx.get('hapiSourceSessions'), undefined)
  } finally { await ctx.fiber.dispose() }
})
