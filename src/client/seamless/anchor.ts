/**
 * Scroll anchor model for seamless history loading.
 *
 * Strategy A (public `ISession.loadOlder()`) cannot reuse the official
 * ChatNavigation anchor owner: `beginPaging()`/`preserve()` are internal to
 * `@deepseek-ai/dsh-client-ui-chat`. The plugin therefore owns a *residual*
 * correction: it records one visible row before requesting an older page, then
 * compares that row's offset after the prepend commit. Browsers with native
 * scroll anchoring — and any upstream compensation that lands later — already
 * reduce the residual to zero, so the plugin must only ever correct the
 * difference. Blindly adding the prepended height would double-shift the
 * transcript.
 *
 * The planning is pure (measurements in, target scrollTop out) so double
 * compensation, clamping, and idempotence are unit-testable without a browser.
 */

/** One row's position relative to the conversation scrollport. */
export interface AnchorReading {
    /** Stable official row identity (`[data-chat-node-key]` or anchor key). */
    readonly key: string
    /** Row border-box top minus scrollport border-box top, in CSS pixels. */
    readonly offset: number
}

/** Measurement needed to plan one residual correction after a prepend commit. */
export interface AnchorCorrectionInput {
    /** Reading captured before the earlier-page request. */
    readonly anchor: AnchorReading
    /** Current reading of the same row, or null when the row is no longer mounted. */
    readonly current: AnchorReading | null
    /** Current scrollport scrollTop. */
    readonly scrollTop: number
    /** Current scrollport scrollHeight. */
    readonly scrollHeight: number
    /** Current scrollport clientHeight. */
    readonly clientHeight: number
    /** Residuals at or below this distance are not worth a scroll write. */
    readonly tolerancePx?: number
}

/** Planned residual correction; `apply: false` means the reader is already stable. */
export type AnchorCorrection =
    | { readonly apply: false; readonly residual: number }
    | { readonly apply: true; readonly targetScrollTop: number; readonly residual: number }

/** Sub-pixel residuals are measurement noise, not a layout shift. */
export const ANCHOR_TOLERANCE_PX = 1

/**
 * Plan the residual scroll correction that keeps the captured row at the same
 * viewport offset after earlier content was prepended.
 *
 * The correction is `current.offset - anchor.offset`: exactly the distance the
 * anchor drifted. When the browser (or upstream) already kept it in place the
 * residual is under the tolerance and nothing is written. The target is clamped
 * to the real scroll range so a correction can never create a rubber-band jump.
 *
 * @param input - captured anchor, current reading, and scrollport metrics.
 * @returns whether to write scrollTop, its target, and the observed residual.
 */
export function planAnchorCorrection(input: AnchorCorrectionInput): AnchorCorrection {
    const residual = input.current === null ? 0 : input.current.offset - input.anchor.offset
    if (input.current === null || !Number.isFinite(residual)) return { apply: false, residual: 0 }
    const tolerance = input.tolerancePx ?? ANCHOR_TOLERANCE_PX
    if (!(tolerance >= 0) || Math.abs(residual) <= tolerance) return { apply: false, residual }
    if (!Number.isFinite(input.scrollTop) || !Number.isFinite(input.scrollHeight) || !Number.isFinite(input.clientHeight)) {
        return { apply: false, residual }
    }
    const floor = Math.max(0, input.scrollHeight - input.clientHeight)
    const target = Math.min(floor, Math.max(0, input.scrollTop + residual))
    if (Math.abs(target - input.scrollTop) <= tolerance) return { apply: false, residual }
    return { apply: true, targetScrollTop: target, residual }
}

/**
 * Measure one row's offset relative to its scrollport.
 *
 * @param row - mounted row element.
 * @param scrollport - conversation scroll container.
 * @returns row identity and relative offset, or null when the row is detached
 *   or the identities are not measurable.
 */
export function readAnchor(row: Element | null, scrollport: Element | null): AnchorReading | null {
    if (row === null || scrollport === null) return null
    const key = row.getAttribute('data-chat-node-key') ?? row.getAttribute('data-chat-anchor-key')
    if (key === null || key === '') return null
    const rowBox = row.getBoundingClientRect()
    const portBox = scrollport.getBoundingClientRect()
    const offset = rowBox.top - portBox.top
    if (!Number.isFinite(offset)) return null
    return { key, offset }
}

/**
 * Pick the first readable transcript row inside a conversation scrollport.
 *
 * The official row order is DOM order; the first row with an anchor key is the
 * topmost retained position, which is the one a prepend above it moves. Rows
 * with `hidden`/empty seats are skipped because the official viewport does the
 * same when it retains a paging anchor.
 *
 * @param scrollport - conversation scroll container.
 * @param flow - transcriptflow element inside it.
 * @returns the topmost readable anchor, or null when the view has no rows yet.
 */
export function firstAnchor(scrollport: Element, flow: Element): AnchorReading | null {
    const rows = flow.querySelectorAll<HTMLElement>('[data-chat-node-key], [data-chat-anchor-key]')
    for (const row of rows) {
        if (row.closest('[hidden]') !== null) continue
        const reading = readAnchor(row, scrollport)
        if (reading !== null) return reading
    }
    return null
}

/**
 * Find the mounted row that previously supplied an anchor.
 *
 * @param scrollport - conversation scroll container.
 * @param key - anchor identity captured before the request.
 * @returns the row's relative offset, or null when a rewind/reresync removed it.
 */
export function findAnchor(scrollport: Element, key: string): AnchorReading | null {
    const rows = scrollport.querySelectorAll<HTMLElement>('[data-chat-node-key], [data-chat-anchor-key]')
    for (const row of rows) {
        if ((row.getAttribute('data-chat-node-key') ?? row.getAttribute('data-chat-anchor-key')) !== key) continue
        const reading = readAnchor(row, scrollport)
        return reading === null ? null : { key, offset: reading.offset }
    }
    return null
}
