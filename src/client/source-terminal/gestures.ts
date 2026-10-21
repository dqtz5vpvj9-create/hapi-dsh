// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Touch motion adapted from pinned HAPI/TermBeam terminalGestures.ts.
 * HAPI: AGPL-3.0-only; TermBeam MIT notice: docs/licenses/TERMBEAM-MIT.txt.
 * Rendering and wheel interpretation stay with the unchanged official body.
 */
export type TerminalGestureMode = 'normal' | 'alternate' | 'blocked'
export interface TerminalTouchPoint { readonly clientX: number; readonly clientY: number }
export interface TerminalGestureOwner {
  visible(): boolean
  fontSize(): number
  setFontSize(size: number): void
  /** Only renderer-acknowledged modes may admit a wheel event. */
  mode(): TerminalGestureMode
  wheel(deltaY: number, clientX: number, clientY: number): boolean
  focus(): void
}
export interface TerminalGestureClock {
  now(): number
  frame(callback: () => void): () => void
  delay(callback: () => void, ms: number): () => void
}
const distance = (points: readonly TerminalTouchPoint[]): number => Math.hypot(points[0]!.clientX - points[1]!.clientX, points[0]!.clientY - points[1]!.clientY)

/** One occurrence owns this transient state; it never edits shared font preferences. */
export class TerminalGestures {
  private pinchDistance = 0
  private pinchFont = 0
  private pinching = false
  private tracking = false
  private claimed = false
  private blocked = false
  private tapEligible = false
  private startX = 0
  private startY = 0
  private lastY = 0
  private lastTime = 0
  private velocity = 0
  private cancelZoom: (() => void) | undefined
  private cancelCoast: (() => void) | undefined
  constructor(private readonly owner: TerminalGestureOwner, private readonly clock: TerminalGestureClock) {}
  start(points: readonly TerminalTouchPoint[]): void {
    this.cancelCoast?.(); this.cancelCoast = undefined
    if (!this.owner.visible()) { this.cancel(); return }
    if (points.length === 2) {
      this.pinching = true; this.tracking = false; this.tapEligible = false
      this.pinchDistance = distance(points); this.pinchFont = this.owner.fontSize()
      if (!(this.pinchDistance > 0) || !Number.isFinite(this.pinchFont)) this.cancel()
      return
    }
    if (points.length !== 1) { this.cancel(); return }
    const point = points[0]!
    this.pinching = false; this.tracking = true; this.tapEligible = true; this.claimed = false; this.blocked = false
    this.startX = point.clientX; this.startY = point.clientY; this.lastY = point.clientY
    this.lastTime = this.clock.now(); this.velocity = 0
  }
  /** Returns true only when the terminal has claimed motion, preserving native taps. */
  move(points: readonly TerminalTouchPoint[]): boolean {
    if (!this.owner.visible()) { this.cancel(); return false }
    if (this.pinching && points.length === 2) {
      const size = Math.min(32, Math.max(9, Math.round(this.pinchFont * distance(points) / this.pinchDistance)))
      this.cancelZoom?.()
      this.cancelZoom = this.clock.delay(() => {
        this.cancelZoom = undefined
        if (this.owner.visible()) this.owner.setFontSize(size)
      }, 50)
      return true
    }
    if (!this.tracking || points.length !== 1) return false
    const y = points[0]!.clientY
    if (!this.claimed) {
      if (Math.abs(y - this.startY) < 4) return false
      this.claimed = true; this.tapEligible = false
    }
    // Once movement was claimed, suppress browser compatibility clicks even
    // when output is not safe to interpret. A later ACK cannot revive this
    // partially consumed drag; the next touch starts a new gesture.
    if (this.blocked || this.owner.mode() === 'blocked') { this.blocked = true; this.velocity = 0; return true }
    const now = this.clock.now(), dt = now - this.lastTime, dy = this.lastY - y
    if (Math.abs(dy) >= 1) {
      if (dt > 0) this.velocity = dy / dt
      if (!this.owner.wheel(dy, this.startX, y)) { this.cancel(); return false }
      this.lastY = y; this.lastTime = now
    }
    return true
  }
  end(changed: readonly TerminalTouchPoint[]): void {
    const touch = changed[0]
    if (this.owner.visible() && this.tapEligible && !this.pinching && touch
      && Math.abs(touch.clientX - this.startX) < 10 && Math.abs(touch.clientY - this.startY) < 10) this.owner.focus()
    if (this.tracking && this.claimed && !this.blocked && this.owner.visible() && this.owner.mode() === 'normal' && Math.abs(this.velocity) > 0.15) {
      this.cancelCoast = this.clock.frame(() => this.coast())
    }
    this.tracking = false; this.tapEligible = false; this.pinching = false
  }
  private coast(): void {
    this.cancelCoast = undefined
    this.velocity *= 0.96
    // Recheck on every frame. A TUI, unacknowledged frame or hidden pane must
    // never receive momentum left over from scrolling normal history.
    if (!this.owner.visible() || this.owner.mode() !== 'normal' || Math.abs(this.velocity) < 0.05) return
    if (!this.owner.wheel(this.velocity * 16, this.startX, this.lastY)) return
    this.cancelCoast = this.clock.frame(() => this.coast())
  }
  cancel(): void {
    this.cancelZoom?.(); this.cancelZoom = undefined
    this.cancelCoast?.(); this.cancelCoast = undefined
    this.tracking = false; this.tapEligible = false; this.pinching = false; this.blocked = false; this.velocity = 0
  }
}

