/** Original HAPI sidebar drag and edge-only docking, with explicit pane identity. */
export const SESSION_DRAG_TYPE = 'application/x-hapi-session'
export const PANE_DRAG_TYPE = 'application/x-hapi-dsh-pane'
export type WorkspaceDrag = { kind: 'session'; sessionId: string } | { kind: 'pane'; paneId: string }
export type DockEdge = 'left' | 'right' | 'top' | 'bottom'
export type DockPosition = DockEdge | 'center'
type DragRead = Pick<DataTransfer, 'types' | 'getData'>

export function acceptsWorkspaceDrag(transfer: Pick<DataTransfer, 'types'>): boolean {
    return transfer.types.includes(SESSION_DRAG_TYPE) || transfer.types.includes(PANE_DRAG_TYPE)
}
export function writeWorkspaceDrag(transfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>, value: WorkspaceDrag): void {
    transfer.setData(value.kind === 'pane' ? PANE_DRAG_TYPE : SESSION_DRAG_TYPE, value.kind === 'pane' ? value.paneId : value.sessionId)
    transfer.effectAllowed = value.kind === 'pane' ? 'move' : 'copyMove'
}
export function readWorkspaceDrag(transfer: DragRead): WorkspaceDrag | null {
    const type = transfer.types.includes(PANE_DRAG_TYPE) ? PANE_DRAG_TYPE : transfer.types.includes(SESSION_DRAG_TYPE) ? SESSION_DRAG_TYPE : null
    if (!type) return null
    const value = transfer.getData(type)
    if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) return null
    return type === PANE_DRAG_TYPE ? { kind: 'pane', paneId: value } : { kind: 'session', sessionId: value }
}

/** Occupied center docking stays disabled, matching HAPI's FlexLayout adapter. */
export function workspaceDockPosition(x: number, y: number, width: number, height: number, empty: boolean): DockPosition | null {
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) return null
    const distances: Array<[DockEdge, number]> = [['left', x / width], ['right', (width - x) / width], ['top', y / height], ['bottom', (height - y) / height]]
    const [edge, distance] = distances.sort((left, right) => left[1] - right[1])[0]!
    return distance <= 0.27 ? edge : empty ? 'center' : null
}
