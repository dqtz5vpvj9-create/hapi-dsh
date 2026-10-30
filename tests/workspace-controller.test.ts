/** Unit tests use explicit Session Controller fakes, not a claim of native backend coverage. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionBinding, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { filterSessions, parseSessionResourceId, sessionCreationContext, sessionLocation, sessionResourceId, WorkspaceController, type WorkspaceOptions } from '../src/client/controller.ts'
import { initialWorkspace, panes, WorkspaceStore, type PaneResource, type WorkspaceState } from '../src/client/model.ts'
import { WorkspaceConflictError } from '../src/client/persistence.ts'
import { sharedWorkspaceSignature, sharedWorkspaceState } from '../src/workspace/legacy.ts'
import { paneTitle, sessionFolder } from '../src/workspace/presentation.ts'
import { createWorkspaceNotifications } from '../src/workspace/notifications.ts'

function fixture() {
    const listeners = new Set<() => void>()
    const refs: Array<SessionReference & { source: string; released: boolean }> = []
    let snapshot: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
    const deferred = new Map<string, { resolve: (value: SessionBinding) => void; reject: (error: Error) => void }>()
    const slow = new Set<string>()
    const renamed: Array<[string, string]> = []
    const actions: Array<[string, string]> = []
    const publish = (): void => { for (const listener of [...listeners]) listener() }
    const phase = (value: SessionListState['phase']): void => { snapshot = { ...snapshot, phase: value }; publish() }
    const add = (id: string, title = id, updatedAt = 1, cwd?: string, durableTitle?: string): void => {
        snapshot = { ...snapshot, ids: [...new Set([...snapshot.ids, id as SessionId])], byId: { ...snapshot.byId,
            [id]: { id: id as SessionId, displayTitle: title, running: false, blank: false, updatedAt, retainedBy: {}, ...(cwd ? { cwd } : {}),
                ...(durableTitle === undefined ? {} : { title: durableTitle }) },
        } }
        publish()
    }
    const project = (id: string, projectionValues: SessionSummary['projectionValues']): void => {
        const row = snapshot.byId[id as SessionId]
        if (!row) throw new Error('Missing fake row')
        snapshot = { ...snapshot, byId: { ...snapshot.byId, [id]: { ...row, projectionValues } as SessionSummary } }
        publish()
    }
    const removeRow = (id: string): void => {
        const byId = { ...snapshot.byId }; delete byId[id as SessionId]
        snapshot = { ...snapshot, ids: snapshot.ids.filter(value => value !== id), byId }; publish()
    }
    const count = (id: string, source: string, delta: number): void => {
        if (!snapshot.byId[id as SessionId]) add(id)
        const row = snapshot.byId[id as SessionId]!
        const counts: Record<string, number> = { ...row.retainedBy }
        counts[source] = (counts[source] ?? 0) + delta
        if (!counts[source]) delete counts[source]
        snapshot = { ...snapshot, byId: { ...snapshot.byId, [id]: { ...row, retainedBy: counts } } }
        publish()
    }
    const sessions: WorkspaceOptions['sessions'] = {
        list: { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
        retain(target, options) {
            const id = typeof target === 'string' ? target : target.childSessionId
            count(id, options.source, 1)
            // The test never renders this binding; only rename is used here.
            const binding = { sessionId: id, session: { rename: async (title: string) => { renamed.push([id, title]); return { ok: true, value: undefined } } } } as unknown as SessionBinding
            const ready = slow.has(id) && options.source === 'hapiWorkspace' ? new Promise<SessionBinding>((resolve, reject) => { deferred.set(id, { resolve, reject }) }) : Promise.resolve(binding)
            const reference: SessionReference & { source: string; released: boolean } = {
                sessionId: id, binding, ready, source: options.source, released: false,
                release() { if (!reference.released) { reference.released = true; count(id, options.source, -1) } },
                [Symbol.dispose]() { reference.release() },
            }
            refs.push(reference)
            return reference
        },
        async using(target, options, operation) {
            const reference = sessions.retain(target, options)
            try { return await operation(reference) } finally { reference.release() }
        },
        refresh: async () => { publish() },
        create: async request => { const id = request?.sessionId ?? 'created'; actions.push(['create', request?.workspaceId ?? request?.cwd ?? '']); add(id); return id as SessionId },
        search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
    }
    let main: SessionReference | undefined
    const navigation: WorkspaceOptions['navigation'] = {
        openSession(target) {
            const next = sessions.retain(target, { source: 'mainView' })
            const previous = main
            main = next
            previous?.release()
        },
        startSession() { actions.push(['start', '']) },
        async archiveSession(id) { actions.push(['archive', id]) },
        async unarchiveSession(id) { actions.push(['unarchive', id]) },
        async pinSession(id) { actions.push(['pin', id]) },
        async unpinSession(id) { actions.push(['unpin', id]) },
        async forkSession(id) { actions.push(['fork', id]); return `${id}-fork` as SessionId },
    }
    let sequence = 0
    const memory = new Map<string, string>()
    const options: WorkspaceOptions = {
        sessions, navigation, storageKey: 'workspace-test',
        workspaces: { create: async ({ path }) => {
            actions.push(['workspace', path]);
            return { workspaceId: `workspace:${path}` as WorkspaceId, path, title: path, sessionIds: [], createdAt: '', updatedAt: '' }
        } },
        storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value) } },
        nextId: () => `test-${++sequence}`,
    }
    return { sessions, navigation, options, refs, add, project, removeRow, publish, phase, slow, deferred, renamed, actions, memory, disposeMain: () => main?.release() }
}

test('related source tools reuse one pane without replacing another session or explicit resource', () => {
    const source = fixture(); source.add('alpha'); source.add('beta')
    const controller = new WorkspaceController(source.options)
    const reuseTabs = ['hapi-notes', 'hapi-history', 'hapi-schedule']
    controller.openSession('alpha')
    const conversation = controller.store.focusedPane().id
    controller.openTab('hapi-notes', { sessionId: 'alpha', beside: 'horizontal', reuseTabs })
    const tools = controller.store.focusedPane().id
    controller.store.focus(conversation)
    controller.openTab('hapi-history', { sessionId: 'alpha', beside: 'horizontal', reuseTabs })
    assert.equal(controller.store.focusedPane().id, tools)
    assert.equal(panes(controller.store.getSnapshot().windows[0]!.root).length, 2)
    controller.openTab('hapi-notes', { sessionId: 'beta', beside: 'horizontal', reuseTabs })
    assert.notEqual(controller.store.focusedPane().id, tools)
    controller.openTab('hapi-notes', { sessionId: 'alpha', beside: 'horizontal' })
    assert.notEqual(controller.store.focusedPane().id, tools, 'explicit independent tabs keep their own occurrence')
    controller.dispose(); source.disposeMain()
})

test('creation hand-off observes only explicit creation success after opening the exact resource', async () => {
    const source = fixture()
    source.add('existing')
    const controller = new WorkspaceController(source.options), created: string[] = []
    const stop = controller.subscribeCreated(id => {
        const focused = controller.store.focusedPane().resource
        assert.equal(focused.kind === 'chat' ? focused.sessionId : null, id)
        created.push(id)
    })
    controller.openSession('existing')
    assert.deepEqual(created, [])
    const id = await controller.createSession('local', '/actual/workspace', 'new')
    assert.deepEqual(created, [id])
    controller.openSession(id)
    assert.deepEqual(created, [id])
    controller.openCreatedSession('existing')
    assert.deepEqual(created, [id, 'existing'])
    stop(); controller.openCreatedSession(id)
    assert.equal(created.length, 2)
    controller.dispose(); source.disposeMain()
})

test('successor navigation requires an exact same-Hub source pair and delegates draft handling before opening', async () => {
    const source = fixture(); source.add('old-display'); source.add('new-display'); source.add('foreign-display')
    source.project('old-display', { hapi: { hubId: 'hub-one', hapiSessionId: 'old-original' } } as never)
    source.project('new-display', { hapi: { hubId: 'hub-one', hapiSessionId: 'new-original' } } as never)
    source.project('foreign-display', { hapi: { hubId: 'hub-two', hapiSessionId: 'new-original' } } as never)
    const controller = new WorkspaceController(source.options), pairs: string[] = []
    controller.openSession('old-display')
    const off = controller.installSuccessorHandler(async (from, to) => {
        const focused = controller.store.focusedPane().resource
        assert.equal(focused.kind === 'chat' && focused.sessionId, 'old-display')
        pairs.push(`${from.hubId}:${from.sessionId}->${to.hubId}:${to.sessionId}`)
        controller.openSession(to.displayId)
    })
    await assert.rejects(controller.openSuccessorSession('old-display', 'foreign-display'), /original Hub/)
    await assert.rejects(controller.openSuccessorSession('old-display', 'unlisted'), /not yet listed/)
    assert.deepEqual(pairs, [])
    await controller.openSuccessorSession('old-display', 'new-display')
    assert.deepEqual(pairs, ['hub-one:old-original->hub-one:new-original'])
    off(); controller.dispose(); source.disposeMain()
})

test('switching windows, focus and zoom retains exact pane references; closing only releases the view', async () => {
    const source = fixture()
    source.add('codex'); source.add('dsh')
    const controller = new WorkspaceController(source.options)
    controller.openSession('codex')
    const first = controller.store.focusedPane().id
    const reference = controller.getSnapshot().leases.get(first)!.reference
    const originalWindow = controller.store.active().id
    controller.store.createWindow()
    controller.openSession('dsh')
    controller.store.selectWindow(originalWindow)
    controller.store.toggleZoom(); controller.store.toggleZoom()
    assert.equal(controller.getSnapshot().leases.get(first)!.reference, reference)
    assert.equal(source.refs.filter(ref => ref.source === 'hapiWorkspace' && ref.sessionId === 'codex').length, 1)
    controller.store.closePane(first)
    assert.ok(source.refs.find(ref => ref === reference)!.released)
    assert.equal(source.actions.length, 0)
    controller.dispose()
    assert.ok(source.refs.filter(ref => ref.source === 'hapiWorkspace').every(ref => ref.released))
    source.disposeMain()
})

test('official mainView navigation opens the matching pane without recursive retain loops', () => {
    const source = fixture(); source.add('a'); source.add('b')
    const controller = new WorkspaceController(source.options)
    source.navigation.openSession('a' as SessionId)
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'a' })
    source.navigation.openSession('b' as SessionId)
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'b' })
    assert.equal(source.refs.filter(ref => ref.source === 'hapiWorkspace' && !ref.released).length, 1)
    const closed = controller.store.focusedPane().id
    controller.store.closePane(closed)
    source.publish()
    assert.equal(controller.store.focusedPane().resource.kind, 'empty')
    controller.dispose(); source.disposeMain()
})

test('original source pin and lifecycle metadata stay independent of official display bookmarks', () => {
    const source = fixture(); source.add('native'); source.add('dsh')
    source.project('native', { hapi: { engine: 'codex', hapiSessionId: 'original-source', hubId: 'hub' } } as never)
    source.options.workspaceState = { getSnapshot: () => ({ archivedSessionIds: ['native'], pinnedSessionIds: ['dsh', 'native'] }), subscribe: () => () => {} }
    const controller = new WorkspaceController(source.options)
    controller.setSourceCatalog([{ id: 'native', logicalSessionId: 'logical', displayRevision: 0, hapiSessionId: 'original-source', machineId: 'runner', engine: 'codex', title: 'Native', cwd: '/repo', pinMode: 'project' }])
    assert.equal(controller.getSnapshot().catalog.byId.native!.archived, false)
    assert.equal(controller.getSnapshot().catalog.byId.native!.sourcePinMode, 'project')
    assert.equal(controller.getSnapshot().catalog.byId.native!.pinned, true)
    assert.equal(controller.getSnapshot().catalog.byId.dsh!.pinned, true)
    controller.setSourceCatalog([{ id: 'native', logicalSessionId: 'logical', displayRevision: 0, hapiSessionId: 'original-source', machineId: 'runner', engine: 'codex', title: 'Native', cwd: '/repo', pinMode: 'none' }])
    assert.equal(controller.getSnapshot().catalog.byId.native!.pinned, false)
    assert.equal(controller.getSnapshot().catalog.byId.dsh!.sourcePinMode, undefined)
    controller.dispose(); source.disposeMain()
})

test('source titles survive intermediate projection clearing and an empty attaching catalog without becoming internal IDs', () => {
    const id = `hapi-codex-${'1'.repeat(32)}`, source = fixture()
    source.add(id, 'Known source title', 1, '/source', 'Known source title')
    source.project(id, { hapi: { engine: 'codex', hubId: 'hub', hapiSessionId: 'original-source' } } as never)
    const controller = new WorkspaceController(source.options)
    controller.openSession(id)
    const title = (): string => paneTitle(controller.store.focusedPane(), controller.getSnapshot().catalog.byId, 'Empty')
    const catalog = { id, logicalSessionId: id, displayRevision: 0, hapiSessionId: 'original-source', machineId: 'runner',
        engine: 'codex', title: 'Known source title', cwd: '/source' }
    assert.equal(title(), 'Known source title')
    // rc.3 clears projection stores on connection changes before loading the
    // replacement baseline. Its temporary row may have neither title nor cwd.
    source.add(id)
    assert.equal(title(), 'Known source title', 'opening retains a title learned before the HAPI catalog arrived')
    controller.setSourceCatalog([catalog], 'hub')
    for (let reconnect = 0; reconnect < 2; reconnect++) {
        controller.setSourceCatalog([], 'hub')
        source.add(id)
        assert.equal(title(), 'Known source title', 'a successful but not-yet-attached source catalog cannot erase a known title')
        controller.sourceCatalogFailed(new Error('Synthetic disconnect'))
        assert.equal(title(), 'Known source title')
        controller.setSourceCatalog([catalog], 'hub')
        source.add(id, 'Known source title', 2, '/source', 'Known source title')
    }
    source.add(id, 'Renamed at source', 3, '/source', 'Renamed at source')
    assert.equal(title(), 'Renamed at source', 'live durable title wins over the older polled source catalog')
    controller.setSourceCatalog([], 'hub')
    source.add(id)
    assert.equal(title(), 'Renamed at source', 'another loading snapshot retains the latest durable title')
    controller.dispose(); source.disposeMain()
})

test('source catalog titles fill a cold display only, without changing ordinary or remote title ownership', () => {
    const id = `hapi-observed-${'2'.repeat(32)}`, local = fixture(), remote = fixture()
    local.add(id); local.add('ordinary', 'Directory label'); remote.add(id, 'Remote title', 1, '/remote', 'Remote title')
    const controller = new WorkspaceController(local.options)
    const off = controller.addHost({ id: 'peer', label: 'Peer', sessions: remote.sessions, navigation: remote.navigation, renderConversation: () => null })
    const catalog = { id, logicalSessionId: id, displayRevision: 0, hapiSessionId: 'original-source', machineId: 'runner',
        engine: 'claude', title: 'Original title', cwd: '/source' }
    controller.setSourceCatalog([catalog], 'hub')
    assert.equal(controller.getSnapshot().catalog.byId[id]?.displayTitle, 'Original title')
    assert.equal(controller.getSnapshot().catalog.byId[id]?.title, 'Original title')
    assert.equal(controller.getSnapshot().catalog.byId[sessionResourceId('peer', id)]?.displayTitle, 'Remote title')
    assert.equal(controller.getSnapshot().catalog.byId.ordinary?.displayTitle, 'Directory label')
    assert.equal(controller.getSnapshot().catalog.byId.ordinary?.title, undefined)
    controller.setSourceCatalog([{ ...catalog, title: 'Source rename while projections load' }], 'hub')
    assert.equal(controller.getSnapshot().catalog.byId[id]?.displayTitle, 'Source rename while projections load')
    for (const title of ['', '   ', 'original-source', id]) {
        controller.setSourceCatalog([{ ...catalog, title }], 'hub')
        assert.equal(controller.getSnapshot().catalog.byId[id]?.displayTitle, 'Source rename while projections load', 'a source catalog fallback ID is not a title')
    }
    local.add('ordinary')
    assert.equal(controller.getSnapshot().catalog.byId.ordinary?.displayTitle, 'ordinary', 'ordinary DSH derivation remains owned by its controller')
    off(); controller.dispose(); local.disposeMain(); remote.disposeMain()
})

test('source pane title survives the missing-row gap across display generations and is cleared when its source changes', () => {
    const id = `hapi-codex-${'3'.repeat(32)}`, source = fixture()
    source.add(id, 'Known original title', 1, '/source', 'Known original title')
    source.project(id, { hapi: { engine: 'codex', hubId: 'hub', hapiSessionId: 'original-source' } } as never)
    const controller = new WorkspaceController(source.options)
    controller.openSession(id)
    const paneId = controller.store.focusedPane().id
    const title = (): string => {
        const snapshot = controller.getSnapshot()
        return paneTitle(controller.store.focusedPane(), snapshot.catalog.byId, 'Empty', snapshot.sourcePaneTitles)
    }
    assert.equal(title(), 'Known original title')
    source.removeRow(id)
    assert.equal(title(), 'Known original title', 'retiring the old display must not expose the original source ID')
    controller.replaceSession(id, `${id}-r1`)
    assert.equal(title(), 'Known original title', 'a successor without its catalog row keeps the exact original title')
    source.add(`${id}-r1`)
    assert.equal(title(), 'Known original title', 'an ID-only successor row is still loading metadata')
    source.add(`${id}-r1`, 'Updated original title', 2, '/source', 'Updated original title')
    source.project(`${id}-r1`, { hapi: { engine: 'codex', hubId: 'hub', hapiSessionId: 'original-source' } } as never)
    assert.equal(title(), 'Updated original title')
    source.removeRow(`${id}-r1`)
    controller.replaceSession(`${id}-r1`, `${id}-r2`)
    assert.equal(title(), 'Updated original title')
    controller.store.openResource({ kind: 'chat', sessionId: 'other-display', sourceSessionId: 'original-source', sourceHubId: 'other-hub' })
    assert.equal(controller.getSnapshot().sourcePaneTitles[paneId], undefined, 'same source ID on another Hub cannot inherit the title')
    controller.store.openResource({ kind: 'chat', sessionId: 'another-display', sourceSessionId: 'different-source', sourceHubId: 'hub' })
    assert.equal(controller.getSnapshot().sourcePaneTitles[paneId], undefined, 'another source on the original Hub cannot inherit the title')
    controller.store.closePane(paneId)
    assert.deepEqual(controller.getSnapshot().sourcePaneTitles, {})
    controller.dispose(); source.disposeMain()
})

test('a retired source display keeps its durable rename while the polled catalog still has the old title', () => {
    const id = `hapi-codex-${'5'.repeat(32)}`, source = fixture()
    source.add(id, 'Old source title', 1, '/source', 'Old source title')
    source.project(id, { hapi: { engine: 'codex', hubId: 'hub', hapiSessionId: 'original-source' } } as never)
    const controller = new WorkspaceController(source.options)
    controller.setSourceCatalog([{ id, logicalSessionId: id, displayRevision: 0, hapiSessionId: 'original-source', machineId: 'runner',
        engine: 'codex', title: 'Old source title', cwd: '/source' }], 'hub')
    controller.openSession(id)
    source.add(id, 'New durable title', 2, '/source', 'New durable title')
    const title = (): string => {
        const snapshot = controller.getSnapshot()
        return paneTitle(controller.store.focusedPane(), snapshot.catalog.byId, 'Empty', snapshot.sourcePaneTitles)
    }
    assert.equal(title(), 'New durable title')
    source.removeRow(id)
    assert.equal(title(), 'New durable title', 'a delayed catalog poll cannot roll the known title back')
    controller.replaceSession(id, `${id}-r1`)
    assert.equal(title(), 'New durable title')
    controller.dispose(); source.disposeMain()
})

test('a restored source pane can use its exact catalog title before the successor display is listed', () => {
    const id = `hapi-codex-${'4'.repeat(32)}`, source = fixture(), controller = new WorkspaceController(source.options)
    controller.setSourceCatalog([{ id, logicalSessionId: id, displayRevision: 0, hapiSessionId: 'original-source', machineId: 'runner',
        engine: 'codex', title: 'Known while loading', cwd: '/source' }], 'hub')
    controller.store.openResource({ kind: 'chat', sessionId: `${id}-r1`, sourceSessionId: 'original-source', sourceHubId: 'hub' })
    const pane = controller.store.focusedPane(), snapshot = controller.getSnapshot()
    assert.equal(snapshot.catalog.byId[`${id}-r1`], undefined, 'a title does not fabricate a ready display row')
    assert.equal(paneTitle(pane, snapshot.catalog.byId, 'Empty', snapshot.sourcePaneTitles), 'Known while loading')
    controller.dispose(); source.disposeMain()
})

test('share discovery waits for real source identities and Host arrival while keeping loaded DSH on a source outage', () => {
    const local = fixture(), remote = fixture(), controller = new WorkspaceController(local.options)
    assert.equal(controller.getSnapshot().catalog.phase, 'ready')
    assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'pending')
    const facts = { metadataPresent: true, flavor: 'codex', agentSessionId: 'native-thread', codexStoreId: '/source/home', hasTitleSignal: true, hasConversationContent: true }
    controller.setSourceCatalog([{ id: 'native', logicalSessionId: 'native-logical', displayRevision: 0,
        hapiSessionId: 'original-source', machineId: 'source-machine', engine: 'codex', title: 'Source title', cwd: '/source', sourceListFacts: facts }], 'source-hub',
    { connected: true, hosts: [{ id: 'remote', label: 'Other Host', online: true }] })
    assert.equal(controller.getSnapshot().catalogDiscovery.sourceBindingsPending, 1)
    local.add('native')
    assert.equal(controller.getSnapshot().catalogDiscovery.sourceBindingsPending, 1, 'DSH proxy existence is not its source identity')
    local.project('native', { hapi: { engine: 'codex', hubId: 'source-hub', hapiSessionId: 'original-source' } } as never)
    assert.equal(controller.getSnapshot().catalogDiscovery.sourceBindingsPending, 0)
    assert.deepEqual(controller.getSnapshot().catalog.byId.native?.sourceListFacts, facts)
    assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'pending', 'an advertised online Host is still loading')
    const off = controller.addHost({ id: 'remote', label: 'Other Host', sessions: remote.sessions, navigation: remote.navigation, renderConversation: () => null })
    controller.catalogHostReady('remote', 'Other Host')
    assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'ready')
    local.add('ordinary')
    assert.equal(controller.getSnapshot().catalog.byId.ordinary?.sourceListFacts, undefined)
    controller.sourceCatalogFailed(new Error('HAPI disconnected'))
    assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'partial')
    assert.equal(controller.getSnapshot().catalog.byId.ordinary?.hostOnline, true)
    off(); controller.dispose(); local.disposeMain(); remote.disposeMain()
})

test('source timestamps and new-in-directory context retain actual machine identity through the engine chooser only', () => {
    const source = fixture(); source.add('native', 'Native', 10, '/source/project'); source.add('dsh', 'Official', 20, '/host/project')
    source.project('native', { hapi: { engine: 'codex', hapiSessionId: 'original-source', hubId: 'original-hub', machineId: 'source-machine' } } as never)
    const controller = new WorkspaceController(source.options)
    controller.setSourceCatalog([{ id: 'native', logicalSessionId: 'logical', displayRevision: 0, hapiSessionId: 'original-source',
        machineId: 'source-machine', engine: 'codex', title: 'Native', cwd: '/source/project', updatedAt: 900 }])
    assert.equal(controller.getSnapshot().catalog.byId.native!.updatedAt, 900)
    assert.equal(controller.getSnapshot().catalog.byId.dsh!.updatedAt, 20)
    controller.requestNewSessionInDirectory('native')
    const expected = { hostId: 'local', directory: '/source/project', sourceSessionId: 'original-source', sourceHubId: 'original-hub', machineId: 'source-machine', engine: 'codex' }
    assert.equal(controller.getSnapshot().creation, 'choose')
    assert.deepEqual(controller.getSnapshot().creationContext, expected)
    controller.requestNewSession('codex')
    assert.deepEqual(controller.getSnapshot().creationContext, expected)
    controller.closeNewSession()
    assert.equal(controller.getSnapshot().creationContext, null)
    controller.requestNewSessionInDirectory('native'); controller.requestNewSession()
    assert.equal(controller.getSnapshot().creationContext, null)
    controller.openSession('native')
    controller.requestNewSession()
    assert.deepEqual(controller.getSnapshot().creationContext, expected)
    controller.requestNewSessionInDirectory('dsh')
    assert.deepEqual(controller.getSnapshot().creationContext, { hostId: 'local', directory: '/host/project' })
    controller.openNativeLibrary()
    assert.equal(controller.getSnapshot().creationContext, null)
    controller.dispose(); source.disposeMain()
})

test('remote official folder creation stays on its Host and never pretends to be a HAPI source machine', () => {
    const source = fixture(), remote = fixture()
    remote.add('official', 'Remote', 20, 'C:\\Projects\\actual')
    const controller = new WorkspaceController(source.options)
    const remove = controller.addHost({ id: 'linux-host', label: 'Remote', sessions: remote.sessions, navigation: remote.navigation, renderConversation: () => null })
    controller.requestNewSessionInDirectory(sessionResourceId('linux-host', 'official'))
    assert.deepEqual(controller.getSnapshot().creationContext, { hostId: 'linux-host', directory: 'C:\\Projects\\actual' })
    const row = controller.getSnapshot().catalog.byId[sessionResourceId('linux-host', 'official')]!
    const { cwd: _cwd, ...withoutDirectory } = row
    assert.equal(sessionCreationContext(withoutDirectory), null)
    assert.equal(sessionCreationContext({ ...row, projectionValues: { hapiObserved: { sidechain: { rootSessionId: 'root' } } } as never }), null)
    remove(); controller.dispose(); remote.disposeMain(); source.disposeMain()
})

test('source search and worktree folder context preserve the original base directory without changing the session cwd', () => {
    const source = fixture(), remote = fixture()
    source.add('native', 'Source', 10, '/source/project.worktrees/task')
    remote.add('native', 'Official same ID', 20, '/host/project')
    source.project('native', { hapi: { engine: 'codex', hapiSessionId: 'original-source', hubId: 'original-hub', machineId: 'source-machine' } } as never)
    const controller = new WorkspaceController(source.options)
    const remove = controller.addHost({ id: 'remote', label: 'Remote', sessions: remote.sessions, navigation: remote.navigation, renderConversation: () => null })
    controller.setSourceCatalog([{ id: 'native', logicalSessionId: 'logical', displayRevision: 0, hapiSessionId: 'original-source',
        machineId: 'source-machine', engine: 'codex', title: 'Source', cwd: '/source/project.worktrees/task', sourceSummary: 'Fix delivery ledger races',
        sourceWorktree: { name: 'task', basePath: '/source/project', branch: 'feat/task' }, sourceSubagentSearch: ['reviewer'] }])
    const native = controller.getSnapshot().catalog.byId.native!, official = controller.getSnapshot().catalog.byId[sessionResourceId('remote', 'native')]!
    assert.equal(native.cwd, '/source/project.worktrees/task')
    assert.equal(sessionFolder(native).path, '/source/project')
    assert.equal(native.sourceWorktree?.worktreePath, undefined)
    assert.equal(official.sourceSummary, undefined)
    assert.equal(sessionFolder(official).path, '/host/project')
    assert.deepEqual(filterSessions([official, native], 'ledger reviewer source-machine').map(row => row.id), ['native'])
    controller.requestNewSessionInDirectory(native.id, sessionFolder(native).path)
    assert.deepEqual(controller.getSnapshot().creationContext, { hostId: 'local', directory: '/source/project', sourceSessionId: 'original-source',
        sourceHubId: 'original-hub', machineId: 'source-machine', engine: 'codex' })
    remove(); controller.dispose(); source.disposeMain(); remote.disposeMain()
})

test('late readiness of a released binding cannot replace the new pane binding', async () => {
    const source = fixture(); source.add('slow'); source.add('next'); source.slow.add('slow')
    const controller = new WorkspaceController(source.options)
    controller.openSession('slow')
    const paneId = controller.store.focusedPane().id
    const old = controller.getSnapshot().leases.get(paneId)!
    controller.openSession('next')
    source.deferred.get('slow')!.reject(new Error('stale network failure'))
    await Promise.resolve(); await Promise.resolve()
    assert.equal(controller.getSnapshot().leases.get(paneId)!.sessionId, 'next')
    assert.equal(controller.getSnapshot().leases.get(paneId)!.status, 'ready')
    assert.equal(source.refs.find(ref => ref === old.reference)!.released, true)
    controller.dispose(); source.disposeMain()
})

test('foreign and local sessions with identical ids remain isolated and share one catalog', () => {
    const local = fixture(); const remote = fixture()
    local.add('same-id', 'Local build'); remote.add('same-id', 'Remote build')
    const controller = new WorkspaceController(local.options)
    const remove = controller.addHost({ id: 'lab', label: 'Lab machine', sessions: remote.sessions, navigation: remote.navigation, renderConversation: reference => reference.sessionId })
    controller.openSession('same-id')
    const localPane = controller.store.focusedPane().id
    controller.openSession(sessionResourceId('lab', 'same-id'), 'horizontal')
    const remotePane = controller.store.focusedPane().id
    assert.equal(controller.getSnapshot().catalog.ids.length, 2)
    assert.equal(controller.getSnapshot().leases.get(localPane)!.hostId, 'local')
    assert.equal(controller.getSnapshot().leases.get(remotePane)!.hostId, 'lab')
    assert.equal(local.refs.filter(ref => ref.source === 'hapiWorkspace').length, 1)
    assert.equal(remote.refs.filter(ref => ref.source === 'hapiWorkspace').length, 1)
    assert.deepEqual(sessionLocation(controller.getSnapshot().catalog.byId[sessionResourceId('lab', 'same-id')]), { engine: 'dsh', machineId: 'lab', machineName: 'Lab machine' })
    remove()
    assert.equal(controller.getSnapshot().leases.get(remotePane)!.status, 'failed')
    assert.equal(controller.getSnapshot().catalog.byId[sessionResourceId('lab', 'same-id')]!.hostOnline, false)
    const reconnect = controller.addHost({ id: 'lab', label: 'Lab machine', sessions: remote.sessions, navigation: remote.navigation, renderConversation: reference => reference.sessionId })
    assert.equal(controller.getSnapshot().leases.get(remotePane)!.status, 'opening')
    reconnect(); controller.dispose(); local.disposeMain(); remote.disposeMain()
})

test('renaming, pinning and forking route to the owning Host', async () => {
    const local = fixture(); const remote = fixture(); remote.add('source')
    const controller = new WorkspaceController(local.options)
    const remove = controller.addHost({ id: 'remote', label: 'Remote', sessions: remote.sessions, navigation: remote.navigation, renderConversation: reference => reference.sessionId })
    const id = sessionResourceId('remote', 'source')
    await controller.renameSession(id, 'Updated')
    await controller.sessionAction(id, 'pin')
    await controller.sessionAction(id, 'fork')
    assert.deepEqual(remote.renamed, [['source', 'Updated']])
    assert.deepEqual(remote.actions, [['pin', 'source'], ['fork', 'source']])
    assert.equal(local.actions.length, 0)
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: sessionResourceId('remote', 'source-fork') })
    remove(); controller.dispose(); local.disposeMain(); remote.disposeMain()
})

test('creating a DSH session targets the selected Host and a lost-response retry opens the existing identity', async () => {
    const local = fixture(); const remote = fixture()
    const controller = new WorkspaceController(local.options)
    const remove = controller.addHost({ id: 'lab', label: 'Lab', sessions: remote.sessions, navigation: remote.navigation, workspaces: remote.options.workspaces!, renderConversation: reference => reference.sessionId })
    const requested = 'new-session-identity'
    const first = await controller.createSession('lab', '/code/project', requested)
    const retry = await controller.createSession('lab', '/code/project', requested)
    assert.equal(first, sessionResourceId('lab', requested))
    assert.equal(retry, first)
    assert.deepEqual(remote.actions, [['workspace', '/code/project'], ['create', 'workspace:/code/project']])
    assert.equal(local.actions.length, 0)
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: first })
    remove(); controller.dispose(); local.disposeMain(); remote.disposeMain()
})

test('a failed catalog refresh cannot make a named creation retry allocate another session', async () => {
    const source = fixture()
    const controller = new WorkspaceController(source.options)
    source.phase('pending')
    await assert.rejects(controller.createSession('local', '/code/project', 'uncertain-identity'), /conversation list is not ready/)
    assert.deepEqual(source.actions, [])
    controller.dispose(); source.disposeMain()
})

test('saved local and remote panes wait for their own catalogs and recover when identities arrive', async () => {
    const saved = fixture(); saved.add('native')
    const initial = new WorkspaceController(saved.options)
    initial.openSession('native')
    initial.openSession(sessionResourceId('lab', 'remote'), 'horizontal')
    const state = saved.memory.get(saved.options.storageKey)!
    initial.dispose(); saved.disposeMain()
    const local = fixture(); local.phase('pending'); local.memory.set(local.options.storageKey, state)
    const remote = fixture(); remote.phase('pending')
    const controller = new WorkspaceController(local.options)
    const remove = controller.addHost({ id: 'lab', label: 'Lab', sessions: remote.sessions, navigation: remote.navigation, renderConversation: reference => reference.sessionId })
    assert.equal(local.refs.length, 0)
    assert.equal(remote.refs.length, 0)
    assert.ok([...controller.getSnapshot().leases.values()].every(lease => lease.status === 'opening' && lease.waitingForCatalog))
    local.phase('ready'); remote.phase('ready')
    // An empty but ready official list is not proof of a missing target: the
    // HAPI catalog keeps attaching sources, so the pane stays a transient
    // `opening` state instead of claiming the session is unavailable.
    assert.ok([...controller.getSnapshot().leases.values()].every(lease => lease.status === 'opening' && lease.reason === 'catalog-loading'))
    local.add('native'); remote.add('remote')
    await Promise.resolve()
    assert.ok([...controller.getSnapshot().leases.values()].every(lease => lease.status === 'ready' && lease.reference))
    assert.equal(local.refs.filter(ref => ref.source === 'hapiWorkspace').length, 1)
    assert.equal(remote.refs.filter(ref => ref.source === 'hapiWorkspace').length, 1)
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: sessionResourceId('lab', 'remote') })
    remove(); controller.dispose(); local.disposeMain(); remote.disposeMain()
})

const restoredPluginResources: PaneResource[] = [
    { kind: 'terminal', sessionId: 'saved', sourceHubId: 'source-hub', sourceSessionId: 'source-session', terminalId: 'original-terminal',
        target: { type: 'tab', kind: 'hapi-legacy-terminal', address: 'sidebar://hapi-legacy-terminal/saved', params: { terminalId: 'original-terminal' } } },
    { kind: 'document', sessionId: 'saved', sourceHubId: 'source-hub', sourceSessionId: 'source-session', document: { kind: 'file', path: '/source/original.txt' },
        target: { type: 'resource', address: 'dsh-resource://file/session/saved/original.txt' } },
    { kind: 'view', sessionId: 'saved', viewId: 'saved-view', target: { type: 'tab', kind: 'files', address: 'sidebar://files' }, title: 'Saved plugin view' },
]

for (const resource of restoredPluginResources) test(`restored ${resource.kind} preserves its identity through delayed catalog and asynchronous main-view confirmation`, async () => {
    const source = fixture(), requested: string[] = []
    source.phase('pending')
    const state = initialWorkspace(source.options.nextId!)
    state.windows[0]!.root = { type: 'pane', id: state.windows[0]!.root.id, resource }
    source.memory.set(source.options.storageKey, JSON.stringify(state))
    const controller = new WorkspaceController({ ...source.options, navigation: { ...source.navigation, openSession: target => { requested.push(String(target)) } } })
    let old: SessionReference | undefined
    try {
        assert.deepEqual(controller.store.focusedPane().resource, resource)
        // The official shell's old main can restore before the desired
        // workspace Session appears. It is not a new user selection.
        source.add('old'); old = source.sessions.retain('old' as SessionId, { source: 'mainView' })
        assert.deepEqual(controller.store.focusedPane().resource, resource)
        source.add('saved'); source.project('saved', { hapi: { hubId: 'source-hub', hapiSessionId: 'source-session' } } as never)
        source.phase('ready'); source.publish()
        assert.deepEqual(requested, ['saved'])
        assert.deepEqual(controller.store.focusedPane().resource, resource)
        old.release(); old = undefined
        source.publish()
        assert.deepEqual(controller.store.focusedPane().resource, resource, 'A temporary absence of mainView references must not discard a plugin resource')
        // openSession is asynchronous in the real UI: its actual main
        // reference may arrive after the immediate catalog callbacks above.
        source.navigation.openSession('saved' as SessionId); source.publish()
        await Promise.resolve()
        assert.deepEqual(controller.store.focusedPane().resource, resource)
        assert.equal(controller.getSnapshot().leases.get(controller.store.focusedPane().id)?.status, 'ready')
        assert.deepEqual(JSON.parse(source.memory.get(source.options.storageKey)!).windows[0].root.resource, resource)
        source.add('next'); source.navigation.openSession('next' as SessionId)
        assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'next' }, 'A later explicit official navigation must still work')
    } finally { controller.dispose(); old?.release(); source.disposeMain() }
})

test('a late first main-view retain of the same restored plugin Session does not turn it into chat', () => {
    const source = fixture(), resource = restoredPluginResources[2]!, requested: string[] = []
    source.add('saved')
    const state = initialWorkspace(source.options.nextId!)
    state.windows[0]!.root = { type: 'pane', id: state.windows[0]!.root.id, resource }
    source.memory.set(source.options.storageKey, JSON.stringify(state))
    const controller = new WorkspaceController({ ...source.options, navigation: { ...source.navigation, openSession: target => { requested.push(String(target)) } } })
    try {
        assert.deepEqual(requested, ['saved'])
        source.publish(); source.publish()
        source.navigation.openSession('saved' as SessionId)
        assert.deepEqual(controller.store.focusedPane().resource, resource)
    } finally { controller.dispose(); source.disposeMain() }
})

test('new-session request survives plugin-page reveal and does not change pane execution ownership', () => {
    const source = fixture(); source.add('running')
    let revealed = 0
    const controller = new WorkspaceController({ ...source.options, reveal: () => { revealed++ } })
    controller.openSession('running')
    const reference = controller.getSnapshot().leases.get(controller.store.focusedPane().id)!.reference
    controller.requestNewSession()
    assert.equal(controller.getSnapshot().creation, 'choose')
    controller.requestNewSession('codex')
    assert.equal(controller.getSnapshot().creation, 'codex')
    controller.closeNewSession()
    assert.equal(controller.getSnapshot().creation, null)
    assert.equal(controller.getSnapshot().leases.get(controller.store.focusedPane().id)!.reference, reference)
    assert.equal(revealed, 3)
    assert.equal(source.actions.length, 0)
    controller.dispose(); source.disposeMain()
})

test('a malformed persisted remote address becomes a recoverable failed pane instead of crashing startup', () => {
    const source = fixture()
    const first = new WorkspaceController(source.options)
    first.openSession('hapi-remote:bad%encoding:source')
    const saved = source.memory.get(source.options.storageKey)!
    first.dispose(); source.disposeMain()
    source.memory.set(source.options.storageKey, saved)
    const restored = new WorkspaceController(source.options)
    const lease = restored.getSnapshot().leases.get(restored.store.focusedPane().id)!
    assert.equal(lease.status, 'failed')
    assert.equal(lease.reference, undefined)
    assert.match(lease.error!, /URI|address/)
    restored.dispose()
})

test('new display generation retains a new reference and preserves the same pane', () => {
    const source = fixture(); source.add('native'); source.add('native-r1')
    const controller = new WorkspaceController(source.options)
    controller.openSession('native')
    const paneId = controller.store.focusedPane().id
    const oldReference = controller.getSnapshot().leases.get(paneId)!.reference
    controller.replaceSession('native', 'native-r1')
    assert.equal(controller.store.focusedPane().id, paneId)
    assert.notEqual(controller.getSnapshot().leases.get(paneId)!.reference, oldReference)
    assert.equal(controller.getSnapshot().leases.get(paneId)!.sessionId, 'native-r1')
    assert.ok(source.refs.find(ref => ref === oldReference)!.released)
    assert.equal(source.actions.length, 0)
    controller.dispose(); source.disposeMain()
})

test('local geometry restores after plugin disposal without persisting references or credentials', () => {
    const source = fixture(); source.add('a')
    const first = new WorkspaceController(source.options)
    first.openSession('a'); first.store.split('vertical'); first.store.createWindow('Review')
    const persisted = first.store.getSnapshot()
    first.dispose()
    const second = new WorkspaceController(source.options)
    assert.deepEqual(second.store.getSnapshot(), persisted)
    const document = source.memory.get('workspace-test')!
    assert.equal(document.includes('retainedBy'), false)
    assert.equal(document.includes('reference'), false)
    assert.equal(second.getSnapshot().layout.windows.flatMap(window => panes(window.root)).length, 3)
    second.dispose(); source.disposeMain()
})

test('invalid browser state remains reviewable and does not silently overwrite the stored document', () => {
    const source = fixture(); source.memory.set('workspace-test', '{broken')
    const controller = new WorkspaceController(source.options)
    assert.match(controller.getSnapshot().notice!, /restore failed/)
    assert.equal(source.memory.get('workspace-test'), '{broken')
    assert.equal(controller.store.focusedPane().resource.kind, 'empty')
    controller.dispose()
})

test('resource addresses round-trip without treating external identifiers as paths', () => {
    const id = sessionResourceId('machine:/中文', 'session/with:punctuation')
    assert.deepEqual(parseSessionResourceId(id), { hostId: 'machine:/中文', sessionId: 'session/with:punctuation' })
    assert.deepEqual(parseSessionResourceId('local-session'), { hostId: 'local', sessionId: 'local-session' })
    assert.throws(() => parseSessionResourceId('hapi-remote:invalid'), /Invalid/)
})

test('one sidebar searches title, native identity, machine and engine without fabricating rows', () => {
    const rows: SessionSummary[] = [
        { id: 'one' as SessionId, displayTitle: 'Refactor API', cwd: '/code/service', running: true, blank: false, updatedAt: 4, retainedBy: {},
            projectionValues: { hapi: { engine: 'codex', machineId: 'lab', machineName: 'Lab', nativeId: 'thread1' } } as unknown as NonNullable<SessionSummary['projectionValues']> },
        { id: 'two' as SessionId, displayTitle: 'Review UI', running: false, blank: false, updatedAt: 8, retainedBy: {} },
    ]
    assert.deepEqual(filterSessions(rows, 'api lab').map(row => row.id), ['one'])
    assert.deepEqual(filterSessions(rows, '', 'dsh').map(row => row.id), ['two'])
    assert.deepEqual(filterSessions(rows, 'thread1', '', 'lab').map(row => row.id), ['one'])
})

const legacyLayout = { schemaVersion: 2, revision: 4, workspaces: [{ id: 'legacy-window', name: 'Existing', root: { type: 'pane', id: 'legacy-pane', resource: { kind: 'chat', sessionId: 'original-source' } } }] }
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('a pane plugin can veto close and replacement without blocking movement, and its disposer restores close', () => {
    const source = fixture(); source.add('a'); source.add('b')
    const controller = new WorkspaceController(source.options)
    controller.openSession('a')
    const paneId = controller.store.focusedPane().id
    let calls = 0
    const release = controller.registerPaneCloseGuard(paneId, () => { calls++; return false })
    controller.store.movePaneToNewWindow(paneId)
    assert.equal(calls, 0, 'Moving preserves the plugin graph and its draft')
    controller.store.closePane(paneId)
    assert.equal(calls, 1)
    assert.equal(controller.store.focusedPane().id, paneId)
    controller.openSession('b')
    assert.equal(calls, 2)
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'a' })
    release(); controller.store.closePane(paneId)
    assert.equal(controller.store.focusedPane().resource.kind, 'empty')
    controller.dispose(); source.disposeMain()
})

test('first installation imports source geometry once and unavailable source retains its identity until catalog arrives', async () => {
    const source = fixture()
    let imported = 0
    const writes: unknown[] = []
    const controller = new WorkspaceController({ ...source.options,
        persistence: { load: async () => null, save: async value => { writes.push(value) } },
        legacy: async () => { imported++; return legacyLayout },
    })
    await turn()
    assert.equal(imported, 1)
    assert.equal(controller.store.active().id, 'legacy-window')
    assert.equal(controller.getSnapshot().leases.get('legacy-pane')?.waitingForCatalog, true)
    assert.equal(source.refs.length, 0, 'unmapped HAPI ids must never be retained as guessed DSH sessions')
    controller.setSourceCatalog([], 'hub')
    source.add('display')
    source.project('display', { hapi: { engine: 'codex', hapiSessionId: 'original-source', hubId: 'hub' } } as SessionSummary['projectionValues'])
    await turn()
    assert.equal(controller.getSnapshot().leases.get('legacy-pane')?.sessionId, 'display')
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'display', sourceSessionId: 'original-source', sourceHubId: 'hub' })
    assert.ok(writes.length > 0)
    controller.dispose(); source.disposeMain()
    const restored = new WorkspaceController({ ...source.options, persistence: { load: async () => null, save: async () => {} }, legacy: async () => { imported++; return legacyLayout } })
    await turn(); assert.equal(imported, 1, 'an existing plugin document must not be overwritten by legacy import')
    restored.dispose(); source.disposeMain()
})

test('an explicit source deep link waits for catalog and opens the real mapped session', async () => {
    const source = fixture()
    const controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'original-source' })
    assert.equal(source.refs.length, 0)
    source.add('real-display')
    source.project('real-display', { hapi: { engine: 'codex', hapiSessionId: 'original-source', hubId: 'hub' } } as SessionSummary['projectionValues'])
    controller.setSourceCatalog([], 'hub')
    await turn()
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'real-display', sourceSessionId: 'original-source', sourceHubId: 'hub' })
    controller.dispose(); source.disposeMain()
})

test('notification and initial deep links keep both Hub and source identities', async () => {
    const source = fixture()
    const controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'shared-original', sourceHubQuery: 'hub-beta' })
    const selected = () => { const resource = controller.store.focusedPane().resource; return resource.kind === 'chat' ? resource.sessionId : undefined }
    source.add('alpha-display')
    source.project('alpha-display', { hapi: { engine: 'codex', hapiSessionId: 'shared-original', hubId: 'hub-alpha' } } as never)
    assert.equal(controller.store.focusedPane().resource.kind, 'empty', 'an early wrong-Hub hit must not consume the pending link')
    source.add('beta-display')
    source.project('beta-display', { hapi: { engine: 'codex', hapiSessionId: 'shared-original', hubId: 'hub-beta' } } as never)
    assert.equal(selected(), 'beta-display')
    await controller.openSourceSession({ hubId: 'hub-alpha', sessionId: 'shared-original' })
    assert.equal(selected(), 'alpha-display')
    await assert.rejects(controller.openSourceSession({ hubId: 'hub-missing', sessionId: 'shared-original' }), /requested source Hub/u)
    assert.equal(selected(), 'alpha-display')
    await assert.rejects(controller.openSourceSession({ hubId: '', sessionId: 'shared-original' }), /both its Hub and session/u)
    controller.dispose(); source.disposeMain()
})

test('an exact deep link resolves during a slow layout read but opens only after the layout merge', async () => {
    const source = fixture(), calls: unknown[] = [], writes: WorkspaceState[] = []
    const localWrites: string[] = []
    let finishLayout!: (state: WorkspaceState) => void, finishSource!: () => void
    const layoutReady = new Promise<WorkspaceState>(resolve => { finishLayout = resolve })
    const sourceReady = new Promise<void>(resolve => { finishSource = resolve })
    const controller = new WorkspaceController({ ...source.options,
        sourceSessionQuery: 'requested-original', sourceHubQuery: 'requested-hub',
        storage: { getItem: source.options.storage!.getItem,
            setItem(key, value) { localWrites.push(key); source.options.storage!.setItem(key, value) } },
        persistence: { load: () => layoutReady, save: async state => { writes.push(state) } },
    })
    const initial = controller.store.getSnapshot()
    controller.installSourceResolver(async (identity, signal) => {
        calls.push(identity); await sourceReady; signal.throwIfAborted()
        source.add('resolved-display')
        source.project('resolved-display', { hapi: { hubId: identity.hubId, hapiSessionId: identity.sourceSessionId } } as never)
    })
    try {
        await turn()
        assert.deepEqual(calls, [{ hubId: 'requested-hub', sourceSessionId: 'requested-original' }])
        source.publish(); await turn()
        assert.equal(calls.length, 1, 'catalog progress shares the same pending identity resolution')
        finishSource(); await turn()
        assert.equal(controller.store.getSnapshot(), initial)
        assert.equal(controller.store.focusedPane().resource.kind, 'empty')
        assert.equal(source.refs.length, 0, 'resolved identity alone cannot open or retain the target')
        assert.deepEqual(writes, [])
        assert.deepEqual(localWrites, [])
        let sequence = 0
        const remote = initialWorkspace(() => `remote-layout-${++sequence}`)
        remote.windows[0]!.name = 'Server layout'
        finishLayout(remote); await turn()
        assert.equal(controller.store.active().id, remote.activeWindowId)
        assert.equal(controller.store.active().name, 'Server layout')
        assert.deepEqual(controller.store.focusedPane().resource, {
            kind: 'chat', sessionId: 'resolved-display', sourceSessionId: 'requested-original', sourceHubId: 'requested-hub',
        })
        assert.ok(source.refs.some(reference => reference.sessionId === 'resolved-display'))
        assert.equal(calls.length, 1)
    } finally { controller.dispose(); source.disposeMain() }
})

test('disposing a deep link during layout loading cancels early resolution without later navigation or writes', async () => {
    const source = fixture(), writes: WorkspaceState[] = []
    let finishLayout!: (state: WorkspaceState) => void, finishSource!: () => void, sourceSignal!: AbortSignal
    const layoutReady = new Promise<WorkspaceState>(resolve => { finishLayout = resolve })
    const sourceReady = new Promise<void>(resolve => { finishSource = resolve })
    const controller = new WorkspaceController({ ...source.options,
        sourceSessionQuery: 'requested-original', sourceHubQuery: 'requested-hub',
        persistence: { load: () => layoutReady, save: async state => { writes.push(state) } },
    })
    const initial = controller.store.getSnapshot()
    controller.installSourceResolver(async (_identity, signal) => {
        sourceSignal = signal; await sourceReady; signal.throwIfAborted()
        source.add('late-display')
        source.project('late-display', { hapi: { hubId: 'requested-hub', hapiSessionId: 'requested-original' } } as never)
    })
    try {
        await turn()
        assert.ok(sourceSignal)
        assert.equal(sourceSignal.aborted, false)
        controller.dispose()
        assert.equal(sourceSignal.aborted, true)
        finishSource(); finishLayout(initial); await turn()
        assert.equal(controller.store.getSnapshot(), initial)
        assert.equal(source.refs.length, 0)
        assert.deepEqual(writes, [])
    } finally { controller.dispose(); source.disposeMain() }
})

test('successful early source resolution cannot bypass a failed layout read', async () => {
    const source = fixture(), writes: WorkspaceState[] = []
    let failLayout!: (error: Error) => void
    const layoutReady = new Promise<WorkspaceState>((_resolve, reject) => { failLayout = reject })
    const controller = new WorkspaceController({ ...source.options,
        sourceSessionQuery: 'requested-original', sourceHubQuery: 'requested-hub',
        persistence: { load: () => layoutReady, save: async state => { writes.push(state) } },
    })
    controller.installSourceResolver(async identity => {
        source.add('resolved-display')
        source.project('resolved-display', { hapi: { hubId: identity.hubId, hapiSessionId: identity.sourceSessionId } } as never)
    })
    try {
        await turn()
        assert.ok(controller.getSnapshot().catalog.byId['resolved-display'])
        failLayout(new Error('Workspace storage unavailable')); await turn()
        assert.equal(controller.store.focusedPane().resource.kind, 'empty')
        assert.equal(source.refs.length, 0)
        assert.deepEqual(writes, [])
        assert.match(controller.getSnapshot().notice ?? '', /Workspace storage unavailable/)
    } finally { controller.dispose(); source.disposeMain() }
})

test('a legacy source-only deep link waits for the configured primary Hub instead of guessing from conflicting rows', () => {
    const source = fixture()
    for (const hub of ['alpha', 'beta']) {
        source.add(`${hub}-display`)
        source.project(`${hub}-display`, { hapi: { engine: 'codex', hapiSessionId: 'shared-original', hubId: hub } } as never)
    }
    const controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'shared-original' })
    assert.equal(controller.store.focusedPane().resource.kind, 'empty')
    assert.equal(source.refs.length, 0)
    controller.setSourceCatalog([], 'beta')
    const resource = controller.store.focusedPane().resource
    assert.equal(resource.kind === 'chat' && resource.sessionId, 'beta-display')
    controller.dispose(); source.disposeMain()
})

test('restored panes prioritize one exact late source in a large catalog and share its hydration', async () => {
    const source = fixture()
    for (let index = 0; index < 153; index++) {
        source.add(`display-${index}`)
        source.project(`display-${index}`, { hapi: { hubId: 'original-hub', hapiSessionId: `original-${index}` } } as never)
    }
    const saved = initialWorkspace(() => 'restore-fixture')
    saved.windows[0]!.root = { type: 'pane', id: 'restored-chat', resource: { kind: 'chat', sessionId: 'old-display', sourceSessionId: 'original-153', sourceHubId: 'original-hub' } }
    saved.windows.push({ ...saved.windows[0]!, id: 'second-window', root: { type: 'pane', id: 'restored-document', resource: {
        kind: 'document', sessionId: 'old-display', sourceSessionId: 'original-153', sourceHubId: 'original-hub', document: { kind: 'file', path: '/original/note.md' }, title: 'Saved document',
    } } })
    saved.focused[saved.windows[0]!.id] = 'restored-chat'; saved.focused['second-window'] = 'restored-document'
    source.memory.set(source.options.storageKey, JSON.stringify(saved))
    const controller = new WorkspaceController(source.options), calls: unknown[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const unresolve = controller.installSourceResolver(async (identity, signal) => {
        calls.push(identity); await gate; signal.throwIfAborted()
        source.add('current-display')
        source.project('current-display', { hapi: { hubId: identity.hubId, hapiSessionId: identity.sourceSessionId } } as never)
    })
    await turn()
    assert.deepEqual(calls, [{ hubId: 'original-hub', sourceSessionId: 'original-153' }])
    assert.ok([...controller.getSnapshot().leases.values()].every(lease => lease.status === 'opening'))
    assert.equal(source.refs.length, 0, 'no nearby or stale display is retained')
    release(); await turn()
    assert.ok([...controller.getSnapshot().leases.values()].every(lease => lease.status === 'ready' && lease.sessionId === 'current-display'))
    assert.equal(controller.getSnapshot().catalog.ids.length, 154)
    const document = panes(controller.store.getSnapshot().windows[1]!.root)[0]!.resource
    assert.deepEqual(document.kind === 'document' && document.document, { kind: 'file', path: '/original/note.md' })
    assert.equal(document.kind === 'document' && document.title, 'Saved document')
    unresolve(); controller.dispose(); source.disposeMain()
})

test('missing original source retains the saved pane and exposes a deliberate exact retry', async () => {
    const source = fixture(), saved = initialWorkspace(() => 'missing-fixture')
    saved.windows[0]!.root = { type: 'pane', id: 'missing-pane', resource: { kind: 'chat', sessionId: 'old-display', sourceSessionId: 'same-name', sourceHubId: 'correct-hub' } }
    saved.focused[saved.windows[0]!.id] = 'missing-pane'
    source.memory.set(source.options.storageKey, JSON.stringify(saved))
    source.add('wrong-display'); source.project('wrong-display', { hapi: { hubId: 'wrong-hub', hapiSessionId: 'same-name' } } as never)
    const controller = new WorkspaceController(source.options)
    let calls = 0
    controller.installSourceResolver(async identity => {
        calls++; assert.deepEqual(identity, { hubId: 'correct-hub', sourceSessionId: 'same-name' })
        if (calls === 1) throw Object.assign(new Error('Original source was not found (404)'), { details: { status: 404 } })
        source.add('correct-display'); source.project('correct-display', { hapi: { hubId: 'correct-hub', hapiSessionId: 'same-name' } } as never)
    })
    await turn()
    assert.equal(controller.getSnapshot().leases.get('missing-pane')?.status, 'failed')
    assert.equal(controller.getSnapshot().leases.get('missing-pane')?.sourceResolution, 'not-found')
    assert.match(controller.getSnapshot().leases.get('missing-pane')?.error ?? '', /not found \(404\)/)
    assert.deepEqual(controller.store.focusedPane().resource, saved.windows[0]!.root.resource)
    source.publish(); await turn(); assert.equal(calls, 1, 'catalog broadcasts do not keep retrying a failed source')
    assert.equal(source.refs.length, 0)
    controller.retryPane('missing-pane'); await turn()
    assert.equal(calls, 2)
    assert.equal(controller.getSnapshot().leases.get('missing-pane')?.sessionId, 'correct-display')
    controller.dispose(); source.disposeMain()
})

test('closing a pending original pane aborts its wait and a late source cannot recreate the pane', async () => {
    const source = fixture(), saved = initialWorkspace(() => 'cancel-fixture')
    saved.windows[0]!.root = { type: 'pane', id: 'pending-pane', resource: { kind: 'chat', sessionId: 'old-display', sourceSessionId: 'original', sourceHubId: 'hub' } }
    saved.focused[saved.windows[0]!.id] = 'pending-pane'; source.memory.set(source.options.storageKey, JSON.stringify(saved))
    const controller = new WorkspaceController(source.options)
    let signal!: AbortSignal, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    controller.installSourceResolver(async (_source, lifetime) => {
        signal = lifetime; await gate
        source.add('late-display'); source.project('late-display', { hapi: { hubId: 'hub', hapiSessionId: 'original' } } as never)
    })
    await turn(); controller.store.closePane('pending-pane')
    assert.equal(signal.aborted, true)
    release(); await turn()
    assert.equal(controller.store.focusedPane().resource.kind, 'empty')
    assert.equal(source.refs.length, 0)
    controller.dispose(); source.disposeMain()
})

test('a source-only deep link hydrates only after its configured Hub is known', async () => {
    const source = fixture(), controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'requested-original' }), calls: unknown[] = []
    controller.installSourceResolver(async identity => {
        calls.push(identity)
        source.add('requested-display'); source.project('requested-display', { hapi: { hubId: identity.hubId, hapiSessionId: identity.sourceSessionId } } as never)
    })
    await turn(); assert.deepEqual(calls, [])
    controller.setSourceCatalog([], 'configured-hub'); await turn()
    assert.deepEqual(calls, [{ hubId: 'configured-hub', sourceSessionId: 'requested-original' }])
    const resource = controller.store.focusedPane().resource
    assert.equal(resource.kind === 'chat' && resource.sessionId, 'requested-display')
    controller.dispose(); source.disposeMain()
})

test('a saved legacy source on an HHPI-only Host is unavailable immediately and recovers only through its original identity', async () => {
    const source = fixture(), resource = { kind: 'chat', sessionId: 'old-display', sourceSessionId: 'original-source', sourceHubId: 'original-hub' } as const
    let sequence = 0, available: boolean | undefined
    const listeners = new Set<() => void>()
    const state = initialWorkspace(() => `saved-${++sequence}`)
    state.windows[0]!.root = { type: 'pane', id: 'legacy-pane', resource }
    state.focused[state.activeWindowId] = 'legacy-pane'
    source.memory.set(source.options.storageKey, JSON.stringify(state))
    const controller = new WorkspaceController({ ...source.options, legacySourceAvailability: {
        getSnapshot: () => available, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } }), requests: unknown[] = []
    controller.installSourceResolver(async identity => { requests.push(identity) })
    controller.setSourceCatalog([], 'hhpi-shell')
    assert.equal(controller.getSnapshot().leases.get('legacy-pane')?.status, 'opening')
    available = false; for (const listener of listeners) listener()
    await turn()
    assert.equal(controller.getSnapshot().leases.get('legacy-pane')?.status, 'failed')
    assert.equal(controller.getSnapshot().leases.get('legacy-pane')?.sourceResolution, 'not-connected')
    assert.deepEqual(controller.store.focusedPane().resource, resource)
    assert.deepEqual(requests, [], 'an unconfigured source must not queue a resolver call or wait for a calm catalog')
    assert.equal(source.refs.length, 0)
    available = true
    source.add('original-display'); source.project('original-display', { hapi: { hubId: 'original-hub', hapiSessionId: 'original-source' } } as never)
    controller.setSourceCatalog([], 'original-hub'); await turn()
    assert.equal(controller.getSnapshot().leases.get('legacy-pane')?.status, 'ready')
    const recovered = controller.store.focusedPane().resource
    assert.equal(recovered.kind === 'chat' && recovered.sessionId, 'original-display')
    assert.deepEqual(source.actions, [], 'reconnection never creates or starts a native conversation')
    controller.dispose(); source.disposeMain()
})

test('legacy restored panes wait for the real primary Hub even when a foreign same-ID source arrives first', async () => {
    const source = fixture()
    source.add('foreign-display')
    source.project('foreign-display', { hapi: { hubId: 'foreign-hub', hapiSessionId: 'original-source' } } as never)
    const controller = new WorkspaceController({ ...source.options, persistence: { load: async () => null, save: async () => {} }, legacy: async () => legacyLayout })
    const requests: unknown[] = []
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    controller.installSourceResolver(async identity => {
        requests.push(identity); await gate
        source.add('primary-display'); source.project('primary-display', { hapi: { hubId: identity.hubId, hapiSessionId: identity.sourceSessionId } } as never)
    })
    await turn()
    assert.equal(source.refs.length, 0)
    assert.deepEqual(requests, [])
    const unbound = controller.store.focusedPane().resource
    assert.equal(unbound.kind === 'chat' && unbound.sourceHubId, undefined)
    assert.notEqual(unbound.kind === 'chat' && unbound.sessionId, 'foreign-display')
    controller.setSourceCatalog([], 'primary-hub'); await turn()
    assert.deepEqual(requests, [{ hubId: 'primary-hub', sourceSessionId: 'original-source' }])
    const fixed = controller.store.focusedPane().resource
    assert.equal(fixed.kind === 'chat' && fixed.sourceHubId, 'primary-hub')
    assert.equal(controller.getSnapshot().leases.get('legacy-pane')?.sourceResolution, 'loading')
    assert.equal(source.refs.length, 0)
    finish(); await turn()
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'primary-display', sourceSessionId: 'original-source', sourceHubId: 'primary-hub' })
    assert.ok(source.refs.every(reference => reference.sessionId === 'primary-display'))
    controller.dispose(); source.disposeMain()
})

test('app badge uses eligible sidebar roots and source bookmarks, retaining uncertainty during loading or failed reads', () => {
    const source = fixture(); source.add('a'); source.add('b')
    const controller = new WorkspaceController(source.options), notifications = createWorkspaceNotifications(controller)
    let changed = 0
    const stop = notifications.subscribeUnread(() => { changed++ })
    assert.equal(notifications.getUnreadCount(), null)
    notifications.readStatus('ready')
    assert.equal(notifications.getUnreadCount(), 0, 'existing rows keep the sidebar first-load baseline')
    controller.sidebar.markUnread('a', 1)
    assert.equal(notifications.getUnreadCount(), 1)
    controller.sidebar.change({ engine: 'codex', filter: 'running' })
    assert.equal(notifications.getUnreadCount(), 1, 'transient list filters do not clear the OS badge')
    source.phase('pending'); assert.equal(notifications.getUnreadCount(), null)
    source.phase('ready'); assert.equal(notifications.getUnreadCount(), 1)
    notifications.readStatus('error'); assert.equal(notifications.getUnreadCount(), null)
    notifications.readStatus('ready'); controller.sidebar.markSeen('a', 1)
    assert.equal(notifications.getUnreadCount(), 0)
    assert.ok(changed > 4)
    stop(); notifications.dispose(); controller.dispose(); source.disposeMain()
})

test('window and pane navigation saves local view state without producing shared geometry mutations', async () => {
    const source = fixture(); source.add('a'); source.add('b')
    const writes: unknown[] = []
    const controller = new WorkspaceController({ ...source.options, persistence: { load: async () => null, save: async value => { writes.push(value) } } })
    await turn()
    controller.openSession('a'); controller.openSession('b', 'horizontal')
    await turn(); const count = writes.length
    controller.store.cyclePane(1); controller.store.toggleZoom(); controller.store.cyclePane(-1)
    await turn()
    assert.equal(writes.length, count)
    assert.equal(JSON.parse(source.memory.get(source.options.storageKey)!).zoomed[controller.store.active().id], true)
    controller.dispose(); source.disposeMain()
})


test('large hidden history can release only its own unguarded view and reopens on selection', () => {
    const source = fixture(); source.add('old'); source.add('current')
    const controller = new WorkspaceController({ ...source.options, deferHiddenSessions: true })
    controller.openSession('old')
    const pane = controller.store.focusedPane().id, originalWindow = controller.store.active().id
    const reference = controller.getSnapshot().leases.get(pane)!.reference!
    assert.equal(controller.releaseHiddenHistory(pane, reference), false)
    controller.store.createWindow(); controller.openSession('current')
    const unguard = controller.registerPaneCloseGuard(pane, () => false)
    assert.equal(controller.releaseHiddenHistory(pane, reference), false)
    unguard()
    assert.equal(controller.releaseHiddenHistory(pane, reference), true)
    assert.equal(controller.getSnapshot().leases.has(pane), false)
    assert.equal(source.actions.length, 0)
    controller.store.selectWindow(originalWindow)
    assert.notEqual(controller.getSnapshot().leases.get(pane)?.reference, reference)
    controller.dispose(); source.disposeMain()
})

/** Independent browser transports against one CAS store, without native I/O. */
function sharedLayoutFixture() {
    let id = 0
    const layout = new WorkspaceStore(initialWorkspace(() => `shared-${++id}`), () => `shared-${++id}`)
    layout.renameWindow(layout.active().id, 'Alpha')
    layout.createWindow('Beta')
    let state = sharedWorkspaceState(layout.getSnapshot()), revision = 1
    const writes: WorkspaceState[] = []
    const client = () => {
        let expected = 0
        return {
            load: async () => { expected = revision; return state },
            save: async (next: WorkspaceState) => {
                if (expected !== revision) { expected = revision; throw new WorkspaceConflictError(state) }
                state = next; expected = ++revision; writes.push(next)
            },
        }
    }
    return { state: () => state, revision: () => revision, writes, client }
}

