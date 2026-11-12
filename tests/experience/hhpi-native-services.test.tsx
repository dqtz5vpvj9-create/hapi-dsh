/** Actual More popup, source-actions entry and native read controller; RPC/editor methods are explicit boundaries. */
import { expect, onTestFinished, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { Context } from '@deepseek-ai/cordis'
import { SourceControls, type InputProps } from '../../src/client/composer-picker/index.tsx'
import { CodexActions } from '../../src/client/remote-codex-actions.tsx'
import { RemoteNativeServicesPanel } from '../../src/client/remote-native-services.tsx'
import { nativeServicesFixture, mcpServer } from '../fixtures/native-services.ts'

function moreFixture() {
  const f = nativeServicesFixture()
  const input = { draft: '中文 original draft', attachmentIds: ['original-image'], phase: 'plain' }
  const submit = vi.fn(), persistDraft = vi.fn(), insertText = vi.fn(), focus = vi.fn()
  const ctx = { get: () => undefined, remote: { hhpi: f.api },
    hhpiSessions: { captureWorkspaceAccess: f.captureAccess },
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    conversation: { input: { for: () => ({ submit, persistDraft, focus }) } },
  } as unknown as Context
  const props = { sessionId: f.session.sessionId, sessionBinding: { session: f.session, ctx: {} },
    inputActions: { insertText, captureInsertion: () => ({ start: 3, end: 3, draftRev: 1 }) },
    useInput: (select: (value: typeof input) => unknown) => select(input),
    useSession: (select: (value: { running: boolean }) => unknown) => select({ running: false }), renderSlot: () => null,
  } as unknown as InputProps
  const view = render(<><textarea aria-label="Original draft" defaultValue={input.draft}/><SourceControls ctx={ctx} props={props}
    initial={{ model: 'Fixture model', effort: null, permission: null, serviceTier: null }} permissionCapable={false} data={null}
    loading={false} busy={false} pending={null} error={null} sourceLocked={false} refresh={async () => {}} apply={async () => false}
    actionsContent={<CodexActions ctx={ctx} session={f.session} metadata={f.session.metadata.getSnapshot()} zh={false}/>}/></>)
  onTestFinished(() => { view.unmount(); f.close() })
  return { ...f, submit, persistDraft, insertText }
}

test('More opens real source connections, refreshes within the same popup and returns without changing the original draft', async () => {
  const f = moreFixture(), user = userEvent.setup()
  const draft = screen.getByRole('textbox', { name: 'Original draft' }) as HTMLTextAreaElement
  draft.setSelectionRange(3, 7)
  expect(f.calls).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: 'More input controls' }))
  await user.click(screen.getByRole('button', { name: 'Source connections & background work' }))
  expect(await screen.findByText('Repository service')).toBeVisible()
  expect(screen.getByText('Connected · Token configured · 1 tools')).toBeVisible()
  expect(screen.getByText('This conversation returned no background processes.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Refresh connections' }))
  expect(screen.getByRole('dialog', { name: 'More input controls' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Back to conversation actions' }))
  expect(screen.getByRole('button', { name: 'Source connections & background work' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: 'Close picker' }))
  expect(draft).toHaveValue('中文 original draft'); expect(draft.selectionStart).toBe(3); expect(draft.selectionEnd).toBe(7)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.persistDraft).not.toHaveBeenCalled(); expect(f.insertText).not.toHaveBeenCalled()
  expect(f.writes).toHaveLength(0)
})

test('one source section can recover without hiding another, inventing completion or exposing raw transport errors', async () => {
  const f = moreFixture(), user = userEvent.setup()
  let failing = true
  f.onRead(async request => {
    if (request.method === 'mcpServerStatus/list') {
      if (failing) throw new TypeError('client api: hhpi/nativeCall failed: Failed to fetch')
      return { status: 'accepted', message: 'Read', result: { data: [{ ...mcpServer(), runtimeStatus: 'authenticationRequired', authStatus: 'notLoggedIn' }], nextCursor: null } }
    }
    return { status: 'accepted', message: 'Read', result: { data: [{ processId: 'source-process', itemId: 'original-item', command: 'python original_worker.py', cwd: '/original', cpuPercent: 0, rssKb: 2048, osPid: 42 }], nextCursor: null } }
  })
  await user.click(screen.getByRole('button', { name: 'More input controls' }))
  await user.click(screen.getByRole('button', { name: 'Source connections & background work' }))
  expect(await screen.findByText(/This source read did not finish/)).toBeVisible()
  const background = screen.getByRole('region', { name: 'Codex background processes' })
  expect(within(background).getByText('python original_worker.py', { selector: 'strong' })).toBeVisible()
  expect(within(background).queryByText(/completed|failed|running/i)).toBeNull()
  expect(screen.queryByText(/Failed to fetch/)).toBeNull()
  failing = false; await user.click(screen.getByRole('button', { name: 'Refresh connections' }))
  expect(await screen.findByText(/Authorization required · Not logged in/)).toBeVisible()
  expect(screen.getByText(/Complete authorization in Codex on this source machine/)).toBeVisible()
  expect(screen.queryByText(/This source read did not finish/)).toBeNull(); expect(f.writes).toHaveLength(0)
})

test('switching the owning session removes old service results and an already revoked owner stays inside an actionable page', async () => {
  const first = nativeServicesFixture(), second = nativeServicesFixture('other-thread', 'other-source')
  const view = render(<RemoteNativeServicesPanel session={first.session} api={first.api} captureAccess={first.captureAccess} chinese={false} back={() => {}}/>)
  onTestFinished(() => { view.unmount(); first.close(); second.close() })
  await screen.findByText('Repository service')
  second.application.clear()
  view.rerender(<RemoteNativeServicesPanel session={second.session} api={second.api} captureAccess={second.captureAccess} chinese={false} back={() => {}}/>)
  await waitFor(() => expect(screen.queryByText('Repository service')).toBeNull())
  expect(screen.getByText(/This account or source changed/)).toBeVisible()
  expect(second.calls).toHaveLength(0); expect(first.writes).toHaveLength(0)
})
