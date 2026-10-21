/** Real parser/projector with explicit HAPI source wire fixtures from production shapes. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { HapiMessage } from '../src/codex/contracts.ts'
import { parseObservedHistory, parseObservedMessage, type ObservedItem } from '../src/hapi-agent/parser.ts'
import { ObservedProjector } from '../src/hapi-agent/projector.ts'
import { ObservedScopeIndex } from '../src/hapi-agent/scopes.ts'

const THREAD = 'thread-fixture'
let cursor = 0
function row(content: unknown, overrides: Partial<HapiMessage> = {}): HapiMessage {
  cursor++
  return { id: `row-${cursor}`, localId: null, seq: cursor, createdAt: 1000 + cursor, invokedAt: 1000 + cursor, content, ...overrides }
}
function agentCodex(data: Record<string, unknown>, overrides: Partial<HapiMessage> = {}): HapiMessage {
  return row({ role: 'agent', content: { type: 'codex', data: { nativeExecution: { threadId: THREAD, turnId: 'turn-1' }, ...data } } }, overrides)
}
function noticeTexts(items: readonly ObservedItem[]): string[] {
  return items.flatMap(item => item.kind === 'notice' ? [item.notice.text] : [])
}
function project(items: readonly ObservedItem[]): Session {
  const projector = new ObservedProjector(Session.create(SessionId('parser-fixture')), {
    model: () => 'fixture-model', submittedMessage: () => undefined, content: () => undefined, stream: () => {},
  })
  projector.apply(items)
  return projector.session
}

test('source lifecycle/protocol rows never become transcript notices or raw JSON', () => {
  const rows: HapiMessage[] = [
    agentCodex({ type: 'message', message: 'Real answer', id: 'codex:thread:turn-1:answer:agent_message', streamSnapshot: true },
      { localId: 'codex:thread:turn-1:answer:agent_message' }),
    agentCodex({ type: 'native-turn', nativeExecution: { threadId: THREAD, turnId: 'turn-1', turn: { status: 'inProgress', started: true, ended: false } } }),
    agentCodex({ type: 'thread_goal_updated', threadId: THREAD, goal: { objective: 'Finish the native task', status: 'active', tokensUsed: 12 } }),
    agentCodex({ type: 'thread_goal_cleared', thread_id: THREAD }),
    agentCodex({ type: 'agent-run-update', agentId: 'child-thread', cardId: 'codex-agent:child-thread', status: 'completed' }),
    agentCodex({ type: 'token_count', info: { last: { inputTokens: 10, outputTokens: 2 } } }),
    agentCodex({ type: 'context_compacted', thread_id: THREAD }),
    agentCodex({ type: 'future-protocol-event', payload: { secret: 'protocol-detail' } }),
    row({ role: 'agent', content: { type: 'event', data: { type: 'future-session-event', payload: { detail: true } } } }),
  ]
  const scopes = new ObservedScopeIndex(); scopes.update(rows, true)
  const items = parseObservedHistory(rows, scopes)
  const texts = noticeTexts(items)
  // Protocol/lifecycle facts are not transcript content.
  for (const text of texts) assert.ok(!/[{}]/.test(text), `notice carries raw JSON: ${text}`)
  assert.ok(!texts.some(text => /native-turn|thread_goal|agent-run/.test(text)), `lifecycle type leaked: ${texts.join(' | ')}`)
  assert.deepEqual(texts.filter(text => text.startsWith('Unsupported source event:')).sort(),
    ['Unsupported source event: future-protocol-event', 'Unsupported source event: future-session-event'])
  assert.ok(texts.includes('The source context was compacted.'))
  const assistant = items.filter(item => item.kind === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0]?.kind === 'assistant' ? assistant[0].text : '', 'Real answer')
  const session = project(items)
  assert.equal(session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
})

test('a completed message row settles the provisional stream once instead of re-detected streaming', () => {
  const stable = 'codex:thread:turn-1:answer:agent_message'
  const provisional = row({ role: 'agent', content: { type: 'codex', data: { type: 'message', id: stable, message: 'Partial answer', streamSnapshot: true,
    nativeExecution: { threadId: THREAD, turnId: 'turn-1', itemId: 'answer' } } } })
  const final = row({ role: 'agent', content: { type: 'codex', data: { type: 'message', id: stable, message: 'Partial answer, now complete.', streamSnapshot: true,
    nativeExecution: { threadId: THREAD, turnId: 'turn-1', itemId: 'answer' } } } }, { localId: stable })
  const scopes = new ObservedScopeIndex(); scopes.update([provisional, final], true)
  const [live] = parseObservedMessage(provisional, scopes)
  const [settled] = parseObservedMessage(final, scopes)
  assert.equal(live?.kind === 'assistant' ? live.live : undefined, true)
  assert.equal(settled?.kind === 'assistant' ? settled.live : undefined, false)
  const projector = new ObservedProjector(Session.create(SessionId('stream-fixture')), {
    model: () => 'fixture-model', submittedMessage: () => undefined, content: () => undefined, stream: () => {},
  })
  projector.apply([live!, settled!])
  const messages = projector.session.snapshotEvents().filter(event => event.type === 'assistant/message')
  assert.equal(messages.length, 1)
  const content = messages[0]?.type === 'assistant/message' ? messages[0].data.message.content : []
  assert.deepEqual(content, [{ type: 'text', text: 'Partial answer, now complete.' }])
  // A late provisional snapshot cannot reopen the committed answer.
  projector.apply([parseObservedMessage(provisional, scopes)[0]!])
  assert.equal(projector.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
})

test('a rewritten final message discards the divergent provisional stream without a phantom step', () => {
  const stable = 'codex:thread:turn-1:answer:agent_message'
  const provisional = row({ role: 'agent', content: { type: 'codex', data: { type: 'message', id: stable,
    message: 'Rough draft that the source rewrote', streamSnapshot: true,
    nativeExecution: { threadId: THREAD, turnId: 'turn-1', itemId: 'answer' } } } })
  const final = row({ role: 'agent', content: { type: 'codex', data: { type: 'message', id: stable,
    message: 'Final corrected answer.', streamSnapshot: true,
    nativeExecution: { threadId: THREAD, turnId: 'turn-1', itemId: 'answer' } } } }, { localId: stable })
  const scopes = new ObservedScopeIndex(); scopes.update([provisional, final], true)
  const projector = new ObservedProjector(Session.create(SessionId('correction-fixture')), {
    model: () => 'fixture-model', submittedMessage: () => undefined, content: () => undefined, stream: () => {},
  })
  projector.apply([parseObservedMessage(provisional, scopes)[0]!, parseObservedMessage(final, scopes)[0]!])
  const events = projector.session.snapshotEvents()
  const messages = events.filter(event => event.type === 'assistant/message')
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0]?.type === 'assistant/message' ? messages[0].data.message.content : [], [{ type: 'text', text: 'Final corrected answer.' }])
  // The stale provisional text must not survive in the committed session log.
  assert.ok(!JSON.stringify(events).includes('Rough draft'))
  // The corrected message reuses the abandoned attempt's step.
  assert.equal(events.filter(event => event.type === 'step/start').length, 1)
  assert.equal(events.filter(event => event.type === 'step/end').length, 1)
})
