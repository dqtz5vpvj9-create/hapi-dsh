/** Actual RPC method, SourceHistoryWindow and native page renderer.
 * HAPI transport and agent services are fixtures; no Host/browser is started. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HapiController } from '../src/index.ts'
import { NativeCodexAgent } from '../src/codex/agent.ts'
import { SourceHistoryWindow, SourceHistoryWindowError, type RenderedHistoryPage, type SourceOutlineReader } from '../src/codex/source-window.ts'
import type { HapiMessage, HapiMessagesQuery, HapiTransport } from '../src/codex/contracts.ts'
import { SOURCE_HISTORY_FRAME_CHUNK_SIZE, sourceHistoryOutlinePageValueSchema, sourceHistoryOutlineValueSchema, sourceHistoryWindowPageStreamItemSchema, sourceHistoryWindowRequestSchema } from '../src/source-window-types.ts'

const id = SessionId(`hapi-codex-${'e'.repeat(32)}`)

function fixture(readOutline?: SourceOutlineReader, multipleTurns = false) {
  const requests: HapiMessagesQuery[] = []
  const enrichmentBatches: unknown[] = []
  const rows: HapiMessage[] = Array.from({ length: 800 }, (_, index) => {
    const seq = index + 1, key = `native-row-${seq}`
    const execution = { threadId: 'thread', turnId: multipleTurns ? `turn-${Math.floor((seq - 1) / 100)}` : 'one-long-turn', itemId: key,
      turn: { started: true, ended: false, status: 'inProgress' } }
    return { id: key, localId: key, seq, createdAt: seq, invokedAt: seq,
      content: { role: multipleTurns && seq % 100 === 1 ? 'user' : 'agent', content: { type: 'codex', data: { type: 'message', id: key,
        message: seq === 800 ? 'whole source row '.repeat(4_000) : key, nativeExecution: execution } } } }
  })
  let reset = false
  const transport = { readMessages: async (_id: string, query: HapiMessagesQuery = {}) => {
    requests.push(query)
    const selected = query.afterSeq === undefined
      ? rows.filter(row => row.seq! < (query.beforeSeq ?? 801)).slice(-(query.limit ?? 200))
      : rows.filter(row => row.seq! > query.afterSeq!).slice(0, query.limit ?? 200)
    const first = selected[0]?.seq ?? null, last = selected.at(-1)?.seq ?? null
    return { messages: selected, page: { direction: 'before', limit: query.limit ?? 200, epoch: 1, reset,
      hasMore: query.afterSeq === undefined ? first !== null && first > 1 : last !== null && last < 800, nextBeforeAt: first, nextBeforeSeq: first,
      nextAfterAt: last, nextAfterSeq: last, snapshotHeadAt: 800, snapshotHeadSeq: 800 } }
  } } as HapiTransport
  const agent = {
    id, logicalSessionId: id, historyPageId: 0,
    binding: { hubId: 'hub', hapiSessionId: 'source', threadId: 'thread', home: null, homeId: null, machineId: 'machine' },
    options: { model: 'fixture', provider: 'fixture' },
    content: { prepare: async () => {}, get: () => undefined },
    historyWindowAnchor: () => ({ epoch: 1, before: { at: 801, seq: 801 }, firstTurn: 1_000_001, hasOlder: true,
      oldest: { id: 'native-row-801', at: 801, seq: 801 } }),
    renderHistoryPage: (page: readonly HapiMessage[]): Promise<RenderedHistoryPage> => NativeCodexAgent.prototype.renderHistoryPage.call(agent as unknown as NativeCodexAgent, page),
    publishHistoryPageEnrichment: (frames: readonly unknown[]) => { enrichmentBatches.push(frames) },
  }
  const window = new SourceHistoryWindow(agent, transport, undefined, readOutline)
  const controller = Object.create(HapiController.prototype) as HapiController
  Object.defineProperties(controller, {
    options: { value: { client: transport } },
    requireHistoryWindow: { value: () => window },
    sourceAgent: { value: () => agent },
    workbenchSource: { value: () => ({ sourceSessionId: 'source', sourceHubId: 'hub', machineId: 'machine' }) },
  })
  return { controller, window, transport, requests, rows, agent, enrichmentBatches, reset: () => { reset = true } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const routes = [{ fromOldest: true }, { beforeAt: 801, beforeSeq: 801 }] as const

test('directory paging reads only metadata while latest identity uses its independent head route', async () => {
  const queries: Parameters<SourceOutlineReader>[0][] = []
  const f = fixture(async query => {
    queries.push(query)
    const seq = queries.length === 1 ? 700 : 300
    return { entries: [{ messageId: `native-row-${seq}`, label: `turn ${seq}`, at: seq, seq, createdAt: seq }],
      page: { epoch: 1, hasMore: seq === 700, beforeCursor: seq === 700 ? { at: seq, seq } : null,
        complete: seq !== 700, scannedThrough: 800, headSeq: 800 } }
  })
  try {
    const first = sourceHistoryOutlinePageValueSchema.parse(await f.controller.sourceHistoryOutlinePage({ sessionId: id, limit: 10 }))
    assert.equal(first.head, undefined, 'metadata does not pretend its last user label is the latest source message')
    assert.equal(first.entries.length, 1)
    assert.equal(first.hasMore, true)
    assert.deepEqual(f.requests, [], 'the directory must not wait behind an unrelated transcript head read')
    const next = sourceHistoryOutlinePageValueSchema.parse(await f.controller.sourceHistoryOutlinePage({ sessionId: id,
      beforeAt: first.cursor!.at, beforeSeq: first.cursor!.seq, epoch: first.epoch, limit: 10 }))
    assert.equal(next.entries.length, 2)
    assert.equal(next.complete, true)
    assert.deepEqual(queries, [{ limit: 10 }, { limit: 10, beforeAt: 700, beforeSeq: 700, epoch: 1 }])
    assert.deepEqual(f.requests, [])
    const head = await f.controller.sourceHistoryHead({ sessionId: id })
    assert.equal(head.messageId, 'native-row-800')
    assert.deepEqual(f.requests, [{ limit: 1, bounded: true }])
  } finally { f.window.dispose() }
})

test('the outline RPC preserves indexing coverage and unreadable status through the client schema', async () => {
  const f = fixture()
  try {
    for (const status of [
      { complete: false, indexing: true, unreadable: false, scannedThrough: 128, headSeq: 800 },
      { complete: false, indexing: false, unreadable: true, scannedThrough: 800, headSeq: 800 },
      { complete: true, indexing: false, unreadable: false, scannedThrough: 800, headSeq: 800 },
    ]) {
      f.window.canonicalOutline = async () => ({ entries: [], seedIndex: 0, firstTurn: 1, epoch: 1, ...status })
      const response = sourceHistoryOutlineValueSchema.parse(await f.controller.sourceHistoryOutline({ sessionId: id }))
      for (const key of Object.keys(status) as Array<keyof typeof status>) assert.equal(response[key], status[key])
      assert.equal(response.head?.messageId, 'native-row-800')
    }
  } finally { f.window.dispose() }
})

test('the source-window wire contract bounds the optional raw row limit', () => {
  for (const limit of [1, 20, 200]) assert.equal(sourceHistoryWindowRequestSchema.parse({ sessionId: id, fromOldest: true, limit }).limit, limit)
  for (const limit of [0, -1, 201, 1.5]) assert.equal(sourceHistoryWindowRequestSchema.safeParse({ sessionId: id, fromOldest: true, limit }).success, false)
})

test('the Host streams one complete history page in bounded frame batches and ends with its cursor', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    const items = []
    for await (const item of f.controller.sourceHistoryWindowPageStream({ sessionId: id, fromOldest: true, limit: 20 }, controller.signal)) {
      items.push(sourceHistoryWindowPageStreamItemSchema.parse(item))
    }
    assert.deepEqual(f.requests.map(query => query.limit), [20], 'one stream open reads one source page')
    assert.equal(items.at(-1)?.kind, 'complete', 'the cursor record terminates the stream')
    const batches = items.filter(item => item.kind === 'frames')
    assert.ok(batches.length >= 2, 'the projected page is divided into multiple small WebSocket messages')
    assert.ok(batches.every(item => item.kind === 'frames' && item.frames.length > 0 && item.frames.length <= SOURCE_HISTORY_FRAME_CHUNK_SIZE),
      'every body batch stays within the transport frame limit')
    const edges = batches.map(item => item.kind === 'frames' ? item.frames.at(-1)!.source!.seq : -1)
    assert.ok(edges.every((seq, index) => index === 0 || seq <= edges[index - 1]!),
      'small transport batches remain source ordered from the current window edge toward older history')
    const frameKeys = batches.flatMap(item => item.kind === 'frames' ? item.frames.map(frame => frame.key) : [])
    assert.equal(new Set(frameKeys).size, frameKeys.length, 'each projected frame is transported once')
    const complete = items.at(-1)!
    assert.equal(complete.kind, 'complete')
    if (complete.kind === 'complete') {
      assert.deepEqual(complete.value.before, { at: 781, seq: 781 })
      assert.equal(complete.value.hasMoreBefore, true)
      assert.equal(Object.hasOwn(complete.value, 'records'), false, 'the stream does not duplicate the raw record page')
      assert.equal(Object.hasOwn(complete.value, 'frames'), false, 'all projected frames travel only in bounded batches')
    }
  } finally { controller.abort(); f.window.dispose() }
})

test('cancelling a streamed history page aborts the upstream HAPI message read', async () => {
  const f = fixture()
  const requested = deferred<AbortSignal>()
  const aborted = deferred<void>()
  f.transport.readMessages = async (_sessionId, _query, signal) => {
    assert.ok(signal, 'the source stream cancellation reaches the HAPI transport')
    requested.resolve(signal)
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted.resolve()
      reject(signal.reason)
    }, { once: true }))
  }
  const controller = new AbortController()
  const iterator = f.controller.sourceHistoryWindowPageStream(
    { sessionId: id, fromOldest: true, limit: 20 }, controller.signal)[Symbol.asyncIterator]()
  try {
    const first = iterator.next()
    const upstream = await requested.promise
    controller.abort(new Error('reader cancelled'))
    assert.equal(upstream.aborted, true)
    await aborted.promise
    await assert.rejects(first, /reader cancelled/)
  } finally {
    controller.abort()
    await iterator.return?.()
    f.window.dispose()
  }
})

test('resource enrichment cannot hold a readable history page open', async () => {
  const f = fixture(), resourceRead = deferred<void>()
  const baseRender = f.agent.renderHistoryPage
  f.agent.renderHistoryPage = async rows => {
    const rendered = await baseRender(rows)
    return { ...rendered, resourceEnrichment: resourceRead.promise.then(() => rendered) }
  }
  try {
    const page = await f.controller.sourceHistoryWindowPage({ sessionId: id, beforeAt: 801, beforeSeq: 801, limit: 20 })
    assert.ok((page.frames?.length ?? 0) > 20, 'the page contains the projected event frames for its source rows')
    assert.equal(Object.hasOwn(page, 'resourceEnrichment'), false, 'the internal background task is never serialized to the client')
    assert.deepEqual(f.enrichmentBatches, [], 'the resource read remains independent after page commit')

    resourceRead.resolve()
    for (let turn = 0; turn < 4 && f.enrichmentBatches.length === 0; turn++) await Promise.resolve()
    assert.equal(f.enrichmentBatches.length, 1)
    const batch = f.enrichmentBatches[0]
    assert.ok(Array.isArray(batch))
    const frames = batch as Array<{ contentRevision?: number }>
    assert.ok(frames.every(frame => frame.contentRevision === 1), 'late resource content is published as a newer row revision')
  } finally { resourceRead.resolve(); f.window.dispose() }
})

for (const route of routes) {
  const name = 'fromOldest' in route ? 'seed edge' : 'explicit cursor'
  test(`${name}: an explicit limit reads one contiguous page and preserves the full projection`, async () => {
    const f = fixture()
    try {
      const first = await f.controller.sourceHistoryWindowPage({ sessionId: id, ...route, limit: 20 })
      assert.equal(f.requests.length, 1)
      assert.equal(f.requests[0]!.limit, 20)
      assert.deepEqual(first.before, { at: 781, seq: 781 })
      assert.equal(first.hasMoreBefore, true)
      const records = first.frames as Array<{ source?: { messageId: string }; event: { type: string; data: any } }>
      assert.deepEqual([...new Set(records.map(row => row.source?.messageId))], f.rows.slice(-20).map(row => row.id))
      assert.ok(records.length > 20, 'the row limit must not truncate projected lifecycle events')
      assert.equal(records.filter(row => row.event.type === 'assistant/message').length, 20)
      assert.equal(records.filter(row => row.event.type === 'step/start').length, 20)
      assert.equal(records.filter(row => row.event.type === 'step/end').length, 20)
      assert.equal(records.filter(row => row.event.type === 'turn/start').length, 0, 'a partial long turn must not create a synthetic new turn')
      assert.equal(records.filter(row => row.event.type === 'turn/end').length, 0)
      assert.equal(records.filter(row => row.event.type === 'assistant/message').at(-1)!.event.data.message.content[0].text,
        'whole source row '.repeat(4_000))
      const next = await f.controller.sourceHistoryWindowPage({ sessionId: id,
        beforeAt: first.before!.at, beforeSeq: first.before!.seq, limit: 20 })
      assert.deepEqual(next.before, { at: 761, seq: 761 })
      assert.equal(f.requests.length, 2)
      assert.equal(f.requests[1]!.beforeSeq, 781)
    } finally { f.window.dispose() }
  })

  test(`${name}: ordinary paging matches HAPI's 50-message, two-turn page up to 500`, async () => {
    const f = fixture()
    try {
      const page = await f.controller.sourceHistoryWindowPage({ sessionId: id, ...route })
      assert.deepEqual(f.requests.map(query => query.limit), [200, 200, 100])
      assert.deepEqual(page.before, { at: 301, seq: 301 })
      assert.equal(page.hasMoreBefore, true)
    } finally { f.window.dispose() }
  })

  test(`${name}: a limited page still rejects source epoch reset`, async () => {
    const f = fixture()
    try {
      f.reset()
      await assert.rejects(() => f.controller.sourceHistoryWindowPage({ sessionId: id, ...route, limit: 20 }), SourceHistoryWindowError)
      assert.equal(f.requests.length, 1)
    } finally { f.window.dispose() }
  })
}

for (const route of routes) {
  test(`${'fromOldest' in route ? 'seed edge' : 'explicit cursor'}: two source turns complete the normal page`, async () => {
    const f = fixture(undefined, true)
    try {
      const page = await f.controller.sourceHistoryWindowPage({ sessionId: id, ...route })
      assert.deepEqual(f.requests.map(query => query.limit), [200])
      assert.ok(new Set(page.frames!.map(frame => frame.source?.messageId)).size >= 50,
        'the page contains HAPI’s minimum message window before its second-turn boundary')
      assert.deepEqual(page.before, { at: 601, seq: 601 })
      assert.equal(page.hasMoreBefore, true)
    } finally { f.window.dispose() }
  })
}

test('a limited empty page returns exhaustion and no fabricated continuation cursor', async () => {
  const f = fixture()
  try {
    const page = await f.controller.sourceHistoryWindowPage({ sessionId: id, beforeAt: 1, beforeSeq: 1, limit: 20 })
    assert.equal(f.requests.length, 1)
    assert.deepEqual(page.records, [])
    assert.equal(page.before, null)
    assert.equal(page.hasMoreBefore, false)
  } finally { f.window.dispose() }
})


test('a forward page honors its explicit row limit and continues from the served edge', async () => {
  const f = fixture()
  try {
    const first = await f.controller.sourceHistoryWindowPage({ sessionId: id, afterAt: 20, afterSeq: 20, limit: 20 })
    assert.deepEqual(f.requests.map(query => [query.afterSeq, query.limit]), [[20, 20]])
    assert.equal(first.frames!.filter(frame => frame.event.type === 'assistant/message').length, 20)
    assert.deepEqual(first.after, { at: 40, seq: 40 })
    assert.equal(first.hasMoreAfter, true)
    const next = await f.controller.sourceHistoryWindowPage({ sessionId: id, afterAt: first.after!.at, afterSeq: first.after!.seq, limit: 20 })
    assert.deepEqual(f.requests.map(query => [query.afterSeq, query.limit]), [[20, 20], [40, 20]])
    assert.deepEqual(next.after, { at: 60, seq: 60 })
  } finally { f.window.dispose() }
})
