import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPage, SessionPageRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HapiMessage, HapiMessagesPage, HapiTransport } from '../src/codex/contracts.ts'
import { DISPLAY_SEQ_OFFSET, DISPLAY_TURN_BASE, DisplayHistoryWindows, SourceHistoryWindow, type RenderedHistoryPage } from '../src/codex/source-window.ts'

function boundary() { return { threadId: 'thread', turnId: 'turn', itemId: 'item' } }
function row(id: number, turn: number, userMessage = false): HapiMessage {
  return { id: `row-${id}`, localId: userMessage ? `local-${id}` : null, seq: id,
    createdAt: 1000 + id, invokedAt: userMessage ? 1000 + id : null,
    content: userMessage ? { role: 'user', content: { type: 'text', text: `turn ${turn}` } }
      : { role: 'agent', content: { type: 'text', text: `answer ${id}` } } }
}

/** The window only sees the same public rendering contract as each Agent. */
function indexIsPartial(rows: readonly HapiMessage[], anchorIndex: number): boolean {
  const before = rows.slice(0, anchorIndex + 1)
  return !before.some(row => row.localId !== null)
}

function fakeAgent(rows: readonly HapiMessage[], anchorIndex: number) {
  const turns = [...new Set(rows.map((_, index) => Math.floor(index / 3)))]
  return {
    id: SessionId('hapi-codex-source-window-fixture'),
    binding: { hapiSessionId: 'source-window-fixture' },
    historyWindowAnchor() {
      const anchor = rows[anchorIndex]!
      return { epoch: 1, before: { at: anchor.createdAt, seq: anchor.seq! },
        firstTurn: DISPLAY_TURN_BASE + 1, hasOlder: anchorIndex > 0,
        oldest: { id: anchor.id, at: anchor.createdAt, seq: anchor.seq! }, partial: indexIsPartial(rows, anchorIndex) }
    },
    renderHistoryPage(pageRows: readonly HapiMessage[]): RenderedHistoryPage {
      const session = Session.create(SessionId(`history-${pageRows[0]?.id}`))
      let turn = 0
      let lastTurn = -1
      const sources = new Map<string, number>()
      const rewinds = new Map<number, string>()
      const forks = new Map<string, ReturnType<typeof boundary>>()
      const turnAnchors = new Map<number, { id: string; at: number; seq: number; key: string | null }>()
      for (const [index, item] of pageRows.entries()) {
        const sourceTurn = Math.floor(index / 3)
        if (sourceTurn !== lastTurn) {
          lastTurn = sourceTurn; turn++
          turnAnchors.set(turn, { id: item.id, at: item.createdAt, seq: item.seq ?? item.createdAt, key: null })
          session.append('turn/start', { turn })
        }
        const event: SessionEvent = item.localId
          ? session.append('user/message', freezeMessage({ id: MessageId(`u:${item.id}`), role: 'user',
            content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
          : session.append('assistant/message', { turn, step: 1,
            message: freezeMessage({ id: MessageId(`a:${item.id}`), role: 'assistant',
              content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
            stream: [] }, { surfaceOp: 'append' })
        sources.set(item.id, event.seq)
        if (item.localId) rewinds.set(event.seq, item.localId)
        if (!item.localId) forks.set(`a:${item.id}`, boundary())
      }
      return { events: session.snapshotEvents(), lastTurn: turn, sources, rewinds, forks, turnAnchors }
    },
  }
}

class FakeTransport implements HapiTransport {
  readonly hubId = 'fixture-hub'
  readonly queries: Array<{ at: number; seq: number }> = []
  constructor(readonly rows: readonly HapiMessage[], private readonly pageSize = 3) {}
  async readMessages(_id: string, query: { beforeAt?: number; beforeSeq?: number } = {}): Promise<HapiMessagesPage> {
    this.queries.push({ at: query.beforeAt ?? 0, seq: query.beforeSeq ?? 0 })
    const before = { at: query.beforeAt ?? Number.POSITIVE_INFINITY, seq: query.beforeSeq ?? Number.POSITIVE_INFINITY }
    const pool = this.rows.filter(item => item.createdAt < before.at || item.createdAt === before.at && (item.seq ?? 0) < before.seq)
    const selected = pool.slice(-this.pageSize)
    const oldest = selected[0]
    return { messages: structuredClone(selected), page: { direction: 'before', limit: this.pageSize, epoch: 1,
      reset: false, nextBeforeAt: oldest?.createdAt ?? null, nextBeforeSeq: oldest?.seq ?? null,
      nextAfterAt: null, nextAfterSeq: null, snapshotHeadAt: this.rows.at(-1)?.createdAt ?? null,
      snapshotHeadSeq: this.rows.at(-1)?.seq ?? null, hasMore: selected.length < pool.length } }
  }
  listSessions(): never { throw new Error('unused') }
  getSession(): never { throw new Error('unused') }
  sendMessage(): never { throw new Error('unused') }
  getQueuedState(): never { throw new Error('unused') }
  cancelQueuedMessage(): never { throw new Error('unused') }
  steerQueuedMessage(): never { throw new Error('unused') }
  retryIndeterminateMessage(): never { throw new Error('unused') }
  abortSession(): never { throw new Error('unused') }
  approve(): never { throw new Error('unused') }
  deny(): never { throw new Error('unused') }
  subscribe(): never { throw new Error('unused') }
}

test('source history window pages older turns with contiguous virtual seqs and no rebuild', async () => {
  const rows = Array.from({ length: 24 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 18)
  const transport = new FakeTransport(rows)
  const delegate = async (_request: SessionPageRequest): Promise<SessionPage> => { throw new Error('no real page expected') }
  const window = new SourceHistoryWindow(agent, transport)
  let before = DISPLAY_SEQ_OFFSET
  const seen = new Set<number>()
  let pages = 0
  while (true) {
    const page = await window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: before + 10,
      beforeSeq: before, maxMessages: 20 }, undefined, delegate)
    if (!page.records.length) { assert.equal(page.hasMore, false); break }
    assert.equal(page.records.at(-1)!.event.seq, before - 1)
    for (const [index, record] of page.records.entries()) {
      if (index > 0) assert.equal(record.event.seq, page.records[index - 1]!.event.seq + 1)
      assert.ok(record.event.seq < before)
      assert.ok(!seen.has(record.event.seq), 'each virtual seq appears once')
      seen.add(record.event.seq)
    }
    const firstTurn = page.records.find(record => record.event.type === 'turn/start')?.event.data as { turn: number } | undefined
    assert.ok(firstTurn === undefined || firstTurn.turn < agent.historyWindowAnchor()!.firstTurn)
    before = page.records[0]!.event.seq
    pages++
    if (!page.hasMore) break
    assert.ok(pages < 10)
  }
  assert.ok(pages >= 2)
  assert.ok(transport.queries.length >= pages)
})

test('canonical outline numbers every source turn around the live seed', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const outline = rows.filter((_row, index) => index % 3 === 0).map((item, index) => ({
    messageId: item.id, label: `question ${index + 1}`, at: item.createdAt, seq: item.seq ?? index, createdAt: item.createdAt,
  }))
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async query => {
    assert.equal(query.limit, 100)
    return { entries: outline, page: { epoch: 1, hasMore: false, beforeCursor: null, complete: true } }
  })
  const value = await window.canonicalOutline()
  assert.ok(value)
  assert.equal(value.seedIndex, 3)
  assert.deepEqual(value.entries.map(item => item.turn), [999998, 999999, 1_000_000, 1_000_001])
  assert.deepEqual(value.entries.map(item => item.seq), [2_000_000_000, 2_000_000_001, 2_000_000_002, 2_000_000_003])
  assert.equal(value.entries[2]?.messageId, 'row-7')
})

test('direct context windows map rendered turns to the canonical outline and assign bounded seqs', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const outline = rows.filter((_row, index) => index % 3 === 0).map((item, index) => ({
    messageId: item.id, label: `question ${index + 1}`, at: item.createdAt, seq: item.seq ?? index, createdAt: item.createdAt,
  }))
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async () => ({
    entries: outline, page: { epoch: 1, hasMore: false, beforeCursor: null },
  }))
  let reads = 0
  const page = await window.windowAt('row-10', 2, 3_000_000_000, async (messageId, radius) => {
    reads++
    assert.equal(messageId, 'row-10')
    assert.equal(radius, 2)
    return { messages: rows.slice(8, 12), page: { beforeCursor: { at: 1009, seq: 9 }, afterCursor: { at: 1012, seq: 12 },
      hasMoreBefore: true, hasMoreAfter: false, epoch: 1, reset: false } }
  })
  assert.equal(reads, 1)
  assert.deepEqual(page.records.map(item => item.event.seq), [3_000_000_000, 3_000_000_001, 3_000_000_002, 3_000_000_003, 3_000_000_004, 3_000_000_005])
  const starts = page.records.filter(item => item.event.type === 'turn/start').map(item => item.event.data as { turn: number })
  assert.deepEqual(starts.map(item => item.turn), [1_000_000, 1_000_001])
  assert.equal(page.hasMoreBefore, true)
})

