/** Bounded HAPI cursor fixtures; no Host or browser acceptance claim. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readHistoryRevision } from '../src/codex/agent.ts'
import { HistoryReadInvalidatedError } from '../src/codex/history-journal.ts'
import type { HapiMessage, HapiMessagesQuery, HapiTransport } from '../src/codex/contracts.ts'
import type { HistoryWindowAnchor } from '../src/codex/source-window.ts'

function fixture() {
  const row = (seq: number): HapiMessage => ({ id: `row-${seq}`, localId: `local-${seq}`, seq, createdAt: seq * 100,
    content: { role: 'user', content: { type: 'text', text: `Synthetic row ${seq}` } } })
  const oldest = row(1), latest = row(2)
  let rows = [oldest, latest, ...Array.from({ length: 600 }, (_, index) => row(index + 3))]
  const anchor: HistoryWindowAnchor = { epoch: 1, before: { at: 100, seq: 1 }, firstTurn: 1, hasOlder: false,
    oldest: { id: oldest.id, at: 100, seq: 1 } }
  const requests: HapiMessagesQuery[] = []
  let epoch = 2, changeDuringRead = false
  const transport = { async readMessages(id: string, query: HapiMessagesQuery = {}) {
    assert.equal(id, 'exact-source'); requests.push(query)
    if (changeDuringRead && requests.length === 2) epoch++
    const reset = query.epoch !== undefined && query.epoch !== epoch
    const pool = rows.filter(value => reset || (query.beforeSeq === undefined || value.seq! < query.beforeSeq)
      && (query.afterSeq === undefined || value.seq! > query.afterSeq))
    const selected = query.afterSeq === undefined ? pool.slice(-(query.limit ?? 200)) : pool.slice(0, query.limit ?? 200)
    const first = selected[0], last = selected.at(-1), head = rows.at(-1)
    return { messages: structuredClone(selected), page: { direction: query.afterSeq === undefined ? 'latest' as const : 'after' as const,
      limit: query.limit ?? 200, epoch, reset, nextBeforeAt: first?.createdAt ?? null, nextBeforeSeq: first?.seq ?? null,
      nextAfterAt: last?.createdAt ?? null, nextAfterSeq: last?.seq ?? null,
      snapshotHeadAt: head?.createdAt ?? null, snapshotHeadSeq: head?.seq ?? null, hasMore: pool.length > selected.length } }
  } } as HapiTransport
  return { oldest, latest, anchor, requests, read: () => readHistoryRevision(transport, 'exact-source', latest, anchor),
    remove: (id: string) => { rows = rows.filter(value => value.id !== id) },
    move: () => { rows = rows.map(value => value.id === latest.id ? { ...value, createdAt: value.createdAt + 1 } : value) },
    race: () => { changeDuringRead = true } }
}

test('a revised snapshot resumes a large gap from its exact retained cursor without reading the archive', async () => {
  const f = fixture(), result = await f.read()
  assert.ok(result)
  assert.equal(result.epoch, 2)
  assert.equal(result.rows[0]!.id, f.latest.id)
  assert.equal(result.rows.at(-1)!.seq, 602)
  assert.equal(result.hasMore, false)
  assert.ok(f.requests.length <= 15)
  assert.ok(f.requests.every(query => query.limit === 32 || query.limit === 1 || query.afterSeq !== undefined))
})

for (const missing of ['oldest', 'latest'] as const) test(`a missing ${missing} source identity cannot authorize an epoch-only rebase`, async () => {
  const f = fixture(); f.remove(f[missing].id)
  assert.equal(await f.read(), null)
})

test('a stable identity at a changed source position requires structural recovery', async () => {
  const f = fixture(); f.move()
  assert.equal(await f.read(), null)
})

test('a revision changing during boundary materialization stays a bounded read failure', async () => {
  const f = fixture(); f.race()
  await assert.rejects(f.read(), HistoryReadInvalidatedError)
  assert.equal(f.requests.length, 2, 'the helper neither replaces an owner nor loops until the source stops changing')
})
