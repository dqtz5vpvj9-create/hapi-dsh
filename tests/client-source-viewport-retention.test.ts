import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { pinSourceViewport, protectSourcePage, sourceGroups, sourceRetentionPlan } from '../src/client/source-window-retention.ts'

function row(seq: number, id = `m${seq}`, bytes = 1): SessionEventLikeEntry {
  return { type: 'event', source: { messageId: id, at: seq, seq }, event: {
    type: 'user/message', seq, time: seq, data: { bytes },
  } } as unknown as SessionEventLikeEntry
}
const budget = { events: 5000, bytes: 12 * 1024 * 1024, size: (entry: SessionEventLikeEntry) => (entry.event.data as { bytes: number }).bytes }
const entries = Array.from({ length: 100 }, (_, index) => row(index))

test('measured viewport keeps six complete source groups of overscan, independently of safety budgets', () => {
  const pin = pinSourceViewport(entries, { firstSeq: 40, lastSeq: 43, followingTail: false })!
  const plan = sourceRetentionPlan(entries, [pin], 'newer', budget)
  assert.deepEqual([plan.first, plan.last], [34, 50])
  assert.equal(plan.fits, true)
  assert.equal(plan.last - plan.first, 16, 'four visible groups plus six on each side, not a new arbitrary event ceiling')
})

test('tail-following viewport slides to the actual latest groups after live growth', () => {
  const pin = pinSourceViewport(entries, { firstSeq: 96, lastSeq: 99, followingTail: true })!
  const grown = [...entries, ...Array.from({ length: 10 }, (_, index) => row(100 + index))]
  const plan = sourceRetentionPlan(grown, [pin], 'newer', budget)
  assert.deepEqual([plan.first, plan.last], [100, 110])
})

test('two visible panes protect their source-range union, including a following tail', () => {
  const old = pinSourceViewport(entries, { firstSeq: 40, lastSeq: 42, followingTail: false })!
  const tail = pinSourceViewport(entries, { firstSeq: 96, lastSeq: 99, followingTail: true })!
  const plan = sourceRetentionPlan(entries, [old, tail], 'newer', budget)
  assert.deepEqual([plan.first, plan.last], [40, 100])
  assert.ok(plan.last - plan.first > 48, 'working target cannot override visible pins')
  assert.equal(plan.fits, true)
})

test('oversized visible union reports a conflict instead of evicting either reading anchor', () => {
  const left = pinSourceViewport(entries, { firstSeq: 3, lastSeq: 4, followingTail: false })!
  const right = pinSourceViewport(entries, { firstSeq: 90, lastSeq: 91, followingTail: false })!
  const plan = sourceRetentionPlan(entries, [left, right], 'newer', { ...budget, events: 50 })
  assert.equal(plan.fits, false)
  assert.deepEqual([plan.first, plan.last], [3, 92])
})

test('whole-source grouping includes projected starts and ends without inventing wrappers', () => {
  const records = [
    { type: 'event', event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } },
    row(1, 'source-a'),
    { type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { turn: 1 } } },
    row(3, 'source-b'),
  ] as SessionEventLikeEntry[]
  assert.deepEqual(sourceGroups(records).map(group => [group.key, group.start, group.end]), [['source-a', 0, 3], ['source-b', 3, 4]])
  const plan = sourceRetentionPlan(records, [], 'newer', { ...budget, events: 2, size: () => 1 })
  assert.deepEqual(records.slice(plan.first, plan.last), [records[3]])
})

test('a source row larger than the safety byte ceiling remains indivisible', () => {
  const records = [row(1, 'huge', 100), row(2, 'huge', 100)]
  const pin = pinSourceViewport(records, { firstSeq: 1, lastSeq: 2, followingTail: false })!
  const plan = sourceRetentionPlan(records, [pin], 'older', { ...budget, bytes: 50 })
  assert.equal(plan.oversizedRow, true)
  assert.deepEqual([plan.first, plan.last, plan.fits], [0, 2, true])
})

