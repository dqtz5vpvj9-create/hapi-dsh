import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { nativeOwnerExecutionState } from '../scripts/migrations/hapi-offline/dsh-native-state.ts'

const events = (...rows: Array<{ type: string; data: unknown }>): SessionEvent[] => rows.map((row, seq) => ({ ...row, seq, time: seq + 1 })) as SessionEvent[]
const goal = (operation: 'create' | 'pause', phase: 'active' | 'paused', revision: number) => ({ type: 'goal/change', data: { kind: 'goal/change', version: 1, operation,
    goal: { id: 'original-goal', revision, objective: 'Original task', phase, maxGoalRounds: 3 }, createdAt: 1, updatedAt: revision, roundsStarted: 0 } })

test('original native turns and durable Goal state distinguish quiescence from an idle gap', () => {
    assert.equal(nativeOwnerExecutionState(events({ type: 'turn/start', data: { turn: 1 } })).idle, false)
    const closed = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }]
    assert.equal(nativeOwnerExecutionState(events(...closed)).idle, true)
    assert.equal(nativeOwnerExecutionState(events(goal('create', 'active', 1), ...closed)).idle, false)
    assert.equal(nativeOwnerExecutionState(events(goal('create', 'active', 1), ...closed, goal('pause', 'paused', 2))).idle, true)
    const queued = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'accepted-original-input' }] } }
    assert.equal(nativeOwnerExecutionState(events(queued, ...closed)).idle, false)
    assert.equal(nativeOwnerExecutionState(events(queued, ...closed, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })).idle, true)
})

test('an external catalog entry is historical only after its exact typed settlement; text and another source do not settle it', () => {
    const catalog = { type: 'subagent/catalog', data: { version: 2, childId: 'original-external-child', mode: 'external' } }
    const namedText = { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'original-external-child completed' }] } }
    const other = { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'another-child' } } }
    assert.equal(nativeOwnerExecutionState(events(catalog, namedText, other)).idle, false)
    assert.equal(nativeOwnerExecutionState(events(catalog, namedText, other, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'original-external-child' } } })).idle, true)
})
