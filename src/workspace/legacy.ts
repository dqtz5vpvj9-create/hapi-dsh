/** Read-only migration of HAPI's existing v2 geometry. No source write or lost pane. */
import { legacyWorkspaceSnapshotSchema, type LegacyWorkspaceNode } from '../legacy-workspace-types.ts'
import { panes, parsePaneResource, parseWorkspaceState, type PaneResource, type WorkspaceNode, type WorkspaceState } from '../client/model.ts'
import type { WorkspaceCatalogRow } from '../client/controller.ts'
import { displaySessionBaseId, displaySessionRevision, isSourceDisplaySessionId } from '../client/catalog-readiness.ts'
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

/**
 * Resolve the listed row for a saved resource. A saved `sourceHubId` is an
 * exact identity boundary: a same-named session on another Hub is a different
 * session and must never be substituted. Re-binding to another Hub is an
 * explicit user action (opening the conversation from the sidebar), never a
 * restore side effect.
 */
export function sourceRow(resource: Exclude<PaneResource, { kind: 'empty' }>, rows: Readonly<Record<string, WorkspaceCatalogRow>>): WorkspaceCatalogRow | undefined {
    if (!resource.sourceSessionId) return rows[resource.sessionId]
    const matches = Object.values(rows).filter(row => {
        const source = sourceIdentity(row)
        if (!source || source.sessionId !== resource.sourceSessionId) return false
        return resource.sourceHubId === undefined || source.hubId === resource.sourceHubId
    })
    return matches.length === 1 ? matches[0] : undefined
}

/**
 * A rewind replaces the display session id with the next `-rN` generation but
 * keeps the logical identity. Resolve the saved id to the one listed
 * generation without ever guessing between several candidates.
 */
export function displayGenerationRow(sessionId: string, rows: Readonly<Record<string, WorkspaceCatalogRow>>): WorkspaceCatalogRow | undefined {
    // Only the HAPI adapter mints `-rN` display generations; an unrelated
    // ordinary DSH id that merely ends in `-r1` must never be rewritten.
    if (!isSourceDisplaySessionId(sessionId)) return undefined
    const base = displaySessionBaseId(sessionId)
    const savedRevision = displaySessionRevision(sessionId)
    if (base === sessionId && savedRevision === undefined) {
        const candidates = Object.values(rows).filter(row => displaySessionBaseId(row.id) === sessionId && displaySessionRevision(row.id) !== undefined)
        if (candidates.length !== 1) return undefined
        return candidates[0]
    }
    const candidates = Object.values(rows).filter(row => {
        if (row.id === sessionId) return false
        if (displaySessionBaseId(row.id) !== base) return false
        const revision = displaySessionRevision(row.id)
        return revision !== undefined && (savedRevision === undefined || revision > savedRevision)
    })
    if (candidates.length !== 1) return undefined
    return candidates[0]
}

export interface SourceBindingScope {
    /** Confirmed by the configured original Hub's catalog, never inferred from a display row. */
    primaryHubId?: string
    /** Imported legacy identities without a Hub wait for that confirmation. */
    requireHub?: boolean
}

export function importLegacyWorkspace(input: unknown, rows: Readonly<Record<string, WorkspaceCatalogRow>>, scope: SourceBindingScope = {}): WorkspaceState | null {
    const legacy = legacyWorkspaceSnapshotSchema.parse(input)
    if (!legacy.workspaces.length) return null
    let occurrence = 0
    const node = (value: LegacyWorkspaceNode): WorkspaceNode => {
        if (value.type === 'split') return { ...value, children: value.children.map(node), weights: [...value.weights] }
        if (value.resource.kind === 'empty') return { ...value, resource: { kind: 'empty' } }
        const resource = parsePaneResource({ ...value.resource, sessionId: `hapi-unmapped:${++occurrence}`, sourceSessionId: value.resource.sessionId,
            ...(scope.primaryHubId ? { sourceHubId: scope.primaryHubId } : {}) })
        if (resource.kind === 'empty') throw new Error('A source resource cannot become empty during migration')
        const row = scope.requireHub && !resource.sourceHubId ? undefined : sourceRow(resource, rows), source = sourceIdentity(row)
        return { ...value, resource: { ...resource, ...(row ? { sessionId: row.id } : {}), ...(source?.hubId ? { sourceHubId: source.hubId } : {}) } }
    }
    const windows = legacy.workspaces.map(window => ({ ...window, root: node(window.root) }))
    return parseWorkspaceState({ schemaVersion: 1, revision: 0, windows, activeWindowId: windows[0]!.id,
        focused: Object.fromEntries(windows.map(window => [window.id, panes(window.root)[0]!.id])), zoomed: {} })
}

