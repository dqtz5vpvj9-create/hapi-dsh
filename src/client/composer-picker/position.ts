export interface PickerAnchorBox { left: number; right: number; top: number; bottom: number }
export interface PickerViewport { left: number; top: number; width: number; height: number }
export interface PickerPosition { left: number; top: number; width: number; maxHeight: number; layout: 'popover' | 'bottom' }

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** Anchor above the control whenever possible, including on phones. Keep a
 * readable popover inside the keyboard-adjusted viewport. Prefer the owning
 * pane when it has room; a narrow split must not collapse the menu's text. */
export function positionPicker(anchor: PickerAnchorBox, viewport: PickerViewport, contentHeight: number, pane?: PickerAnchorBox): PickerPosition {
    const margin = 12, gap = 8
    const insetX = Math.min(margin, Math.max(0, viewport.width) / 2), insetY = Math.min(margin, Math.max(0, viewport.height) / 2)
    let leftEdge = viewport.left + insetX, rightEdge = viewport.left + viewport.width - insetX
    let topEdge = viewport.top + insetY, bottomEdge = viewport.top + viewport.height - insetY
    const layout = 'popover' as const
    if (pane) {
        const paneInsetX = Math.min(margin, Math.max(0, pane.right - pane.left) / 2)
        const paneInsetY = Math.min(margin, Math.max(0, pane.bottom - pane.top) / 2)
        const paneLeft = clamp(pane.left + paneInsetX, leftEdge, rightEdge)
        const paneRight = clamp(pane.right - paneInsetX, paneLeft, rightEdge)
        // The portal keeps its original button/session owner even when it
        // needs to extend over a neighbouring split to remain readable.
        if (paneRight - paneLeft >= Math.min(280, rightEdge - leftEdge)) {
            leftEdge = paneLeft
            rightEdge = paneRight
        }
        topEdge = clamp(pane.top + paneInsetY, topEdge, bottomEdge)
        bottomEdge = clamp(pane.bottom - paneInsetY, topEdge, bottomEdge)
    }
    const width = Math.max(0, Math.min(320, rightEdge - leftEdge))
    const heightLimit = Math.max(0, Math.min(480, viewport.height * .7, bottomEdge - topEdge))
    const wantedHeight = Math.min(Math.max(0, contentHeight), heightLimit)
    const aboveEnd = clamp(anchor.top - gap, topEdge, bottomEdge), belowStart = clamp(anchor.bottom + gap, topEdge, bottomEdge)
    const aboveSpace = aboveEnd - topEdge, belowSpace = bottomEdge - belowStart
    const above = aboveSpace >= wantedHeight || belowSpace < wantedHeight && aboveSpace >= belowSpace
    const maxHeight = Math.min(heightLimit, above ? aboveSpace : belowSpace)
    const height = Math.min(Math.max(0, contentHeight), maxHeight)
    const left = clamp(anchor.left, leftEdge, rightEdge - width)
    const top = above ? aboveEnd - height : belowStart
    return { left, top, width, maxHeight, layout }
}
