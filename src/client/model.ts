/**
 * Persistent pane geometry adapted from HAPI shared/src/workspaces.ts and
 * web/src/workspace/workspaceStore.ts at 0f8ef6970884c92fb2ddca3070be2ec56cb50333.
 * Copyright HAPI contributors. SPDX-License-Identifier: AGPL-3.0-only
 */

export type SplitAxis = 'horizontal' | 'vertical'
export type PaneResource = { kind: 'empty' } | { kind: 'chat'; sessionId: string }
export type PaneNode = { type: 'pane'; id: string; resource: PaneResource }
export type SplitNode = {
    type: 'split'
    id: string
    axis: SplitAxis
    children: WorkspaceNode[]
    weights: number[]
}
export type WorkspaceNode = PaneNode | SplitNode
export type WorkspaceWindow = { id: string; name: string; root: WorkspaceNode }
export type WorkspaceState = {
    schemaVersion: 1
    revision: number
    windows: WorkspaceWindow[]
    activeWindowId: string
    focused: Record<string, string>
    zoomed: Record<string, boolean>
}

/** Geometry is independent of engine, machine, messages, and execution ownership. */
export function panes(node: WorkspaceNode): PaneNode[] {
    return node.type === 'pane' ? [node] : node.children.flatMap(panes)
}

export function updateNode(node: WorkspaceNode, id: string, update: (node: WorkspaceNode) => WorkspaceNode): WorkspaceNode {
    if (node.id === id) return update(node)
    return node.type === 'pane' ? node : { ...node, children: node.children.map(child => updateNode(child, id, update)) }
}

export function removePane(node: WorkspaceNode, id: string): WorkspaceNode | null {
    if (node.type === 'pane') return node.id === id ? null : node
    const children: WorkspaceNode[] = []
    const weights: number[] = []
    node.children.forEach((child, index) => {
        const next = removePane(child, id)
        if (next) {
            children.push(next)
            weights.push(node.weights[index] ?? 1)
        }
    })
    if (!children.length) return null
    return children.length === 1 ? children[0]! : { ...node, children, weights }
}

export function emptyPane(id: string): PaneNode {
    return { type: 'pane', id, resource: { kind: 'empty' } }
}

export function initialWorkspace(nextId: () => string): WorkspaceState {
    const id = nextId()
    const root = emptyPane(nextId())
    return {
        schemaVersion: 1, revision: 0,
        windows: [{ id, name: 'W1', root }], activeWindowId: id,
        focused: { [id]: root.id }, zoomed: {},
    }
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256
}

