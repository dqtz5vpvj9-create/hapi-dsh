/** Adapted from HAPI 0f8ef697 programmaticScrollOffset.ts.
 * Copyright HAPI contributors. AGPL-3.0-only; see NOTICE. */
import { observeElementOffset, observeElementRect, type VirtualizerOptions } from '@tanstack/react-virtual'

type OffsetObserver = VirtualizerOptions<HTMLDivElement, HTMLDivElement>['observeElementOffset']
type RectObserver = VirtualizerOptions<HTMLDivElement, HTMLDivElement>['observeElementRect']

/** Observe the viewport owner's completed writes before the browser delivers
 * its scroll event. This boundary never writes or replays a scroll position. */
export function createProgrammaticScrollObserver(
    observe: OffsetObserver = observeElementOffset, observeRect: RectObserver = observeElementRect,
) {
    let observedOffset: number | undefined
    let activeInstance: Parameters<OffsetObserver>[0] | null = null
    let activeRect: object | null = null
    let publishLanding: ((offset: number) => void) | null = null
    const observeOffset: OffsetObserver = (instance, callback) => {
        let latestOffset: number | undefined
        const publish = (offset: number, isScrolling: boolean) => {
            latestOffset = offset
            observedOffset = offset
            callback(offset, isScrolling)
        }
        const landing = (offset: number) => {
            if (offset !== latestOffset) publish(offset, false)
        }
        activeInstance = instance
        publishLanding = landing
        const cleanup = observe(instance, publish)
        return () => {
            if (publishLanding === landing) { publishLanding = null; observedOffset = undefined; activeInstance = null }
            cleanup?.()
        }
    }
    const observeSize: RectObserver = (instance, callback) => {
        const token = {}; activeRect = token
        let visible: boolean | undefined
        const cleanup = observeRect(instance, rect => {
            if (activeRect !== token) return
            const nextVisible = rect.width > 0 && rect.height > 0
            // display:none can publish offset zero. On reveal the browser
            // restores its DOM top without a scroll event. Sample that fact
            // before a positive viewport exposes a stale top-of-list range.
            if (visible === false && nextVisible && activeInstance === instance && instance.scrollElement) {
                publishLanding?.(instance.scrollElement.scrollTop)
            }
            visible = nextVisible
            callback(rect)
        })
        return () => {
            if (activeRect === token) activeRect = null
            cleanup?.()
        }
    }
    return {
        observeOffset,
        observeRect: observeSize,
        getOffset: () => observedOffset,
        observeLanding: (offset: number) => publishLanding?.(offset),
    }
}
