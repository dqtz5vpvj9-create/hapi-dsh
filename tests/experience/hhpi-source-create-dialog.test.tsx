/** Production workspace controller, modal and creation owner; source RPC and Session service are boundaries. */
import { useSyncExternalStore } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkspaceController, sessionResourceId, type WorkspaceOptions } from '../../src/client/controller.ts'
import { SourceCreateDialog } from '../../src/client/source-create-dialog.tsx'
import { RemoteCreationController } from '../../src/client/remote-creation.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { SourceSession } from '../../src/remote/protocol.ts'
import type { SourceDirectoryIdentity, SourceDirectoryListing } from '../../src/workspace/source-api.ts'
import { memoryOperations } from '../fixtures/operation-transactions.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives)

function directoryInput() {
    if (!screen.queryByLabelText('Working directory')) fireEvent.click(screen.getByRole('button', { name: 'Enter a path (optional)' }))
    return screen.getByLabelText('Working directory')
}

function directoryPage(source: SourceDirectoryIdentity, path = 'C:\\Users\\owned'): SourceDirectoryListing {
    const drive = path.startsWith('D:') ? 'D:\\' : 'C:\\'
    return { source, roots: [{ name: 'C:\\', path: 'C:\\', hidden: false }, { name: 'D:\\', path: 'D:\\', hidden: false }], listing: {
        path, home: 'C:\\Users\\owned', crumbs: [{ name: drive, path: drive, hidden: false }, ...(path === drive ? [] : [{ name: path.split('\\').at(-1)!, path, hidden: false }])],
        entries: path.endsWith('Projects') ? [] : [{ name: 'Projects', path: drive + 'Projects', hidden: false }], truncated: false,
    } }
}

test('the central forwarded Windows Agent browses its exact paired owner, chooses another drive folder and creates without typing', async () => {
    const local = sourceHost('central-machine'), windows = sourceHost('windows-machine')
    const catalog = await windows.api.catalog(); if (!catalog.ok) throw new Error('fixture catalog')
    vi.mocked(local.api.catalog).mockResolvedValue(catalog)
    vi.mocked(local.api.create).mockImplementation(async request => ({ ok: true, value: { sourceId: request.sourceId, operationId: request.operationId, status: 'accepted', message: 'Created', session: windows.session } }))
    vi.mocked(local.api.resolve!).mockResolvedValue({ ok: true, value: windows.session })
    const centralBrowse = vi.fn(), hostBrowse = vi.fn(), source = { machineId: 'windows-machine', sourceId: 'same-source', engine: 'codex' }
    const windowsBrowse = vi.fn(async (request: SourceDirectoryIdentity & { path?: string }) => ({ ok: true as const, value: directoryPage(source, request.path) }))
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: { ...local.navigation, listDirectory: hostBrowse }, sourceCreation: local.sourceCreation,
        sourceDirectories: centralBrowse, storageKey: 'forwarded-source-folder-picker' })
    controller.setHostDiscovery([{ id: 'windows-machine', label: 'Windows source', online: true }])
    let remove = () => {}
    const open = vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {})
    controller.requestNewSession('source', { hostId: 'local', directory: '' })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        fireEvent.click(await screen.findByRole('button', { name: 'Choose folder' }))
        await waitFor(() => expect(controller.pendingDirectoryMachineId).toBe('windows-machine'))
        expect(centralBrowse).not.toHaveBeenCalled(); expect(windowsBrowse).not.toHaveBeenCalled()
        act(() => { remove = controller.addHost({ id: 'windows-machine', label: 'Windows source', sessions: windows.sessions, navigation: windows.navigation,
            sourceCreation: windows.sourceCreation, sourceDirectories: windowsBrowse, renderConversation: () => null }) })
        await screen.findByRole('button', { name: 'D:\\' }); fireEvent.click(screen.getByRole('button', { name: 'D:\\' }))
        await waitFor(() => expect(windowsBrowse).toHaveBeenLastCalledWith({ ...source, path: 'D:\\' }, expect.any(AbortSignal)))
        fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
        await screen.findByRole('button', { name: 'Parent folder' }); fireEvent.click(screen.getByRole('button', { name: 'Parent folder' }))
        await waitFor(() => expect(windowsBrowse).toHaveBeenLastCalledWith({ ...source, path: 'D:\\' }, expect.any(AbortSignal)))
        fireEvent.click(screen.getByRole('button', { name: 'Projects' })); await screen.findByRole('button', { name: 'Parent folder' })
        fireEvent.click(screen.getByRole('button', { name: 'Select this folder' }))
        expect(screen.queryByLabelText('Working directory')).not.toBeInTheDocument(); expect(screen.getByText('D:\\Projects')).toBeVisible()
        expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled(); expect(local.api.create).not.toHaveBeenCalled()
        expect(centralBrowse).not.toHaveBeenCalled(); expect(hostBrowse).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Create' })); await waitFor(() => expect(open).toHaveBeenCalledWith(sessionResourceId('local', windows.session.id)))
        expect(local.api.create).toHaveBeenCalledExactlyOnceWith({ sourceId: 'same-source', cwd: 'D:\\Projects', operationId: expect.any(String) })
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); windows.creation.dispose() }
})

