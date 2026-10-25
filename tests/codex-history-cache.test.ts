import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
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

test('cache tail counts UTF-8 bytes for Chinese and emoji instead of JavaScript string length', () => {
  const rows = [1, 2, 3].map(id => ({ ...row(id, 0), content: { text: '中文🙂'.repeat(120) } }))
  const bounded = newestWithin(rows, 2_700)
  assert.deepEqual(bounded.map(value => value.id), ['row-2', 'row-3'])
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 2_700)
})

test('cache file budget includes UTF-8 rows and the persisted JSON envelope', async () => {
  const directory = await mkdtemp('/mnt/cache/data-cache/hapi-dsh-cache-unicode-')
  try {
    const rows = [1, 2, 3].map(id => ({ ...row(id, 0), content: { text: '中文🙂'.repeat(120) } }))
    const budget = Buffer.byteLength(JSON.stringify(rows.slice(1)), 'utf8')
    const cache = new NativeHistoryCache(directory, 'unicode-cache')
    cache.write(rows, true, 7, budget)
    assert.deepEqual(cache.read()?.map(value => value.id), ['row-3'], 'the envelope must fit too')
    for (const kind of ['history', 'opening']) {
      assert.ok((await stat(join(directory, `unicode-cache.${kind}.json`))).size <= budget)
    }
    assert.equal(cache.snapshot()?.complete, false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
