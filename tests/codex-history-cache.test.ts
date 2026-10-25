import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HapiMessage } from '../src/codex/contracts.js'
import { NativeHistoryCache, newestWithin } from '../src/codex/history-cache.js'

const row = (id: number, width: number): HapiMessage => ({
  id: `row-${id}`, seq: id, localId: null, createdAt: id,
  content: { role: 'agent', content: { type: 'text', text: `${id}:` + 'x'.repeat(width) } },
})

test('history cache keeps a contiguous newest tail under its byte budget and preserves one oversized row', () => {
  const rows = [row(1, 1_000), row(2, 1_000), row(3, 1_000)]
  const bounded = newestWithin(rows, 2_300)
  assert.deepEqual(bounded.map(value => value.id), ['row-2', 'row-3'])
  const oversized = newestWithin([row(1, 1_000), row(2, 50_000)], 1_024)
  assert.deepEqual(oversized.map(value => value.id), ['row-2'])
})

test('an archive over the cache budget is written as an explicitly incomplete newest tail', async () => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hapi-dsh-cache-')
  try {
    const cache = new NativeHistoryCache(directory, 'synthetic-cache')
    const rows = [row(1, 2_000), row(2, 2_000), row(3, 2_000)]
    cache.write(rows, true, 7, 4_500)
    const after = cache.snapshot()
    assert.ok(after)
    assert.equal(after.complete, false)
    assert.deepEqual(after.rows.map(value => value.id), ['row-2', 'row-3'])
    assert.equal(after.epoch, 7)
    const opening = cache.snapshot(true)
    assert.equal(opening?.complete, false)
    assert.deepEqual(opening?.rows.map(value => value.id), ['row-2', 'row-3'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
