/** Production workspace controller, modal and creation owner; source RPC and Session service are boundaries. */
import { useSyncExternalStore } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkspaceController, sessionResourceId, type WorkspaceOptions } from '../../src/client/controller.ts'
import { SourceCreateDialog } from '../../src/client/source-create-dialog.tsx'
import { RemoteCreationController } from '../../src/client/remote-creation.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { SourceSession } from '../../src/remote/protocol.ts'
import { DshSessionForm } from '../../src/client/dsh-session.tsx'
import { en } from '../../src/client/locales.ts'
import { memoryOperations } from '../fixtures/operation-transactions.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives)

function sourceHost(id: string) {
    const session: SourceSession = { id: `hhpi:${id}:same-source:codex:created`, machineId: id, sourceId: 'same-source', engine: 'codex', nativeId: 'created',
        title: 'Created', cwd: '/repo', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: true, files: true } }
    const directory = { id: 'same-source', machineId: id, engine: 'codex', online: true, create: true }
    const api = { catalog: vi.fn(async () => ({ ok: true, value: { protocol: 1, legacyHapi: false, sources: [directory], sessions: [] } })),
        create: vi.fn(async request => ({ ok: true, value: { sourceId: directory.id, operationId: request.operationId, status: 'accepted', message: 'Created', session } })),
        resolve: vi.fn(async () => ({ ok: true, value: session })) } as unknown as HhpiRemoteApi
    const creation = new RemoteCreationController(api, { storage: localStorage, scope: `dialog-${id}` }, { createLedger: memoryOperations })
    const state = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
    const list = { getSnapshot: () => state, subscribe: () => () => {} }
    const sessions = { list, refresh: async () => {}, resolveSession: vi.fn(async () => {}) } as unknown as WorkspaceOptions['sessions']
    const navigation = {} as WorkspaceOptions['navigation']
    return { session, api, creation, sessions, navigation, sourceCreation: { api, list, createController: () => creation } as unknown as NonNullable<WorkspaceOptions['sourceCreation']> }
}

test('source creation uses the selected Host despite identical source IDs and retains its exact result after reconnect', async () => {
    const local = sourceHost('local-machine'), remote = sourceHost('remote-machine')
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, storageKey: 'source-dialog' })
    const remoteHost = { id: 'remote', label: 'Other machine', sessions: remote.sessions, navigation: remote.navigation, sourceCreation: remote.sourceCreation, renderConversation: () => null }
    let remove = controller.addHost(remoteHost)
    const open = vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {})
    controller.requestNewSession('source', { hostId: 'remote', directory: '/repo', sourceSessionId: remote.session.id })
    const slow = Promise.withResolvers<void>()
    vi.mocked(remote.sessions.resolveSession!).mockReturnValueOnce(slow.promise)
    const view = render(<SourceCreateDialog controller={controller} language="en"/>)
    try {
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await waitFor(() => expect(remote.sessions.resolveSession).toHaveBeenCalled())
        expect(local.api.create).not.toHaveBeenCalled()
        act(remove)
        await act(async () => { slow.resolve(); await slow.promise })
        expect(open).not.toHaveBeenCalled()
        act(() => { remove = controller.addHost({ ...remoteHost }) })
        fireEvent.click(await screen.findByRole('button', { name: 'Open created conversation' }))
        await waitFor(() => expect(open).toHaveBeenCalledWith(sessionResourceId('remote', remote.session.id)))
        expect(remote.api.create).toHaveBeenCalledTimes(1)
        expect(remote.api.resolve).toHaveBeenCalledTimes(2)
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})

function CreationFlow({ controller }: { controller: WorkspaceController }) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    return snapshot.creation === 'dsh'
        ? <DshSessionForm controller={controller} close={controller.closeNewSession} t={key => en[key]}/>
        : snapshot.creation === 'source' ? <SourceCreateDialog controller={controller} language="en"/> : null
}