test('fresh and cached browser restores do not echo geometry or ask clean browsers to resolve differences', async () => {
    const server = sharedLayoutFixture(), desktop = fixture(), mobile = fixture()
    const a = new WorkspaceController({ ...desktop.options, persistence: server.client() })
    const b = new WorkspaceController({ ...mobile.options, persistence: server.client() })
    await turn()
    assert.equal(server.writes.length, 0)
    b.store.selectWindow(b.store.getSnapshot().windows[1]!.id)
    const localSelection = b.store.getSnapshot().activeWindowId
    a.store.renameWindow(a.store.getSnapshot().windows[0]!.id, 'Desktop edit')
    await turn(); b.dispose(); mobile.disposeMain()
    const reopened = new WorkspaceController({ ...mobile.options, persistence: server.client() })
    await turn()
    assert.equal(reopened.store.getSnapshot().windows[0]!.name, 'Desktop edit')
    assert.equal(reopened.store.getSnapshot().activeWindowId, localSelection)
    assert.equal(reopened.getSnapshot().notice, null)
    assert.equal(reopened.getSnapshot().conflict, null)
    assert.equal(server.writes.length, 1, 'only the deliberate desktop edit writes')
    assert.equal(JSON.parse(mobile.memory.get('workspace-test')!).syncBase.windows[0].name, 'Desktop edit')
    reopened.dispose(); a.dispose(); desktop.disposeMain(); mobile.disposeMain()
})