test('a source page never splits the same source turn across virtual pages', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const transport = new FakeTransport(rows)
  const window = new SourceHistoryWindow(agent, transport)
  const page = await window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: DISPLAY_SEQ_OFFSET,
    beforeSeq: DISPLAY_SEQ_OFFSET, maxMessages: 20 }, undefined, async () => ({ records: [], hasMore: false }))
  const turns = page.records.flatMap(record => record.event.type === 'turn/start' ? [record.event.data.turn] : [])
  assert.deepEqual(turns, [...new Set(turns)])
  const firstSeq = page.records[0]!.event.seq
  const second = await window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: firstSeq + 1,
    beforeSeq: firstSeq, maxMessages: 20 }, undefined, async () => ({ records: [], hasMore: false }))
  assert.ok(second.records.every(record => record.event.seq < firstSeq))
})


test('history rewind/fork mappings survive page cache eviction', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows))
  const page = await window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: DISPLAY_SEQ_OFFSET,
    beforeSeq: DISPLAY_SEQ_OFFSET, maxMessages: 20 }, undefined, async () => ({ records: [], hasMore: false }))
  const first = page.records[0]!.event.seq
  const user = page.records.find(record => record.event.type === 'user/message')!
  const rewind = window.resolveRewind(user.event.seq)
  assert.ok(rewind)
  const assistant = page.records.find(record => record.event.type === 'assistant/message')!
  const assistantId = (assistant.event.data as { message: { id: string } }).message.id
  assert.deepEqual(window.resolveFork(`a:${assistantId.slice(2)}`), boundary())
  window.trimTo(0)
  assert.equal(window.resolveRewind(user.event.seq), rewind)
  assert.ok(first > 0)
})



