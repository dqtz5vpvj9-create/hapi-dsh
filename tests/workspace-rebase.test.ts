import assert from 'node:assert/strict'
import test from 'node:test'
import { panes, parseWorkspaceState, type PaneNode, type PaneResource, type WorkspaceNode, type WorkspaceState, type WorkspaceWindow } from '../src/client/model.ts'
import { rebaseWorkspace, WorkspaceRebaseConflictError } from '../src/workspace/rebase.ts'

const pane = (id: string, sessionId = id): PaneNode => ({ type: 'pane', id, resource: { kind: 'chat', sessionId } })
const empty = (id: string): PaneNode => ({ type: 'pane', id, resource: { kind: 'empty' } })
const split = (id: string, ...children: WorkspaceNode[]): WorkspaceNode => ({ type: 'split', id, axis: 'horizontal', children, weights: children.map(() => 1) })
const window = (id: string, root: WorkspaceNode, name = id): WorkspaceWindow => ({ id, root, name })
const state = (...windows: WorkspaceWindow[]): WorkspaceState => parseWorkspaceState({ schemaVersion: 1, revision: 0,
    windows, activeWindowId: windows[0]!.id, focused: {}, zoomed: {} })
const ids = (value: WorkspaceState): string[] => value.windows.flatMap(row => panes(row.root).map(item => item.id)).sort()
const resource = (value: WorkspaceState, id: string): PaneResource => value.windows.flatMap(row => panes(row.root)).find(row => row.id === id)!.resource

test('independent window edits survive while focus, zoom and active window stay local', () => {
    const base = state(window('w1', split('s', pane('a'), pane('b'))), window('w2', pane('c')))
    const local = structuredClone(base), remote = structuredClone(base)
    local.windows[0]!.name = 'local name'; local.activeWindowId = 'w2'; local.focused.w1 = 'b'; local.zoomed.w1 = true
    remote.windows[1]!.name = 'remote name'; remote.revision = 14
    const inputs = JSON.stringify([base, local, remote])
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(result.windows.map(row => row.name), ['local name', 'remote name'])
    assert.equal(result.activeWindowId, 'w2'); assert.equal(result.focused.w1, 'b'); assert.equal(result.zoomed.w1, true)
    assert.equal(result.revision, 14)
    assert.equal(JSON.stringify([base, local, remote]), inputs)
})

test('different panes in one window merge bindings and same-pane explicit local binding wins', () => {
    const base = state(window('w', split('s', pane('a'), pane('b'))))
    const local = state(window('w', split('s', pane('a', 'local'), pane('b'))))
    const remote = state(window('w', split('s', pane('a', 'remote'), pane('b', 'remote-b'))))
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(resource(result, 'a'), { kind: 'chat', sessionId: 'local' })
    assert.deepEqual(resource(result, 'b'), { kind: 'chat', sessionId: 'remote-b' })
})

test('remote closure of an unchanged window or pane does not resurrect it', () => {
    const base = state(window('w1', pane('a')), window('w2', split('s', pane('b'), pane('c'))))
    const remote = state(window('w2', pane('c')))
    assert.deepEqual(ids(rebaseWorkspace(base, base, remote)), ['c'])
})

test('local pane closure preserves an independent remote pane edit and addition', () => {
    const base = state(window('w', split('s', pane('a'), pane('b'))))
    const local = state(window('w', pane('b')))
    const remote = state(window('w', split('s', pane('a'), pane('b', 'updated-b'), pane('c'))))
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(ids(result), ['b', 'c'])
    assert.deepEqual(resource(result, 'b'), { kind: 'chat', sessionId: 'updated-b' })
})

test('local window closure preserves an unrelated remote window rename', () => {
    const base = state(window('w1', pane('a')), window('w2', pane('b')))
    const local = state(window('w2', pane('b')))
    const remote = state(window('w1', pane('a')), window('w2', pane('b'), 'new name'))
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(result.windows.map(row => row.id), ['w2'])
    assert.equal(result.windows[0]!.name, 'new name')
})