test('an older browser cache is backed up once and follows the server without a recurring banner', async () => {
    const server = sharedLayoutFixture(), source = fixture()
    const cached = structuredClone(server.state())
    cached.windows[0]!.name = 'Old browser arrangement'
    source.memory.set('workspace-test', JSON.stringify(cached))
    let controller = new WorkspaceController({ ...source.options, persistence: server.client() })
    await turn()
    assert.equal(controller.store.getSnapshot().windows[0]!.name, 'Alpha')
    assert.equal(controller.getSnapshot().hasLayoutRecovery, true)
    assert.equal(controller.getSnapshot().conflict, null)
    assert.equal(controller.getSnapshot().notice, null)
    assert.equal(JSON.parse(source.memory.get('workspace-test')!).layoutRecovery.windows[0].name, 'Old browser arrangement')
    controller.dispose(); source.disposeMain()
    controller = new WorkspaceController({ ...source.options, persistence: server.client() })
    await turn()
    assert.equal(controller.getSnapshot().notice, null)
    assert.equal(server.writes.length, 0)
    controller.restoreLayoutRecovery(); await turn()
    assert.equal(server.state().windows[0]!.name, 'Old browser arrangement')
    assert.equal(controller.getSnapshot().hasLayoutRecovery, false)
    controller.dispose(); source.disposeMain()
})

