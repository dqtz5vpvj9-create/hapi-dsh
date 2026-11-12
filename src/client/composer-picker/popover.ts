import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { PickerMode } from './presentation.tsx'
import { positionPicker, type PickerPosition } from './position.ts'

/** Detect the actual APIs/properties used here, rather than a browser family. */
export function nativePickerSupport(): { popover: boolean; anchor: boolean } {
    const popover = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover')
        && typeof HTMLElement.prototype.showPopover === 'function' && typeof HTMLElement.prototype.hidePopover === 'function'
    const anchor = popover && typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        && ['anchor-name: --hhpi-picker', 'position-anchor: --hhpi-picker', 'position-area: block-start span-all',
            'position-try-fallbacks: flip-block', 'left: clamp(12px, anchor(left), calc(100% - 332px))'].every(value => CSS.supports(value))
    return { popover, anchor }
}

function addAnchor(element: HTMLElement, name: string): () => void {
    const previous = element.style.getPropertyValue('anchor-name')
    const names = previous && previous !== 'none' ? `${previous}, ${name}` : name
    element.style.setProperty('anchor-name', names)
    return () => {
        // Another mounted occurrence may have contributed an anchor meanwhile.
        const remaining = element.style.getPropertyValue('anchor-name').split(',').map(value => value.trim()).filter(value => value !== name)
        if (remaining.length) element.style.setProperty('anchor-name', remaining.join(', '))
        else element.style.removeProperty('anchor-name')
    }
}

/** Keep DSH's mixed form semantics and the retained actions subtree. Native
 * popover owns the top layer/light-dismiss; only constrained layouts retain
 * the old measured placement. No scroll listener runs on the anchor path. */
export function usePickerPopover({ visible, id, triggers, settingsPopup, actionsPopup, close }: {
    visible: PickerMode | null; id: string
    triggers: RefObject<Partial<Record<PickerMode, HTMLButtonElement | null>>>
    settingsPopup: RefObject<HTMLDivElement>; actionsPopup: RefObject<HTMLDivElement>
    close(): void
}) {
    const [support] = useState(nativePickerSupport)
    const [anchored, setAnchored] = useState(false)
    const [position, setPosition] = useState<PickerPosition>({ left: 8, top: 8, width: 320, maxHeight: 520, layout: 'popover' })
    const remeasure = useRef<(() => void) | null>(null)
    const current = useRef(visible); current.current = visible
    const anchorName = `--hhpi-picker-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`
    const paneAnchor = `${anchorName}-pane`

    useLayoutEffect(() => {
        if (!visible) { setAnchored(false); return }
        const button = triggers.current?.[visible], panel = visible === 'actions' ? actionsPopup.current : settingsPopup.current
        if (!button || !panel) return
        const pane = button.closest<HTMLElement>('.hapi-pane')
        const removeAnchors = [addAnchor(button, anchorName), ...(pane ? [addAnchor(pane, paneAnchor)] : [])]
        const dismissed = (event: Event): void => {
            if ((event as ToggleEvent).newState === 'closed' && current.current === visible && !panel.matches(':popover-open')) close()
        }
        if (support.popover) {
            panel.addEventListener('toggle', dismissed)
            // The source option is newer than the pinned DOM typings. Older
            // implementations safely ignore the dictionary argument.
            ;(panel.showPopover as (options: { source: HTMLElement }) => void).call(panel, { source: button })
        }
        let stopGeometry = (): void => {}, usingAnchor = false
        const measure = (): void => {
            const view = window.visualViewport
            const next = positionPicker(button.getBoundingClientRect(), {
                left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0,
                width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight,
            }, Math.max(panel.offsetHeight, panel.scrollHeight + 2), pane?.getBoundingClientRect())
            setPosition(previous => Object.keys(next).every(key => previous[key as keyof PickerPosition] === next[key as keyof PickerPosition]) ? previous : next)
        }
        const configure = (): void => {
            const view = window.visualViewport, box = pane?.getBoundingClientRect(), trigger = button.getBoundingClientRect()
            const fullViewport = !view || view.offsetLeft === 0 && view.offsetTop === 0 && Math.abs(view.width - window.innerWidth) < 1 && Math.abs(view.height - window.innerHeight) < 1
            // CSS clamps to both Pane inline edges. A short Pane, narrow split,
            // zoomed/panned visual viewport or keyboard-reduced viewport still
            // needs the existing readable cross-Pane/above-or-below policy.
            const next = support.anchor && fullViewport && !!box && box.width >= 344
                && trigger.top - Math.max(12, box.top + 12) - 8 >= Math.min(480, window.innerHeight * .7)
            stopGeometry(); stopGeometry = () => {}
            usingAnchor = next; setAnchored(next)
            if (next) { remeasure.current = null; return }
            measure(); remeasure.current = measure
            const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
            observer?.observe(panel); observer?.observe(button)
            window.addEventListener('resize', configure)
            window.addEventListener('scroll', measure, true)
            stopGeometry = () => { observer?.disconnect(); window.removeEventListener('resize', configure); window.removeEventListener('scroll', measure, true) }
        }
        configure()
        // Resizing a split can change eligibility. Native anchors follow its
        // movement themselves; the initial ResizeObserver delivery is ignored.
        let paneSize: string | undefined
        const paneResize = pane && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => {
            const entry = entries[0], size = entry?.borderBoxSize?.[0]
            const nextSize = size ? `${size.inlineSize}:${size.blockSize}` : `${entry?.contentRect.width}:${entry?.contentRect.height}`
            if (paneSize !== undefined && nextSize !== paneSize) configure()
            paneSize = nextSize
        }) : undefined
        if (pane) paneResize?.observe(pane)
        const visualChange = (): void => {
            const view = window.visualViewport
            const reduced = view && (view.offsetLeft !== 0 || view.offsetTop !== 0 || Math.abs(view.width - window.innerWidth) >= 1 || Math.abs(view.height - window.innerHeight) >= 1)
            if (usingAnchor && !reduced) return
            configure()
        }
        window.visualViewport?.addEventListener('resize', visualChange)
        window.visualViewport?.addEventListener('scroll', visualChange)
        return () => {
            stopGeometry(); paneResize?.disconnect(); remeasure.current = null
            window.visualViewport?.removeEventListener('resize', visualChange); window.visualViewport?.removeEventListener('scroll', visualChange)
            panel.removeEventListener('toggle', dismissed)
            if (support.popover && panel.matches(':popover-open')) panel.hidePopover()
            for (const remove of removeAnchors) remove()
        }
    }, [visible, support, anchorName, paneAnchor, triggers, settingsPopup, actionsPopup, close])

    return { native: support.popover, anchored, position, remeasure, anchorName, paneAnchor }
}
