import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceWindowStore } from '../src/client/source-window-store.ts'
import type { SourceFrame } from '../src/shared/source-frames.ts'

function frame(key: string, seq: number, type = 'assistant/message', overrides: Partial<SourceFrame> = {}): SourceFrame {
  return { key, source: { messageId: `row-${seq}`, at: seq, seq }, turnKey: `turn-${seq}`, stepKey: `step-${seq}`,
    event: { type, seq: 1, time: seq, data: { turn: 1, step: 1, message: { id: key, role: 'assistant', content: [{ type: 'text', text: key }] } } } as unknown as SourceFrame['event'],
    ...overrides }
}
const data = (store: SourceWindowStore, key: string) => store.entries.find(entry =>
  (entry.event.data as { message?: { id?: string } }).message?.id === key)!

test('page and live revisions share one identity; a late older page cannot restore stale text', () => {
  const store = new SourceWindowStore()
  store.apply({ kind: 'replace', frames: [frame('answer', 10)] })
  const originalSeq = data(store, 'answer').event.seq
  const newer = frame('answer', 20)
  store.apply({ kind: 'merge', frames: [newer] })
  store.apply({ kind: 'merge', frames: [frame('answer', 10)] })
  assert.equal(store.entries.length, 1)
  assert.equal(store.frames[0]?.source?.messageId, 'row-20')
  assert.equal(data(store, 'answer').event.seq, originalSeq)
})

test('replayed source frames preserve the projected entry when their meaning is unchanged', () => {
  const store = new SourceWindowStore()
  store.apply({ kind: 'replace', frames: [frame('resident', 10)] })
  const original = data(store, 'resident')
  store.apply({ kind: 'merge', frames: [frame('resident', 10)] })
  assert.equal(data(store, 'resident'), original,
    'a fresh transport object for the same source row does not trigger a Conversation replacement')
})

test('late resource hydration cannot be overwritten by the original page response', () => {
  const store = new SourceWindowStore()
  const original = frame('image', 10)
  store.apply({ kind: 'replace', frames: [original] })
  const hydrated = frame('image', 10, 'assistant/message', { contentRevision: 1,
    event: { ...original.event, data: { turn: 1, step: 1, message: { id: 'image', role: 'assistant',
      content: [{ type: 'image', attachment: { attachmentId: 'source-image' } }] } } } as unknown as SourceFrame['event'] })
  store.apply({ kind: 'merge', frames: [hydrated] })
  store.apply({ kind: 'merge', frames: [original] })
  assert.deepEqual((data(store, 'image').event.data as { message: { content: unknown[] } }).message.content, [
    { type: 'image', attachment: { attachmentId: 'source-image' } },
  ], 'a delayed base page cannot replace resource content that arrived first over the live feed')
})

test('backfilled turn context does not reclassify an already visible source row', () => {
  const store = new SourceWindowStore()
  const original = frame('partial', 10, 'assistant/message', { turnKey: 'partial-turn', stepKey: 'partial-step' })
  store.apply({ kind: 'replace', frames: [original] })
  const entry = data(store, 'partial')
  store.apply({ kind: 'merge', frames: [frame('partial', 10, 'assistant/message',
    { turnKey: 'resolved-turn', stepKey: 'resolved-step' })] })
  assert.equal(data(store, 'partial'), entry,
    'new historical context must be inserted around resident rows instead of rebuilding their turn identity')
})

test('backfilled view references do not replace an unchanged resident source event', () => {
  const store = new SourceWindowStore()
  const original = frame('annotation', 10, 'plugin:hapi-dsh/native-item')
  store.apply({ kind: 'replace', frames: [original] })
  const entry = data(store, 'annotation')
  store.apply({ kind: 'merge', frames: [frame('annotation', 10, 'plugin:hapi-dsh/native-item',
    { refs: { surfaceKey: 'body', sourceEventKeys: ['body'] } })] })
  assert.equal(data(store, 'annotation'), entry,
    'a page cannot force a full conversation rebuild through a view-only reference remap')
})

