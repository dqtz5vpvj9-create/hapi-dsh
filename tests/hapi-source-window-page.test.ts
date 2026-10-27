/** Actual RPC method, SourceHistoryWindow and native page renderer.
 * HAPI transport and agent services are fixtures; no Host/browser is started. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HapiController } from '../src/index.ts'
import { NativeCodexAgent } from '../src/codex/agent.ts'
import { SourceHistoryWindow, SourceHistoryWindowError, type RenderedHistoryPage } from '../src/codex/source-window.ts'
import type { HapiMessage, HapiMessagesQuery, HapiTransport } from '../src/codex/contracts.ts'
import { sourceHistoryOutlineValueSchema, sourceHistoryWindowRequestSchema } from '../src/source-window-types.ts'

const id = SessionId(`hapi-codex-${'e'.repeat(32)}`)

function fixture() {
  const requests: HapiMessagesQuery[] = []
  const rows: HapiMessage[] = Array.from({ length: 800 }, (_, index) => {
    const seq = index + 1, key = `native-row-${seq}`
    const execution = { threadId: 'thread', turnId: 'one-long-turn', itemId: key,
      turn: { started: true, ended: false, status: 'inProgress' } }
    return { id: key, localId: key, seq, createdAt: seq, invokedAt: seq,
      content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: key,
        message: seq === 800 ? 'whole source row '.repeat(4_000) : key, nativeExecution: execution } } } }
  })
  let reset = false
  const transport = { readMessages: async (_id: string, query: HapiMessagesQuery = {}) => {
    requests.push(query)
    const selected = rows.filter(row => row.seq! < (query.beforeSeq ?? 801)).slice(-(query.limit ?? 200))
    const first = selected[0]?.seq ?? null, last = selected.at(-1)?.seq ?? null
    return { messages: selected, page: { direction: 'before', limit: query.limit ?? 200, epoch: 1, reset,
      hasMore: first !== null && first > 1, nextBeforeAt: first, nextBeforeSeq: first,
      nextAfterAt: last, nextAfterSeq: last, snapshotHeadAt: 800, snapshotHeadSeq: 800 } }
  } } as HapiTransport
  const agent = {
    id, logicalSessionId: id, historyPageId: 0,
    binding: { hubId: 'hub', hapiSessionId: 'source', threadId: 'thread', home: null, homeId: null, machineId: 'machine' },
    options: { model: 'fixture', provider: 'fixture' },
    content: { prepare: async () => {}, get: () => undefined },
    historyWindowAnchor: () => ({ epoch: 1, before: { at: 801, seq: 801 }, firstTurn: 1, hasOlder: true }),
    renderHistoryPage: (page: readonly HapiMessage[]): Promise<RenderedHistoryPage> => NativeCodexAgent.prototype.renderHistoryPage.call(agent as unknown as NativeCodexAgent, page),
  }
  const window = new SourceHistoryWindow(agent, transport)
  const controller = Object.create(HapiController.prototype) as HapiController
  Object.defineProperties(controller, {
    options: { value: { client: transport } },
    requireHistoryWindow: { value: () => window },
    sourceAgent: { value: () => agent },
    workbenchSource: { value: () => ({ sourceSessionId: 'source', sourceHubId: 'hub', machineId: 'machine' }) },
  })
  return { controller, window, requests, rows, reset: () => { reset = true } }
}

const routes = [{ fromOldest: true }, { beforeAt: 801, beforeSeq: 801 }] as const

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
      const records = first.records as Array<{ source?: { messageId: string }; event: { type: string; data: any } }>
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

  test(`${name}: ordinary paging keeps its existing three-page turn batching`, async () => {
    const f = fixture()
    try {
      const page = await f.controller.sourceHistoryWindowPage({ sessionId: id, ...route })
      assert.deepEqual(f.requests.map(query => query.limit), [200, 200, 200])
      assert.deepEqual(page.before, { at: 201, seq: 201 })
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
