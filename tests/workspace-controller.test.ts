/** Unit tests use explicit Session Controller fakes, not a claim of native backend coverage. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionBinding, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { filterSessions, parseSessionResourceId, sessionCreationContext, sessionLocation, sessionResourceId, WorkspaceController, type WorkspaceOptions } from '../src/client/controller.ts'
import { panes } from '../src/client/model.ts'
import { sessionFolder } from '../src/workspace/presentation.ts'
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
    const add = (id: string, title = id, updatedAt = 1, cwd?: string): void => {
        snapshot = { ...snapshot, ids: [...new Set([...snapshot.ids, id as SessionId])], byId: { ...snapshot.byId,
            [id]: { id: id as SessionId, displayTitle: title, running: false, blank: false, updatedAt, retainedBy: {}, ...(cwd ? { cwd } : {}) },
        } }
        publish()
    }
    const project = (id: string, projectionValues: SessionSummary['projectionValues']): void => {
        const row = snapshot.byId[id as SessionId]
        if (!row) throw new Error('Missing fake row')
        snapshot = { ...snapshot, byId: { ...snapshot.byId, [id]: { ...row, projectionValues } as SessionSummary } }
        publish()
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
    return { sessions, navigation, options, refs, add, project, publish, phase, slow, deferred, renamed, actions, memory, disposeMain: () => main?.release() }
}

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
    assert.ok([...controller.getSnapshot().leases.values()].every(lease => lease.status === 'failed' && lease.waitingForCatalog))
    local.add('native'); remote.add('remote')
    await Promise.resolve()
    assert.ok([...controller.getSnapshot().leases.values()].every(lease => lease.status === 'ready' && lease.reference))
    assert.equal(local.refs.filter(ref => ref.source === 'hapiWorkspace').length, 1)
    assert.equal(remote.refs.filter(ref => ref.source === 'hapiWorkspace').length, 1)
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: sessionResourceId('lab', 'remote') })
    remove(); controller.dispose(); local.disposeMain(); remote.disposeMain()
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
    assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'real-display' })
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
