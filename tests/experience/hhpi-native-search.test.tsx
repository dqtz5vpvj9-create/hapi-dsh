/** Production native search/task panels. Only native source RPC responses are controlled. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { NativeSourceSearch, type NativeHistoryTarget, type NativeSourceQueryApi } from '../../src/client/sidebar-search-query.ts'
import { NativeSourceSearchPanel } from '../../src/client/sidebar-search-controls.tsx'
import { NativeThreadHistory, RemoteNativeHistoryPanel } from '../../src/client/remote-native-history.tsx'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives)
import type { CodexCall } from '../../src/remote/codex-access.ts'
const route = { hostId: 'host-a', machineId: 'machine-a', sourceId: 'source-a', engine: 'codex' }
const thread = (id: string, parentThreadId: string | null = null) => ({ id, name: 'Same title', cwd: '/source/project', createdAt: 1, updatedAt: 2, status: { type: 'notLoaded' }, parentThreadId })
const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers() })
function api(reply: (request: CodexCall) => unknown | Promise<unknown>): NativeSourceQueryApi {
  return { nativeCapabilities: async () => ({ ok: true, value: { protocolVersion: '0.165.0', runtime: 'fixture', methods: { 'thread/search': 'read', 'thread/searchOccurrences': 'read', 'thread/read': 'read', 'thread/list': 'read', 'thread/turns/list': 'read' }, unavailable: {} } }),
    nativeCall: async request => ({ ok: true, value: { status: 'accepted', message: '', result: await reply(request) } }) }
}

test('one source query continues empty scan batches, shows early matches and never calls a paused scan complete', async () => {
  const pending = Promise.withResolvers<unknown>(), calls: CodexCall[] = []
  const source = api(request => {
    calls.push(request)
    if (!request.params?.cursor) return { data: [], nextCursor: 'scan-2' }
    if (request.params.cursor === 'scan-2') return { data: [{ thread: thread('found'), snippet: 'Early real body match' }], nextCursor: 'scan-3' }
    return pending.promise
  })
  const controller = new NativeSourceSearch(route, source, () => true)
  stops.push(() => controller.dispose())
  render(<NativeSourceSearchPanel controller={controller} open={() => {}}/>)
  await userEvent.type(screen.getByRole('searchbox', { name: 'Message query' }), 'needle')
  await userEvent.click(screen.getByRole('button', { name: 'Search source' }))
  await screen.findByText('Early real body match')
  expect(calls.map(x => x.params?.cursor)).toEqual([null, 'scan-2', 'scan-3'])
  expect(screen.queryByText('The source returned no matches.')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Search source' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Cancel search' }))
  expect(screen.getByRole('status')).toHaveTextContent('Search stopped')
  expect(controller.getSnapshot().nextCursor).toBeNull()
  expect(screen.getByText('Early real body match')).toBeInTheDocument()
  expect(screen.queryByText('The source returned no matches.')).not.toBeInTheDocument()
  await act(async () => { pending.resolve({ data: [{ thread: thread('late'), snippet: 'Late cancelled body' }], nextCursor: null }); await pending.promise })
  expect(screen.queryByText('Late cancelled body')).not.toBeInTheDocument()
  expect(controller.getSnapshot().complete).toBe(false)
})

test('source search opens the selected native message and remount retains the query and return target', async () => {
  const user = userEvent.setup(), parentSubmit = vi.fn(), open = vi.fn(async (_target: NativeHistoryTarget) => {})
  const source = api(request => {
    if (request.method === 'thread/search') return { data: [{ thread: thread('first'), snippet: 'A needle' }, { thread: thread('second'), snippet: 'Another needle' }], nextCursor: null }
    if (request.method === 'thread/searchOccurrences') return { data: [{ turnId: 'exact-turn', itemId: 'exact-item', turnCursor: 'native-anchor', snippet: 'A needle', snippetMatchRange: { start: 2, end: 8 } }], nextCursor: null }
    return { thread: thread(String(request.params?.threadId)) }
  })
  const controller = new NativeSourceSearch(route, source, () => true), origin = { hostId: 'host-a', sessionId: 'original-parent' }
  stops.push(() => controller.dispose())
  const view = render(<div onSubmit={parentSubmit}><NativeSourceSearchPanel controller={controller} open={open} origin={origin}/></div>)
  await user.type(screen.getByRole('searchbox', { name: 'Message query' }), 'needle')
  await user.click(screen.getByRole('button', { name: 'Search source' }))
  await screen.findByText('Another needle')
  await user.click(screen.getAllByRole('button', { name: 'Show message matches' })[1]!)
  await user.click(await screen.findByRole('button', { name: 'Open this match' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ hostId: 'host-a', sessionId: expect.stringMatching(/:second$/), position: { kind: 'native', turnId: 'exact-turn', itemId: 'exact-item' }, turnCursor: 'native-anchor' }))
  expect(parentSubmit).not.toHaveBeenCalled()
  view.unmount()
  render(<NativeSourceSearchPanel controller={controller} open={open} origin={origin}/> )
  expect(screen.getByRole('searchbox', { name: 'Message query' })).toHaveValue('needle')
  await user.click(screen.getByRole('button', { name: 'Return to origin' }))
  expect(open).toHaveBeenLastCalledWith(origin)
})

test('late search from a replaced account cannot fill the new source panel', async () => {
  const user = userEvent.setup(), pending = Promise.withResolvers<unknown>()
  const old = new NativeSourceSearch(route, api(() => pending.promise), () => true)
  const next = new NativeSourceSearch({ ...route, machineId: 'machine-b', sourceId: 'source-b' }, api(() => ({ data: [], nextCursor: null })), () => true)
  stops.push(() => old.dispose(), () => next.dispose())
  const view = render(<NativeSourceSearchPanel controller={old} open={() => {}}/> )
  await user.type(screen.getByRole('searchbox', { name: 'Message query' }), 'old account query')
  await user.click(screen.getByRole('button', { name: 'Search source' }))
  view.rerender(<NativeSourceSearchPanel controller={next} open={() => {}}/> )
  old.dispose()
  await act(async () => { pending.resolve({ data: [{ thread: thread('private-old'), snippet: 'Private old account result' }], nextCursor: null }); await pending.promise })
  expect(screen.queryByText('Private old account result')).not.toBeInTheDocument()
  expect(screen.getByRole('searchbox', { name: 'Message query' })).toHaveValue('')
})

test('a user can cancel a source search and return to its exact origin before any match, keeping the query and rejecting a late result', async () => {
  const pending = Promise.withResolvers<unknown>(), open = vi.fn(), source = api(() => pending.promise)
  const controller = new NativeSourceSearch(route, source, () => true), origin = { hostId: 'host-a', sessionId: 'original-parent' }
  stops.push(() => controller.dispose())
  render(<NativeSourceSearchPanel controller={controller} open={open} origin={origin}/>)
  await userEvent.type(screen.getByRole('searchbox', { name: 'Message query' }), 'retained query')
  await userEvent.click(screen.getByRole('button', { name: 'Search source' }))
  await userEvent.click(screen.getByRole('button', { name: 'Cancel search' }))
  expect(screen.getByRole('button', { name: 'Search source' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'Return to origin' }))
  expect(open).toHaveBeenCalledWith(origin)
  await act(async () => { pending.resolve({ data: [{ thread: thread('late'), snippet: 'Cancelled source result' }], nextCursor: null }); await pending.promise })
  expect(screen.queryByText('Cancelled source result')).not.toBeInTheDocument()
  expect(screen.getByRole('searchbox', { name: 'Message query' })).toHaveValue('retained query')
})

test('a source search that never replies reaches the existing read deadline and permits a retry or return', async () => {
  vi.useFakeTimers()
  const source = api(() => new Promise(() => {})), controller = new NativeSourceSearch(route, source, () => true), open = vi.fn()
  stops.push(() => controller.dispose())
  render(<NativeSourceSearchPanel controller={controller} open={open} origin={{ hostId: 'host-a', sessionId: 'original-parent' }}/>)
  await act(async () => { void controller.search('retained query'); await Promise.resolve() })
  expect(screen.getByRole('button', { name: 'Search source' })).toBeDisabled()
  await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
  expect(screen.getByRole('alert')).toHaveTextContent('within 30 seconds')
  expect(screen.getByRole('button', { name: 'Search source' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Return to origin' })).toBeEnabled()
  expect(screen.getByRole('searchbox', { name: 'Message query' })).toHaveValue('retained query')
})

test('native child history shows explicit source outcome and archived pages without creating or resuming a task', async () => {
  const calls: CodexCall[] = [], open = vi.fn(async (_target: NativeHistoryTarget) => {})
  const source = api(request => {
    calls.push(request)
    if (request.method === 'thread/read') return { thread: thread(String(request.params?.threadId), request.params?.threadId === 'root' ? 'parent' : 'root') }
    if (request.method === 'thread/list') return { data: [thread(request.params?.archived ? 'archived-child' : 'child', 'root')], nextCursor: null }
    return { data: [{ id: 'native-turn', status: 'interrupted' }], nextCursor: null }
  })
  const controller = new NativeThreadHistory(route, source, () => true)
  stops.push(() => controller.dispose())
  render(<RemoteNativeHistoryPanel controller={controller} threadId="root" open={open}/> )
  await userEvent.click(await screen.findByRole('button', { name: /^View result:/ }))
  const outcome = await screen.findByRole('region', { name: 'Task result' })
  expect(within(outcome).getByText('Latest result: Interrupted')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Close result' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'Archived tasks' }))
  await waitFor(() => expect(controller.getSnapshot().children[0]?.nativeId).toBe('archived-child'))
  await userEvent.click(screen.getByRole('button', { name: 'Parent task' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ hostId: 'host-a', sessionId: expect.stringMatching(/:parent$/) }))
  expect(calls.every(call => ['thread/read', 'thread/list', 'thread/turns/list'].includes(call.method))).toBe(true)
})

test('related tasks show source task names first, retain exact identity in details and return to the original parent', async () => {
  const childId = '11111111-1111-4111-8111-111111111111', open = vi.fn(async (_target: NativeHistoryTarget) => {})
  const child = { ...thread(childId, 'root'), name: null, preview: '', agentNickname: 'Random nickname',
    source: { subAgent: { thread_spawn: { parent_thread_id: 'root', agent_path: '/root/check_api', depth: 1 } } } }
  const source = api(request => request.method === 'thread/list' ? { data: [child], nextCursor: null }
    : request.method === 'thread/read' ? { thread: request.params?.threadId === childId ? child : thread('root') }
      : { data: [{ id: 'native-turn', status: 'completed' }], nextCursor: null })
  const controller = new NativeThreadHistory(route, source, () => true), origin = { hostId: route.hostId, sessionId: 'original-parent' }
  stops.push(() => controller.dispose())
  render(<RemoteNativeHistoryPanel controller={controller} threadId="root" open={open} origin={origin}/> )
  const name = await screen.findByText('check_api')
  expect(name.tagName).toBe('STRONG'); expect(screen.getByText(/Random nickname/).tagName).toBe('SMALL')
  expect(screen.queryByText(childId)).not.toBeInTheDocument()
  expect(within(name.closest('li')!).getByText('Saved')).toBeVisible()
  expect(screen.queryByText('Saved history, not loaded')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /^View result:/ }))
  const outcome = await screen.findByRole('region', { name: 'Task result' })
  expect(outcome.closest('li')).toContainElement(name)
  expect(within(outcome).getByRole('heading', { name: 'check_api' })).toBeVisible()
  expect(within(outcome).getByText('Latest result: Completed')).toBeVisible()
  const details = within(outcome).getByText('Technical details')
  expect(details.closest('details')).not.toHaveAttribute('open')
  await userEvent.click(details)
  expect(within(outcome).getByText(childId).closest('details')).toHaveAttribute('open')
  await userEvent.click(screen.getByRole('button', { name: 'Open task: check_api' }))
  expect(open).toHaveBeenLastCalledWith({ hostId: route.hostId, sessionId: `hhpi:machine-a:source-a:codex:${childId}` })
  await userEvent.click(screen.getByRole('button', { name: 'Return to conversation' }))
  expect(open).toHaveBeenLastCalledWith(origin)
})


test('conversation scope shows real matches and preserves exact origin without issuing source-wide search', async () => {
  const calls: CodexCall[] = [], open = vi.fn(async (_target: NativeHistoryTarget) => {})
  const source = api(request => {
    calls.push(request)
    if (request.method === 'thread/read') return { thread: thread('current') }
    if (request.method === 'thread/searchOccurrences') return { data: [{ turnId: 'native-turn', itemId: 'native-item', turnCursor: 'opaque-current-turn', snippet: 'Current needle', snippetMatchRange: { start: 8, end: 14 } }], nextCursor: null }
    throw new Error('A conversation query cannot invoke source search')
  })
  const controller = new NativeSourceSearch(route, source, () => true), origin = { hostId: route.hostId, sessionId: 'hhpi:machine-a:source-a:codex:current' }
  stops.push(() => controller.dispose()); controller.setScope('conversation')
  render(<NativeSourceSearchPanel controller={controller} open={open} origin={origin} conversationSessionId={origin.sessionId}/>)
  expect(screen.getByRole('radio', { name: 'Current conversation' })).toBeChecked()
  await userEvent.type(screen.getByRole('searchbox', { name: 'Message query' }), 'needle')
  expect(calls).toHaveLength(0)
  await userEvent.click(screen.getByRole('button', { name: 'Search conversation' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Open this match' }))
  expect(open).toHaveBeenLastCalledWith({ ...origin, position: { kind: 'native', turnId: 'native-turn', itemId: 'native-item' }, turnCursor: 'opaque-current-turn' })
  await userEvent.click(screen.getByRole('button', { name: 'Return to origin' }))
  expect(open).toHaveBeenLastCalledWith(origin)
  await userEvent.click(screen.getByRole('radio', { name: 'Entire source' }))
  expect(screen.getByRole('heading', { name: 'Search source history' })).toBeVisible()
  expect(screen.getByText(/Search user and assistant messages across this source/)).toBeVisible()
  expect(calls.every(x => ['thread/read', 'thread/searchOccurrences'].includes(x.method))).toBe(true)
})

test('Enter and button submission share one busy guard while cancellation excludes a late conversation match', async () => {
  const pending = Promise.withResolvers<unknown>(), calls: CodexCall[] = []
  const source = api(request => { calls.push(request); return request.method === 'thread/read' ? { thread: thread('current') } : pending.promise })
  const controller = new NativeSourceSearch(route, source, () => true)
  stops.push(() => controller.dispose()); controller.setScope('conversation')
  const view = render(<NativeSourceSearchPanel controller={controller} open={() => {}} conversationSessionId="hhpi:machine-a:source-a:codex:current"/>)
  await userEvent.type(screen.getByRole('searchbox', { name: 'Message query' }), 'needle')
  act(() => { fireEvent.submit(view.container.querySelector('form')!); fireEvent.submit(view.container.querySelector('form')!) })
  await waitFor(() => expect(calls.filter(x => x.method === 'thread/searchOccurrences')).toHaveLength(1))
  expect(screen.getByRole('button', { name: 'Search conversation' })).toBeDisabled()
  expect(screen.getByRole('radio', { name: 'Entire source' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Cancel search' }))
  await act(async () => { pending.resolve({ data: [{ turnId: 'late', itemId: 'late', turnCursor: 'late', snippet: 'Cancelled private match', snippetMatchRange: { start: 0, end: 4 } }], nextCursor: null }); await pending.promise })
  expect(screen.queryByText('Cancelled private match')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Search conversation' })).toBeEnabled()
  expect(calls.filter(x => x.method === 'thread/read')).toHaveLength(1)
})