test('display window retirement releases agent/cache refs and global bytes stay bounded', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const transport = new FakeTransport(rows)
  const registry = new DisplayHistoryWindows(1)
  const window = registry.window('display-a', agent, transport)
  const page = await window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: DISPLAY_SEQ_OFFSET,
    beforeSeq: DISPLAY_SEQ_OFFSET, maxMessages: 20 }, undefined, async () => ({ records: [], hasMore: false }))
  assert.ok(page.records.length > 0)
  assert.equal(registry.size, 1)
  assert.equal(registry.bytes, 0, 'a page over the global budget is served but not retained')
  registry.retire('display-a')
  assert.equal(registry.size, 0)
  assert.equal(registry.peek('display-a'), undefined)
  await assert.rejects(window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: DISPLAY_SEQ_OFFSET,
    beforeSeq: DISPLAY_SEQ_OFFSET }, undefined, async () => ({ records: [], hasMore: false })))
})

test('a single oversized page never bypasses the per-window cache ceiling', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const transport = new FakeTransport(rows)
  const window = new SourceHistoryWindow(agent, transport)
  const page = await window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: DISPLAY_SEQ_OFFSET,
    beforeSeq: DISPLAY_SEQ_OFFSET, maxMessages: 20 }, undefined, async () => ({ records: [], hasMore: false }))
  assert.ok(page.records.length > 0)
  assert.ok(window.cacheBytes <= 8 * 1024 * 1024)
})

test('a giant partial turn is delivered as bounded pages without an oversized-turn error', async () => {
  const rows = Array.from({ length: 2_400 }, (_, index) => row(index + 1, 0, index === 0))
  const agent = fakeAgent(rows, 2_300)
  const transport = new FakeTransport(rows, 300)
  const window = new SourceHistoryWindow(agent, transport)
  const page = await window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: DISPLAY_SEQ_OFFSET,
    beforeSeq: DISPLAY_SEQ_OFFSET, maxMessages: 20 }, undefined, async () => ({ records: [], hasMore: false }))
  assert.ok(page.records.length > 0)
  assert.ok(page.records.length < 3_000)
  assert.equal(page.hasMore, true)
})

