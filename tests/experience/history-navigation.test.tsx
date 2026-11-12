import { act, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createRef, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PaneReadingIntent } from '../../src/client/reading-intent.ts'
import type { MountedChatControlV1 } from '../../src/client/mounted-chat-control.ts'
import { publishPaneMountedChat } from '../../src/client/mounted-chat-control.ts'
import { installSourceWindowNavigation } from '../../src/client/surface/source-window-navigation.tsx'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import { context, pane, slots } from './fixtures.tsx'

test('an archive gap offers latest in its own pane, remains disabled during loading, and disappears only after the gap closes', async () => {
  const registered = slots(), user = userEvent.setup()
  const window = createSnapshotStore({ hasMoreAfter: true }), session = createSnapshotStore({ loadingOlder: false })
  const ctx = context({ slots: registered.registry, sessions: { binding: () => ({ session: { sourceWindow: window } }) } })
  const stop = installSourceWindowNavigation(ctx), Latest = registered.component('hapi.source-latest')
  const left = pane('left'), right = pane('right')
  const props = { sessionId: 'fixture-session', t: () => 'Latest messages', useSession: (select: (value: { loadingOlder: boolean }) => boolean) =>
    useSyncExternalStore(session.subscribe, () => select(session.getSnapshot())) } as unknown as PropsRuntime<'conversation.input.dock'>
  function View() { return <><section aria-label="Left"><WorkspacePaneProvider value={left}><Latest {...props}/></WorkspacePaneProvider></section>
    <section aria-label="Right"><WorkspacePaneProvider value={right}><Latest {...props}/></WorkspacePaneProvider></section></> }
  const view = render(<View/>)
  await user.click(within(screen.getByRole('region', { name: 'Right' })).getByRole('button', { name: 'Latest messages' }))
  expect(right.locate).toHaveBeenCalledExactlyOnceWith({ kind: 'latest' }); expect(left.locate).not.toHaveBeenCalled()
  await act(async () => session.set({ loadingOlder: true }))
  expect(within(screen.getByRole('region', { name: 'Right' })).getByRole('button')).toBeDisabled()
  await user.click(within(screen.getByRole('region', { name: 'Right' })).getByRole('button'))
  expect(right.locate).toHaveBeenCalledTimes(1)
  await act(async () => window.set({ hasMoreAfter: false }))
  expect(screen.queryByRole('button', { name: 'Latest messages' })).not.toBeInTheDocument()
  view.unmount(); stop()
})

test('a failed source page remains visible with a retry action until a retry succeeds', async () => {
  const registered = slots(), user = userEvent.setup()
  const initialWindow: { hasMoreAfter: boolean; before: { at: number; seq: number } | null; pagingError?: true } = {
    hasMoreAfter: false, before: { at: 10, seq: 4 }, pagingError: true,
  }
  const window = createSnapshotStore(initialWindow)
  const loadOlder = vi.fn().mockResolvedValue(undefined)
  const session = createSnapshotStore({ loadingOlder: false })
  const ctx = context({ slots: registered.registry, sessions: { binding: () => ({ session: { sourceWindow: window, loadOlder } }) } })
  const stop = installSourceWindowNavigation(ctx), Latest = registered.component('hapi.source-latest')
  const current = pane('current')
  const props = {
    sessionId: 'fixture-session',
    t: (key: string, args?: { message?: string; code?: string }) => ({
      'chat.toBottom': 'Latest messages', 'chat.loadOlder': 'Retry older', 'chat.loadingHistory': 'Loading history',
      'chat.loadError': `历史加载失败：${args?.message}（${args?.code}）`,
    }[key] ?? key),
    useSession: (select: (value: { loadingOlder: boolean }) => boolean) =>
      useSyncExternalStore(session.subscribe, () => select(session.getSnapshot())),
  } as unknown as PropsRuntime<'conversation.input.dock'>
  function View() { return <WorkspacePaneProvider value={current}><Latest {...props}/></WorkspacePaneProvider> }
  const view = render(<View/>), status = screen.getByRole('status')
  expect(status).toHaveTextContent('历史加载失败：Retry older（history_page_failed）')
  const retry = within(status).getByRole('button', { name: 'Retry older' })
  await user.click(retry)
  expect(loadOlder).toHaveBeenCalledOnce()
  await act(async () => session.set({ loadingOlder: true }))
  expect(within(status).getByRole('button', { name: 'Loading history' })).toBeDisabled()
  await act(async () => { window.set({ hasMoreAfter: false, before: { at: 10, seq: 4 } }) })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  view.unmount(); stop()
})

