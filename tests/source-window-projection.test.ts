import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { HapiMessage, HapiTransport } from '../src/codex/contracts.ts'
import { SourceHistoryWindow, type RenderedHistoryPage } from '../src/codex/source-window.ts'
import { NativeProjector } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'
import { officialChat } from './official-conversation-fixture.ts'
import { HistoryProjectionSink } from '../src/shared/projection-event-sink.ts'
import { SourceWindowStore } from '../src/client/source-window-store.ts'
import { SourceEventFeed } from '../src/client/source-event-feed.ts'
import type { SourceFrame } from '../src/shared/source-frames.ts'

test('older messages inside a resident step never precede its official start', async () => {
  const make = (key: string, at: number, type: string): SourceFrame => ({ key,
    source: { messageId: key, at, seq: at }, turnKey: 'same-turn', stepKey: 'same-step',
    event: { type, seq: at, time: at, data: { turn: 1, step: 1,
      ...(type === 'assistant/message' ? { message: { id: key, role: 'assistant', content: [{ type: 'text', text: key }] } } : {}) },
      ...(type === 'assistant/message' ? { surfaceOp: 'append' } : {}) } as unknown as SourceFrame['event'] })
  const store = new SourceWindowStore(), feed = new SourceEventFeed(), chat = officialChat()
  chat.assembler.activateTarget('chat')
  store.apply({ kind: 'replace', frames: [make('step-start', 110, 'step/start'), make('resident', 120, 'assistant/message')] })
  feed.replace(store.entries, true)
  chat.assembler.replaceWindow(store.entries, true)
  chat.assembler.flush()
  const retained = [...store.entries]
  try {
    // A projector's clipped page can associate earlier reasoning/protocol
    // messages with a step whose start is already present in the next page.
    for (const at of [100, 90, 80]) {
      store.apply({ kind: 'merge', frames: [make(`earlier-${at}`, at, 'assistant/message')] })
      feed.update(store.entries, true)
      const change = feed.getSnapshot().change
      assert.equal(change.kind, 'prepend')
      assert.doesNotThrow(() => {
        chat.assembler.prepend(change.entries as typeof store.entries, true)
        chat.assembler.flush()
      }, 'the official reader must accept every older slice instead of retaining a frozen projection')
      const start = store.entries.find(row => row.event.type === 'step/start')!
      assert.ok(store.entries.filter(row => row.event.type === 'assistant/message').every(row => row.event.seq > start.event.seq))
      for (const row of retained) assert.ok(store.entries.includes(row), 'resident event identities survive the semantic insertion')
    }
  } finally { await chat.close() }
})

test('source windows carry canonical references without assigning display coordinates', async () => {
  const row: HapiMessage = { id: 'source-row', seq: 1, localId: null, createdAt: 1000, content: {} }
  const events = [
    { type: 'user/message', seq: 11, time: 1000, data: { id: 'user', content: [] } },
    { type: 'plugin:hapi-dsh/native-item', seq: 17, time: 1000, data: { surfaceSeq: 11, displayTurn: 1 },
      sourceEventSeqs: [11], surfaceOp: { kind: 'replace', startSeq: 11, endSeq: 11 } },
  ] as unknown as SessionEvent[]
  const rendered: RenderedHistoryPage = { events, lastTurn: 1,
    eventSources: new Map(events.map(event => [event.seq, { messageId: row.id, at: 1000, seq: 1, itemKey: row.id }])),
    sources: new Map([[row.id, 11]]), rewinds: new Map(), forks: new Map() }
  const agent = {
    id: 'hapi-codex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as SessionId,
    binding: { hapiSessionId: 'source' },
    historyWindowAnchor: () => ({ epoch: 1, before: { at: 2000, seq: 2 }, firstTurn: 1, hasOlder: true }),
    renderHistoryPage: async () => rendered,
  }
  const window = new SourceHistoryWindow(agent, {} as HapiTransport)
  const result = await window.windowAt(row.id, 1, 3_000_000_000, async () => ({ messages: [row],
    page: { epoch: 1, reset: false, beforeCursor: { at: 1000, seq: 1 }, afterCursor: { at: 1000, seq: 1 },
      hasMoreBefore: false, hasMoreAfter: false } }))
  const body = result.frames[0]!, annotation = result.frames[1]!
  assert.deepEqual(result.records, [], 'only one body representation crosses the API')
  assert.equal(body.event.seq, 11, 'Host leaves projector-local coordinates untouched')
  assert.equal(annotation.refs?.surfaceKey, body.key)
  assert.deepEqual(annotation.refs?.sourceEventKeys, [body.key])
  assert.deepEqual(annotation.refs?.surfaceOp, { startKey: body.key, endKey: body.key })
  const newer = await window.windowAt(row.id, 1, 123, async () => ({ messages: [row],
    page: { epoch: 2, reset: false, beforeCursor: { at: 1000, seq: 1 }, afterCursor: { at: 1000, seq: 1 },
      hasMoreBefore: false, hasMoreAfter: false } }))
  assert.deepEqual(newer.frames, result.frames, 'epoch and obsolete display coordinate inputs do not change source identity')
  const store = new SourceWindowStore()
  store.apply({ kind: 'replace', frames: result.frames })
  const projected = store.entries
  assert.equal((projected[1]!.event.data as { surfaceSeq: number }).surfaceSeq, projected[0]!.event.seq)
  assert.deepEqual(projected[1]!.event.sourceEventSeqs, [projected[0]!.event.seq])

})

