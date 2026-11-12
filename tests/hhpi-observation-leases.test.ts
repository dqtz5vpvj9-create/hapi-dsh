/** Real adapter/index lifetime; only native RPC, metadata and clock are fixtures. */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts'
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts'
import { nativeMetadataFixture, sliceNativeEntries } from './fixtures/hhpi-native-metadata.ts'
import type { NativeItem, NativeItemEntry, NativeTurn } from '../src/remote/codex-native.ts'
import type { NativeMetadataPage, NativeMetadataRequest } from '../src/remote/codex-metadata-core.mjs'

test('reader leases stop idle body polling and reopen the durable index without resetting its epoch', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const directory = await mkdtemp(join(existsSync('/mnt/cache/data-cache') ? '/mnt/cache/data-cache' : tmpdir(), 'hhpi-observation-lease-'))
  let now = 1_000, notify: (frame: NativeNotification) => void = () => {}, metadataReads = 0
  const thread = { id: 'thread', cwd: directory, createdAt: 1, updatedAt: 1, status: { type: 'active' } }
  const rpc = { online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
    onNotification: (listener: typeof notify) => { notify = listener; return () => {} }, onRequest: () => () => {}, onDisconnect: () => () => {},
    request: async (method: string) => {
      if (method === 'thread/list') return { data: [thread], nextCursor: null }
      if (method === 'thread/loaded/list') return { data: ['thread'], nextCursor: null }
      if (method === 'thread/read') return { thread }
      throw new Error(`Unexpected native IO: ${method}`)
    } } as unknown as CodexRpc
  const metadata = nativeMetadataFixture(() => [])
  const adapter = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex' }, directory,
    { rpc, now: () => now, readMetadata: request => { metadataReads++; return metadata(request) } })
  t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }) })
  const [session] = await adapter.list(), head = await adapter.read({ sessionId: session!.id })
  const acceptedReads = metadataReads
  notify({ method: 'item/agentMessage/delta', params: { threadId: thread.id } })
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve))
  assert.equal(metadataReads, acceptedReads, 'running execution without a display reader does not poll body snapshots')
  now += 31_000; t.mock.timers.tick(250)
  const reopened = await adapter.read({ sessionId: session!.id })
  assert.equal(reopened.epoch, head.epoch, 'closing the idle display index preserves durable native identity')
  assert.ok(metadataReads > acceptedReads, 'reentry validates the current sparse tail')
  const reader = new AbortController(), changes = adapter.changes({ sessionId: session!.id, epoch: reopened.epoch, version: reopened.version }, reader.signal)[Symbol.asyncIterator]()
  await changes.next()
  const before = metadataReads
  t.mock.timers.tick(250); await new Promise(resolve => setImmediate(resolve))
  assert.ok(metadataReads > before, 'an actual shared observer activates source polling')
  reader.abort(); await changes.return?.()
})


test('continuous tail notifications do not restart a revision-verified historical cursor', async t => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-page-observation-')
  let notify: (frame: NativeNotification) => void = () => {}, race = false, historicalReads = 0
  const thread = { id: 'thread', cwd: directory, createdAt: 1, updatedAt: 1, status: { type: 'idle' } }
  const rpc = { online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
    onNotification: (listener: typeof notify) => { notify = listener; return () => {} }, onRequest: () => () => {}, onDisconnect: () => () => {},
    request: async (method: string) => {
      if (method === 'thread/list') return { data: [thread], nextCursor: null }
      if (method === 'thread/loaded/list') return { data: ['thread'], nextCursor: null }
      if (method === 'thread/read') return { thread }
      throw new Error(`Unexpected native IO: ${method}`)
    } } as unknown as CodexRpc
  const metadata = nativeMetadataFixture(() => [])
  const adapter = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex' }, directory,
    { rpc, readMetadata: async request => {
      if (request.before !== undefined) {
        historicalReads++
        if (race) notify({ method: 'item/agentMessage/delta', params: { threadId: thread.id } })
      }
      return metadata(request)
    } })
  t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }) })
  const [session] = await adapter.list(), head = await adapter.read({ sessionId: session!.id })
  race = true
  const page = await adapter.read({ sessionId: session!.id, before: 16 })
  assert.equal(page.epoch, head.epoch)
  assert.equal(historicalReads, 2, 'one sparse selection and its revision verification, without restarting the page')
})

