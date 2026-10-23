import { planAnchorCorrection, readAnchor, type AnchorReading } from './anchor.ts'

/** Used only while a new reader gesture interrupts our own pending prepend. */
export const INTERRUPTED_PREPEND_ATTRIBUTE = 'data-hapi-interrupted-prepend'
export const INTERRUPTED_PREPEND_STYLE = `[${INTERRUPTED_PREPEND_ATTRIBUTE}] { overflow-anchor: none !important; }`

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

/** One DOM element, retained only until this prepend or the outer scrollend. */
export class InterruptedPrependAnchor {
    private before: MovingAnchorReading
    private released = false

    constructor(private readonly row: HTMLElement, readonly port: HTMLElement, reading: AnchorReading) {
        this.before = { anchor: reading, scrollTop: port.scrollTop }
        // Leave the official inline value alone. Releasing our marker reveals
        // its current value, including a newer flow-animation setting.
        port.setAttribute(INTERRUPTED_PREPEND_ATTRIBUTE, '')
    }

    private reading(): AnchorReading | null {
        if (this.released || !this.row.isConnected || !this.port.contains(this.row)) return null
        const reading = readAnchor(this.row, this.port)
        return reading?.key === this.before.anchor.key ? reading : null
    }

    /** Non-prepend mutations (streaming/tool expansion) establish a new base. */
    refresh(): void {
        const current = this.reading()
        if (current === null) { this.release(); return }
        this.before = { anchor: current, scrollTop: this.port.scrollTop }
    }

    /** Called once, only after the pending request proves an older head commit. */
    commit(): void {
        const correction = planInterruptedPrepend(this.before, this.reading(), {
            scrollTop: this.port.scrollTop,
            scrollHeight: this.port.scrollHeight,
            clientHeight: this.port.clientHeight,
        })
        if (correction.apply) this.port.scrollTop = correction.targetScrollTop
        this.release()
    }

    release(): void {
        if (this.released) return
        this.released = true
        this.port.removeAttribute(INTERRUPTED_PREPEND_ATTRIBUTE)
    }
}

/** Bounded viewport hit tests; no traversal of the retained transcript. */
export function captureInterruptedPrepend(port: HTMLElement): InterruptedPrependAnchor | null {
    const box = port.getBoundingClientRect()
    for (const fraction of [0.08, 0.35, 0.65]) {
        let node = port.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height * fraction)
        let row: HTMLElement | null = null
        while (node !== null && node !== port) {
            if (node instanceof HTMLElement && node.hasAttribute('data-chat-anchor-key')) row = node
            node = node.parentElement
        }
        if (node !== port || row === null) continue
        const reading = readAnchor(row, port)
        if (reading !== null) return new InterruptedPrependAnchor(row, port, reading)
    }
    return null
}