/** Browser events are the only bridge to the retained renderer; no emulator handles. */
export function attachTerminalGestures(container: HTMLElement, owner: Omit<TerminalGestureOwner, 'wheel'>): () => void {
  const browser = container.ownerDocument.defaultView
  if (!browser) return () => {}
  let target: Element | null = null
  const gestures = new TerminalGestures({ ...owner, wheel(deltaY, clientX, clientY) {
    if (!target?.isConnected || !container.contains(target)) return false
    // Chromium's constructor otherwise gives wheelDeltaY the SAME sign as
    // deltaY. xterm's retained viewport reads the legacy field first, while
    // its mouse-protocol owner reads deltaY. Encode both at construction, with
    // equivalent normalization (legacy /120, pixel delta /40), so both public
    // event consumers see the same direction. No existing event is patched.
    const init = { deltaY, deltaMode: 0, clientX, clientY, bubbles: true, cancelable: true,
      wheelDeltaY: -3 * deltaY, wheelDelta: -3 * deltaY, wheelDeltaX: 0 }
    target.dispatchEvent(new browser.WheelEvent('wheel', init))
    return true
  } }, {
    now: () => browser.performance.now(),
    frame(callback) { const id = browser.requestAnimationFrame(callback); return () => browser.cancelAnimationFrame(id) },
    delay(callback, ms) { const id = browser.setTimeout(callback, ms); return () => browser.clearTimeout(id) },
  })
  const points = (touches: TouchList): TerminalTouchPoint[] => Array.from(touches, touch => ({ clientX: touch.clientX, clientY: touch.clientY }))
  const start = (event: TouchEvent): void => {
    const element = event.target instanceof Element ? event.target : null
    if (!element?.closest('[data-sidebar-terminal]') || element.closest('button, select, input, [role=button]')) { cancel(); return }
    // Text spans are replaced during ordinary viewport scrolling. Dispatch on
    // the retained screen DOM so a redraw neither stops momentum nor changes
    // the event's official viewport/mouse-owner propagation path.
    target = element.closest('.xterm-screen')
    if (!target || !container.contains(target)) { cancel(); return }
    gestures.start(points(event.touches))
  }
  const move = (event: TouchEvent): void => {
    if (gestures.move(points(event.touches))) { event.preventDefault(); event.stopPropagation() }
  }
  const end = (event: TouchEvent): void => { gestures.end(points(event.changedTouches)) }
  const cancel = (): void => { gestures.cancel(); target = null }
  const visibility = (): void => { if (container.ownerDocument.visibilityState === 'hidden') cancel() }
  container.addEventListener('touchstart', start, { capture: true, passive: true })
  container.addEventListener('touchmove', move, { capture: true, passive: false })
  container.addEventListener('touchend', end, { capture: true })
  container.addEventListener('touchcancel', cancel, { capture: true })
  browser.addEventListener('blur', cancel)
  container.ownerDocument.addEventListener('visibilitychange', visibility)
  return () => {
    cancel()
    container.removeEventListener('touchstart', start, { capture: true })
    container.removeEventListener('touchmove', move, { capture: true })
    container.removeEventListener('touchend', end, { capture: true })
    container.removeEventListener('touchcancel', cancel, { capture: true })
    browser.removeEventListener('blur', cancel)
    container.ownerDocument.removeEventListener('visibilitychange', visibility)
  }
}
