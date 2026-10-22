/** Source protocol fixtures; journal, ordering and reconciliation scheduling are production code. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HapiMessage } from '../src/codex/contracts.js'
import { HistoryReadInvalidatedError, mergeSourceRows, SourceHistoryJournal, SourceHistoryOrder } from '../src/codex/history-journal.js'
import { SourceHistorySync } from '../src/codex/history-sync.js'

function row(id: string, seq: number, text = id, extra: Partial<HapiMessage> = {}): HapiMessage {
  return { id, seq, localId: id, createdAt: seq * 10, content: { role: 'user', content: { type: 'text', text } }, ...extra }
}
function stream(id: string, text: string, final: boolean): HapiMessage {
  return row(id, 3, text, { localId: final ? 'stable-stream' : null,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'stable-stream', message: text, streamSnapshot: true } } } })
}

test('live receive journal merges the in-flight suffix in source order without duplicate identities', () => {
  const journal = new SourceHistoryJournal(), checkpoint = journal.checkpoint()
  journal.capture({ type: 'message-received', sessionId: 'source', message: row('third', 3) })
  journal.capture({ type: 'message-received', sessionId: 'source', message: row('second-new-id', 2, 'updated', { localId: 'second' }) })
  const result = journal.merge([row('first', 1), row('second', 2)], checkpoint)
  assert.deepEqual(result.map(value => value.localId), ['first', 'second', 'third'])
  assert.equal(result[1]?.id, 'second-new-id')
  assert.equal(journal.size, 2)
})

test('a delayed provisional stream cannot replace the committed row from REST or live', () => {
  const committed = stream('final', 'Final answer', true), provisional = stream('partial', 'Final', false)
  assert.deepEqual(mergeSourceRows([committed], [provisional]), [committed])
  assert.deepEqual(mergeSourceRows([provisional], [committed]), [committed])
})

test('a previously received live row survives source history indexing lag', () => {
  const journal = new SourceHistoryJournal()
  journal.capture({ type: 'message-received', sessionId: 'source', message: row('live', 2) })
  const checkpoint = journal.checkpoint()
  assert.deepEqual(journal.merge([row('old', 1)], checkpoint).map(value => value.id), ['old', 'live'])
  const indexed = row('live', 2, 'source-confirmed update')
  assert.deepEqual(journal.merge([row('old', 1), indexed], checkpoint)[1], indexed)
})

test('rewind and reconnect-gap barriers reject in-flight snapshots and cannot restore removed rows', () => {
  for (const event of [
    { type: 'messages-invalidated' as const, sessionId: 'source', reason: 'rewind' as const },
    { type: 'connection-changed' as const, data: { status: 'connected', resume: 'gap' as const } },
  ]) {
    const journal = new SourceHistoryJournal(), checkpoint = journal.checkpoint()
    journal.capture({ type: 'message-received', sessionId: 'source', message: row('removed', 2) })
    journal.capture(event)
    assert.throws(() => journal.merge([row('first', 1)], checkpoint), HistoryReadInvalidatedError)
    assert.deepEqual(journal.merge([row('replacement', 3)], journal.checkpoint()).map(value => value.id), ['replacement'])
  }
})

test('a journal overrun requires reconciliation rather than silently accepting an incomplete tail', () => {
  const journal = new SourceHistoryJournal(2), checkpoint = journal.checkpoint()
  for (let seq = 1; seq <= 3; seq++) journal.capture({ type: 'message-received', sessionId: 'source', message: row(`row-${seq}`, seq) })
  assert.equal(journal.size, 2)
  assert.throws(() => journal.merge([], checkpoint), HistoryReadInvalidatedError)
  assert.deepEqual(journal.overlayCache([]).map(value => value.seq), [2, 3])
})

test('byte-budget eviction cannot claim completeness until the source accounts for the evicted live identity', () => {
  const journal = new SourceHistoryJournal(1024, 512), large = row('large', 1, 'x'.repeat(1024))
  journal.capture({ type: 'message-received', sessionId: 'source', message: large })
  assert.equal(journal.bytes, 0); assert.equal(journal.size, 0); assert.equal(journal.incomplete, true)
  assert.throws(() => journal.merge([], journal.checkpoint()), /not indexed an evicted live row/)
  assert.deepEqual(journal.merge([large], journal.checkpoint()), [large])
  assert.equal(journal.incomplete, false)
})

test('exhausted bounded coverage proofs remain stale until a structural source resynchronization', () => {
  const journal = new SourceHistoryJournal(1, 256, 1)
  for (let seq = 1; seq <= 3; seq++) journal.capture({ type: 'message-received', sessionId: 'source', message: row(`large-${seq}`, seq, 'x'.repeat(1024)) })
  assert.throws(() => journal.merge([], journal.checkpoint()), /bounded coverage proofs/)
  journal.capture({ type: 'messages-invalidated', sessionId: 'source' })
  assert.deepEqual(journal.merge([], journal.checkpoint()), [])
})

test('cancellation during history load removes both transport id and stable queued localId', () => {
  const journal = new SourceHistoryJournal(), checkpoint = journal.checkpoint()
  journal.capture({ type: 'message-cancelled', sessionId: 'source', messageId: 'server-id', localId: 'queued' })
  assert.deepEqual(journal.merge([row('older-transport-id', 1, 'queued', { localId: 'queued' })], checkpoint), [])
})

test('older backfill requires a fresh append-only display while an overlapping tail does not', () => {
  const order = new SourceHistoryOrder()
  order.accept([row('second', 2), stream('partial', 'Partial', false)], true)
  assert.equal(order.needsReseed([row('second', 2), stream('final', 'Complete', true), row('fourth', 4)]), false)
  assert.equal(order.needsReseed([row('first', 1), row('second', 2)]), true)
})

test('read-only refresh requests coalesce without occupying the live event queue', async () => {
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const requests: boolean[] = []
  const sync = new SourceHistorySync(async history => {
    requests.push(history)
    if (requests.length === 1) { entered(); await blocked }
  }, error => { throw error })
  try {
    sync.request(true); await started
    for (let index = 0; index < 100; index++) sync.request(index === 50)
    assert.deepEqual(requests, [true])
    release(); await sync.settled()
    assert.deepEqual(requests, [true, true])
  } finally { sync.dispose() }
})
