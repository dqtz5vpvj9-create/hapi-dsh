import assert from 'node:assert/strict'
import test from 'node:test'
import { adjacentPane, initialWorkspace, paneRectangles, panes, parseWorkspaceState, splitBoundaries, WorkspaceStore, type WorkspaceState } from '../src/client/model.ts'
import { PrefixKeys, runWorkspaceCommand, WORKSPACE_PREFIX_TIMEOUT_MS } from '../src/client/shortcuts.ts'

function workspace() {
    let sequence = 0
    const nextId = () => `id-${++sequence}`
    return new WorkspaceStore(initialWorkspace(nextId), nextId)
}

test('one editable occurrence of a Session across all windows', () => {
    const store = workspace()
    store.openSession('codex-native-1')
    const firstPane = store.focusedPane().id
    const firstWindow = store.active().id
    store.createWindow('Build')
    store.openSession('dsh-2')
    store.openSession('codex-native-1', 'horizontal')
    assert.equal(store.focusedPane().id, firstPane)
    assert.equal(store.active().id, firstWindow)
    assert.equal(store.getSnapshot().windows.flatMap(window => panes(window.root)).filter(pane => pane.resource.kind === 'chat').length, 2)
})

test('mixed nested splits preserve geometry, focus and weights after pane closure', () => {
    const store = workspace()
    store.openSession('a')
    store.split('horizontal', { kind: 'chat', sessionId: 'b' })
    const rightId = store.focusedPane().id
    const split = store.active().root
    assert.equal(split.type, 'split')
    store.resize(split.id, 0, 3, 1)
    store.split('vertical', { kind: 'chat', sessionId: 'c' })
    const rectangles = paneRectangles(store.active().root)
    assert.deepEqual(rectangles.map(({ width, height }) => [width, height]), [[75, 100], [25, 50], [25, 50]])
    const focused = store.focusedPane().id
    assert.equal(adjacentPane(store.active().root, rightId, 'down'), focused)
    store.closePane(rightId)
    assert.deepEqual(paneRectangles(store.active().root).map(({ width, height }) => [width, height]), [[75, 100], [25, 100]])
    assert.equal(store.focusedPane().id, focused)
    store.closePane(focused)
    assert.equal(store.active().root.type, 'pane')
    assert.deepEqual(paneRectangles(store.active().root).map(({ width, height }) => [width, height]), [[100, 100]])
})

test('close and undo a window restores pane identities, but deduplicates sessions opened elsewhere', () => {
    const store = workspace()
    store.openSession('native-thread')
    const original = store.active()
    const paneId = store.focusedPane().id
    store.closeWindow(original.id)
    assert.equal(store.canRestoreWindow(), true)
    assert.equal(store.getSnapshot().windows.length, 1)
    store.openSession('native-thread')
    store.restoreWindow()
    assert.equal(store.active().id, original.id)
    assert.equal(store.focusedPane().id, paneId)
    assert.deepEqual(store.focusedPane().resource, { kind: 'empty' })
    assert.equal(store.getSnapshot().windows.flatMap(window => panes(window.root)).filter(pane => pane.resource.kind === 'chat').length, 1)
})

test('moving a pane changes layout ownership without cloning a session or pane', () => {
    const store = workspace()
    store.openSession('running-native-session')
    const oldWindow = store.active().id
    const paneId = store.focusedPane().id
    const target = store.createWindow('Tests')
    store.movePane(paneId, target)
    assert.equal(store.focusedPane().id, paneId)
    assert.deepEqual(store.focusedPane().resource, { kind: 'chat', sessionId: 'running-native-session' })
    assert.equal(panes(store.getSnapshot().windows.find(window => window.id === oldWindow)!.root)[0]!.resource.kind, 'empty')
})

test('native display generation replacement preserves geometry and active window', () => {
    const store = workspace()
    store.openSession('codex-base')
    const paneId = store.focusedPane().id
    store.split('vertical')
    store.focus(paneId)
    const geometry = paneRectangles(store.active().root)
    store.replaceSession('codex-base', 'codex-base-r2')
    assert.equal(store.focusedPane().id, paneId)
    assert.deepEqual(store.focusedPane().resource, { kind: 'chat', sessionId: 'codex-base-r2' })
    assert.deepEqual(paneRectangles(store.active().root), geometry)
})