test('canonical outline orders shuffled outline rows by source position', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 3)
  const ordered = rows.filter((_row, index) => index % 3 === 0).map((item, index) => ({
    messageId: item.id, label: `q${index}`, at: item.createdAt, seq: item.seq ?? index, createdAt: item.createdAt,
  }))
  const shuffled = [ordered[1]!, ordered[0]!]
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async () => ({
    entries: shuffled, page: { epoch: 1, hasMore: false, beforeCursor: null, complete: true },
  }))
  const value = await window.canonicalOutline()
  assert.ok(value)
  assert.deepEqual(value.entries.map(entry => entry.messageId), [ordered[0]!.messageId, ordered[1]!.messageId])
  assert.deepEqual(value.entries.map(entry => entry.turn), [1_000_000, 1_000_001])
})

test('canonical outline groups steer rows by native turn identity', async () => {
  const rows = [
    { ...row(1, 0, true), id: 'native:thread:turn-A:item-1:local-1' },
    { ...row(2, 0, false), id: 'native:thread:turn-A:item-2:local-2' },
    { ...row(3, 0, false), id: 'native:thread:turn-A:item-3:local-3' },
    { ...row(4, 1, true), id: 'native:thread:turn-B:item-4:local-4' },
    { ...row(5, 1, false), id: 'native:thread:turn-B:item-5:local-5' },
  ] as HapiMessage[]
  const agent = fakeAgent(rows, 3)
  const outline = rows.map(item => ({ messageId: item.id, label: item.id.endsWith('local-1') ? 'normal' : 'steer',
    at: item.createdAt, seq: item.seq ?? 0, createdAt: item.createdAt }))
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async () => ({
    entries: outline, page: { epoch: 1, hasMore: false, beforeCursor: null, complete: true },
  }))
  const value = await window.canonicalOutline()
  assert.ok(value)
  assert.equal(value.entries.length, 2, 'normal + steer + normal must produce two native turns, not three ordinals')
  assert.equal(value.entries[0]?.messageId, rows[0]!.id)
  assert.equal(value.entries[1]?.messageId, rows[3]!.id)
})

test('source outline pages cannot mix epochs', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 3)
  let calls = 0
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async () => {
    calls++
    return { entries: [], page: { epoch: calls, hasMore: true, beforeCursor: { at: 1, seq: 1 }, complete: false } }
  })
  await assert.rejects(window.canonicalOutline(), /epoch/)
})

test('outline pagination uses its current snapshot revision instead of the opening seed epoch', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 3)
  const queries: Array<{ epoch?: number }> = []
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async query => {
    queries.push(query)
    const item = queries.length === 1 ? rows[3]! : rows[0]!
    return { entries: [{ messageId: item.id, label: item.id, at: item.createdAt, seq: item.seq!, createdAt: item.createdAt }],
      page: { epoch: 2, hasMore: queries.length === 1, beforeCursor: { at: item.createdAt, seq: item.seq! }, complete: true } }
  })
  const result = await window.canonicalOutline()
  assert.deepEqual(queries.map(query => query.epoch), [undefined, 2])
  assert.equal(result?.epoch, 2)
  assert.equal(result?.entries.length, 2)
  assert.equal(window.agent, agent)
  assert.equal(window.attachments.disposed, false)
})