test('offline edits survive reload and rebase onto independent changes from another browser', async () => {
    const server = sharedLayoutFixture(), mobile = fixture(), desktop = fixture()
    let offline = false
    const transport = server.client()
    const a = new WorkspaceController({ ...mobile.options, persistence: { ...transport, save: async state => {
        if (offline) throw new Error('Offline')
        return transport.save(state)
    } } })
    const b = new WorkspaceController({ ...desktop.options, persistence: server.client() })
    await turn()
    offline = true
    a.store.renameWindow(a.store.getSnapshot().windows[1]!.id, 'Mobile edit')
    b.store.renameWindow(b.store.getSnapshot().windows[0]!.id, 'Desktop edit')
    await turn()
    assert.equal(a.getSnapshot().persistence, 'failed')
    a.dispose(); mobile.disposeMain()
    const resumed = new WorkspaceController({ ...mobile.options, persistence: server.client() })
    await turn()
    assert.deepEqual(server.state().windows.map(window => window.name), ['Desktop edit', 'Mobile edit'])
    assert.equal(resumed.getSnapshot().conflict, null)
    assert.equal(resumed.getSnapshot().notice, null)
    assert.equal(server.writes.length, 2)
    resumed.dispose(); b.dispose(); mobile.disposeMain(); desktop.disposeMain()
})