test('older pages preserve resident view identities and rewrite every frame reference once', () => {
  const store = new SourceWindowStore()
  const body = frame('body', 20)
  const annotation = frame('annotation', 20, 'plugin:hapi-dsh/native-item', {
    event: { type: 'plugin:hapi-dsh/native-item', seq: 2, time: 20, data: { displayTurn: 1, displayStep: 1, surfaceSeq: 1 },
      sourceEventSeqs: [1], surfaceOp: { kind: 'replace', startSeq: 1, endSeq: 1 } } as unknown as SourceFrame['event'],
    refs: { surfaceKey: 'body', sourceEventKeys: ['body'], surfaceOp: { startKey: 'body', endKey: 'body' } },
  })
  store.apply({ kind: 'replace', frames: [body, annotation] })
  const before = data(store, 'body'), turn = (before.event.data as { turn: number }).turn
  store.apply({ kind: 'merge', frames: [frame('older', 10), body] })
  const after = data(store, 'body')
  assert.equal(after, before, 'an unchanged resident projection keeps its identity across prepend and overlap')
  assert.equal(after.event.seq, before.event.seq)
  assert.equal((after.event.data as { turn: number }).turn, turn)
  assert.ok(data(store, 'older').event.seq < after.event.seq)
  const note = store.entries.find(entry => String(entry.event.type) === 'plugin:hapi-dsh/native-item')!.event as unknown as Record<string, unknown>
  assert.equal((note.data as { surfaceSeq: number }).surfaceSeq, after.event.seq)
  assert.deepEqual(note.sourceEventSeqs, [after.event.seq])
  assert.deepEqual(note.surfaceOp, { kind: 'replace', startSeq: after.event.seq, endSeq: after.event.seq })
})

test('several dense pages inside one turn keep resident event sequences stable', () => {
  const store = new SourceWindowStore()
  const left = frame('left-boundary', 0), right = frame('right-boundary', 10_000)
  store.apply({ kind: 'replace', frames: [left, right] })
  const resident = new Map(store.entries.map(entry => [entry.event.type === 'assistant/message'
    ? String((entry.event.data as { message: { id: string } }).message.id) : '', entry]))
  const originalLeft = resident.get('left-boundary')!, originalRight = resident.get('right-boundary')!
  const originalLeftSeq = originalLeft.event.seq, originalRightSeq = originalRight.event.seq

  const page = (start: number, end: number): SourceFrame[] => Array.from({ length: end - start }, (_, index) => {
    const at = start + index
    return frame(`inserted-${at}`, at, 'assistant/message', { turnKey: 'shared-turn', stepKey: 'shared-step' })
  })
  store.apply({ kind: 'merge', frames: page(100, 800) })
  store.apply({ kind: 'merge', frames: page(800, 1_500) })
  store.apply({ kind: 'merge', frames: page(1_500, 2_200) })

  const afterLeft = store.entries.find(entry => (entry.event.data as { message?: { id?: string } }).message?.id === 'left-boundary')!
  const afterRight = store.entries.find(entry => (entry.event.data as { message?: { id?: string } }).message?.id === 'right-boundary')!
  assert.equal(afterLeft, originalLeft)
  assert.equal(afterRight, originalRight)
  assert.equal(afterLeft.event.seq, originalLeftSeq)
  assert.equal(afterRight.event.seq, originalRightSeq)
  assert.ok(store.entries.every(entry => Number.isSafeInteger(entry.event.seq)),
    'dense page inserts stay within exact client sequence coordinates')
})

test('operation controls do not consume transcript prefix coordinates across repeated history pages', () => {
  const store = new SourceWindowStore()
  const control = (type: string): SourceFrame => ({ key: `transport:${type}`,
    event: { type, seq: 0, time: 1, data: { status: 'idle' } } as unknown as SourceFrame['event'] })
  store.apply({ kind: 'replace', frames: [control('plugin:hapi-dsh/state'), control('plugin:hapi-dsh/execution'), frame('latest', 10_000)] })
  const readEntry = (key: string) => store.entries.find(entry =>
    (entry.event.data as { message?: { id?: string } }).message?.id === key
    || (String(entry.event.type) === 'plugin:hapi-dsh/state' && key === 'state')
    || (String(entry.event.type) === 'plugin:hapi-dsh/execution' && key === 'execution'))!
  const fixedState = readEntry('state'), fixedExecution = readEntry('execution')
  const controlSeqs = [fixedState.event.seq, fixedExecution.event.seq]

  for (let page = 0; page < 20; page++) {
    const first = 9_999 - page * 32
    const older = Array.from({ length: 32 }, (_, index) => frame(`older-${page}-${index}`, first - index))
    const resident = new Map(store.entries.map(entry => [entry.event.type === 'assistant/message'
      ? String((entry.event.data as { message: { id: string } }).message.id)
      : `control-${entry.event.type}`, entry]))
    store.apply({ kind: 'merge', frames: older })
    for (const [key, previous] of resident) {
      const current = key === 'control-plugin:hapi-dsh/state' ? readEntry('state')
        : key === 'control-plugin:hapi-dsh/execution' ? readEntry('execution')
          : readEntry(key)
      assert.equal(current, previous, `resident ${key} must keep its projected identity`)
      assert.equal(current.event.seq, previous.event.seq, `resident ${key} must keep its sequence`)
    }
  }

  assert.deepEqual([readEntry('state').event.seq, readEntry('execution').event.seq], controlSeqs)
  assert.equal(readEntry('state').event.seq, 1)
  assert.equal(readEntry('execution').event.seq, 4)
  assert.equal(store.entries.length, 643)
  assert.ok(store.entries.every(entry => Number.isSafeInteger(entry.event.seq)))
})

