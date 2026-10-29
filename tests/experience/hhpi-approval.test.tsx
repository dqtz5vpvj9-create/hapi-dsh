/** Production approval UI. Only the remote operate call is controlled by the test. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SourceApproval, SourceOperation, SourceReceipt } from '../../src/remote/protocol.ts'
import { SourceApprovalControl } from '../../src/client/remote-controls.tsx'

const request: SourceApproval = { id: 'same-native-request', method: 'command/approval', turnId: 'turn', itemId: 'item', params: { command: 'synthetic operation' } }
function owner(id: string) {
  const pending = Promise.withResolvers<SourceReceipt>()
  const session = { sessionId: id as SessionId, operate: vi.fn((_request: SourceOperation) => pending.promise) }
  const done = (message: string): SourceReceipt => ({ sessionId: id, operationId: `approval:${request.id}`, status: 'accepted', message })
  return { session, pending, done }
}

test('repeated approval clicks submit once and remain disabled after source acceptance', async () => {
  const a = owner('hhpi:machine-a:source:codex:thread')
  render(<SourceApprovalControl session={a.session} request={request} zh={false}/> )
  const allow = screen.getByRole('button', { name: 'Allow' })
  fireEvent.click(allow); fireEvent.click(allow)
  expect(a.session.operate).toHaveBeenCalledTimes(1)
  expect(allow).toBeDisabled()
  await act(async () => { a.pending.resolve(a.done('Accepted A')); await a.pending.promise })
  expect(screen.getByRole('status')).toHaveTextContent('Accepted A')
  expect(allow).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
})

test('same request ID on another source resets busy state and ignores the first source late receipt', async () => {
  const a = owner('hhpi:machine-a:source:codex:thread'), b = owner('hhpi:machine-b:source:codex:thread')
  const view = render(<SourceApprovalControl session={a.session} request={request} zh={false}/>)
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  view.rerender(<SourceApprovalControl session={b.session} request={request} zh={false}/>)
  expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
  expect(b.session.operate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: b.session.sessionId, decision: 'decline' }))
  await act(async () => { a.pending.resolve(a.done('Late A')); await a.pending.promise })
  expect(screen.queryByText('Late A')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  await act(async () => { b.pending.resolve(b.done('Accepted B')); await b.pending.promise })
  expect(screen.getByRole('status')).toHaveTextContent('Accepted B')
})

test('a replaced Session face of the same native identity does not inherit in-flight state', async () => {
  const a = owner('hhpi:machine:source:codex:thread'), b = owner(a.session.sessionId)
  const view = render(<SourceApprovalControl session={a.session} request={request} zh={false}/>)
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  view.rerender(<SourceApprovalControl session={b.session} request={request} zh={false}/>)
  expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
  expect(b.session.operate).not.toHaveBeenCalled()
  await act(async () => { a.pending.resolve(a.done('Released owner')); await a.pending.promise })
  expect(screen.queryByText('Released owner')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  expect(b.session.operate).toHaveBeenCalledTimes(1)
})

test('an uncertain source answer remains visible and unmounting never resends', async () => {
  const a = owner('hhpi:machine:source:codex:thread')
  const view = render(<SourceApprovalControl session={a.session} request={request} zh={false}/>)
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await act(async () => { a.pending.resolve({ ...a.done('Outcome unknown; not retried'), status: 'indeterminate' }); await a.pending.promise })
  expect(screen.getByRole('alert')).toHaveTextContent('Outcome unknown; not retried')
  view.unmount()
  render(<SourceApprovalControl session={a.session} request={request} zh={false}/>)
  expect(a.session.operate).toHaveBeenCalledTimes(1)
})