test('CAS conflict replays only local edits and does not overwrite a remote rename', async () => {
    const server = sharedLayoutFixture(), desktop = fixture(), mobile = fixture()
    const a = new WorkspaceController({ ...desktop.options, persistence: server.client() })
    const b = new WorkspaceController({ ...mobile.options, persistence: server.client() })
    await turn()
    a.store.renameWindow(a.store.getSnapshot().windows[0]!.id, 'Desktop edit')
    await turn()
    b.store.renameWindow(b.store.getSnapshot().windows[1]!.id, 'Mobile edit')
    await turn()
    assert.deepEqual(server.state().windows.map(window => window.name), ['Desktop edit', 'Mobile edit'])
    assert.equal(b.getSnapshot().conflict, null)
    assert.equal(server.writes.length, 2)
    a.dispose(); b.dispose(); desktop.disposeMain(); mobile.disposeMain()
})

test('a save acknowledgement cannot erase an edit made while that save was in flight', async () => {
    const server = sharedLayoutFixture(), source = fixture(), transport = server.client()
    let finish!: () => void, saves = 0
    const gate = new Promise<void>(resolve => { finish = resolve })
    const controller = new WorkspaceController({ ...source.options, persistence: { ...transport, save: async state => {
        if (++saves === 1) await gate
        return transport.save(state)
    } } })
    await turn()
    const [a, b] = controller.store.getSnapshot().windows
    controller.store.renameWindow(a!.id, 'First edit')
    controller.store.renameWindow(b!.id, 'Second edit')
    finish(); await turn()
    assert.deepEqual(server.state().windows.map(window => window.name), ['First edit', 'Second edit'])
    const saved = JSON.parse(source.memory.get('workspace-test')!)
    assert.equal(sharedWorkspaceSignature(saved.syncBase), sharedWorkspaceSignature(server.state()))
    assert.equal(server.writes.length, 2)
    controller.dispose(); source.disposeMain()
})