test('resume requests the current Pane destination and keeps an unconfirmed position available', async () => {
  const registered = slots(), user = userEvent.setup(), current = pane('current')
  const window = createSnapshotStore({ hasMoreAfter: false })
  const bound = { sourceWindow: window, resumeReadingTarget: 900 }
  const ctx = context({ slots: registered.registry,
    locale: { getSnapshot: () => ({ active: 'zh' }) },
    sessions: { binding: () => ({ session: { resumeReadingTarget: 300 } }) } })
  const stop = installSourceWindowNavigation(ctx), Latest = registered.component('hapi.source-latest')
  const props = { sessionId: 'fixture-session', sessionBinding: { session: bound }, t: () => 'Latest', useSession: () => false } as unknown as PropsRuntime<'conversation.input.dock'>
  const view = render(<WorkspacePaneProvider value={current}><Latest {...props}/></WorkspacePaneProvider>)
  expect(current.locate).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: /继续上次阅读/ }))
  expect(current.locate).toHaveBeenCalledExactlyOnceWith({ kind: 'message', messageId: '900', origin: 'link' })
  expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
  view.unmount(); stop()
})

function resumeFixture() {
  const registered = slots(), current = pane('current'), root = createRef<HTMLElement>()
  const intent = createSnapshotStore<PaneReadingIntent | undefined>({ revision: 1, sessionId: 'source-session', target: { kind: 'latest' } })
  Object.assign(current, { reading: intent })
  const events = vi.spyOn(HTMLElement.prototype, 'addEventListener')
  let rowTop = 700, rendered = true
  const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  const node = { key: 'saved-source-body', kind: 'user', anchorSeq: 900, visibility: 'visible', data: { seq: 900 } }
  const chat = createSnapshotStore({ order: [node.key], nodes: { get: (key: string) => key === node.key ? node : undefined, values: () => [node] } })
  const reading = createSnapshotStore({ phase: 'ready', busy: false, correction: 'applied', entries: [], version: 'source-window' })
  const sourceWindow = createSnapshotStore({ hasMoreAfter: false })
  const session = { sourceWindow, resumeReadingTarget: 900, readingView: { snapshot: reading } }
  const binding = { sessionId: 'source-session', session } as unknown as SessionBinding
  const ctx = context({ slots: registered.registry, locale: { getSnapshot: () => ({ active: 'zh' }), bind: () => (key: string) => key },
    uiConversation: { binding: (value: SessionBinding) => { expect(value).toBe(binding); return { target: () => chat } } } })
  const stop = installSourceWindowNavigation(ctx), Latest = registered.component('hapi.source-latest')
  const props = { sessionId: binding.sessionId, sessionBinding: binding, t: () => 'Latest', useSession: () => false } as unknown as PropsRuntime<'conversation.input.dock'>
  const view = render(<section ref={root} data-hhpi-reading-owner=""><div data-conversation-scroll>
    <div data-chat-node-key={node.key} data-chat-anchor-key={node.key}>Saved source body</div><div data-composer-seat/>
  </div><WorkspacePaneProvider value={current}><Latest {...props}/></WorkspacePaneProvider></section>)
  const port = root.current!.querySelector<HTMLElement>('[data-conversation-scroll]')!, row = port.firstElementChild as HTMLElement
  port.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 800, height: 500, width: 800 }) as DOMRect
  row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 80, left: 20, right: 700, height: 80, width: 680 }) as DOMRect
  row.getClientRects = () => [row.getBoundingClientRect()] as unknown as DOMRectList
  Object.defineProperty(port.querySelector('[data-composer-seat]'), 'offsetHeight', { value: 100 })
  const listeners = new Set<() => void>()
  const control: MountedChatControlV1 = { version: 1, read: () => ({ revision: 1, renderRevision: 1, anchor: { key: node.key, top: rowTop }, following: false, hasOlder: true, busy: false }),
    renderedNode: () => rendered ? node as never : undefined,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    loadOlder: async () => {}, reveal: async () => {}, toLatest: async () => {} }
  act(() => publishPaneMountedChat(root.current!, control))
  return { current, root: root.current!, row, reading, session, intent,
    move(top: number) { rowTop = top; for (const listener of listeners) listener() },
    rendered(value: boolean) { rendered = value; for (const listener of listeners) listener() },
    frame() { act(() => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0) }) },
    nativeClick(button: HTMLButtonElement, trusted: boolean) {
      const index = events.mock.calls.findIndex((args, index) => events.mock.contexts[index] === root.current && args[0] === 'click' && args[2] === true)
      const listener = events.mock.calls[index]?.[1] as EventListener
      expect(listener).toBeTypeOf('function')
      act(() => listener({ isTrusted: trusted, target: button } as unknown as Event))
    },
    close() { publishPaneMountedChat(root.current!, null); view.unmount(); stop() } }
}

