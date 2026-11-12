/** Production task panel/controller/ledger; native RPC, transactional browser store and primitive presentation are explicit boundaries. */
import { afterEach, expect, test, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { SourceSession } from '../../src/remote/protocol.ts'
import type { CodexCall, CodexCallResult } from '../../src/remote/codex-access.ts'
import type { RemoteSourceSession } from '../../src/client/remote-sessions.ts'
import { NativeActionOwner } from '../../src/client/remote-native-actions.ts'
import { SourceDirectory } from '../../src/client/source-capabilities.ts'
import { RemoteTaskPanel } from '../../src/client/remote-native-tasks.tsx'
import { memoryOperations } from '../fixtures/operation-transactions.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives)
const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })
function fixture(nativeId = 'thread') {
  const metadata = { id: `hhpi:machine:source:codex:${nativeId}`, sourceId: 'source', nativeId, status: 'idle', codex: { model: 'fixture' } } as SourceSession
  let queue = [{ id: 'exact-queued-id', clientUserMessageId: 'original-client-id', input: [{ type: 'text', text: 'Original queued text', text_elements: [] }, { type: 'skill', name: 'review', path: '/skills/SKILL.md' }] }]
  let goal: { threadId: string; objective: string; status: string; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number } | null = { threadId: nativeId, objective: 'Current objective', status: 'active', tokenBudget: null, tokensUsed: 3, timeUsedSeconds: 2 }
  let write: (request: CodexCall) => Promise<CodexCallResult> = async () => ({ status: 'accepted', message: 'Native request accepted' })
  const calls = vi.fn(async (request: CodexCall) => write(request)), receipt = vi.fn(async (_request: CodexCall) => ({ status: 'accepted' as const, message: 'Original receipt confirmed' }))
  const api = { async nativeCapabilities() { return { ok: true, value: { methods: { 'thread/queue/list': 'read', 'thread/goal/get': 'read', 'thread/queue/update': 'write', 'thread/queue/delete': 'write', 'thread/queue/start': 'write', 'thread/queue/reorder': 'write', 'thread/goal/set': 'write', 'thread/goal/clear': 'write' }, unavailable: {} } } },
    async nativeCall(request: CodexCall) { return { ok: true, value: { status: 'accepted', result: request.method === 'thread/queue/list' ? { data: queue, nextCursor: null } : { goal } } } } } as unknown as HhpiRemoteApi
  const actions = new NativeActionOwner({ call: calls, receipt }, { createLedger: memoryOperations })
  actions.setStorage({ storage: localStorage, scope: crypto.randomUUID() })
  const directory = new SourceDirectory(api, 'source')
  const session = { sessionId: metadata.id, metadata: { getSnapshot: () => metadata, subscribe: () => () => {} }, nativeActions: actions, sourceDirectory: () => directory } as unknown as RemoteSourceSession
  stops.push(() => { actions.dispose(); directory.dispose() })
  return { session, api, calls, receipt, actions, setGoal: (next: typeof goal) => { goal = next }, setStatus: (status: SourceSession['status']) => { metadata.status = status }, setQueue: (next: typeof queue) => { queue = next }, onWrite: (next: typeof write) => { write = next } }
}

