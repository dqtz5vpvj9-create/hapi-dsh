/** Bounded HAPI cursor pages with an explicit fake; the reader is production code. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HapiMessage, HapiMessagesPage, HapiMessagesQuery, HapiTransport } from '../src/codex/contracts.ts'
import { compareNativeMessages } from '../src/codex/native.ts'
import { NativeHistoryEpochChangedError, readNativeHistory, readNativeHistoryUpdate, readNativeHistoryTail } from '../src/codex/history.ts'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeHistoryCache } from '../src/codex/history-cache.ts'

interface Position { at: number; seq: number }
const position = (row: HapiMessage): Position => ({ at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0 })
const compare = (left: Position, right: Position): number => left.at - right.at || left.seq - right.seq

function message(index: number): HapiMessage {
  return { id: `row-${index}`, localId: null, seq: index + 1, createdAt: 1_000_000 + index, invokedAt: 1_000_000 + index,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: `Answer ${index}` } } } }
}
function rows(count: number): HapiMessage[] { return Array.from({ length: count }, (_, index) => message(index)) }
const PAGE = 200

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
    const limit = query.limit ?? PAGE
    // HAPI only signals a stale snapshot when the caller supplies an epoch.
    const reset = query.epoch !== undefined && query.epoch !== this.epoch
    let selected: HapiMessage[]
    let available: number
    if (!reset && query.beforeAt !== undefined && query.beforeSeq !== undefined) {
      const before = { at: query.beforeAt, seq: query.beforeSeq }
      const older = ordered.filter(row => compare(position(row), before) < 0)
      selected = older.slice(-limit)
      available = older.length
    } else {
      selected = ordered.slice(-limit)
      available = ordered.length
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

test('opening cache is bounded and can be read without parsing the archival file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hapi-opening-cache-'))
  try {
    const cache = new NativeHistoryCache(directory, 'fixture')
    cache.write(rows(10_000), true, 3)
    assert.equal(cache.snapshot()?.rows.length, 10_000)
    await writeFile(join(directory, 'fixture.history.json'), 'Archive deliberately not parseable by the opening read')
    const opening = cache.snapshot(true)!
    assert.equal(opening.epoch, 3); assert.equal(opening.complete, false)
    assert.deepEqual(opening.rows.map(row => row.id), rows(10_000).slice(-200).map(row => row.id))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('first viewport reads one epoch-checked source page and leaves earlier context to backfill', async () => {
  const fake = new FakeHistory(); fake.rows = rows(10_000)
  const opening = await readNativeHistoryTail(transport(fake), 'native-session', 1)
  assert.equal(fake.requests.length, 2)
  assert.equal(opening.rows.length, 200); assert.equal(opening.complete, false)
  assert.equal(opening.context, 'limited'); assert.equal(opening.epoch, 1)
  assert.equal(opening.rows.at(-1)?.id, 'row-9999')
})

test('live append reads a bounded overlap rather than all 10000 historical messages', async () => {
  const fake = new FakeHistory(); fake.rows = rows(10_000)
  const delta = await readNativeHistoryUpdate(transport(fake), 'native-session', 1, row => row.id === 'row-9980')
  assert.ok(delta && delta.length <= 64, 'a small live update must not reread a full 200-row history page')
  assert.equal(delta?.at(-1)?.id, 'row-9999')
  assert.equal(fake.requests.length, 2)
})

test('a live burst pages back to the known boundary and cannot skip intermediate messages', async () => {
  const fake = new FakeHistory(); fake.rows = rows(1000)
  const delta = await readNativeHistoryUpdate(transport(fake), 'native-session', 1, row => row.id === 'row-550')
  assert.deepEqual(delta?.filter(row => row.seq! > 550).map(row => row.id), fake.rows.filter(row => row.seq! > 550).map(row => row.id))
  assert.ok(fake.requests.length <= 5)
})

test('native structural epoch changes and missing overlap require full reconciliation', async () => {
  const fake = new FakeHistory(); fake.rows = rows(400); fake.epoch = 2
  await assert.rejects(readNativeHistoryUpdate(transport(fake), 'native-session', 1, () => true), NativeHistoryEpochChangedError)
  fake.requests.length = 0
  assert.equal(await readNativeHistoryUpdate(transport(fake), 'native-session', 2, row => row.id === 'deleted-row'), null)
  fake.requests.length = 0
  fake.onRequest = index => { if (index === 1) fake.epoch++ }
  await assert.rejects(readNativeHistoryUpdate(transport(fake), 'native-session', 2, () => true), NativeHistoryEpochChangedError)
})

test('a busy appending source keeps one epoch-stable pass and never sends the snapshot anchor', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  const history = await readNativeHistory(transport(fake), 'native-session')
  assert.equal(history.length, 5_000)
  assert.deepEqual(new Set(history.map(row => row.id)).size, 5_000)
  assert.deepEqual(history.map(row => row.id), [...history].sort(compareNativeMessages).map(row => row.id))
  // 1 initial page + 24 backward pages + 1 final epoch-stable validation.
  assert.equal(fake.requests.length, 26)
  const epoch = fake.epoch
  assert.equal(fake.requests[0]!.epoch, undefined)
  for (const request of fake.requests) {
    assert.equal(request.untilAt, undefined)
    assert.equal(request.untilSeq, undefined)
  }
  for (const request of fake.requests.slice(1, -1)) {
    assert.equal(request.epoch, epoch)
    assert.ok(request.beforeAt !== undefined && request.beforeSeq !== undefined)
  }
  const validation = fake.requests.at(-1)!
  assert.equal(validation.epoch, epoch)
  assert.equal(validation.limit, 1)
  assert.ok(validation.beforeAt !== undefined && validation.beforeSeq !== undefined)
})

test('a structural change mid-pass invalidates it and only the replacement pass is published', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  fake.onRequest = index => {
    if (index !== 2) return
    // The source rewinds: the newest 1,000 rows disappear and the epoch bumps.
    fake.rows = fake.rows.slice(0, 4_000); fake.epoch++
  }
  const history = await readNativeHistory(transport(fake), 'native-session')
  assert.equal(history.length, 4_000)
  assert.ok(history.every(row => Number(row.id.split('-')[1]) < 4_000))
  assert.ok(fake.requests.length > 20)
})

test('a change after the last page is caught by final validation', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  const backwardPages = 24
  fake.onRequest = index => {
    if (index !== backwardPages + 1) return
    // The epoch changes exactly when the final validation request is issued.
    fake.rows = fake.rows.slice(0, 4_000); fake.epoch++
  }
  const history = await readNativeHistory(transport(fake), 'native-session')
  assert.equal(history.length, 4_000)
  assert.ok(fake.requests.length > backwardPages + 2)
})

test('consecutive structural changes reject instead of publishing invalidated rows', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  fake.onRequest = index => {
    if (index === 0) return
    fake.rows = fake.rows.slice(0, -1); fake.epoch++
  }
  await assert.rejects(readNativeHistory(transport(fake), 'native-session'),
    /Native history changed repeatedly during pagination; refresh/)
  assert.equal(fake.requests.length, 8)
})

test('an incomplete page cursor cannot loop forever or substitute a partial snapshot', async () => {
  const fake = new FakeHistory(); fake.rows = rows(5_000)
  fake.readMessages = async function (this: FakeHistory, _sessionId: string, query: HapiMessagesQuery = {}) {
    this.requests.push({ ...query })
    const ordered = [...this.rows].sort(compareNativeMessages)
    const limit = query.limit ?? PAGE
    const selected = ordered.slice(-limit)
    const first = selected[0]
    return { messages: selected, page: { direction: 'before', limit, epoch: this.epoch, reset: false,
      nextBeforeSeq: first?.seq ?? null, nextBeforeAt: first ? position(first).at : null,
      nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: ordered.at(-1)!.seq, snapshotHeadAt: position(ordered.at(-1)!).at,
      hasMore: true } }
  }
  await assert.rejects(readNativeHistory(transport(fake), 'native-session'), /changed repeatedly during pagination/)
  assert.equal(fake.requests.length, 8)
})
