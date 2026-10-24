/** Real pinned ConversationNodeAssembler; native source rows are an explicit protocol fixture. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Session, SessionId, pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import { NativeProjector } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'

const require = createRequire(import.meta.url)

// This crosses Host and Client runtime faces deliberately. Keep the consumed
// public contract structural so ClientContext's declaration merges cannot
// change the Host program's remote-access service types.
interface Timeline {
  turns: ReadonlyMap<number, { status: string; steps: ReadonlyArray<{ step: number; status: string }> }>
}
interface TimelineView {
  target: string
  create(): {
    empty: Timeline
    replace(input: { timeline: Timeline }): Timeline
    apply(input: { timeline: Timeline }): Timeline
  }
}
interface AssemblerConstructor {
  new (events: { entries(): []; fallbackEntry(): undefined }, views: { entries(): TimelineView[] }): {
    replaceWindow(entries: Array<{ type: 'event'; event: SessionEvent }>, hasMore: boolean): unknown
    activateTarget(target: string): unknown
    snapshot(target: string): unknown
  }
}

/**
 * The published client is an official factory bundle, not a Node ESM entry.
 * Register and evaluate its unchanged bytes in an isolated registration target.
 * The timeline-only view never invokes browser rendering or snapshot stores;
 * throw if either unused platform seat is touched so no substitute implements
 * any behavior under test. All other dependencies are the actual packages.
 */
function officialAssembler(): AssemblerConstructor {
  const manifest = require('@deepseek-ai/dsh-client-ui-conversation/package.json') as { version: string }
  assert.equal(manifest.version, '0.2.1-rc.3')
  let registration: { id: string; factory: (resolve: (id: string) => unknown) => Record<string, unknown> } | undefined
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8')
  new Function('window', source)({ __ModuleLoader__: { load(value: typeof registration) { registration = value } } })
  assert.equal(registration?.id, '@deepseek-ai/dsh-client-ui-conversation')
  const unused = new Proxy({}, { get() { throw new Error('Timeline regression unexpectedly used a browser platform service') } })
  const exports = registration!.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' || id === '@deepseek-ai/dsh-client-store'
    ? unused : require(id))
  assert.equal(typeof exports.ConversationNodeAssembler, 'function')
  return exports.ConversationNodeAssembler as AssemblerConstructor
}

test('seed metadata cannot invent a late official Step 0 that hides the native final answer', () => {
  const id = SessionId('native-conversation-history-fixture')
  const projector = new NativeProjector(Session.create(id), {
    model: () => 'fixture-model', provider: () => 'fixture-provider', submittedMessage: () => undefined, stream: () => {},
  })
  const rows: NativeRow[] = [
    { key: 'user', rowId: 'user', localId: 'user', createdAt: 1000, fingerprint: 'user',
      execution: { threadId: 'thread', turnId: 'turn', itemId: 'input' },
      kind: 'user', text: 'Original TUI input', invoked: true, mode: 'queue', parts: [] },
    { key: 'answer', rowId: 'answer', localId: 'answer', createdAt: 1100, fingerprint: 'answer',
      execution: { threadId: 'thread', turnId: 'turn', itemId: 'answer' },
      kind: 'assistant', text: 'The completed native answer stays visible.', reasoning: false, final: true },
    { key: 'terminal', rowId: 'terminal', localId: 'terminal', createdAt: 1200, fingerprint: 'terminal', kind: 'turn',
      execution: { threadId: 'thread', turnId: 'turn', turn: { status: 'completed', started: true, ended: true } } },
  ]
  projector.beginHistorySeed()
  projector.apply(rows)
  const session = Session.create(id, projector.historySeed())
  projector.finishHistorySeed(session)
  const events = session.snapshotEvents()
  const metadata = events.map(pluginRecordOf).filter((record): record is NonNullable<typeof record> => record?.type === 'plugin:hapi-dsh/native-item')
  assert.equal(metadata.length, 2)
  const coordinates = metadata.map(record => {
    assert.ok(typeof record.data === 'object' && record.data !== null)
    assert.ok(!('turn' in record.data) && !('step' in record.data))
    assert.ok('displayTurn' in record.data && 'displayStep' in record.data)
    return [record.data.displayTurn, record.data.displayStep]
  })
  assert.deepEqual(coordinates, [[1, 0], [1, 1]])
  const Assembler = officialAssembler()
  const view: TimelineView = {
    target: 'timeline-fixture',
    create: () => ({ empty: { turns: new Map() }, replace: input => input.timeline, apply: input => input.timeline }),
  }
  const assembler = new Assembler({ entries: () => [], fallbackEntry: () => undefined }, { entries: () => [view] })
  assembler.replaceWindow(events.map(event => ({ type: 'event', event })), false)
  assembler.activateTarget('timeline-fixture')
  const timeline = assembler.snapshot('timeline-fixture') as Timeline
  const turn = timeline.turns.get(1)
  assert.ok(turn)
  assert.equal(turn.status, 'closed')
  assert.deepEqual(turn.steps.map(step => step.step), [1])
  const lastStep = turn.steps.at(-1)!
  const answer = events.find(event => event.type === 'assistant/message')
  assert.ok(answer?.type === 'assistant/message')
  // Official Chat's latestAnswer() only examines this latest Step. A phantom
  // Step 0 after the terminal boundary used to make its final answer null.
  assert.equal(lastStep.step, answer.data.step)
  assert.equal(lastStep.status, 'closed')
})