test('a waiting native turn keeps queue editing available but requires Stop before explicit queue start', async () => {
  const f = fixture()
  f.setStatus('waiting')
  const view = render(<RemoteTaskPanel session={f.session} api={f.api}/>)
  await screen.findByText('Original queued text review')
  expect(screen.getByRole('button', { name: 'Start this message' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
  expect(screen.getByText('Stop the current turn before starting a queued message.')).toBeVisible()
  expect(f.calls).not.toHaveBeenCalled()
  view.unmount(); f.setStatus('idle')
  render(<RemoteTaskPanel session={f.session} api={f.api}/>)
  await screen.findByText('Original queued text review')
  expect(screen.getByRole('button', { name: 'Start this message' })).toBeEnabled()
  expect(f.calls).not.toHaveBeenCalled()
})

test('queue edit remains visible when the source starts the item and never touches the composer or re-adds it', async () => {
  const f = fixture(), user = userEvent.setup()
  render(<RemoteTaskPanel session={f.session} api={f.api}/> )
  await screen.findByText('Original queued text review')
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  const draft = screen.getByRole('textbox', { name: 'Message text 1' })
  await user.clear(draft); await user.type(draft, 'Keep this new queued edit')
  f.setQueue([])
  await user.click(screen.getByRole('button', { name: 'Save queued edit' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('started or left the native queue')
  expect(draft).toHaveValue('Keep this new queued edit')
  expect(screen.getByText(/will not be added again/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Save queued edit' })).toBeDisabled()
  expect(f.calls).not.toHaveBeenCalled()
})

test('Goal uncertainty is shared after remount and only explicit original receipt recovery settles it', async () => {
  const f = fixture(), user = userEvent.setup()
  f.onWrite(async () => ({ status: 'indeterminate', message: 'Original Goal write is uncertain' }))
  const view = render(<RemoteTaskPanel session={f.session} api={f.api}/> )
  await user.click(await screen.findByRole('button', { name: 'Edit goal' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveValue('Current objective'))
  const objective = screen.getByRole('textbox', { name: 'Goal objective' })
  await user.clear(objective); await user.type(objective, 'Explicit new objective')
  await user.click(screen.getByRole('button', { name: 'Save goal' }))
  await screen.findByText('Original Goal write is uncertain')
  expect(screen.getByRole('button', { name: 'Save goal' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Refresh source state' }))
  expect(f.calls).toHaveBeenCalledTimes(1); expect(f.receipt).not.toHaveBeenCalled()
  view.unmount()
  render(<RemoteTaskPanel session={f.session} api={f.api}/> )
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveValue('Explicit new objective'))
  await user.click(await screen.findByRole('button', { name: 'Check original request' }))
  await screen.findByText('Original receipt confirmed')
  expect(f.calls).toHaveBeenCalledTimes(1)
  expect(f.receipt.mock.calls[0]?.[0]).toEqual(f.calls.mock.calls[0]?.[0])
  expect(f.calls.mock.calls[0]?.[0].params).toMatchObject({ threadId: 'thread', objective: 'Explicit new objective', origin: 'user' })
})

test('switching the task panel to another source does not carry a Goal draft into its save operation', async () => {
  const first = fixture('first'), second = fixture('second'), user = userEvent.setup()
  const view = render(<RemoteTaskPanel session={first.session} api={first.api}/> )
  await user.click(await screen.findByRole('button', { name: 'Edit goal' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveValue('Current objective'))
  const draft = screen.getByRole('textbox', { name: 'Goal objective' })
  await user.clear(draft); await user.type(draft, 'First source private draft')
  view.rerender(<RemoteTaskPanel session={second.session} api={second.api}/> )
  expect(screen.queryByRole('textbox', { name: 'Goal objective' })).toBeNull()
  await user.click(await screen.findByRole('button', { name: 'Edit goal' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveValue('Current objective'))
  await user.click(screen.getByRole('button', { name: 'Save goal' }))
  await waitFor(() => expect(second.calls).toHaveBeenCalledTimes(1))
  expect(second.calls.mock.calls[0]?.[0].params?.threadId).toBe('second')
  expect(second.calls.mock.calls[0]?.[0].params?.objective).toBe('Current objective')
  expect(first.calls).not.toHaveBeenCalled()
})


test('an uncertain queue edit restores its desired text after remount without dispatching it again', async () => {
  const f = fixture(), user = userEvent.setup()
  f.onWrite(async () => ({ status: 'indeterminate', message: 'Queue edit pending' }))
  const view = render(<RemoteTaskPanel session={f.session} api={f.api}/> )
  await screen.findByText('Original queued text review')
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  const draft = screen.getByRole('textbox', { name: 'Message text 1' })
  await user.clear(draft); await user.type(draft, 'Durable edited text')
  await user.click(screen.getByRole('button', { name: 'Save queued edit' }))
  await screen.findByText('Queue edit pending')
  view.unmount()
  render(<RemoteTaskPanel session={f.session} api={f.api}/> )
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message text 1' })).toHaveValue('Durable edited text'))
  expect(f.calls).toHaveBeenCalledTimes(1)
  expect(f.receipt).not.toHaveBeenCalled()
})

test('an open task panel clears old-account Goal, queued text and unsaved edits immediately on revocation', async () => {
  const f = fixture(), user = userEvent.setup()
  render(<RemoteTaskPanel session={f.session} api={f.api}/>)
  await screen.findByText('Original queued text review')
  await user.click(screen.getByRole('button', { name: 'Edit goal' }))
  const objective = screen.getByRole('textbox', { name: 'Goal objective' })
  await user.clear(objective); await user.type(objective, 'Private goal draft')
  act(() => f.actions.setStorage({ storage: localStorage, scope: 'different-account' }))
  expect(await screen.findByText(/This account or source changed/)).toBeVisible()
  expect(screen.queryByText('Original queued text review')).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Goal objective' })).toBeNull()
  expect(screen.queryByDisplayValue('Private goal draft')).toBeNull()
  expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled()
})

test('opening an already revoked task source stays on the local recovery message without throwing or reading old content', async () => {
  const f = fixture(); await f.actions.revokeSession(f.session.sessionId)
  render(<RemoteTaskPanel session={f.session} api={f.api}/>)
  expect(screen.getByText(/This account or source changed/)).toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'Goal objective' })).toBeNull()
  expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled()
})

test('the goal opens as readable content, cancels a draft locally and shows only the current status action', async () => {
  const f = fixture(), user = userEvent.setup()
  f.setQueue([])
  f.setGoal({ threadId: 'thread', objective: 'A goal that should be read before editing', status: 'active', tokenBudget: 50000000, tokensUsed: 29707992, timeUsedSeconds: 90656 })
  render(<RemoteTaskPanel session={f.session} api={f.api}/>)
  await screen.findByText('A goal that should be read before editing')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByRole('button', { name: 'Pause goal' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Resume goal' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Clear goal' })).toBeNull()
  expect(screen.getByText('No queued messages.')).toBeVisible()
  expect(screen.getByText('29.7M')).not.toBeVisible()
  await user.click(screen.getByText('Usage details'))
  expect(screen.getByText('29.7M')).toBeVisible()
  expect(screen.getByText('1d 1h')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Edit goal' }))
  const draft = screen.getByRole('textbox', { name: 'Goal objective' })
  expect(draft).toHaveFocus()
  await user.clear(draft); await user.type(draft, 'Discard this local draft')
  await user.click(screen.getByRole('button', { name: 'Cancel editing' }))
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByText('A goal that should be read before editing')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Edit goal' }))
  expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveValue('A goal that should be read before editing')
  expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).not.toHaveBeenCalled()
})

test('goal actions keep the exact objective and clear only through the explicit menu action', async () => {
  const f = fixture(), user = userEvent.setup()
  f.onWrite(async request => {
    if (request.method === 'thread/goal/clear') f.setGoal(null)
    else f.setGoal({ threadId: 'thread', objective: 'Current objective', status: String(request.params?.status ?? 'active'), tokenBudget: null, tokensUsed: 3, timeUsedSeconds: 2 })
    return { status: 'accepted', message: 'Native request accepted' }
  })
  render(<RemoteTaskPanel session={f.session} api={f.api}/>)
  await user.click(await screen.findByRole('button', { name: 'Pause goal' }))
  expect(await screen.findByRole('button', { name: 'Resume goal' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Pause goal' })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(f.calls.mock.calls[0]?.[0]).toMatchObject({ method: 'thread/goal/set', params: { threadId: 'thread', objective: 'Current objective', tokenBudget: null, status: 'paused', origin: 'user' } })
  await user.click(screen.getByRole('button', { name: 'Resume goal' }))
  await user.click(await screen.findByRole('button', { name: 'Mark goal complete' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark goal complete' })).toBeNull())
  expect(screen.getByRole('button', { name: 'Resume goal' })).toBeEnabled()
  expect(f.calls).toHaveBeenCalledTimes(3)
  await user.click(screen.getByRole('button', { name: 'More goal actions' }))
  expect(f.calls).toHaveBeenCalledTimes(3)
  await user.click(await screen.findByRole('menuitem', { name: 'Clear goal' }))
  await screen.findByText('No persistent goal.')
  expect(f.calls).toHaveBeenCalledTimes(4)
  expect(f.calls.mock.calls[3]?.[0]).toMatchObject({ method: 'thread/goal/clear', params: { threadId: 'thread', origin: 'user' } })
  expect(screen.getByRole('button', { name: 'Set goal' })).toBeEnabled()
})