test.each(['source', 'machine', 'close'] as const)('a late folder listing cannot change a %s replacement creation view', async action => {
    const local = sourceHost('local-machine'), remote = sourceHost('remote-machine'), source = { machineId: 'local-machine', sourceId: 'same-source', engine: 'codex' }
    const catalog = await local.api.catalog(); if (!catalog.ok) throw new Error('fixture catalog')
    vi.mocked(local.api.catalog).mockResolvedValue({ ok: true, value: { ...catalog.value, sources: [...catalog.value.sources, { ...catalog.value.sources[0]!, id: 'other-source' }] } })
    let finish!: (result: { ok: true; value: SourceDirectoryListing }) => void, readSignal: AbortSignal | undefined
    const listing = vi.fn(async (_request: unknown, signal?: AbortSignal) => { readSignal = signal; return new Promise<{ ok: true; value: SourceDirectoryListing }>(resolve => { finish = resolve }) })
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, sourceDirectories: listing, storageKey: 'folder-cancellation-'+action })
    const remove = controller.addHost({ id: 'remote', label: 'Other machine', sessions: remote.sessions, navigation: remote.navigation, sourceCreation: remote.sourceCreation, renderConversation: () => null })
    controller.requestNewSession('source', { hostId: 'local', directory: '' }); const view = render(<CreationFlow controller={controller}/>)
    try {
        fireEvent.click(await screen.findByRole('button', { name: 'Choose folder' })); await waitFor(() => expect(listing).toHaveBeenCalledTimes(1))
        if (action === 'source') { fireEvent.click(screen.getByRole('button', { name: /^Connection / })); fireEvent.click(screen.getAllByRole('menuitem')[1]!) }
        else if (action === 'machine') { fireEvent.click(screen.getByRole('button', { name: /^Machine / })); fireEvent.click(screen.getByRole('menuitem', { name: 'Other machine' })) }
        else act(() => controller.closeNewSession())
        expect(readSignal?.aborted).toBe(true)
        await act(async () => finish({ ok: true, value: directoryPage(source, 'C:\\stale-folder') }))
        expect(screen.queryByText('C:\\stale-folder')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Select this folder' })).not.toBeInTheDocument()
        expect(local.api.create).not.toHaveBeenCalled(); expect(remote.api.create).not.toHaveBeenCalled()
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})

test('an unavailable inherited directory can recover through Home without typing a path', async () => {
    const local = sourceHost('local-machine'), source = { machineId: 'local-machine', sourceId: 'same-source', engine: 'codex' }
    const listing = vi.fn(async (request: SourceDirectoryIdentity & { path?: string }) => {
        if (request.path) throw new Error('The old directory is unavailable')
        return { ok: true as const, value: directoryPage(source) }
    })
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, sourceDirectories: listing, storageKey: 'folder-home-recovery' })
    controller.requestNewSession('source', { hostId: 'local', sourceSessionId: local.session.id, directory: 'C:\\removed' }); const view = render(<CreationFlow controller={controller}/>)
    try {
        fireEvent.click(await screen.findByRole('button', { name: 'Choose folder' })); await screen.findByRole('alert')
        fireEvent.click(screen.getByRole('button', { name: 'Home' })); await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
        fireEvent.click(screen.getByRole('button', { name: 'Select this folder' })); expect(screen.getByText('C:\\Users\\owned')).toBeVisible()
        expect(listing).toHaveBeenLastCalledWith(source, expect.any(AbortSignal)); expect(local.api.create).not.toHaveBeenCalled()
    } finally { view.unmount(); controller.dispose(); local.creation.dispose() }
})

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
    const sessions = { list, refresh: async () => {}, resolveSession: vi.fn(async () => {}), create: vi.fn(async (request: { sessionId: string }) => request.sessionId) } as unknown as WorkspaceOptions['sessions']
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
        fireEvent.click(await screen.findByRole('button', { name: 'Open last created conversation' }))
        await waitFor(() => expect(open).toHaveBeenCalledWith(sessionResourceId('remote', remote.session.id)))
        expect(remote.api.create).toHaveBeenCalledTimes(1)
        expect(remote.api.resolve).toHaveBeenCalledTimes(2)
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})

