import { planAnchorCorrection, readAnchor, type AnchorReading } from './anchor.ts'

/** Used only while a new reader gesture interrupts our own pending prepend. */
export const INTERRUPTED_PREPEND_ATTRIBUTE = 'data-hapi-interrupted-prepend'
export const INTERRUPTED_PREPEND_STYLE = `[${INTERRUPTED_PREPEND_ATTRIBUTE}] { overflow-anchor: none !important; }`
const portOwners = new WeakMap<HTMLElement, number>()

function retainPort(port: HTMLElement): void {
    portOwners.set(port, (portOwners.get(port) ?? 0) + 1)
    port.setAttribute(INTERRUPTED_PREPEND_ATTRIBUTE, '')
}

function releasePort(port: HTMLElement): void {
    const owners = portOwners.get(port) ?? 0
    if (owners <= 1) {
        portOwners.delete(port)
        port.removeAttribute(INTERRUPTED_PREPEND_ATTRIBUTE)
    } else portOwners.set(port, owners - 1)
}

export interface MovingAnchorReading {
    readonly anchor: AnchorReading
    readonly scrollTop: number
}

/**
 * A moving reader changes viewport offset and scrollTop by opposite amounts.
 * Only the document-coordinate change belongs to the prepend. This preserves
 * motion delivered between the last event and the DOM commit as well.
 */
export function planInterruptedPrepend(
    before: MovingAnchorReading,
    current: AnchorReading | null,
    metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
): ReturnType<typeof planAnchorCorrection> {
    // A previous owner already kept this row in place. Never add height twice.
    if (current === null || Math.abs(current.offset - before.anchor.offset) <= 1) return { apply: false, residual: 0 }
    return planAnchorCorrection({
        anchor: { key: before.anchor.key, offset: before.anchor.offset + before.scrollTop - metrics.scrollTop },
        current,
        ...metrics,
    })
}

/** One DOM element, retained until this prepend or reader ownership changes. */
export class InterruptedPrependAnchor {
    private row: HTMLElement
    private rowId: string | undefined
    private before: MovingAnchorReading
    private released = false
    private upperEdge = false
    private committed = false
    private correctionComplete = false

    get waitingAtUpperEdge(): boolean { return this.upperEdge && !this.released }

    constructor(row: HTMLElement, readonly port: HTMLElement, reading: AnchorReading) {
        this.row = row
        this.rowId = row.id || undefined
        this.before = { anchor: reading, scrollTop: port.scrollTop }
        // Leave the official inline value alone. Releasing our marker reveals
        // its current value, including a newer flow-animation setting.
        retainPort(port)
        // HAPI's NativeChatViewport and virtual list own later layout changes.
        // This adapter corrects one interrupted prepend at the commit boundary;
        // observing every descendant mutation here would duplicate HAPI's work
        // and force layout repeatedly while React mounts a history page.
    }

    private reading(): AnchorReading | null {
        if (this.released) return null
        // React may replace the DOM node while preserving its official semantic
        // row key. HAPI's viewport resolves that key again after a page commit;
        // keep the same behavior instead of losing the anchor with the old node.
        if (!this.row.isConnected || !this.port.contains(this.row) || this.row.closest('[hidden]') !== null) {
            const byId = this.rowId ? this.port.ownerDocument.getElementById(this.rowId) : null
            const replacement = byId !== null && this.port.contains(byId)
                && readAnchor(byId, this.port)?.key === this.before.anchor.key ? byId as HTMLElement
                : [...this.port.querySelectorAll<HTMLElement>(
                    '[data-chat-node-key]:not([hidden]):not([hidden] *), [data-chat-anchor-key]:not([hidden]):not([hidden] *)',
                )].find(row => readAnchor(row, this.port)?.key === this.before.anchor.key)
            if (replacement === undefined) return null
            this.row = replacement
            this.rowId = replacement.id || undefined
        }
        const reading = readAnchor(this.row, this.port)
        return reading?.key === this.before.anchor.key ? reading : null
    }

    /**
     * A pan against scrollTop=0 may produce no scrollend for the official
     * paging owner to reacquire its anchor. Keep this row and its temporary
     * CSS ownership until the page commit has been compensated.
     */
    retainAtUpperEdge(): boolean {
        const current = this.reading()
        if (current === null || this.port.scrollTop > 1) return false
        this.before = { anchor: current, scrollTop: this.port.scrollTop }
        this.upperEdge = true
        return true
    }

