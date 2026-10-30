/** Explicit deterministic jsdom geometry. Never imported by a browser or production entry. */
import { createRequire } from 'node:module'
import type { DOMWindow } from 'jsdom'
import { act } from 'react'
const require = createRequire(import.meta.url)
export interface GeometryProfile { width: number; height: number; rowHeight?: number; scrollHeight?: number }
export interface ElementBox { x: number; y: number; width: number; height: number }

export function installDomGeometry(window: DOMWindow, initial: GeometryProfile) {
  let profile = { ...initial }, disposed = false
  const restored: Array<() => void> = [], boxes = new WeakMap<Element, ElementBox>(), observers = new Set<GeometryObserver>()
  function property(target: object, key: string, descriptor: PropertyDescriptor): void {
    const before = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, ...descriptor })
    restored.push(() => { if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key) })
  }
  function box(element: HTMLElement): ElementBox {
    return boxes.get(element) ?? { x: 0, y: 0, width: profile.width, height: element.hasAttribute('data-chat-virtual-row') ? profile.rowHeight ?? 96 : profile.height }
  }
  function notify(target?: HTMLElement): void {
    for (const observer of observers) observer.notify(target)
  }
  class GeometryObserver {
    private readonly targets = new Set<HTMLElement>()
    constructor(private readonly callback: ResizeObserverCallback) { observers.add(this) }
    observe(target: HTMLElement): void { this.targets.add(target); this.notify(target) }
    unobserve(target: HTMLElement): void { this.targets.delete(target) }
    disconnect(): void { this.targets.clear(); observers.delete(this) }
    notify(target?: HTMLElement): void {
      const targets = target ? [target] : [...this.targets]
      queueMicrotask(() => {
        if (disposed) return
        const entries = targets.filter(value => this.targets.has(value)).map(value => ({ target: value, contentRect: value.getBoundingClientRect(),
          borderBoxSize: [{ inlineSize: value.clientWidth, blockSize: value.clientHeight }], contentBoxSize: [], devicePixelContentBoxSize: [] }))
        if (entries.length) this.callback(entries, this as unknown as ResizeObserver)
      })
    }
  }
  for (const name of ['Document', 'DocumentFragment', 'Text', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLDivElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLIFrameElement', 'HTMLImageElement', 'KeyboardEvent', 'InputEvent', 'Event', 'CustomEvent', 'DOMParser', 'DOMRectReadOnly', 'Selection']) {
    const value = Reflect.get(window, name); if (value !== undefined) property(globalThis, name, { value })
  }
  property(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true })
  property(globalThis, 'requestAnimationFrame', { value: window.requestAnimationFrame.bind(window) })
  property(globalThis, 'cancelAnimationFrame', { value: window.cancelAnimationFrame.bind(window) })
  const matchMedia = (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  for (const target of [window, globalThis]) {
    property(target, 'matchMedia', { value: matchMedia })
    property(target, 'ResizeObserver', { value: GeometryObserver })
    property(target, 'CSS', { value: { escape: require('css.escape') } })
  }
  property(window, 'innerWidth', { get: () => profile.width })
  property(window, 'innerHeight', { get: () => profile.height })
  property(window.HTMLElement.prototype, 'clientWidth', { get(this: HTMLElement) { return box(this).width } })
  property(window.HTMLElement.prototype, 'clientHeight', { get(this: HTMLElement) { return box(this).height } })
  property(window.HTMLElement.prototype, 'scrollHeight', { get() { return profile.scrollHeight ?? 16000 } })
  property(window.HTMLElement.prototype, 'getBoundingClientRect', { value: function(this: HTMLElement) { const value = box(this); return new window.DOMRect(value.x, value.y, value.width, value.height) } })
  property(window.Range.prototype, 'getBoundingClientRect', { value: () => new window.DOMRect(0, 0, 1, 20) })
  property(window.Range.prototype, 'getClientRects', { value: () => { const rect = new window.DOMRect(0, 0, 1, 20); return Object.assign([rect], { item: (index: number) => index === 0 ? rect : null }) } })
  property(window.HTMLElement.prototype, 'scrollTo', { value: function(this: HTMLElement, options: ScrollToOptions | number, top?: number) {
    this.scrollTop = typeof options === 'number' ? top ?? 0 : options.top ?? this.scrollTop
  } })
  return {
    resize(next: GeometryProfile): void { profile = { ...next }; notify(); window.dispatchEvent(new window.Event('resize')) },
    setBox(element: HTMLElement, value: ElementBox): void { boxes.set(element, value); notify(element) },
    /** Flush committed React layout frames, with no fixed per-page sleep or retry. */
    async settled(pending: Promise<unknown>): Promise<void> {
      let finished = false
      void pending.then(() => { finished = true }, () => { finished = true })
      for (let frame = 0; frame < 45 && !finished; frame++) {
        await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())) })
      }
      if (!finished) throw new Error('Mounted operation did not settle within 45 jsdom animation frames')
      await pending
    },
    dispose(): void { if (disposed) return; disposed = true; for (const observer of observers) observer.disconnect(); for (const restore of restored.reverse()) restore() },
  }
}