/** A long running turn: the old page is outside the opening sparse tail. */
async function historicalFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-fixed-page-')
  const thread = { id: 'thread', cwd: directory, createdAt: 1, updatedAt: 1, status: { type: 'active' } }
  const turn: NativeTurn = { id: 'running-turn', status: 'inProgress', startedAt: 1, completedAt: null }
  const items: NativeItem[] = Array.from({ length: 40 }, (_, i) => ({ id: `answer-${i}`, type: 'agentMessage', text: `body ${i}` }))
  let generation = 1
  let notify: (frame: NativeNotification) => void = () => {}
  let onMetadata: (request: NativeMetadataRequest, page: NativeMetadataPage) => void | Promise<void> = () => {}
  const calls: string[] = [], metadata = nativeMetadataFixture(() => [{ turn, items }])
  const adapter = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex' }, directory, {
    rpc: { online: true, get currentGeneration() { return generation }, connect: async () => ({}), dispose: async () => {},
      onNotification: (listener: typeof notify) => { notify = listener; return () => {} }, onRequest: () => () => {}, onDisconnect: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push(method)
        if (method === 'thread/list') return { data: [thread], nextCursor: null }
        if (method === 'thread/loaded/list') return { data: ['thread'], nextCursor: null }
        if (method === 'thread/read') return { thread }
        if (method === 'thread/items/list') return sliceNativeEntries(items.map(item => ({ turnId: turn.id, item: structuredClone(item) } satisfies NativeItemEntry)), params)
        throw new Error(`Unexpected native IO: ${method}`)
      } } as unknown as CodexRpc,
    readMetadata: async request => { const page = await metadata(request); await onMetadata(request, page); return page },
  })
  t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }) })
  const [session] = await adapter.list(), head = await adapter.read({ sessionId: session!.id })
  const request = { sessionId: session!.id, before: 72, limit: 16, epoch: head.epoch }
  return { adapter, items, calls, head, request, notify: (frame: NativeNotification) => notify(frame),
    changeGeneration: () => { generation++ },
    metadataHook: (hook: typeof onMetadata) => { onMetadata = hook } }
}

test('an earlier page merges once while the same running turn appends and its metadata changes', async t => {
  const f = await historicalFixture(t)
  let selections = 0
  const headers = f.calls.filter(method => method === 'thread/read').length
  f.notify({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'running-turn' } })
  f.metadataHook(request => {
    if (request.before === undefined) return
    selections++
    const item = f.items[39] = { id: 'answer-39', type: 'agentMessage', text: `new live tail ${selections}` }
    f.notify({ method: 'item/completed', params: { threadId: 'thread', turnId: 'running-turn', item } })
    f.notify({ method: 'thread/status/changed', params: { threadId: 'thread', status: { type: 'active' } } })
    f.notify({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'running-turn' } })
  })
  const page = await f.adapter.read(f.request)
  assert.equal(page.epoch, f.head.epoch)
  assert.ok(page.entries.some(entry => entry.event.type === 'assistant/message'), 'the selected old body is published')
  assert.ok(page.before !== null && page.before < f.request.before)
  assert.equal(selections, 2, 'selection plus exact revision verification, no page restart')
  assert.equal(f.calls.filter(method => method === 'thread/read').length, headers, 'dirty live tail does not add a head refresh to an older cursor')
})

test('accepting another fixed page does not invalidate the earlier page being prepared', async t => {
  const f = await historicalFixture(t), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  t.after(() => release.resolve())
  let held = false
  f.metadataHook(async request => {
    if (request.before !== 8 || held) return
    held = true; started.resolve(); await release.promise
  })
  const pending = f.adapter.read(f.request)
  await started.promise
  const other = await f.adapter.read({ ...f.request, before: 120 })
  release.resolve()
  const page = await pending
  assert.equal(page.epoch, other.epoch)
  assert.ok(page.entries.some(entry => entry.event.type === 'assistant/message'))
  assert.ok(other.entries.some(entry => entry.event.type === 'assistant/message'))
})

test('a delayed verified page cannot overwrite a newer accepted item revision', async t => {
  const f = await historicalFixture(t), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  t.after(() => release.resolve())
  let reads = 0
  f.metadataHook(async request => {
    if (request.before === undefined || ++reads !== 2) return
    started.resolve(); await release.promise
  })
  const pending = f.adapter.read(f.request)
  await started.promise
  f.items[5] = { id: 'answer-5', type: 'agentMessage', text: 'new selected revision' }
  const newer = await f.adapter.read(f.request)
  assert.ok(JSON.stringify(newer.entries).includes('new selected revision'))
  release.resolve()
  const page = await pending
  assert.ok(JSON.stringify(page.entries).includes('new selected revision'))
  assert.ok(!JSON.stringify(page.entries).includes('"text":"body 5"'), 'the delayed old body never replaces the accepted revision')
  assert.ok(reads >= 6, 'a real selected revision conflict is still reobserved')
})

