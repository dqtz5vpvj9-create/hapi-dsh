import { act, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SourceQueue } from '../../src/client/source-queue.tsx'
import type { DeliveryView } from '../../src/codex/projection-types.ts'
import { deferred, nativeApi } from './fixtures.tsx'
import type { ReactNode } from 'react'

// The Host supplies these renderer atoms through its browser graph. Tooltip
// positioning and file icons have no bearing on queue ownership or actions.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  FileTypeIcon: () => <span aria-hidden="true"/>,
}))

const row = (id: string, state: DeliveryView['state'] = 'queued'): DeliveryView => ({ localId: id, messageId: id, text: `Message ${id}`,
  state, mode: 'queue', createdAt: 1, error: null, editable: true, cancelable: true })
const source = { sourceHubId: 'fixture-hub', sourceSessionId: 'fixture-source' }
const props = () => ({ api: nativeApi(), sessionId: 'display-a', source, rows: [row('one')], disabled: false, steer: true, zh: false })

test('double click sends one cancellation, keeps the pending row visible, and exposes a failed request', async () => {
  const p = props(), pending = deferred<unknown>(), user = userEvent.setup()
  vi.mocked(p.api.cancel).mockReturnValue(pending.promise)
  render(<SourceQueue {...p}/> )
  await user.dblClick(screen.getByRole('button', { name: 'Cancel queued message' }))
  expect(p.api.cancel).toHaveBeenCalledExactlyOnceWith('display-a', 'one')
  expect(screen.getByText('Message one')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeDisabled()
  await act(async () => pending.reject(new Error('Source unreachable')))
  expect(screen.getByRole('alert')).toHaveTextContent('Source unreachable')
  expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()
  expect(p.api.cancel).toHaveBeenCalledTimes(1)
})

test('a pending operation belongs to its original pane even when another session has the same local ID', async () => {
  const p = props(), pending = deferred<unknown>(), user = userEvent.setup()
  vi.mocked(p.api.cancel).mockReturnValue(pending.promise)
  render(<><div aria-label="first"><SourceQueue {...p}/></div><div aria-label="second"><SourceQueue {...p} sessionId="display-b"/></div></>)
  await user.click(within(screen.getByLabelText('first')).getByRole('button', { name: 'Cancel queued message' }))
  expect(within(screen.getByLabelText('second')).getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()
  await act(async () => pending.reject(new Error('Only first pane failed')))
  expect(within(screen.getByLabelText('second')).queryByRole('alert')).not.toBeInTheDocument()
})

test('queue expansion reflects source updates and excludes indeterminate receipts', async () => {
  const p = props(), user = userEvent.setup()
  const view = render(<SourceQueue {...p} rows={[row('one'), row('two'), row('uncertain', 'indeterminate')]}/> )
  expect(screen.queryByText('Message one')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /2 queued messages/ }))
  expect(screen.getByText('Message one')).toBeVisible()
  expect(screen.queryByText('Message uncertain')).not.toBeInTheDocument()
  view.rerender(<SourceQueue {...p} rows={[row('two')]}/> )
  expect(screen.queryByText('Message one')).not.toBeInTheDocument()
  expect(screen.getByText('Message two')).toBeVisible()
  view.rerender(<SourceQueue {...p} rows={[]}/> )
  expect(screen.queryByText('Message two')).not.toBeInTheDocument()
})

test('disconnected controls cannot cancel or steer; reconnect itself sends nothing', async () => {
  const p = props(), user = userEvent.setup(), view = render(<SourceQueue {...p} disabled/> )
  await user.click(screen.getByRole('button', { name: 'Cancel queued message' }))
  await user.click(screen.getByRole('button', { name: 'Steer now' }))
  expect(p.api.cancel).not.toHaveBeenCalled(); expect(p.api.steer).not.toHaveBeenCalled()
  view.rerender(<SourceQueue {...p}/> )
  expect(p.api.cancel).not.toHaveBeenCalled(); expect(p.api.steer).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Edit queued message' }))
  expect(p.api.queuedEditing?.edit).toHaveBeenCalledExactlyOnceWith('display-a', p.rows[0])
})

test('steer button reaches the queued source item once and reports a failed request', async () => {
  const p = props(), pending = deferred<unknown>(), user = userEvent.setup()
  vi.mocked(p.api.steer).mockReturnValue(pending.promise)
  render(<SourceQueue {...p}/> )
  const steer = screen.getByRole('button', { name: 'Steer now' })
  expect(steer).toBeEnabled()
  await user.dblClick(steer)
  expect(p.api.steer).toHaveBeenCalledExactlyOnceWith('display-a', 'one')
  expect(steer).toBeDisabled()
  await act(async () => pending.reject(new Error('Steering unavailable')))
  expect(screen.getByRole('alert')).toHaveTextContent('Steering unavailable')
  expect(screen.getByRole('button', { name: 'Steer now' })).toBeEnabled()
  expect(p.api.steer).toHaveBeenCalledTimes(1)
})