test('append and rejected stale revisions retain unchanged projection objects', () => {
  const store = new SourceWindowStore()
  const first = frame('first', 10), second = frame('second', 20)
  store.apply({ kind: 'replace', frames: [first] })
  const original = data(store, 'first')
  store.apply({ kind: 'merge', frames: [second] })
  assert.equal(data(store, 'first'), original)
  store.apply({ kind: 'merge', frames: [frame('first', 5)] })
  assert.equal(data(store, 'first'), original, 'rejected input cannot masquerade as a resident revision')
  store.apply({ kind: 'merge', frames: [frame('first', 11)] })
  assert.notEqual(data(store, 'first'), original, 'a real same-key revision must remain observable')
})

test('a late referenced surface invalidates only projections whose resolved references change', () => {
  const store = new SourceWindowStore()
  const note = frame('note', 20, 'plugin:hapi-dsh/native-item', {
    refs: { surfaceKey: 'body', sourceEventKeys: ['body'], surfaceOp: { startKey: 'body', endKey: 'body' } },
  })
  store.apply({ kind: 'replace', frames: [note, frame('unrelated', 30)] })
  const before = data(store, 'note'), unrelated = data(store, 'unrelated')
  store.apply({ kind: 'merge', frames: [frame('body', 10)] })
  const after = data(store, 'note'), bodySeq = data(store, 'body').event.seq
  assert.notEqual(after, before)
  assert.equal(after.event.seq, before.event.seq)
  assert.equal((after.event.data as { surfaceSeq: number }).surfaceSeq, bodySeq)
  assert.deepEqual((after.event as unknown as { sourceEventSeqs: number[] }).sourceEventSeqs, [bodySeq])
  assert.deepEqual((after.event as unknown as { surfaceOp: object }).surfaceOp, { startSeq: bodySeq, endSeq: bodySeq })
  assert.equal(data(store, 'unrelated'), unrelated)
})

test('durable completion replaces its transient frame and abandoned streams are removed explicitly', () => {
  const store = new SourceWindowStore()
  store.apply({ kind: 'replace', frames: [frame('answer', 20, 'assistant/message', { transient: true })] })
  store.apply({ kind: 'merge', frames: [frame('answer', 10)] })
  assert.equal(store.entries.length, 1)
  assert.equal(store.entries[0]!.type, 'event')
  store.apply({ kind: 'merge', frames: [frame('answer', 30, 'assistant/message', { transient: true })] })
  assert.equal(store.entries[0]!.type, 'event', 'a delayed streaming frame cannot replace committed content')
  store.apply({ kind: 'merge', frames: [frame('abandoned', 40, 'assistant/message', { transient: true })] })
  store.apply({ kind: 'merge', frames: [], removeKeys: ['abandoned'] })
  assert.deepEqual(store.frames.map(row => row.key), ['answer'])
})

test('retention owns canonical data; detached live updates cannot resurrect discarded rows', () => {
  const store = new SourceWindowStore()
  store.apply({ kind: 'replace', frames: [frame('old', 10), frame('reading', 20), frame('tail', 30)] })
  store.retain([data(store, 'reading')])
  store.apply({ kind: 'merge', frames: [frame('reading', 21), frame('tail', 31), frame('new', 40)] }, true)
  assert.deepEqual(store.frames.map(row => row.key), ['reading'])
  assert.equal(store.frames[0]!.source!.seq, 21)
  assert.equal(store.entries.length, 1)
})

test('an authoritative rewrite may replace an identity with a reset source coordinate', () => {
  const store = new SourceWindowStore()
  store.apply({ kind: 'replace', frames: [frame('retained-item', 100), frame('deleted-item', 200)] })
  store.apply({ kind: 'replace', reset: true, frames: [frame('retained-item', 1)] })
  assert.deepEqual(store.frames.map(value => [value.key, value.source!.seq]), [['retained-item', 1]])
})
