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
import { ACTIVE_CONVERSATION_INPUT } from './conversation-content-input.ts'
import { installNativeComposerAdmission } from '../../src/client/native-composer.ts'
import { en } from '../../src/client/locales.ts'

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
        props.renderFactorySlot('conversation.content', ACTIVE_CONVERSATION_INPUT))
    } })
    const stopAdmission = installNativeComposerAdmission(f.sessions, f.ctx.conversation.blocks,
      { t: key => en[key], subscribe: () => () => {} })
    let unmount: (() => void) | undefined
    try {
      await act(async () => { unmount = f.ctx.uiRenderer.mount(f.dom.window.document.getElementById('root')!) })
      assert.equal(controls.size, 2, 'both actual official views must deliver distinct controls')
      assert.notEqual(controls.get('a'), controls.get('b'))
      const editors = new Map<string, HTMLElement>()
      for (const id of ['a', 'b']) {
        const pane = f.dom.window.document.querySelector(`[data-test-pane="${id}"]`)!
        assert.equal(pane.querySelector('[data-conversation-content]')?.getAttribute('data-content-phase'), 'active', 'source ready state must not replace the official active presentation phase')
        assert.ok(pane.querySelector('[data-chat-flow]'), 'the actual Chat flow must be mounted')
        assert.ok(pane.textContent?.includes('body-'), 'real user-message content must render')
        const editor = pane.querySelector<HTMLElement>('[contenteditable="true"]')
        assert.ok(editor, 'the actual occurrence input must be mounted'); editors.set(id, editor)
      }
      const paneA = f.dom.window.document.querySelector<HTMLElement>('[data-test-pane="a"]')!
      assert.ok(a.conversation.windowCommit)
      assert.ok(a.binding.viewId)
      await act(async () => { a.input.setDraft('Rendered draft A'); b.input.setDraft('Rendered draft B') })
      assert.equal(editors.get('a')!.textContent, 'Rendered draft A'); assert.equal(editors.get('b')!.textContent, 'Rendered draft B')
      const sourceSend = async (send: boolean): Promise<void> => {
        const accepted = Promise.withResolvers<void>(), id = f.canonical.sessionId
        const stop = f.remote.list.subscribe(() => {
          if (f.remote.list.getSnapshot().byId[id]?.projectionValues?.hhpiSource?.capabilities.send === send) accepted.resolve()
        })
        try {
          await act(async () => {
            const current = f.index.session
            f.index.edit({ ...current, capabilities: { ...current.capabilities, send } }, () => {})
            await accepted.promise
          })
        } finally { stop() }
      }
      for (const send of [false, true]) {
        await sourceSend(send)
        for (const id of ['a', 'b']) {
          const pane = f.dom.window.document.querySelector(`[data-test-pane="${id}"]`)!
          const button = pane.querySelector<HTMLButtonElement>('button[aria-label="input.send"]')
          assert.ok(button, 'the actual official send button must be mounted')
          assert.equal(button.disabled, !send, 'official input admission follows accepted source capability changes')
          assert.equal(editors.get(id)!.textContent, `Rendered draft ${id.toUpperCase()}`, 'capability changes preserve each visible draft')
        }
        assert.equal(f.writes.length, 0, 'capability recovery never submits a draft automatically')
      }
      let revision = 0
      let measured: { readonly key: string; readonly index: number } | null = null
      const corrections: Array<{ readonly key: string; readonly oldIndex: number; readonly orderIndex: number; readonly domIndex: number }> = []
      const observerFailures: string[] = []
      const stopDomObserver = a.conversation.windowCommit.register(a.binding.viewId, {
        id: 'mounted-node-dom-order',
        measure: () => {
          const snapshot = a.conversation.target('chat').getSnapshot()
          const order = (snapshot?.order ?? []) as readonly string[]
          const node = [...paneA.querySelectorAll<HTMLElement>('[data-chat-node-key]')]
            .find(candidate => candidate.dataset.chatNodeKey !== undefined
              && order.includes(candidate.dataset.chatNodeKey)
              && candidate.closest('[data-chat-virtual-row]') !== null)
          if (node === undefined) observerFailures.push('measure found no mounted official Chat Node')
          else {
            const key = node.dataset.chatNodeKey!
            const index = order.indexOf(key)
            const rowIndex = Number(node.closest<HTMLElement>('[data-chat-virtual-row]')?.dataset.index)
            if (rowIndex !== index) observerFailures.push(`pre-publish row index ${rowIndex} did not match order index ${index} for ${key}`)
            measured = { key, index }
          }
          return { revision: ++revision, anchor: null, following: false, scrollTop: 0,
            clientHeight: profile.height, scrollHeight: profile.height, nodes: order.length, available: false }
        },
        correct: () => {
          const previous = measured
          measured = null
          const snapshot = a.conversation.target('chat').getSnapshot()
          if (previous === null) {
            observerFailures.push('correct ran without a preceding measurement')
            return
          }
          const order = (snapshot?.order ?? []) as readonly string[]
          const orderIndex = order.indexOf(previous.key)
          const node = [...paneA.querySelectorAll<HTMLElement>('[data-chat-node-key]')]
            .find(candidate => candidate.dataset.chatNodeKey === previous.key)
          const rowIndex = Number(node?.closest<HTMLElement>('[data-chat-virtual-row]')?.dataset.index ?? NaN)
          corrections.push({ key: previous.key, oldIndex: previous.index, orderIndex, domIndex: rowIndex })
        },
      })
      t.after(stopDomObserver)
      const initialB = b.reading.snapshot.getSnapshot().before
      for (let page = 1; page <= 6; ++page) {
        const before = a.reading.snapshot.getSnapshot().before
        let pending!: Promise<void>
        await act(async () => { pending = controls.get('a')!.loadOlder() })
        await geometry.settled(pending)
        assert.deepEqual(observerFailures, [], `the observer must remain passive during page ${page}`)
        assert.notEqual(a.reading.snapshot.getSnapshot().before, before)
        assert.equal(b.reading.snapshot.getSnapshot().before, initialB)
        assert.equal(f.body(a).length, (page + 1) * 160); assert.equal(f.body(b).length, 160)
        assert.equal(corrections.length, page, `DOM-order correction must complete for page ${page}`)
        assert.equal(measured, null, `page ${page} must not leave a measured but uncorrected Node`)
        const correction = corrections[page - 1]!
        assert.ok(correction.orderIndex >= 0, 'the measured Node must remain in the committed Chat window')
        assert.equal(correction.domIndex, correction.orderIndex,
          `correct must run after React commits the new order for ${correction.key} (was ${correction.oldIndex})`)
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
      stopAdmission()
      if (unmount) await act(async () => { unmount?.() })
      geometry.dispose()
    }
  })
}