test('a native outline follows more than ten bounded pages to exhaustion and shares its in-flight read', async () => {
  const rows = Array.from({ length: 372 }, (_, index) => ({ ...row(index + 1, index, true),
    id: `native:thread:turn-${index}:item-${index}:local-${index}` }))
  const agent = fakeAgent(rows, 359), transport = new FakeTransport(rows)
  agent.renderHistoryPage = () => { throw new Error('An outline cannot render or retain transcript bodies') }
  const queries: Array<{ beforeAt?: number; beforeSeq?: number; epoch?: number }> = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const window = new SourceHistoryWindow(agent, transport, undefined, async query => {
    queries.push(query)
    assert.equal(query.limit, 100)
    if (queries.length === 1) await gate
    // Native metadata includes the boundary source among its 31 items; the
    // projected label filter removes it, so subsequent pages add 30 labels.
    const selected = rows.filter(item => query.beforeSeq === undefined || item.seq! <= query.beforeSeq).slice(-32)
    const sources = selected.slice(-31), more = selected.length > 31
    const labels = sources.filter(item => query.beforeSeq === undefined || item.seq! < query.beforeSeq)
    return { entries: labels.map(item => ({ messageId: item.id, label: item.id,
      at: item.createdAt, seq: item.seq!, createdAt: item.createdAt })), page: {
      epoch: 7, reset: false, hasMore: more, beforeCursor: sources[0] ? { at: sources[0].createdAt, seq: sources[0].seq! } : null,
      complete: !more, indexing: false, unreadable: false, scannedThrough: 372, headSeq: 372,
    } }
  })
  const first = window.canonicalOutline(), second = window.canonicalOutline()
  assert.equal(queries.length, 1, 'concurrent callers share one cursor chain')
  release()
  const [value, shared] = await Promise.all([first, second])
  assert.equal(value, shared)
  assert.ok(value?.complete)
  assert.equal(value.indexing, false)
  assert.equal(value.unreadable, false)
  assert.equal(value.epoch, 7, 'a newer source snapshot does not invalidate the opening seed owner')
  assert.equal(queries.length, 13)
  assert.deepEqual(queries.map(query => query.epoch), [undefined, ...Array(12).fill(7)])
  assert.deepEqual(value.entries.map(entry => entry.messageId), rows.map(item => item.id))
  assert.equal(value.seedIndex, 359)
  assert.equal(value.entries[359]!.turn, agent.historyWindowAnchor().firstTurn)
  assert.deepEqual(value.entries.map(entry => entry.seq), rows.map((_, index) => 2_000_000_000 + index))
  assert.equal(await window.canonicalOutline(), value, 'completed metadata is reused without rereading bodies')
  assert.equal(queries.length, 13)
  assert.equal(transport.queries.length, 0)
  assert.equal(window.cacheBytes, 0)
  assert.equal(window.mappingCount, 0)
  assert.equal(window.attachments.disposed, false)
})

test('indexing coverage restarts from the head before certifying the whole outline', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(index + 1, index, true))
  const queries: Array<{ beforeSeq?: number }> = []
  const window = new SourceHistoryWindow(fakeAgent(rows, 3), new FakeTransport(rows), undefined, async query => {
    queries.push(query)
    const indexing = queries.length === 1
    const selected = indexing ? [rows[0]!] : rows
    return { entries: selected.map(item => ({ messageId: item.id, label: item.id,
      at: item.createdAt, seq: item.seq!, createdAt: item.createdAt })), page: {
      epoch: 2, hasMore: indexing, beforeCursor: { at: rows[0]!.createdAt, seq: 1 },
      complete: !indexing, indexing, unreadable: false, scannedThrough: indexing ? 1 : 6, headSeq: 6,
    } }
  })
  const pending = await window.canonicalOutline()
  assert.equal(queries.length, 1, 'an unstable indexed prefix is not paged into a false complete result')
  assert.equal(pending?.complete, false)
  assert.equal(pending?.indexing, true)
  assert.equal(pending?.scannedThrough, 1)
  assert.equal(pending?.headSeq, 6)
  const ready = await window.canonicalOutline()
  assert.equal(ready?.complete, true)
  assert.equal(ready?.entries.length, 6, 'labels added above the previous cursor are included')
  assert.deepEqual(queries.map(query => query.beforeSeq), [undefined, undefined])
})

test('an indexing refresh preserves the last complete canonical coordinates until its replacement is complete', async () => {
  const rows = Array.from({ length: 9 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 6)
  let indexing = false, epoch = 1
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async () => {
    const selected = indexing ? [rows[6]!] : rows.filter((_item, index) => index % 3 === 0)
    return { entries: selected.map(item => ({ messageId: item.id, label: item.id,
      at: item.createdAt, seq: item.seq!, createdAt: item.createdAt })), page: {
      epoch, hasMore: false, beforeCursor: null, complete: !indexing, indexing, unreadable: false,
      scannedThrough: indexing ? 1 : 9, headSeq: 9,
    } }
  })
  const complete = await window.canonicalOutline()
  const context = async () => ({ messages: rows.slice(3, 6), page: { epoch, reset: false,
    beforeCursor: { at: rows[3]!.createdAt, seq: 4 }, afterCursor: { at: rows[5]!.createdAt, seq: 6 },
    hasMoreBefore: true, hasMoreAfter: true } })
  const expectedTurn = complete!.entries.find(entry => entry.messageId === rows[3]!.id)!.turn
  const turnOf = (records: readonly { event: SessionEvent }[]) =>
    (records.find(record => record.event.type === 'turn/start')!.event.data as { turn: number }).turn
  epoch = 2; indexing = true
  window.observeSnapshotEpoch(epoch)
  assert.equal((await window.canonicalOutline())?.indexing, true)
  const during = await window.windowAt(rows[3]!.id, 2, 3_000_000_000, context)
  assert.equal(turnOf(during.records), expectedTurn, 'partial labels cannot replace an existing source turn map')
  indexing = false
  const refreshed = await window.canonicalOutline()
  assert.equal(refreshed?.complete, true)
  assert.equal(refreshed?.epoch, 2)
  const after = await window.windowAt(rows[3]!.id, 2, 3_001_000_000, context)
  assert.equal(turnOf(after.records), expectedTurn)
})

