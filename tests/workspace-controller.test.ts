/** Unit tests use explicit Session Controller fakes, not a claim of native backend coverage. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionBinding, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { filterSessions, parseSessionResourceId, sessionLocation, sessionResourceId, WorkspaceController, type WorkspaceOptions } from '../src/client/controller.ts'
import { panes } from '../src/client/model.ts'

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
    const add = (id: string, title = id, updatedAt = 1): void => {
        snapshot = { ...snapshot, ids: [...new Set([...snapshot.ids, id as SessionId])], byId: { ...snapshot.byId,
            [id]: { id: id as SessionId, displayTitle: title, running: false, blank: false, updatedAt, retainedBy: {} },
        } }
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
    return { sessions, navigation, options, refs, add, publish, phase, slow, deferred, renamed, actions, memory, disposeMain: () => main?.release() }
}

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