test('a local edit during the first GET is replayed onto the remote layout', async () => {
    const server = sharedLayoutFixture(), source = fixture(), transport = server.client()
    const base = server.state()
    source.memory.set('workspace-test', JSON.stringify({ ...base, syncBase: base }))
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const controller = new WorkspaceController({ ...source.options, persistence: { ...transport,
        load: async () => { await gate; return transport.load() },
    } })
    controller.store.renameWindow(base.windows[1]!.id, 'Edited while loading')
    finish(); await turn()
    assert.deepEqual(server.state().windows.map(window => window.name), ['Alpha', 'Edited while loading'])
    assert.equal(server.writes.length, 1)
    controller.dispose(); source.disposeMain()
})

test('retrying a failed initial read reloads the server before saving pending edits', async () => {
    const server = sharedLayoutFixture(), source = fixture(), transport = server.client()
    const base = server.state()
    source.memory.set('workspace-test', JSON.stringify({ ...base, syncBase: base }))
    let reads = 0
    const controller = new WorkspaceController({ ...source.options, persistence: { ...transport,
        load: async () => { if (++reads === 1) throw new Error('Offline'); return transport.load() },
    } })
    await turn()
    controller.store.renameWindow(base.windows[1]!.id, 'Offline edit')
    assert.equal(server.writes.length, 0)
    controller.retryPersistence(); await turn()
    assert.equal(reads, 2)
    assert.equal(server.state().windows[1]!.name, 'Offline edit')
    assert.equal(controller.getSnapshot().notice, null)
    controller.dispose(); source.disposeMain()
})

