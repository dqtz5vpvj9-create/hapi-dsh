/** Protocol snapshots projected through the real pinned DSH Session and production projectors. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { HapiMessage } from '../src/codex/contracts.js'
import { parseNativeRow, type NativeBinding } from '../src/codex/native.js'
import { NativeProjector } from '../src/codex/projector.js'
import { ObservedProjector } from '../src/hapi-agent/projector.js'
import { parseObservedMessage } from '../src/hapi-agent/parser.js'

const binding: NativeBinding = { hubId: 'stream-fixture', hapiSessionId: 'source', threadId: 'thread', home: null, homeId: null, machineId: null }
function snapshot(text: string, final = false): HapiMessage {
  return { id: `row:${text}`, localId: final ? 'same-stream' : null, seq: 2, createdAt: 2000,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'same-stream', message: text,
      streamSnapshot: true, nativeExecution: { threadId: binding.threadId, turnId: 'turn', itemId: 'same-item' } } } } }
}

for (const kind of ['native', 'observed'] as const) {
  test(`${kind} cumulative stream ignores delayed provisional prefixes after a longer snapshot, preserving source corrections`, () => {
    const session = Session.create(SessionId(`stream-order-${kind}`)), frames: AssistantStreamFrame[] = []
    const native = new NativeProjector(session, { model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined,
      stream: frame => frames.push(frame) })
    const observed = new ObservedProjector(session, { model: () => 'fixture', submittedMessage: () => undefined, content: () => undefined,
      stream: frame => frames.push(frame) })
    const apply = (message: HapiMessage) => {
      if (kind === 'native') { const row = parseNativeRow(message, binding); assert.ok(row); native.apply([row]) }
      else observed.apply(parseObservedMessage(message))
    }
    apply(snapshot('Hello from a newer snapshot'))
    const seeded = frames.length
    apply({ ...snapshot('Hel'), seq: 1 })
    apply(snapshot('Hello from a newer snapshot'))
    assert.equal(frames.length, seeded, 'neither the older prefix nor repeated snapshot abandons/restarts the stream')
    apply(snapshot('A source correction'))
    assert.equal(frames.filter(frame => frame.type === 'end' && frame.outcome.kind === 'abandoned').length, 1)
    assert.equal(frames.filter(frame => frame.type === 'start').length, 2, 'a non-prefix correction still starts its corrected attempt')
    apply(snapshot('Final authoritative correction', true))
    const answers = session.snapshotEvents().filter(event => event.type === 'assistant/message')
    assert.equal(answers.length, 1)
    assert.ok(answers[0]?.type === 'assistant/message')
    assert.deepEqual(answers[0].data.message.content, [{ type: 'text', text: 'Final authoritative correction' }])
  })
}
