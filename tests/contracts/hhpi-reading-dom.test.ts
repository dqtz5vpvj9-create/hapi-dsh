/** Actual official Renderer, SessionProvider, Conversation content, input and Chat.
 * Deterministic desktop/mobile jsdom profiles are not browser layout evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MountedChatV1 } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime, PropsRenderFactories, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { fixture } from './hhpi-reading-fixture.ts'
import { installDomGeometry } from './dom-geometry.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'hhpi.test.pane': { kind: 'single'; scope: 'session' } }
}

for (const profile of [{ name: 'desktop', width: 800, height: 600 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`real mounted official Chat controls isolate occurrences with ${profile.name} simulated geometry`, { timeout: 15000 }, async t => {
    const f = await fixture(t), geometry = installDomGeometry(f.dom.window, profile)
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
      ctx.slots.register({ name: 'root', children: {
        main: { kind: 'keyed', scope: 'root' }, 'hhpi.test.pane': { kind: 'single', scope: 'session' },
      } }, (props: PropsRuntime<'root'> & PropsRenderSlots<'hhpi.test.pane'>) => createElement('main', null,
        ...[a, b].map((pane, index) => createElement('section', { key: index, 'data-test-pane': index === 0 ? 'a' : 'b' },
          createElement(props.SessionProvider, { session: pane.reference }, props.renderSlot('hhpi.test.pane', {}))))))
      ctx.slots.register({ name: 'hhpi.test.pane' }, (props: PropsRenderFactories) =>
        props.renderFactorySlot('conversation.content', { phase: 'ready', hero: false, variant: 'embedded' }))
    } })
    let unmount: (() => void) | undefined
    try {
      await act(async () => { unmount = f.ctx.uiRenderer.mount(f.dom.window.document.getElementById('root')!) })
      assert.equal(controls.size, 2, 'both actual official views must deliver distinct controls')
      assert.notEqual(controls.get('a'), controls.get('b'))
      const editors = new Map<string, HTMLElement>()
      for (const id of ['a', 'b']) {
        const pane = f.dom.window.document.querySelector(`[data-test-pane="${id}"]`)!
        assert.ok(pane.querySelector('[data-chat-flow]'), 'the actual Chat flow must be mounted')
        assert.ok(pane.textContent?.includes('body-'), 'real user-message content must render')
        const editor = pane.querySelector<HTMLElement>('[contenteditable="true"]')
        assert.ok(editor, 'the actual occurrence input must be mounted'); editors.set(id, editor)
      }
      await act(async () => { a.input.setDraft('Rendered draft A'); b.input.setDraft('Rendered draft B') })
      assert.equal(editors.get('a')!.textContent, 'Rendered draft A'); assert.equal(editors.get('b')!.textContent, 'Rendered draft B')
      const initialB = b.reading.snapshot.getSnapshot().before
      for (let page = 1; page <= 6; ++page) {
        const before = a.reading.snapshot.getSnapshot().before
        let pending!: Promise<void>
        await act(async () => { pending = controls.get('a')!.loadOlder() })
        await geometry.settled(pending)
        assert.notEqual(a.reading.snapshot.getSnapshot().before, before)
        assert.equal(b.reading.snapshot.getSnapshot().before, initialB)
        assert.equal(f.body(a).length, (page + 1) * 160); assert.equal(f.body(b).length, 160)
        assert.equal(controls.get('a')!.read().busy, false)
        assert.equal(editors.get('a')!.textContent, 'Rendered draft A'); assert.equal(editors.get('b')!.textContent, 'Rendered draft B')
      }
      await act(async () => { geometry.resize({ width: profile.height, height: profile.width }) })
      assert.equal(editors.get('a')!.textContent, 'Rendered draft A')
      assert.equal(controls.get('a')!.read().busy, false)
      const disposed = controls.get('a')!
      await act(async () => { unmount?.(); unmount = undefined })
      assert.equal(controls.size, 0)
      await assert.rejects(disposed.loadOlder(), /attached|disposed|unmounted/i)
      assert.equal(f.writes.length, 0, 'opening, paging and closing views must never issue a native write')
    } finally {
      if (unmount) await act(async () => { unmount?.() })
      geometry.dispose()
    }
  })
}