function assistant(item: string, at: number, reasoning = false): NativeRow {
  const key = `${item}:${reasoning ? 'reasoning' : 'answer'}`
  return { kind: 'assistant', key, rowId: key, localId: key, seq: at, createdAt: at, fingerprint: key,
    text: key, final: true, reasoning, execution: { threadId: 'thread', turnId: 'same-turn', itemId: item } }
}
function renderNative(rows: readonly NativeRow[], partial = false, turnBase = 0): RenderedHistoryPage {
  const sink = new HistoryProjectionSink()
  const projector = new NativeProjector(sink, {
    model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined, stream: () => {}, turnBase,
  })
  if (partial) projector.setSuppressFirstTurnStart()
  projector.apply(rows)
  return { events: sink.events, eventSources: sink.eventSources, lastTurn: projector.lastTurn, sources: projector.sourceSeqEntries(),
    rewinds: projector.rewindSeqEntries(), forks: projector.forkBoundaryEntries(),
    turnAnchors: projector.turnAnchorEntries(), stepAnchors: projector.stepAnchorEntries() }
}

for (const directory of ['pending', 'unavailable', 'loaded'] as const) test(`live source identities align context and contiguous windows with directory ${directory}`, { timeout: 2_000 }, async () => {
  const natives = ['turn-a', 'turn-b', 'turn-c', 'turn-d'].map((turnId, index) => ({
    ...assistant(`item-${index}`, 10 + index * 10),
    rowId: `native:thread:${turnId}:item-${index}:answer`, sourceAt: 1000 + index * 1000,
    execution: { threadId: 'thread', turnId, itemId: `item-${index}`,
      turn: { status: 'completed', started: true, ended: true } },
  }) as NativeRow)
  const rows: HapiMessage[] = natives.map(row => ({ id: row.rowId, seq: row.seq!, localId: null,
    createdAt: row.createdAt, invokedAt: row.sourceAt!, content: {} }))
  const byId = new Map(natives.map(row => [row.rowId, row]))
  let live = renderNative(natives.slice(1, 3), false, 100)
  let outlineReads = 0
  const agent = { id: SessionId(`hapi-codex-data-owned-${directory}`), binding: { hapiSessionId: 'source' },
    historyWindowAnchor: () => ({ epoch: 1, before: { at: 2000, seq: 20 }, firstTurn: 101, hasOlder: true,
      oldest: { id: rows[1]!.id, at: 2000, seq: 20 }, partial: true }),
    historyTurnAnchors: () => live.turnAnchors,
    renderHistoryPage: async (page: readonly HapiMessage[]) => renderNative(page.map(row => byId.get(row.id)!), true),
  }
  const window = new SourceHistoryWindow(agent, {} as HapiTransport, undefined, async () => {
    outlineReads++
    if (directory === 'pending') return new Promise(() => {})
    if (directory === 'unavailable') throw new Error('directory offline')
    return { entries: rows.map(row => ({ messageId: row.id, label: row.id, at: row.invokedAt!, seq: row.seq!, createdAt: row.createdAt })),
      page: { epoch: 1, hasMore: false, beforeCursor: null, complete: true } }
  })
  const chat = officialChat()
  try {
    if (directory === 'loaded') await window.canonicalOutline()
    const context = await window.windowAt(rows[1]!.id, 2, 3_000_000_000, async () => ({ messages: rows.slice(0, 2),
      page: { epoch: 1, reset: false, beforeCursor: { at: 1000, seq: 10 }, afterCursor: { at: 2000, seq: 20 },
        hasMoreBefore: true, hasMoreAfter: true } }))
    const before = await window.windowBefore({ at: 2000, seq: 20 }, 3_000_000_000, async () => ({
      messages: rows.slice(0, 1), hasMore: false, next: { at: 1000, seq: 10 }, epoch: 1 }))
    const after = await window.windowAfter({ at: 2000, seq: 20 }, 3_000_001_000, async () => ({
      messages: rows.slice(2, 3), hasMore: false, next: { at: 3000, seq: 30 }, epoch: 1 }))
    live = renderNative(natives.slice(1), false, 100)
    const advanced = await window.windowAfter({ at: 3000, seq: 30 }, 3_000_002_000, async () => ({
      messages: rows.slice(3), hasMore: false, next: { at: 4000, seq: 40 }, epoch: 2 }), 2)
    const bodies = (page: typeof context) => page.frames.filter(row => row.event.type === 'assistant/message')
    assert.equal(bodies(context)[0]!.key, bodies(before)[0]!.key)
    assert.equal(bodies(context)[0]!.stepKey, bodies(before)[0]!.stepKey)
    assert.notEqual(bodies(context)[0]!.turnKey, bodies(context)[1]!.turnKey)
    assert.notEqual(bodies(after)[0]!.turnKey, bodies(advanced)[0]!.turnKey)
    assert.equal(outlineReads, directory === 'loaded' ? 1 : 0, 'body reads never wait for optional metadata')
    const store = new SourceWindowStore()
    for (const page of [context, before, after, advanced]) {
      store.apply({ kind: 'merge', frames: page.frames })
      chat.assembler.replaceWindow(store.entries, page.hasMoreBefore)
      chat.assembler.activateTarget('chat')
      chat.assembler.flush()
    }
    assert.equal(store.entries.filter(row => row.event.type === 'assistant/message').length, 4)

  } finally { window.dispose(); await chat.close() }
})

