/** Production approval UI. Only the remote operate call is controlled by the test. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SourceApproval, SourceOperation, SourceReceipt } from '../../src/remote/protocol.ts'
import { SourceApprovalControl } from '../../src/client/remote-controls.tsx'

const request: SourceApproval = { id: 'same-native-request', method: 'item/commandExecution/requestApproval', turnId: 'turn', itemId: 'item', params: { command: 'synthetic operation' } }
function owner(id: string) {
  const pending = Promise.withResolvers<SourceReceipt>()
  const session = { sessionId: id as SessionId, operate: vi.fn((_request: SourceOperation) => pending.promise) }
  const done = (message: string): SourceReceipt => ({ sessionId: id, operationId: session.operate.mock.calls[0]?.[0].operationId ?? 'pending', status: 'accepted', message })
  return { session, pending, done }
}

test('repeated approval clicks submit once and remain disabled after source acceptance', async () => {
  const a = owner('hhpi:machine-a:source:codex:thread')
  render(<SourceApprovalControl session={a.session} request={request} zh={false}/> )
  const allow = screen.getByRole('button', { name: 'Allow' })
  fireEvent.click(allow); fireEvent.click(allow)
  await waitFor(() => expect(a.session.operate).toHaveBeenCalledTimes(1))
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
  await waitFor(() => expect(b.session.operate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: b.session.sessionId, decision: 'decline' })))
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
  await waitFor(() => expect(b.session.operate).toHaveBeenCalledTimes(1))
})

test('an uncertain source answer remains visible and unmounting never resends', async () => {
  const a = owner('hhpi:machine:source:codex:thread')
  const view = render(<SourceApprovalControl session={a.session} request={request} zh={false}/>)
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await act(async () => { a.pending.resolve({ ...a.done('Outcome unknown; not retried'), status: 'indeterminate' }); await a.pending.promise })
  expect(screen.getByRole('status')).toHaveTextContent('Outcome unknown; not retried')
  expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Check original decision' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
  await waitFor(() => expect(a.session.operate).toHaveBeenCalledTimes(1))
  view.unmount()
  render(<SourceApprovalControl session={a.session} request={request} zh={false}/>)
  await waitFor(() => expect(a.session.operate).toHaveBeenCalledTimes(1))
})

test('offline approval remains visible and cannot submit until the source is reachable again', async () => {
  const a = owner('hhpi:machine:source:codex:thread')
  const view = render(<SourceApprovalControl session={a.session} request={request} zh={false} disabled/>)
  expect(screen.getByRole('region', { name: 'Source approval' })).toHaveTextContent('Command approval')
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  expect(a.session.operate).not.toHaveBeenCalled()
  view.rerender(<SourceApprovalControl session={a.session} request={request} zh={false}/>)
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(a.session.operate).toHaveBeenCalledTimes(1))
})

test('a transient approval transport loss shows waiting while definite access denial stays visible', async () => {
  const a = owner('hhpi:machine:source:codex:thread')
  const view = render(<SourceApprovalControl session={a.session} request={request} zh={false}/>)
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(a.session.operate).toHaveBeenCalledTimes(1))
  await act(async () => { a.pending.reject(Object.assign(new Error('client api: hhpi/operate failed: network connection lost'), { code: 'gateway/internal' })); await a.pending.promise.catch(() => {}) })
  expect(screen.getByRole('status')).toHaveTextContent('Waiting to confirm this approval')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  await waitFor(() => expect(a.session.operate).toHaveBeenCalledTimes(1))
  const b = owner(a.session.sessionId)
  view.rerender(<SourceApprovalControl session={b.session} request={request} zh={false}/>)
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(b.session.operate).toHaveBeenCalledTimes(1))
  await act(async () => { b.pending.reject(Object.assign(new Error('client api: hhpi/operate failed: HTTP 403'), { code: 'gateway/internal' })); await b.pending.promise.catch(() => {}) })
  expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('human command context is visible while request IDs and raw parameters stay in collapsed details', () => {
  const a = owner('hhpi:machine:source:codex:thread')
  render(<SourceApprovalControl session={a.session} request={{ ...request, params: { command: 'npm test', cwd: '/workspace', reason: 'Run the requested checks' } }} zh={false}/> )
  expect(screen.getByRole('heading', { name: 'Command approval' })).toBeVisible()
  expect(screen.getByText('npm test')).toBeVisible()
  expect(screen.getByText('Working directory: /workspace')).toBeVisible()
  expect(screen.getByText('Run the requested checks')).toBeVisible()
  expect(screen.getByText('Technical details').closest('details')).not.toHaveAttribute('open')
})

test('an unknown native request cannot use generic approval buttons', () => {
  const a = owner('hhpi:machine:source:codex:thread')
  render(<SourceApprovalControl session={a.session} request={{ ...request, method: 'unknown/requestPermission' }} zh={false}/> )
  expect(screen.getByText(/generic approval is unavailable/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
  expect(a.session.operate).not.toHaveBeenCalled()
})

test('source-provided decisions do not expose a broader approval choice', async () => {
  const a = owner('hhpi:machine:source:codex:thread')
  render(<SourceApprovalControl session={a.session} request={{ ...request, params: { command: 'native command', availableDecisions: ['decline', 'cancel'] } }} zh={false}/> )
  expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Deny and stop this turn' }))
  await waitFor(() => expect(a.session.operate).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.id, decision: 'cancel' })))
})

test('a stale command card cannot approve after the source resolves its original request', async () => {
  const a = owner('hhpi:machine:source:codex:thread')
  let pendingRequests: SourceApproval[] = [request]
  const session = { ...a.session, metadata: { getSnapshot: () => ({ pendingRequests }) } }
  render(<SourceApprovalControl session={session} request={request} zh={false}/> )
  pendingRequests = []
  await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
  expect(screen.getByRole('alert')).toHaveTextContent('original approval was resolved or changed')
  expect(session.operate).not.toHaveBeenCalled()
})
