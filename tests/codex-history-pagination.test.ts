/** Bounded HAPI cursor pages with an explicit fake; the reader is production code. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HapiMessage, HapiMessagesPage, HapiMessagesQuery, HapiTransport } from '../src/codex/contracts.ts'
import { compareNativeMessages } from '../src/codex/native.ts'
import { readNativeHistory } from '../src/codex/history.ts'

interface Position { at: number; seq: number }
const position = (row: HapiMessage): Position => ({ at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0 })
const compare = (left: Position, right: Position): number => left.at - right.at || left.seq - right.seq

function message(index: number): HapiMessage {
  return { id: `row-${index}`, localId: null, seq: index + 1, createdAt: 1_000_000 + index, invokedAt: 1_000_000 + index,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: `Answer ${index}` } } } }
}
function rows(count: number): HapiMessage[] { return Array.from({ length: count }, (_, index) => message(index)) }

class FakeHistory {
  readonly requests: HapiMessagesQuery[] = []
  rows: HapiMessage[] = []
  epoch = 1
  onRequest?: (index: number) => void
  async readMessages(_sessionId: string, query: HapiMessagesQuery = {}): Promise<HapiMessagesPage> {
    const index = this.requests.length
    this.requests.push({ ...query })
    this.onRequest?.(index)
    const ordered = [...this.rows].sort(compareNativeMessages)
    const head = ordered.length ? position(ordered.at(-1)!) : { at: 0, seq: 0 }
    const limit = query.limit ?? 200
    const reset = query.epoch !== undefined && query.epoch !== this.epoch
    let pool = ordered
    if (query.untilAt !== undefined && query.untilSeq !== undefined) {
      const until = { at: query.untilAt, seq: query.untilSeq }
      pool = ordered.filter(row => compare(position(row), until) <= 0)
    }
    let selected: HapiMessage[]
    let available: number
    if (!reset && query.beforeAt !== undefined && query.beforeSeq !== undefined) {
      const before = { at: query.beforeAt, seq: query.beforeSeq }
      const older = pool.filter(row => compare(position(row), before) < 0)
      selected = older.slice(-limit)
      available = older.length
    } else {
      selected = pool.slice(-limit)
      available = pool.length
    }
    const first = selected[0]
    return {
      messages: selected,
      page: {
        direction: query.beforeAt === undefined ? 'latest' : 'before', limit, epoch: this.epoch, reset,
        nextBeforeSeq: first?.seq ?? null, nextBeforeAt: first ? position(first).at : null,
        nextAfterSeq: null, nextAfterAt: null,
        snapshotHeadSeq: ordered.length ? ordered.at(-1)!.seq : null,
        snapshotHeadAt: ordered.length ? position(ordered.at(-1)!).at : null,
        hasMore: !reset && available > selected.length,
      },
    }
  }
}
const transport = (fake: FakeHistory): HapiTransport => fake as unknown as HapiTransport

test('a busy source that rewrites its active item no longer restarts a large read', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  // A live session bumps its epoch whenever the active stream item changes.
  fake.onRequest = () => { fake.epoch++ }
  const history = await readNativeHistory(transport(fake), 'native-session')
  assert.equal(history.length, 5_000)
  assert.deepEqual(new Set(history.map(row => row.id)).size, 5_000)
  assert.deepEqual(history.map(row => row.id), [...history].sort(compareNativeMessages).map(row => row.id))
  assert.equal(fake.requests.length, 25)
  const head = fake.rows.at(-1)!
  assert.equal(fake.requests[0]?.untilAt, undefined)
  for (const request of fake.requests.slice(1)) {
    assert.equal(request.untilAt, position(head).at)
    assert.equal(request.untilSeq, head.seq)
    assert.equal(request.epoch, undefined)
  }
})

test('a source rewind restarts the pass and publishes only the replacement history', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  fake.onRequest = index => {
    if (index !== 2) return
    // The source rewinds: the newest 1,000 rows disappear and the head moves back.
    fake.rows = fake.rows.slice(0, 4_000); fake.epoch++
  }
  const history = await readNativeHistory(transport(fake), 'native-session')
  assert.equal(history.length, 4_000)
  assert.ok(history.every(row => Number(row.id.split('-')[1]) < 4_000))
  assert.ok(fake.requests.length > 20)
})

test('consecutive rewinds reject instead of publishing rows the source already removed', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  const removed = new Set<string>()
  fake.onRequest = index => {
    if (index === 0) return
    // Each page discovers a rewound head: every anchored pass is invalid.
    for (const row of fake.rows.slice(-1)) removed.add(row.id)
    fake.rows = fake.rows.slice(0, -1); fake.epoch++
  }
  await assert.rejects(readNativeHistory(transport(fake), 'native-session'),
    /Native history changed repeatedly during pagination; refresh/)
  // Nothing was published, so no message the rewind removed can be mistaken for
  // authoritative history by the caller's cache or projection.
  assert.ok(removed.size > 0)
})

test('an incomplete page cursor cannot loop forever or substitute a partial snapshot', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  fake.readMessages = async function (this: FakeHistory, _sessionId: string, query: HapiMessagesQuery = {}) {
    this.requests.push({ ...query })
    const ordered = [...this.rows].sort(compareNativeMessages)
    const limit = query.limit ?? 200
    const selected = ordered.slice(-limit)
    const first = selected[0]
    return { messages: selected, page: { direction: 'before', limit, epoch: 1, reset: false,
      nextBeforeSeq: first?.seq ?? null, nextBeforeAt: first ? position(first).at : null,
      nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: ordered.at(-1)!.seq, snapshotHeadAt: position(ordered.at(-1)!).at,
      hasMore: true } }
  }
  await assert.rejects(readNativeHistory(transport(fake), 'native-session'), /changed repeatedly during pagination/)
  assert.equal(fake.requests.length, 8)
})
