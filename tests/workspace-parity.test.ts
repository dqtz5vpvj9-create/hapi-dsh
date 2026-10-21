/** Source-derived workspace semantics; explicit catalog fixtures do not simulate execution. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'
import { initialWorkspace, panes, parseWorkspaceState, WorkspaceStore } from '../src/client/model.ts'
import { commandForKey } from '../src/client/shortcuts.ts'
import { bindSourceResources, importLegacyWorkspace, isSourceChild, keepLocalView, sharedWorkspaceSignature, sharedWorkspaceState, sourceIdentity, sourceRow } from '../src/workspace/legacy.ts'
import { paneTitle, sessionActivity, sessionDestinations, sessionFolder, stableSessionOrder, windowActivity, windowAlias, windowTitle } from '../src/workspace/presentation.ts'
import { SidebarState } from '../src/workspace/sidebar-state.ts'
import { sidebarTree } from '../src/workspace/sidebar-tree.ts'

function row(id: string, patch: Partial<WorkspaceCatalogRow> = {}): WorkspaceCatalogRow {
    return { id: id as SessionId, sourceSessionId: id, displayTitle: id, hostId: 'local', hostLabel: 'Primary', hostOnline: true,
        archived: false, pinned: false, blank: false, running: false, updatedAt: 1, retainedBy: {}, ...patch }
}
function native(id: string, source: string, changes: Record<string, unknown> = {}): WorkspaceCatalogRow {
    return row(id, { projectionValues: { hapi: { engine: 'codex', hubId: 'hub', hapiSessionId: source, nativeConnection: 'attached',
        execution: { status: 'idle', waitingOn: [] }, pendingRequests: [], ...changes } } as unknown as NonNullable<WorkspaceCatalogRow['projectionValues']> })
}
function store() { let n = 0; const id = () => `pane-${++n}`; return new WorkspaceStore(initialWorkspace(id), id) }

test('a child transcript cannot claim its root source identity during migration or read-state mapping', () => {
    const parent = row('parent', { projectionValues: { hapiObserved: { ownership: 'hapi-runner', hubId: 'hub', hapiSessionId: 'source' } } as never })
    const child = row('child', { parentId: 'parent' as SessionId, projectionValues: { hapiObserved: { ownership: 'hapi-runner', hubId: 'hub', hapiSessionId: 'source', sidechain: { scopeId: 'real-child' } } } as never })
    assert.equal(isSourceChild(child), true)
    assert.equal(sourceIdentity(child), null)
    assert.deepEqual(sourceIdentity(parent), { sessionId: 'source', hubId: 'hub' })
    assert.equal(sourceRow({ kind: 'chat', sessionId: 'old', sourceSessionId: 'source' }, { child, parent }), parent)
})

test('source waiting and error precedence beats running; async input remains pending without hiding execution', () => {
    const active = { status: 'active', waitingOn: [] }
    assert.equal(sessionActivity(native('a', 's', { execution: { ...active, waitingOn: ['input'] } })).kind, 'input')
    assert.equal(sessionActivity(native('a', 's', { execution: { ...active, waitingOn: ['approval', 'input'] } })).kind, 'permission')
    assert.equal(sessionActivity(native('a', 's', { execution: { status: 'systemError', waitingOn: ['approval'] } })).kind, 'error')
    const pending = sessionActivity(native('a', 's', { execution: active, pendingRequests: [{ tool: 'request_user_input', blocking: false }] }))
    assert.equal(pending.kind, 'running'); assert.equal(pending.running, true); assert.equal(pending.pending, true)
    assert.equal(sessionActivity(native('a', 's', { nativeConnection: 'disconnected', execution: active })).kind, 'offline')
})

test('window titles follow content; strongest activity scans every pane; aliases and exact W/P follow layout positions', () => {
    const layout = store(); layout.openSession('a'); const first = layout.focusedPane().id
    layout.split('horizontal', { kind: 'chat', sessionId: 'b' })
    const rows = { a: row('a', { displayTitle: 'Build' }), b: native('b', 's', { execution: { status: 'active', waitingOn: ['approval'] } }) }
    assert.equal(windowTitle(layout.active(), first, rows, 'Empty'), 'Build')
    assert.equal(windowActivity(layout.active(), rows), 'permission')
    assert.equal(sessionDestinations(layout.getSnapshot()).get('b')?.label, 'W1 · P2')
    layout.renameWindow(layout.active().id, 'Release'); assert.equal(windowAlias(layout.active(), 3), 'Release')
    layout.closePane(first); assert.equal(sessionDestinations(layout.getSnapshot()).get('b')?.label, 'W1 · P1')
    assert.equal(windowAlias({ ...layout.active(), name: 'Window 99', autoName: undefined } as never, 2), 'W2')
    assert.equal(commandForKey('h'), 'left'); assert.equal(commandForKey('j'), 'down'); assert.equal(commandForKey('k'), 'up'); assert.equal(commandForKey('l'), 'right'); assert.equal(commandForKey('w'), 'windowList')
})

test('legacy import preserves every document, terminal, identity and weight while unavailable sessions remain source-addressed', () => {
    const legacy = { schemaVersion: 2, revision: 17, workspaces: [{ id: 'window', name: 'Research', autoName: false, root: {
        type: 'split', id: 'split', axis: 'horizontal', weights: [2, 1, 1], children: [
            { type: 'pane', id: 'chat', resource: { kind: 'chat', sessionId: 'source' } },
            { type: 'pane', id: 'file', resource: { kind: 'document', sessionId: 'source', document: { kind: 'file', path: '/repo/task.md', machineId: 'machine' } } },
            { type: 'pane', id: 'terminal', resource: { kind: 'terminal', sessionId: 'unknown', terminalId: 'pty-stable' } },
        ],
    } }] }
    const imported = importLegacyWorkspace(legacy, { display: native('display', 'source') })!
    const resources = panes(imported.windows[0]!.root).map(pane => pane.resource)
    assert.deepEqual(resources[0], { kind: 'chat', sessionId: 'display', sourceSessionId: 'source', sourceHubId: 'hub' })
    assert.deepEqual(resources[1], { kind: 'document', sessionId: 'display', sourceSessionId: 'source', sourceHubId: 'hub', document: { kind: 'file', path: '/repo/task.md', machineId: 'machine' } })
    assert.deepEqual(resources[2], { kind: 'terminal', sessionId: 'hapi-unmapped:3', sourceSessionId: 'unknown', terminalId: 'pty-stable' })
    const bound = bindSourceResources(imported, { display: native('display-r2', 'source'), later: native('later', 'unknown') })
    assert.equal(panes(bound.windows[0]!.root)[0]!.id, 'chat')
    assert.equal(panes(bound.windows[0]!.root)[2]!.resource.kind, 'terminal')
    assert.deepEqual(bound.windows[0]!.root.type === 'split' && bound.windows[0]!.root.weights, [2, 1, 1])
    assert.equal(bindSourceResources(bound, { display: native('display-r2', 'source'), later: native('later', 'unknown') }), bound)
    assert.equal(importLegacyWorkspace({ schemaVersion: 2, revision: 0, workspaces: [] }, {}), null)
    assert.throws(() => importLegacyWorkspace({ ...legacy, workspaces: [...legacy.workspaces, ...legacy.workspaces] }, {}))
})

test('geometry sync never exports the active window, focused pane, or zoom and keeps browser selection on merge', () => {
    const layout = store(); layout.openSession('a'); const first = layout.active().id
    layout.createWindow('Review'); layout.split('horizontal'); layout.toggleZoom()
    const local = layout.getSnapshot(), signature = sharedWorkspaceSignature(local)
    const shared = sharedWorkspaceState(local)
    assert.equal(shared.activeWindowId, first); assert.deepEqual(shared.zoomed, {})
    assert.equal(sharedWorkspaceSignature(shared), signature)
    const restored = keepLocalView(shared, local)
    assert.equal(restored.activeWindowId, local.activeWindowId)
    assert.deepEqual(restored.focused, local.focused); assert.deepEqual(restored.zoomed, { [first]: false, [local.activeWindowId]: true })
    assert.equal(parseWorkspaceState(restored).windows.length, 2)
})

test('a terminal pane navigated to a file follows only its source display successor and retains its current title', () => {
    const layout = store()
    layout.openResource({ kind: 'terminal', sessionId: 'display-one', sourceSessionId: 'source', sourceHubId: 'hub', terminalId: 'original-pty' })
    const paneId = layout.focusedPane().id
    layout.updateView(paneId, { type: 'resource', address: sessionFileAddress('display-one', '/repo/readme.md'), params: { line: 7 } }, 'readme.md')
    const next = native('display-two', 'source')
    const rebound = bindSourceResources(layout.getSnapshot(), { 'display-two': next })
    const pane = panes(rebound.windows[0]!.root)[0]!
    assert.equal(pane.id, paneId)
    assert.deepEqual(pane.resource, { kind: 'terminal', sessionId: 'display-two', sourceSessionId: 'source', sourceHubId: 'hub', terminalId: 'original-pty',
        target: { type: 'resource', address: sessionFileAddress('display-two', '/repo/readme.md'), params: { line: 7 } }, title: 'readme.md' })
    assert.equal(paneTitle(pane, { 'display-two': next }, 'Empty'), 'readme.md')
    assert.equal(windowTitle(rebound.windows[0]!, paneId, { 'display-two': next }, 'Empty'), 'readme.md')
    layout.updateView(paneId, { type: 'tab', kind: 'third-party', address: 'sidebar://third-party/opaque-display-one', params: { opaque: 'display-one' } })
    const opaque = bindSourceResources(layout.getSnapshot(), { 'display-two': next })
    const resource = panes(opaque.windows[0]!.root)[0]!.resource
    assert.ok(resource.kind === 'terminal')
    assert.deepEqual(resource.target, { type: 'tab', kind: 'third-party', address: 'sidebar://third-party/opaque-display-one', params: { opaque: 'display-one' } })
})

test('documents and PTY occurrences deduplicate by true resource identity and closing a window can restore them', () => {
    const layout = store()
    layout.openResource({ kind: 'document', sessionId: 's', document: { kind: 'file', path: 'C:\\Repo\\a.md', machineId: 'm' } })
    const original = layout.focusedPane().id
    layout.openResource({ kind: 'document', sessionId: 'other', document: { kind: 'file', path: 'c:/repo/a.md', machineId: 'm' } }, 'horizontal')
    assert.equal(layout.focusedPane().id, original)
    layout.openResource({ kind: 'terminal', sessionId: 's', terminalId: 'terminal' }, 'vertical')
    const terminal = layout.focusedPane().id
    layout.movePaneToNewWindow(terminal); assert.equal(layout.focusedPane().id, terminal)
    layout.closeWindow(layout.active().id); layout.restoreWindow()
    assert.equal(layout.focusedPane().resource.kind, 'terminal')
})

test('streaming activity cannot reorder existing list rows; folders are machine scoped and cycles cannot hide a session', () => {
    const a = row('a', { updatedAt: 10, cwd: '/same' }), b = row('b', { updatedAt: 9, cwd: '/same', hostId: 'remote' })
    assert.deepEqual(stableSessionOrder(['a', 'b'], [{ ...b, updatedAt: 20 }, a]), ['a', 'b'])
    assert.deepEqual(stableSessionOrder(['a', 'b'], [{ ...b, updatedAt: 20 }, a], true), ['b', 'a'])
    assert.notEqual(sessionFolder(a).key, sessionFolder(b).key)
    const parent = row('parent'), child = row('child', { parentId: 'parent' as SessionId })
    assert.equal(sidebarTree([parent, child])[0]!.children[0]!.row.id, 'child')
    assert.equal(sidebarTree([child])[0]!.row.id, 'child')
    assert.equal(sidebarTree([{ ...parent, parentId: 'child' as SessionId }, child]).length, 2)
})

test('reading one pane never clears another pane, manual unread persists, and source updates after reading remain unread', () => {
    const memory = new Map<string, string>()
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) } }
    const sidebar = new SidebarState(storage, 'view')
    const at = sidebar.getSnapshot().baseline + 1
    sidebar.markSeen('a', at)
    assert.equal(sidebar.isUnread('a', at), false); assert.equal(sidebar.isUnread('b', at), true)
    sidebar.markUnread('a', at); assert.equal(new SidebarState(storage, 'view').isUnread('a', at), true)
    sidebar.markSeen('a', at); assert.equal(sidebar.isUnread('a', at + 1), true)
    sidebar.change({ mode: 'folders', machine: 'lab' }); sidebar.toggle('collapsed', '/folder')
    assert.deepEqual(new SidebarState(storage, 'view').getSnapshot().preferences, sidebar.getSnapshot().preferences)
})