function CreationFlow({ controller }: { controller: WorkspaceController }) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    return snapshot.creation ? <SourceCreateDialog controller={controller} language="en"/> : null
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
        expect(await screen.findByRole('button', { name: 'Agent DSH' })).toBeVisible()
        expect(view.container.querySelector('select')).not.toBeInTheDocument()
        expect(screen.queryByText(/no available native sources/)).not.toBeInTheDocument()
        expect(controller.getSnapshot().creationContext?.hostId).toBe('imac')
        expect(screen.getByRole('button', { name: 'Machine lis-imac' })).toBeVisible()
        expect(directoryInput()).toHaveValue('/owned/isolated-create')
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await waitFor(() => expect(open).toHaveBeenCalled())
        expect(workspace).toHaveBeenCalledExactlyOnceWith({ path: '/owned/isolated-create' })
        expect(create).toHaveBeenCalledExactlyOnceWith({ sessionId: expect.any(String), workspaceId: 'owned-imac-workspace' })
        expect(open).toHaveBeenCalledWith(sessionResourceId('imac', create.mock.calls[0]![0].sessionId))
        expect(remote.api.create).not.toHaveBeenCalled(); expect(local.api.create).not.toHaveBeenCalled()
        expect(controller.getSnapshot().creation).toBeNull()
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})

test('an old accepted intent opens a fresh form; successful open completes it and the next new-chat entry stays fresh', async () => {
    const local = sourceHost('legacy-machine')
    const catalog = await local.api.catalog(); if (!catalog.ok) throw new Error('fixture catalog')
    await local.creation.start(catalog.value.sources[0]!, '/previous')
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, storageKey: 'legacy-accepted-create' })
    const open = vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {})
    controller.requestNewSession('choose', { hostId: 'local', directory: '/new-project', sourceSessionId: local.session.id })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())
        expect(directoryInput()).toHaveValue('/new-project')
        expect(screen.queryByRole('button', { name: 'Create another conversation' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Open last created conversation' })).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(controller.getSnapshot().creation).toBeNull())
        expect(local.api.create).toHaveBeenCalledTimes(2)
        const requests = vi.mocked(local.api.create).mock.calls.map(([request]) => request)
        expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId)
        expect(local.creation.getSnapshot().record).toBeNull()
        act(() => controller.requestNewSession('choose', { hostId: 'local', directory: '/third-project', sourceSessionId: local.session.id }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())
        expect(screen.queryByRole('button', { name: /Open.*created/ })).not.toBeInTheDocument()
        expect(local.api.create).toHaveBeenCalledTimes(2) // opening another form cannot create anything
    } finally { view.unmount(); controller.dispose(); local.creation.dispose() }
})