test('missing geometry keeps the safety-window fallback but stale pins reject an unrelated replacement', () => {
  const stale = { first: 'absent', last: 'absent', visibleGroups: 1, followingTail: false }
  assert.equal(sourceRetentionPlan(entries, [stale], 'newer', budget).fits, false)
  assert.equal(sourceRetentionPlan(entries, [], 'newer', budget).last, 100)
})

test('an active unknown viewport preserves possible live followers until geometry is known', () => {
  const unknown = { first: 'm0', last: 'm49', visibleGroups: 50, followingTail: false, unknownGeometry: true }
  const plan = sourceRetentionPlan(entries, [unknown], 'newer', { ...budget, events: 50 })
  assert.equal(plan.fits, false, 'a possible live follower must not silently lose the newer body')
  assert.deepEqual([plan.first, plan.last], [0, 100])
})

test('an unknown viewport protects the received bounded page and rejects a union beyond its safety budget', () => {
  const records = Array.from({ length: 220 }, (_, index) => row(index))
  const captured = { first: 'm200', last: 'm219', visibleGroups: 20, followingTail: false, unknownGeometry: true }
  const pins = protectSourcePage(records.slice(0, 200), [captured])
  const plan = sourceRetentionPlan(records, pins, 'older', budget)
  assert.deepEqual([plan.first, plan.last], [0, 220])
  assert.ok(records.slice(plan.first, plan.last).includes(records[200]!))
  assert.ok(records.slice(plan.first, plan.last).includes(records[219]!))
  assert.equal(sourceRetentionPlan(records, pins, 'older', { ...budget, events: 100 }).fits, false,
    'receiving a page does not authorize discarding its readable prefix or increasing the safety budget')
})

test('an unknown pane and a measured second pane protect their complete visible union', () => {
  const unknown = { first: 'm10', last: 'm19', visibleGroups: 10, followingTail: false, unknownGeometry: true }
  const measured = pinSourceViewport(entries, { firstSeq: 70, lastSeq: 73, followingTail: false })!
  const pins = protectSourcePage(entries.slice(74), [unknown, measured])
  const plan = sourceRetentionPlan(entries, pins, 'newer', budget)
  assert.deepEqual([plan.first, plan.last, plan.fits], [10, 100, true])
  assert.equal(sourceRetentionPlan(entries, pins, 'newer', { ...budget, events: 50 }).fits, false)
})

test('a requested page stays complete until a subsequent measured viewport releases it', () => {
  const pin = pinSourceViewport(entries, { firstSeq: 40, lastSeq: 43, followingTail: false })!
  const older = protectSourcePage(entries.slice(0, 34), [pin])
  assert.deepEqual(older[1], { first: 'm0', last: 'm33', visibleGroups: 34, followingTail: false, requestedPage: true })
  const backward = sourceRetentionPlan(entries, older, 'older', budget)
  assert.ok(backward.first === 0 && backward.last > 43)
  const newer = protectSourcePage(entries.slice(50), [pin])
  assert.deepEqual(newer[1], { first: 'm50', last: 'm99', visibleGroups: 50, followingTail: false, requestedPage: true })
  const forward = sourceRetentionPlan(entries, newer, 'newer', budget)
  assert.ok(forward.first <= 40 && forward.last === 100)
  const measured = pinSourceViewport(entries, { firstSeq: 40, lastSeq: 43, followingTail: false })!
  const settled = sourceRetentionPlan(entries, [measured], 'newer', budget)
  assert.deepEqual([settled.first, settled.last], [34, 50], 'the commit pin is not a permanent retained-page cache')
})

function control(seq: number, type = 'plugin:hapi-dsh/execution'): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq, time: seq, data: {
    sequence: seq, phase: 'idle', turn: 1, step: 1, bytes: 1,
  } } } as unknown as SessionEventLikeEntry
}
const unitBudget = { ...budget, size: () => 1 }
const bodySeqs = (rows: readonly SessionEventLikeEntry[]) => rows.filter(row => row.event.type === 'user/message').map(row => row.event.seq)