test('exhausted unreadable coverage is distinct from indexing and is never complete', async () => {
  const rows = [row(1, 0, true)]
  const window = new SourceHistoryWindow(fakeAgent(rows, 0), new FakeTransport(rows), undefined, async () => ({
    entries: [], page: { epoch: 1, hasMore: false, beforeCursor: null, complete: false,
      unreadable: true, indexing: false, scannedThrough: 1, headSeq: 1 },
  }))
  const value = await window.canonicalOutline()
  assert.equal(value?.complete, false)
  assert.equal(value?.indexing, false)
  assert.equal(value?.unreadable, true)
})

for (const broken of ['missing', 'repeated', 'newer'] as const) test(`a ${broken} outline cursor cannot spin or certify incomplete navigation`, async () => {
  const rows = [row(1, 0, true)]
  let reads = 0
  const window = new SourceHistoryWindow(fakeAgent(rows, 0), new FakeTransport(rows), undefined, async () => {
    reads++
    return { entries: [], page: { epoch: 1, hasMore: true, complete: false,
      beforeCursor: broken === 'missing' ? null : { at: broken === 'newer' ? reads : 1, seq: 1 } } }
  })
  await assert.rejects(window.canonicalOutline(), /cursor did not advance/)
  assert.equal(reads, broken === 'missing' ? 1 : 2)
})

test('an interrupted outline chain is retried from the head without caching its failure', async () => {
  const rows = [row(1, 0, true), row(2, 1, true)]
  const queries: Array<{ beforeSeq?: number; epoch?: number }> = []
  const window = new SourceHistoryWindow(fakeAgent(rows, 1), new FakeTransport(rows), undefined, async query => {
    queries.push(query)
    if (queries.length === 2) throw new Error('controlled source read failure')
    const selected = queries.length === 1 ? rows.slice(1) : rows
    return { entries: selected.map(item => ({ messageId: item.id, label: item.id,
      at: item.createdAt, seq: item.seq!, createdAt: item.createdAt })), page: {
      epoch: queries.length === 1 ? 2 : 3, hasMore: queries.length === 1,
      beforeCursor: { at: rows[1]!.createdAt, seq: 2 }, complete: queries.length !== 1,
    } }
  })
  await assert.rejects(window.canonicalOutline(), /controlled source read failure/)
  const value = await window.canonicalOutline()
  assert.equal(value?.complete, true)
  assert.equal(value?.epoch, 3)
  assert.deepEqual(value?.entries.map(entry => entry.messageId), rows.map(item => item.id))
  assert.deepEqual(queries.map(query => [query.beforeSeq, query.epoch]), [[undefined, undefined], [2, 2], [undefined, undefined]])
})

test('disposing a shared outline read prevents another page or later cache publication', async () => {
  const rows = [row(1, 0, true)]
  let reads = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const window = new SourceHistoryWindow(fakeAgent(rows, 0), new FakeTransport(rows), undefined, async () => {
    reads++; await gate
    return { entries: [], page: { epoch: 1, hasMore: true, complete: false, beforeCursor: { at: 1, seq: 1 } } }
  })
  const first = window.canonicalOutline(), second = window.canonicalOutline()
  assert.equal(reads, 1)
  window.dispose(); release()
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined])
  assert.equal(await window.canonicalOutline(), undefined)
  assert.equal(reads, 1)
  assert.equal(window.cacheBytes, 0)
})

