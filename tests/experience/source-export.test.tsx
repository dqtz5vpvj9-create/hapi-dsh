/** Production sidebar/dialog/export walk. Session catalogs, history RPC and browser download are explicit boundaries. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, onTestFinished, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ReactNode } from 'react'
import type { SessionListState, SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceController, sessionResourceId, type WorkspaceHost, type WorkspaceOptions } from '../../src/client/controller.ts'
import { SessionSidebar } from '../../src/client/ui.tsx'
import { WorkspaceSourceExportPanel } from '../../src/client/source-export.tsx'
import { createSessionSourceExporter, type SourceExportApi } from '../../src/client/source-export-state.ts'
import type { HapiRemoteApi } from '../../src/client-api.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { SourcePage, SourceSession } from '../../src/remote/protocol.ts'
import { en, type WorkspaceTranslate } from '../../src/client/locales.ts'
import type { SessionSidebarProps } from '../../src/client/slots.ts'

// Unused native tool panels import the public primitives. Export and sidebar
// state remain production code; this test does not assert their presentation.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => children,
    CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))
const t: WorkspaceTranslate = key => en[key]
const workspaces = { archivedSessionIds: [], pinnedSessionIds: [] }
const event = (seq: number) => ({ type: 'event' as const, event: { type: 'user/message', seq, time: seq + 1,
    data: { role: 'user', content: [{ type: 'text', text: `original-${seq}` }] } } })

function host(id: string, sessionId: string, exportApi?: SourceExportApi) {
    const state: SessionListState = { ids: [sessionId as SessionId], byId: { [sessionId]: { id: sessionId as SessionId,
        displayTitle: `Original ${id}`, running: false, blank: false, updatedAt: 1, retainedBy: {}, cwd: '/source' } }, phase: 'ready', projectionsBySession: {} }
    const list = { getSnapshot: () => state, subscribe: () => () => {} }, refresh = vi.fn(async () => {})
    const sessions = { list, refresh } as unknown as WorkspaceOptions['sessions'], navigation = {} as WorkspaceOptions['navigation']
    const host: WorkspaceHost = { id, label: id, sessions, navigation, renderConversation: () => null, ...(exportApi ? { sourceExporter: exportApi } : {}) }
    return { ...host, state, refresh }
}
function workspace(remote: ReturnType<typeof host>, localExporter: SourceExportApi = { sourceExport: vi.fn(async () => { throw new Error('The local exporter must not handle a foreign source') }) }) {
    const local = host('local', 'ordinary-local', localExporter)
    const controller = new WorkspaceController({ sessions: local.sessions, navigation: local.navigation, sourceExporter: local.sourceExporter!, storage: localStorage, storageKey: 'export-ui' })
    const remove = remote.id === 'local' ? () => {} : controller.addHost(remote)
    onTestFinished(() => { remove(); controller.dispose() })
    return { controller, remove, localExporter }
}
function browserDownload() {
    const blobs: Blob[] = [], create = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:source-export-${blobs.length}` }), revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    return { blobs, create, revoke, click }
}
function viewport() {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    // jsdom has no modal dialog implementation; retain the actual dialog DOM.
    for (const name of ['showModal', 'close'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)
        Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value(this: HTMLDialogElement) { this.open = name === 'showModal' } })
        onTestFinished(() => { if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, name) })
    }
}

test.each(['local-dsh', 'federated-dsh', 'hhpi'] as const)('the %s sidebar menu exports its original Host/session through actual fixed-cut pagination', async kind => {
    viewport(); const download = browserDownload(), hostId = kind === 'local-dsh' ? 'local' : 'runner'
    const sessionId = kind === 'hhpi' ? 'hhpi:machine:source:codex:native-thread' : kind === 'local-dsh' ? 'ordinary-local' : 'native-dsh'
    const sourceHost = host(hostId, sessionId), requests: Array<{ endpoint: string; request: unknown }> = []
    const ordinary = { events: async request => { requests.push({ endpoint: 'events', request }); const older = request.beforeSeq !== undefined
        return { ok: true, value: { cursor: 3, records: (older ? [event(0), event(1)] : [event(2), event(3)]) as never, hasMore: !older } } } } satisfies Pick<SessionRemote, 'events'>
    const session: SourceSession = { id: sessionId, machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native-thread', title: 'Native source', cwd: '/source',
        updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: false, steer: false, cancel: false, approve: false, files: false } }
    const hhpi = { read: async request => { requests.push({ endpoint: 'read', request }); const older = request.before !== undefined
        const page: SourcePage = { session, epoch: 'original-epoch', version: 7, entries: (older ? [event(0), event(1)] : [event(2), event(3)]) as never,
            before: older ? 0 : 2, after: older ? 1 : 3, hasBefore: !older, hasAfter: older, context: [] }
        return { ok: true, value: page } } } satisfies Pick<HhpiRemoteApi, 'read'>
    const exporter = createSessionSourceExporter(sourceHost.sessions, hostId, () => true, ordinary, hhpi)
    const remote = { ...sourceHost, sourceExporter: exporter }, f = workspace(remote, kind === 'local-dsh' ? exporter : undefined)
    act(() => f.controller.sidebar.change({ mode: 'folders' }))
    const api = { catalog: vi.fn(async () => { throw new Error('Export cannot use the old Hub API') }) } as unknown as HapiRemoteApi
    const props = { controller: f.controller, api, wide: true, expandSidebar() {},
        useWorkspaces: (select: (state: typeof workspaces) => unknown) => select(workspaces), t } as unknown as SessionSidebarProps
    render(<SessionSidebar {...props}/>)
    const rowId = sessionResourceId(hostId, sessionId), row = document.querySelector<HTMLElement>(`[data-session-id="${rowId}"]`)!
    const rowButton = row?.querySelector<HTMLButtonElement>('.hapi-session-open') ?? [...document.querySelectorAll<HTMLButtonElement>('.hapi-session-open')].find(button => button.textContent?.includes(`Original ${hostId}`))!
    expect(rowButton).toBeDefined(); fireEvent.contextMenu(rowButton)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export conversation' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Download conversation' }))
    await waitFor(() => expect(download.click).toHaveBeenCalledOnce())
    const blob = download.blobs.at(-1)!, value = JSON.parse(await blob.text())
    expect(value.source).toMatchObject({ kind, hostId, sessionId }); expect(value.events.map((item: { seq: number }) => item.seq)).toEqual([0, 1, 2, 3])
    expect(requests).toHaveLength(3); expect(requests.every(item => item.endpoint === (kind === 'hhpi' ? 'read' : 'events'))).toBe(true)
    expect(api.catalog).not.toHaveBeenCalled(); if (kind !== 'local-dsh') expect(f.localExporter.sourceExport).not.toHaveBeenCalled()
})

test('a disconnected original Host keeps its export target and recovers without calling the local exporter', async () => {
    const download = browserDownload(), exporter = { sourceExport: vi.fn(async () => ({ type: 'ready' as const, fileName: 'source.json', bytes: 2, blob: new Blob(['{}']) })) }
    const remote = host('runner', 'original-source', exporter), f = workspace(remote), row = f.controller.getSnapshot().catalog.byId[sessionResourceId('runner', 'original-source')]!
    const view = render(<WorkspaceSourceExportPanel controller={f.controller} row={row}/>)
    act(f.remove)
    expect(screen.getByRole('alert')).toHaveTextContent(/original Host is offline/)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh sources' }))
    expect(exporter.sourceExport).not.toHaveBeenCalled(); expect(f.localExporter.sourceExport).not.toHaveBeenCalled()
    let remove = () => {}; act(() => { remove = f.controller.addHost({ ...remote }) })
    await userEvent.click(screen.getByRole('button', { name: 'Download conversation' }))
    await waitFor(() => expect(download.click).toHaveBeenCalledOnce())
    expect(exporter.sourceExport).toHaveBeenCalledWith({ source: { kind: 'federated-dsh', hostId: 'runner', sessionId: 'original-source' }, format: 'json' }, expect.any(AbortSignal))
    view.unmount(); remove()
})

test('a wrong Host exporter is explicit and closing the source panel cancels a pending original read', async () => {
    browserDownload(); const remote = host('runner', 'original-source'), wrong = createSessionSourceExporter(remote.sessions, 'another-host', () => true)
    const f = workspace({ ...remote, sourceExporter: wrong }), row = f.controller.getSnapshot().catalog.byId[sessionResourceId('runner', 'original-source')]!
    const view = render(<WorkspaceSourceExportPanel controller={f.controller} row={row}/>)
    await userEvent.click(screen.getByRole('button', { name: 'Download conversation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('another Host graph')
    expect(screen.getByRole('button', { name: 'Download conversation' })).toBeEnabled()
    expect(f.localExporter.sourceExport).not.toHaveBeenCalled(); view.unmount()
    const gate = Promise.withResolvers<never>(); let signal: AbortSignal | undefined
    const pendingHost = host('pending-runner', 'original-source', { sourceExport: (_request, active) => { signal = active; return gate.promise } })
    const stop = f.controller.addHost(pendingHost), pendingRow = f.controller.getSnapshot().catalog.byId[sessionResourceId('pending-runner', 'original-source')]!
    const pending = render(<WorkspaceSourceExportPanel controller={f.controller} row={pendingRow}/>)
    await userEvent.click(screen.getByRole('button', { name: 'Download conversation' })); expect(signal?.aborted).toBe(false)
    pending.unmount(); expect(signal?.aborted).toBe(true); gate.reject(new Error('Old source response')); await act(async () => { await Promise.resolve() }); stop()
})

test('an online Host without an exporter keeps an explicit setup error and does not borrow another Host', async () => {
    const f = workspace(host('runner', 'original-source')), row = f.controller.getSnapshot().catalog.byId[sessionResourceId('runner', 'original-source')]!
    render(<WorkspaceSourceExportPanel controller={f.controller} row={row}/>)
    expect(screen.getByRole('alert')).toHaveTextContent('Export is not registered on the original Host')
    expect(screen.getByRole('button', { name: 'Refresh sources' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Download conversation' })).not.toBeInTheDocument()
    expect(f.localExporter.sourceExport).not.toHaveBeenCalled()
})
