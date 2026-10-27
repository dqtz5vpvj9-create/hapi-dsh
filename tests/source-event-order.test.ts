import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { hasLateSourceRows, orderSourceWindow, sourceMessageForSequence, sourceSequenceForMessage } from '../src/client/source-event-order.ts'

test('separately framed annotations resolve resident reading anchors in both directions', () => {
  for (const [type, field] of [['plugin:hapi-dsh/native-item', 'sourceMessageId'], ['plugin:hapi-dsh-observed/item', 'sourceRowId']]) {
    const body = entry(3_001_000_001, 'assistant/message', { id: 'body', turn: 2, step: 1 })
    const annotation = entry(3_001_000_002, type!, {
      [field!]: 'source-body', sourceAt: 20, sourceSeq: 4, surfaceSeq: body.event.seq,
    })
    assert.equal(sourceMessageForSequence([body], Number(body.event.seq)), undefined)
    assert.equal(sourceMessageForSequence([body, annotation], Number(body.event.seq)), 'source-body')
    assert.equal(sourceSequenceForMessage([body, annotation], 'source-body'), body.event.seq)
    assert.equal(sourceSequenceForMessage([annotation], 'source-body'), undefined, 'an evicted body is not resident')
  }
})

function entry(seq: number, type: string, data: Record<string, unknown>, at?: number,
  extra: Record<string, unknown> = {}): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq, time: seq, data, ...extra },
    ...(at === undefined ? {} : { source: { messageId: String(data.id ?? seq), at, seq: at } }),
  } as unknown as SessionEventLikeEntry
}
function data(row: SessionEventLikeEntry): Record<string, unknown> { return row.event.data as Record<string, unknown> }
function bodyOrder(rows: readonly SessionEventLikeEntry[]): unknown[] {
  return rows.filter(row => row.event.type === 'user/message' || row.event.type === 'assistant/message').map(row => data(row).id)
}
function assertScopes(rows: readonly SessionEventLikeEntry[]): void {
  let turn: number | undefined
  const steps = new Set<string>()
  for (const row of rows) {
    const value = data(row)
    if (row.event.type === 'turn/start') turn = value.turn as number
    else if (row.event.type === 'turn/end') turn = undefined
    else if (row.event.type === 'step/start') {
      assert.equal(value.turn, turn, 'step/start must follow its turn/start')
      steps.add(`${value.turn}:${value.step}`)
    } else if (row.event.type === 'user/message') {
      assert.ok(turn !== undefined, 'a user/message must stay inside its turn')
    } else if (row.event.type === 'assistant/message') {
      assert.equal(value.turn, turn, 'assistant/message must stay inside its turn')
      assert.ok(steps.has(`${value.turn}:${value.step}`), 'assistant/message must follow its step/start')
    }
  }
}

test('late closed turns sort as complete scopes and remap in-window seq references', () => {
  const later = [entry(10, 'turn/start', { turn: 2 }), entry(11, 'step/start', { turn: 2, step: 1 }),
    entry(12, 'assistant/message', { turn: 2, step: 1, id: 'later' }, 20),
    entry(13, 'plugin:hapi-dsh/native-item', { displayTurn: 2, displayStep: 1, surfaceSeq: 12 }, 20,
      { sourceEventSeqs: [12, 3], surfaceOp: { kind: 'replace', startSeq: 12, endSeq: 12 } }),
    entry(14, 'step/end', { turn: 2, step: 1 }), entry(15, 'turn/end', { turn: 2 })]
  const earlier = [entry(16, 'turn/start', { turn: 1 }), entry(17, 'step/start', { turn: 1, step: 1 }),
    entry(18, 'assistant/message', { turn: 1, step: 1, id: 'earlier' }, 10),
    entry(19, 'step/end', { turn: 1, step: 1 }), entry(20, 'turn/end', { turn: 1 })]
  assert.equal(hasLateSourceRows(later, earlier), true)
  const ordered = orderSourceWindow([...later, ...earlier])
  assert.deepEqual(bodyOrder(ordered), ['earlier', 'later'])
  assertScopes(ordered)
  const body = ordered.find(row => data(row).id === 'later')!
  const annotation = ordered.find(row => String(row.event.type) === 'plugin:hapi-dsh/native-item')!
  const annotationEvent = annotation.event as unknown as { sourceEventSeqs: unknown; surfaceOp: unknown }
  assert.equal(data(annotation).surfaceSeq, body.event.seq)
  assert.deepEqual(annotationEvent.sourceEventSeqs, [body.event.seq, 3], 'references outside this window retain their original identity')
  assert.deepEqual(annotationEvent.surfaceOp, { kind: 'replace', startSeq: body.event.seq, endSeq: body.event.seq })
})

test('user messages without numeric coordinates retain their surrounding turn context', () => {
  const rows = [entry(10, 'turn/start', { turn: 2 }), entry(11, 'user/message', { id: 'later' }, 20),
    entry(12, 'turn/end', { turn: 2 }), entry(13, 'turn/start', { turn: 1 }),
    entry(14, 'user/message', { id: 'earlier' }, 10), entry(15, 'turn/end', { turn: 1 })]
  const ordered = orderSourceWindow(rows)
  assert.deepEqual(bodyOrder(ordered), ['earlier', 'later'])
  assertScopes(ordered)
})