/** Validate browser or remote persistence before accepting any restored identities. */
export function parseWorkspaceState(value: unknown): WorkspaceState {
    if (!record(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)
        || typeof value.revision !== 'number' || value.revision < 0
        || !Array.isArray(value.windows) || value.windows.length < 1 || value.windows.length > 64
        || !validId(value.activeWindowId) || !record(value.focused) || !record(value.zoomed)) {
        throw new Error('Invalid workspace document')
    }
    const ids = new Set<string>()
    const sessions = new Set<string>()
    let nodeCount = 0
    const take = (id: unknown): string => {
        if (!validId(id) || ids.has(id)) throw new Error('Duplicate or invalid workspace identity')
        ids.add(id)
        return id
    }
    const node = (input: unknown, depth: number): WorkspaceNode => {
        if (!record(input) || depth > 24 || ++nodeCount > 2048) throw new Error('Invalid workspace geometry')
        const id = take(input.id)
        if (input.type === 'pane') {
            if (!record(input.resource)) throw new Error('Invalid pane resource')
            if (input.resource.kind === 'empty') return emptyPane(id)
            if (input.resource.kind !== 'chat' || !validId(input.resource.sessionId)
                || sessions.has(input.resource.sessionId)) throw new Error('Duplicate or invalid session binding')
            sessions.add(input.resource.sessionId)
            return { type: 'pane', id, resource: { kind: 'chat', sessionId: input.resource.sessionId } }
        }
        if (input.type !== 'split' || !['horizontal', 'vertical'].includes(String(input.axis))
            || !Array.isArray(input.children) || input.children.length < 2 || input.children.length > 64
            || !Array.isArray(input.weights) || input.weights.length !== input.children.length
            || !input.weights.every(weight => typeof weight === 'number' && Number.isFinite(weight) && weight > 0)
            || !Number.isFinite(input.weights.reduce((total: number, weight: number) => total + weight, 0))) {
            throw new Error('Invalid split geometry')
        }
        return {
            type: 'split', id, axis: input.axis as SplitAxis,
            children: input.children.map(child => node(child, depth + 1)),
            weights: input.weights.map(weight => Number(weight)),
        }
    }
    const windows = value.windows.map((item): WorkspaceWindow => {
        if (!record(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200) {
            throw new Error('Invalid workspace window')
        }
        const id = take(item.id)
        return { id, name: item.name, root: node(item.root, 0) }
    })
    if (!windows.some(window => window.id === value.activeWindowId)) throw new Error('Unknown active workspace window')
    const focused: Record<string, string> = {}
    const zoomed: Record<string, boolean> = {}
    for (const window of windows) {
        const available = panes(window.root)
        const focus = value.focused[window.id]
        focused[window.id] = typeof focus === 'string' && available.some(pane => pane.id === focus)
            ? focus : available[0]!.id
        zoomed[window.id] = value.zoomed[window.id] === true
    }
    return { schemaVersion: 1, revision: value.revision, windows, activeWindowId: value.activeWindowId, focused, zoomed }
}

/** Mutable owner of immutable layout snapshots; it never drives an agent. */
export class WorkspaceStore {
    private listeners = new Set<() => void>()
    private closed: { window: WorkspaceWindow; index: number } | undefined

    constructor(private state: WorkspaceState, private readonly nextId: () => string = () => crypto.randomUUID()) {
        this.state = parseWorkspaceState(state)
    }

    getSnapshot = (): WorkspaceState => this.state

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    private commit(next: WorkspaceState): void {
        this.state = parseWorkspaceState({ ...next, revision: this.state.revision + 1 })
        for (const listener of [...this.listeners]) listener()
    }

    replace(next: WorkspaceState): void {
        this.state = parseWorkspaceState(next)
        for (const listener of [...this.listeners]) listener()
    }

    active(): WorkspaceWindow {
        return this.state.windows.find(window => window.id === this.state.activeWindowId)!
    }

    focusedPane(): PaneNode {
        const active = this.active()
        return panes(active.root).find(pane => pane.id === this.state.focused[active.id]) ?? panes(active.root)[0]!
    }

    focus(paneId: string): void {
        const window = this.state.windows.find(window => panes(window.root).some(pane => pane.id === paneId))
        if (!window) return
        if (this.state.activeWindowId === window.id && this.state.focused[window.id] === paneId) return
        this.commit({ ...this.state, activeWindowId: window.id, focused: { ...this.state.focused, [window.id]: paneId } })
    }

    selectWindow(windowId: string): void {
        const window = this.state.windows.find(window => window.id === windowId)
        if (window) this.focus(this.state.focused[window.id] ?? panes(window.root)[0]!.id)
    }

    cycleWindow(direction: 1 | -1): void {
        const index = this.state.windows.findIndex(window => window.id === this.state.activeWindowId)
        const next = (index + direction + this.state.windows.length) % this.state.windows.length
        this.selectWindow(this.state.windows[next]!.id)
    }

    cyclePane(direction: 1 | -1): void {
        const available = panes(this.active().root)
        const index = available.findIndex(pane => pane.id === this.focusedPane().id)
        this.focus(available[(index + direction + available.length) % available.length]!.id)
    }

    createWindow(name?: string): string {
        if (this.state.windows.length >= 64) throw new Error('The workspace has reached its window limit')
        const id = this.nextId()
        const root = emptyPane(this.nextId())
        this.commit({
            ...this.state, windows: [...this.state.windows, { id, name: name?.trim() || `W${this.state.windows.length + 1}`, root }],
            activeWindowId: id, focused: { ...this.state.focused, [id]: root.id },
        })
        return id
    }

    renameWindow(windowId: string, name: string): void {
        const normalized = name.trim()
        if (!normalized || normalized.length > 200) throw new Error('Window names must contain 1–200 characters')
        this.commit({ ...this.state, windows: this.state.windows.map(window => window.id === windowId ? { ...window, name: normalized } : window) })
    }

    closeWindow(windowId: string): void {
        const index = this.state.windows.findIndex(window => window.id === windowId)
        if (index < 0) return
        this.closed = { window: this.state.windows[index]!, index }
        const windows = this.state.windows.filter(window => window.id !== windowId)
        if (!windows.length) {
            const replacement = initialWorkspace(this.nextId)
            this.commit({ ...replacement, revision: this.state.revision })
            return
        }
        const activeWindowId = this.state.activeWindowId === windowId
            ? windows[Math.min(index, windows.length - 1)]!.id : this.state.activeWindowId
        this.commit({ ...this.state, windows, activeWindowId })
    }

    canRestoreWindow(): boolean { return this.closed !== undefined }

    restoreWindow(): void {
        if (!this.closed) return
        if (this.state.windows.length >= 64) throw new Error('The workspace has reached its window limit')
        const { window, index } = this.closed
        this.closed = undefined
        if (this.state.windows.some(existing => existing.id === window.id)) return
        const openSessions = new Set(this.state.windows.flatMap(window => panes(window.root))
            .flatMap(pane => pane.resource.kind === 'chat' ? [pane.resource.sessionId] : []))
        let root = window.root
        for (const pane of panes(root)) {
            if (pane.resource.kind === 'chat' && openSessions.has(pane.resource.sessionId)) {
                root = updateNode(root, pane.id, () => emptyPane(pane.id))
            }
        }
        const windows = [...this.state.windows]
        windows.splice(Math.min(index, windows.length), 0, { ...window, root })
        this.commit({ ...this.state, windows, activeWindowId: window.id })
    }

    /** Match HAPI: a sidebar selection focuses an existing pane or binds the focused pane. */
    openSession(sessionId: string, beside?: SplitAxis): void {
        if (!validId(sessionId)) throw new Error('Invalid session identity')
        const existing = this.state.windows.flatMap(window => panes(window.root))
            .find(pane => pane.resource.kind === 'chat' && pane.resource.sessionId === sessionId)
        if (existing) { this.focus(existing.id); return }
        if (beside) { this.split(beside, { kind: 'chat', sessionId }); return }
        const active = this.active()
        const focused = this.focusedPane()
        const root = updateNode(active.root, focused.id, () => ({ ...focused, resource: { kind: 'chat', sessionId } }))
        this.commit({ ...this.state, windows: this.state.windows.map(window => window.id === active.id ? { ...window, root } : window) })
    }

    /** A source-native rewind creates a new display generation, preserving the pane. */
    replaceSession(previousId: string, nextId: string): void {
        if (previousId === nextId) return
        if (!validId(nextId)) throw new Error('Invalid replacement session identity')
        const all = this.state.windows.flatMap(window => panes(window.root))
        const previous = all.find(pane => pane.resource.kind === 'chat' && pane.resource.sessionId === previousId)
        if (!previous) return
        const alreadyOpen = all.some(pane => pane.resource.kind === 'chat' && pane.resource.sessionId === nextId)
        const windows = this.state.windows.map(window => ({ ...window, root: updateNode(window.root, previous.id, () => ({
            ...previous, resource: alreadyOpen ? { kind: 'empty' } : { kind: 'chat', sessionId: nextId },
        })) }))
        this.commit({ ...this.state, windows })
    }

    split(axis: SplitAxis, resource: PaneResource = { kind: 'empty' }): void {
        if (this.state.windows.flatMap(window => panes(window.root)).length >= 1024) throw new Error('The workspace has reached its pane limit')
        if (resource.kind === 'chat') {
            const existing = this.state.windows.flatMap(window => panes(window.root))
                .find(pane => pane.resource.kind === 'chat' && pane.resource.sessionId === resource.sessionId)
            if (existing) { this.focus(existing.id); return }
        }
        const active = this.active()
        const focused = this.focusedPane()
        const added: PaneNode = { type: 'pane', id: this.nextId(), resource }
        const root = updateNode(active.root, focused.id, () => ({
            type: 'split', id: this.nextId(), axis, children: [focused, added], weights: [1, 1],
        }))
        this.commit({
            ...this.state, windows: this.state.windows.map(window => window.id === active.id ? { ...window, root } : window),
            focused: { ...this.state.focused, [active.id]: added.id }, zoomed: { ...this.state.zoomed, [active.id]: false },
        })
    }

    closePane(paneId: string): void {
        const window = this.state.windows.find(window => panes(window.root).some(pane => pane.id === paneId))
        if (!window) return
        const root = removePane(window.root, paneId) ?? emptyPane(this.nextId())
        const previous = this.state.focused[window.id]
        const focus = panes(root).find(pane => pane.id === previous)?.id ?? panes(root)[0]!.id
        this.commit({
            ...this.state, windows: this.state.windows.map(candidate => candidate.id === window.id ? { ...candidate, root } : candidate),
            focused: { ...this.state.focused, [window.id]: focus }, zoomed: { ...this.state.zoomed, [window.id]: false },
        })
    }

    toggleZoom(): void {
        const id = this.active().id
        this.commit({ ...this.state, zoomed: { ...this.state.zoomed, [id]: !this.state.zoomed[id] } })
    }

    resize(splitId: string, boundary: number, leftWeight: number, rightWeight: number): void {
        if (!Number.isFinite(leftWeight) || !Number.isFinite(rightWeight) || leftWeight <= 0 || rightWeight <= 0) return
        const window = this.state.windows.find(window => findNode(window.root, splitId)?.type === 'split')
        if (!window) return
        const root = updateNode(window.root, splitId, node => {
            if (node.type !== 'split' || boundary < 0 || boundary >= node.children.length - 1) return node
            const weights = [...node.weights]
            const total = leftWeight + rightWeight
            weights[boundary] = Math.max(total * 0.08, Math.min(total * 0.92, leftWeight))
            weights[boundary + 1] = total - weights[boundary]!
            return { ...node, weights }
        })
        this.commit({ ...this.state, windows: this.state.windows.map(candidate => candidate.id === window.id ? { ...candidate, root } : candidate) })
    }

    movePane(paneId: string, targetWindowId: string): void {
        const source = this.state.windows.find(window => panes(window.root).some(pane => pane.id === paneId))
        const target = this.state.windows.find(window => window.id === targetWindowId)
        if (!source || !target || source.id === target.id) return
        const pane = panes(source.root).find(pane => pane.id === paneId)!
        const sourceRoot = removePane(source.root, paneId) ?? emptyPane(this.nextId())
        const targetRoot: WorkspaceNode = target.root.type === 'pane' && target.root.resource.kind === 'empty' ? pane
            : { type: 'split', id: this.nextId(), axis: 'horizontal', children: [target.root, pane], weights: [1, 1] }
        this.commit({
            ...this.state, activeWindowId: target.id,
            windows: this.state.windows.map(window => window.id === source.id ? { ...window, root: sourceRoot }
                : window.id === target.id ? { ...window, root: targetRoot } : window),
            focused: { ...this.state.focused, [source.id]: panes(sourceRoot)[0]!.id, [target.id]: paneId },
            zoomed: { ...this.state.zoomed, [target.id]: false },
        })
    }
}

export function findNode(node: WorkspaceNode, id: string): WorkspaceNode | undefined {
    if (node.id === id) return node
    if (node.type === 'pane') return undefined
    for (const child of node.children) {
        const found = findNode(child, id)
        if (found) return found
    }
    return undefined
}

export type PaneRectangle = { id: string; left: number; top: number; width: number; height: number }

export type SplitBoundary = {
    splitId: string
    boundary: number
    axis: SplitAxis
    position: number
    crossStart: number
    crossSize: number
    pairSize: number
    leftWeight: number
    rightWeight: number
}

/** Resize handles address a pair of siblings while all other weights remain unchanged. */
export function splitBoundaries(node: WorkspaceNode, bounds = { left: 0, top: 0, width: 100, height: 100 }): SplitBoundary[] {
    if (node.type === 'pane') return []
    const total = node.weights.reduce((sum, weight) => sum + weight, 0)
    const result: SplitBoundary[] = []
    let offset = 0
    node.children.forEach((child, index) => {
        const fraction = node.weights[index]! / total
        const childBounds = node.axis === 'horizontal'
            ? { ...bounds, left: bounds.left + bounds.width * offset, width: bounds.width * fraction }
            : { ...bounds, top: bounds.top + bounds.height * offset, height: bounds.height * fraction }
        result.push(...splitBoundaries(child, childBounds))
        offset += fraction
        if (index < node.children.length - 1) {
            const leftWeight = node.weights[index]!
            const rightWeight = node.weights[index + 1]!
            result.push({
                splitId: node.id, boundary: index, axis: node.axis,
                position: node.axis === 'horizontal' ? bounds.left + bounds.width * offset : bounds.top + bounds.height * offset,
                crossStart: node.axis === 'horizontal' ? bounds.top : bounds.left,
                crossSize: node.axis === 'horizontal' ? bounds.height : bounds.width,
                pairSize: (node.axis === 'horizontal' ? bounds.width : bounds.height) * (leftWeight + rightWeight) / total,
                leftWeight, rightWeight,
            })
        }
    })
    return result
}

/** Calculate stable pane rectangles; hidden windows keep their geometry and editor DOM. */
export function paneRectangles(node: WorkspaceNode, bounds = { left: 0, top: 0, width: 100, height: 100 }): PaneRectangle[] {
    if (node.type === 'pane') return [{ id: node.id, ...bounds }]
    const total = node.weights.reduce((sum, weight) => sum + weight, 0)
    let offset = 0
    return node.children.flatMap((child, index) => {
        const fraction = node.weights[index]! / total
        const childBounds = node.axis === 'horizontal'
            ? { ...bounds, left: bounds.left + bounds.width * offset, width: bounds.width * fraction }
            : { ...bounds, top: bounds.top + bounds.height * offset, height: bounds.height * fraction }
        offset += fraction
        return paneRectangles(child, childBounds)
    })
}

/** Spatial focus follows visible pane centers, with deterministic nearest-neighbor selection. */
export function adjacentPane(root: WorkspaceNode, focusedId: string, direction: 'left' | 'right' | 'up' | 'down'): string | undefined {
    const rectangles = paneRectangles(root)
    const current = rectangles.find(rectangle => rectangle.id === focusedId)
    if (!current) return undefined
    const centerX = current.left + current.width / 2
    const centerY = current.top + current.height / 2
    const horizontal = direction === 'left' || direction === 'right'
    const positive = direction === 'right' || direction === 'down'
    let best: { id: string; score: number } | undefined
    for (const candidate of rectangles) {
        if (candidate.id === focusedId) continue
        const dx = candidate.left + candidate.width / 2 - centerX
        const dy = candidate.top + candidate.height / 2 - centerY
        const along = horizontal ? dx : dy
        if (positive ? along <= 0 : along >= 0) continue
        const cross = horizontal ? Math.abs(dy) : Math.abs(dx)
        const score = Math.abs(along) + cross * 2
        if (!best || score < best.score) best = { id: candidate.id, score }
    }
    return best?.id
}
