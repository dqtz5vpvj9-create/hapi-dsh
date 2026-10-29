/** Pure page projection against the pinned Session writer and Conversation assembler. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { NativeProjector, type NativeProjectorOptions } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'
import { ObservedProjector, type ObservedProjectorOptions } from '../src/hapi-agent/projector.ts'
import type { ObservedItem } from '../src/hapi-agent/parser.ts'
import { HistoryProjectionSink } from '../src/shared/projection-event-sink.ts'
import { toSourceFrames } from '../src/shared/source-frame-builder.ts'
import { SourceWindowStore } from '../src/client/source-window-store.ts'
import { officialChat } from './official-conversation-fixture.ts'

const nativeOptions: NativeProjectorOptions = {
  model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined, stream: () => {},
}
const observedOptions: ObservedProjectorOptions = {
  model: () => 'fixture', submittedMessage: () => undefined, content: () => undefined, stream: () => {},
}
function base(seq: number) {
  return { key: `item-${seq}`, rowId: `row-${seq}`, localId: `local-${seq}`, seq, createdAt: 1000 + seq,
    sourceAt: 2000 + seq, fingerprint: `fingerprint-${seq}`, execution: { threadId: 'thread', turnId: 'turn', itemId: `item-${seq}` } }
}
const nativeRows: NativeRow[] = [
  { ...base(1), kind: 'user', text: 'question', invoked: true, mode: 'queue', parts: [] },
  { ...base(2), kind: 'assistant', text: 'reasoning', reasoning: true, final: true },
  { ...base(3), kind: 'tool-call', callId: 'tool', name: 'read', input: { path: '/fixture' } },
  { ...base(4), kind: 'tool-result', callId: 'tool', output: 'fixture contents', isError: false },
  { ...base(5), kind: 'assistant', text: 'answer', reasoning: false, final: true },
  { ...base(6), kind: 'turn', execution: { ...base(6).execution, turn: { started: true, ended: true, status: 'completed' } } },
]
function observedBase(seq: number) {
  const { execution: _, ...item } = base(seq)
  return { ...item, scopeId: null, parentToolCallId: null, model: null }
}
const observedRows: ObservedItem[] = [
  { ...observedBase(1), kind: 'user', text: 'question', parts: [], invoked: true, mode: 'queue' },
  { ...observedBase(2), kind: 'assistant', text: 'reasoning', parts: [{ type: 'reasoning', text: 'reasoning' }], reasoning: true, live: false, cumulative: false },
  { ...observedBase(3), kind: 'tool-call', callId: 'tool', name: 'read', input: { path: '/fixture' } },
  { ...observedBase(4), kind: 'tool-result', callId: 'tool', output: 'fixture contents', parts: [], isError: false },
  { ...observedBase(5), kind: 'assistant', text: 'answer', parts: [{ type: 'text', text: 'answer' }], reasoning: false, live: false, cumulative: false },
  { ...observedBase(6), kind: 'end', reason: 'completed', error: null },
]

for (const partial of [false, true]) for (const engine of ['native', 'observed'] as const) {
  test(`${engine} pure ${partial ? 'partial' : 'complete'} page matches every official Session event`, async context => {
    const session = Session.create(SessionId(`reference-${engine}-${partial}`))
    const reference = engine === 'native' ? new NativeProjector(session, nativeOptions) : new ObservedProjector(session, observedOptions)
    if (partial) reference.setSuppressFirstTurnStart()
    reference.beginHistorySeed()
    if (reference instanceof NativeProjector) reference.apply(partial ? nativeRows.slice(1) : nativeRows)
    else reference.apply(partial ? observedRows.slice(1) : observedRows)
    const noSession = context.mock.method(Session, 'create', () => { throw new Error('history created a Session') })
    const projected = engine === 'native' ? NativeProjector.history(nativeOptions) : ObservedProjector.history(observedOptions)
    if (partial) projected.setSuppressFirstTurnStart()
    if (projected instanceof NativeProjector) projected.apply(partial ? nativeRows.slice(1) : nativeRows)
    else projected.apply(partial ? observedRows.slice(1) : observedRows)
    noSession.mock.restore()
    assert.deepEqual(projected.historySeed(), reference.historySeed(), 'body, source annotations, seqs, timestamps and surface metadata remain equivalent')
    assert.deepEqual(projected.sourceSeqEntries(), reference.sourceSeqEntries())
    assert.deepEqual(projected.turnAnchorEntries(), reference.turnAnchorEntries())
    assert.deepEqual(projected.stepAnchorEntries(), reference.stepAnchorEntries())
    assert.deepEqual(projected.rewindSeqEntries(), reference.rewindSeqEntries())
    assert.equal(projected.eventSources()?.size, projected.historySeed().length)
    for (const [seq, source] of projected.eventSources()!) {
      assert.ok(source.messageId.startsWith('row-'))
      assert.equal(source.at, source.seq + 2000)
      assert.equal(projected.historySeed()[seq]?.time, source.seq + 1000)
    }
    assert.throws(() => projected.session, /no Session/)
    const chat = officialChat()
    try {
      chat.assembler.replaceWindow(projected.historySeed().map(event => ({ type: 'event', event })), partial)
      chat.assembler.activateTarget('chat'); chat.assembler.flush()
      assert.ok(chat.assembler.snapshot('chat').order.length > 0)
      const store = new SourceWindowStore()
      store.apply({ kind: 'replace', frames: frames(projected) })
      chat.assembler.replaceWindow(store.entries, partial); chat.assembler.flush()
      assert.ok(chat.assembler.snapshot('chat').order.length > 0, 'canonical coordinates retain the actual official Conversation projection')
    } finally { await chat.close() }
  })
}

test('pure projection preserves the original source row when a terminal settles an interrupted stream', () => {
  const provisional: NativeRow = { ...base(1), kind: 'assistant', text: 'partial answer', reasoning: false, final: false }
  const terminal: NativeRow = { ...base(2), kind: 'turn', execution: { ...base(2).execution,
    turn: { started: true, ended: true, status: 'interrupted' } } }
  const native = NativeProjector.history(nativeOptions)
  native.apply([provisional, terminal])
  const assistant = native.historySeed().find(event => event.type === 'assistant/message')!
  const ended = native.historySeed().find(event => event.type === 'turn/end')!
  assert.equal(native.eventSources()?.get(assistant.seq)?.messageId, provisional.rowId)
  assert.equal(native.eventSources()?.get(ended.seq)?.messageId, terminal.rowId)
  const observed = ObservedProjector.history(observedOptions)
  observed.apply([{ ...observedBase(1), kind: 'assistant', text: 'partial answer', parts: [], reasoning: false, live: true, cumulative: true },
    { ...observedBase(2), kind: 'end', reason: 'aborted', error: null }])
  const observedBody = observed.historySeed().find(event => event.type === 'assistant/message')!
  const observedEnd = observed.historySeed().find(event => event.type === 'turn/end')!
  assert.equal(observed.eventSources()?.get(observedBody.seq)?.messageId, 'row-1')
  assert.equal(observed.eventSources()?.get(observedEnd.seq)?.messageId, 'row-2')
})

test('the pure sink retains JSON and surface validation without changing its log on rejection', () => {
  const sink = new HistoryProjectionSink()
  const message = freezeMessage({ id: MessageId('user'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] })
  const official = Session.create(SessionId('surface-reference'))
  for (const append of [
    () => sink.append('user/message', message, 1000, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(10)] }),
    () => official.append('user/message', message, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(10)] }),
  ]) assert.throws(append)
  assert.equal(sink.seq, 0); assert.equal(official.seq, 0)
  assert.throws(() => sink.append('turn/start', { turn: Number.NaN }, 1000), /JSON/)
  const event = sink.append('user/message', message, 1000, { surfaceOp: 'append' })
  assert.equal(event.seq, 0)
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.data))
  assert.deepEqual(sink.events, [{ type: 'user/message', seq: 0, time: 1000, data: message, surfaceOp: 'append' }])
})

function frames(projector: NativeProjector | ObservedProjector) {
  return toSourceFrames({ events: projector.historySeed(), eventSources: projector.eventSources()!,
    turnAnchors: projector.turnAnchorEntries(), stepAnchors: projector.stepAnchorEntries() })
}

for (const engine of ['native', 'observed'] as const) test(`${engine} user frame identity belongs to its source item even without the delivery journal`, () => {
  const message = freezeMessage({ id: MessageId('original-dsh-user'), role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'question' }] })
  const live = engine === 'native' ? NativeProjector.history({ ...nativeOptions, submittedMessage: () => message })
    : ObservedProjector.history({ ...observedOptions, submittedMessage: () => message })
  const detached = engine === 'native' ? NativeProjector.history(nativeOptions) : ObservedProjector.history(observedOptions)
  if (live instanceof NativeProjector && detached instanceof NativeProjector) {
    live.apply([nativeRows[0]!]); detached.apply([nativeRows[0]!])
  } else if (live instanceof ObservedProjector && detached instanceof ObservedProjector) {
    live.apply([observedRows[0]!]); detached.apply([observedRows[0]!])
  }
  const existing = frames(live).find(frame => frame.event.type === 'user/message')!
  const page = frames(detached).find(frame => frame.event.type === 'user/message')!
  assert.notDeepEqual(existing.event.data, page.event.data)
  assert.equal(existing.key, page.key)
  const store = new SourceWindowStore()
  store.apply({ kind: 'replace', frames: frames(live) }); store.apply({ kind: 'merge', frames: frames(detached) })
  assert.equal(store.entries.filter(entry => entry.event.type === 'user/message').length, 1)
})

for (const engine of ['native', 'observed'] as const) test(`${engine} canonical body, step and reference keys agree between live and detached history`, () => {
  const full = engine === 'native' ? NativeProjector.history(nativeOptions) : ObservedProjector.history(observedOptions)
  const page = engine === 'native' ? NativeProjector.history(nativeOptions) : ObservedProjector.history(observedOptions)
  page.setSuppressFirstTurnStart()
  if (full instanceof NativeProjector && page instanceof NativeProjector) {
    full.apply(nativeRows); page.apply(nativeRows.slice(4))
  } else if (full instanceof ObservedProjector && page instanceof ObservedProjector) {
    full.apply(observedRows); page.apply(observedRows.slice(4))
  }
  const liveFrames = frames(full), detachedFrames = frames(page)
  for (const detached of detachedFrames.filter(frame => frame.event.type !== 'turn/end')) {
    const known = liveFrames.find(frame => frame.key === detached.key)
    assert.ok(known, `missing stable key for ${detached.event.type}`)
    assert.equal(detached.stepKey, known.stepKey)
    assert.deepEqual(detached.refs, known.refs)
  }
  const body = detachedFrames.find(frame => frame.event.type === 'assistant/message')!
  const item = detachedFrames.find(frame => String(frame.event.type).endsWith('/item') || String(frame.event.type).endsWith('/native-item'))!
  assert.equal(item.refs?.surfaceKey, body.key)
  assert.notEqual(body.event.seq, liveFrames.find(frame => frame.key === body.key)!.event.seq, 'local sequence differs while canonical identity remains unchanged')
})

for (const engine of ['native', 'observed'] as const) test(`${engine} transient source text is replaced by the final frame with the same key`, () => {
  const projector = engine === 'native' ? NativeProjector.history(nativeOptions) : ObservedProjector.history(observedOptions)
  if (projector instanceof NativeProjector) projector.apply([{ ...base(1), kind: 'assistant', text: 'Partial', reasoning: false, final: false }])
  else projector.apply([{ ...observedBase(1), kind: 'assistant', text: 'Partial', parts: [], reasoning: false, live: true, cumulative: true }])
  const [transient] = projector.activeSourceFrames()
  assert.ok(transient?.transient)
  assert.equal(projector.historySeed().some(event => event.type === 'assistant/message'), false, 'transient content is not appended as a durable simulated message')
  if (projector instanceof NativeProjector) projector.apply([{ ...base(1), rowId: 'final-row', kind: 'assistant', text: 'Partial answer.', reasoning: false, final: true }])
  else projector.apply([{ ...observedBase(1), rowId: 'final-row', kind: 'assistant', text: 'Partial answer.', parts: [{ type: 'text', text: 'Partial answer.' }], reasoning: false, live: false, cumulative: true }])
  const final = frames(projector).find(frame => frame.event.type === 'assistant/message')!
  assert.equal(final.key, transient.key)
  assert.equal(final.stepKey, transient.stepKey)
  assert.equal(final.transient, undefined)
  assert.equal(final.source?.messageId, 'final-row')
  assert.deepEqual(projector.activeSourceFrames(), [])
})