test('closing a remotely changed window fails explicitly rather than discarding its new pane', () => {
    const base = state(window('w1', pane('a')), window('w2', pane('b')))
    const local = state(window('w2', pane('b')))
    const remote = state(window('w1', split('s', pane('a'), pane('remote-added'))), window('w2', pane('b')))
    assert.throws(() => rebaseWorkspace(base, local, remote), WorkspaceRebaseConflictError)
})

test('pane closure conflicts with a concurrent binding change in either direction', () => {
    const base = state(window('w', split('s', pane('a'), pane('b'))))
    const closed = state(window('w', pane('b')))
    const edited = state(window('w', split('s', pane('a', 'new session'), pane('b'))))
    assert.throws(() => rebaseWorkspace(base, closed, edited), WorkspaceRebaseConflictError)
    assert.throws(() => rebaseWorkspace(base, edited, closed), WorkspaceRebaseConflictError)
})

test('pane closure conflicts with a concurrent cross-window move', () => {
    const base = state(window('w1', split('s', pane('a'), pane('b'))), window('w2', pane('c')))
    const closed = state(window('w1', pane('b')), window('w2', pane('c')))
    const moved = state(window('w1', pane('b')), window('w2', split('m', pane('c'), pane('a'))))
    assert.throws(() => rebaseWorkspace(base, closed, moved), WorkspaceRebaseConflictError)
})

test('concurrent splits of separate panes preserve both additions and stable IDs', () => {
    const base = state(window('w', split('s', pane('a'), pane('b'))))
    const local = state(window('w', split('s', split('local-s', pane('a'), pane('local-new')), pane('b'))))
    const remote = state(window('w', split('s', pane('a'), split('remote-s', pane('b'), pane('remote-new')))))
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(ids(result), ['a', 'b', 'local-new', 'remote-new'])
    assert.equal(result.windows[0]!.root.id, 's')
})

test('concurrent splits of the same pane retain both new panes without copying the old pane', () => {
    const base = state(window('w', pane('a')))
    const local = state(window('w', split('local-s', pane('a'), pane('local-new'))))
    const remote = state(window('w', split('remote-s', pane('a'), pane('remote-new'))))
    assert.deepEqual(ids(rebaseWorkspace(base, local, remote)), ['a', 'local-new', 'remote-new'])
})

test('cross-window move keeps remote resource updates and an independent target split', () => {
    const base = state(window('w1', split('s', pane('a'), pane('b'))), window('w2', pane('c')))
    const local = state(window('w1', pane('b')), window('w2', split('local-s', pane('c'), pane('a'))))
    const remote = state(window('w1', split('s', pane('a', 'new source'), pane('b'))), window('w2', split('remote-s', pane('c'), pane('d'))))
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(ids(result), ['a', 'b', 'c', 'd'])
    assert.deepEqual(panes(result.windows[0]!.root).map(row => row.id), ['b'])
    assert.deepEqual(resource(result, 'a'), { kind: 'chat', sessionId: 'new source' })
})

test('two concurrent moves of one pane choose the local destination only once', () => {
    const base = state(window('w1', pane('a')), window('w2', pane('b')), window('w3', pane('c')))
    const local = state(window('w1', empty('local-empty')), window('w2', split('local-s', pane('b'), pane('a'))), window('w3', pane('c')))
    const remote = state(window('w1', empty('remote-empty')), window('w2', pane('b')), window('w3', split('remote-s', pane('c'), pane('a'))))
    const result = rebaseWorkspace(base, local, remote)
    assert.equal(result.windows.filter(row => panes(row.root).some(item => item.id === 'a')).length, 1)
    assert.equal(result.windows.find(row => panes(row.root).some(item => item.id === 'a'))!.id, 'w2')
    assert.deepEqual(panes(result.windows.find(row => row.id === 'w3')!.root).map(row => row.id), ['c'])
})

