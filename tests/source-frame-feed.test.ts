import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { SourceFrameFeed } from '../src/shared/source-frame-feed.ts'
import type { SourceFrame } from '../src/shared/source-frames.ts'

function frame(index: number): SourceFrame {
  return { key: `source-${index}`, event: { type: 'turn/start', seq: SessionSeq(index), time: index, data: { turn: index } } }
}

test('source feed admits its first snapshot and subsequent changes without a subscription gap', async () => {
  let current = [frame(0)]
  const feed = new SourceFrameFeed(() => ({ kind: 'replace', frames: current }))
  const iterator = feed.watch(new AbortController().signal)
  const opening = iterator.next()
  current = [frame(0), frame(1)]
  feed.publish({ kind: 'merge', frames: [current[1]!] })
  assert.deepEqual((await opening).value, { kind: 'replace', frames: [frame(0)], historyId: feed.historyId, historyVersion: 0 })
  assert.deepEqual((await iterator.next()).value, { kind: 'merge', frames: [frame(1)], historyId: feed.historyId, historyVersion: 0 })
  await iterator.return?.(); feed.dispose()
})

test('a slow source reader coalesces a large burst into the current bounded baseline', async () => {
  let current = [frame(0)], snapshots = 0
  const feed = new SourceFrameFeed(() => { snapshots++; return { kind: 'replace', frames: current } })
  const slow = feed.watch(new AbortController().signal), fast = feed.watch(new AbortController().signal)
  await slow.next(); await fast.next()
  for (let index = 1; index <= 10_000; index++) {
    current = [frame(index - 1), frame(index)]
    feed.publish({ kind: 'merge', frames: [current[1]!] })
    const live = await fast.next()
    assert.equal(live.value?.kind, 'merge'); assert.equal(live.value?.frames[0]?.key, `source-${index}`)
  }
  assert.equal(snapshots, 2, 'pending slow reads retain a marker rather than copied transcript snapshots')
  const latest = await slow.next()
  assert.deepEqual(latest.value, { kind: 'replace', frames: [frame(9_999), frame(10_000)], historyId: feed.historyId, historyVersion: 0 })
  assert.equal(snapshots, 3)
  await slow.return?.(); await fast.return?.(); feed.dispose()
})

test('source reset versions survive coalescing and reconnection without treating clipping as a rewrite', async () => {
  let current = [frame(0)]
  const feed = new SourceFrameFeed(() => ({ kind: 'replace', frames: current }))
  const slow = feed.watch(new AbortController().signal)
  await slow.next()
  current = [frame(1)]; feed.publish({ kind: 'replace', frames: current, reset: true })
  current = [frame(2)]; feed.publish({ kind: 'replace', frames: current })
  assert.deepEqual((await slow.next()).value, { kind: 'replace', frames: current, historyId: feed.historyId, historyVersion: 1 })
  const reconnect = feed.watch(new AbortController().signal)
  assert.equal((await reconnect.next()).value?.historyVersion, 1)
  current = []; feed.publish({ kind: 'replace', frames: current, reset: true })
  const reset = (await reconnect.next()).value
  assert.equal(reset?.reset, true); assert.equal(reset?.historyVersion, 2)
  await slow.return?.(); await reconnect.return?.(); feed.dispose()
})

test('new source feed lifetimes remain distinct when history versions restart at zero', async () => {
  const previous = new SourceFrameFeed(() => ({ kind: 'replace', frames: [frame(0)] }))
  const restarted = new SourceFrameFeed(() => ({ kind: 'replace', frames: [frame(1)] }))
  assert.equal(previous.version, 0); assert.equal(restarted.version, 0)
  assert.notEqual(previous.historyId, restarted.historyId)
  assert.equal(previous.baseline().historyId, previous.historyId)
  const stream = restarted.watch(new AbortController().signal)
  const opening = (await stream.next()).value
  assert.equal(opening?.historyId, restarted.historyId)
  assert.equal(opening?.historyVersion, 0)
  restarted.publish({ kind: 'replace', frames: [frame(2)], reset: true })
  const reset = (await stream.next()).value
  assert.equal(reset?.historyId, restarted.historyId)
  assert.equal(reset?.historyVersion, 1)
  assert.equal(restarted.baseline().historyId, restarted.historyId)
  assert.equal(restarted.baseline().historyVersion, 1)
  await stream.return?.(); previous.dispose(); restarted.dispose()
})

test('source feed abort, iterator return and owner disposal release pending readers independently', async () => {
  const feed = new SourceFrameFeed(() => ({ kind: 'replace', frames: [] }))
  const abort = new AbortController(), aborted = feed.watch(abort.signal), returned = feed.watch(new AbortController().signal)
  const disposed = feed.watch(new AbortController().signal)
  await aborted.next(); await returned.next(); await disposed.next()
  const waitingAbort = aborted.next(), waitingReturn = returned.next(), waitingDispose = disposed.next()
  abort.abort()
  assert.equal((await waitingAbort).done, true)
  await returned.return?.()
  assert.equal((await waitingReturn).done, true)
  feed.dispose()
  assert.equal((await waitingDispose).done, true)
  assert.equal((await feed.watch(new AbortController().signal).next()).done, true)
  feed.publish({ kind: 'merge', frames: [frame(1)] })
  assert.equal((await disposed.next()).done, true)
})