test('Windows directory choices belong to its exact source, and changing machine keeps the chosen Agent explicit', async () => {
    const local = sourceHost('local-machine'), windows = sourceHost('windows-machine'), mac = sourceHost('mac-machine')
    const windowsCatalog = await windows.api.catalog(); if (!windowsCatalog.ok) throw new Error('fixture catalog')
    vi.mocked(windows.api.catalog).mockResolvedValue({ ok: true, value: { ...windowsCatalog.value,
        sources: [...windowsCatalog.value.sources, { id: 'other-source', machineId: 'local-machine', engine: 'codex', online: true, create: true }], sessions: [
        { ...windows.session, cwd: 'C:\\Users\\owned\\project' },
        { ...windows.session, machineId: 'local-machine', cwd: '/home/linux/project' },
        { ...windows.session, sourceId: 'other-source', cwd: 'D:\\not-this-agent' },
    ] } })
    vi.mocked(mac.api.catalog).mockResolvedValue({ ok: true, value: { protocol: 1, legacyHapi: false, sources: [], sessions: [] } })
    const browse = vi.fn()
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, storageKey: 'windows-create-directory' })
    controller.setMachines([{ id: 'windows-machine', label: 'Windows machine', online: true }, { id: 'local-machine', label: 'Linux machine', online: true }])
    const removeWin = controller.addHost({ id: 'windows', label: 'Windows machine', sessions: windows.sessions, navigation: { ...windows.navigation, listDirectory: browse }, sourceCreation: windows.sourceCreation, renderConversation: () => null })
    const removeMac = controller.addHost({ id: 'mac', label: 'lis-imac', sessions: mac.sessions, navigation: mac.navigation, workspaces: { create: vi.fn() } as never, sourceCreation: mac.sourceCreation, renderConversation: () => null })
    controller.requestNewSession('source', { hostId: 'windows', directory: '', sourceSessionId: windows.session.id })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        await screen.findByRole('button', { name: 'Agent Codex' })
        fireEvent.click(screen.getByRole('button', { name: 'Connection Codex · Windows machine' }))
        expect(screen.getByRole('menuitem', { name: 'Codex · Linux machine' })).toBeVisible()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Codex · Windows machine' }))
        expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Recent directories on this Agent Choose a directory' }))
        expect(screen.getAllByRole('menuitem')).toHaveLength(1)
        expect(screen.getByRole('menuitem', { name: 'C:\\Users\\owned\\project' })).toBeVisible()
        expect(screen.queryByText('/home/linux/project')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('menuitem', { name: 'C:\\Users\\owned\\project' }))
        expect(directoryInput()).toHaveValue('C:\\Users\\owned\\project')
        expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
        expect(browse).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Machine Windows machine' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'lis-imac' }))
        await screen.findByText('This machine cannot create Codex conversations. Choose another Agent or machine.')
        expect(screen.getByRole('button', { name: 'Agent Codex (unavailable on this machine)' })).toBeVisible()
        expect(screen.queryByLabelText('Working directory')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Agent Codex (unavailable on this machine)' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'DSH' }))
        expect(screen.getByRole('button', { name: 'Agent DSH' })).toBeVisible()
        expect(directoryInput()).toHaveValue('')
        expect(windows.api.create).not.toHaveBeenCalled(); expect(mac.api.create).not.toHaveBeenCalled()
    } finally { view.unmount(); removeWin(); removeMac(); controller.dispose(); local.creation.dispose(); windows.creation.dispose(); mac.creation.dispose() }
})

test('forwarded native cwd is not inherited by ordinary DSH on the serving Host', async () => {
    const local = sourceHost('windows-machine')
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation,
        workspaces: { create: vi.fn() } as never, storageKey: 'forwarded-directory-separation' })
    controller.requestNewSession('dsh', { hostId: 'local', directory: 'C:\\Users\\owned\\project', sourceSessionId: local.session.id })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        await screen.findByRole('button', { name: 'Agent DSH' })
        expect(directoryInput()).toHaveValue('')
        expect(view.container.querySelector('option[value="C:\\\\Users\\\\owned\\\\project"]')).toBeNull()
    } finally { view.unmount(); controller.dispose(); local.creation.dispose() }
})

test('native creation never inherits an unidentified DSH path and a removed source can choose the current exact source directory', async () => {
    const local = sourceHost('native-machine'), catalog = await local.api.catalog(); if (!catalog.ok) throw new Error('fixture catalog')
    vi.mocked(local.api.catalog).mockResolvedValue({ ok: true, value: { ...catalog.value, sessions: [{ ...local.session, cwd: 'C:\\Users\\owned\\current' }] } })
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, storageKey: 'stale-source-directory' })
    controller.requestNewSession('source', { hostId: 'local', directory: '/home/linux/ordinary-dsh' })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        await screen.findByRole('button', { name: 'Create' })
        expect(directoryInput()).toHaveValue('')
        act(() => controller.closeNewSession())
        act(() => controller.requestNewSession('source', { hostId: 'local', directory: '/wrong/removed', sourceSessionId: 'hhpi:native-machine:removed:codex:old' }))
        await screen.findByRole('button', { name: 'Create' })
        expect(directoryInput()).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: 'Recent directories on this Agent Choose a directory' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'C:\\Users\\owned\\current' }))
        expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await waitFor(() => expect(local.api.create).toHaveBeenCalledTimes(1))
        expect(vi.mocked(local.api.create).mock.calls[0]![0]).toMatchObject({ sourceId: 'same-source', cwd: 'C:\\Users\\owned\\current' })
    } finally { view.unmount(); controller.dispose(); local.creation.dispose() }
})

