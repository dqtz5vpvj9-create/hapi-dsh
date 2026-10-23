/** Background graph evaluation must yield to typing, touch and inertial scrolling. */
export class ForegroundActivity {
    private until = 0
    private readonly pointers = new Set<number>()
    private touches = 0
    private intentUntil = 0
    private motion: { target: EventTarget; nativeEnd: boolean } | undefined
    constructor(private readonly now = () => performance.now()) {}
    defer(): void { this.until = this.now() + 600 }
    private clearMotion(): void { this.motion = undefined; this.intentUntil = 0 }
    press(id: number): void { this.clearMotion(); this.pointers.add(id); this.defer() }
    release(id: number): void { this.pointers.delete(id); this.defer() }
    touch(count: number): void {
        if (count > this.touches) this.clearMotion()
        this.touches = count; this.defer()
    }
    busy = (): boolean => {
        // A removed pane cannot deliver scrollend. isConnected is structural
        // and does not measure layout or place a time limit on real inertia.
        if (this.motion && 'isConnected' in this.motion.target && this.motion.target.isConnected === false) this.clearMotion()
        return this.pointers.size > 0 || this.touches > 0 || this.now() < this.until || this.motion?.nativeEnd === true
    }
    scrollIntent(): void {
        this.defer(); this.intentUntil = this.until; this.motion = undefined
    }
    scroll(target: EventTarget, nativeEnd = true): void {
        if (this.motion && !this.motion.nativeEnd && this.now() >= this.until) {
            this.clearMotion()
        }
        if (this.motion ? this.motion.target !== target : this.now() >= this.intentUntil) return
        this.motion = { target, nativeEnd }
        if (!nativeEnd) { this.defer(); this.intentUntil = this.until }
    }
    scrollend(target: EventTarget): boolean {
        if (this.motion?.target !== target) return false
        this.clearMotion(); this.defer()
        return true
    }
}

export function observeForegroundActivity(document: Document): ForegroundActivity & { dispose(): void } {
    const activity = new ForegroundActivity()
    const press = (event: PointerEvent) => { if (event.isTrusted) activity.press(event.pointerId) }
    const release = (event: PointerEvent) => { if (event.isTrusted) activity.release(event.pointerId) }
    const touch = (event: TouchEvent) => { if (event.isTrusted) activity.touch(event.touches.length) }
    const input = (event: Event) => { if (event.isTrusted) activity.defer() }
    let intentTarget: Node | null = null
    const intent = (event: Event) => {
        if (!event.isTrusted) return
        intentTarget = event.target instanceof Node ? event.target : null
        activity.scrollIntent()
    }
    const scroll = (event: Event) => {
        // Bind only the actual scroller containing the trusted gesture. A live
        // follow in another pane, or a nested tool's scroll, cannot renew it.
        if (event.target instanceof Node && intentTarget && event.target.contains(intentTarget)) {
            activity.scroll(event.target, 'onscrollend' in event.target)
        }
    }
    const scrollend = (event: Event) => {
        if (event.target && activity.scrollend(event.target)) intentTarget = null
    }
    document.addEventListener('pointerdown', press, { capture: true, passive: true })
    document.addEventListener('pointerup', release, { capture: true, passive: true })
    // Native panning cancels the pointer even while the finger stays down.
    // Touch contacts retain ownership through a pause; scroll carries inertia.
    document.addEventListener('pointercancel', release, { capture: true, passive: true })
    for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) document.addEventListener(type, touch, { capture: true, passive: true })
    for (const type of ['wheel', 'touchmove']) document.addEventListener(type, intent, { capture: true, passive: true })
    for (const type of ['keydown', 'input']) document.addEventListener(type, input, { capture: true, passive: true })
    document.addEventListener('scroll', scroll, { capture: true, passive: true })
    document.addEventListener('scrollend', scrollend, { capture: true, passive: true })
    return Object.assign(activity, { dispose() {
        document.removeEventListener('pointerdown', press, true)
        document.removeEventListener('pointerup', release, true)
        document.removeEventListener('pointercancel', release, true)
        for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) document.removeEventListener(type, touch, true)
        for (const type of ['wheel', 'touchmove']) document.removeEventListener(type, intent, true)
        for (const type of ['keydown', 'input']) document.removeEventListener(type, input, true)
        document.removeEventListener('scroll', scroll, true)
        document.removeEventListener('scrollend', scrollend, true)
    } })
}
