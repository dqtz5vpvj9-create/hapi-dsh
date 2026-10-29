import { act, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installSourceWindowNavigation } from '../../src/client/surface/source-window-navigation.tsx'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import { context, pane, slots } from './fixtures.tsx'

test('an archive gap offers latest in its own pane, remains disabled during loading, and disappears only after the gap closes', async () => {
  const registered = slots(), user = userEvent.setup()
  const window = createSnapshotStore({ hasMoreAfter: true }), session = createSnapshotStore({ loadingOlder: false })
  const ctx = context({ slots: registered.registry, sessions: { binding: () => ({ session: { sourceWindow: window } }) } })
  const stop = installSourceWindowNavigation(ctx), Latest = registered.component('hapi.source-latest')
  const left = pane('left'), right = pane('right')
  const props = { sessionId: 'fixture-session', t: () => 'Latest messages', useSession: (select: (value: { loadingOlder: boolean }) => boolean) =>
    useSyncExternalStore(session.subscribe, () => select(session.getSnapshot())) } as unknown as PropsRuntime<'conversation.input.dock'>
  function View() { return <><section aria-label="Left"><WorkspacePaneProvider value={left}><Latest {...props}/></WorkspacePaneProvider></section>
    <section aria-label="Right"><WorkspacePaneProvider value={right}><Latest {...props}/></WorkspacePaneProvider></section></> }
  const view = render(<View/>)
  await user.click(within(screen.getByRole('region', { name: 'Right' })).getByRole('button', { name: 'Latest messages' }))
  expect(right.locate).toHaveBeenCalledExactlyOnceWith({ kind: 'latest' }); expect(left.locate).not.toHaveBeenCalled()
  await act(async () => session.set({ loadingOlder: true }))
  expect(within(screen.getByRole('region', { name: 'Right' })).getByRole('button')).toBeDisabled()
  await user.click(within(screen.getByRole('region', { name: 'Right' })).getByRole('button'))
  expect(right.locate).toHaveBeenCalledTimes(1)
  await act(async () => window.set({ hasMoreAfter: false }))
  expect(screen.queryByRole('button', { name: 'Latest messages' })).not.toBeInTheDocument()
  view.unmount(); stop()
})

test('a failed source page remains visible with a retry action until a retry succeeds', async () => {
  const registered = slots(), user = userEvent.setup()
  const initialWindow: { hasMoreAfter: boolean; before: { at: number; seq: number } | null; pagingError?: true } = {
    hasMoreAfter: false, before: { at: 10, seq: 4 }, pagingError: true,
  }
  const window = createSnapshotStore(initialWindow)
  const loadOlder = vi.fn().mockResolvedValue(undefined)
  const session = createSnapshotStore({ loadingOlder: false })
  const ctx = context({ slots: registered.registry, sessions: { binding: () => ({ session: { sourceWindow: window, loadOlder } }) } })
  const stop = installSourceWindowNavigation(ctx), Latest = registered.component('hapi.source-latest')
  const current = pane('current')
  const props = {
    sessionId: 'fixture-session',
    t: (key: string, args?: { message?: string; code?: string }) => ({
      'chat.toBottom': 'Latest messages', 'chat.loadOlder': 'Retry older', 'chat.loadingHistory': 'Loading history',
      'chat.loadError': `历史加载失败：${args?.message}（${args?.code}）`,
    }[key] ?? key),
    useSession: (select: (value: { loadingOlder: boolean }) => boolean) =>
      useSyncExternalStore(session.subscribe, () => select(session.getSnapshot())),
  } as unknown as PropsRuntime<'conversation.input.dock'>
  function View() { return <WorkspacePaneProvider value={current}><Latest {...props}/></WorkspacePaneProvider> }
  const view = render(<View/>), status = screen.getByRole('status')
  expect(status).toHaveTextContent('历史加载失败：Retry older（history_page_failed）')
  const retry = within(status).getByRole('button', { name: 'Retry older' })
  await user.click(retry)
  expect(loadOlder).toHaveBeenCalledOnce()
  await act(async () => session.set({ loadingOlder: true }))
  expect(within(status).getByRole('button', { name: 'Loading history' })).toBeDisabled()
  await act(async () => { window.set({ hasMoreAfter: false, before: { at: 10, seq: 4 } }) })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  view.unmount(); stop()
})