/**
 * Re-bind saved resources to the listed rows. A missing Hub on an imported
 * identity is filled only from the configured original Hub (`scope`); a Hub
 * that is already saved is never replaced by another Hub's row. Besides a
 * rewind generation this upgrades display-only panes (saved before original
 * identity was persisted) to carry `sourceSessionId`/`sourceHubId`, so a later
 * restore no longer depends on a transient display id.
 */
export function bindSourceResources(state: WorkspaceState, rows: Readonly<Record<string, WorkspaceCatalogRow>>, scope: SourceBindingScope = {}): WorkspaceState {
    let changed = false
    const node = (value: WorkspaceNode): WorkspaceNode => {
        if (value.type === 'split') return { ...value, children: value.children.map(node) }
        if (value.resource.kind === 'empty') return value
        const original = value.resource
        let resource = original
        // Imported legacy identities may lack a Hub; only the confirmed
        // configured Hub may supply it. No row is consulted before this.
        if (resource.sourceSessionId && resource.sourceHubId === undefined && scope.primaryHubId !== undefined) {
            resource = { ...resource, sourceHubId: scope.primaryHubId }
            changed = true
        }
        if (scope.requireHub && resource.sourceSessionId && resource.sourceHubId === undefined) {
            return resource === original ? value : { ...value, resource }
        }
        let row: WorkspaceCatalogRow | undefined
        if (resource.sourceSessionId) row = sourceRow(resource, rows)
        else if (resource.sourceHubId !== undefined) {
            // A saved Hub without its original session id may only bind to a
            // listed source identity that names that exact Hub.
            const candidate = rows[resource.sessionId]
            row = candidate && sourceIdentity(candidate)?.hubId === resource.sourceHubId ? candidate : undefined
        } else row = rows[resource.sessionId] ?? displayGenerationRow(resource.sessionId, rows)
        if (!row) return resource === original ? value : { ...value, resource }
        const source = sourceIdentity(row)
        // A restore never replaces a saved Hub identity with another Hub's,
        // even if an id happens to look identical.
        if (resource.sourceHubId !== undefined && source?.hubId !== resource.sourceHubId) return resource === original ? value : { ...value, resource }
        // Only a chat pane upgrades from its display-only form: a plugin View,
        // document or terminal restores with its exact saved resource identity
        // and target, even when the official row exposes a source projection.
        const upgradeIdentity = resource.kind === 'chat'
        const nextSourceSessionId = resource.sourceSessionId ?? (upgradeIdentity ? source?.sessionId : undefined)
        const nextSourceHubId = resource.sourceHubId ?? (upgradeIdentity ? source?.hubId : undefined)
        if (row.id === resource.sessionId && nextSourceSessionId === original.sourceSessionId
            && nextSourceHubId === original.sourceHubId && resource === original) return value
        changed = true
        const target = (resource.kind === 'view' || resource.kind === 'document' || resource.kind === 'terminal') && resource.target
        return { ...value, resource: { ...resource, sessionId: row.id,
            ...(nextSourceSessionId ? { sourceSessionId: nextSourceSessionId } : {}),
            ...(nextSourceHubId ? { sourceHubId: nextSourceHubId } : {}),
            ...(target && row.hostId === 'local'
                ? { target: rebindSessionFileTarget(target, resource.sessionId, row.sourceSessionId) } : {}),
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
