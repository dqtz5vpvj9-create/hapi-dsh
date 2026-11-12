/** Production registered contributions/controllers; Slot props and source RPC are explicit boundaries. */
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, onTestFinished, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SourceReadCommits } from '../../src/client/source-reading-commit.ts'
import { installSourceNativeNavigation, SOURCE_NATIVE_NAVIGATION_ID } from '../../src/client/source-native-navigation.tsx'
import { installRemoteSourceControls } from '../../src/client/remote-controls.tsx'
import type { NativeSourceQueryApi } from '../../src/client/sidebar-search-query.ts'
import type { CodexCall } from '../../src/remote/codex-access.ts'
import type { AppTarget } from '../../src/workspace/app-service-types.ts'
import type { SourceApproval, SourceOperation } from '../../src/remote/protocol.ts'
import type { SourceInputProps } from '../../src/client/composer-picker/slots.ts'
import type { AppTargetPane } from '../../src/client/app-target-navigation.ts'
import { SourceControls, type InputProps } from '../../src/client/composer-picker/index.tsx'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives)

const sessionId = 'hhpi:machine:source:codex:original' as PropsRuntime<'conversation.input.left'>['sessionId']
const thread = (id: string, parentThreadId: string | null = null) => ({ id, name: 'Exact source task', cwd: '/source', createdAt: 1, updatedAt: 2, status: { type: 'notLoaded' }, parentThreadId })
function fixture(reply: (request: CodexCall) => unknown | Promise<unknown>) {
    let access = new AbortController(), scope = 'first-account'
    const registrations = new Map<string, ComponentType<any>>(), readCommits = new SourceReadCommits(), navigate = vi.fn(async (_target: AppTarget, _signal: AbortSignal, _destination?: AppTargetPane) => {})
    const binding = { sessionId, session: {} } as SessionBinding, openTab = vi.fn()
    const paneState = { focused: true, visible: true }
    const pane = { hostId: 'original-host', paneId: 'actual-pane', state: { getSnapshot: () => paneState, subscribe: () => () => {} }, openTab }
    const api: NativeSourceQueryApi = { nativeCapabilities: async () => ({ ok: true, value: { protocolVersion: '0.165.0', runtime: 'fixture',
        methods: { 'thread/search': 'read', 'thread/searchOccurrences': 'read', 'thread/read': 'read', 'thread/list': 'read', 'thread/turns/list': 'read' }, unavailable: {} } }),
        nativeCall: vi.fn(async (request: CodexCall) => ({ ok: true as const, value: { status: 'accepted' as const, message: '', result: await reply(request) } })) }
    const ctx = { get: (name: string) => name === 'hapiWorkspacePane' ? pane : undefined,
        locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) }, sessions: { binding: () => binding },
        hhpiSessions: { ownsBinding: (value: SessionBinding) => value === binding,
            captureWorkspaceAccess() { const owner = access; owner.signal.throwIfAborted(); return { scope, signal: owner.signal, assertCurrent() { owner.signal.throwIfAborted() } } } },
        hapiWorkspaceUi: { readCommits }, remote: { hhpi: api }, sidebarRight: { openTabIn: vi.fn() },
        sidebarRightTabs: { register: vi.fn(() => () => {}) },
        slots: { inject(_name: string, install: () => () => void) { return install() }, register(options: { name: string; key?: string; id?: string }, component: ComponentType<any>) {
            const key = options.key ?? options.id!; registrations.set(key, component); return () => { registrations.delete(key) }
        } },
    } as unknown as Context
    const stop = installSourceNativeNavigation(ctx, { hostId: pane.hostId, navigate }); onTestFinished(() => { stop(); readCommits.dispose() })
    const Entry = registrations.get('hhpi.native-navigation')!, Body = registrations.get(SOURCE_NATIVE_NAVIGATION_ID)!
    const close = vi.fn(), inputProps = { sessionId, sessionBinding: binding } as unknown as SourceInputProps
    const entryProps = { source: inputProps, onClose: close } as unknown as PropsRuntime<'hapi.source.composer-navigation'>
    const bodyProps = () => ({ sessionId, sessionBinding: binding, useTabInfo: () => ({ tab: { visible: true, signal: new AbortController().signal,
        navigation: { revision: 1, params: openTab.mock.calls.at(-1)![1].params } } }) }) as unknown as PropsRuntime<'sidebar.right.pane.tab'>
    return { ctx, api, pane, binding, readCommits, navigate, openTab, Entry, Body, entryProps, inputProps, close, bodyProps,
        revoke() { access.abort() }, replaceAccount() { access = new AbortController(); scope = 'second-account' } }
}

