import { act, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { NativeActions } from '../../src/client/native-actions.tsx'
import { hapiProjectionSchema, type ApprovalView } from '../../src/codex/projection-types.ts'
import { deferred, nativeApi, t } from './fixtures.tsx'

const approval: ApprovalView = { requestId: 'request-1', tool: 'shell', toolCallId: 'tool-1', arguments: { command: 'synthetic-command' },
  blocking: true, createdAt: 1, stage: 'pending', error: null }
function projection(source = 'source-a', request = approval) {
  return hapiProjectionSchema.unwrap().parse({ engine: 'codex', hubId: 'hub', hapiSessionId: source, logicalSessionId: source,
    displayRevision: 0, machineId: 'machine', machineName: 'Fixture', nativeId: source, nativeHome: null, nativeConnection: 'attached',
    readOnly: false, model: null, reasoningEffort: null, execution: null, pendingRequests: [request], resolvedRequests: [], delivery: [], error: null })
}

test('approval acknowledgement blocks duplicates until the source resolves the request', async () => {
  const api = nativeApi(), pending = deferred<unknown>(), user = userEvent.setup(), value = projection()
  vi.mocked(api.answer).mockReturnValue(pending.promise)
  const view = render(<NativeActions sessionId="display-a" projection={value} api={api} t={t}/> )
  await user.dblClick(screen.getByRole('button', { name: 'Approve once' }))
  expect(api.answer).toHaveBeenCalledExactlyOnceWith('display-a', 'request-1', { decision: 'approved' }, false)
  await act(async () => pending.resolve({ accepted: true }))
  expect(screen.getByText('Submitted · awaiting source resolution')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Approve once' })).toBeDisabled()
  view.rerender(<NativeActions sessionId="display-a" projection={{ ...value, pendingRequests: [], resolvedRequests: [
    { requestId: 'request-1', status: 'approved', completedAt: 2 },
  ] }} api={api} t={t}/> )
  expect(screen.queryByRole('button', { name: 'Approve once' })).not.toBeInTheDocument()
})

test('a failed approval stays visible and reconnecting or remounting does not submit it again', async () => {
  const api = nativeApi(), user = userEvent.setup(), value = projection()
  vi.mocked(api.answer).mockRejectedValue(new Error('Source acknowledgement missing'))
  const view = render(<NativeActions sessionId="display-a" projection={value} api={api} t={t}/> )
  await user.click(screen.getByRole('button', { name: 'Approve once' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Source acknowledgement missing')
  view.rerender(<NativeActions sessionId="display-a" projection={{ ...value, nativeConnection: 'disconnected' }} api={api} t={t}/> )
  expect(screen.getByRole('button', { name: 'Approve once' })).toBeDisabled()
  view.unmount()
  render(<NativeActions sessionId="new-display" projection={value} api={api} t={t}/> )
  expect(screen.getByRole('alert')).toHaveTextContent('Source acknowledgement missing')
  expect(api.answer).toHaveBeenCalledTimes(1)
})

test('question text survives a view remount but the same request ID in another source has its own answer', async () => {
  const api = nativeApi(), user = userEvent.setup()
  const request = { ...approval, tool: 'request_user_input', arguments: { questions: [{ id: 'choice', question: 'What should happen next?', options: [] }] } }
  const view = render(<NativeActions sessionId="display-a" projection={projection('source-a', request)} api={api} t={t}/> )
  await user.type(screen.getByRole('textbox', { name: 'What should happen next?' }), 'Keep my answer')
  view.unmount()
  const next = render(<NativeActions sessionId="new-a" projection={projection('source-a', request)} api={api} t={t}/> )
  expect(screen.getByRole('textbox')).toHaveValue('Keep my answer')
  next.rerender(<NativeActions sessionId="display-b" projection={projection('source-b', request)} api={api} t={t}/> )
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(api.answer).not.toHaveBeenCalled()
})
