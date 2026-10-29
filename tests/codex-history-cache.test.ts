import { tmpdir as testTemporaryRoot } from 'node:os'
import { join as testTemporaryJoin } from 'node:path'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
  const directory = await mkdtemp(testTemporaryJoin(testTemporaryRoot(), "hapi-dsh-cache-"))
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
  const directory = await mkdtemp(testTemporaryJoin(testTemporaryRoot(), "hapi-dsh-cache-unicode-"))
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

test('cache replacement leaves private complete snapshots and no temporary files', async () => {
  const directory = await mkdtemp(testTemporaryJoin(testTemporaryRoot(), "hapi-dsh-cache-replace-"))
  try {
    const cache = new NativeHistoryCache(directory, 'replacement')
    cache.write([row(1, 1_000)], true, 7)
    const rows = [row(2, 500), row(3, 700)]
    cache.write(rows, true, 8)
    assert.deepEqual(cache.snapshot(), { rows, complete: true, epoch: 8 })
    assert.deepEqual(cache.snapshot(true), { rows, complete: true, epoch: 8 })
    assert.deepEqual((await readdir(directory)).sort(), ['replacement.history.json', 'replacement.opening.json'])
    if (process.platform !== 'win32') {
      for (const kind of ['history', 'opening']) {
        assert.equal((await stat(join(directory, `replacement.${kind}.json`))).mode & 0o777, 0o600)
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a failed cache replacement reports the error and removes its temporary file', async () => {
  const directory = await mkdtemp(testTemporaryJoin(testTemporaryRoot(), "hapi-dsh-cache-failure-"))
  try {
    const cache = new NativeHistoryCache(directory, 'blocked')
    const destination = join(directory, 'blocked.opening.json')
    await mkdir(destination)
    await writeFile(join(destination, 'existing'), 'preserved')
    assert.throws(() => cache.writeOpening([row(1, 100)], false, 7))
    assert.deepEqual(await readdir(directory), ['blocked.opening.json'])
    assert.equal(await readFile(join(destination, 'existing'), 'utf8'), 'preserved')
    await rm(destination, { recursive: true })
    cache.writeOpening([row(2, 100)], false, 8)
    assert.equal(cache.snapshot(true)?.rows[0]?.id, 'row-2')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