test('registered source entry opens exact native matches and returns to an actual committed source position while retaining its query', async () => {
    const f = fixture(request => request.method === 'thread/search' ? { data: [{ thread: thread('found'), snippet: 'needle in source' }], nextCursor: null }
        : request.method === 'thread/searchOccurrences' ? { data: [{ turnId: 'exact-turn', itemId: 'exact-item', turnCursor: 'opaque-turn', snippet: 'needle in source', snippetMatchRange: { start: 0, end: 6 } }], nextCursor: null }
            : { thread: thread(String(request.params?.threadId)) })
    // The sample precedes even the popup child mounting. No scroll or new
    // reader publication follows while the user opens the navigation entry.
    act(() => f.readCommits.publish({ hostId: 'original-host', paneId: 'actual-pane', sessionBinding: f.binding,
        position: { kind: 'hhpi', epoch: 'accepted-source-epoch', seq: 73 }, at: 100 }))
    act(() => f.readCommits.publish({ hostId: 'another-host', paneId: 'actual-pane', sessionBinding: f.binding,
        position: { kind: 'hhpi', epoch: 'wrong-host', seq: 999 }, at: 999 }))
    const entry = render(<f.Entry {...f.entryProps}/>)
    await userEvent.click(screen.getByRole('button', { name: 'Search source history' })); entry.unmount()
    expect(f.close).toHaveBeenCalledOnce(); expect(f.openTab.mock.calls[0]![1].beside).toBeUndefined()
    const body = render(<f.Body {...f.bodyProps()}/>)
    await userEvent.type(screen.getByRole('searchbox', { name: 'Message query' }), 'needle')
    await userEvent.click(screen.getByRole('button', { name: 'Search source' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show message matches' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Open this match' }))
    expect(f.navigate).toHaveBeenLastCalledWith({ kind: 'reading', source: { kind: 'hhpi', hostId: 'original-host', sessionId: 'hhpi:machine:source:codex:found',
        identity: { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'found' } }, position: { kind: 'native', turnId: 'exact-turn', itemId: 'exact-item' } }, expect.any(AbortSignal),
        { hostId: 'original-host', paneId: 'actual-pane', sessionId })
    body.unmount(); render(<f.Body {...f.bodyProps()}/>)
    expect(screen.getByRole('searchbox', { name: 'Message query' })).toHaveValue('needle')
    await userEvent.click(screen.getByRole('button', { name: 'Return to origin' }))
    expect(f.navigate.mock.calls.at(-1)![0]).toMatchObject({ kind: 'reading', source: { hostId: 'original-host', sessionId }, position: { kind: 'hhpi', epoch: 'accepted-source-epoch', seq: 73 } })
    expect(f.navigate.mock.calls.at(-1)![2]).toEqual({ hostId: 'original-host', paneId: 'actual-pane', sessionId: 'hhpi:machine:source:codex:found' })
})

