import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceStore, initialWorkspace, panes, paneRectangles, parseWorkspaceState } from '../src/client/model.ts'
import { acceptsWorkspaceDrag, readWorkspaceDrag, writeWorkspaceDrag, workspaceDockPosition, PANE_DRAG_TYPE, SESSION_DRAG_TYPE } from '../src/workspace/drag.ts'

const workspace = (beforeRemove?: () => boolean) => {
    let sequence = 0
    const next = () => `drag-${++sequence}`
    return new WorkspaceStore(initialWorkspace(next), next, beforeRemove)
}

test('edge docking moves the same plugin occurrence and never invokes a close guard', () => {
    let closes = 0
    const store = workspace(() => { closes++; return false })
    const view = { kind: 'view' as const, sessionId: 'source-display', sourceSessionId: 'original-source', viewId: 'official-tab-occurrence',
        target: { type: 'resource' as const, address: 'dsh-resource://terminal/session/source-display/terminal-one', kind: 'terminal', params: { scroll: 42 } } }
    store.openResource(view); const terminal = store.focusedPane().id
    store.split('horizontal', { kind: 'chat', sessionId: 'other-host:session' }); const chat = store.focusedPane().id
    store.dockPane(terminal, chat, 'bottom')
    assert.equal(closes, 0); assert.equal(store.focusedPane().id, terminal)
    assert.deepEqual(store.focusedPane().resource, view)
    assert.deepEqual(paneRectangles(store.active().root).map(value => [value.id, value.left, value.top, value.width, value.height]), [
        [chat, 0, 0, 100, 50], [terminal, 0, 50, 100, 50],
    ])
    const targetWindow = store.createWindow('Elsewhere'), empty = store.focusedPane().id
    store.dockPane(terminal, empty, 'center')
    assert.equal(store.active().id, targetWindow); assert.equal(store.focusedPane().id, terminal)
    assert.equal(closes, 0); assert.deepEqual(store.focusedPane().resource, view)
    assert.equal(store.getSnapshot().windows.flatMap(window => panes(window.root)).filter(pane => pane.id === terminal).length, 1)
    assert.deepEqual(parseWorkspaceState(JSON.parse(JSON.stringify(store.getSnapshot()))), store.getSnapshot())
})

test('docking a new source session preserves surrounding geometry, deduplicates, and does not replace occupied centers', () => {
    const store = workspace()
    store.openSession('first'); const first = store.focusedPane().id
    store.split('horizontal', { kind: 'chat', sessionId: 'second' }); const second = store.focusedPane().id
    store.dockResource({ kind: 'chat', sessionId: 'native-display', sourceSessionId: 'native-source', sourceHubId: 'hub' }, first, 'top')
    const added = store.focusedPane().id
    assert.deepEqual(paneRectangles(store.active().root).map(value => [value.id, value.left, value.top, value.width, value.height]), [
        [added, 0, 0, 50, 50], [first, 0, 50, 50, 50], [second, 50, 0, 50, 100],
    ])
    store.dockResource({ kind: 'chat', sessionId: 'native-display' }, second, 'left')
    assert.equal(panes(store.active().root).length, 3); assert.equal(store.focusedPane().id, added)
    const previous = store.getSnapshot()
    store.dockResource({ kind: 'chat', sessionId: 'must-not-replace' }, first, 'center')
    store.dockPane(added, first, 'center'); store.dockPane(first, first, 'left')
    assert.equal(store.getSnapshot(), previous)
    store.createWindow(); const empty = store.focusedPane().id
    store.dockResource({ kind: 'chat', sessionId: 'empty-target' }, empty, 'right')
    assert.equal(store.focusedPane().id, empty); assert.equal(panes(store.active().root).length, 1)
})

test('drag MIME is distinct from attachments and invalid IDs never become layout mutations', () => {
    const data = new Map<string, string>()
    const transfer = { types: [] as string[], getData: (type: string) => data.get(type) ?? '', setData(type: string, value: string) { data.set(type, value); this.types.push(type) }, effectAllowed: 'none' as DataTransfer['effectAllowed'] }
    assert.equal(acceptsWorkspaceDrag({ types: ['Files', 'text/plain'] }), false)
    writeWorkspaceDrag(transfer, { kind: 'session', sessionId: 'hapi-remote:runner-one:session-one' })
    assert.deepEqual(readWorkspaceDrag(transfer), { kind: 'session', sessionId: 'hapi-remote:runner-one:session-one' })
    assert.equal(transfer.effectAllowed, 'copyMove')
    transfer.types = []; data.clear()
    writeWorkspaceDrag(transfer, { kind: 'pane', paneId: 'existing-pane' })
    assert.deepEqual(readWorkspaceDrag(transfer), { kind: 'pane', paneId: 'existing-pane' }); assert.equal(transfer.effectAllowed, 'move')
    data.set(PANE_DRAG_TYPE, '\u0000invalid'); assert.equal(readWorkspaceDrag(transfer), null)
    assert.equal(readWorkspaceDrag({ types: [SESSION_DRAG_TYPE], getData: () => 'a'.repeat(257) }), null)
    assert.equal(workspaceDockPosition(20, 50, 100, 100, false), 'left')
    assert.equal(workspaceDockPosition(50, 99, 100, 100, false), 'bottom')
    assert.equal(workspaceDockPosition(50, 50, 100, 100, false), null)
    assert.equal(workspaceDockPosition(50, 50, 100, 100, true), 'center')
    assert.equal(workspaceDockPosition(50, 50, 0, 100, true), null)
})