test('continuous execution and metadata frames cannot evict the visible tail body', () => {
  const types = ['plugin:hapi-dsh/execution', 'plugin:hapi-dsh/session-state', 'plugin:hapi-dsh/status',
    'plugin:hapi-dsh/state', 'plugin:hapi-dsh/notices', 'plugin:hapi-dsh-observed/status',
    'plugin:hapi-dsh-observed/state', 'plugin:hapi-dsh-observed/notices', 'request/context', 'request/header', 'session/end-seed',
    'session/title', 'model/selection', 'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced']
  // Source annotations are optional here: ordinary public message entries must
  // also remain visible when only execution status changes in the real feed.
  for (const annotated of [true, false]) {
    let retained = entries.map(entry => annotated ? entry : ({ type: 'event', event: entry.event } as SessionEventLikeEntry))
    for (let seq = 100; seq < 180; seq++) {
      const pin = pinSourceViewport(retained, { firstSeq: 96, lastSeq: 99, followingTail: true })!
      const next = [...retained, control(seq, types[(seq - 100) % types.length])]
      const plan = sourceRetentionPlan(next, [pin], 'newer', unitBudget)
      assert.equal(plan.fits, true)
      retained = next.slice(plan.first, plan.last)
      assert.deepEqual(bodySeqs(retained), Array.from({ length: 10 }, (_, index) => index + 90),
        'metadata arrival consumes zero visible source groups')
      assert.equal(retained.at(-1)!.event.seq, seq, 'the status update is preserved, not filtered out')
    }
    assert.equal(retained.filter(entry => entry.event.type !== 'user/message').length, 80)
  }
})

test('interleaved metadata does not count as visible content or consume content overscan', () => {
  const records = Array.from({ length: 20 }, (_, index) => [row(index * 2), control(index * 2 + 1)]).flat()
  const pin = pinSourceViewport(records, { firstSeq: 32, lastSeq: 38, followingTail: true })!
  assert.equal(pin.visibleGroups, 4)
  const plan = sourceRetentionPlan([...records, control(40)], [pin], 'newer', unitBudget)
  assert.deepEqual(bodySeqs([...records, control(40)].slice(plan.first, plan.last)),
    Array.from({ length: 10 }, (_, index) => (index + 10) * 2))
})

test('native source annotations count with their body once, and annotation-only arrivals do not advance it', () => {
  const native = (seq: number, surface: number | null, source: number): SessionEventLikeEntry => ({ type: 'event', event: {
    type: 'plugin:hapi-dsh/native-item', seq, time: seq,
    data: { surfaceSeq: surface, sourceMessageId: `source-${source}`, sourceAt: source, sourceSeq: source },
  } } as unknown as SessionEventLikeEntry)
  const records = Array.from({ length: 20 }, (_, index) => [
    { type: 'event', event: row(index * 2).event } as SessionEventLikeEntry,
    native(index * 2 + 1, index * 2, index),
  ]).flat()
  const pin = pinSourceViewport(records, { firstSeq: 32, lastSeq: 38, followingTail: true })!
  assert.equal(pin.visibleGroups, 4)
  assert.equal(sourceGroups(records).length, 20)
  const next = [...records, ...Array.from({ length: 30 }, (_, index) => native(40 + index, null, 20 + index))]
  const plan = sourceRetentionPlan(next, [pin], 'newer', unitBudget)
  assert.deepEqual(bodySeqs(next.slice(plan.first, plan.last)), Array.from({ length: 10 }, (_, index) => (index + 10) * 2))
  assert.equal(next[plan.last - 1]!.event.seq, 69)
})

