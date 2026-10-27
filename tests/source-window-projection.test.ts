import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { HapiMessage, HapiTransport } from '../src/codex/contracts.ts'
import { SOURCE_WINDOW_STEP_BASE, SourceHistoryWindow, type RenderedHistoryPage } from '../src/codex/source-window.ts'
import { NativeProjector } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'
import { officialChat } from './official-conversation-fixture.ts'

test('direct source windows translate every local seq reference with the returned event coordinates', async () => {
  const row: HapiMessage = { id: 'source-row', seq: 1, localId: null, createdAt: 1000, content: {} }
  const events = [
    { type: 'user/message', seq: 11, time: 1000, data: { id: 'user', content: [] } },
    { type: 'plugin:hapi-dsh/native-item', seq: 17, time: 1000, data: { surfaceSeq: 11, displayTurn: 1 },
      sourceEventSeqs: [11, 2], surfaceOp: { kind: 'replace', startSeq: 11, endSeq: 11 } },
  ] as unknown as SessionEvent[]
  const rendered: RenderedHistoryPage = { events, lastTurn: 1,
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
  const body = result.records[0]!.event, annotation = result.records[1]!.event
  assert.equal(body.seq, 3_000_000_000)
  assert.equal(annotation.seq, 3_000_000_001)
  assert.equal((annotation.data as { surfaceSeq: number }).surfaceSeq, body.seq)
  assert.deepEqual(annotation.sourceEventSeqs, [body.seq, 2])
  assert.deepEqual(annotation.surfaceOp, { kind: 'replace', startSeq: body.seq, endSeq: body.seq })
  assert.equal(window.sourceMessageAtVirtualSeq(body.seq), row.id)
  assert.equal(window.virtualSeqForSourceMessage(row.id), body.seq)
  const newer = await window.windowAt(row.id, 1, 3_001_000_000, async () => ({ messages: [row],
    page: { epoch: 1, reset: false, beforeCursor: { at: 1000, seq: 1 }, afterCursor: { at: 1000, seq: 1 },
      hasMoreBefore: false, hasMoreAfter: false } }))
  assert.equal(window.virtualSeqForSourceMessage(row.id), newer.records[0]!.event.seq,
    'source lookup must use the latest returned virtual coordinates')
})

function assistant(item: string, at: number, reasoning = false): NativeRow {
  const key = `${item}:${reasoning ? 'reasoning' : 'answer'}`
  return { kind: 'assistant', key, rowId: key, localId: key, seq: at, createdAt: at, fingerprint: key,
    text: key, final: true, reasoning, execution: { threadId: 'thread', turnId: 'same-turn', itemId: item } }
}
let nextSession = 0
function renderNative(rows: readonly NativeRow[], partial = false): RenderedHistoryPage {
  const projector = new NativeProjector(Session.create(SessionId(`native-step-fixture-${++nextSession}`)), {
    model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined, stream: () => {},
  })
  if (partial) projector.setSuppressFirstTurnStart()
  projector.beginHistorySeed()
  projector.apply(rows)
  return { events: projector.historySeed(), lastTurn: projector.lastTurn, sources: projector.sourceSeqEntries(),
    rewinds: projector.rewindSeqEntries(), forks: projector.forkBoundaryEntries(),
    turnAnchors: projector.turnAnchorEntries(), stepAnchors: projector.stepAnchorEntries() }
}

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
    assert.equal(page.records.length, rendered.events.length, 'identity mapping must not drop or invent lifecycle events')
    assert.doesNotThrow(() => {
      chat.assembler.replaceWindow(page.records, true)
      chat.assembler.activateTarget('chat')
      chat.assembler.flush()
    }, 'distinct native turns must not collapse into one Context with an update before its later start')
    const turns = (type: string) => page.records.filter(row => row.event.type === type)
      .map(row => (row.event.data as { turn: number }).turn)
    assert.deepEqual(turns('assistant/message'), [100, 101])
    assert.deepEqual(turns('turn/end'), [100])
    assert.deepEqual(turns('turn/start'), [101], 'the clipped first turn keeps its absent start')
    assert.deepEqual(page.records.filter(row => String(row.event.type) === 'plugin:hapi-dsh/native-item')
      .map(row => (row.event.data as { displayTurn: number }).displayTurn), [100, 101])
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
  assert.equal(window.virtualSeqForSourceMessage(first.rowId), undefined, 'reused window coordinates cannot keep a stale inverse mapping')
  const again = await read(first)
  const body = (page: typeof a) => page.records.find(row => row.event.type === 'assistant/message')!.event.data as { turn: number; step: number }
  assert.equal(body(a).turn, 10)
  assert.equal(body(b).turn, 10)
  assert.ok(body(a).step > SOURCE_WINDOW_STEP_BASE)
  assert.notEqual(body(a).step, body(b).step)
  assert.equal(body(a).step, body(again).step)
  for (const page of [a, b, again]) {
    const expected = body(page).step
    for (const row of page.records) {
      const data = row.event.data as { step?: number; displayStep?: number }
      if (data.step !== undefined) assert.equal(data.step, expected)
      if (data.displayStep !== undefined) assert.equal(data.displayStep, expected)
    }
  }
  window.dispose()
  assert.equal(window.mappingCount, 0)
})