test('a naturally reached saved body retires Continue reading only when its real rendered row enters the unobscured viewport', () => {
  const f = resumeFixture()
  try {
    f.frame(); expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    f.move(420); f.frame()
    expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    f.move(250); f.frame()
    expect(screen.queryByRole('button', { name: /继续上次阅读/ })).not.toBeInTheDocument()
    expect(f.current.locate).not.toHaveBeenCalled()
    f.move(700); f.frame()
    expect(screen.queryByRole('button', { name: /继续上次阅读/ })).not.toBeInTheDocument()
  } finally { f.close() }
})

test('clicking Continue reading keeps the original target until its accepted render actually arrives', async () => {
  const f = resumeFixture(), user = userEvent.setup()
  try {
    f.frame(); await user.click(screen.getByRole('button', { name: /继续上次阅读/ }))
    expect(f.current.locate).toHaveBeenCalledExactlyOnceWith({ kind: 'message', messageId: '900', origin: 'link' })
    expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    f.rendered(false); f.move(150); f.frame()
    expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    f.rendered(true); f.frame()
    expect(screen.queryByRole('button', { name: /继续上次阅读/ })).not.toBeInTheDocument()
  } finally { f.close() }
})

test('a hidden occurrence or a visible duplicate in another Pane cannot retire the current saved position', async () => {
  const f = resumeFixture()
  const duplicate = document.createElement('div'); duplicate.dataset.chatNodeKey = 'saved-source-body'; document.body.append(duplicate)
  duplicate.getBoundingClientRect = () => ({ top: 100, bottom: 180, left: 20, right: 700, height: 80, width: 680 }) as DOMRect
  try {
    f.frame(); expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    await act(async () => f.current.state.set({ visible: false, focused: false }))
    f.move(100); f.frame(); expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    await act(async () => f.current.state.set({ visible: true, focused: true }))
    f.frame(); expect(screen.queryByRole('button', { name: /继续上次阅读/ })).not.toBeInTheDocument()
  } finally { duplicate.remove(); f.close() }
})

test('a prepared page and a busy reader cannot acknowledge the saved destination before the official window commits', async () => {
  const f = resumeFixture()
  try {
    await act(async () => f.reading.set({ ...f.reading.getSnapshot(), busy: true }))
    f.move(100); f.frame(); expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    await act(async () => f.reading.set({ ...f.reading.getSnapshot(), busy: false }))
    f.frame(); expect(screen.queryByRole('button', { name: /继续上次阅读/ })).not.toBeInTheDocument()
  } finally { f.close() }
})

test('startup latest and automatic source commits preserve the offer, but a new explicit latest ends it', async () => {
  const f = resumeFixture()
  try {
    f.frame(); expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    await act(async () => f.reading.set({ ...f.reading.getSnapshot(), version: 'source-newer-window' }))
    f.frame(); expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    await act(async () => f.intent.set({ revision: 2, sessionId: 'source-session', target: { kind: 'latest' } }))
    expect(screen.queryByRole('button', { name: /继续上次阅读/ })).not.toBeInTheDocument()
  } finally { f.close() }
})

test('navigation to another Pane cannot retire this offer; choosing a different message in this Pane can', async () => {
  const f = resumeFixture()
  try {
    await act(async () => f.intent.set({ revision: 2, sessionId: 'another-source-session', target: { kind: 'message', messageId: '500', origin: 'link' } }))
    f.frame(); expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    await act(async () => f.intent.set({ revision: 3, sessionId: 'source-session', target: { kind: 'message', messageId: '500', origin: 'link' } }))
    expect(screen.queryByRole('button', { name: /继续上次阅读/ })).not.toBeInTheDocument()
  } finally { f.close() }
})

test('only the actual user native to-bottom action retires an old offer, without replacing its reading owner', () => {
  const f = resumeFixture(), button = document.createElement('button')
  button.className = 'official_toBottom'; button.setAttribute('aria-label', 'Latest'); f.root.append(button)
  try {
    f.frame(); f.nativeClick(button, false)
    expect(screen.getByRole('button', { name: /继续上次阅读/ })).toBeInTheDocument()
    f.nativeClick(button, true)
    expect(screen.queryByRole('button', { name: /继续上次阅读/ })).not.toBeInTheDocument()
    expect(f.current.locate).not.toHaveBeenCalled()
  } finally { f.close() }
})
