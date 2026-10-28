import type { HapiWireFixture } from './hapi-fixture.ts'
import type { HapiMessage } from '../../src/codex/contracts.ts'

/** Synthetic source snapshots travel over the actual SSE/projection/session path. */
export function beginUiLive(wire: HapiWireFixture, sessionId: string, mode: 'events' | 'indexed' = 'events') {
  const fixture = wire.require(sessionId), at = Date.now(), turnId = `accept-live-${at}`
  const threadId = fixture.session.metadata!.codexSessionId!, seq = fixture.rows.at(-1)!.seq! + 10
  const status = (active: boolean) => {
    const current = fixture.session.execution!
    fixture.session.execution = { ...current, sequence: current.sequence + 1, status: active ? 'active' : 'idle',
      turnId, startedAt: at, completedAt: active ? null : Date.now(), waitingOn: [] }
    fixture.session.executionVersion = (fixture.session.executionVersion ?? 0) + 1
    wire.emit({ type: 'session-updated', sessionId })
  }
  status(true)
  const emit = (row: HapiMessage) => wire.emit(mode === 'events' ? { type: 'message-received', sessionId, message: row }
    : { type: 'messages-invalidated', sessionId, reason: 'native-history' })
  const input: HapiMessage = { id: `${turnId}-input`, localId: `${turnId}-input`, seq, createdAt: at, invokedAt: at,
    content: { role: 'user', content: { type: 'text', text: `Acceptance live question ${at}` },
      meta: { nativeExecution: { threadId, turnId, itemId: 'input' } } } }
  const reply: HapiMessage = { id: `${turnId}-reply`, localId: null, seq: seq + 1, createdAt: at + 1, invokedAt: at + 1,
    content: {} }
  fixture.rows.push(input); emit(input)
  fixture.rows.push(reply)
  return {
    update(text: string) {
      reply.content = { role: 'agent', content: { type: 'codex', data: { type: 'message', id: reply.id,
        message: text, streamSnapshot: true, live: true, nativeExecution: { threadId, turnId, itemId: 'reply', phase: 'final_answer' } } } }
      emit(reply)
    },
    finish() {
      reply.localId = reply.id
      const content = reply.content as { content: { data: { live?: boolean } } }
      delete content.content.data.live
      emit(reply)
      const row: HapiMessage = { id: `${turnId}-done`, localId: null, seq: seq + 2, createdAt: at + 2,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'native-turn', nativeExecution: {
          threadId, turnId, turn: { status: 'completed', started: true, ended: true },
        } } } } }
      fixture.rows.push(row); emit(row)
      status(false)
    },
  }
}
