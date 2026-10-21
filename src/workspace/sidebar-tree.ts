/** Flat tree projection adapted from HAPI 0f8ef697 sessionTreeRows.ts.
 * Copyright HAPI contributors. AGPL-3.0-only; see NOTICE. */
import type { WorkspaceCatalogRow } from '../client/controller.ts'
import { sessionResourceId } from '../client/controller.ts'

export type SidebarBranch = { row: WorkspaceCatalogRow; children: SidebarBranch[] }
export type SidebarTreeRow = { id: string; branch: SidebarBranch; depth: number; expanded: boolean; rootId: string }

/** HAPI's flat recent tree projection: expansion is resolved on content changes,
 * not on scroll, and even a deeply nested SDK history never uses the JS stack. */
export function projectSidebarRows(roots: readonly SidebarBranch[], showChildren: (branch: SidebarBranch) => boolean): SidebarTreeRow[] {
    const rows: SidebarTreeRow[] = []
    const stack = roots.map(branch => ({ branch, depth: 0, rootId: branch.row.id as string })).reverse()
    while (stack.length) {
        const item = stack.pop()!, expanded = item.branch.children.length > 0 && showChildren(item.branch)
        rows.push({ ...item, id: item.branch.row.id, expanded })
        if (expanded) for (let index = item.branch.children.length - 1; index >= 0; index--) {
            stack.push({ branch: item.branch.children[index]!, depth: item.depth + 1, rootId: item.rootId })
        }
    }
    return rows
}

/** A filtered child stays visible when its parent is absent; corrupt cycles cannot hide rows. */
export function sidebarTree(rows: readonly WorkspaceCatalogRow[]): SidebarBranch[] {
    const branches = new Map(rows.map(row => [row.id as string, { row, children: [] } as SidebarBranch]))
    const roots: SidebarBranch[] = []
    const parentIds = new Map<string, string>()
    for (const row of rows) {
        if (!row.parentId) continue
        const id = sessionResourceId(row.hostId, row.parentId)
        if (id !== row.id && branches.has(id)) parentIds.set(row.id, id)
    }
    // Memoize each lineage once. Walking every full ancestry independently is
    // quadratic for a long SDK chain, before virtualization can even help.
    const validLineage = new Map<string, boolean>()
    for (const row of rows) {
        if (validLineage.has(row.id)) continue
        const path: string[] = [], visiting = new Set<string>()
        let cursor: string | undefined = row.id
        while (cursor && !validLineage.has(cursor) && !visiting.has(cursor)) {
            path.push(cursor); visiting.add(cursor); cursor = parentIds.get(cursor)
        }
        const valid = !cursor || validLineage.get(cursor) === true
        for (const id of path) validLineage.set(id, valid)
    }
    for (const row of rows) {
        const branch = branches.get(row.id)!
        const parentId = validLineage.get(row.id) ? parentIds.get(row.id) : undefined
        if (parentId) branches.get(parentId)!.children.push(branch)
        else roots.push(branch)
    }
    return roots
}
