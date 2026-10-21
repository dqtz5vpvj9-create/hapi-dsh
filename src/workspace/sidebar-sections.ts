/**
 * Original HAPI SessionList grouping/preview rules, adapted from 0f8ef697.
 * Copyright HAPI contributors. SPDX-License-Identifier: AGPL-3.0-only
 */
import type { WorkspaceCatalogRow } from '../client/controller.ts'
import { nativeProjection, observedProjection, sessionActivity } from './presentation.ts'
import type { SidebarBranch } from './sidebar-tree.ts'

export const DEFAULT_SESSION_PREVIEW_LIMIT = 8
export function normalizeSessionPreviewLimit(value: number): number {
    return Number.isInteger(value) ? Math.min(99, Math.max(1, value)) : DEFAULT_SESSION_PREVIEW_LIMIT
}

export function sidebarSessionActive(row: WorkspaceCatalogRow): boolean {
    if (!row.hostOnline) return false
    if (typeof row.sourceActive === 'boolean') return row.sourceActive
    const observed = observedProjection(row), native = nativeProjection(row)
    if (observed) return observed.active
    if (native) return native.nativeConnection === 'attached' && native.execution?.status !== 'disconnected'
    // Ordinary DSH has no HAPI socket-active concept. Only its published agent
    // activity or a retained view establishes an active official conversation.
    return row.running || Object.values(row.retainedBy).some(count => typeof count === 'number' && count > 0)
}

export type SidebarBranchFacts = { selected: boolean; pending: boolean; pendingDescendant: boolean }
export function sidebarBranchFacts(roots: readonly SidebarBranch[], selectedId?: string): Map<string, SidebarBranchFacts> {
    const facts = new Map<string, SidebarBranchFacts>()
    const pending: Array<{ branch: SidebarBranch; visited: boolean }> = roots.map(branch => ({ branch, visited: false }))
    while (pending.length) {
        const item = pending.pop()!
        if (!item.visited) {
            pending.push({ ...item, visited: true })
            for (const branch of item.branch.children) pending.push({ branch, visited: false })
            continue
        }
        const selected = item.branch.row.id === selectedId || item.branch.children.some(child => facts.get(child.row.id)?.selected)
        const pendingDescendant = item.branch.children.some(child => facts.get(child.row.id)?.pending)
        facts.set(item.branch.row.id, { selected, pendingDescendant, pending: sessionActivity(item.branch.row).pending || pendingDescendant })
    }
    return facts
}

export function sidebarActiveRoots(roots: readonly SidebarBranch[], facts: ReadonlyMap<string, SidebarBranchFacts>): SidebarBranch[] {
    return roots.filter(branch => sidebarSessionActive(branch.row) || facts.get(branch.row.id)?.selected)
}

export function sidebarPreview(branches: readonly SidebarBranch[], limit: number, facts: ReadonlyMap<string, SidebarBranchFacts>, expanded = false): readonly SidebarBranch[] {
    if (expanded || branches.length <= limit) return branches
    const required = (branch: SidebarBranch): boolean => { const state = facts.get(branch.row.id); return state?.selected === true || state?.pending === true }
    const visible = branches.filter((branch, index) => index < limit || required(branch))
    for (let index = visible.length - 1; visible.length > limit && index >= 0; index--) if (!required(visible[index]!)) visible.splice(index, 1)
    return visible
}
export const nextSidebarPreview = (current: number, step: number, total: number): number => Math.min(current + Math.max(1, step), total)
export const previousSidebarPreview = (current: number, step: number): number => Math.max(Math.max(1, step), current - Math.max(1, step))

export type SidebarActivityBucket = 'working' | 'pending' | 'active' | 'idle'
export function sidebarActivityBuckets(roots: readonly SidebarBranch[], enabled: boolean, pinned: ReadonlySet<string>): Record<SidebarActivityBucket, SidebarBranch[]> {
    const buckets: Record<SidebarActivityBucket, SidebarBranch[]> = { working: [], pending: [], active: [], idle: [] }
    if (!enabled) return buckets
    for (const branch of roots) {
        if (pinned.has(branch.row.id) || !sidebarSessionActive(branch.row)) continue
        const activity = sessionActivity(branch.row)
        buckets[activity.running ? 'working' : activity.pending ? 'pending' : branch.row.sourceLifecycleState === 'idle' ? 'idle' : 'active'].push(branch)
    }
    return buckets
}