test('remote replacement of an automatic empty seat survives moving the last local pane', () => {
    const base = state(window('w1', pane('a')), window('w2', pane('b')))
    const local = state(window('w1', empty('placeholder')), window('w2', split('local-s', pane('b'), pane('a'))))
    const remote = state(window('w1', split('remote-s', pane('a'), pane('new-a'))), window('w2', pane('b')))
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(ids(result), ['a', 'b', 'new-a'])
    assert.deepEqual(panes(result.windows[0]!.root).map(row => row.id), ['new-a'])
})

test('incompatible reparenting reports a conflict instead of dropping either set of panes', () => {
    const base = state(window('w', split('s', pane('a'), pane('b'), pane('c'))))
    const local = state(window('w', split('s', split('ab', pane('a'), pane('b')), pane('c'))))
    const remote = state(window('w', split('s', pane('a'), split('bc', pane('b'), pane('c')))))
    assert.throws(() => rebaseWorkspace(base, local, remote), WorkspaceRebaseConflictError)
})

const display = 'hapi-codex-0123456789abcdef0123456789abcdef'
const sourcePane = (generation: number, hub = 'hub'): PaneNode => ({ type: 'pane', id: 'source-pane',
    resource: { kind: 'chat', sessionId: `${display}-r${generation}`, sourceHubId: hub, sourceSessionId: 'original' } })

test('display generation updates are derived and keep the newest address without a false edit', () => {
    const base = state(window('w1', sourcePane(1)), window('w2', pane('b')))
    const local = state(window('w1', sourcePane(3)), window('w2', pane('b')))
    const remote = state(window('w1', sourcePane(2)), window('w2', pane('b'), 'remote name'))
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(resource(result, 'source-pane'), sourcePane(3).resource)
    assert.equal(result.windows[1]!.name, 'remote name')
    const closed = state(window('w2', pane('b')))
    assert.deepEqual(ids(rebaseWorkspace(base, local, closed)), ['b'])
    assert.deepEqual(ids(rebaseWorkspace(base, closed, local)), ['b'])
})

test('same native source ID on different hubs is a real local binding change', () => {
    const base = state(window('w1', sourcePane(1)), window('w2', pane('b')))
    const local = state(window('w1', sourcePane(2, 'different-hub')), window('w2', pane('b')))
    const remote = state(window('w1', sourcePane(3)), window('w2', pane('b')))
    assert.deepEqual(resource(rebaseWorkspace(base, local, remote), 'source-pane'), sourcePane(2, 'different-hub').resource)
    assert.throws(() => rebaseWorkspace(base, local, state(window('w2', pane('b')))), WorkspaceRebaseConflictError)
})

test('duplicate resource identities introduced independently fail with the public conflict error', () => {
    const terminal = (id: string): PaneNode => ({ type: 'pane', id, resource: { kind: 'terminal', sessionId: 'session', terminalId: 'terminal' } })
    const base = state(window('w1', pane('a')), window('w2', pane('b')))
    const local = state(window('w1', split('local-s', pane('a'), terminal('local-term'))), window('w2', pane('b')))
    const remote = state(window('w1', pane('a')), window('w2', split('remote-s', pane('b'), terminal('remote-term'))))
    assert.throws(() => rebaseWorkspace(base, local, remote), error => error instanceof WorkspaceRebaseConflictError && /invalid|Duplicate/i.test(error.message))
})

test('simultaneous independent additions retain both windows', () => {
    const base = state(window('w', pane('a')))
    const local = state(window('w', pane('a')), window('local-window', pane('local-pane')))
    const remote = state(window('w', pane('a')), window('remote-window', pane('remote-pane')))
    const result = rebaseWorkspace(base, local, remote)
    assert.deepEqual(ids(result), ['a', 'local-pane', 'remote-pane'])
    assert.equal(result.windows.length, 3)
})
