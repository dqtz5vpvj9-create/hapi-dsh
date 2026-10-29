import { act, fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installComposerEnter } from '../../src/client/composer-enter/index.tsx'
import { createWorkspaceUiPreferences } from '../../src/client/ui-preferences.ts'
import { COMPOSER_ENTER_KEY } from '../../src/client/composer-enter/preferences.ts'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import type { ComposerEnterAttachments } from '../../src/client/composer-enter/attachments.ts'
import { context, input, pane, slots } from './fixtures.tsx'

const disposers: Array<() => void> = []
afterEach(() => { for (const stop of disposers.splice(0)) stop() })

function fixture() {
  const registered = slots()
  const preferences = createWorkspaceUiPreferences(localStorage)
  preferences.setItem(COMPOSER_ENTER_KEY, 'newline')
  const blocked = createSnapshotStore<unknown>(undefined)
  const menu = createSnapshotStore({ open: false, groups: [] })
  const arbitrate = vi.fn(() => 'pass' as const), inspectSubmission = vi.fn(() => 'ready' as const)
  const bindings = new Map<string, { ctx: ReturnType<typeof input> }>()
  const ctx = context({ slots: registered.registry, hapiWorkspaceUi: { preferences },
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    sessions: { binding: (id: string) => bindings.get(id) },
    conversation: { input: { for: (editor: ReturnType<typeof input>) => editor.composer }, blocks: { storeFor: () => blocked } },
    inputTriggers: { sessionOf: () => ({ menu, arbitrate }) } })
  Object.assign(ctx, { inject: (_keys: string[], run: (owner: Context) => () => void) => { const dispose = run(ctx); return { dispose } } })
  disposers.push(installComposerEnter(ctx, { inspectSubmission } as unknown as ComposerEnterAttachments), () => preferences.dispose())
  const Seat = registered.component('hapi.composer-enter')
  const officialKeymap = vi.fn()
  const Card = ({ id, editor, navigation }: { id: string; editor: ReturnType<typeof input>; navigation: ReturnType<typeof pane> }) => {
    const props = { sessionId: id, inputActions: editor.actions } as PropsRuntime<'conversation.input.dock'>
    return <WorkspacePaneProvider value={navigation}><div data-composer-card="">
      <div role="textbox" aria-label={id} contentEditable suppressContentEditableWarning data-composer-input="" onKeyDown={officialKeymap}
        ref={element => { if (element) Object.defineProperty(element, 'isContentEditable', { configurable: true, value: true }) }}>Draft {id}</div>
      <Seat {...props}/></div></WorkspacePaneProvider>
  }
  function add(id: string) {
    const editor = input(`Draft ${id}`), navigation = pane(id)
    bindings.set(id, { ctx: editor })
    const element = <Card id={id} editor={editor} navigation={navigation}/>
    return { ...editor, Pane: () => element, navigation, element }
  }
  return { add, blocked, menu, arbitrate, inspectSubmission, officialKeymap }
}

test('keyboard listeners stay on the focused pane and a hidden pane cannot submit', async () => {
  const f = fixture(), left = f.add('Left'), right = f.add('Right'), user = userEvent.setup()
  render(<><left.Pane/><right.Pane/></>)
  await user.click(screen.getByRole('textbox', { name: 'Right' }))
  await user.keyboard('{Control>}{Enter}{/Control}')
  expect(right.actions.submit).toHaveBeenCalledTimes(1)
  expect(left.actions.submit).not.toHaveBeenCalled()
  await act(async () => right.navigation.state.set({ visible: false, focused: false }))
  await user.keyboard('{Control>}{Enter}{/Control}')
  expect(right.actions.submit).toHaveBeenCalledTimes(1)
})

test('Chinese composition confirmation never becomes a send and normal shortcut resumes afterward', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const f = fixture(), current = f.add('Draft')
  render(<current.Pane/>)
  const editor = screen.getByRole('textbox', { name: 'Draft' })
  editor.focus()
  fireEvent.compositionStart(editor)
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
  fireEvent.compositionEnd(editor)
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
  expect(current.actions.submit).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(11))
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
  expect(current.actions.submit).toHaveBeenCalledTimes(1)
})

test('plain Enter reaches native editing without reaching the official submit keymap', async () => {
  const f = fixture(), current = f.add('Draft'), user = userEvent.setup()
  render(<current.Pane/>)
  const editor = screen.getByRole('textbox', { name: 'Draft' })
  await user.click(editor)
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  fireEvent(editor, enter)
  expect(enter.defaultPrevented).toBe(false)
  expect(f.officialKeymap).not.toHaveBeenCalled()
  expect(current.actions.submit).not.toHaveBeenCalled()
  // jsdom cannot prove caret placement or the browser's native beforeinput.
})

test('rerendering the same seat with a new session uses the current input owner', async () => {
  const f = fixture(), first = f.add('First'), second = f.add('Second'), user = userEvent.setup()
  const view = render(first.element)
  const original = screen.getByRole('textbox', { name: 'First' })
  view.rerender(second.element)
  expect(screen.getByRole('textbox', { name: 'Second' })).toBe(original)
  await user.click(screen.getByRole('textbox', { name: 'Second' }))
  await user.keyboard('{Meta>}{Enter}{/Meta}')
  expect(first.actions.submit).not.toHaveBeenCalled()
  expect(second.actions.submit).toHaveBeenCalledTimes(1)
  view.unmount()
  fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true })
  expect(second.actions.submit).toHaveBeenCalledTimes(1)
})