for (const route of ['before', 'context'] as const) test(`a ${route} page uses native turn identity when its first body precedes the outline label`, async () => {
  const first = { ...assistant('first', 10), rowId: 'native:thread:turn-a:first:answer', sourceAt: 1000,
    execution: { threadId: 'thread', turnId: 'turn-a', itemId: 'first',
      turn: { status: 'completed', started: true, ended: true } } } as NativeRow
  const second = { ...assistant('second', 20), rowId: 'native:thread:turn-b:second:answer', sourceAt: 2000,
    execution: { threadId: 'thread', turnId: 'turn-b', itemId: 'second' } } as NativeRow
  const natives = [first, second], byId = new Map(natives.map(row => [row.rowId, row]))
  const rows: HapiMessage[] = natives.map(row => ({ id: row.rowId, seq: row.seq!, localId: null,
    createdAt: row.createdAt, invokedAt: row.sourceAt!, content: {} }))
  const rendered = renderNative(natives, true)
  const agent = { id: SessionId(`hapi-codex-identity-${route}`), binding: { hapiSessionId: 'source' },
    historyWindowAnchor: () => ({ epoch: 1, before: { at: 2000, seq: 20 }, firstTurn: 101, hasOlder: true,
      oldest: { id: second.rowId, at: 2000, seq: 20 }, partial: true }),
    renderHistoryPage: async (page: readonly HapiMessage[]) => renderNative(page.map(row => byId.get(row.id)!), true) }
  const window = new SourceHistoryWindow(agent, {} as HapiTransport, undefined, async () => ({ entries: [
    { messageId: 'native:thread:turn-a:prompt:user', at: 1000, seq: 1, createdAt: 1, label: 'first turn' },
    // A later invoked/steering user item is the first available directory label
    // for turn-b. Its earlier assistant still belongs to turn-b, never turn-a.
    { messageId: 'native:thread:turn-b:prompt:user', at: 2000, seq: 30, createdAt: 30, label: 'second turn' },
  ], page: { epoch: 1, hasMore: false, beforeCursor: null, complete: true } }))
  const chat = officialChat()
  try {
    const page = route === 'before'
      ? await window.windowBefore({ at: 2000, seq: 30 }, 3_000_000_000, async () => ({
        messages: rows, hasMore: true, next: { at: 1000, seq: 10 }, epoch: 1, reset: false }))
      : await window.windowAt(second.rowId, 2, 3_000_000_000, async () => ({ messages: rows,
        page: { epoch: 1, reset: false, beforeCursor: { at: 1000, seq: 10 }, afterCursor: { at: 2000, seq: 20 },
          hasMoreBefore: true, hasMoreAfter: true } }))
    assert.equal(page.frames.length, rendered.events.length, 'identity projection must not drop or invent lifecycle events')
    const store = new SourceWindowStore()
    store.apply({ kind: 'replace', frames: page.frames })
    assert.doesNotThrow(() => {
      chat.assembler.replaceWindow(store.entries, true)
      chat.assembler.activateTarget('chat')
      chat.assembler.flush()
    }, 'distinct source turns remain separate in the official assembler')
    const turns = (type: string) => store.entries.filter(row => row.event.type === type)
      .map(row => (row.event.data as { turn: number }).turn)
    const bodies = turns('assistant/message')
    assert.notEqual(bodies[0], bodies[1])
    assert.deepEqual(turns('turn/end'), [bodies[0]])
    assert.deepEqual(turns('turn/start'), [bodies[1]], 'the clipped first turn keeps its absent start')
    assert.deepEqual(store.entries.filter(row => String(row.event.type) === 'plugin:hapi-dsh/native-item')
      .map(row => (row.event.data as { displayTurn: number }).displayTurn), bodies)

  } finally { window.dispose(); await chat.close() }
})
function nativeMetadata(page: RenderedHistoryPage) {
  return page.events.filter(row => String(row.type) === 'plugin:hapi-dsh/native-item')
    .map(row => row.data as { nativeStepId?: string; displayStep: number; sourceMessageId?: string })
}