test('native tool-call siblings and their referenced annotations form one indivisible source row', () => {
  const event = (seq: number, type: string, data: object): SessionEventLikeEntry => ({
    type: 'event', event: { seq, type, time: seq, data },
  } as unknown as SessionEventLikeEntry)
  const records = [
    row(0, 'before'),
    event(1, 'step/start', { turn: 1, step: 1 }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: {
      content: [{ type: 'tool-call', id: 'native-call', name: 'shell', arguments: '{}' }],
    } }),
    event(3, 'tool/call', { turn: 1, step: 1, callId: 'native-call', name: 'shell', arguments: '{}' }),
    event(4, 'plugin:hapi-dsh/notify-summary', { surfaceSeq: 2 }),
    event(5, 'plugin:hapi-dsh/native-item', { surfaceSeq: 2, sourceMessageId: 'call-source', sourceAt: 1, sourceSeq: 1 }),
    row(6, 'after'),
  ]
  assert.deepEqual(sourceGroups(records).map(group => [group.key, group.start, group.end]),
    [['before', 0, 1], ['call-source', 1, 6], ['after', 6, 7]])
  const pin = pinSourceViewport(records, { firstSeq: 3, lastSeq: 3, followingTail: false })!
  const plan = sourceRetentionPlan(records, [pin], 'newer', { ...unitBudget, events: 1 })
  assert.equal(plan.oversizedRow, true)
  assert.deepEqual(records.slice(plan.first, plan.last), records.slice(1, 6),
    'a safety trim cannot keep the annotation while dropping its tool-call body')
})

test('a state update inside one native row cannot split the body from its source annotation', () => {
  const annotation = { type: 'event', event: { type: 'plugin:hapi-dsh/native-item', seq: 3, time: 3,
    data: { surfaceSeq: 1, sourceMessageId: 'same-source', sourceAt: 1, sourceSeq: 1 } } } as unknown as SessionEventLikeEntry
  const records = [row(0, 'before'), { type: 'event', event: row(1).event } as SessionEventLikeEntry,
    control(2), annotation, row(4, 'after')]
  assert.deepEqual(sourceGroups(records).map(group => [group.key, group.start, group.end]),
    [['before', 0, 1], ['same-source', 1, 4], ['after', 4, 5]])
  const unrelated = [row(0, 'left'), control(1), row(2, 'right')]
  assert.deepEqual(sourceGroups(unrelated).map(group => group.key), ['left', 'event:1', 'right'],
    'a status update between different source rows must not merge their identities')
})

test('a real new body advances the tail across status frames without replacing its reading budget', () => {
  const pin = pinSourceViewport(entries, { firstSeq: 96, lastSeq: 99, followingTail: true })!
  const records = [...entries, control(100), control(101), row(102), control(103)]
  const plan = sourceRetentionPlan(records, [pin], 'newer', unitBudget)
  assert.deepEqual(bodySeqs(records.slice(plan.first, plan.last)), [91, 92, 93, 94, 95, 96, 97, 98, 99, 102])
  assert.equal(records[plan.last - 1]!.event.seq, 103)
})

test('control-frame pressure reports a safety conflict instead of retaining a bodyless tail', () => {
  const pin = pinSourceViewport(entries, { firstSeq: 96, lastSeq: 99, followingTail: true })!
  const records = [...entries, ...Array.from({ length: 60 }, (_, index) => control(index + 100))]
  const plan = sourceRetentionPlan(records, [pin], 'newer', { ...unitBudget, events: 50 })
  assert.equal(plan.fits, false, 'the owner preserves its existing reader on this conflict')
  assert.deepEqual(bodySeqs(records.slice(plan.first, plan.last)), [96, 97, 98, 99])
})

test('requested pages retain their complete contiguous interval with interleaved status records', () => {
  const records = Array.from({ length: 50 }, (_, index) => [row(index * 2), control(index * 2 + 1)]).flat()
  const pin = pinSourceViewport(records, { firstSeq: 90, lastSeq: 98, followingTail: false })!
  const older = protectSourcePage(records.slice(0, 80), [pin])
  const newer = protectSourcePage(records.slice(10), [pin])
  assert.equal(older[1]!.first, 'm0')
  assert.equal(older[1]!.last, 'event:79')
  assert.equal(older[1]!.visibleGroups, 40)
  assert.equal(newer[1]!.first, 'm10')
  assert.equal(newer[1]!.last, 'event:99')
  assert.equal(newer[1]!.visibleGroups, 45)
})
