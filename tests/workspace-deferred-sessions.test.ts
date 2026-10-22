/** Explicit Session Controller/catalog fixtures; no real Host is exercised. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionBinding, SessionListState, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceController, type WorkspaceOptions } from '../src/client/controller.ts'
import { parseWorkspaceState, type PaneNode, type WorkspaceState } from '../src/client/model.ts'

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function layout(): WorkspaceState {
    let serial = 0
    const windows = [4, 4, 5].map((count, i) => ({ id: `window-${i}`, name: `Window ${i}`, root: {
        type: 'split' as const, id: `split-${i}`, axis: 'horizontal' as const,
        children: Array.from({ length: count }, (): PaneNode => {
            const n = serial++
            return { type: 'pane', id: `pane-${n}`, resource: { kind: 'chat', sessionId: `session-${n}` } }
        }), weights: Array(count).fill(1) as number[],
    } }))
    return parseWorkspaceState({ schemaVersion: 1, revision: 1, windows, activeWindowId: 'window-0',
        focused: { 'window-0': 'pane-0', 'window-1': 'pane-4', 'window-2': 'pane-8' }, zoomed: {} })
}

function fixture(state = layout(), missing: readonly string[] = []) {
    const refs: Array<{ id: string; releases: number }> = []
    const ids = Array.from({ length: 13 }, (_, i) => `session-${i}` as SessionId).filter(id => !missing.includes(id))
    const catalog: SessionListState = { ids, byId: Object.fromEntries(ids.map(id => [id,
        { id, displayTitle: id, running: false, blank: false, updatedAt: 1, retainedBy: {} },
    ])), phase: 'ready', projectionsBySession: {} }
    const sessions: WorkspaceOptions['sessions'] = {
        list: { getSnapshot: () => catalog, subscribe: () => () => {} },
        retain(target) {
            const id = typeof target === 'string' ? target : target.childSessionId
            const record = { id, releases: 0 }; refs.push(record)
            const binding = { sessionId: id } as SessionBinding
            const reference: SessionReference = { sessionId: id, binding, ready: Promise.resolve(binding),
                release() { record.releases++ }, [Symbol.dispose]() { this.release() } }
            return reference
        },
        async using(target, options, operation) {
            const reference = sessions.retain(target, options)
            try { return await operation(reference) } finally { reference.release() }
        },
        async refresh() {}, async create() { return 'created' as SessionId },
        async search() { return { ok: true, value: { items: [], hasMore: false } } },
    }
    const options: WorkspaceOptions = { sessions, deferHiddenSessions: true, catalogSettleMs: 0, storageKey: 'fixture',
        storage: { getItem: () => JSON.stringify(state), setItem() {} },
        navigation: { openSession() {}, startSession() {}, async archiveSession() {}, async unarchiveSession() {},
            async pinSession() {}, async unpinSession() {}, async forkSession(id) { return id } },
    }
    return { options, refs }
}

test('13 restored panes acquire only the visible four and preserve already bound windows', async () => {
    const f = fixture(), controller = new WorkspaceController(f.options)
    try {
        await tick()
        assert.equal(f.refs.length, 4)
        assert.equal(controller.getSnapshot().leases.size, 4)
        for (let i = 4; i < 13; i++) assert.equal(controller.getSnapshot().leases.has(`pane-${i}`), false)
        const first = controller.getSnapshot().leases.get('pane-0')?.reference
        controller.store.selectWindow('window-1'); await tick()
        assert.equal(f.refs.length, 8)
        assert.ok(f.refs.every(ref => ref.releases === 0))
        controller.store.selectWindow('window-0'); await tick()
        assert.equal(f.refs.length, 8)
        assert.equal(controller.getSnapshot().leases.get('pane-0')?.reference, first)
        controller.store.closePane('pane-0')
        assert.equal(f.refs.find(ref => ref.id === 'session-0')?.releases, 1)
        controller.store.closeWindow('window-2')
        assert.equal(f.refs.length, 8, 'closing a never-visible window does not acquire it')
    } finally { controller.dispose() }
    assert.ok(f.refs.every(ref => ref.releases === 1), 'every owned reference releases exactly once')
})

test('a deferred missing session is classified only when its window becomes visible', async () => {
    const f = fixture(layout(), ['session-4']), controller = new WorkspaceController(f.options)
    try {
        await tick()
        assert.equal(controller.getSnapshot().leases.has('pane-4'), false)
        controller.store.selectWindow('window-1'); await tick()
        assert.equal(controller.getSnapshot().leases.get('pane-4')?.status, 'failed')
        assert.equal(controller.getSnapshot().leases.get('pane-4')?.reason, 'session-not-listed')
        assert.equal(f.refs.length, 7)
    } finally { controller.dispose() }
})

test('initial zoom acquires its focused pane; revealing siblings acquires them once', async () => {
    const state = layout(); state.zoomed['window-0'] = true
    const f = fixture(state), controller = new WorkspaceController(f.options)
    try {
        await tick()
        assert.deepEqual(f.refs.map(ref => ref.id), ['session-0'])
        controller.store.toggleZoom(); await tick()
        assert.equal(f.refs.length, 4)
        controller.store.toggleZoom(); await tick()
        assert.equal(f.refs.length, 4)
        assert.ok(f.refs.every(ref => ref.releases === 0))
    } finally { controller.dispose() }
})

test('legacy default keeps the original eager lease behavior', async () => {
    const f = fixture(), controller = new WorkspaceController({ ...f.options, deferHiddenSessions: false })
    try { await tick(); assert.equal(f.refs.length, 13) }
    finally { controller.dispose() }
})