    private trace(phase: 'commit', current: AnchorReading | null,
        correction: ReturnType<typeof planAnchorCorrection>, scrollTopBefore: number): void {
        const view = this.port.ownerDocument?.defaultView
        if (view === null || view === undefined || typeof view.CustomEvent !== 'function') return
        this.port.dispatchEvent(new view.CustomEvent('hapi-dsh:interrupted-prepend-commit', {
            bubbles: true,
            detail: { phase, upperEdge: this.upperEdge, anchorFound: current !== null,
                residual: correction.residual, applied: correction.apply,
                scrollTopBefore, scrollTopAfter: this.port.scrollTop },
        }))
    }

    /** Non-prepend mutations (streaming/tool expansion) establish a new base. */
    refresh(): void {
        // While a page is pending, the Host can move scrollTop in stages as
        // rows enter the DOM. Keep the request-time anchor and let the reader
        // input handlers replace/release it if the reader actually moves.
        if (this.upperEdge) return
        const current = this.reading()
        if (current === null) { this.release(); return }
        this.before = { anchor: current, scrollTop: this.port.scrollTop }
    }

    /** Called once, only after the pending request proves an older head commit. */
    commit(): void {
        if (this.committed) return
        this.committed = true
        const view = this.port.ownerDocument?.defaultView
        if (view && typeof view.requestAnimationFrame === 'function') {
            // The source cursor advances before React and the virtual list finish
            // laying out the newly admitted rows. Measure after two paint turns
            // so the correction sees the committed geometry, not the old DOM.
            view.requestAnimationFrame(() => {
                if (this.released) return
                view.requestAnimationFrame(() => {
                    try { this.applyCommitCorrection() }
                    finally { this.correctionComplete = true; this.release() }
                })
            })
            return
        }
        try { this.applyCommitCorrection() }
        finally { this.correctionComplete = true; this.release() }
    }

    private applyCommitCorrection(): void {
        const current = this.reading()
        if (current === null) {
            this.trace('commit', null, { apply: false, residual: 0 }, this.port.scrollTop)
            return
        }
        const metrics = {
            scrollTop: this.port.scrollTop,
            scrollHeight: this.port.scrollHeight,
            clientHeight: this.port.clientHeight,
        }
        // At the upper edge no upward reader motion can change the captured
        // row's position. Any scrollTop movement while that row is retained is
        // the browser/Host's partial prepend compensation, so compare against
        // the original semantic offset directly. The moving-anchor formula is
        // only for a reader who continues a gesture away from the edge.
        const correction = this.upperEdge
            ? planAnchorCorrection({ anchor: this.before.anchor, current, ...metrics })
            : planInterruptedPrepend(this.before, current, metrics)
        const scrollTopBefore = this.port.scrollTop
        if (correction.apply) this.port.scrollTop = correction.targetScrollTop
        this.trace('commit', current, correction, scrollTopBefore)
        const landed = this.reading()
        if (landed !== null) this.before = { anchor: landed, scrollTop: this.port.scrollTop }
    }

    release(): void {
        if (this.released) return
        // A reader gesture that arrives between publication and the two-frame
        // layout correction must not cancel the correction for an already
        // committed page. The moving-anchor calculation accounts for that
        // gesture's scrollTop delta; the owner releases itself after applying.
        if (this.committed && !this.correctionComplete) return
        this.released = true
        releasePort(this.port)
    }
}

/** Bounded viewport hit tests; no traversal of the retained transcript. */
export function captureInterruptedPrepend(port: HTMLElement): InterruptedPrependAnchor | null {
    const box = port.getBoundingClientRect()
    const style = port.ownerDocument.defaultView?.getComputedStyle(port)
    const top = box.top + (Number.parseFloat(style?.scrollPaddingTop ?? '') || 0)
    const bottom = box.bottom - (Number.parseFloat(style?.scrollPaddingBottom ?? '') || 0)
    // Preserve the topmost visible semantic row. A hit-test at a fixed inset
    // can select a later row on a narrow phone, so prepending then appears as
    // a scene jump even though that lower row stayed fixed. The virtual list
    // bounds this query to its mounted rows.
    const rows = port.querySelectorAll<HTMLElement>(
        '[data-chat-node-key]:not([hidden]):not([hidden] *), [data-chat-anchor-key]:not([hidden]):not([hidden] *)',
    )
    let first: { row: HTMLElement; reading: AnchorReading; top: number } | undefined
    for (const row of rows) {
        if (row.closest('[hidden]') !== null) continue
        const rowBox = row.getBoundingClientRect()
        if (rowBox.bottom <= top || rowBox.top >= bottom) continue
        const reading = readAnchor(row, port)
        if (reading !== null && (!first || rowBox.top < first.top)) first = { row, reading, top: rowBox.top }
    }
    return first ? new InterruptedPrependAnchor(first.row, port, first.reading) : null
}
