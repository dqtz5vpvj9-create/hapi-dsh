/** Reading behavior and resource limits, without prescribing an overscan size. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { pinSourceViewport, protectSourcePage, sourceRetentionPlan } from '../src/client/source-window-retention.ts'

function row(seq: number, id = `message-${seq}`, bytes = 1): SessionEventLikeEntry {
  return { type: 'event', source: { messageId: id, at: seq, seq }, event: {
    type: 'user/message', seq, time: seq, data: { bytes, text: `Read body ${id}` },
  } } as unknown as SessionEventLikeEntry
}
const budget = { events: 1_500, bytes: 12 * 1024 * 1024,
  size: (entry: SessionEventLikeEntry) => (entry.event.data as { bytes: number }).bytes }
const rows = (first: number, count: number) => Array.from({ length: count }, (_, offset) => row(first + offset))
const pin = (entries: readonly SessionEventLikeEntry[], firstSeq: number, lastSeq: number, followingTail = false) =>
  pinSourceViewport(entries, { firstSeq, lastSeq, followingTail })!
function sameReadWindow(actual: readonly SessionEventLikeEntry[], expected: readonly SessionEventLikeEntry[], message: string): void {
  assert.equal(actual.length, expected.length, message)
  assert.ok(actual.every((entry, index) => entry === expected[index]), message)
}

test('moving the viewport and receiving metadata never discard already read body within budget', () => {
  const read = rows(0, 100)
  const status = { type: 'event', event: { type: 'plugin:hapi-dsh/execution', seq: 100, time: 100,
    data: { bytes: 1, phase: 'idle' } } } as unknown as SessionEventLikeEntry
  const grown = [...read, status, row(101)]
  for (const view of [pin(read, 40, 43), pin(read, 96, 99, true)]) {
    const plan = sourceRetentionPlan(grown, [view], 'newer', budget)
    assert.equal(plan.fits, true)
    sameReadWindow(grown.slice(plan.first, plan.last), grown,
      'a scroll measurement or a status change is not permission to discard affordable source history')
  }
})

test('three older pages and a return through read history preserve every body while the window fits', () => {
  let resident = rows(300, 100)
  const expected = [...resident]
  for (const first of [200, 100, 0]) {
    const visible = pin(resident, first + 100, first + 109)
    const page = rows(first, 100), next = [...page, ...resident]
    expected.unshift(...page)
    const plan = sourceRetentionPlan(next, protectSourcePage(page, [visible]), 'older', budget)
    assert.equal(plan.fits, true)
    resident = next.slice(plan.first, plan.last)
    sameReadWindow(resident, expected, 'each older page adds history without replacing an already read page')
  }
  for (const first of [0, 100, 300, 100, 0]) {
    const plan = sourceRetentionPlan(resident, [pin(resident, first, first + 9)], first === 300 ? 'newer' : 'older', budget)
    assert.equal(plan.fits, true)
    resident = resident.slice(plan.first, plan.last)
    sameReadWindow(resident, expected, 'reading forward and back must not require fetching an affordable page again')
  }
})

test('event and byte pressure keep both visible panes and bound the retained window', () => {
  const entries = rows(0, 100), visible = [pin(entries, 30, 34), pin(entries, 65, 69)]
  for (const limits of [{ ...budget, events: 60 }, { ...budget, bytes: 60 }]) {
    for (const direction of ['older', 'newer'] as const) {
      const plan = sourceRetentionPlan(entries, visible, direction, limits)
      assert.equal(plan.fits, true)
      const kept = entries.slice(plan.first, plan.last)
      assert.ok(kept.length <= limits.events)
      assert.ok(kept.reduce((sum, entry) => sum + limits.size(entry), 0) <= limits.bytes)
      for (const entry of [...entries.slice(30, 35), ...entries.slice(65, 70)]) assert.ok(kept.includes(entry),
        'resource pressure must not evict either visible reading range')
    }
  }
})

test('a visible union that exceeds the budget rejects the proposed trim instead of sacrificing a reader', () => {
  const entries = rows(0, 100)
  const plan = sourceRetentionPlan(entries, [pin(entries, 3, 4), pin(entries, 90, 91)], 'newer', { ...budget, events: 50 })
  assert.equal(plan.fits, false)
  const protectedRange = entries.slice(plan.first, plan.last)
  for (const entry of [...entries.slice(3, 5), ...entries.slice(90, 92)]) assert.ok(protectedRange.includes(entry))
})

test('one indivisible source row remains complete even when it alone exceeds either resource ceiling', () => {
  const source = Array.from({ length: 5 }, (_, index) => row(index + 1, 'large-tool-result', 100))
  const entries = [row(0), ...source, row(6)]
  for (const limits of [{ ...budget, events: 2 }, { ...budget, bytes: 50 }]) {
    const plan = sourceRetentionPlan(entries, [pin(entries, 2, 3)], 'newer', limits)
    assert.equal(plan.fits, true)
    assert.equal(plan.oversizedRow, true)
    assert.deepEqual(entries.slice(plan.first, plan.last), source,
      'a large source result may exceed the ceiling, but its siblings must never be truncated or mixed with unrelated rows')
  }
})

test('stale reading pins cannot authorize replacement by a different window, including a following pane', () => {
  const current = rows(0, 100), replacement = rows(1_000, 100)
  for (const following of [false, true]) {
    const captured = pin(current, 96, 99, following)
    const plan = sourceRetentionPlan(replacement, [captured], 'newer', budget)
    assert.equal(plan.fits, false, 'an affordable replacement still needs the captured reader identity')
  }
})
