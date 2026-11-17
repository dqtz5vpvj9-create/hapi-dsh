import assert from 'node:assert/strict'
import test from 'node:test'
import { automaticQuestion, NativeQuestionPresentation, nativeMessageIdentity } from '../src/client/native-question-presentation.ts'
import { questionItemId, sourceQuestionCallId } from '../src/shared/native-async-questions.ts'
import type { SourceApproval, SourceSession } from '../src/remote/protocol.ts'

const question = (turnId: string, itemId: string, index: number, revision: number): SourceApproval => ({
  id: questionItemId(itemId, index), itemId, turnId, method: 'request_user_input_async',
  params: { index, revision, question: { title: `${itemId}-${index}`, options: ['yes'] } },
})
const session = (pendingRequests: SourceApproval[], activeTurnId: string | null = null): SourceSession => ({
  id: 'hhpi:one:source:codex:thread', machineId: 'one', sourceId: 'source', nativeId: 'thread', engine: 'codex',
  title: 'session', cwd: '/', status: activeTurnId ? 'running' : 'idle', activeTurnId, updatedAt: 0,
  capabilities: { send: true, steer: true, cancel: true, approve: true, files: true }, pendingRequests,
})

test('only the latest native turn and newest question batch can open automatically', () => {
  const old = question('old-turn', 'old-item', 0, 10), one = question('new-turn', 'new-item', 0, 20)
  const two = question('new-turn', 'new-item', 1, 20), later = question('new-turn', 'later-item', 0, 30)
  assert.equal(automaticQuestion(session([old, one, two]), 'new-turn'), one)
  assert.equal(automaticQuestion(session([old, one, two, later]), 'new-turn'), later)
  assert.equal(automaticQuestion(session([old]), 'new-turn'), undefined)
  assert.equal(automaticQuestion(session([old, one], 'new-turn'), 'old-turn'), one)
  assert.equal(automaticQuestion(session([old]), undefined), undefined)
  assert.deepEqual(nativeMessageIdentity('codex:thread:new-turn:new-item', 'thread'), { turnId: 'new-turn', itemId: 'new-item' })
  assert.equal(nativeMessageIdentity('codex:another:new-turn:new-item', 'thread'), undefined)
  assert.equal(nativeMessageIdentity('antigravity:thread:turn:item', 'thread'), undefined)
  assert.equal(nativeMessageIdentity('codex:%broken:turn:item', 'thread'), undefined)
  assert.equal(nativeMessageIdentity(null, 'thread'), undefined)
})

test('closing is local, content scoped, persistent and does not uncover older siblings', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } as Storage
  const access = () => ({ scope: 'account', storage })
  const first = question('turn', 'item', 0, 10), second = question('turn', 'item', 1, 10)
  const state = session([first, second]), callId = sourceQuestionCallId(first)
  const head = { turnId: 'turn', lastUserSeq: 10, positions: new Map([['item', 20]]) }
  const presentation = new NativeQuestionPresentation(access)
  assert.equal(presentation.isVisible(state, head, callId), true)
  assert.equal(presentation.isVisible(state, { ...head, lastUserSeq: 21 }, callId), false, 'a later normal user message supersedes the prompt')
  assert.equal(presentation.isVisible(state, { ...head, positions: new Map() }, callId), false, 'unverified historical questions do not take the composer')
  presentation.dismiss(state, callId)
  assert.equal(presentation.isVisible(state, head, callId), false)
  assert.equal(presentation.isVisible(state, head, sourceQuestionCallId(second)), false)
  assert.equal(new NativeQuestionPresentation(access).isVisible(state, head, callId), false)
  const revised = question('turn', 'item', 0, 11)
  assert.equal(presentation.isVisible(session([revised, second]), head, sourceQuestionCallId(revised)), false, 'an unchanged question cannot reopen on a native revision')
  const changed = { ...revised, params: { ...revised.params, question: { title: 'A new question', options: ['yes'] } } }
  assert.equal(presentation.isVisible(session([changed, second]), head, sourceQuestionCallId(changed)), true)
  assert.equal(presentation.isVisible(session([second]), head, sourceQuestionCallId(second)), true)
  assert.equal(state.pendingRequests.length, 2, 'closing does not answer or change source state')
})