test('native step identity is stable across independent pages and distinguishes reasoning from the final item', () => {
  const reasoning = assistant('same-item', 100, true), final = assistant('same-item', 101)
  const combined = renderNative([reasoning, final]), detached = renderNative([final])
  const both = nativeMetadata(combined), alone = nativeMetadata(detached)
  assert.ok(both[0]!.nativeStepId)
  assert.notEqual(both[0]!.nativeStepId, both[1]!.nativeStepId)
  assert.equal(both[1]!.nativeStepId, alone[0]!.nativeStepId)
  assert.notEqual(both[1]!.displayStep, alone[0]!.displayStep, 'local ordinals differ even though the source step is identical')
  assert.deepEqual(combined.stepAnchors?.get(both[1]!.nativeStepId!), { turn: 1, step: 2 })
})

test('native call and result split across pages retain one stable step and tool identity', () => {
  for (const itemId of ['tool-item', undefined]) {
    const execution = { threadId: 'thread', turnId: 'same-turn', ...(itemId === undefined ? {} : { itemId }) }
    const call: NativeRow = { kind: 'tool-call', key: 'call-row', rowId: 'call-row', localId: null,
      createdAt: 100, fingerprint: 'call-row', execution, callId: 'call', name: 'test', input: {} }
    const result: NativeRow = { kind: 'tool-result', key: 'result-row', rowId: 'result-row', localId: null,
      createdAt: 101, fingerprint: 'result-row', execution, callId: 'call', output: 'done', isError: false }
    const first = renderNative([call]), second = renderNative([result])
    assert.equal(nativeMetadata(first)[0]!.nativeStepId, nativeMetadata(second)[0]!.nativeStepId)
    const toolCall = first.events.find(row => row.type === 'tool/call')!
    const toolResult = second.events.find(row => row.type === 'tool/result')!
    assert.equal((toolCall.data as { callId: string }).callId,
      (toolResult.data as { message: { toolCallId: string } }).message.toolCallId)
  }
})

test('one source window assigns different steps to different items and reuses them when pages overlap', async () => {
  const first = assistant('first', 101), second = assistant('second', 102)
  const byId = new Map([first, second].map(row => [row.rowId, row]))
  const sourceRow = (row: NativeRow): HapiMessage => ({ id: row.rowId, seq: row.seq!, localId: null,
    createdAt: row.createdAt, content: {} })
  const agent = {
    id: SessionId('hapi-codex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), binding: { hapiSessionId: 'source' },
    historyWindowAnchor: () => ({ epoch: 1, before: { at: 100, seq: 100 }, firstTurn: 10, hasOlder: true,
      oldest: { id: 'prompt', at: 100, seq: 100 } }),
    renderHistoryPage: async (rows: readonly HapiMessage[]) => renderNative(rows.map(row => byId.get(row.id)!)),
  }
  const window = new SourceHistoryWindow(agent, {} as HapiTransport, undefined, async () => ({
    entries: [{ messageId: 'prompt', at: 100, seq: 100, createdAt: 100, label: 'prompt' }],
    page: { epoch: 1, hasMore: false, beforeCursor: null },
  }))
  const read = async (row: NativeRow) => window.windowAt(row.rowId, 1, 3_000_000_000, async () => ({
    messages: [sourceRow(row)], page: { epoch: 1, reset: false, beforeCursor: { at: row.createdAt, seq: row.seq! },
      afterCursor: { at: row.createdAt, seq: row.seq! }, hasMoreBefore: true, hasMoreAfter: true },
  }))
  const a = await read(first), b = await read(second)
  const again = await read(first)
  const body = (page: typeof a) => page.frames.find(row => row.event.type === 'assistant/message')!
  assert.equal(body(a).turnKey, body(b).turnKey)
  assert.notEqual(body(a).stepKey, body(b).stepKey)
  assert.equal(body(a).stepKey, body(again).stepKey)
  const store = new SourceWindowStore()
  for (const page of [a, b, again]) store.apply({ kind: 'merge', frames: page.frames })
  const messages = store.entries.filter(row => row.event.type === 'assistant/message')
  assert.equal(messages.length, 2, 'overlap updates one canonical item')
  assert.notEqual((messages[0]!.event.data as { step: number }).step, (messages[1]!.event.data as { step: number }).step)

  window.dispose()
  assert.equal(window.mappingCount, 0)
})