test('a Host with no native sources offers the real DSH path on that same Host without empty fields', async () => {
    const local = sourceHost('local-machine'), remote = sourceHost('imac-machine')
    vi.mocked(remote.api.catalog).mockResolvedValue({ ok: true, value: { protocol: 1, legacyHapi: false, sources: [], sessions: [] } })
    const create = vi.fn(async (options: { sessionId: string; workspaceId: string }) => options.sessionId), workspace = vi.fn(async () => ({ workspaceId: 'owned-imac-workspace' }))
    Object.assign(remote.sessions, { create })
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, storageKey: 'empty-source-dialog' })
    const remove = controller.addHost({ id: 'imac', label: 'lis-imac', sessions: remote.sessions, navigation: remote.navigation,
        workspaces: { create: workspace } as never, sourceCreation: remote.sourceCreation, renderConversation: () => null })
    const open = vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {})
    controller.requestNewSession('source', { hostId: 'imac', directory: '/owned/isolated-create' })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        expect(await screen.findByText(/This Host has no available native sources/)).toBeVisible()
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Working directory')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'New DSH conversation' }))
        expect(controller.getSnapshot().creationContext?.hostId).toBe('imac')
        expect(screen.getByRole('button', { name: 'Machine lis-imac' })).toBeVisible()
        expect(screen.getByLabelText('Working directory')).toHaveValue('/owned/isolated-create')
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await waitFor(() => expect(open).toHaveBeenCalled())
        expect(workspace).toHaveBeenCalledExactlyOnceWith({ path: '/owned/isolated-create' })
        expect(create).toHaveBeenCalledExactlyOnceWith({ sessionId: expect.any(String), workspaceId: 'owned-imac-workspace' })
        expect(open).toHaveBeenCalledWith(sessionResourceId('imac', create.mock.calls[0]![0].sessionId))
        expect(remote.api.create).not.toHaveBeenCalled(); expect(local.api.create).not.toHaveBeenCalled()
        expect(controller.getSnapshot().creation).toBeNull()
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})

test('a failed source list is actionable and refresh recovers native creation without replay or placeholder-only menus', async () => {
    const local = sourceHost('local-machine'), remote = sourceHost('remote-machine')
    vi.mocked(remote.api.catalog).mockRejectedValueOnce(new Error('RPC transport failure raw detail'))
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, storageKey: 'source-catalog-retry' })
    const remove = controller.addHost({ id: 'remote', label: 'Source machine', sessions: remote.sessions, navigation: remote.navigation, sourceCreation: remote.sourceCreation, renderConversation: () => null })
    vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {})
    controller.requestNewSession('source', { hostId: 'remote', directory: '/repo' })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        expect(await screen.findByRole('alert')).toHaveTextContent('Sources on this Host could not be loaded. Refresh to retry.')
        expect(screen.queryByText('RPC transport failure raw detail')).not.toBeInTheDocument()
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
        expect(remote.api.create).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Source Codex · same-source' }))
        expect(screen.getAllByRole('menuitem')).toHaveLength(1)
        expect(screen.queryByText('Choose a source')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Codex · same-source' }))
        expect(screen.getByLabelText('Working directory')).toHaveValue('/repo')
        fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: ' ' } })
        fireEvent.submit(view.container.querySelector('form')!)
        expect(remote.api.create).not.toHaveBeenCalled()
        fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/repo' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await waitFor(() => expect(remote.api.create).toHaveBeenCalledOnce())
        expect(local.api.create).not.toHaveBeenCalled()
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})


test('a native-only directory Host uses its explicit default service and stays editable when no default exists', async () => {
    const local = sourceHost('local'), remote = sourceHost('native-picker')
    const listDirectory = vi.fn(async () => { throw new Error('directory-picker/unavailable: native') })
    const pickDirectory = vi.fn()
    const initializeDefault = vi.fn(async (): Promise<{ workspaceId: string } | undefined> => undefined)
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'explicit-workspace' }))
    const create = vi.fn(async (request: { sessionId: string }) => request.sessionId)
    Object.assign(remote.sessions, { create })
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, storageKey: 'native-picker-create' })
    const remove = controller.addHost({ id: 'native-picker', label: 'lis-imac', sessions: remote.sessions,
        navigation: { ...remote.navigation, listDirectory, pickDirectory }, directoryBrowsing: false,
        workspaces: { create: createWorkspace, initializeDefault } as never, renderConversation: () => null })
    vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {})
    controller.requestNewSession('dsh', { hostId: 'native-picker', directory: '' })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        expect(screen.queryByRole('button', { name: 'Browse directories' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Enter a working directory on this machine.')
        expect(screen.getByLabelText('Working directory')).toBeEnabled()
        expect(listDirectory).not.toHaveBeenCalled(); expect(pickDirectory).not.toHaveBeenCalled()
        expect(createWorkspace).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
        initializeDefault.mockResolvedValueOnce({ workspaceId: 'official-default' })
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith({ sessionId: expect.any(String), workspaceId: 'official-default' }))
        expect(createWorkspace).not.toHaveBeenCalled()
        expect(listDirectory).not.toHaveBeenCalled(); expect(pickDirectory).not.toHaveBeenCalled()
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})
