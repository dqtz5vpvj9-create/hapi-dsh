import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { HapiMessage } from '../../src/codex/contracts.js'
import { parseNativeRow, type NativeBinding } from '../../src/codex/native.js'
import { NativeProjector } from '../../src/codex/projector.js'
import { ObservedProjector } from '../../src/hapi-agent/projector.js'
import { parseObservedMessage } from '../../src/hapi-agent/parser.js'

export type ProjectorKind = 'native' | 'observed'
const binding: NativeBinding = { hubId: 'stream-retention', hapiSessionId: 'source', threadId: 'thread', home: null, homeId: null, machineId: null }

export function streamProjector(kind: ProjectorKind, stream: (frame: AssistantStreamFrame) => void = () => {}) {
  const session = Session.create(SessionId(`stream-retention-${kind}`))
  const projector = kind === 'native'
    ? new NativeProjector(session, { model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined, stream })
    : new ObservedProjector(session, { model: () => 'fixture', submittedMessage: () => undefined,
      content: item => item.kind === 'assistant' ? [{ type: item.reasoning ? 'reasoning' : 'text', text: item.text }] : undefined, stream })
  return { session, projector, apply(text: string, final = false, reasoning = false) {
    const message: HapiMessage = { id: 'stream-row', localId: final ? 'stream-item' : null, seq: 2, createdAt: 2000,
      content: { role: 'agent', content: { type: 'codex', data: { type: reasoning ? 'reasoning' : 'message', id: 'stream-item', message: text,
        streamSnapshot: true, nativeExecution: { threadId: binding.threadId, turnId: 'turn', itemId: 'stream-item' } } } } }
    if (projector instanceof NativeProjector) {
      const row = parseNativeRow(message, binding)
      assert.ok(row)
      projector.apply([row])
    } else projector.apply(parseObservedMessage(message))
  } }
}
