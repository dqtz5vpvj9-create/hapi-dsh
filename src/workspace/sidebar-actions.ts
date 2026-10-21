import type { WorkspaceCatalogRow } from '../client/controller.ts'
import { sessionLocation } from '../client/controller.ts'
import { isSourceChild, sourceIdentity } from './legacy.ts'
import { nativeProjection, observedProjection } from './presentation.ts'

/** Source identity and lifecycle are distinct from the serving display row. */
export function sidebarActionFacts(row: WorkspaceCatalogRow) {
    const child = isSourceChild(row), source = sourceIdentity(row)
    const native = nativeProjection(row), observed = observedProjection(row)
    const location = sessionLocation(row)
    const active = typeof row.sourceActive === 'boolean' ? row.sourceActive
        : typeof observed?.active === 'boolean' ? observed.active
        : native?.nativeConnection === 'history' ? false : native?.nativeConnection === 'attached' ? true : null
    return {
        child, source, localSource: row.hostId === 'local' && source !== null,
        sourceActive: source ? active : null,
        sourceId: source?.sessionId ?? null,
        nativeId: source && !child ? location.nativeId ?? null : null,
        displayId: row.sourceSessionId,
        canMigrate: row.hostId === 'local' && Boolean(source && native?.nativeId && native.nativeHome),
    }
}

export type MenuPoint = { x: number; y: number }
export interface PressClock { now(): number; schedule(callback: () => void, milliseconds: number): () => void }
const clock: PressClock = { now: Date.now, schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer) } }

/** Original HAPI uses 500 ms and suppresses touch compatibility clicks for
 * 700 ms. This adapter leaves normal click and keyboard activation native. */
export class SidebarPress {
    private press: { pointerId: number; point: MenuPoint; type: string; fired: boolean } | null = null
    private stop: (() => void) | undefined
    private suppressUntil = 0
    constructor(private readonly open: (point: MenuPoint) => void, private readonly time: PressClock = clock) {}
    begin(pointerId: number, point: MenuPoint, type: string): void {
        this.cancel(); this.suppressUntil = 0
        const press = { pointerId, point, type, fired: false }; this.press = press
        this.stop = this.time.schedule(() => {
            if (this.press !== press) return
            press.fired = true; this.stop = undefined; this.suppressUntil = this.time.now() + 700; this.open(press.point)
        }, 500)
    }
    move(pointerId: number, point: MenuPoint): void {
        const press = this.press
        if (!press || press.pointerId !== pointerId || press.fired) return
        const distance = Math.hypot(point.x - press.point.x, point.y - press.point.y)
        if (distance > (press.type === 'mouse' ? 8 : 0)) this.cancel()
    }
    end(pointerId: number): void {
        if (this.press?.pointerId !== pointerId) return
        if (this.press.fired) this.suppressUntil = this.time.now() + 700
        this.stop?.(); this.stop = undefined; this.press = null
    }
    context(point: MenuPoint): void {
        this.stop?.(); this.stop = undefined
        if (this.press) { this.press.fired = true; this.suppressUntil = this.time.now() + 700 }
        this.open(point)
    }
    suppressClick(detail: number): boolean {
        if (detail === 0 || this.time.now() >= this.suppressUntil) return false
        this.suppressUntil = 0; return true
    }
    /** A second physical press is an intentional action, not the first
     * long-touch's compatibility click (which may hit its portaled menu). */
    nextGesture(): void { this.cancel(); this.suppressUntil = 0 }
    cancel(): void {
        this.stop?.(); this.stop = undefined
        if (this.press?.fired) this.suppressUntil = this.time.now() + 700
        this.press = null
    }
    dispose(): void { this.cancel(); this.suppressUntil = 0 }
}

/** The menu occupies visual-viewport coordinates, including a mobile keyboard. */
export function sidebarMenuPosition(point: MenuPoint, size: { width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }) {
    const padding = 8, gap = 6
    const width = Math.min(size.width, Math.max(0, viewport.width - padding * 2))
    const height = Math.min(size.height, Math.max(0, viewport.height - padding * 2))
    const below = viewport.top + viewport.height - point.y, above = point.y - viewport.top
    const top = below < height + gap && above > below ? point.y - height - gap : point.y + gap
    return { left: Math.max(viewport.left + padding, Math.min(point.x, viewport.left + viewport.width - width - padding)),
        top: Math.max(viewport.top + padding, Math.min(top, viewport.top + viewport.height - height - padding)), maxWidth: viewport.width - padding * 2, maxHeight: viewport.height - padding * 2 }
}
