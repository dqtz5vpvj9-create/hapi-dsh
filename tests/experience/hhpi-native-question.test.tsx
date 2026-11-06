/** Real question component; the source operation is a controlled boundary. */
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SourceNativeQuestion } from '../../src/client/remote-native-question.tsx'
import type { SourceApproval, SourceOperation, SourceReceipt } from '../../src/remote/protocol.ts'
const request: SourceApproval = { id: 'native-question', method: 'item/tool/requestUserInput', turnId: 'turn', itemId: 'item', params: { questions: [{ id: 'choice', header: 'Choice', question: 'Which option?', options: [{ label: 'First', description: 'One' }, { label: 'Second', description: 'Two' }] }] } }
test('human answers retain native question IDs and cannot be submitted twice while pending', async () => {
  const pending = Promise.withResolvers<SourceReceipt>()
  const session = { sessionId: 'hhpi:a:b:codex:thread', operate: vi.fn((_request: SourceOperation) => pending.promise) }
  render(<SourceNativeQuestion session={session} request={request} zh={false}/>)
  await userEvent.click(screen.getByRole('radio', { name: /Second/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }))
  expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
  await waitFor(() => expect(session.operate).toHaveBeenCalledTimes(1))
  expect(session.operate.mock.calls[0]![0]).toMatchObject({ sessionId: session.sessionId, requestId: request.id, response: { answers: { choice: { answers: ['Second'] } } } })
  await act(async () => pending.resolve({ sessionId: session.sessionId, operationId: 'answer', status: 'indeterminate', message: 'Waiting for native confirmation' }))
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for native confirmation')
  expect(session.operate).toHaveBeenCalledTimes(1)
})
