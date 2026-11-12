/** Real question component; the source operation is a controlled boundary. */
import { act, render, screen, waitFor, within } from '@testing-library/react'
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

test('free answers keep exact question IDs and an old card cannot answer a changed source request', async () => {
  const user = userEvent.setup(), pending: SourceApproval[] = [{ ...request, params: { questions: [{ id: 'free-id', header: 'Reply', question: 'Explain your choice', isOther: true, options: [{ label: 'Yes' }] }] } }]
  const session = { sessionId: 'hhpi:a:b:codex:thread', operate: vi.fn(async (_value: SourceOperation) => ({ sessionId: 'hhpi:a:b:codex:thread', operationId: 'same', status: 'accepted' as const, message: 'resolved' })), metadata: { getSnapshot: () => ({ pendingRequests: pending }) } }
  const view = render(<SourceNativeQuestion session={session} request={pending[0]!} zh={false}/> )
  await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'My own detailed answer')
  pending.length = 0
  await user.click(screen.getByRole('button', { name: 'Submit answers' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('resolved or changed')
  expect(session.operate).not.toHaveBeenCalled()
  const next = { ...request, id: 'new-question', params: { questions: [{ id: 'free-id', header: 'Reply', question: 'New question', isOther: true }] } }
  pending.push(next)
  view.rerender(<SourceNativeQuestion session={session} request={next} zh={false}/> )
  expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('')
  await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'Fresh answer')
  await user.click(screen.getByRole('button', { name: 'Submit answers' }))
  await waitFor(() => expect(session.operate).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'new-question', response: { answers: { 'free-id': { answers: ['Fresh answer'] } } } })))
})

test('an uncertain structured answer checks its original payload and never offers a replacement answer', async () => {
  const user = userEvent.setup(), operate = vi.fn(async (_value: SourceOperation) => ({ sessionId: 'hhpi:a:b:codex:thread', operationId: 'original', status: 'indeterminate' as const, message: 'Awaiting original answer' }))
  render(<SourceNativeQuestion session={{ sessionId: 'hhpi:a:b:codex:thread', operate }} request={request} zh={false}/> )
  await user.click(screen.getByRole('radio', { name: /Second/ }))
  await user.click(screen.getByRole('button', { name: 'Submit answers' }))
  await screen.findByText('Awaiting original answer')
  expect(screen.getByRole('radio', { name: /First/ })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Check original answer' }))
  await waitFor(() => expect(operate).toHaveBeenCalledTimes(2))
  expect(operate.mock.calls[1]?.[0]).toEqual(operate.mock.calls[0]?.[0])
})

test('additional permissions show their actual scope and grant only the requested turn', async () => {
  const operate = vi.fn(async (_value: SourceOperation) => ({ sessionId: 'hhpi:a:b:codex:thread', operationId: 'permission', status: 'accepted' as const, message: 'resolved' }))
  const permissions = { network: { enabled: true }, fileSystem: { read: ['/workspace/input'], write: ['/workspace/output'] } }
  render(<SourceNativeQuestion session={{ sessionId: 'hhpi:a:b:codex:thread', operate }} request={{ ...request, method: 'item/permissions/requestApproval', params: { permissions, cwd: '/workspace', reason: 'Write the requested output' } }} zh={false}/> )
  expect(screen.getByText('Network access')).toBeVisible()
  expect(screen.getByText('Read: /workspace/input')).toBeVisible()
  expect(screen.getByText('Write: /workspace/output')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Allow for this turn' }))
  await waitFor(() => expect(operate).toHaveBeenCalledWith(expect.objectContaining({ response: { permissions, scope: 'turn' } })))
})

test('simultaneous native questions keep answers and request identities separate', async () => {
  const pending = Promise.withResolvers<SourceReceipt>()
  const session = { sessionId: 'hhpi:a:b:codex:thread', operate: vi.fn((_value: SourceOperation) => pending.promise) }
  const first = { ...request, id: 'first-request' }, second = { ...request, id: 'second-request', turnId: 'next-turn' }
  const view = render(<><SourceNativeQuestion session={session} request={first} zh={false}/><SourceNativeQuestion session={session} request={second} zh={false}/></>)
  const [a, b] = screen.getAllByRole('region', { name: 'Source question' })
  await userEvent.click(within(a!).getByRole('radio', { name: /First/ }))
  await userEvent.click(within(b!).getByRole('radio', { name: /Second/ }))
  await userEvent.click(within(b!).getByRole('button', { name: 'Submit answers' }))
  await waitFor(() => expect(session.operate).toHaveBeenCalledWith(expect.objectContaining({ requestId: second.id, response: { answers: { choice: { answers: ['Second'] } } } })))
  expect(within(a!).getByRole('button', { name: 'Submit answers' })).toBeEnabled()
  expect(within(a!).getByRole('radio', { name: /First/ })).toBeChecked()
  view.unmount()
  await act(async () => pending.resolve({ sessionId: session.sessionId, operationId: 'second', status: 'accepted', message: 'resolved' }))
})

test('a replacement MCP form clears an old field even when the native request ID is unchanged', async () => {
  const session = { sessionId: 'hhpi:a:b:codex:thread', operate: vi.fn(async (_value: SourceOperation) => ({ sessionId: 'hhpi:a:b:codex:thread', operationId: 'form', status: 'accepted' as const, message: 'resolved' })) }
  const form = { ...request, method: 'mcpServer/elicitation/request', params: { mode: 'form', message: 'Service question', requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } } } } }
  const view = render(<SourceNativeQuestion session={session} request={form} zh={false}/> )
  await userEvent.type(screen.getByRole('textbox', { name: 'Answer' }), 'old answer')
  view.rerender(<SourceNativeQuestion session={session} request={{ ...form, params: { ...form.params, message: 'Replacement service question' } }} zh={false}/> )
  expect(screen.getByRole('textbox', { name: 'Answer' })).toHaveValue('')
  expect(session.operate).not.toHaveBeenCalled()
})
