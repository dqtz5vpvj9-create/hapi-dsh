export interface PickerAnchorBox { left: number; right: number; top: number; bottom: number }
export interface PickerViewport { left: number; top: number; width: number; height: number }
export interface PickerPosition { left: number; top: number; width: number; maxHeight: number; layout: 'popover' | 'bottom' }

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** The desktop popover starts above/start and fits the intersection of its own
 * pane and the visual viewport. Mobile sheets belong to the viewport, so a
 * narrow split does not constrain their width or keyboard-adjusted height. */
export function positionPicker(anchor: PickerAnchorBox, viewport: PickerViewport, contentHeight: number, pane?: PickerAnchorBox): PickerPosition {
    const margin = 12, gap = 8
    const insetX = Math.min(margin, Math.max(0, viewport.width) / 2), insetY = Math.min(margin, Math.max(0, viewport.height) / 2)
    let leftEdge = viewport.left + insetX, rightEdge = viewport.left + viewport.width - insetX
    let topEdge = viewport.top + insetY, bottomEdge = viewport.top + viewport.height - insetY
    const layout = viewport.width <= 600 ? 'bottom' : 'popover'
    if (layout === 'popover' && pane) {
        const paneInsetX = Math.min(margin, Math.max(0, pane.right - pane.left) / 2)
        const paneInsetY = Math.min(margin, Math.max(0, pane.bottom - pane.top) / 2)
        leftEdge = clamp(pane.left + paneInsetX, leftEdge, rightEdge)
        rightEdge = clamp(pane.right - paneInsetX, leftEdge, rightEdge)
        topEdge = clamp(pane.top + paneInsetY, topEdge, bottomEdge)
        bottomEdge = clamp(pane.bottom - paneInsetY, topEdge, bottomEdge)
    }
    const width = Math.max(0, Math.min(layout === 'bottom' ? Infinity : 320, rightEdge - leftEdge))
    const heightLimit = Math.max(0, Math.min(480, viewport.height * .7, bottomEdge - topEdge))
    const wantedHeight = Math.min(Math.max(0, contentHeight), heightLimit)
    const aboveEnd = clamp(anchor.top - gap, topEdge, bottomEdge), belowStart = clamp(anchor.bottom + gap, topEdge, bottomEdge)
    const aboveSpace = aboveEnd - topEdge, belowSpace = bottomEdge - belowStart
    const above = aboveSpace >= wantedHeight || belowSpace < wantedHeight && aboveSpace >= belowSpace
    const maxHeight = layout === 'bottom' ? heightLimit : Math.min(heightLimit, above ? aboveSpace : belowSpace)
    const height = Math.min(Math.max(0, contentHeight), maxHeight)
    const left = layout === 'bottom' ? leftEdge : clamp(anchor.left, leftEdge, rightEdge - width)
    const top = layout === 'bottom' ? bottomEdge - height : above ? aboveEnd - height : belowStart
    return { left, top, width, maxHeight, layout }
}