test('restored documents reject duplicate identities, sessions, invalid weights and unbounded nesting', () => {
    const store = workspace()
    store.openSession('a'); store.split('horizontal', { kind: 'chat', sessionId: 'b' })
    const valid = store.getSnapshot()
    const clone = (): WorkspaceState => structuredClone(valid)
    const duplicated = clone()
    if (duplicated.windows[0]!.root.type === 'split') duplicated.windows[0]!.root.children[1] = duplicated.windows[0]!.root.children[0]!
    assert.throws(() => parseWorkspaceState(duplicated), /Duplicate/)
    const badWeight = clone()
    if (badWeight.windows[0]!.root.type === 'split') badWeight.windows[0]!.root.weights[0] = Number.POSITIVE_INFINITY
    assert.throws(() => parseWorkspaceState(badWeight), /split/)
    const overflow = clone()
    if (overflow.windows[0]!.root.type === 'split') overflow.windows[0]!.root.weights = [Number.MAX_VALUE, Number.MAX_VALUE]
    assert.throws(() => parseWorkspaceState(overflow), /split/)
    assert.throws(() => parseWorkspaceState({ ...valid, schemaVersion: 2 }), /Invalid/)
    const duplicateSession = clone()
    if (duplicateSession.windows[0]!.root.type === 'split') {
        const child = duplicateSession.windows[0]!.root.children[1]!
        if (child.type === 'pane') child.resource = { kind: 'chat', sessionId: 'a' }
    }
    assert.throws(() => parseWorkspaceState(duplicateSession), /Duplicate/)
    assert.deepEqual(parseWorkspaceState(JSON.parse(JSON.stringify(valid))), valid)
})

test('resize boundaries describe nested sibling pairs and preserve total area', () => {
    const store = workspace()
    store.split('horizontal'); store.split('vertical')
    const boundaries = splitBoundaries(store.active().root)
    assert.equal(boundaries.length, 2)
    assert.deepEqual(boundaries.map(item => [item.axis, item.position, item.crossStart, item.crossSize, item.pairSize]), [
        ['horizontal', 50, 0, 100, 100], ['vertical', 50, 50, 50, 100],
    ])
    for (const boundary of boundaries) store.resize(boundary.splitId, boundary.boundary, 0.0001, 1)
    const rectangles = paneRectangles(store.active().root)
    assert.ok(rectangles.every(rect => rect.width > 0 && rect.height > 0))
    assert.ok(Math.abs(rectangles.reduce((area, rect) => area + rect.width * rect.height, 0) - 10000) < 1e-8)
})

test('deterministic mixed window operations always produce a valid recoverable document', () => {
    const store = workspace()
    let seed = 9153
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let i = 0; i < 300; i++) {
        const op = Math.floor(next() * 9)
        const available = panes(store.active().root)
        if (op === 0 && available.length < 7) store.split('horizontal')
        if (op === 1 && available.length < 7) store.split('vertical')
        if (op === 2) store.closePane(available[Math.floor(next() * available.length)]!.id)
        if (op === 3 && store.getSnapshot().windows.length < 8) store.createWindow()
        if (op === 4) store.cycleWindow(1)
        if (op === 5) store.openSession(`session-${Math.floor(next() * 20)}`)
        if (op === 6) store.toggleZoom()
        if (op === 7) store.closeWindow(store.active().id)
        if (op === 8) store.restoreWindow()
        const state = store.getSnapshot()
        assert.deepEqual(parseWorkspaceState(JSON.parse(JSON.stringify(state))), state)
        for (const window of state.windows) assert.ok(Math.abs(paneRectangles(window.root).reduce((sum, r) => sum + r.width * r.height, 0) - 10000) < 1e-8)
    }
})

test('tmux prefix handles timeout, send-prefix, composition and mapped actions', () => {
    const keys = new PrefixKeys()
    const key = (key: string, ctrlKey = false) => ({ key, ctrlKey, metaKey: false, altKey: false })
    assert.equal(keys.key(key('%'), 1).consumed, false)
    assert.equal(keys.key(key('b', true), 2).armed, true)
    assert.equal(keys.key(key('%'), 3).command, 'splitHorizontal')
    assert.equal(keys.key(key('b', true), 5).armed, true)
    assert.equal(keys.key(key('b', true), 6).consumed, false)
    keys.key(key('b', true), 10)
    assert.equal(WORKSPACE_PREFIX_TIMEOUT_MS, 1500)
    assert.equal(keys.key(key('c'), 1509).command, 'newWindow')
    keys.key(key('b', true), 2000)
    assert.equal(keys.key(key('c'), 3500).command, undefined)
    keys.key(key('b', true), 3600)
    assert.deepEqual(keys.key(key('a'), 3601), { consumed: true, armed: false })
    assert.equal(keys.key({ ...key('b', true), isComposing: true }, 4001).consumed, false)
    const store = workspace()
    runWorkspaceCommand(store, 'splitHorizontal', () => {})
    assert.equal(panes(store.active().root).length, 2)
    runWorkspaceCommand(store, 'closePane', () => {})
    assert.equal(panes(store.active().root).length, 1)
})
