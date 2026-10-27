/** Real pinned CommandDirectory and Cordis/Loader; RPC replies are controlled
 * protocol fixtures. This tests composition/concurrency, not browser latency. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CommandListReads, COMMAND_DIRECTORY_CONSUMER, COMMAND_DIRECTORY_REALM,
  installCommandDirectoryProvider } from '../src/client/command-directory-provider.ts'
import { sourceSessionsLoader } from '../src/client/source-sessions-composition.ts'

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
function calls() {
  const reads: Array<{ key: string; reply: ReturnType<typeof deferred<number>> }> = []
  const directory = new CommandListReads((key: string) => {
    const reply = deferred<number>(); reads.push({ key, reply }); return reply.promise
  })
  return { reads, directory }
}

test('47 same-turn invalidations dispatch one read and retain no completed cache', async () => {
  const { reads, directory } = calls()
  const waiting = Array.from({ length: 47 }, () => directory.read('session'))
  await flush(); assert.equal(reads.length, 1)
  reads[0]!.reply.resolve(7)
  assert.deepEqual(await Promise.all(waiting), Array(47).fill(7))
  const next = directory.read('session'); await flush(); assert.equal(reads.length, 2)
  reads[1]!.reply.resolve(8); assert.equal(await next, 8)
})

test('in-flight callers share a followup; continuing changes do not hold earlier callers until quiet', async () => {
  const { reads, directory } = calls()
  const first = directory.read('session'); await flush()
  const second = Array.from({ length: 46 }, () => directory.read('session'))
  reads[0]!.reply.resolve(1); assert.equal(await first, 1); await flush()
  assert.equal(reads.length, 2)
  const third = directory.read('session')
  reads[1]!.reply.resolve(2)
  assert.deepEqual(await Promise.all(second), Array(46).fill(2)); await flush()
  assert.equal(reads.length, 3)
  reads[2]!.reply.resolve(3); assert.equal(await third, 3)
})

test('different session keys are independent and failure does not discard a requested followup', async () => {
  const { reads, directory } = calls()
  const first = directory.read('one'), other = directory.read('two')
  const failed = assert.rejects(first, /fixture failure/)
  await flush(); assert.deepEqual(reads.map(read => read.key), ['one', 'two'])
  const next = directory.read('one')
  reads[0]!.reply.reject(new Error('fixture failure')); await failed
  reads[1]!.reply.resolve(20); assert.equal(await other, 20); await flush()
  assert.equal(reads[2]!.key, 'one'); reads[2]!.reply.resolve(10); assert.equal(await next, 10)
})

test('connection reset rejects both old rounds and cannot let old completion dispatch into the new generation', async () => {
  const { reads, directory } = calls()
  const first = directory.read('session'); await flush()
  const second = directory.read('session')
  const rejected = Promise.all([assert.rejects(first, /connection changed/), assert.rejects(second, /connection changed/)])
  directory.reset(); await rejected
  const current = directory.read('session'); await flush(); assert.equal(reads.length, 2)
  reads[0]!.reply.resolve(1); await flush(); assert.equal(reads.length, 2)
  reads[1]!.reply.resolve(2); assert.equal(await current, 2)
})

test('disposal rejects queued work promptly and prevents undispatched or later reads', async () => {
  const { reads, directory } = calls()
  const first = directory.read('session'); await flush()
  const queued = directory.read('session'), notStarted = directory.read('other')
  const rejected = [first, queued, notStarted].map(value => assert.rejects(value, /disposed/))
  directory.dispose(); await Promise.all(rejected)
  reads[0]!.reply.resolve(1); await flush(); assert.equal(reads.length, 1)
  await assert.rejects(directory.read('session'), /disposed/)
})

const require = createRequire(import.meta.url)
interface OfficialDirectory {
  warm(id: string): void
  invalidateAll(): void
  status(id: string): string
  resolve(id: string, name: string): { name: string } | undefined
}
let published: { factory(resolve: (id: string) => unknown): { CommandDirectory: new (read: (id: string) => Promise<unknown>) => OfficialDirectory } } | undefined
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-commands/client'), 'utf8'))({
  __ModuleLoader__: { load(value: typeof published) { published = value } },
})
const { CommandDirectory } = published!.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id))

test('pinned official directory keeps its epoch guard across a coalesced invalidation burst', async () => {
  const pending: Array<ReturnType<typeof deferred<Array<{ name: string }>>>> = []
  const reads = new CommandListReads((_key: string) => {
    const reply = deferred<Array<{ name: string }>>(); pending.push(reply); return reply.promise
  })
  const official = new CommandDirectory(id => reads.read(id))
  official.warm('source'); await flush(); assert.equal(pending.length, 1)
  for (let n = 0; n < 46; n++) official.invalidateAll()
  pending[0]!.resolve([{ name: 'obsolete' }]); await flush()
  assert.equal(official.status('source'), 'pending', 'superseded first response cannot publish')
  assert.equal(pending.length, 2)
  pending[1]!.resolve([{ name: 'current' }]); await flush()
  assert.equal(official.status('source'), 'ready')
  assert.equal(official.resolve('source', 'obsolete'), undefined)
  assert.equal(official.resolve('source', 'current')?.name, 'current')
})

async function graph(options: { late?: boolean; pull?: () => Promise<{ ok: true; value: [] }> } = {}) {
  const ctx = new Context(), received: string[] = [], executions: unknown[][] = [], consumers: Context[] = []
  await ctx.plugin(options.late ? Loader : sourceSessionsLoader(Loader))
  class Remote extends Service { constructor(owner: Context) { super(owner, 'remote') } }
  class Commands extends Service {
    constructor(owner: Context) { super(owner, 'remote.commands') }
    async list(id: SessionId) { received.push(id); return options.pull ? options.pull() : { ok: true as const, value: [] } }
    async execute(...args: Parameters<Context['remote']['commands']['execute']>) {
      executions.push(args); return { ok: true as const, value: undefined }
    }
  }
  await ctx.plugin(Remote); await ctx.plugin(Commands)
  ctx.loader.internal = { version: 'client', import: () => ({ inject: ['remote', 'remote.commands'], apply(owner: Context) {
    consumers.push(owner)
  } }) } as unknown as NonNullable<Loader['internal']>
  const create = async () => ctx.loader.resolve(await ctx.loader.create({ name: COMMAND_DIRECTORY_CONSUMER }))
  let entry: Awaited<ReturnType<typeof create>> | undefined
  if (options.late) { entry = await create(); await entry.fiber }
  const stop = await installCommandDirectoryProvider(ctx)
  entry ??= await create()
  await entry.fiber; await flush()
  return { ctx, stop, entry, consumer: consumers.at(-1)!, consumers, received, executions }
}

test('public Loader namespace isolation reaches ctx.remote.commands without changing execute or other consumers', async () => {
  const fixture = await graph()
  try {
    const { ctx, consumer, entry, received, executions } = fixture
    assert.equal(entry.options.isolate?.['remote.commands'], COMMAND_DIRECTORY_REALM)
    assert.notEqual(consumer.remote.commands, ctx.remote.commands)
    assert.equal(consumer[Context.isolate].remote, ctx[Context.isolate].remote, 'only the generated namespace is isolated')
    const id = 'fixture-source' as SessionId
    await Promise.all(Array.from({ length: 47 }, () => consumer.remote.commands.list(id)))
    assert.deepEqual(received, [id])
    const signal = new AbortController().signal
    const attachments: Parameters<Context['remote']['commands']['execute']>[2] = []
    const result = await consumer.remote.commands.execute(id, '/native argument', attachments, signal)
    assert.equal(result.ok, true)
    assert.equal(executions.length, 1)
    assert.deepEqual(executions[0], [id, '/native argument', attachments, signal])
    await ctx.remote.commands.list(id); assert.equal(received.length, 2, 'original owner bypasses this UI-only provider')
  } finally { await fixture.stop(); await fixture.ctx.fiber.dispose() }
})

test('Host graphs never share same-ID command reads', async () => {
  const first = await graph(), second = await graph()
  try {
    const id = 'same-display-id' as SessionId
    await Promise.all([first.consumer.remote.commands.list(id), second.consumer.remote.commands.list(id)])
    assert.deepEqual(first.received, [id]); assert.deepEqual(second.received, [id])
    await first.stop()
    await second.consumer.remote.commands.list(id); assert.equal(second.received.length, 2)
  } finally {
    await first.stop(); await second.stop()
    await first.ctx.fiber.dispose(); await second.ctx.fiber.dispose()
  }
})

test('an already-active consumer moves through public entry update and disposal restores its original namespace', async () => {
  const fixture = await graph({ late: true })
  try {
    assert.equal(fixture.consumers.length, 2)
    const id = 'fixture-late' as SessionId
    await Promise.all(Array.from({ length: 47 }, () => fixture.consumer.remote.commands.list(id)))
    assert.deepEqual(fixture.received, [id])
    await fixture.stop(); await flush()
    assert.equal(fixture.entry.options.isolate?.['remote.commands'], undefined)
    assert.equal(fixture.consumers.length, 3)
    await Promise.all([fixture.consumers.at(-1)!.remote.commands.list(id), fixture.ctx.remote.commands.list(id)])
    assert.deepEqual(fixture.received, [id, id, id])
  } finally { await fixture.stop(); await fixture.ctx.fiber.dispose() }
})

test('the public connection event cancels old provider rounds while a fresh generation remains usable', async () => {
  const pending: Array<ReturnType<typeof deferred<{ ok: true; value: [] }>>> = []
  const fixture = await graph({ pull: () => { const reply = deferred<{ ok: true; value: [] }>(); pending.push(reply); return reply.promise } })
  try {
    const id = 'fixture-reset' as SessionId
    const first = fixture.consumer.remote.commands.list(id); await flush()
    const next = fixture.consumer.remote.commands.list(id)
    const rejected = [first, next].map(value => assert.rejects(value, /connection changed/))
    fixture.ctx.emit('connection/reset'); await Promise.all(rejected)
    const current = fixture.consumer.remote.commands.list(id); await flush()
    assert.equal(pending.length, 2)
    pending[0]!.resolve({ ok: true, value: [] }); await flush(); assert.equal(pending.length, 2)
    pending[1]!.resolve({ ok: true, value: [] }); assert.equal((await current).ok, true)
  } finally { await fixture.stop(); await fixture.ctx.fiber.dispose() }
})

test('a pending command bundle import does not serialize source provider startup', async () => {
  const ctx = new Context(), imported = deferred<unknown>()
  await ctx.plugin(Loader)
  ctx.loader.internal = { version: 'client', import: () => imported.promise } as unknown as NonNullable<Loader['internal']>
  const creation = ctx.loader.create({ name: COMMAND_DIRECTORY_CONSUMER })
  await flush()
  let installed = false
  const installing = installCommandDirectoryProvider(ctx).then(stop => { installed = true; return stop })
  try {
    await flush()
    assert.equal(installed, true, 'the public loader will finish the pending import independently')
    const entry = [...ctx.loader.entries()][0]!
    assert.equal(entry.options.isolate?.['remote.commands'], COMMAND_DIRECTORY_REALM)
    let stopped = false
    const stopping = (await installing)().then(() => { stopped = true })
    await flush()
    assert.equal(stopped, true, 'provider disposal must not wait for an unrelated import either')
    await stopping
    assert.equal(entry.options.isolate?.['remote.commands'], undefined)
    imported.resolve({ inject: ['remote', 'remote.commands'], apply() {} })
    await creation
  } finally {
    imported.resolve({ inject: ['remote', 'remote.commands'], apply() {} })
    await creation
    await (await installing)()
    await ctx.fiber.dispose()
  }
})
