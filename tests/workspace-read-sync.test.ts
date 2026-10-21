/** CAS tests use a fake Hub while retaining the real sidebar intent/outbox code. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { HapiRemoteApi } from '../src/client-api.ts'
import type { SourceReadState, SourceReadStateWrite } from '../src/native-library-types.ts'
import type { WorkspaceCatalogRow, WorkspaceController } from '../src/client/controller.ts'
import { SidebarState } from '../src/workspace/sidebar-state.ts'
import { SourceReadSync, type SourceReadStatus } from '../src/workspace/read-sync.ts'

const ok = <T>(value: T) => ({ ok: true as const, value })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(memory = new Map<string, string>(), displayId = 'display') {
    const listeners = new Set<() => void>(), errors: unknown[] = []
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) } }
    const sidebar = new SidebarState(storage, 'sidebar')
    const row = { id: displayId, hostId: 'local', projectionValues: { hapiObserved: { hapiSessionId: 'original-source', hubId: 'hub' } } } as unknown as WorkspaceCatalogRow
    const controller = { sidebar, options: { storageKey: 'workspace', storage }, getSnapshot: () => ({ catalog: { byId: { [displayId]: row } } }),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, report: (error: unknown) => { errors.push(error) },
    } as unknown as WorkspaceController
    return { controller, sidebar, errors, memory }
}
type Api = Pick<HapiRemoteApi, 'sourceReadStates' | 'sourceReadStateWrite'>

test('a source read conflict rebases the original user intent without using a display ID as source', async () => {
    const view = fixture(), writes: SourceReadStateWrite[] = []
    let source: SourceReadState = { version: 1, seenAt: 10, manualUnreadAt: null }
    const api: Api = { sourceReadStates: async () => ok({ 'original-source': source }), sourceReadStateWrite: async request => {
        writes.push(request)
        if (writes.length === 1) { source = { version: 2, seenAt: 25, manualUnreadAt: 30 }; return ok({ applied: false, state: source }) }
        source = { version: source.version + 1, seenAt: request.seenAt, manualUnreadAt: request.manualUnreadAt }; return ok({ applied: true, state: source })
    } }
    const sync = new SourceReadSync(view.controller, api)
    view.sidebar.markSeen('display', 20)
    await sync.refresh()
    assert.deepEqual(writes, [
        { sourceSessionId: 'original-source', expectedVersion: 1, seenAt: 20, manualUnreadAt: null },
        { sourceSessionId: 'original-source', expectedVersion: 2, seenAt: 25, manualUnreadAt: null },
    ])
    assert.equal(view.sidebar.getSnapshot().seen.display, 25)
    assert.deepEqual(JSON.parse(view.memory.get('workspace:native-read-outbox')!), [])
    sync.dispose()
})

test('a newer unread intent survives an older in-flight seen acknowledgement', async () => {
    const view = fixture(), writes: SourceReadStateWrite[] = []
    let reply!: (value: Awaited<ReturnType<Api['sourceReadStateWrite']>>) => void
    let source: SourceReadState = { version: 0, seenAt: 0, manualUnreadAt: null }
    const api: Api = { sourceReadStates: async () => ok({ 'original-source': source }), sourceReadStateWrite: async request => {
        writes.push(request)
        if (writes.length === 1) return new Promise(resolve => { reply = resolve })
        source = { version: 2, seenAt: request.seenAt, manualUnreadAt: request.manualUnreadAt }; return ok({ applied: true, state: source })
    } }
    const sync = new SourceReadSync(view.controller, api)
    await sync.refresh()
    view.sidebar.markSeen('display', 100)
    view.sidebar.markUnread('display', 110)
    reply(ok({ applied: true, state: { version: 1, seenAt: 100, manualUnreadAt: null } }))
    await flush()
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[1], { sourceSessionId: 'original-source', expectedVersion: 1, seenAt: 100, manualUnreadAt: 110 })
    assert.equal(view.sidebar.getSnapshot().unread.display, 110)
    sync.dispose()
})

test('offline bookmark outbox follows a source through a new display generation and reload', async () => {
    const previous = fixture()
    const offline = new SourceReadSync(previous.controller, { sourceReadStates: async () => { throw new Error('offline') }, sourceReadStateWrite: async () => { throw new Error('no writes while unloaded') } })
    previous.sidebar.markUnread('display', 88)
    await offline.refresh(); offline.dispose()
    const current = fixture(previous.memory, 'display-r2'), writes: SourceReadStateWrite[] = []
    const restored = new SourceReadSync(current.controller, { sourceReadStates: async () => ok({ 'original-source': { version: 3, seenAt: 60, manualUnreadAt: null } }),
        sourceReadStateWrite: async request => { writes.push(request); return ok({ applied: true, state: { version: 4, seenAt: request.seenAt, manualUnreadAt: request.manualUnreadAt } }) } })
    await restored.refresh()
    assert.deepEqual(writes, [{ sourceSessionId: 'original-source', expectedVersion: 3, seenAt: 60, manualUnreadAt: 88 }])
    assert.equal(current.sidebar.getSnapshot().unread['display-r2'], 88)
    restored.dispose()
})

test('badge readiness distinguishes a failed refresh from a confirmed empty source snapshot', async () => {
    const view = fixture(), states: SourceReadStatus[] = []
    let offline = false
    const sync = new SourceReadSync(view.controller, {
        sourceReadStates: async () => { if (offline) throw new Error('source unavailable'); return ok({}) },
        sourceReadStateWrite: async () => { throw new Error('this test has no writes') },
    }, state => { states.push(state) })
    await sync.refresh(); offline = true; await sync.refresh(); offline = false; await sync.refresh()
    assert.deepEqual(states, ['pending', 'ready', 'pending', 'error', 'pending', 'ready'])
    sync.dispose()
})