test('offline native sources do not block the same machine’s DSH Agent', async () => {
    const local = sourceHost('local'), remote = sourceHost('offline-native')
    const result = await remote.api.catalog(); if (!result.ok) throw new Error('fixture catalog')
    vi.mocked(remote.api.catalog).mockResolvedValue({ ok: true, value: { ...result.value, sources: result.value.sources.map(source => ({ ...source, online: false })) } })
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, storageKey: 'offline-native-dsh' })
    const remove = controller.addHost({ id: 'remote', label: 'Other machine', sessions: remote.sessions, navigation: remote.navigation, workspaces: { create: vi.fn() } as never, sourceCreation: remote.sourceCreation, renderConversation: () => null })
    controller.requestNewSession('choose', { hostId: 'remote', directory: '' })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        expect(await screen.findByRole('button', { name: 'Agent DSH' })).toBeVisible()
        expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
        expect(remote.api.create).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Agent DSH' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Codex (unavailable)' }))
        await screen.findByText('This machine cannot create Codex conversations. Choose another Agent or machine.')
        vi.mocked(remote.api.catalog).mockResolvedValue({ ok: true, value: result.value })
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(directoryInput()).toBeVisible())
        expect(screen.getByRole('button', { name: 'Agent Codex' })).toBeVisible()
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})

test('an unknown native creation remains protected while an unrelated DSH Agent can be selected', async () => {
    const local = sourceHost('unknown-create')
    const result = await local.api.catalog(); if (!result.ok) throw new Error('fixture catalog')
    vi.mocked(local.api.create).mockRejectedValue(new Error('Synthetic lost acknowledgement'))
    await local.creation.start(result.value.sources[0]!, '/original')
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation,
        workspaces: { create: vi.fn() } as never, storageKey: 'unknown-native-other-agent' })
    controller.requestNewSession('source', { hostId: 'local', directory: '/other', sourceSessionId: local.session.id })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        await screen.findByRole('button', { name: 'Check original result' })
        expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Agent Codex' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'DSH' }))
        expect(directoryInput()).toBeEnabled()
        expect(directoryInput()).toHaveValue('')
        expect(local.creation.getSnapshot().record?.phase).toBe('confirming')
        expect(local.creation.getSnapshot().record?.request.cwd).toBe('/original')
        expect(local.api.create).toHaveBeenCalledTimes(1)
    } finally { view.unmount(); controller.dispose(); local.creation.dispose() }
})

test('cancelled native creation cannot steal focus or close the next machine form, and its accepted result remains reachable', async () => {
    const local = sourceHost('first'), other = sourceHost('second'), gate = Promise.withResolvers<void>()
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, storageKey: 'cancelled-native-create' })
    const remove = controller.addHost({ id: 'other', label: 'Second machine', sessions: other.sessions, navigation: other.navigation, sourceCreation: other.sourceCreation, renderConversation: () => null })
    const open = vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {}), created = vi.fn(), stop = controller.subscribeCreated(created)
    vi.mocked(local.sessions.resolveSession!).mockReturnValueOnce(gate.promise)
    controller.requestNewSession('source', { hostId: 'local', directory: '/first', sourceSessionId: local.session.id })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        fireEvent.click(await screen.findByRole('button', { name: 'Create' }))
        await waitFor(() => expect(local.sessions.resolveSession).toHaveBeenCalled())
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        act(() => controller.requestNewSession('source', { hostId: 'other', directory: '/second', sourceSessionId: other.session.id }))
        await screen.findByRole('button', { name: 'Machine Second machine' })
        await act(async () => { gate.resolve(); await gate.promise })
        expect(open).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled()
        expect(controller.getSnapshot().creation).toBe('source'); expect(controller.getSnapshot().creationContext?.hostId).toBe('other')
        expect(local.creation.getSnapshot().record?.phase).toBe('accepted')
        expect(local.api.create).toHaveBeenCalledTimes(1)
    } finally { view.unmount(); stop(); remove(); controller.dispose(); local.creation.dispose(); other.creation.dispose() }
})

