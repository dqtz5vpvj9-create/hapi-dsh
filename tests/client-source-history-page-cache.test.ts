import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SourceFrame, SourceFrameBatch } from '../src/shared/source-frames.ts'
import type { SourceHistoryWindowValue } from '../src/source-window-types.ts'
import { SourceHistoryPageCache } from '../src/client/source-history-page-cache.ts'

function frame(key: string, messageId: string, text: string): SourceFrame {
  return { key, source: { messageId, at: 10, seq: 10 }, event: { type: 'user/message', seq: 0, time: 10, data: { text } } } as unknown as SourceFrame
}

function page(row: SourceFrame): SourceHistoryWindowValue {
  return { records: [{ discarded: 'source rows are not retained twice' }], frames: [row], hasMoreBefore: true,
    hasMoreAfter: false, before: { at: 9, seq: 9 }, after: { at: 10, seq: 10 }, epoch: 1 }
}

function request(sessionId: string, limit = 20) {
  return { sessionId, beforeAt: 100, beforeSeq: 100, cursorMessageId: 'message-100', limit }
}

test('accepted source pages are reused as frames and evicted by bounded LRU pressure', () => {
  const cache = new SourceHistoryPageCache({ totalBytes: 10_000, sessionBytes: 7_000, sessions: 1 })
  const first = page(frame('frame-1', 'message-1', 'a'.repeat(2_000)))
  const second = page(frame('frame-2', 'message-2', 'b'.repeat(2_000)))
  const third = page(frame('frame-3', 'message-3', 'c'.repeat(2_000)))
  cache.remember({ key: 'cursor-1', sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: request('source-a'), value: first, frames: first.frames! })
  cache.remember({ key: 'cursor-2', sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: request('source-a'), value: second, frames: second.frames! })
  assert.equal(cache.get('cursor-1')?.records.length, 0, 'cached projected frames replace the duplicate raw-record array')
  cache.remember({ key: 'cursor-3', sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: request('source-a'), value: third, frames: third.frames! })
  assert.ok(cache.get('cursor-1'), 'a hit promotes a page to the newest LRU position')
  cache.remember({ key: 'other-session', sessionId: 'source-b', historyId: 'history-b', historyVersion: 1,
    request: request('source-b'), value: page(frame('frame-b', 'message-b', 'd'.repeat(2_000))),
    frames: [frame('frame-b', 'message-b', 'd'.repeat(2_000))] })
  assert.equal(cache.stats().sessions, 1)
  assert.equal(cache.get('other-session')?.frames?.[0]?.key, 'frame-b')
  assert.equal(cache.get('cursor-1'), undefined, 'the least recently used session is released under the session bound')
})

test('source page cache keeps unchanged live frames and drops pages affected by revisions or removals', () => {
  const cache = new SourceHistoryPageCache()
  const original = frame('stable-frame', 'message-1', 'original')
  cache.remember({ key: 'cursor', sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: request('source-a'), value: page(original), frames: [original] })
  const duplicate: SourceFrameBatch = { kind: 'replace', frames: [frame('stable-frame', 'message-1', 'original')] }
  cache.invalidateChanges('source-a', duplicate)
  assert.ok(cache.get('cursor'), 'same-content source republishing cannot destroy the read cache')
  cache.invalidateChanges('source-a', { kind: 'merge', frames: [frame('stable-frame', 'message-1', 'edited')] })
  assert.equal(cache.get('cursor'), undefined, 'a newer body for a cached message invalidates that page')

  cache.remember({ key: 'cursor', sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: request('source-a'), value: page(original), frames: [original] })
  cache.invalidateChanges('source-a', { kind: 'merge', frames: [], removeKeys: ['stable-frame'] })
  assert.equal(cache.get('cursor'), undefined, 'a removed source frame cannot reappear from the cache')
})

test('history identity changes evict obsolete cursor pages without clearing a matching reopened history', () => {
  const cache = new SourceHistoryPageCache()
  const value = page(frame('frame', 'message', 'body'))
  cache.remember({ key: 'same', sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: request('source-a'), value, frames: value.frames! })
  cache.remember({ key: 'old', sessionId: 'source-a', historyId: 'history-old', historyVersion: 3,
    request: request('source-a'), value, frames: value.frames! })
  cache.retainVersion('source-a', 'history-a', 4)
  assert.ok(cache.get('same'))
  assert.equal(cache.get('old'), undefined)
  cache.retainVersion('source-a', 'history-a', 5)
  assert.equal(cache.get('same'), undefined)
})

test('a cached warm page serves smaller reads and keeps its older remainder addressable by cursor', () => {
  const cache = new SourceHistoryPageCache()
  const frames = Array.from({ length: 5 }, (_, index) => {
    const position = (index + 1) * 10
    return { key: `frame-${position}`, source: { messageId: `message-${position}`, at: position, seq: position },
      event: { type: 'assistant/message', seq: index, time: position, data: { text: String(position) } } } as unknown as SourceFrame
  })
  const value: SourceHistoryWindowValue = { records: [], frames, before: { at: 10, seq: 10 }, beforeMessageId: 'message-10',
    after: null, hasMoreBefore: true, hasMoreAfter: false, epoch: 1 }
  cache.remember({ key: 'warm-50', sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: request('source-a', 50), value: { ...value, frames: [...frames].reverse() }, frames: [...frames].reverse() })

  const first = cache.getOlder({ sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: request('source-a', 2) })
  assert.deepEqual(first?.frames?.map(frame => frame.source?.messageId), ['message-40', 'message-50'])
  assert.deepEqual(first?.before, { at: 40, seq: 40 })
  assert.equal(first?.hasMoreBefore, true)

  const second = cache.getOlder({ sessionId: 'source-a', historyId: 'history-a', historyVersion: 4,
    request: { sessionId: 'source-a', beforeAt: 40, beforeSeq: 40, cursorMessageId: 'message-40', limit: 2 } })
  assert.deepEqual(second?.frames?.map(frame => frame.source?.messageId), ['message-20', 'message-30'])
  assert.deepEqual(second?.before, { at: 20, seq: 20 })
  assert.equal(second?.hasMoreBefore, true)
})
