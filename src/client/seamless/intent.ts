/**
 * Reader-intent normalization for seamless history loading.
 *
 * The official ChatView publishes no scroll/gesture API, so a plugin observes
 * the conversation scrollport's DOM events. These helpers reduce raw browser
 * samples to the one intent the load policy understands: "the reader asked for
 * content above the current viewport." They are pure (no DOM, no timers) so the
 * gesture-to-policy boundary stays unit-testable without a browser.
 *
 * Direction convention follows the scroll model, not the finger: `up` means the
 * reader wants earlier rows (scroll position decreasing, wheel delta negative,
 * finger dragging content downward, PageUp/Home).
 */

/** Direction the reader asked a scrollport for, from one observable input. */
export type ReaderIntent = 'up' | 'down' | 'none'

/** Kind of input that produced one intent sample. */
export type ReaderInputSource = 'wheel' | 'touch' | 'key' | 'scroll'

/** One normalized reader input and where it came from. */
export interface ReaderIntentSample {
    readonly intent: ReaderIntent
    readonly source: ReaderInputSource
}

/**
 * Convert one wheel sample.
 *
 * `deltaMode` is the DOM constant: 0 = pixels, 1 = lines, 2 = pages. Browsers
 * only use lines/pages for some hardware and platform settings; a fixed
 * conversion keeps the direction unambiguous (the policy never reads magnitude).
 *
 * @param deltaY - vertical wheel delta of the event.
 * @param deltaMode - `WheelEvent.deltaMode` (defaults to pixels).
 * @returns requested reader direction.
 */
export function wheelIntent(deltaY: number, deltaMode = 0): ReaderIntent {
    if (!Number.isFinite(deltaY)) return 'none'
    const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY
    if (pixels < 0) return 'up'
    if (pixels > 0) return 'down'
    return 'none'
}

/**
 * Convert one touch-move sample.
 *
 * A finger moving down on the glass drags content down, revealing earlier rows;
 * a finger moving up scrolls toward the tail.
 *
 * @param previousY - previous touch clientY, or null before the first move.
 * @param currentY - current touch clientY.
 * @returns requested reader direction.
 */
export function touchIntent(previousY: number | null, currentY: number): ReaderIntent {
    if (previousY === null || !Number.isFinite(previousY) || !Number.isFinite(currentY)) return 'none'
    if (currentY > previousY) return 'up'
    if (currentY < previousY) return 'down'
    return 'none'
}

/**
 * Convert one scroll sample from two consecutive scrollport positions.
 *
 * Scroll positions also change without reader input (history prepend
 * compensation, restored bookmarks, follow animations); the controller only
 * feeds samples observed immediately after a real input event, and this helper
 * keeps the sign rule in one place.
 *
 * @param previousTop - scrollTop before the sample.
 * @param currentTop - scrollTop after the sample.
 * @returns requested reader direction.
 */
export function scrollIntent(previousTop: number, currentTop: number): ReaderIntent {
    if (!Number.isFinite(previousTop) || !Number.isFinite(currentTop)) return 'none'
    if (currentTop < previousTop) return 'up'
    if (currentTop > previousTop) return 'down'
    return 'none'
}

/**
 * Convert one keyboard sample.
 *
 * Only keys the browser uses to scroll the focused scrollport carry intent, and
 * only while no browser/app shortcut modifier claims the chord. The plugin never
 * prevents the default action; this only decides whether an auto-load may start.
 *
 * @param key - `KeyboardEvent.key`.
 * @param modifiers - modifier state of the event.
 * @returns requested reader direction.
 */
export function keyIntent(
    key: string,
    modifiers: { readonly altKey?: boolean; readonly ctrlKey?: boolean; readonly metaKey?: boolean } = {},
): ReaderIntent {
    if (key === '') return 'none'
    if (modifiers.altKey === true || modifiers.ctrlKey === true || modifiers.metaKey === true) return 'none'
    switch (key) {
        case 'PageUp':
        case 'ArrowUp':
        case 'Home':
            return 'up'
        case 'PageDown':
        case 'ArrowDown':
        case 'End':
            return 'down'
        default:
            return 'none'
    }
}

/**
 * Wrap one normalized intent with its input source.
 *
 * @param intent - normalized direction.
 * @param source - input family that produced it.
 * @returns the sample passed to the load policy.
 */
export function intentSample(intent: ReaderIntent, source: ReaderInputSource): ReaderIntentSample {
    return { intent, source }
}
