import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claimNativeAction, nativeActionKey, settleNativeAction, type NativeActionRecord } from '../src/client/remote-operation-contracts.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'

const sessionId = sourceSessionId({ machineId: 'm', sourceId: 's', engine: 'codex', nativeId: 'parent' })
const action: NativeActionRecord = { version: 1, sessionId, intent: 'fork', kind: 'fork',
  request: { sourceId: 's', method: 'thread/fork', params: { threadId: 'parent' }, operationId: 'original' }, phase: 'prepared', createdAt: 1, updatedAt: 1 }

test('claiming a native action once prevents unknown outcomes from becoming another dispatch', () => {
  const claimed = claimNativeAction(action, 2)!
  assert.equal(claimNativeAction(claimed, 3), undefined)
  const unknown = settleNativeAction(claimed, { status: 'indeterminate', message: 'Awaiting the original result' }, 4)
  assert.equal(claimNativeAction(unknown, 5), undefined)
  assert.equal(unknown.request.operationId, 'original')
  const absent = settleNativeAction(unknown, { status: 'rejected', message: 'No receipt exists' }, 6)
  assert.equal(claimNativeAction(absent, 7), undefined)
  assert.notEqual(nativeActionKey(sessionId, 'fork'), nativeActionKey(sessionId + '-other', 'fork'))
})

test('only an exact fork result associates its new target and does not persist unrelated source data', () => {
  const result = settleNativeAction(action, { status: 'accepted', message: 'Accepted', result: { thread: { id: 'child', model: 'test' }, token: 'not-stored' } }, 2)
  assert.deepEqual(result.outcome, { status: 'accepted', message: 'Accepted', targetNativeId: 'child' })
  assert.equal(settleNativeAction(action, { status: 'accepted', message: 'Accepted', resultUnavailable: true }, 2).outcome?.targetNativeId, undefined)
  assert.throws(() => claimNativeAction({ ...action, request: { ...action.request, params: { threadId: 'replacement' } } }, 2))
})
