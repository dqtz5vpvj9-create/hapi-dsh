import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { HistoryProjectionSink } from '../src/shared/projection-event-sink.ts'
import type { HapiMessage, HapiMessagesPage, HapiTransport } from '../src/codex/contracts.ts'
import { DISPLAY_TURN_BASE, sourceTurnKey, DisplayHistoryWindows, SourceHistoryPageCache, SourceHistoryWindow,
  type RenderedHistoryPage, type SourceWindowPage } from '../src/codex/source-window.ts'

function boundary() { return { threadId: 'thread', turnId: 'turn', itemId: 'item' } }
function row(id: number, turn: number, userMessage = false): HapiMessage {
  return { id: `row-${id}`, localId: userMessage ? `local-${id}` : null, seq: id,
    createdAt: 1000 + id, invokedAt: userMessage ? 1000 + id : null,
    content: userMessage ? { role: 'user', content: { type: 'text', text: `turn ${turn}` }, meta: { nativeExecution: { threadId: 'thread', turnId: `turn-${turn}`, itemId: `item-${id}` } } }
      : { role: 'agent', content: { type: 'text', text: `answer ${id}` }, meta: { nativeExecution: { threadId: 'thread', turnId: `turn-${turn}`, itemId: `item-${id}` } } } }
}

/** The window only sees the same public rendering contract as each Agent. */
function indexIsPartial(rows: readonly HapiMessage[], anchorIndex: number): boolean {
  const before = rows.slice(0, anchorIndex + 1)
  return !before.some(row => row.localId !== null)
}

