import { findNode, panes, removePane, type PaneNode, type PaneResource, type WorkspaceNode, type WorkspaceState, type WorkspaceWindow } from '../client/model.ts'
import { displaySessionBaseId, displaySessionRevision, isSourceDisplaySessionId } from '../client/catalog-readiness.ts'
import { rebindSessionFileTarget } from './dsh-view.ts'
import { keepLocalView } from './legacy.ts'

/** The caller must retain its local view when two structures cannot be combined. */
export class WorkspaceRebaseConflictError extends Error {
    override readonly name = 'WorkspaceRebaseConflictError'
    constructor(message: string, readonly windowId?: string) { super(message) }
}

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

function resourceMeaning(resource: PaneResource): unknown {
    if (resource.kind === 'empty') return resource
    const session = resource.sourceSessionId !== undefined
        ? JSON.stringify(['source', resource.sourceHubId ?? null, resource.sourceSessionId])
        : isSourceDisplaySessionId(resource.sessionId) ? displaySessionBaseId(resource.sessionId) : resource.sessionId
    return { ...resource, sessionId: session,
        ...('target' in resource && resource.target ? { target: rebindSessionFileTarget(resource.target, resource.sessionId, session) } : {}),
    }
}

function sameResource(left: PaneResource, right: PaneResource): boolean {
    return equal(resourceMeaning(left), resourceMeaning(right))
}

function resourceAfter(base: PaneResource | undefined, local: PaneResource, remote: PaneResource): PaneResource {
    if (!sameResource(local, remote)) return base && sameResource(local, base) ? remote : local
    if (local.kind === 'empty' || remote.kind === 'empty') return remote
    if (isSourceDisplaySessionId(local.sessionId) && isSourceDisplaySessionId(remote.sessionId)
        && displaySessionBaseId(local.sessionId) === displaySessionBaseId(remote.sessionId)) {
        return (displaySessionRevision(local.sessionId) ?? 0) > (displaySessionRevision(remote.sessionId) ?? 0) ? local : remote
    }
    // A derived binding is not an edit. Keep a newer local resolution if the
    // server still has the base address; otherwise the fetched server wins.
    return base && base.kind !== 'empty' && base.sessionId === remote.sessionId && local.sessionId !== remote.sessionId ? local : remote
}

function geometry(node: WorkspaceNode | null): unknown {
    return node?.type === 'split'
        ? { type: node.type, id: node.id, axis: node.axis, weights: node.weights, children: node.children.map(geometry) }
        : node && { type: node.type, id: node.id }
}

function windowMeaning(window: WorkspaceWindow): unknown {
    return { name: window.name, autoName: window.autoName, geometry: geometry(window.root),
        resources: panes(window.root).map(pane => [pane.id, resourceMeaning(pane.resource)]) }
}

function replace(node: WorkspaceNode, id: string, value: WorkspaceNode): WorkspaceNode {
    if (node.id === id) return value
    return node.type === 'pane' ? node : { ...node, children: node.children.map(child => replace(child, id, value)) }
}

/** Keep the chosen order, inserting the other side's new seats next to their
 * surviving neighbors. Disjoint additions never replace an existing seat. */
function combineOrder(preferred: readonly string[], other: readonly string[]): string[] {
    const result = [...preferred]
    other.forEach((key, index) => {
        if (result.includes(key)) return
        const next = other.slice(index + 1).find(id => result.includes(id))
        const previous = other.slice(0, index).reverse().find(id => result.includes(id))
        result.splice(next !== undefined ? result.indexOf(next) : previous !== undefined ? result.indexOf(previous) + 1 : result.length, 0, key)
    })
    return result
}

