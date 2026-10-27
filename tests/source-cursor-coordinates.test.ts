/** Synthetic indexed-native wire rows projected through the pinned public Session. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { HapiMessage, HapiTransport } from '../src/codex/contracts.ts'
import { parseNativeRow, type NativeBinding } from '../src/codex/native.ts'
import { NativeProjector, NativeHistoryChangedError } from '../src/codex/projector.ts'
import { SourceHistoryWindow, sourcePosition, type RenderedHistoryPage } from '../src/codex/source-window.ts'
import { parseObservedMessage } from '../src/hapi-agent/parser.ts'
import { ObservedProjector } from '../src/hapi-agent/projector.ts'

const binding: NativeBinding = { hubId: 'cursor-fixture', hapiSessionId: 'source', threadId: 'thread', home: null, homeId: null, machineId: null }
const toolRow: HapiMessage = {
  id: 'indexed-tool-row', localId: 'stable-tool', seq: 431_580_001, createdAt: 9000, invokedAt: 1000,
  content: { role: 'agent', meta: { nativeExecution: { threadId: 'thread', turnId: 'turn', itemId: 'item',
    turn: { status: 'completed', started: true, ended: true } } },
  content: { type: 'codex', data: { id: 'stable-tool', type: 'tool-call', callId: 'call', name: 'Bash', input: { command: 'fixture' } } } },
}
type Kind = 'native' | 'observed'
let nextId = 0
function projection(kind: Kind, rows: readonly HapiMessage[], seed: boolean) {
  const session = Session.create(SessionId(`cursor-coordinates-${++nextId}`))
  const options = { model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined,
    content: () => undefined, stream: () => {} }
  const projector = kind === 'native' ? new NativeProjector(session, options) : new ObservedProjector(session, options)
  if (seed) projector.beginHistorySeed()
  if (projector instanceof NativeProjector) projector.apply(rows.map(row => {
    const parsed = parseNativeRow(row, binding); assert.ok(parsed); return parsed
  }))
  else projector.apply(rows.flatMap(row => parseObservedMessage(row)))
  return { projector, events: seed ? projector.historySeed() : session.snapshotEvents() }
}
function annotation(events: readonly SessionEvent[], kind: Kind) {
  const type = kind === 'native' ? 'plugin:hapi-dsh/native-item' : 'plugin:hapi-dsh-observed/item'
  const event = events.find(event => event.type === type)
  assert.ok(event)
  return event.data as { sourceMessageId?: string; sourceRowId?: string; sourceAt: number; sourceSeq: number; surfaceSeq: number }
}

for (const kind of ['native', 'observed'] as const) {
  for (const seed of [false, true]) test(`${kind} ${seed ? 'seed' : 'live'} tool annotation uses indexed source coordinates and keeps item time`, () => {
    const { projector, events } = projection(kind, [toolRow], seed)
    const data = annotation(events, kind), expected = sourcePosition(toolRow)
    assert.equal(data.sourceMessageId ?? data.sourceRowId, toolRow.id)
    assert.deepEqual({ at: data.sourceAt, seq: data.sourceSeq }, expected)
    const anchor = [...projector.turnAnchorEntries().values()][0]!
    assert.deepEqual({ id: anchor.id, at: anchor.at, seq: anchor.seq }, { id: toolRow.id, ...expected })
    assert.equal(events.find(event => event.seq === data.surfaceSeq)?.type, 'assistant/message')
    if (seed) assert.ok(events.every(event => event.time === toolRow.createdAt), 'display timestamps remain item timestamps')
  })

  test(`${kind} context source and projected annotation agree for the same indexed tool`, async () => {
    const render = async (rows: readonly HapiMessage[]): Promise<RenderedHistoryPage> => {
      const { projector, events } = projection(kind, rows, true)
      return { events, lastTurn: projector.lastTurn, sources: projector.sourceSeqEntries(), rewinds: projector.rewindSeqEntries(),
        forks: projector instanceof NativeProjector ? projector.forkBoundaryEntries() : new Map(),
        turnAnchors: projector.turnAnchorEntries(), stepAnchors: projector.stepAnchorEntries() }
    }
    const window = new SourceHistoryWindow({ id: SessionId('hapi-codex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      binding: { hapiSessionId: 'source' }, historyWindowAnchor: () => ({ epoch: 1, before: sourcePosition(toolRow), firstTurn: 1, hasOlder: true }),
      renderHistoryPage: render }, {} as HapiTransport)
    try {
      const result = await window.windowAt(toolRow.id, 1, 3_000_000_000, async () => ({ messages: [toolRow], page: {
        epoch: 1, reset: false, beforeCursor: sourcePosition(toolRow), afterCursor: sourcePosition(toolRow), hasMoreBefore: true, hasMoreAfter: false,
      } }))
      const data = annotation(result.records.map(row => row.event), kind)
      const record = result.records.find(row => row.event.seq === data.surfaceSeq)!
      assert.ok(record.source)
      assert.equal(record.source.messageId, toolRow.id)
      assert.deepEqual({ at: data.sourceAt, seq: data.sourceSeq }, { at: record.source.at, seq: record.source.seq })
    } finally { window.dispose() }
  })

  test(`${kind} absent invokedAt and seq use the same source-position fallbacks`, () => {
    const row = { ...toolRow, invokedAt: null, seq: null }
    const data = annotation(projection(kind, [row], true).events, kind)
    assert.deepEqual({ at: data.sourceAt, seq: data.sourceSeq }, sourcePosition(row))
  })

  test(`${kind} source cursor metadata does not change semantic tool content identity`, () => {
    const moved = { ...toolRow, invokedAt: 2000 }
    if (kind === 'native') {
      const before = parseNativeRow(toolRow, binding)!, after = parseNativeRow(moved, binding)!
      assert.notEqual(before.sourceAt, after.sourceAt)
      assert.equal(before.fingerprint, after.fingerprint)
    } else {
      const before = parseObservedMessage(toolRow), after = parseObservedMessage(moved)
      assert.ok(before.some(item => item.kind === 'end'), 'fixture includes the synthesized native completion')
      assert.ok(before.every(item => item.sourceAt === 1000))
      assert.ok(after.every(item => item.sourceAt === 2000))
      assert.deepEqual(before.map(item => item.fingerprint), after.map(item => item.fingerprint))
    }
  })
}

test('native late-source classification follows the indexed cursor even when item clocks disagree', () => {
  const first = parseNativeRow(toolRow, binding)!
  const { projector } = projection('native', [toolRow], false)
  assert.ok(projector instanceof NativeProjector)
  const delayed = { ...first, createdAt: 10_000, sourceAt: 900, fingerprint: 'older payload' }
  assert.doesNotThrow(() => projector.apply([delayed], true), 'an older indexed payload cannot replace a committed live item')
  const correction = { ...first, createdAt: 8000, sourceAt: 2000, fingerprint: 'newer correction' }
  assert.throws(() => projector.apply([correction], true), NativeHistoryChangedError,
    'a newer source correction still requires structural recovery even if its item timestamp is earlier')
})