function fakeAgent(rows: readonly HapiMessage[], anchorIndex: number) {
  return {
    id: SessionId('hapi-codex-source-window-fixture'),
    binding: { hapiSessionId: 'source-window-fixture' },
    historyWindowAnchor() {
      const anchor = rows[anchorIndex]!
      return { epoch: 1, before: { at: anchor.createdAt, seq: anchor.seq! },
        firstTurn: DISPLAY_TURN_BASE + 1, hasOlder: anchorIndex > 0,
        oldest: { id: anchor.id, at: anchor.createdAt, seq: anchor.seq! }, partial: indexIsPartial(rows, anchorIndex) }
    },
    async renderHistoryPage(pageRows: readonly HapiMessage[]): Promise<RenderedHistoryPage> {
      const session = new HistoryProjectionSink()
      let turn = 0
      let lastTurn: string | null | undefined
      const sources = new Map<string, number>()
      const rewinds = new Map<number, string>()
      const forks = new Map<string, ReturnType<typeof boundary>>()
      const turnAnchors = new Map<number, { id: string; at: number; seq: number; key: string | null }>()
      for (const [index, item] of pageRows.entries()) {
        const sourceTurn = sourceTurnKey(item)
        session.setSource({ messageId: item.id, at: item.createdAt, seq: item.seq ?? 0, itemKey: item.id, ...(sourceTurn ? { turnKey: sourceTurn } : {}) })
        if (sourceTurn !== lastTurn) {
          lastTurn = sourceTurn; turn++
          turnAnchors.set(turn, { id: item.id, at: item.createdAt, seq: item.seq ?? item.createdAt, key: sourceTurn })
          session.append('turn/start', { turn }, item.createdAt)
        }
        const event: SessionEvent = item.localId
          ? session.append('user/message', freezeMessage({ id: MessageId(`u:${item.id}`), role: 'user',
            content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }), item.createdAt, { surfaceOp: 'append' })
          : session.append('assistant/message', { turn, step: 1,
            message: freezeMessage({ id: MessageId(`a:${item.id}`), role: 'assistant',
              content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
            stream: [] }, item.createdAt, { surfaceOp: 'append' })
        sources.set(item.id, event.seq)
        if (item.localId) rewinds.set(event.seq, item.localId)
        if (!item.localId) forks.set(`a:${item.id}`, boundary())
      }
      return { events: session.events, eventSources: session.eventSources, lastTurn: turn, sources, rewinds, forks, turnAnchors }
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

async function beforePage(window: SourceHistoryWindow, transport: FakeTransport, before: { at: number; seq: number }) {
  return window.windowBefore(before, 0, async cursor => {
    const page = await transport.readMessages(window.agent.binding.hapiSessionId, { beforeAt: cursor.at, beforeSeq: cursor.seq })
    return { messages: page.messages, epoch: page.page.epoch, hasMore: page.page.hasMore,
      next: page.page.nextBeforeAt == null || page.page.nextBeforeSeq == null ? null : { at: page.page.nextBeforeAt, seq: page.page.nextBeforeSeq } }
  }, 1)
}

test('source pages keep original identities across independently rendered pages without a display rebuild', async () => {
  const rows = Array.from({ length: 24 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 18), transport = new FakeTransport(rows), window = new SourceHistoryWindow(agent, transport)
  let before = agent.historyWindowAnchor().before, pages = 0
  const seen = new Set<string>()
  while (true) {
    const page = await beforePage(window, transport, before)
    assert.deepEqual(page.records, [], 'the canonical body is not duplicated in an obsolete numeric-coordinate stream')
    for (const frame of page.frames!) {
      assert.ok(frame.source && frame.source.seq < before.seq)
      assert.ok(!seen.has(frame.key)); seen.add(frame.key)
    }
    pages++
    if (!page.hasMoreBefore) break
    assert.ok(page.before && page.before.seq < before.seq)
    before = page.before
    assert.ok(pages < 10)
  }
  assert.equal(pages, 6); assert.equal(transport.queries.length, pages)
  assert.equal(window.agent, agent)
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

test('direct context body has stable source identity and never waits for the directory', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9)
  let outlineReads = 0, reads = 0
  const window = new SourceHistoryWindow(agent, new FakeTransport(rows), undefined, async () => {
    outlineReads++; throw new Error('Body loading must not read the outline')
  })
  const page = await window.windowAt('row-10', 2, 3_000_000_000, async (messageId, radius) => {
    reads++; assert.equal(messageId, 'row-10'); assert.equal(radius, 2)
    return { messages: rows.slice(8), page: { beforeCursor: { at: 1009, seq: 9 }, afterCursor: { at: 1012, seq: 12 },
      hasMoreBefore: true, hasMoreAfter: false, epoch: 1, reset: false } }
  })
  assert.equal(reads, 1); assert.equal(outlineReads, 0)
  assert.deepEqual([...new Set(page.frames!.map(frame => frame.source?.messageId))], ['row-9', 'row-10', 'row-11', 'row-12'])
  assert.equal(new Set(page.frames!.map(frame => frame.turnKey)).size, 2)
  assert.equal(page.hasMoreBefore, true)
})

test('overlapping detached pages name the same source turn and message keys', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9), transport = new FakeTransport(rows, 4), window = new SourceHistoryWindow(agent, transport)
  const page = await beforePage(window, transport, agent.historyWindowAnchor().before)
  const overlap = await window.windowAt('row-8', 1, 0, async () => snapshotContext(rows.slice(6, 9), 1))
  const shared = page.frames!.filter(frame => frame.event.type === 'assistant/message' && overlap.frames!.some(other => other.key === frame.key))
  assert.ok(shared.length > 0)
  for (const frame of shared) assert.equal(frame.turnKey, overlap.frames!.find(other => other.key === frame.key)!.turnKey)
  assert.equal(transport.queries.length, 1)
})

test('history rewind and fork authorization uses served source identities without retaining page bodies', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9), transport = new FakeTransport(rows), window = new SourceHistoryWindow(agent, transport)
  const page = await beforePage(window, transport, agent.historyWindowAnchor().before)
  const user = page.frames!.find(frame => frame.event.type === 'user/message')!
  const assistant = page.frames!.find(frame => frame.event.type === 'assistant/message')!
  assert.equal(window.resolveRewindMessage((user.event.data as { id: string }).id), `local-${user.source!.seq}`)
  assert.deepEqual(window.resolveFork(`a:${assistant.source!.messageId}`), boundary())
  assert.ok(window.cacheBytes > 0)
  assert.equal(window.resolveRewindMessage('never-served'), undefined)
  window.dispose()
  assert.equal(window.resolveRewindMessage((user.event.data as { id: string }).id), undefined)
  assert.equal(window.resolveFork(`a:${assistant.source!.messageId}`), undefined)
})

test('display retirement releases source and authorization state and subsequent body reads reject', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9), transport = new FakeTransport(rows), registry = new DisplayHistoryWindows()
  const window = registry.window('display-a', agent, transport)
  const page = await beforePage(window, transport, agent.historyWindowAnchor().before)
  assert.ok(page.frames!.length > 0); assert.equal(registry.size, 1); assert.ok(registry.bytes > 0)
  registry.retire('display-a')
  assert.equal(registry.size, 0); assert.equal(registry.peek('display-a'), undefined)
  assert.equal(window.mappingCount, 0); assert.equal(window.attachments.disposed, true); assert.ok(registry.bytes > 0,
    'the HAPI-equivalent page cache survives display retirement within its authentication lifetime')
  await assert.rejects(beforePage(window, transport, agent.historyWindowAnchor().before), /released/)
  registry.clear(); assert.equal(registry.bytes, 0)
})