function snapshotContext(rows: readonly HapiMessage[], epoch: number) {
  const first = rows[0]!, last = rows[rows.length - 1]!
  return { messages: rows, page: { epoch, reset: false,
    beforeCursor: { at: first.createdAt, seq: first.seq! }, afterCursor: { at: last.createdAt, seq: last.seq! },
    hasMoreBefore: true, hasMoreAfter: true } }
}

for (const direction of ['before', 'after'] as const) test(`${direction} paging recovers a snapshot revision once through its unchanged source identity`, async () => {
  const rows = Array.from({ length: 9 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 3)
  const anchor = direction === 'before' ? rows[3]! : rows[5]!
  let contextReads = 0
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, undefined, async (id, radius) => {
    contextReads++
    assert.equal(id, anchor.id); assert.equal(radius, 1)
    return snapshotContext([anchor], 3)
  })
  const initial = await window.windowAt(rows[4]!.id, 1, 3_000_000_000, async () => snapshotContext(rows.slice(3, 6), 2))
  assert.equal(initial.epoch, 2, 'stable message context is independent of the opening seed revision')
  const epochs: Array<number | undefined> = []
  const pageRows = direction === 'before' ? rows.slice(0, 3) : rows.slice(6)
  const read = async (_cursor: { at: number; seq: number }, epoch?: number) => {
    epochs.push(epoch)
    return { messages: epoch === 2 ? [row(999, 99)] : pageRows, epoch: 3, reset: epoch === 2,
      hasMore: false, next: { at: pageRows[0]!.createdAt, seq: pageRows[0]!.seq! } }
  }
  const cursor = direction === 'before' ? initial.before! : initial.after!
  const page = direction === 'before' ? await window.windowBefore(cursor, 3_000_000_000, read, 2)
    : await window.windowAfter(cursor, 3_000_000_100, read, 2)
  assert.deepEqual(epochs, [2, 3])
  assert.equal(contextReads, 1)
  assert.equal(page.epoch, 3)
  assert.equal(window.agent, agent)
  assert.equal(window.attachments.disposed, false)
  assert.ok(page.records.length > 0)
  assert.ok(page.records.every(record => (record as any).source?.epoch === 3))
  assert.ok(page.records.every(record => (record as any).source?.messageId !== 'row-999'), 'the reset response is never appended')
})

