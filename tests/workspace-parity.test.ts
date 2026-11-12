/** Source-derived workspace semantics; explicit catalog fixtures do not simulate execution. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'
import { initialWorkspace, panes, parseWorkspaceState, WorkspaceStore } from '../src/client/model.ts'
import { commandForKey } from '../src/client/shortcuts.ts'
import { bindSourceAliases, legacyPaneReference, keepLocalView, sharedWorkspaceSignature, sharedWorkspaceState } from '../src/workspace/legacy.ts'
import { paneTitle, sessionActivity, sessionModel, sourceProjection, sessionDestinations, sessionFolder, stableSessionOrder, windowActivity, windowAlias, windowTitle } from '../src/workspace/presentation.ts'
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts'
import { pendingTarget } from '../src/workspace/pending-target.ts'
import { SidebarState } from '../src/workspace/sidebar-state.ts'
import { sidebarTree } from '../src/workspace/sidebar-tree.ts'

function row(id: string, patch: Partial<WorkspaceCatalogRow> = {}): WorkspaceCatalogRow {
    return { id: id as SessionId, sourceSessionId: id, displayTitle: id, hostId: 'local', hostLabel: 'Primary', hostOnline: true,
        archived: false, pinned: false, blank: false, running: false, updatedAt: 1, retainedBy: {}, ...patch }
}
function native(id: string, source: string, changes: Partial<SourceSession> = {}): WorkspaceCatalogRow {
    const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: source }
    const metadata: SourceSession = { ...identity, id: sourceSessionId(identity), title: source, cwd: '/source', updatedAt: 1,
        status: 'idle', activeTurnId: null, capabilities: { send: true, steer: true, cancel: true, approve: true, files: true }, pendingRequests: [], ...changes }
    return row(id, { sourceSessionId: metadata.id, projectionValues: { hhpiSource: metadata } })
}
const question = { id: 'native-question', method: 'item/tool/requestUserInput', turnId: 'turn', itemId: 'item', params: {} }
const approval = { ...question, id: 'native-approval', method: 'item/commandExecution/requestApproval' }
function store() { let n = 0; const id = () => `pane-${++n}`; return new WorkspaceStore(initialWorkspace(id), id) }

test('a child row cannot claim another original session projection', () => {
    const parent = native('parent', 'parent-thread')
    const child = native('child', 'child-thread')
    assert.equal(sourceProjection(parent)?.nativeId, 'parent-thread')
    assert.equal(sourceProjection(child)?.nativeId, 'child-thread')
    assert.ok(parent.projectionValues)
    assert.equal(sourceProjection({ ...child, projectionValues: parent.projectionValues }), undefined)
})

test('HHPI presentation uses current requests and connectivity while ordinary DSH retains native model selection', () => {
    const current = native('a', 's', { status: 'running', pendingRequests: [question] })
    assert.equal(sessionActivity(current).kind, 'input')
    assert.equal(sessionActivity(native('a', 's', { status: 'waiting', pendingRequests: [question, approval] })).kind, 'permission')
    assert.deepEqual(pendingTarget(current), { kind: 'approval', requestId: question.id })
    assert.equal(sessionActivity(native('a', 's', { status: 'running' })).kind, 'running')
    assert.equal(sessionActivity(native('a', 's', { status: 'running', connection: { state: 'offline', observedAt: 1 } })).kind, 'offline')
    assert.equal(sessionActivity(native('a', 's')).kind, 'idle', 'idle is not evidence of completion')
    assert.equal(sourceProjection({ ...current, sourceSessionId: 'another-source' }), undefined)
    assert.equal(sessionModel(native('a', 's', { codex: { model: 'native-model', reasoningEffort: null, parentThreadId: null, agentNickname: null } })), 'native-model')
    const selection = { provider: 'provider', model: 'ordinary-model' }
    assert.equal(sessionModel(row('ordinary', { projectionValues: { modelSelection: { next: selection, lastUsed: null } } })), 'ordinary-model')
    assert.equal(sessionModel(row('ordinary', { projectionValues: { modelSelection: { next: null, lastUsed: selection } } })), 'ordinary-model')
    assert.equal(sessionActivity(row('ordinary', { running: true })).kind, 'running')
})

test('window titles follow content; strongest activity scans every pane; aliases and exact W/P follow layout positions', () => {
    const layout = store(); layout.openSession('a'); const first = layout.focusedPane().id
    layout.split('horizontal', { kind: 'chat', sessionId: 'b' })
    const rows = { a: row('a', { displayTitle: 'Build' }), b: native('b', 's', { status: 'waiting', pendingRequests: [approval] }) }
    assert.equal(windowTitle(layout.active(), first, rows, 'Empty'), 'Build')
    assert.equal(windowActivity(layout.active(), rows), 'permission')
    assert.equal(sessionDestinations(layout.getSnapshot()).get('b')?.label, 'W1 · P2')
    layout.renameWindow(layout.active().id, 'Release'); assert.equal(windowAlias(layout.active(), 3), 'Release')
    layout.closePane(first); assert.equal(sessionDestinations(layout.getSnapshot()).get('b')?.label, 'W1 · P1')
    assert.equal(windowAlias({ ...layout.active(), name: 'Window 99', autoName: undefined } as never, 2), 'W2')
    assert.equal(commandForKey('h'), 'left'); assert.equal(commandForKey('j'), 'down'); assert.equal(commandForKey('k'), 'up'); assert.equal(commandForKey('l'), 'right'); assert.equal(commandForKey('w'), 'windowList')
})

test('finite session aliases preserve pane geometry and never retarget an old file or terminal resource', () => {
    const layout = store()
    layout.openResource({ kind: 'chat', sessionId: 'old', sourceSessionId: 'source', sourceHubId: 'hub' })
    layout.split('horizontal', { kind: 'terminal', sessionId: 'old', sourceSessionId: 'source', sourceHubId: 'hub', terminalId: 'original-terminal' })
    const original = layout.getSnapshot(), bound = bindSourceAliases(original, () => ({ kind: 'federated-dsh', hostId: 'paired', sessionId: 'native' }))
    const resources = panes(bound.windows[0]!.root).map(pane => pane.resource)
    assert.equal(resources[0]!.kind === 'chat' && resources[0]!.sessionId, 'hapi-remote:paired:native')
    assert.deepEqual(resources[1], panes(original.windows[0]!.root)[1]!.resource)
    assert.deepEqual(bound.windows[0]!.root.type === 'split' && bound.windows[0]!.root.weights, original.windows[0]!.root.type === 'split' && original.windows[0]!.root.weights)
    assert.equal(bindSourceAliases(bound, () => undefined), bound)
    assert.deepEqual(legacyPaneReference({ kind: 'chat', sessionId: 'ordinary-r1' }), undefined)
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

test('a saved terminal file target keeps its original resource address until its own exact resource migration', () => {
    const layout = store()
    layout.openResource({ kind: 'terminal', sessionId: 'display-one', sourceSessionId: 'source', sourceHubId: 'hub', terminalId: 'original-pty' })
    const paneId = layout.focusedPane().id
    layout.updateView(paneId, { type: 'resource', address: sessionFileAddress('display-one', '/repo/readme.md'), params: { line: 7 } }, 'readme.md')
    const next = native('display-two', 'source')
    const rebound = bindSourceAliases(layout.getSnapshot(), () => ({ kind: 'local-dsh', hostId: 'local', sessionId: 'display-two' }))
    const pane = panes(rebound.windows[0]!.root)[0]!
    assert.equal(pane.id, paneId)
    assert.deepEqual(pane.resource, { kind: 'terminal', sessionId: 'display-one', sourceSessionId: 'source', sourceHubId: 'hub', terminalId: 'original-pty',
        target: { type: 'resource', address: sessionFileAddress('display-one', '/repo/readme.md'), params: { line: 7 } }, title: 'readme.md' })
    assert.equal(paneTitle(pane, { 'display-two': next }, 'Empty'), 'readme.md')
    assert.equal(windowTitle(rebound.windows[0]!, paneId, { 'display-two': next }, 'Empty'), 'readme.md')
    layout.updateView(paneId, { type: 'tab', kind: 'third-party', address: 'sidebar://third-party/opaque-display-one', params: { opaque: 'display-one' } })
    const opaque = bindSourceAliases(layout.getSnapshot(), () => ({ kind: 'local-dsh', hostId: 'local', sessionId: 'display-two' }))
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