function mergeTree(base: WorkspaceNode | null, local: WorkspaceNode | null, remote: WorkspaceNode | null, windowId: string, emptySeats: Set<string>): WorkspaceNode | null {
    if (equal(geometry(local), geometry(base))) return remote
    if (equal(geometry(remote), geometry(base)) || equal(geometry(local), geometry(remote))) return local
    if (base === null) {
        if (local === null) return remote
        if (remote === null) return local
        // Moving the last pane leaves an automatic empty seat. It must not
        // displace a real pane concurrently opened in that window.
        if (local.type === 'pane' && local.resource.kind === 'empty') { emptySeats.add(local.id); return remote }
        if (remote.type === 'pane' && remote.resource.kind === 'empty') { emptySeats.add(remote.id); return local }
        throw new WorkspaceRebaseConflictError('Both devices added different layouts to the same empty window', windowId)
    }
    if (local === null || remote === null) throw new WorkspaceRebaseConflictError('A changed layout lost its shared parent', windowId)
    // A split wraps an existing seat. Substitute the other side's updated seat
    // inside that wrapper, retaining both sets of added panes and their IDs.
    if (local.id !== base.id) {
        const retained = findNode(local, base.id)
        if (retained) {
            const merged = mergeTree(base, retained, remote, windowId, emptySeats)
            if (merged) return replace(local, base.id, merged)
        }
    }
    if (remote.id !== base.id) {
        const retained = findNode(remote, base.id)
        if (retained) {
            const merged = mergeTree(base, local, retained, windowId, emptySeats)
            if (merged) return replace(remote, base.id, merged)
        }
    }
    if (base.type !== 'split' || local.type !== 'split' || remote.type !== 'split'
        || base.id !== local.id || base.id !== remote.id) {
        throw new WorkspaceRebaseConflictError('Both devices reorganized the same pane group incompatibly', windowId)
    }
    const seats = (node: typeof base) => {
        const values = new Map<string, { node: WorkspaceNode; weight: number }>()
        node.children.forEach((child, index) => {
            const anchors = base.children.filter(previous => findNode(child, previous.id) || findNode(previous, child.id))
            if (anchors.length > 1) throw new WorkspaceRebaseConflictError('A new group crosses several independently edited seats', windowId)
            const key = anchors[0]?.id ?? child.id
            if (values.has(key)) throw new WorkspaceRebaseConflictError('Two groups claim the same pane seat', windowId)
            values.set(key, { node: child, weight: node.weights[index]! })
        })
        return values
    }
    const before = seats(base), left = seats(local), right = seats(remote)
    const beforeOrder = [...before.keys()], localOrder = [...left.keys()], remoteOrder = [...right.keys()]
    const moved = !equal(localOrder.filter(id => before.has(id)), beforeOrder.filter(id => left.has(id)))
    const order = moved ? combineOrder(localOrder, remoteOrder) : combineOrder(remoteOrder, localOrder)
    const children: WorkspaceNode[] = [], weights: number[] = []
    for (const id of order) {
        const b = before.get(id), l = left.get(id), r = right.get(id)
        const child = mergeTree(b?.node ?? null, l?.node ?? null, r?.node ?? null, windowId, emptySeats)
        if (!child) continue
        children.push(child)
        weights.push(l && (!b || l.weight !== b.weight) ? l.weight : r?.weight ?? l?.weight ?? 1)
    }
    if (!children.length) return null
    if (children.length === 1) return children[0]!
    return { ...remote, axis: local.axis !== base.axis ? local.axis : remote.axis, children, weights }
}

type WindowTree = Omit<WorkspaceWindow, 'root'> & { root: WorkspaceNode | null }
function paneIndex(state: WorkspaceState): Map<string, { pane: PaneNode; windowId: string }> {
    return new Map(state.windows.flatMap(window => panes(window.root).map(pane => [pane.id, { pane, windowId: window.id }] as const)))
}

/** Replay this browser's changes onto the latest shared layout. It never
 * persists, mutates inputs, allocates IDs, or changes official pane ownership. */