test('Host reveals a read-only source with the real official Chat and composer, then recovers write capability in place', { timeout: 15000 }, async t => {
  const f = await fixture(t, { send: false }), geometry = installDomGeometry(f.dom.window, { width: 390, height: 844 })
  const { installSessionViewHost } = await import('../../src/client/surface/session-view.tsx')
  const id = f.canonical.sessionId
  const state = <T,>(initial: T) => {
    let value = initial
    const listeners = new Set<() => void>()
    return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set(next: T) { value = next; for (const listener of listeners) listener() } }
  }
  const sourceSend = async (send: boolean): Promise<void> => {
    const changed = Promise.withResolvers<void>()
    const stop = f.remote.list.subscribe(() => {
      if (f.remote.list.getSnapshot().byId[id]?.projectionValues?.hhpiSource?.capabilities.send === send) changed.resolve()
    })
    try {
      await act(async () => {
        const source = f.index.session
        f.index.edit({ ...source, capabilities: { ...source.capabilities, send } }, () => {})
        await changed.promise
      })
    } finally { stop() }
  }
  const stopAdmission = installNativeComposerAdmission(f.sessions, f.ctx.conversation.blocks,
    { t: key => en[key], subscribe: () => () => {} })
  let host!: ReturnType<typeof installSessionViewHost>
  await f.ctx.plugin({ name: 'readonly-host-contract', inject: ['slots', 'sessions', 'uiConversation'], apply(ctx: Context) {
    ctx.slots.provideRoot({ hooks: {
      workspaces: state({ items: [], phase: 'ready' }), panelInfo: state({ activePanelId: null }),
    } })
    ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } } },
      (props: PropsRenderSlots<'shell.overlay'>) => props.renderSlot('shell.overlay', {}))
    host = installSessionViewHost(ctx)
    return () => host.dispose()
  } })
  const target = f.dom.window.document.createElement('section')
  f.dom.window.document.body.append(target)
  const readerReady = Promise.withResolvers<void>(), failures: unknown[] = []
  let unmount: (() => void) | undefined, view: ReturnType<typeof host.mount> | undefined
  try {
    await act(async () => {
      unmount = f.ctx.uiRenderer.mount(f.dom.window.document.getElementById('root')!)
      view = host.mount({ paneId: 'readonly-first-open', target, reference: f.canonical,
        navigation: { hostId: 'local', paneId: 'readonly-first-open', state: state({ visible: true, focused: true }),
          reading: state(undefined) } as unknown as import('../../src/client/pane-navigation.ts').WorkspacePaneNavigation,
        onReady: () => readerReady.resolve(), onError: error => failures.push(error) })
    })
    await geometry.settled(readerReady.promise)
    assert.deepEqual(failures, [], 'a source write refusal cannot fail its readable history')
    const reveal = target.querySelector<HTMLElement>('[data-hapi-session-reveal]')!
    assert.equal(reveal.style.visibility, 'visible')
    assert.ok(target.textContent?.includes('body-'), 'the installed official Chat must show accepted source content')
    assert.equal(target.querySelector('[data-hapi-session-loading]'), null)
    const flow = target.querySelector('[data-chat-flow]')
    const editor = target.querySelector<HTMLElement>('[data-composer-input]')
    assert.ok(flow); assert.ok(editor)
    const button = target.querySelector<HTMLButtonElement>('button[aria-label="input.send"]')!
    assert.ok(button)
    assert.equal(button.disabled, true, 'read readiness cannot grant source write ownership')
    assert.equal(f.ctx.conversation.blocks.storeFor(id).getSnapshot()?.reason, en.sourceReadOnly)
    await sourceSend(true)
    assert.equal(target.querySelector('[data-chat-flow]'), flow)
    assert.equal(target.querySelector('[data-composer-input]'), editor)
    assert.equal(f.ctx.conversation.blocks.storeFor(id).getSnapshot(), undefined, 'official composer admission follows live source recovery')
    assert.equal(target.querySelector<HTMLButtonElement>('button[aria-label="input.send"]')?.disabled, true, 'the empty editor still cannot submit an empty prompt')
    assert.equal(f.writes.length, 0, 'capability recovery must not send anything automatically')
    assert.deepEqual(failures, [])
  } finally {
    stopAdmission()
    let disposing: Promise<void> | undefined
    await act(async () => { disposing = view?.dispose() })
    await disposing
    await act(async () => { unmount?.() })
    geometry.dispose()
  }
})