for (const failure of ['moved', 'removed', 'changed-again'] as const) test(`snapshot recovery rejects a ${failure} boundary without an unbounded retry`, async () => {
  const rows = Array.from({ length: 6 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const anchor = rows[3]!
  const recovered = failure === 'moved' ? { ...anchor, seq: 400 } : failure === 'removed' ? rows[0]! : anchor
  const window = new SourceHistoryWindow(fakeAgent(rows, 3), new FakeTransport(rows), undefined, undefined,
    async () => snapshotContext([recovered], 3))
  const initial = await window.windowAt(anchor.id, 1, 3_000_000_000, async () => snapshotContext(rows.slice(3), 2))
  let reads = 0
  await assert.rejects(() => window.windowBefore(initial.before!, 3_000_000_000, async (_cursor, epoch) => {
    reads++
    return { messages: rows, epoch: epoch === 2 ? 3 : 4, reset: true, hasMore: false, next: null }
  }, 2), failure === 'changed-again' ? /changed again/ : /moved or was removed/)
  assert.equal(reads, failure === 'changed-again' ? 2 : 1)
  assert.equal(window.attachments.disposed, false)
})

test('a giant single source turn is not split into a second display turn', async () => {
  const rows = Array.from({ length: 140 }, (_, index) => row(index + 1, 0, index === 0))
  const agent = {
    id: SessionId('hapi-codex-giant-turn-fixture'),
    binding: { hapiSessionId: 'giant-turn-fixture' },
    historyWindowAnchor() { const anchor = rows[125]!
      return { epoch: 1, before: { at: anchor.createdAt, seq: anchor.seq! }, firstTurn: DISPLAY_TURN_BASE + 1, hasOlder: true } },
    async renderHistoryPage(pageRows: readonly HapiMessage[]): Promise<RenderedHistoryPage> {
      const session = Session.create(SessionId('giant-history'))
      session.append('turn/start', { turn: 1 })
      let last = 0
      for (const item of pageRows) {
        const event = item.localId
          ? session.append('user/message', freezeMessage({ id: MessageId(`u:${item.id}`), role: 'user',
            content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
          : session.append('assistant/message', { turn: 1, step: 1,
            message: freezeMessage({ id: MessageId(`a:${item.id}`), role: 'assistant',
              content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
            stream: [] }, { surfaceOp: 'append' })
        last = event.seq
      }
      return { events: session.snapshotEvents(), lastTurn: 1, sources: new Map(), rewinds: new Map(), forks: new Map() }
    },
  }
  const transport = new FakeTransport(rows, 7)
  const window = new SourceHistoryWindow(agent, transport)
  const page = await window.page({ address: { kind: 'session', sessionId: 'display' as never }, throughSeq: DISPLAY_SEQ_OFFSET,
    beforeSeq: DISPLAY_SEQ_OFFSET, maxMessages: 20 }, undefined, async () => ({ records: [], hasMore: false }))
  const starts = page.records.filter(record => record.event.type === 'turn/start')
  assert.equal(starts.length, 1, 'one source turn produces one display turn/start')
  assert.ok(page.records.length >= 100, 'the giant turn is delivered as one bounded page')
})

test('outlinePage accumulates pages and keeps the seed turn stable while older pages prepend', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const outline = rows.filter((_row, index) => index % 3 === 0).map((item, index) => ({
    messageId: item.id, label: `question ${index + 1}`, at: item.createdAt, seq: item.seq ?? index, createdAt: item.createdAt,
  }))
  const pages = [
    { entries: outline.slice(-2), page: { epoch: 1, hasMore: true, beforeCursor: { at: outline.at(-2)!.at, seq: outline.at(-2)!.seq }, complete: false } },
    { entries: outline.slice(0, 2), page: { epoch: 1, hasMore: false, beforeCursor: null, complete: true } },
  ]
  const queries: Array<{ beforeAt?: number; beforeSeq?: number }> = []
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async query => {
    queries.push(query)
    return pages.shift()!
  })
  const first = await window.outlinePage({ limit: 100 })
  assert.ok(first)
  assert.equal(first.complete, false)
  assert.equal(first.hasMore, true)
  const turnsAfterFirst = new Map(first.entries.map(entry => [entry.messageId, entry.turn]))
  assert.equal(window.outlineSettled, false)
  const second = await window.outlinePage({ beforeAt: first.cursor!.at, beforeSeq: first.cursor!.seq, limit: 100 })
  assert.ok(second)
  assert.equal(second.complete, true)
  assert.equal(window.outlineSettled, true)
  // Every label read on the first page keeps its turn number after the older page.
  for (const [messageId, turn] of turnsAfterFirst) {
    assert.equal(second.entries.find(entry => entry.messageId === messageId)?.turn, turn,
      `turn for ${messageId} must not be renumbered when older pages prepend`)
  }
  assert.equal(second.entries.length, 4)
  assert.deepEqual(queries[1], { limit: 100, beforeAt: first.cursor!.at, beforeSeq: first.cursor!.seq, epoch: 1 })
})

test('outlinePage rejects a cursor that does not advance while older labels remain', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const outline = rows.filter((_row, index) => index % 3 === 0).map((item, index) => ({
    messageId: item.id, label: `question ${index + 1}`, at: item.createdAt, seq: item.seq ?? index, createdAt: item.createdAt,
  }))
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async () => ({
    entries: outline.slice(-1), page: { epoch: 1, hasMore: true, beforeCursor: null, complete: false },
  }))
  await assert.rejects(window.outlinePage({ limit: 100 }), /cursor did not advance/)
})

test('outlinePage rejects an epoch reset instead of merging two snapshots', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  const outline = rows.filter((_row, index) => index % 3 === 0).map((item, index) => ({
    messageId: item.id, label: `question ${index + 1}`, at: item.createdAt, seq: item.seq ?? index, createdAt: item.createdAt,
  }))
  let call = 0
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async () => {
    call++
    return call === 1
      ? { entries: outline.slice(-2), page: { epoch: 1, hasMore: true, beforeCursor: { at: outline.at(-2)!.at, seq: outline.at(-2)!.seq }, complete: false } }
      : { entries: outline.slice(0, 1), page: { epoch: 2, hasMore: false, beforeCursor: null, complete: true, reset: true } }
  })
  const first = await window.outlinePage({ limit: 100 })
  assert.ok(first)
  await assert.rejects(window.outlinePage({ beforeAt: first.cursor!.at, beforeSeq: first.cursor!.seq }), /epoch changed/)
})