export function rebaseWorkspace(base: WorkspaceState, local: WorkspaceState, remote: WorkspaceState): WorkspaceState {
    const oldPanes = paneIndex(base), localPanes = paneIndex(local), remotePanes = paneIndex(remote)
    const before = new Map<string, WindowTree>(base.windows.map(window => [window.id, { ...window }]))
    const left = new Map<string, WindowTree>(local.windows.map(window => [window.id, { ...window }]))
    const right = new Map<string, WindowTree>(remote.windows.map(window => [window.id, { ...window }]))
    const remove = (windows: Map<string, WindowTree>, paneId: string) => {
        for (const [id, window] of windows) if (window.root) windows.set(id, { ...window, root: removePane(window.root, paneId) })
    }
    for (const window of base.windows) {
        if (!left.has(window.id)) {
            const other = remote.windows.find(row => row.id === window.id)
            if (other && !equal(windowMeaning(window), windowMeaning(other))) {
                throw new WorkspaceRebaseConflictError('A locally closed window has server changes', window.id)
            }
            before.delete(window.id); right.delete(window.id); continue
        }
        if (!right.has(window.id)) {
            if (!equal(windowMeaning(window), windowMeaning(local.windows.find(row => row.id === window.id)!))) {
                throw new WorkspaceRebaseConflictError('The server closed a window with local changes', window.id)
            }
            before.delete(window.id); left.delete(window.id)
        }
    }
    for (const [id, old] of oldPanes) {
        const l = localPanes.get(id), r = remotePanes.get(id)
        if (!l) {
            if (r && (!sameResource(old.pane.resource, r.pane.resource) || r.windowId !== old.windowId)) {
                throw new WorkspaceRebaseConflictError('A locally closed pane was edited or moved on the server', r.windowId)
            }
            remove(before, id); remove(right, id); continue
        }
        if (!r) {
            if (!sameResource(old.pane.resource, l.pane.resource) || l.windowId !== old.windowId) {
                throw new WorkspaceRebaseConflictError('The server closed a pane that was edited or moved locally', l.windowId)
            }
            remove(before, id); remove(left, id)
        } else if (l.windowId !== old.windowId) {
            // A local move owns the destination. Remove the remote occurrence
            // first, including a different concurrent move of that same ID.
            remove(before, id); remove(right, id)
        }
    }
    const resources = new Map<string, PaneResource>()
    for (const [id, { pane }] of remotePanes) resources.set(id, pane.resource)
    for (const [id, { pane }] of localPanes) {
        const old = oldPanes.get(id)?.pane.resource, other = remotePanes.get(id)?.pane.resource
        if (!old && other && !sameResource(pane.resource, other)) throw new WorkspaceRebaseConflictError('Two new panes reused an identity for different resources')
        resources.set(id, other ? resourceAfter(old, pane.resource, other) : pane.resource)
    }
    const bind = (node: WorkspaceNode): WorkspaceNode => node.type === 'pane'
        ? { ...node, resource: resources.get(node.id) ?? node.resource }
        : { ...node, children: node.children.map(bind) }
    const baseOrder = [...before.keys()], localOrder = [...left.keys()], remoteOrder = [...right.keys()]
    const moved = !equal(localOrder.filter(id => before.has(id)), baseOrder.filter(id => left.has(id)))
    const order = moved ? combineOrder(localOrder, remoteOrder) : combineOrder(remoteOrder, localOrder)
    const windows: WorkspaceWindow[] = [], emptySeats = new Set<string>()
    for (const id of order) {
        const b = before.get(id), l = left.get(id), r = right.get(id)
        const root = mergeTree(b?.root ?? null, l?.root ?? null, r?.root ?? null, id, emptySeats)
        if (!root) continue
        const source = l && (!b || l.name !== b.name || l.autoName !== b.autoName) ? l : r ?? l!
        windows.push({ id, name: source.name, ...(source.autoName === undefined ? {} : { autoName: source.autoName }), root: bind(root) })
    }
    // A structural shortcut must never discard a concurrently added pane.
    // The existing schema also enforces globally unique node/resource IDs.
    const retained = new Set(windows.flatMap(window => panes(window.root).map(pane => pane.id)))
    for (const window of [...left.values(), ...right.values()]) for (const pane of window.root ? panes(window.root) : []) {
        if (!retained.has(pane.id) && !emptySeats.has(pane.id)) throw new WorkspaceRebaseConflictError('The combined layout would discard a pane', window.id)
    }
    if (!windows.length) throw new WorkspaceRebaseConflictError('Concurrent closes left no shared window')
    try {
        return keepLocalView({ ...remote, revision: Math.max(base.revision, local.revision, remote.revision), windows,
            activeWindowId: windows[0]!.id }, local)
    } catch (error) {
        throw new WorkspaceRebaseConflictError(`The combined layout is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
}