test('remote layout removal respects dirty pane guards and accepting the server does not echo it', async () => {
    const server = sharedLayoutFixture(), source = fixture()
    const base = structuredClone(server.state())
    base.windows[0]!.root = { type: 'pane', id: 'guarded-pane', resource: { kind: 'chat', sessionId: 'editing' } }
    source.add('editing')
    source.memory.set('workspace-test', JSON.stringify({ ...base, syncBase: base }))
    const controller = new WorkspaceController({ ...source.options, persistence: server.client() })
    const release = controller.registerPaneCloseGuard('guarded-pane', () => false)
    await turn()
    assert.equal(controller.store.getSnapshot().windows[0]!.root.id, 'guarded-pane')
    assert.ok(controller.getSnapshot().conflict)
    assert.equal(controller.getSnapshot().notice, null, 'recovery controls live in the menu, not a recurring top banner')
    controller.resolveConflict('server')
    assert.equal(controller.store.getSnapshot().windows[0]!.root.id, 'guarded-pane')
    release(); controller.resolveConflict('server'); await turn()
    assert.equal(sharedWorkspaceSignature(controller.store.getSnapshot()), sharedWorkspaceSignature(server.state()))
    assert.equal(controller.getSnapshot().conflict, null)
    assert.equal(controller.getSnapshot().hasLayoutRecovery, true)
    assert.equal(server.writes.length, 0)
    controller.dispose(); source.disposeMain()
})

