/** Unit tests use explicit Session Controller fakes, not a claim of native backend coverage. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionBinding, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { filterSessions, parseSessionResourceId, sessionCreationContext, sessionLocation, sessionResourceId, WorkspaceController, type WorkspaceOptions } from '../src/client/controller.ts'
import { initialWorkspace, panes, parseWorkspaceState, WorkspaceStore, type PaneResource, type WorkspaceState } from '../src/client/model.ts'
import { WorkspaceConflictError } from '../src/client/persistence.ts'
import { sharedWorkspaceSignature, sharedWorkspaceState } from '../src/workspace/legacy.ts'
import { paneTitle, sessionFolder } from '../src/workspace/presentation.ts'
import { createWorkspaceNotifications } from '../src/workspace/notifications.ts'
import { FederationHosts, type FederatedHostRuntime } from '../src/client/federation-hosts.ts'
import type { FederationHost } from '../src/client-api.ts'
import { SourceAliasResolutionError } from '../src/client/source-session-resolver.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'
import { CatalogRefresh } from '../src/client/catalog-refresh.ts'
import { catalogFailureText } from '../src/client/error-policy.ts'
import { accountComposerDraftKey } from '../src/client/composer-autosave.ts'

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
    const omitRow = (id: string): void => { snapshot = { ...snapshot, ids: snapshot.ids.filter(value => value !== id) }; publish() }
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
    return { sessions, navigation, options, refs, add, project, removeRow, omitRow, publish, phase, slow, deferred, renamed, actions, memory, disposeMain: () => main?.release() }
}

test('canonical native directory entries deduplicate offline original and shadow without merging ordinary sessions or grants', () => {
    const local = fixture(), remote = fixture(), id = 'hhpi:windows:source:codex:thread'
    const metadata = { id, machineId: 'windows', sourceId: 'source', engine: 'codex', nativeId: 'thread', title: 'Native', cwd: 'C:\\work', updatedAt: 1,
        status: 'offline' as const, activeTurnId: null, pendingRequests: [], capabilities: { send: false, steer: false, cancel: false, approve: false, files: false } }
    local.add(id); local.project(id, { hhpiSource: metadata }); local.add('ordinary')
    remote.add(id); remote.project(id, { hhpiSource: metadata }); remote.add('ordinary')
    const controller = new WorkspaceController(local.options)
    try {
        controller.addHost({ id: 'windows', label: 'Windows', sessions: remote.sessions, navigation: remote.navigation, renderConversation: () => null })
        controller.setHostDiscovery([{ id: 'windows', label: 'Windows', online: false }])
        const catalog = controller.getSnapshot().catalog
        assert.equal(catalog.ids.filter(value => value === id || value === sessionResourceId('windows', id)).length, 1)
        assert.ok(catalog.byId[id]); assert.ok(catalog.byId[sessionResourceId('windows', id)])
        assert.ok(catalog.ids.includes('ordinary' as SessionId)); assert.ok(catalog.ids.includes(sessionResourceId('windows', 'ordinary') as SessionId))
    } finally { controller.dispose(); local.disposeMain(); remote.disposeMain() }
})

test('omitted native rows preserve exact account drafts and open Panes while empty peers leave the sidebar', async () => {
    const local = fixture(), application = new WorkspaceApplicationIdentity(), prefix = 'hhpi:machine:source:codex:'
    application.set({ accountId: 'owner', origin: 'https://workspace.test' }, 'device')
    local.sessions.captureWorkspaceAccess = () => ({ scope: 'source-account', signal: new AbortController().signal, assertCurrent() {} })
    const draft = prefix + 'draft', opened = prefix + 'opened', empty = prefix + 'empty'
    for (const id of [draft, opened, empty]) local.add(id)
    const key = accountComposerDraftKey(JSON.stringify([application.getSnapshot()!.scope, 'source-account']), 'local', draft)
    local.memory.set(key, JSON.stringify({ version: 1, draft: { text: '未发送的草稿', references: [] } }))
    const controller = new WorkspaceController({ ...local.options, application })
    try {
        controller.openSession(opened)
        for (const id of [draft, opened, empty]) local.omitRow(id)
        await turn()
        const catalog = controller.getSnapshot().catalog
        assert.ok(catalog.ids.includes(draft as SessionId)); assert.ok(catalog.ids.includes(opened as SessionId))
        assert.ok(!catalog.ids.includes(empty as SessionId)); assert.ok(catalog.byId[empty])
        assert.equal(JSON.parse(local.memory.get(key)!).draft.text, '未发送的草稿')
        assert.equal(focusedResourceId(controller), opened)
    } finally { controller.dispose(); local.disposeMain(); application.dispose() }
})

test('an empty attachment lookup is invalidated after opening and closing the same omitted Pane with a new file draft', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    let saved: unknown, reads = 0
    const database = { objectStoreNames: { contains: () => true }, close() {}, transaction(_name: string, mode: string) {
        assert.equal(mode, 'readonly'); return { objectStore() { return { get() {
            reads++; const request = { result: saved, onsuccess: undefined as (() => void) | undefined }
            queueMicrotask(() => request.onsuccess?.()); return request
        } } } }
    } }
    const factory = { databases: async () => [{ name: 'hapi-dsh-composer-attachments' }], open() {
        const request = { result: database, onsuccess: undefined as (() => void) | undefined }
        queueMicrotask(() => request.onsuccess?.()); return request
    } }
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory })
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else Reflect.deleteProperty(globalThis, 'indexedDB') })
    const local = fixture(), application = new WorkspaceApplicationIdentity(), id = 'hhpi:machine:source:codex:temporary'
    application.set({ accountId: 'owner', origin: 'https://workspace.test' }, 'device')
    local.sessions.captureWorkspaceAccess = () => ({ scope: 'source-account', signal: new AbortController().signal, assertCurrent() {} })
    local.add(id); local.omitRow(id)
    const controller = new WorkspaceController({ ...local.options, application })
    try {
        await turn(); assert.ok(!controller.getSnapshot().catalog.ids.includes(id as SessionId))
        const initialReads = reads
        controller.openSession(id)
        saved = { version: 1, revision: 'new-attachment', value: { version: 1, text: '', mode: 'draft', files: [{ name: 'unsent.png' }] } }
        controller.store.closePane(controller.store.focusedPane().id)
        await turn()
        assert.ok(reads > initialReads, 'a new layout lifetime requires a fresh exact attachment lookup')
        assert.ok(controller.getSnapshot().catalog.ids.includes(id as SessionId), 'attachment-only draft stays reachable after its Pane closes')
    } finally { controller.dispose(); local.disposeMain(); application.dispose() }
})

test('catalog poll failure and explicit retry retain loaded readers and unrelated operation notices', async () => {
    const source = fixture(); source.add('kept')
    const controller = new WorkspaceController(source.options)
    const host = { id: 'paired', label: 'Source', online: true }
    let fail = false, reads = 0
    const refresh = new CatalogRefresh({
        read: async () => { reads++; if (fail) throw new Error('transport failure for /api/hapi/catalog: HTTP 502'); return [host] },
        accept: hosts => controller.setHostDiscovery(hosts),
        failed: error => controller.catalogDiscoveryFailed(catalogFailureText(error, 'en')),
    })
    const unrefresh = controller.installCatalogRefresh(refresh.refresh)
    try {
        controller.openSession('kept'); await turn()
        await refresh.refresh(); controller.catalogHostReady(host.id, host.label)
        const pane = controller.store.focusedPane().id
        const lease = controller.getSnapshot().leases.get(pane)!
        const reference = lease.reference
        const row = controller.getSnapshot().catalog.byId['kept']
        assert.equal(lease.status, 'ready')
        fail = true; await refresh.refresh()
        let snapshot = controller.getSnapshot()
        assert.equal(snapshot.notice, null, 'background errors do not enter the chat notice')
        assert.equal(snapshot.catalogDiscovery.source, 'unavailable')
        assert.match(snapshot.catalogDiscovery.sourceError!, /Retrying automatically/)
        assert.equal(snapshot.catalogDiscovery.hosts.find(value => value.id === host.id)?.phase, 'ready')
        assert.equal(snapshot.catalog.byId['kept'], row)
        assert.equal(snapshot.leases.get(pane), lease)
        assert.equal(snapshot.leases.get(pane)?.reference, reference)
        controller.report(new Error('The selected file could not be saved'))
        fail = false; await controller.refresh()
        snapshot = controller.getSnapshot()
        assert.equal(reads, 3, 'existing explicit refresh retries the actual inventory')
        assert.equal(snapshot.catalogDiscovery.source, 'ready')
        assert.equal(snapshot.catalogDiscovery.sourceError, null)
        assert.equal(snapshot.notice, 'The selected file could not be saved', 'catalog recovery does not erase unrelated user errors')
        assert.equal(snapshot.leases.get(pane), lease)
        assert.ok(reference && !source.refs.find(value => value === reference)?.released)
    } finally { unrefresh(); refresh.dispose(); controller.dispose(); source.disposeMain() }
})

test('a Host row update preserves unrelated display rows in the aggregated catalog', () => {
    const source = fixture(); source.add('a'); source.add('b')
    const controller = new WorkspaceController(source.options)
    try {
        const before = controller.getSnapshot().catalog
        source.add('b', 'Updated B', 2)
        const after = controller.getSnapshot().catalog
        assert.equal(after.byId.a, before.byId.a, 'one source update must not invalidate every sidebar row')
        assert.notEqual(after.byId.b, before.byId.b)
        assert.equal(after.byId.b?.displayTitle, 'Updated B')
        assert.deepEqual(after.ids, before.ids)
    } finally { controller.dispose(); source.disposeMain() }
})

test('update checkpoint saves the complete layout, confirmed baseline and pending recovery envelope together', () => {
    let sequence = 0
    const source = fixture(), baseline = initialWorkspace(() => `baseline-${++sequence}`), recovery = initialWorkspace(() => `recovery-${++sequence}`)
    source.memory.set(source.options.storageKey, JSON.stringify({ ...baseline, syncBase: baseline, layoutRecovery: recovery }))
    const controller = new WorkspaceController(source.options)
    try {
        controller.store.renameWindow(controller.store.getSnapshot().activeWindowId, 'Current workspace')
        source.memory.delete(source.options.storageKey)
        controller.checkpoint(new AbortController().signal)
        const saved = JSON.parse(source.memory.get(source.options.storageKey)!)
        assert.equal(saved.windows[0].name, 'Current workspace')
        assert.deepEqual(saved.syncBase, parseWorkspaceState(baseline)); assert.deepEqual(saved.layoutRecovery, parseWorkspaceState(recovery))
        assert.equal(controller.getSnapshot().hasLayoutRecovery, true)
    } finally { controller.dispose() }
})

test('update checkpoint reports storage failure and rejects missing storage, cancelled and disposed owners', () => {
    const source = fixture(), write = source.options.storage!.setItem
    let failed = false, writes = 0
    source.options.storage = { getItem: key => source.memory.get(key) ?? null, setItem(key, value) {
        writes++; if (failed) throw new Error('Storage quota exhausted'); write(key, value)
    } }
    const controller = new WorkspaceController(source.options)
    try {
        failed = true
        assert.doesNotThrow(() => controller.store.renameWindow(controller.store.getSnapshot().activeWindowId, 'Unsaved workspace'))
        assert.throws(() => controller.checkpoint(new AbortController().signal), /quota exhausted/)
        assert.equal(controller.getSnapshot().persistence, 'failed'); assert.match(controller.getSnapshot().notice!, /Workspace save failed/)
        const before = writes, cancelled = new AbortController(); cancelled.abort()
        assert.throws(() => controller.checkpoint(cancelled.signal)); assert.equal(writes, before)
        controller.dispose(); assert.throws(() => controller.checkpoint(new AbortController().signal), /closed/); assert.equal(writes, before)
    } finally { controller.dispose() }
    const { storage: _storage, ...withoutStorage } = source.options, missing = new WorkspaceController(withoutStorage)
    try { assert.throws(() => missing.checkpoint(new AbortController().signal), /storage is unavailable/) }
    finally { missing.dispose() }
})

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
    assert.deepEqual(sessionCreationContext({ ...row, projectionValues: { hapiObserved: { sidechain: { rootSessionId: 'root' } } } as never }), { hostId: row.hostId, directory: row.cwd }, 'retired sidechain metadata cannot restrict an independent current session')
    remove(); controller.dispose(); remote.disposeMain(); source.disposeMain()
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
    assert.equal(controller.getSnapshot().catalog.byId[sessionResourceId('lab', 'same-id')], undefined, 'explicit removal releases the Host catalog')
    const reconnect = controller.addHost({ id: 'lab', label: 'Lab machine', sessions: remote.sessions, navigation: remote.navigation, renderConversation: reference => reference.sessionId })
    assert.equal(controller.getSnapshot().leases.get(remotePane)!.status, 'opening')
    reconnect(); controller.dispose(); local.disposeMain(); remote.disposeMain()
})

test('paired Host disconnect and incomplete inventory preserve the same pane references until authoritative revocation', async () => {
    const local = fixture(), remote = fixture()
    remote.add('one', 'First conversation'); remote.add('two', 'Second conversation')
    const controller = new WorkspaceController(local.options)
    const booted: Promise<void>[] = []
    let starts = 0, stops = 0, revocations = 0
    const hosts = new FederationHosts({
        enqueue: (_id, start) => { booted.push(start()) },
        async boot(host) {
            starts++
            const remove = controller.addHost({ id: host.id, label: host.label, sessions: remote.sessions,
                navigation: remote.navigation, renderConversation: reference => reference.sessionId })
            return { revoke() { revocations++ }, async stop() { stops++; remove() } }
        },
        ready: host => controller.catalogHostReady(host.id, host.label),
        failed: (_host, error) => { throw error },
    })
    const host: FederationHost = { id: 'paired', label: 'Paired machine', online: true, basePath: '/hapi-dsh/machine/paired/' }
    const observe = async (rows: FederationHost[], complete: boolean): Promise<void> => {
        controller.setHostDiscovery(rows)
        await hosts.reconcile(rows, complete)
        await Promise.all(booted)
    }
    try {
        await observe([host], true)
        controller.openSession(sessionResourceId(host.id, 'one'))
        const first = controller.store.focusedPane().id
        controller.openSession(sessionResourceId(host.id, 'two'), 'horizontal')
        const second = controller.store.focusedPane().id
        await turn()
        const firstLease = controller.getSnapshot().leases.get(first)!
        const secondLease = controller.getSnapshot().leases.get(second)!
        assert.equal(firstLease.status, 'ready'); assert.equal(secondLease.status, 'ready')
        const references = remote.refs.filter(ref => ref.source === 'hapiWorkspace')
        await observe([{ ...host, online: false }], true)
        await observe([], false)
        assert.equal(stops, 0, 'temporary availability never disposes the running graph')
        assert.equal(revocations, 0, 'temporary availability retains durable reading data')
        assert.equal(controller.getSnapshot().leases.get(first), firstLease)
        assert.equal(controller.getSnapshot().leases.get(second), secondLease)
        assert.ok(references.every(ref => !ref.released), 'both readers retain their original Session owners')
        assert.equal(controller.getSnapshot().catalog.byId[sessionResourceId(host.id, 'one')]!.hostOnline, false)
        await observe([host], true)
        assert.equal(starts, 1, 'recovery reuses the original graph instead of booting a replacement')
        assert.equal(controller.getSnapshot().leases.get(first), firstLease)
        assert.equal(controller.getSnapshot().catalog.byId[sessionResourceId(host.id, 'one')]!.hostOnline, true)
        assert.equal(controller.getSnapshot().catalogDiscovery.hosts.find(row => row.id === host.id)?.phase, 'ready')
        await observe([], true)
        assert.equal(stops, 1, 'the authoritative removal disposes the same graph')
        assert.equal(revocations, 1, 'explicit removal clears durable data before disposal')
        assert.equal(controller.host(host.id), undefined)
        assert.ok(references.every(ref => ref.released))
        assert.equal(controller.getSnapshot().catalog.byId[sessionResourceId(host.id, 'one')], undefined)
    } finally { await hosts.dispose(); controller.dispose(); local.disposeMain(); remote.disposeMain() }
})

test('revocation during Host bootstrap aborts ownership and disposes a late runtime without registering readiness', async () => {
    const boot = Promise.withResolvers<FederatedHostRuntime>()
    const tasks: Promise<void>[] = []
    let signal: AbortSignal | undefined, ready = 0, stopped = 0, revoked = 0
    const hosts = new FederationHosts({
        enqueue: (_id, start) => { tasks.push(start()) },
        boot: (_host, value) => { signal = value; return boot.promise },
        ready: () => { ready++ },
        failed: (_host, error) => { throw error },
    })
    await hosts.reconcile([{ id: 'paired', label: 'Paired', online: true, basePath: '/hapi-dsh/machine/paired/' }], true)
    await hosts.reconcile([], true)
    assert.equal(signal?.aborted, true)
    boot.resolve({ revoke() { revoked++ }, async stop() { stopped++ } })
    await Promise.all(tasks)
    assert.equal(stopped, 1)
    assert.equal(revoked, 1, 'a late runtime cannot persist a revoked Host again')
    assert.equal(ready, 0, 'a late bootstrap cannot re-advertise a revoked Host')
    await hosts.dispose()
})

test('confirmed Host removal clears an offline saved Host while ordinary teardown preserves it', async () => {
    const cleared: string[] = [], tasks: Promise<void>[] = []
    let stopped = 0, revoked = 0
    const hosts = new FederationHosts({ enqueue: (_id, start) => { tasks.push(start()) },
        boot: async () => ({ revoke() { revoked++ }, async stop() { stopped++ } }),
        ready() {}, failed(_host, error) { throw error }, revoked: host => { cleared.push(host.id) } })
    await hosts.reconcile([{ id: 'offline', label: 'Offline', online: false, basePath: '/hapi-dsh/machine/offline/' }], true)
    await hosts.reconcile([], false)
    assert.deepEqual(cleared, [], 'an incomplete directory has no revocation authority')
    await hosts.reconcile([], true)
    assert.deepEqual(cleared, ['offline'], 'saved data is cleared even if this page never booted the offline Host')
    await hosts.reconcile([{ id: 'live', label: 'Live', online: true, basePath: '/hapi-dsh/machine/live/' }], true)
    await Promise.all(tasks)
    await hosts.dispose()
    assert.equal(stopped, 1); assert.equal(revoked, 0)
    assert.deepEqual(cleared, ['offline'], 'page close retains live Host reading data')
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
    { kind: 'terminal', sessionId: 'saved', terminalId: 'original-terminal',
        target: { type: 'tab', kind: 'terminal', address: 'sidebar://terminal/saved', params: { terminalId: 'original-terminal' } } },
    { kind: 'document', sessionId: 'saved', document: { kind: 'file', path: '/source/original.txt' },
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

test('one sidebar searches current title, native identity, machine and engine without consulting retired projections', () => {
    const id = 'hhpi:lab:original-source:codex:thread1'
    const rows: SessionSummary[] = [
        { id: id as SessionId, displayTitle: 'Refactor API', cwd: '/code/service', running: true, blank: false, updatedAt: 4, retainedBy: {} },
        { id: 'two' as SessionId, displayTitle: 'Review UI', running: false, blank: false, updatedAt: 8, retainedBy: {},
            projectionValues: { hapi: { engine: 'codex', machineId: 'lab', nativeId: 'thread1' } } as never },
    ]
    assert.deepEqual(filterSessions(rows, 'api lab').map(row => row.id), [id])
    assert.deepEqual(filterSessions(rows, '', 'dsh').map(row => row.id), ['two'])
    assert.deepEqual(filterSessions(rows, 'thread1', '', 'lab').map(row => row.id), [id])
})

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

test('finite aliases restore the exact paired Host and preserve unrelated saved resource identities', async () => {
    const local = fixture(), foreign = fixture(), saved = initialWorkspace(() => 'aliases')
    local.add('original-native'); foreign.add('original-native')
    const original = { kind: 'chat', sessionId: 'old-display', sourceSessionId: 'old-source', sourceHubId: 'old-hub' } as const
    saved.windows[0]!.root = { type: 'pane', id: 'saved-chat', resource: original }
    saved.focused[saved.activeWindowId] = 'saved-chat'
    saved.windows.push({ id: 'saved-resources', name: 'Original resource', root: { type: 'pane', id: 'saved-terminal', resource: {
        kind: 'terminal', sessionId: 'old-display', sourceSessionId: 'old-source', sourceHubId: 'old-hub', terminalId: 'original-terminal',
    } } })
    saved.focused['saved-resources'] = 'saved-terminal'
    local.memory.set(local.options.storageKey, JSON.stringify(saved))
    const controller = new WorkspaceController(local.options), requests: unknown[] = []
    const remove = controller.addHost({ id: 'paired', label: 'Paired', sessions: foreign.sessions, navigation: foreign.navigation, renderConversation: () => null })
    controller.installSourceResolver(async reference => { requests.push(reference); return { kind: 'federated-dsh', hostId: 'paired', sessionId: 'original-native' } })
    try {
        await turn()
        assert.deepEqual(requests, [{ kind: 'hapi-session', hubId: 'old-hub', sessionId: 'old-source' }])
        assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: sessionResourceId('paired', 'original-native'), draftOrigin: {
            sessionId: original.sessionId, sourceSessionId: original.sourceSessionId, sourceHubId: original.sourceHubId,
        } })
        assert.equal(controller.getSnapshot().leases.get('saved-chat')?.hostId, 'paired')
        assert.equal(local.refs.length, 0, 'same-named local sessions cannot receive the paired source reference')
        assert.ok(foreign.refs.some(reference => reference.sessionId === 'original-native'))
        const terminal = panes(controller.store.getSnapshot().windows[1]!.root)[0]!.resource
        assert.equal(terminal.kind === 'terminal' && terminal.terminalId, 'original-terminal')
        assert.equal(controller.getSnapshot().leases.get('saved-terminal')?.status, 'failed')
        assert.deepEqual(local.actions, []); assert.deepEqual(foreign.actions, [])
    } finally { remove(); controller.dispose(); local.disposeMain(); foreign.disposeMain() }
})

test('unmapped saved references remain exportable and retry only the original finite alias', async () => {
    const source = fixture(), saved = initialWorkspace(() => 'missing-alias')
    const original = { kind: 'chat', sessionId: 'old-display', sourceSessionId: 'original', sourceHubId: 'old-hub' } as const
    saved.windows[0]!.root = { type: 'pane', id: 'saved', resource: original }; saved.focused[saved.activeWindowId] = 'saved'
    source.memory.set(source.options.storageKey, JSON.stringify(saved))
    const controller = new WorkspaceController(source.options); let calls = 0
    controller.installSourceResolver(async reference => {
        calls++; assert.deepEqual(reference, { kind: 'hapi-session', hubId: 'old-hub', sessionId: 'original' })
        if(calls === 1) throw new SourceAliasResolutionError('not-found', 'No installed migration mapping; export the saved reference.', [{ packageId: 'original-recovery', family: 'sessions', objectId: 'original-object' }])
        source.add('original-native'); return { kind: 'local-dsh', hostId: 'local', sessionId: 'original-native' }
    })
    try {
        await turn()
        assert.equal(controller.getSnapshot().leases.get('saved')?.sourceResolution, 'not-found')
        assert.deepEqual(controller.store.focusedPane().resource, original)
        assert.deepEqual(JSON.parse(controller.exportSavedPaneReference('saved')), { version: 1, resource: original, reference: { kind: 'hapi-session', hubId: 'old-hub', sessionId: 'original' }, recovery: [{ packageId: 'original-recovery', family: 'sessions', objectId: 'original-object' }] })
        assert.deepEqual(JSON.parse(source.memory.get(source.options.storageKey)!).windows[0].root.resource, original)
        source.publish(); await turn(); assert.equal(calls, 1)
        controller.retryPane('saved'); await turn()
        assert.equal(calls, 2); assert.equal(controller.getSnapshot().leases.get('saved')?.sessionId, 'original-native')
        assert.deepEqual(source.actions, [])
    } finally { controller.dispose(); source.disposeMain() }
})

test('an unmapped original shared link opens an exportable failure pane instead of silently keeping unrelated content', async () => {
    const source = fixture()
    const controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'original-link', sourceHubQuery: 'retired-hub' })
    controller.installSourceResolver(async reference => {
        assert.deepEqual(reference, { kind: 'hapi-session', hubId: 'retired-hub', sessionId: 'original-link' })
        throw new SourceAliasResolutionError('not-found', 'No installed mapping', [])
    })
    try {
        await turn()
        const pane = controller.store.focusedPane()
        assert.equal(controller.getSnapshot().leases.get(pane.id)?.sourceResolution, 'not-found')
        assert.deepEqual(JSON.parse(controller.exportSavedPaneReference(pane.id)).reference,
            { kind: 'hapi-session', hubId: 'retired-hub', sessionId: 'original-link' })
        assert.deepEqual(source.actions, [])
    } finally { controller.dispose(); source.disposeMain() }
})

test('removing a saved pane or its resolver aborts a late alias result before it can replace current geometry', async () => {
    for (const dispose of [false, true]) {
        const source = fixture(), saved = initialWorkspace(() => 'late-alias')
        const original = { kind: 'chat', sessionId: 'old-display', sourceSessionId: 'original', sourceHubId: 'old-hub' } as const
        saved.windows[0]!.root = { type: 'pane', id: 'saved', resource: original }; saved.focused[saved.activeWindowId] = 'saved'
        source.memory.set(source.options.storageKey, JSON.stringify(saved))
        const controller = new WorkspaceController(source.options), gate = Promise.withResolvers<void>(); let signal!: AbortSignal
        const remove = controller.installSourceResolver(async (_reference, lifetime) => { signal = lifetime; await gate.promise; return { kind: 'local-dsh', hostId: 'local', sessionId: 'late-native' } })
        try {
            await turn()
            if(dispose) remove(); else controller.store.closePane('saved')
            assert.equal(signal.aborted, true)
            const state = controller.store.getSnapshot()
            source.add('late-native'); gate.resolve(); await turn()
            assert.equal(controller.store.getSnapshot(), state); assert.equal(source.refs.length, 0)
        } finally { remove(); controller.dispose(); source.disposeMain() }
    }
})

test('ordinary DSH restoration never invokes a legacy alias or rewrites a native suffix', async () => {
    const source = fixture(), saved = initialWorkspace(() => 'ordinary')
    source.add('ordinary-r1')
    saved.windows[0]!.root = { type: 'pane', id: 'saved', resource: { kind: 'chat', sessionId: 'ordinary-r1' } }; saved.focused[saved.activeWindowId] = 'saved'
    source.memory.set(source.options.storageKey, JSON.stringify(saved))
    const controller = new WorkspaceController(source.options); let aliases = 0
    controller.installSourceResolver(async () => { aliases++; throw new Error('No legacy source exists') })
    try { await turn(); assert.equal(aliases, 0); assert.equal(controller.getSnapshot().leases.get('saved')?.status, 'ready') }
    finally { controller.dispose(); source.disposeMain() }
})

test('an exact migrated deep link resolves early but opens only after the real layout merge', async () => {
    const source = fixture(), layout = Promise.withResolvers<WorkspaceState>(), alias = Promise.withResolvers<void>(), requests: unknown[] = [], writes: WorkspaceState[] = []
    const controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'original', sourceHubQuery: 'old-hub',
        persistence: { load: () => layout.promise, save: async state => { writes.push(state) } } })
    const initial = controller.store.getSnapshot()
    controller.installSourceResolver(async reference => { requests.push(reference); await alias.promise; source.add('native'); return { kind: 'local-dsh', hostId: 'local', sessionId: 'native' } })
    try {
        await turn(); alias.resolve(); await turn()
        assert.deepEqual(requests, [{ kind: 'hapi-session', hubId: 'old-hub', sessionId: 'original' }])
        assert.equal(controller.store.getSnapshot(), initial); assert.equal(source.refs.length, 0); assert.deepEqual(writes, [])
        let seq = 0; const server = initialWorkspace(() => `server-${++seq}`); server.windows[0]!.name = 'Server geometry'
        layout.resolve(server); await turn()
        assert.equal(controller.store.active().name, 'Server geometry')
        assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: 'native' })
    } finally { controller.dispose(); source.disposeMain() }
})

test('canonical HHPI deep links preserve the message target and resolve an unlisted exact conversation after layout load', async () => {
    const source = fixture(), id = 'hhpi:machine:source:codex:native', layout = Promise.withResolvers<WorkspaceState>()
    const resolved = Promise.withResolvers<void>(), listeners = new Set<() => void>()
    let catalogReady = false
    const capabilities: NonNullable<WorkspaceOptions['sessions']['capabilities']> = { getSnapshot: () => ({ catalogReady, legacyHapi: false }),
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    source.add('ordinary-ready')
    let aliases = 0, exactResolves = 0
    source.sessions.resolveSession = async target => { assert.equal(target, id); exactResolves++; await resolved.promise; source.add(id) }
    const controller = new WorkspaceController({ ...source.options, sessions: { ...source.sessions, capabilities }, sourceSessionQuery: id, sourceMessageQuery: '1000',
        persistence: { load: () => layout.promise, save: async () => {} } })
    controller.installSourceResolver(async () => { aliases++; throw new Error('Current sources do not use retired Hub aliases') })
    try {
        await turn(); assert.equal(exactResolves, 0); assert.equal(source.refs.length, 0)
        layout.resolve(controller.store.getSnapshot()); await turn(); await turn()
        const pane = controller.store.focusedPane()
        assert.deepEqual(pane.resource, { kind: 'chat', sessionId: id })
        assert.equal(controller.getSnapshot().catalog.phase, 'ready')
        assert.ok(controller.getSnapshot().catalog.byId['ordinary-ready'])
        assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'pending')
        assert.equal(controller.getSnapshot().catalogDiscovery.source, 'pending')
        assert.equal(controller.getSnapshot().leases.get(pane.id)?.status, 'opening', 'an ordinary-ready list cannot delete or reject an unresolved native target')
        resolved.resolve(); await turn(); await turn()
        catalogReady = true; for (const listener of listeners) listener()
        assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'ready')
        assert.deepEqual(controller.readingIntent(pane.id)?.target, { kind: 'message', messageId: '1000', origin: 'link' })
        assert.equal(aliases, 0); assert.equal(exactResolves, 1)
        assert.equal(controller.getSnapshot().leases.get(pane.id)?.status, 'ready')
    } finally { controller.dispose(); source.disposeMain() }
})

test('canonical native message links resolve exact source coordinates and ignore newer navigation or accounts', async () => {
    const id = 'hhpi:machine:source:codex:native'
    for (const superseded of ['none', 'navigation', 'account', 'focus']) {
        const application = new WorkspaceApplicationIdentity()
        const source = fixture(), location = Promise.withResolvers<Awaited<ReturnType<NonNullable<WorkspaceOptions['locateSourcePosition']>>>>()
        source.add(id); source.add('ordinary')
        const calls: unknown[] = []
        const controller = new WorkspaceController({ ...source.options, application, sourceSessionQuery: id, sourceMessageQuery: 'codex:native:turn%3Aone:item%2Fone',
            locateSourcePosition: (request, signal) => { calls.push(request); assert.equal(signal?.aborted, false); return location.promise } })
        try {
            await turn(); assert.deepEqual(calls, [], 'unknown authenticated account waits before resolving private source coordinates')
            application.set({ accountId: 'first', origin: 'https://first.test' }, 'device')
            await turn()
            assert.deepEqual(calls, [{ sessionId: id, position: { turnId: 'turn:one', itemId: 'item/one' } }])
            if (superseded === 'navigation') controller.openSession('ordinary')
            if (superseded === 'focus') controller.focusPane(controller.store.focusedPane().id)
            if (superseded === 'account') application.set({ accountId: 'second', origin: 'https://first.test' }, 'device')
            location.resolve({ ok: true, value: { epoch: 'source-epoch', seq: 1000 } })
            await turn(); await turn()
            const pane = controller.store.focusedPane()
            if (superseded === 'account' || superseded === 'focus') assert.equal(pane.resource.kind, 'empty', 'an old-account or superseded startup resolution cannot navigate the new selection')
            else {
                assert.equal(pane.resource.kind === 'chat' && pane.resource.sessionId, superseded === 'navigation' ? 'ordinary' : id)
                assert.deepEqual(controller.readingIntent(pane.id)?.target, superseded === 'navigation' ? { kind: 'latest' }
                    : { kind: 'message', messageId: '1000', epoch: 'source-epoch', origin: 'link' })
            }
        } finally { controller.dispose(); application.dispose(); source.disposeMain() }
    }
    const source = fixture(); source.add(id); let reads = 0
    const controller = new WorkspaceController({ ...source.options, sourceSessionQuery: id, sourceMessageQuery: 'codex:another-thread:turn:item',
        locateSourcePosition: async () => { reads++; return { ok: true, value: { epoch: 'wrong', seq: 1 } } } })
    try { await turn(); assert.equal(reads, 0); assert.match(controller.getSnapshot().notice ?? '', /another source conversation/) }
    finally { controller.dispose(); source.disposeMain() }
})

test('malformed HHPI deep links report the invalid identity without acquiring another source', async () => {
    const source = fixture(), controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'hhpi:incomplete' })
    try { await turn(); assert.equal(source.refs.length, 0); assert.match(controller.getSnapshot().notice ?? '', /Invalid source session identity/) }
    finally { controller.dispose(); source.disposeMain() }
})

test('a deep link without its original Hub remains unresolved instead of adopting a polled primary Hub', async () => {
    const source = fixture(), controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'original' }); let reads = 0
    controller.installSourceResolver(async () => { reads++; return { kind: 'local-dsh', hostId: 'local', sessionId: 'native' } })
    try { source.add('native'); await turn(); assert.equal(reads, 0); assert.equal(source.refs.length, 0) }
    finally { controller.dispose(); source.disposeMain() }
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



test('HHPI rename and archive use source receipts without the ordinary Host workspace registry', async () => {
    const source = fixture(), id = 'hhpi:machine:source:codex:native', actions: string[] = []
    source.add(id)
    const controller = new WorkspaceController({ ...source.options, sourceActions: {
        rename: async (target, title) => { assert.equal(target, id); actions.push(`native rename:${title}`) },
        archive: async (target, archived) => { assert.equal(target, id); actions.push(`native archive:${archived}`); source.project(id, { hhpiArchived: archived }) },
    }, navigation: { ...source.navigation,
        archiveSession: async target => { assert.equal(target, id); actions.push('workspace archive') },
        unarchiveSession: async target => { assert.equal(target, id); actions.push('workspace unarchive') },
    } })
    try {
        controller.openSession(id)
        await controller.renameSession(id, '  Confirmed title  ')
        assert.deepEqual(source.renamed, [], 'native rename cannot fabricate the official SessionFace event sequence')
        await controller.sessionAction(id, 'archive')
        assert.equal(controller.store.focusedPane().resource.kind, 'empty')
        assert.equal(controller.getSnapshot().catalog.byId[id]?.archived, true)
        await controller.sessionAction(id, 'unarchive')
        assert.deepEqual(actions, ['native rename:Confirmed title', 'native archive:true', 'native archive:false'])
        assert.equal(controller.getSnapshot().catalog.byId[id]?.archived, false)
    } finally { controller.dispose(); source.disposeMain() }
})

test('unknown HHPI native archive cannot hide the conversation or close its saved pane', async () => {
    const source = fixture(), id = 'hhpi:machine:source:codex:native'
    source.add(id)
    const controller = new WorkspaceController({ ...source.options, sourceActions: {
        rename: async () => { throw new Error('Original rename outcome is unknown') },
        archive: async () => { throw new Error('Original archive outcome is unknown; reconcile that operation') },
    } })
    try {
        controller.openSession(id); const original = controller.store.focusedPane().resource
        await assert.rejects(controller.sessionAction(id, 'archive'), /Original archive outcome is unknown/)
        assert.deepEqual(controller.store.focusedPane().resource, original); assert.deepEqual(source.actions, [])
        await assert.rejects(controller.renameSession(id, 'Another title'), /Original rename outcome is unknown/)
        assert.deepEqual(source.renamed, [])
    } finally { controller.dispose(); source.disposeMain() }
})

test('late aliases cannot bypass a failed layout read or a disposed deep-link owner', async () => {
    for (const mode of ['failed-layout', 'disposed'] as const) {
        const source = fixture(), layout = Promise.withResolvers<WorkspaceState>(), alias = Promise.withResolvers<void>(), writes: WorkspaceState[] = []
        let signal!: AbortSignal
        const controller = new WorkspaceController({ ...source.options, sourceSessionQuery: 'original', sourceHubQuery: 'old-hub',
            persistence: { load: () => layout.promise, save: async state => { writes.push(state) } } })
        const initial = controller.store.getSnapshot()
        controller.installSourceResolver(async (_reference, lifetime) => { signal = lifetime; await alias.promise; source.add('late-native'); return { kind: 'local-dsh', hostId: 'local', sessionId: 'late-native' } })
        try {
            await turn()
            if (mode === 'disposed') { controller.dispose(); assert.equal(signal.aborted, true); layout.resolve(initial) }
            else layout.reject(new Error('Original layout is unavailable'))
            alias.resolve(); await turn()
            assert.equal(controller.store.getSnapshot(), initial); assert.equal(source.refs.length, 0); assert.deepEqual(writes, [])
        } finally { controller.dispose(); source.disposeMain() }
    }
})


test('current HHPI rows keep official workspace bookmark ownership without Hub overlays', () => {
    const source = fixture(), id = 'hhpi:machine:codex-source:codex:thread'
    source.add(id, 'Native title', 100, '/source/project')
    source.options.workspaceState = { getSnapshot: () => ({ archivedSessionIds: [id], pinnedSessionIds: [id] }), subscribe: () => () => {} }
    const controller = new WorkspaceController(source.options)
    const row = controller.getSnapshot().catalog.byId[id]!
    assert.equal(row.archived, true); assert.equal(row.pinned, true)
    assert.equal(row.updatedAt, 100)
    assert.deepEqual(sessionCreationContext(row), { hostId: 'local', directory: '/source/project', machineId: 'machine', engine: 'codex', sourceSessionId: id })
    controller.dispose(); source.disposeMain()
})

test('offline original-reference titles never adopt another live catalog title', () => {
    const source = fixture(), display = 'hapi-codex-' + '1'.repeat(32)
    source.memory.set('workspace-test:pane-titles:v1', JSON.stringify({ version: 1, titles: { [JSON.stringify(['original-hub', 'original-session'])]: 'Saved original title' } }))
    const controller = new WorkspaceController(source.options)
    controller.store.openResource({ kind: 'chat', sessionId: display, sourceHubId: 'original-hub', sourceSessionId: 'original-session' })
    const paneId = controller.store.focusedPane().id
    assert.equal(controller.getSnapshot().sourcePaneTitles[paneId], 'Saved original title')
    source.add(display, 'Unrelated live label')
    assert.equal(controller.getSnapshot().sourcePaneTitles[paneId], 'Saved original title')
    controller.store.openResource({ kind: 'chat', sessionId: display, sourceHubId: 'another-hub', sourceSessionId: 'original-session' })
    assert.equal(controller.getSnapshot().sourcePaneTitles[paneId], undefined)
    controller.dispose(); source.disposeMain()
})

test('paired Host discovery reports partial availability without hiding the loaded local catalog', () => {
    const source = fixture(); source.add('ordinary')
    const controller = new WorkspaceController(source.options)
    assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'ready')
    controller.setHostDiscovery([{ id: 'peer', label: 'Peer', online: true }])
    assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'pending')
    controller.catalogHostFailed('peer', 'Peer', new Error('Synthetic offline'))
    assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'partial')
    assert.equal(controller.getSnapshot().catalog.byId.ordinary!.hostOnline, true)
    controller.catalogHostReady('peer', 'Peer')
    assert.equal(controller.getSnapshot().catalogDiscovery.phase, 'ready')
    controller.dispose(); source.disposeMain()
})

function focusedResourceId(controller: WorkspaceController): string | false {
    const resource = controller.store.focusedPane().resource
    return resource.kind === 'chat' && resource.sessionId
}

test('same-native original Host routing preserves saved Pane, directory and full canonical link ownership', async () => {
    const id = 'hhpi:windows:win-native:codex:thread', target = sessionResourceId('windows', id)
    for (const entry of ['saved-pane', 'directory', 'canonical-link']) {
        const local = fixture(), remote = fixture(), application = new WorkspaceApplicationIdentity()
        application.set({ accountId: 'owner', origin: 'https://workspace.test' }, 'device')
        const metadata = { id, machineId: 'windows', sourceId: 'win-native', engine: 'codex', nativeId: 'thread',
            title: 'Original Windows thread', cwd: 'C:\\work', updatedAt: 1, status: 'idle' as const, activeTurnId: null,
            connection: { state: 'online' as const, observedAt: 1 }, capabilities: { send: true, steer: true, cancel: true, approve: true, files: true }, pendingRequests: [] }
        local.add(id); local.project(id, { hhpiSource: { ...metadata, capabilities: { ...metadata.capabilities, send: false } } })
        remote.sessions.captureWorkspaceAccess = () => ({ scope: 'original-account', signal: new AbortController().signal, assertCurrent() {} })
        if (entry === 'saved-pane') {
            const layout = initialWorkspace(() => 'saved'); layout.windows[0]!.root = { type: 'pane', id: 'original-pane', resource: { kind: 'chat', sessionId: id } }
            layout.focused[layout.activeWindowId] = 'original-pane'; local.memory.set(local.options.storageKey, JSON.stringify(layout))
        }
        const controller = new WorkspaceController({ ...local.options, application, ...(entry === 'canonical-link' ? { sourceSessionQuery: id, sourceMessageQuery: '42' } : {}) })
        let stop: (() => void) | undefined
        try {
            const before = controller.store.focusedPane().id, transfers: unknown[] = []
            controller.addHost({ id: 'windows', label: 'Windows', sessions: remote.sessions, navigation: remote.navigation, renderConversation: () => null })
            controller.setHostDiscovery([{ id: 'windows', label: 'Windows', online: true }])
            assert.notEqual(focusedResourceId(controller), target,
                'a registered Host without its exact own catalog row cannot take the Pane')
            remote.phase('pending')
            remote.add(id); remote.project(id, { hhpiSource: metadata })
            if (entry !== 'directory') {
                assert.equal(focusedResourceId(controller), id,
                    'the existing native input owns draft/attachment readiness')
                stop = controller.registerSourceRouteCheckpoint(before, { sessionId: id, transfer(route) { transfers.push(route); return true } })
                await turn()
            } else controller.openSession(id)
            assert.equal(remote.sessions.list.getSnapshot().phase, 'pending', 'unrelated ordinary directory remains pending')
            assert.deepEqual(controller.store.focusedPane().resource, { kind: 'chat', sessionId: target })
            assert.equal(controller.store.focusedPane().id, before)
            assert.deepEqual(controller.getSnapshot().catalog.ids, [target])
            assert.ok(controller.getSnapshot().catalog.byId[id], 'a blocked old Pane keeps its exact readable shadow row')
            assert.equal(controller.source(target).host.sessions, remote.sessions)
            assert.equal(controller.source(target).sessionId, id)
            assert.equal(controller.getSnapshot().catalog.byId[target]?.projectionValues?.hhpiSource?.capabilities.send, true)
            if (entry === 'canonical-link') assert.deepEqual(controller.readingIntent(before)?.target, { kind: 'message', messageId: '42', origin: 'link' })
            if (entry !== 'directory') assert.ok(transfers.length)
            assert.equal(local.actions.length + remote.actions.length, 0, 'route correction never starts or submits to a native session')
        } finally { stop?.(); controller.dispose(); local.disposeMain(); remote.disposeMain(); application.dispose() }
    }
})

test('same-native route keeps the original Pane for unsafe drafts and rejects wrong or offline owner metadata', async () => {
    const id = 'hhpi:windows:source:codex:thread', target = sessionResourceId('windows', id)
    const local = fixture(), remote = fixture(), application = new WorkspaceApplicationIdentity()
    application.set({ accountId: 'owner', origin: 'https://workspace.test' }, 'device')
    local.add(id); remote.add(id)
    remote.sessions.captureWorkspaceAccess = () => ({ scope: 'original-account', signal: new AbortController().signal, assertCurrent() {} })
    const metadata = { id, machineId: 'windows', sourceId: 'source', engine: 'codex', nativeId: 'thread', title: 'Original', cwd: 'C:\\work', updatedAt: 1,
        status: 'idle' as const, activeTurnId: null, capabilities: { send: true, steer: true, cancel: true, approve: true, files: true }, pendingRequests: [] }
    const controller = new WorkspaceController({ ...local.options, application, sourceSessionQuery: id })
    let safe = false, called = 0
    const stop = controller.registerSourceRouteCheckpoint(controller.store.focusedPane().id, { sessionId: id, transfer() { called++; return safe } })
    try {
        controller.addHost({ id: 'windows', label: 'Original', sessions: remote.sessions, navigation: remote.navigation, renderConversation: () => null })
        remote.project(id, { hhpiSource: { ...metadata, nativeId: 'other-thread' } })
        await turn(); assert.equal(called, 0)
        remote.project(id, { hhpiSource: metadata })
        assert.equal(focusedResourceId(controller), id)
        controller.openSession(target)
        assert.equal(focusedResourceId(controller), id,
            'directory and full links cannot bypass an attachment, in-flight request or target draft conflict veto')
        controller.setHostDiscovery([{ id: 'windows', label: 'Original', online: false }]); safe = true
        local.publish(); assert.ok(controller.getSnapshot().catalog.ids.includes(id as SessionId))
        assert.equal(focusedResourceId(controller), id)
        controller.setHostDiscovery([{ id: 'windows', label: 'Original', online: true }]); controller.catalogHostReady('windows', 'Original')
        assert.equal(focusedResourceId(controller), target)
        assert.equal(local.actions.length + remote.actions.length, 0)
    } finally { stop(); controller.dispose(); local.disposeMain(); remote.disposeMain(); application.dispose() }
})