test('repeated page cursors reuse their bounded projected page cache', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, Math.floor(index / 3), index % 3 === 0))
  const agent = fakeAgent(rows, 9), transport = new FakeTransport(rows), window = new SourceHistoryWindow(agent, transport)
  const first = await beforePage(window, transport, agent.historyWindowAnchor().before)
  const again = await beforePage(window, transport, agent.historyWindowAnchor().before)
  assert.ok(first.frames!.length > 0); assert.deepEqual(first.frames, again.frames)
  assert.equal(transport.queries.length, 1); assert.ok(window.cacheBytes > 0)
})

test('projected history pages obey the source, total-byte, and source-count LRU bounds', () => {
  const cache = new SourceHistoryPageCache({ totalBytes: 700, sourceBytes: 450, sources: 1 })
  const page = (text: string): SourceWindowPage => ({ records: [], frames: [{ key: 'frame', event: {
    type: 'user/message', seq: 1, time: 1, data: { text },
  } } as unknown as SourceWindowPage['frames'][number]], hasMoreBefore: false, hasMoreAfter: false, before: null, after: null })
  cache.set('source-a', 'source-a', 'first', page('你'.repeat(80)))
  cache.set('source-a', 'source-a', 'second', page('你'.repeat(80)))
  assert.equal(cache.get('source-a', 'first'), undefined, 'per-source pressure evicts the oldest page')
  assert.ok(cache.get('source-a', 'second'))
  cache.set('source-b', 'source-b', 'third', page('你'.repeat(80)))
  assert.equal(cache.get('source-a', 'second'), undefined, 'the source-count bound evicts the old source')
  assert.ok(cache.get('source-b', 'third'))
  assert.ok(cache.bytes <= 450)
  cache.removeOwner('source-b')
  assert.equal(cache.bytes, 0)
})

test('a giant partial turn uses one bounded source read without waiting for its beginning', async () => {
  const rows = Array.from({ length: 2_400 }, (_, index) => row(index + 1, 0, index === 0))
  const agent = fakeAgent(rows, 2_300), transport = new FakeTransport(rows, 300), window = new SourceHistoryWindow(agent, transport)
  const page = await beforePage(window, transport, agent.historyWindowAnchor().before)
  assert.ok(page.frames!.length > 0); assert.ok(page.frames!.length <= 301)
  assert.equal(page.hasMoreBefore, true); assert.equal(transport.queries.length, 1)
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
  const original = await window.windowAt(rows[3]!.id, 2, 0, context)
  const originalKeys = original.frames!.map(frame => [frame.key, frame.turnKey])
  epoch = 2; indexing = true
  window.observeSnapshotEpoch(epoch)
  assert.equal((await window.canonicalOutline())?.indexing, true)
  const during = await window.windowAt(rows[3]!.id, 2, 3_000_000_000, context)
  assert.deepEqual(during.frames!.map(frame => [frame.key, frame.turnKey]), originalKeys, 'partial labels cannot change body identities')
  indexing = false
  const refreshed = await window.canonicalOutline()
  assert.equal(refreshed?.complete, true)
  assert.equal(refreshed?.epoch, 2)
  const after = await window.windowAt(rows[3]!.id, 2, 3_001_000_000, context)
  assert.deepEqual(after.frames!.map(frame => [frame.key, frame.turnKey]), originalKeys)
  assert.equal(refreshed!.entries.find(entry => entry.messageId === rows[3]!.id)!.turn, expectedTurn)
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
  assert.ok(page.frames!.length > 0)
  assert.ok(page.frames!.every(frame => frame.source?.messageId !== 'row-999'), 'the reset response is never appended')
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

test('giant-turn pages preserve one stable turn identity across bounded slices', async () => {
  const rows = Array.from({ length: 140 }, (_, index) => row(index + 1, 0, index === 0))
  const agent = fakeAgent(rows, 125), transport = new FakeTransport(rows, 7), window = new SourceHistoryWindow(agent, transport)
  const first = await beforePage(window, transport, agent.historyWindowAnchor().before)
  const second = await beforePage(window, transport, first.before!)
  const turns = new Set([...first.frames!, ...second.frames!].map(frame => frame.turnKey))
  assert.equal(turns.size, 1)
  assert.ok(!turns.has(undefined)); assert.equal(transport.queries.length, 2)
  assert.equal(first.frames!.filter(frame => frame.event.type === 'turn/start').length, 1)
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