test('the official initial session selection is not replayed as a new local window on fresh restore', async () => {
    const server = sharedLayoutFixture(), source = fixture()
    source.add('official-selected')
    source.navigation.openSession('official-selected' as SessionId)
    const controller = new WorkspaceController({ ...source.options, persistence: server.client() })
    await turn()
    assert.equal(sharedWorkspaceSignature(controller.store.getSnapshot()), sharedWorkspaceSignature(server.state()))
    assert.equal(controller.getSnapshot().conflict, null)
    assert.equal(server.writes.length, 0)
    controller.dispose(); source.disposeMain()
})

test('accepting a conflicting server layout backs up the layout being replaced, even with an older backup', async () => {
    const server = sharedLayoutFixture(), source = fixture()
    const base = structuredClone(server.state()), local = structuredClone(base), oldBackup = structuredClone(base)
    local.windows[0]!.name = 'Current local edit'; oldBackup.windows[0]!.name = 'Much older backup'
    source.memory.set('workspace-test', JSON.stringify({ ...local, syncBase: base, layoutRecovery: oldBackup }))
    const remote = structuredClone(base); remote.windows.splice(0, 1)
    remote.activeWindowId = remote.windows[0]!.id
    const controller = new WorkspaceController({ ...source.options, persistence: { load: async () => remote, save: async () => {} } })
    await turn()
    assert.ok(controller.getSnapshot().conflict)
    controller.resolveConflict('server')
    assert.equal(JSON.parse(source.memory.get('workspace-test')!).layoutRecovery.windows[0].name, 'Current local edit')
    assert.equal(controller.getSnapshot().conflict, null)
    controller.dispose(); source.disposeMain()
})

test('same-source generation retains one rendering reference across a missing successor catalog', async () => {
    const id = `hapi-codex-${'6'.repeat(32)}`, source = fixture()
    source.add(id, 'Source')
    source.project(id, { hapi: { hubId: 'hub', hapiSessionId: 'original' } } as never)
    const controller = new WorkspaceController(source.options)
    controller.openSession(id); await Promise.resolve()
    const paneId = controller.store.focusedPane().id
    const old = controller.getSnapshot().leases.get(paneId)!.reference!
    source.removeRow(id)
    controller.replaceSession(id, `${id}-r1`)
    const pending = controller.getSnapshot().leases.get(paneId)!
    assert.equal(pending.reference, undefined)
    assert.equal(pending.previousReference, old)
    assert.equal(source.refs.find(ref => ref === old)!.released, false)
    source.add(`${id}-r1`)
    source.project(`${id}-r1`, { hapi: { hubId: 'hub', hapiSessionId: 'original' } } as never)
    const next = controller.getSnapshot().leases.get(paneId)!
    assert.equal(next.reference?.sessionId, `${id}-r1`)
    assert.equal(next.previousReference, undefined)
    assert.equal(source.refs.find(ref => ref === old)!.released, true)
    controller.dispose(); source.disposeMain()
})

test('navigating to another source releases a waiting generation rendering reference', async () => {
    const id = `hapi-codex-${'7'.repeat(32)}`, source = fixture()
    source.add(id)
    source.project(id, { hapi: { hubId: 'hub', hapiSessionId: 'original' } } as never)
    source.add('other')
    const controller = new WorkspaceController(source.options)
    controller.openSession(id); await Promise.resolve()
    const paneId = controller.store.focusedPane().id
    const old = controller.getSnapshot().leases.get(paneId)!.reference!
    source.removeRow(id); controller.replaceSession(id, `${id}-r1`)
    assert.equal(controller.getSnapshot().leases.get(paneId)!.previousReference, old)
    controller.openSession('other')
    assert.equal(controller.getSnapshot().leases.get(paneId)!.previousReference, undefined)
    assert.equal(source.refs.find(ref => ref === old)!.released, true)
    controller.dispose(); source.disposeMain()
})

test('source identity arriving during initial reference readiness is retained for generation handoff', async () => {
    const id = `hapi-codex-${'8'.repeat(32)}`, source = fixture()
    source.add(id); source.slow.add(id)
    const controller = new WorkspaceController(source.options)
    controller.openSession(id)
    const paneId = controller.store.focusedPane().id
    const old = controller.getSnapshot().leases.get(paneId)!.reference!
    source.project(id, { hapi: { hubId: 'hub', hapiSessionId: 'late-original' } } as never)
    source.deferred.get(id)!.resolve(old.binding); await Promise.resolve()
    assert.equal(controller.getSnapshot().leases.get(paneId)!.status, 'ready')
    source.removeRow(id); controller.replaceSession(id, `${id}-r1`)
    assert.equal(controller.getSnapshot().leases.get(paneId)!.previousReference, old)
    controller.dispose()
    assert.equal(source.refs.find(ref => ref === old)!.released, true)
    source.disposeMain()
})