test('late detection reads the native annotation source coordinates before top-level enrichment', () => {
  const native = (seq: number, at: number) => entry(seq, 'plugin:hapi-dsh/native-item', {
    displayTurn: seq, displayStep: 1, sourceMessageId: `source-${at}`, sourceAt: at, sourceSeq: at,
  })
  assert.equal(hasLateSourceRows([native(10, 20)], [native(11, 10)]), true)
  assert.equal(hasLateSourceRows([native(10, 20)], [native(11, 30)]), false)
})

test('observed annotation coordinates detect late rows and attach source identity to their user body', () => {
  const native = entry(10, 'plugin:hapi-dsh/native-item', {
    displayTurn: 2, sourceMessageId: 'new', sourceAt: 20, sourceSeq: 20,
  })
  const observed = entry(12, 'plugin:hapi-dsh-observed/item', {
    displayTurn: 1, surfaceSeq: 11, sourceRowId: 'old', sourceAt: 10, sourceSeq: 10,
  })
  assert.equal(hasLateSourceRows([native], [observed]), true)
  const ordered = orderSourceWindow([native, entry(11, 'user/message', { id: 'user' }), observed])
  const body = ordered.find(row => data(row).id === 'user')!
  assert.deepEqual((body as unknown as { source: unknown }).source, { messageId: 'old', at: 10, seq: 10 })
})

test('recovered source positions remain on ordered bodies and annotations for local reading anchors', () => {
  const rows = [entry(10, 'turn/start', { turn: 1 }), entry(11, 'step/start', { turn: 1, step: 1 }),
    entry(12, 'assistant/message', { turn: 1, step: 1, id: 'body' }),
    entry(13, 'plugin:hapi-dsh/native-item', { displayTurn: 1, displayStep: 1, surfaceSeq: 12,
      sourceMessageId: 'source-body', sourceAt: 20, sourceSeq: 4 }), entry(14, 'step/end', { turn: 1, step: 1 })]
  const ordered = orderSourceWindow(rows)
  for (const row of ordered.filter(row => data(row).id === 'body' || String(row.event.type) === 'plugin:hapi-dsh/native-item')) {
    assert.deepEqual((row as unknown as { source: unknown }).source, { messageId: 'source-body', at: 20, seq: 4 })
  }
})

test('a clipped source step retains its body without inventing unavailable start boundaries', () => {
  const rows = [entry(10, 'turn/start', { turn: 2 }), entry(11, 'step/start', { turn: 2, step: 1 }),
    entry(12, 'assistant/message', { id: 'later', turn: 2, step: 1 }, 20),
    entry(13, 'step/end', { turn: 2, step: 1 }), entry(14, 'turn/end', { turn: 2 }),
    entry(15, 'assistant/message', { id: 'earlier', turn: 1, step: 4 }, 10)]
  const ordered = orderSourceWindow(rows)
  assert.deepEqual(bodyOrder(ordered), ['earlier', 'later'])
  assert.equal(ordered.filter(row => row.event.type === 'turn/start').length, 1)
  assert.equal(ordered.filter(row => row.event.type === 'step/start').length, 1)
  assertScopes(ordered.filter(row => data(row).turn === 2))
  assert.equal(new Set(ordered.map(row => row.event.seq)).size, ordered.length)
  assert.equal(ordered.filter(row => row.event.type === 'turn/end').length, 1, 'ordering must not invent a terminal turn result')
  assert.equal(ordered.filter(row => row.event.type === 'step/end').length, 1, 'ordering must not invent a terminal step result')
})

test('surface annotations inherit the referenced body context even after step/end', () => {
  const rows = [entry(10, 'turn/start', { turn: 2 }), entry(11, 'step/start', { turn: 2, step: 1 }),
    entry(12, 'assistant/message', { id: 'later', turn: 2, step: 1 }, 20),
    entry(13, 'step/end', { turn: 2, step: 1 }),
    entry(14, 'plugin:hapi-dsh-observed/item', { surfaceSeq: 12 }, 20), entry(15, 'turn/end', { turn: 2 }),
    entry(16, 'turn/start', { turn: 1 }), entry(17, 'user/message', { id: 'earlier' }, 10), entry(18, 'turn/end', { turn: 1 })]
  const ordered = orderSourceWindow(rows)
  const annotationIndex = ordered.findIndex(row => String(row.event.type) === 'plugin:hapi-dsh-observed/item')
  const bodyIndex = ordered.findIndex(row => data(row).id === 'later')
  assert.ok(annotationIndex > bodyIndex, 'the annotation cannot move before its referenced body')
  assert.equal(data(ordered[annotationIndex]!).surfaceSeq, ordered[bodyIndex]!.event.seq)
  assertScopes(ordered)
})

test('empty windows stay empty and equal source positions retain arrival order', () => {
  assert.deepEqual(orderSourceWindow([]), [])
  const rows = [entry(10, 'turn/start', { turn: 1 }), entry(11, 'user/message', { id: 'first' }, 10),
    entry(12, 'user/message', { id: 'second' }, 10), entry(13, 'turn/end', { turn: 1 })]
  assert.equal(hasLateSourceRows(rows, []), false)
  assert.deepEqual(bodyOrder(orderSourceWindow(rows)), ['first', 'second'])
})