test('a late official DSH create result cannot open or close a replacement form', async () => {
    const local = sourceHost('local'), remote = sourceHost('remote'), gate = Promise.withResolvers<string>()
    const create = vi.fn(() => gate.promise)
    Object.assign(local.sessions, { create })
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, storageKey: 'cancelled-dsh-create', workspaces: { create: vi.fn(async () => ({ workspaceId: 'workspace' })) } as never })
    const remove = controller.addHost({ id: 'remote', label: 'Second machine', sessions: remote.sessions, navigation: remote.navigation, workspaces: { create: vi.fn() } as never, renderConversation: () => null })
    const open = vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {}), created = vi.fn(), stop = controller.subscribeCreated(created)
    controller.requestNewSession('dsh', { hostId: 'local', directory: '/first' })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        fireEvent.click(await screen.findByRole('button', { name: 'Create' }))
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        act(() => controller.requestNewSession('dsh', { hostId: 'remote', directory: '/second' }))
        await screen.findByRole('button', { name: 'Machine Second machine' })
        await act(async () => { gate.resolve('exact-original-session'); await gate.promise })
        expect(open).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled()
        expect(controller.getSnapshot().creationContext?.hostId).toBe('remote')
        expect(directoryInput()).toHaveValue('/second')
    } finally { view.unmount(); stop(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})

test('an old DSH owner completing after same-ID reconnect cannot open its result', async () => {
    const local = sourceHost('local'), remote = sourceHost('old-owner'), replacement = sourceHost('new-owner')
    const gate = Promise.withResolvers<string>(), create = vi.fn(() => gate.promise)
    Object.assign(remote.sessions, { create })
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, storageKey: 'create-host-owner-replaced' })
    const workspace = { create: vi.fn(async () => ({ workspaceId: 'owned-workspace' })) } as never
    let remove = controller.addHost({ id: 'remote', label: 'Same machine', sessions: remote.sessions, navigation: remote.navigation, workspaces: workspace, renderConversation: () => null })
    const open = vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {})
    const pending = controller.createSession('remote', '/owned', 'exact-owned-session')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    remove(); remove = controller.addHost({ id: 'remote', label: 'Same machine', sessions: replacement.sessions, navigation: replacement.navigation, workspaces: workspace, renderConversation: () => null })
    gate.resolve('exact-owned-session'); await expect(pending).rejects.toThrow('original conversation was kept')
    expect(open).not.toHaveBeenCalled()
    remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose(); replacement.creation.dispose()
})

test('a failed source list is actionable and refresh recovers native creation without replay or placeholder-only menus', async () => {
    const local = sourceHost('local-machine'), remote = sourceHost('remote-machine')
    vi.mocked(remote.api.catalog).mockRejectedValueOnce(new Error('RPC transport failure raw detail'))
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceCreation: local.sourceCreation, storageKey: 'source-catalog-retry' })
    const remove = controller.addHost({ id: 'remote', label: 'Source machine', sessions: remote.sessions, navigation: remote.navigation, sourceCreation: remote.sourceCreation, renderConversation: () => null })
    vi.spyOn(controller, 'openCreatedSession').mockImplementation(() => {})
    controller.requestNewSession('source', { hostId: 'remote', directory: '/repo', sourceSessionId: remote.session.id })
    const view = render(<CreationFlow controller={controller}/>)
    try {
        expect(await screen.findByRole('alert')).toHaveTextContent('Agents on this machine could not be loaded. Retry to reconnect.')
        expect(screen.queryByText('RPC transport failure raw detail')).not.toBeInTheDocument()
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
        expect(remote.api.create).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Agent Codex' }))
        expect(screen.getAllByRole('menuitem')).toHaveLength(1)
        expect(screen.queryByText('Choose a source')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
        expect(directoryInput()).toHaveValue('/repo')
        fireEvent.change(directoryInput(), { target: { value: ' ' } })
        fireEvent.submit(view.container.querySelector('form')!)
        expect(remote.api.create).not.toHaveBeenCalled()
        fireEvent.change(directoryInput(), { target: { value: '/repo' } })
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
        expect(directoryInput()).toBeEnabled()
        expect(listDirectory).not.toHaveBeenCalled(); expect(pickDirectory).not.toHaveBeenCalled()
        expect(createWorkspace).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
        initializeDefault.mockResolvedValueOnce({ workspaceId: 'official-default' })
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith({ sessionId: expect.any(String), workspaceId: 'official-default' }))
        expect(createWorkspace).not.toHaveBeenCalled()
        expect(listDirectory).not.toHaveBeenCalled(); expect(pickDirectory).not.toHaveBeenCalled()
    } finally { view.unmount(); remove(); controller.dispose(); local.creation.dispose(); remote.creation.dispose() }
})