test('registered related-task entry stays source scoped and revocation clears results before a late source search returns', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = fixture(request => request.method === 'thread/list' ? { data: [thread('child', 'original')], nextCursor: null }
        : request.method === 'thread/search' ? pending.promise : { thread: thread(String(request.params?.threadId), request.params?.threadId === 'original' ? 'parent' : null) })
    const entry = render(<f.Entry {...f.entryProps}/>)
    await userEvent.click(screen.getByRole('button', { name: 'Related tasks' })); entry.unmount()
    render(<f.Body {...f.bodyProps()}/>)
    await userEvent.click(await screen.findByRole('button', { name: 'Parent task' }))
    expect(f.navigate.mock.calls.at(-1)![0]).toMatchObject({ kind: 'session', source: { hostId: 'original-host', sessionId: 'hhpi:machine:source:codex:parent' } })
    await userEvent.click(screen.getByRole('button', { name: 'Message search' }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Message query' }), 'secret')
    await userEvent.click(screen.getByRole('button', { name: 'Search source' }))
    act(f.revoke)
    expect(screen.getByRole('alert')).toHaveTextContent('account or permission changed')
    await act(async () => { pending.resolve({ data: [{ thread: thread('private-old'), snippet: 'Old account private result' }], nextCursor: null }); await pending.promise })
    expect(screen.queryByText('Old account private result')).not.toBeInTheDocument()
    expect(vi.mocked(f.api.nativeCall!).mock.calls.every(([request]) => ['thread/search', 'thread/read', 'thread/list'].includes(request.method))).toBe(true)
})

test('source navigation stays inside More input controls and closes that popup after opening the same Pane tab', async () => {
    const f = fixture(() => { throw new Error('Opening navigation must not issue a native read') })
    Object.assign(f.binding.session, { metadata: { getSnapshot: () => ({ capabilities: { steer: false } }) } })
    const input = { phase: 'plain', draft: '', attachmentIds: [] }, session = { running: false }
    const props = { ...f.inputProps, useInput: (select: (value: typeof input) => unknown) => select(input),
        useSession: (select: (value: typeof session) => unknown) => select(session), inputActions: {},
        renderSlot: (name: string, owner: object) => name === 'hapi.source.composer-navigation' ? <f.Entry {...owner}/> : null,
    } as unknown as InputProps
    render(<SourceControls ctx={f.ctx} props={props} initial={{ model: null, effort: null, permission: null, serviceTier: null }}
        permissionCapable={false} data={null} loading={false} busy={false} pending={null} error={null} sourceLocked={false}
        refresh={async () => {}} apply={async () => false}/>)
    expect(screen.queryByRole('button', { name: 'Search source history' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'More input controls' }))
    expect(screen.getByRole('dialog', { name: 'More input controls' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Search source history' }))
    expect(f.openTab).toHaveBeenCalledOnce(); expect(f.openTab.mock.calls[0]![1].beside).toBeUndefined()
    expect(screen.queryByRole('dialog', { name: 'More input controls' })).not.toBeInTheDocument()
    expect(f.api.nativeCall).not.toHaveBeenCalled()
})

test('an exact navigation record crosses the originating Conversation and isolated plugin-view graphs in the same account', async () => {
    const origin = fixture(request => request.method === 'thread/search' ? { data: [{ thread: thread('found'), snippet: 'real origin result' }], nextCursor: null }
        : { thread: thread(String(request.params?.threadId)) })
    const viewer = fixture(() => { throw new Error('The viewer graph must retain the original source read owner') })
    const entry = render(<origin.Entry {...origin.entryProps}/>)
    await userEvent.click(screen.getByRole('button', { name: 'Search source history' })); entry.unmount()
    render(<viewer.Body {...origin.bodyProps()}/>)
    await userEvent.type(screen.getByRole('searchbox', { name: 'Message query' }), 'needle')
    await userEvent.click(screen.getByRole('button', { name: 'Search source' }))
    expect(await screen.findByText('real origin result')).toBeVisible()
    expect(viewer.api.nativeCall).not.toHaveBeenCalled()
    act(viewer.revoke)
    expect(screen.getByRole('alert')).toHaveTextContent('account or permission changed')
    expect(screen.queryByText('real origin result')).not.toBeInTheDocument()
})

test('a navigation record cannot cross an account or source-session boundary', async () => {
    const origin = fixture(() => { throw new Error('A stale record cannot read the original source') })
    const viewer = fixture(() => { throw new Error('A foreign viewer cannot dispatch source reads') })
    const entry = render(<origin.Entry {...origin.entryProps}/>)
    await userEvent.click(screen.getByRole('button', { name: 'Search source history' })); entry.unmount()
    viewer.replaceAccount()
    const body = render(<viewer.Body {...origin.bodyProps()}/>)
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeVisible()
    body.unmount()
    render(<origin.Body {...{ ...origin.bodyProps(), sessionId: 'hhpi:machine:source:codex:foreign' }}/>)
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(origin.api.nativeCall).not.toHaveBeenCalled()
    expect(viewer.api.nativeCall).not.toHaveBeenCalled()
})

test('registered approval dock uses the rendered binding rather than another canonical binding and retires settled cards', async () => {
    const approval: SourceApproval = { id: 'original-request', method: 'item/commandExecution/requestApproval', turnId: 'original-turn', itemId: 'original-item', params: { command: 'synthetic command', cwd: '/source' } }
    const listeners = new Set<() => void>()
    let metadata = { id: sessionId, sourceOnline: true, status: 'running', activeTurnId: 'original-turn', pendingRequests: [approval] as SourceApproval[] }
    const canonicalOperate = vi.fn(), operate = vi.fn(async (request: SourceOperation) => ({ sessionId, operationId: request.operationId, status: 'accepted', message: 'Source accepted original approval' }))
    const deliveries: readonly [] = [], snapshot = { removed: false }, empty = { getSnapshot: () => deliveries, subscribe: () => () => {} }
    const session = { sessionId, metadata: { getSnapshot: () => metadata, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } },
        getSnapshot: () => snapshot, subscribe: () => () => {}, controlStatus: { getSnapshot: () => null, subscribe: () => () => {} },
        projections: { faceOf: () => ({ getSnapshot: () => false, subscribe: () => () => {} }) }, deliveries: empty, operate }
    let Dock: ComponentType<any> | undefined
    const ctx = { locale: { getSnapshot: () => ({ active: 'en' }) }, sessions: { binding: () => ({ session: { operate: canonicalOperate } }) },
        slots: { inject(_name: string, install: () => () => void) { return install() }, register(_options: unknown, component: ComponentType<any>) { Dock = component; return () => {} } },
    } as unknown as Context
    const stop = installRemoteSourceControls(ctx); onTestFinished(stop)
    const BoundDock = Dock!
    render(<BoundDock {...{ sessionId, sessionBinding: { session } }}/>)
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(operate).toHaveBeenCalledOnce())
    expect(operate.mock.calls[0]![0]).toMatchObject({ sessionId, requestId: 'original-request', kind: 'approve', decision: 'accept' })
    expect(canonicalOperate).not.toHaveBeenCalled()
    act(() => { metadata = { ...metadata, pendingRequests: [] }; for (const listener of listeners) listener() })
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
})


test('registered current-conversation entry keeps explicit scope and opens the original native match before returning', async () => {
    const f = fixture(request => request.method === 'thread/searchOccurrences'
        ? { data: [{ turnId: 'original-turn', itemId: 'original-item', turnCursor: 'actual-source-cursor', snippet: 'known text', snippetMatchRange: { start: 0, end: 5 } }], nextCursor: null }
        : request.method === 'thread/read' ? { thread: thread(String(request.params?.threadId)) }
            : (() => { throw new Error('A current-conversation entry cannot issue full-source search') })())
    act(() => f.readCommits.publish({ hostId: 'original-host', paneId: 'actual-pane', sessionBinding: f.binding,
        position: { kind: 'hhpi', epoch: 'original-epoch', seq: 73 }, at: 100 }))
    const entry = render(<f.Entry {...f.entryProps}/>)
    expect(screen.getByRole('button', { name: 'Search source history' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Search this conversation' })); entry.unmount()
    expect(f.api.nativeCall).not.toHaveBeenCalled()
    render(<f.Body {...f.bodyProps()}/>)
    expect(screen.getByRole('radio', { name: 'Current conversation' })).toBeChecked()
    await userEvent.type(screen.getByRole('searchbox', { name: 'Message query' }), 'known')
    await userEvent.click(screen.getByRole('button', { name: 'Search conversation' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Open this match' }))
    expect(f.navigate.mock.calls.at(-1)![0]).toMatchObject({ kind: 'reading', source: { hostId: 'original-host', sessionId },
        position: { kind: 'native', turnId: 'original-turn', itemId: 'original-item' } })
    expect(f.navigate.mock.calls.at(-1)![2]).toEqual({ hostId: 'original-host', paneId: 'actual-pane', sessionId })
    await userEvent.click(screen.getByRole('button', { name: 'Return to origin' }))
    expect(f.navigate.mock.calls.at(-1)![0]).toMatchObject({ kind: 'reading', source: { sessionId }, position: { kind: 'hhpi', epoch: 'original-epoch', seq: 73 } })
    expect(vi.mocked(f.api.nativeCall!).mock.calls.every(([request]) => request.method !== 'thread/search' && request.params?.includeTurns !== true)).toBe(true)
})
