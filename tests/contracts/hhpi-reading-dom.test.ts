/** Actual official Renderer, SessionProvider, Conversation content, input and Chat.
 * Geometry is deterministic jsdom input, not browser layout acceptance evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MountedChatV1 } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { fixture } from './hhpi-reading-fixture.ts'
const require = createRequire(import.meta.url)

test('real mounted official Chat controls page only their own canonical-session occurrence', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const restored: Array<() => void> = []
  function property(target: object, key: string, descriptor: PropertyDescriptor): void {
    const before = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, ...descriptor })
    restored.push(() => { if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key) })
  }
  for (const name of ['Document', 'DocumentFragment', 'Text', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLDivElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLIFrameElement', 'HTMLImageElement', 'KeyboardEvent', 'InputEvent', 'Event', 'CustomEvent', 'DOMParser', 'DOMRectReadOnly', 'Selection']) {
    const value = Reflect.get(f.dom.window, name)
    if (value !== undefined) property(globalThis, name, { value })
  }
  property(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true })
  property(globalThis, 'requestAnimationFrame', { value: f.dom.window.requestAnimationFrame.bind(f.dom.window) })
  property(globalThis, 'cancelAnimationFrame', { value: f.dom.window.cancelAnimationFrame.bind(f.dom.window) })
  const matchMedia = (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  property(f.dom.window, 'matchMedia', { value: matchMedia })
  property(globalThis, 'matchMedia', { value: matchMedia })
  property(globalThis, 'CSS', { value: { escape: require('css.escape') } })
  property(f.dom.window.HTMLElement.prototype, 'clientHeight', { get() { return this.hasAttribute('data-chat-virtual-row') ? 96 : 600 } })
  property(f.dom.window.HTMLElement.prototype, 'clientWidth', { get() { return 800 } })
  property(f.dom.window.HTMLElement.prototype, 'scrollHeight', { get() { return 16000 } })
  property(f.dom.window.HTMLElement.prototype, 'getBoundingClientRect', { value: function(this: HTMLElement) {
    return new f.dom.window.DOMRect(0, 0, 800, this.hasAttribute('data-chat-virtual-row') ? 96 : 600)
  } })
  property(f.dom.window.HTMLElement.prototype, 'scrollTo', { value: function(this: HTMLElement, options: ScrollToOptions | number, top?: number) {
    this.scrollTop = typeof options === 'number' ? top ?? 0 : options.top ?? this.scrollTop
  } })
  class GeometryObserver {
    private disposed = false
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: HTMLElement): void {
      queueMicrotask(() => {
        if (this.disposed) return
        this.callback([{ target, contentRect: target.getBoundingClientRect(),
          borderBoxSize: [{ inlineSize: 800, blockSize: target.clientHeight }], contentBoxSize: [], devicePixelContentBoxSize: [] }], this as unknown as ResizeObserver)
      })
    }
    unobserve(): void {}
    disconnect(): void { this.disposed = true }
  }
  property(globalThis, 'ResizeObserver', { value: GeometryObserver })
  property(f.dom.window, 'ResizeObserver', { value: GeometryObserver })
  const controls = new Map<string, MountedChatV1>()
  f.ctx.reflect.provide('mountedChatConsumer', { onMountedChat(control: MountedChatV1 | null, element: HTMLElement) {
    const id = element.closest<HTMLElement>('[data-test-pane]')?.dataset.testPane
    if (!id) throw new Error('A mounted official reader has no occurrence element.')
    if (control) controls.set(id, control); else controls.delete(id)
  } })
  const a = await f.open('dom-a'), b = await f.open('dom-b')
  await f.ctx.plugin({ name: 'reading-contract-root', inject: ['slots'], apply(ctx: Context) {
    const workspaces = { items: [], phase: 'ready' }, panelInfo = { activePanelId: null }
    ctx.slots.provideRoot({ hooks: {
      workspaces: { getSnapshot: () => workspaces, subscribe: () => () => {} },
      panelInfo: { getSnapshot: () => panelInfo, subscribe: () => () => {} },
    } })
    // The main declaration activates the official subtree. Its factory owns
    // conversation.session and every composer child; do not redeclare them.
    ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } },
      (props: PropsRuntime<'root'>) => createElement('main', null,
        ...[a, b].map((pane, index) => createElement('section', { key: index, 'data-test-pane': index === 0 ? 'a' : 'b' },
          createElement(props.SessionProvider, { session: pane.reference },
            props.renderFactorySlot('conversation.content', { phase: 'ready', hero: false, variant: 'embedded' }))))))
  } })
  let unmount: (() => void) | undefined
  try {
    await act(async () => { unmount = f.ctx.uiRenderer.mount(f.dom.window.document.getElementById('root')!) })
    assert.equal(controls.size, 2, `both actual official views must deliver distinct controls: ${f.dom.window.document.body.innerHTML.slice(0, 6000)}`)
    assert.notEqual(controls.get('a'), controls.get('b'))
    for (const id of ['a', 'b']) {
      const pane = f.dom.window.document.querySelector(`[data-test-pane="${id}"]`)!
      assert.ok(pane.querySelector('[data-chat-flow]'), 'the actual Chat flow must be mounted')
      assert.ok(pane.textContent?.includes('body-'), 'real user-message content must render')
      assert.ok(pane.querySelector('[contenteditable="true"]'), 'the actual occurrence input must be mounted')
    }
    const initialA = a.reading.snapshot.getSnapshot().before
    const initialB = b.reading.snapshot.getSnapshot().before
    let pending!: Promise<void>
    await act(async () => { pending = controls.get('a')!.loadOlder(); await new Promise(resolve => setTimeout(resolve, 100)) })
    await pending
    assert.notEqual(a.reading.snapshot.getSnapshot().before, initialA)
    assert.equal(b.reading.snapshot.getSnapshot().before, initialB)
    assert.equal(f.body(a).length, 320)
    assert.equal(f.body(b).length, 160)
    assert.equal(controls.get('a')!.read().busy, false)
    const disposed = controls.get('a')!
    await act(async () => { unmount?.(); unmount = undefined })
    assert.equal(controls.size, 0)
    await assert.rejects(disposed.loadOlder(), /attached|disposed|unmounted/i)
    assert.equal(f.writes.length, 0, 'opening, paging and closing views must never issue a native write')
  } finally {
    if (unmount) await act(async () => { unmount?.() })
    for (const restore of restored.reverse()) restore()
  }
})