test('a native connection generation change still reobserves a fixed older page', async t => {
  const f = await historicalFixture(t)
  let reads = 0
  f.metadataHook(request => {
    if (request.before !== undefined && ++reads === 1) f.changeGeneration()
  })
  const page = await f.adapter.read(f.request)
  assert.ok(page.entries.some(entry => entry.event.type === 'assistant/message'))
  assert.equal(reads, 4, 'the old-generation candidate cannot publish; the new generation selects and verifies again')
})

for (const method of ['thread/reverted', 'thread/compacted', 'thread/deleted'] as const) {
  test(`${method} still rejects an in-flight page pinned to the old source`, async t => {
    const f = await historicalFixture(t)
    let changed = false
    f.metadataHook(request => {
      if (request.before === undefined || changed) return
      changed = true; f.notify({ method, params: { threadId: 'thread' } })
    })
    await assert.rejects(f.adapter.read(f.request), { code: method === 'thread/deleted' ? 'HISTORY_UNAVAILABLE' : 'STALE_VERSION' })
  })
}


test('queued steering acquires the exact native item despite unrelated live-tail observations', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-queue-observation-')
  const thread = { id: 'thread', cwd: directory, createdAt: 1, updatedAt: 1, status: { type: 'active' } }
  const original = { id: 'original-item', clientUserMessageId: 'original-client', input: [{ type: 'text', text: 'owned queued input', text_elements: [] }] }
  const callbacks = new Set<(frame: NativeNotification) => void>(), writes: Array<{ method: string; params: Record<string, unknown> }> = []
  let rows = [original], correlate = false
  const metadata = nativeMetadataFixture(() => [])
  const adapter = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex' }, directory, {
    rpc: { online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
      onNotification: (listener: (frame: NativeNotification) => void) => { callbacks.add(listener); return () => { callbacks.delete(listener) } },
      onRequest: () => () => {}, onDisconnect: () => () => {},
      request: async (method: string, params: Record<string, unknown>, options?: { write?: boolean }) => {
        if (options?.write) writes.push({ method, params })
        if (method === 'thread/list') return { data: [thread], nextCursor: null }
        if (method === 'thread/loaded/list') return { data: ['thread'], nextCursor: null }
        if (method === 'thread/read') return { thread }
        if (method === 'thread/queue/list') return { data: rows, nextCursor: null }
        if (method === 'thread/queue/delete') { assert.equal(params.queuedSubmissionId, original.id); rows = []; return { deleted: true } }
        if (method === 'turn/steer') return { turnId: 'captured-turn' }
        throw new Error(`Unexpected native IO: ${method}`)
      } } as unknown as CodexRpc,
    readMetadata: async request => {
      const page = await metadata(request)
      if (correlate && request.userOnly) for (const listener of callbacks) listener({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'captured-turn' } })
      return page
    },
  })
  t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }) })
  const [session] = await adapter.list(); await adapter.read({ sessionId: session!.id }); correlate = true
  const request = { sourceId: 'source', method: 'hhpi/queue/steer', operationId: 'original-transfer',
    params: { threadId: 'thread', expectedTurnId: 'captured-turn', queuedSubmissionId: original.id, clientUserMessageId: original.clientUserMessageId, input: original.input } }
  let response, failure: unknown
  try { response = await adapter.nativeAccess.call(request) } catch (error) { failure = error }
  const names = await readdir(join(directory, 'queue-steer-inputs'))
  const retained = await readFile(join(directory, 'queue-steer-inputs', names.find(name => name.endsWith('.json'))!), 'utf8')
  assert.ok(retained.includes('owned queued input'), 'claim durably retains the original before any transfer')
  assert.equal(response?.status, 'accepted', failure instanceof Error ? failure.message : 'the original queue action must complete')
  assert.deepEqual(writes.map(call => call.method), ['thread/queue/delete', 'turn/steer'])
  assert.deepEqual(writes[1]?.params, { threadId: 'thread', expectedTurnId: 'captured-turn', clientUserMessageId: original.clientUserMessageId, input: original.input })
  assert.equal((await adapter.nativeAccess.call(request, true)).status, 'accepted')
  assert.equal(writes.length, 2, 'receipt lookup never repeats either native write when correlation reads conflict')
})
