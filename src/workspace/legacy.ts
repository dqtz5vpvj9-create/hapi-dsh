/** Read-only migration of HAPI's existing v2 geometry. No source write or lost pane. */
import { legacyWorkspaceSnapshotSchema, type LegacyWorkspaceNode } from '../legacy-workspace-types.ts'
import { panes, parsePaneResource, parseWorkspaceState, type PaneResource, type WorkspaceNode, type WorkspaceState } from '../client/model.ts'
import type { WorkspaceCatalogRow } from '../client/controller.ts'
import { rebindSessionFileTarget } from './dsh-view.ts'

/** A child transcript is not the mutable/read-state identity of its root thread. */
export function isSourceChild(row: Pick<WorkspaceCatalogRow, 'projectionValues'> | undefined): boolean {
    const value: unknown = row?.projectionValues && Reflect.get(row.projectionValues, 'hapiObserved')
    return Boolean(value && typeof value === 'object' && Reflect.get(value, 'sidechain'))
}

export function sourceIdentity(row: Pick<WorkspaceCatalogRow, 'projectionValues'> | undefined): { sessionId: string; hubId?: string } | null {
    if (isSourceChild(row)) return null
    const value: unknown = row?.projectionValues && (Reflect.get(row.projectionValues, 'hapi') ?? Reflect.get(row.projectionValues, 'hapiObserved'))
    if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'hapiSessionId') !== 'string') return null
    const hubId: unknown = Reflect.get(value, 'hubId')
    return { sessionId: Reflect.get(value, 'hapiSessionId') as string, ...(typeof hubId === 'string' ? { hubId } : {}) }
}

export function sourceRow(resource: Exclude<PaneResource, { kind: 'empty' }>, rows: Readonly<Record<string, WorkspaceCatalogRow>>): WorkspaceCatalogRow | undefined {
    if (!resource.sourceSessionId) return rows[resource.sessionId]
    const matches = Object.values(rows).filter(row => {
        const source = sourceIdentity(row)
        return source?.sessionId === resource.sourceSessionId && (!resource.sourceHubId || source?.hubId === resource.sourceHubId)
    })
    return matches.length === 1 ? matches[0] : undefined
}

export function importLegacyWorkspace(input: unknown, rows: Readonly<Record<string, WorkspaceCatalogRow>>): WorkspaceState | null {
    const legacy = legacyWorkspaceSnapshotSchema.parse(input)
    if (!legacy.workspaces.length) return null
    let occurrence = 0
    const node = (value: LegacyWorkspaceNode): WorkspaceNode => {
        if (value.type === 'split') return { ...value, children: value.children.map(node), weights: [...value.weights] }
        if (value.resource.kind === 'empty') return { ...value, resource: { kind: 'empty' } }
        const resource = parsePaneResource({ ...value.resource, sessionId: `hapi-unmapped:${++occurrence}`, sourceSessionId: value.resource.sessionId })
        if (resource.kind === 'empty') throw new Error('A source resource cannot become empty during migration')
        const row = sourceRow(resource, rows), source = sourceIdentity(row)
        return { ...value, resource: { ...resource, ...(row ? { sessionId: row.id } : {}), ...(source?.hubId ? { sourceHubId: source.hubId } : {}) } }
    }
    const windows = legacy.workspaces.map(window => ({ ...window, root: node(window.root) }))
    return parseWorkspaceState({ schemaVersion: 1, revision: 0, windows, activeWindowId: windows[0]!.id,
        focused: Object.fromEntries(windows.map(window => [window.id, panes(window.root)[0]!.id])), zoomed: {} })
}

export function bindSourceResources(state: WorkspaceState, rows: Readonly<Record<string, WorkspaceCatalogRow>>): WorkspaceState {
    let changed = false
    const node = (value: WorkspaceNode): WorkspaceNode => {
        if (value.type === 'split') return { ...value, children: value.children.map(node) }
        if (value.resource.kind === 'empty' || !value.resource.sourceSessionId) return value
        const row = sourceRow(value.resource, rows), source = sourceIdentity(row)
        if (!row || (row.id === value.resource.sessionId && value.resource.sourceHubId === source?.hubId)) return value
        changed = true
        const target = (value.resource.kind === 'view' || value.resource.kind === 'document') && value.resource.target
        return { ...value, resource: { ...value.resource, sessionId: row.id, ...(source?.hubId ? { sourceHubId: source.hubId } : {}),
            ...(target && row.hostId === 'local' ? { target: rebindSessionFileTarget(target, value.resource.sessionId, row.sourceSessionId) } : {}),
        } }
    }
    const windows = state.windows.map(window => ({ ...window, root: node(window.root) }))
    return changed ? parseWorkspaceState({ ...state, windows, revision: state.revision + 1 }) : state
}

/** Focus and zoom belong to a browser; shared geometry excludes those choices. */
export function sharedWorkspaceSignature(state: WorkspaceState): string {
    return JSON.stringify({ schemaVersion: state.schemaVersion, windows: state.windows })
}

export function sharedWorkspaceState(state: WorkspaceState): WorkspaceState {
    return { ...state, activeWindowId: state.windows[0]!.id,
        focused: Object.fromEntries(state.windows.map(window => [window.id, panes(window.root)[0]!.id])), zoomed: {} }
}

export function keepLocalView(incoming: WorkspaceState, local: WorkspaceState): WorkspaceState {
    return parseWorkspaceState({ ...incoming,
        activeWindowId: incoming.windows.some(window => window.id === local.activeWindowId) ? local.activeWindowId : incoming.windows[0]!.id,
        focused: Object.fromEntries(incoming.windows.map(window => [window.id, panes(window.root).some(pane => pane.id === local.focused[window.id]) ? local.focused[window.id] : panes(window.root)[0]!.id])),
        zoomed: Object.fromEntries(incoming.windows.map(window => [window.id, local.zoomed[window.id] === true])),
    })
}
