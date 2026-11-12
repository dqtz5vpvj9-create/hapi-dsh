/** Browser geometry and finite offline reference restoration. No old Hub loader or execution owner. */
import { panes, parseWorkspaceState, type PaneResource, type WorkspaceNode, type WorkspaceState } from '../client/model.ts'
import { isSourceDisplaySessionId } from '../client/catalog-readiness.ts'
import { isSourceSessionId, parseSourceSessionId } from '../remote/protocol.ts'
import type { AppSourceRoute } from './app-service-types.ts'
import type { LegacySourceReference } from './source-aliases.ts'
import { parseSessionResourceId, sessionResourceId } from '../shared/session-resource-id.ts'

/** Exact persisted reference only; no projection or focused Host supplies missing identity. */
export function legacyPaneReference(resource: Exclude<PaneResource, { kind: 'empty' }>): LegacySourceReference | undefined {
    if (resource.sourceSessionId && resource.sourceHubId) return { kind: 'hapi-session', hubId: resource.sourceHubId, sessionId: resource.sourceSessionId }
    let address: { hostId: string; sessionId: string }
    try { address = parseSessionResourceId(resource.sessionId) } catch { return undefined }
    let oldDisplay = isSourceDisplaySessionId(address.sessionId)
    if (isSourceSessionId(address.sessionId)) {
        try { oldDisplay = parseSourceSessionId(address.sessionId).engine === 'dsh' }
        catch { return undefined }
    }
    return oldDisplay ? { kind: 'hapi-display', hostId: address.hostId, displayId: address.sessionId } : undefined
}

export const legacyReferenceKey = (reference: LegacySourceReference): string => JSON.stringify(reference.kind === 'hapi-session'
    ? [reference.kind, reference.hubId, reference.namespace ?? null, reference.sessionId]
    : [reference.kind, reference.hostId, reference.displayId])

/** A session alias grants a chat destination, never an old terminal or document resource. */
export function bindSourceAliases(state: WorkspaceState, resolve: (reference: LegacySourceReference) => AppSourceRoute | undefined): WorkspaceState {
    let changed = false
    const node = (value: WorkspaceNode): WorkspaceNode => {
        if (value.type === 'split') return { ...value, children: value.children.map(node) }
        if (value.resource.kind !== 'chat') return value
        const original = value.resource, reference = legacyPaneReference(original)
        const target = reference && resolve(reference)
        if (!target) return value
        const sessionId = sessionResourceId(target.hostId, target.sessionId)
        if (sessionId === original.sessionId && original.sourceSessionId === undefined && original.sourceHubId === undefined) return value
        changed = true
        return { ...value, resource: { kind: 'chat', sessionId, draftOrigin: original.draftOrigin ?? {
            sessionId: original.sessionId,
            ...(original.sourceSessionId ? { sourceSessionId: original.sourceSessionId } : {}),
            ...(original.sourceHubId ? { sourceHubId: original.sourceHubId } : {}),
        } } }
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
