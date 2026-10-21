/** Explicit catalog/storage fakes verifying the pinned original HAPI rules. */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'
import { sidebarTree, type SidebarBranch } from '../src/workspace/sidebar-tree.ts'
import { nextSidebarPreview, normalizeSessionPreviewLimit, previousSidebarPreview, sidebarActiveRoots, sidebarActivityBuckets, sidebarBranchFacts, sidebarPreview } from '../src/workspace/sidebar-sections.ts'
import { SidebarState } from '../src/workspace/sidebar-state.ts'

const row = (id: string, patch: Partial<WorkspaceCatalogRow> = {}): WorkspaceCatalogRow => ({ id: id as WorkspaceCatalogRow['id'], displayTitle: id,
    updatedAt: 1, running: false, retainedBy: {}, blank: false, hostId: 'local', hostLabel: 'DSH', hostOnline: true,
    sourceSessionId: id, archived: false, pinned: false, sourceActive: true, ...patch })
const branch = (id: string, patch: Partial<WorkspaceCatalogRow> = {}): SidebarBranch => ({ row: row(id, patch), children: [] })
const pending = { hapiObserved: { ownership: 'hapi-runner', active: true, connection: 'connected', thinking: false,
    pendingRequests: [{ tool: 'request_user_input', blocking: true }] } } as never
const ids = (branches: readonly SidebarBranch[]) => branches.map(branch => branch.row.id)

test('optional folder buckets use true activity, preserve pins and distinguish quiet active from source idle', () => {
    const roots = [branch('working', { running: true }), branch('pending', { projectionValues: pending }), branch('active'),
        branch('idle', { sourceLifecycleState: 'idle' }), branch('offline', { sourceActive: false, running: true }),
        branch('pinned', { running: true }), branch('global', { running: true })]
    const pins = new Set(['pinned', 'global'])
    assert.deepEqual(sidebarActivityBuckets(roots, false, pins), { working: [], pending: [], active: [], idle: [] })
    const actual = sidebarActivityBuckets(roots, true, pins)
    assert.deepEqual(Object.fromEntries(Object.entries(actual).map(([key, branches]) => [key, ids(branches)])),
        { working: ['working'], pending: ['pending'], active: ['active'], idle: ['idle'] })
    assert.equal(roots.length, 7) // Partitioning never deletes source rows or changes their ownership.
})

test('active-only keeps the selected inactive root and the original full child tree', () => {
    const roots = sidebarTree([row('inactive', { sourceActive: false }), row('child', { sourceActive: false, parentId: 'inactive' as never }),
        row('hidden', { sourceActive: false }), row('active')])
    const facts = sidebarBranchFacts(roots, 'child')
    assert.deepEqual(ids(sidebarActiveRoots(roots, facts)), ['inactive', 'active'])
    assert.equal(facts.get('inactive')?.selected, true)
    assert.equal(roots[0]!.children[0]!.row.id, 'child')
})

test('directory preview keeps selected and pending descendants within the batch by evicting ordinary rows', () => {
    const roots = Array.from({ length: 12 }, (_, index) => branch(String(index)))
    roots[10]!.children.push(branch('needs-answer', { projectionValues: pending }))
    const facts = sidebarBranchFacts(roots, '11')
    assert.deepEqual(ids(sidebarPreview(roots, 4, facts)), ['0', '1', '10', '11'])
    assert.equal(facts.get('10')?.pendingDescendant, true)
    const manyRequired = roots.map(branch => ({ ...branch, row: { ...branch.row, projectionValues: pending } }))
    assert.equal(sidebarPreview(manyRequired, 4, sidebarBranchFacts(manyRequired)).length, 12)
    const next = nextSidebarPreview(Math.max(4, 12), 4, 30)
    assert.equal(next, 16); assert.equal(previousSidebarPreview(next, 4), 12)
    assert.equal(previousSidebarPreview(4, 4), 4); assert.equal(nextSidebarPreview(28, 8, 30), 30)
})

test('original list preferences migrate once, retain original keys, and clamp preview batches to the source range', () => {
    const data = new Map<string, string>([['hapi-pin-in-progress-sessions', 'true'], ['hapi-show-active-sessions-only', 'true'], ['hapi-session-preview-limit', '12'], ['hapi-session-list-status-mode', 'detailed']])
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
    const original = new SidebarState(storage, 'plugin-list')
    assert.equal(original.getSnapshot().preferences.pinInProgressSessions, true)
    assert.equal(original.getSnapshot().preferences.showActiveSessionsOnly, true)
    assert.equal(original.getSnapshot().preferences.sessionPreviewLimit, 12)
    assert.equal(original.getSnapshot().preferences.statusMode, 'detailed')
    original.change({ pinInProgressSessions: false, showActiveSessionsOnly: false, sessionPreviewLimit: 100, statusMode: 'standard' })
    assert.equal(data.get('hapi-pin-in-progress-sessions'), 'false')
    assert.equal(data.get('hapi-show-active-sessions-only'), 'false')
    assert.equal(data.get('hapi-session-preview-limit'), '99')
    assert.equal(data.get('hapi-session-list-status-mode'), 'standard')
    assert.deepEqual(new SidebarState(storage, 'plugin-list').getSnapshot().preferences, original.getSnapshot().preferences)
    assert.equal(normalizeSessionPreviewLimit(0), 1); assert.equal(normalizeSessionPreviewLimit(4.5), 8)
    assert.equal(normalizeSessionPreviewLimit(Number.NaN), 8)
    original.receiveOriginalPreference('hapi-session-list-status-mode', 'detailed')
    assert.equal(original.getSnapshot().preferences.statusMode, 'detailed')
    assert.equal(data.get('hapi-session-list-status-mode'), 'standard') // Observing another tab never broadcasts another shared-key write.
    original.receiveOriginalPreference('unrelated-private-setting', 'anything')
    assert.equal(original.getSnapshot().preferences.statusMode, 'detailed')
    original.receiveOriginalPreference('hapi-session-list-status-mode', null)
    assert.equal(original.getSnapshot().preferences.statusMode, 'standard')
})
