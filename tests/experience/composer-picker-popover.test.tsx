import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SourceControls, type InputProps } from '../../src/client/composer-picker/index.tsx'
import type { PickerData } from '../../src/client/composer-picker/data.ts'

// Only the unavailable jsdom browser APIs/layout are fixtures. The production
// controls, retained subtree, focus, state and source callbacks run unchanged.
const restore: Array<() => void> = []
afterEach(() => { cleanup(); vi.restoreAllMocks(); for (const stop of restore.splice(0).reverse()) stop() })
function nativeBrowser(anchor = true) {
  const open = new Set<HTMLElement>(), proto = HTMLElement.prototype
  for (const name of ['popover', 'showPopover', 'hidePopover'] as const) {
    const before = Object.getOwnPropertyDescriptor(proto, name)
    Object.defineProperty(proto, name, { configurable: true, value: name === 'popover' ? null : function (this: HTMLElement) {
      const showing = name === 'showPopover'
      if (showing) for (const other of open) if (other !== this) other.hidePopover()
      if (showing) open.add(this); else open.delete(this)
      // jsdom's UA stylesheet hides [popover] but cannot render its top layer.
      this.style.display = showing ? 'block' : 'none'
      const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: showing ? 'open' : 'closed' })
      this.dispatchEvent(event)
    } })
    restore.push(() => { if (before) Object.defineProperty(proto, name, before); else Reflect.deleteProperty(proto, name) })
  }
  const matches = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? open.has(this as HTMLElement) : matches.call(this, selector) })
  vi.stubGlobal('CSS', { supports: () => anchor })
}
function bounds() {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return new DOMRect(40, this.matches('.hapi-pane') ? 50 : 740, 700, this.matches('.hapi-pane') ? 760 : 44)
  })
}
const data: PickerData = {
  model: 'first', models: [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }],
  effort: 'medium', efforts: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }],
  permission: ':read-only', permissions: [':read-only', ':workspace'], serviceTier: null, fast: false,
  editable: { model: true, effort: true, permission: true, fast: true }, warnings: [], fastAvailable: true, readOnly: false,
}
function seat(id: string, apply = vi.fn(async () => true)) {
  let state = { focused: true, visible: true }; const listeners = new Set<() => void>()
  const pane = { paneId: id, state: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } } }
  const ctx = { get: (key: string) => key === 'hapiWorkspacePane' ? pane : undefined,
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} } } as unknown as Context
  const props = { sessionId: id, sessionBinding: { session: { metadata: { getSnapshot: () => ({ capabilities: {} }) } } }, useInput: () => false, useSession: () => false, renderSlot: () => null } as unknown as InputProps
  return { apply, hide: () => { state = { ...state, visible: false }; for (const listener of listeners) listener() },
    ui: <section className="hapi-pane" aria-label={id}><textarea aria-label={`${id} draft`} defaultValue={`Unsent ${id}`}/>
      <SourceControls ctx={ctx} props={props} initial={{ model: 'First', effort: 'medium', permission: ':read-only', serviceTier: null }}
        permissionCapable data={data} loading={false} busy={false} pending={null} error={null} sourceLocked={false}
        refresh={async () => {}} apply={apply} actionsContent={<input aria-label={`${id} parked draft`} defaultValue="Keep attachment note"/>}/>
    </section> }
}

test('native popover dismisses, reopens and returns Escape focus without measuring normal anchor scrolling', async () => {
  nativeBrowser(); const geometry = bounds(), f = seat('A'), user = userEvent.setup(); render(f.ui)
  const trigger = screen.getByRole('button', { name: 'First' })
  await user.click(trigger)
  const panel = screen.getByRole('dialog', { name: 'Choose model' })
  expect(panel).toHaveAttribute('popover', 'auto'); expect(panel).toHaveAttribute('data-picker-positioning', 'anchor')
  expect(screen.getByRole('radio', { name: 'First' })).toHaveFocus()
  const measured = geometry.mock.calls.length
  fireEvent.scroll(window); fireEvent.resize(window)
  expect(geometry.mock.calls.length).toBe(measured)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Choose model' })).not.toBeInTheDocument(); expect(trigger).toHaveFocus()
  await user.click(trigger)
  act(() => { screen.getByRole('dialog', { name: 'Choose model' }).hidePopover() })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await user.click(trigger)
  expect(screen.getByRole('dialog', { name: 'Choose model' })).toBeVisible()
  await user.click(trigger)
  expect(screen.queryByRole('dialog', { name: 'Choose model' })).not.toBeInTheDocument()
})

test('changing Pane closes its old popover, keeps both drafts and sends a selection only to its owner', async () => {
  nativeBrowser(); bounds(); const a = seat('A'), b = seat('B'), user = userEvent.setup(); render(<>{a.ui}{b.ui}</>)
  const panes = { a: within(screen.getByRole('region', { name: 'A' })), b: within(screen.getByRole('region', { name: 'B' })) }
  const draftA = panes.a.getByRole('textbox', { name: 'A draft' }), draftB = panes.b.getByRole('textbox', { name: 'B draft' })
  await user.click(panes.a.getByRole('button', { name: 'More input controls' }))
  const parked = screen.getByRole('textbox', { name: 'A parked draft' }); await user.type(parked, ' unsaved')
  await user.keyboard('{Escape}')
  await user.click(panes.a.getByRole('button', { name: 'More input controls' }))
  expect(screen.getByRole('textbox', { name: 'A parked draft' })).toBe(parked); expect(parked).toHaveValue('Keep attachment note unsaved')
  await user.click(panes.b.getByRole('button', { name: 'First' }))
  expect(panes.a.getByRole('button', { name: 'More input controls' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('dialog', { name: 'Choose model' })).toHaveAttribute('data-picker-session', 'B')
  await user.click(screen.getByRole('radio', { name: 'Second' }))
  expect(b.apply).toHaveBeenCalledExactlyOnceWith({ kind: 'model', value: 'second' }); expect(a.apply).not.toHaveBeenCalled()
  expect(draftA).toHaveValue('Unsent A'); expect(draftB).toHaveValue('Unsent B')
  await user.click(panes.b.getByRole('button', { name: /Session permissions/ }))
  act(b.hide)
  expect(screen.queryByRole('dialog', { name: 'Permissions' })).not.toBeInTheDocument()
})

test('native popover keeps measured placement in a reduced visual viewport and preserves permission/Fast semantics', async () => {
  nativeBrowser(); bounds()
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 600, height: 400, offsetLeft: 0, offsetTop: 0 }))
  const f = seat('A'), user = userEvent.setup(); render(f.ui)
  await user.click(screen.getByRole('button', { name: /Session permissions/ }))
  const panel = screen.getByRole('dialog', { name: 'Permissions' })
  expect(panel).toHaveAttribute('popover', 'auto'); expect(panel).toHaveAttribute('data-picker-positioning', 'geometry')
  await user.click(screen.getByRole('radio', { name: 'Workspace access' }))
  expect(f.apply).toHaveBeenCalledExactlyOnceWith({ kind: 'permission', value: ':workspace' })
  await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', { name: /Reasoning effort/ }))
  await user.click(screen.getByRole('switch', { name: 'Fast mode' }))
  expect(f.apply).toHaveBeenLastCalledWith({ kind: 'fast', value: true })
})

test('interleaved popovers in the same Pane release only their own anchors', async () => {
  nativeBrowser(); bounds(); const a = seat('A'), b = seat('B')
  const view = render(<section className="hapi-pane">{a.ui.props.children}{b.ui.props.children}</section>)
  const triggers = screen.getAllByRole('button', { name: 'First' }), pane = view.container.firstElementChild as HTMLElement
  pane.style.setProperty('anchor-name', '--existing-host-anchor')
  fireEvent.click(triggers[0]!)
  // Unlike user-event, this preserves focus so native auto-dismiss and React's
  // lifecycle release A after B has already contributed its Pane anchor.
  fireEvent.click(triggers[1]!)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(pane.style.getPropertyValue('anchor-name')).toBe('--existing-host-anchor')
  expect(triggers[0]!.style.getPropertyValue('anchor-name')).toBe('')
  expect(triggers[1]!.style.getPropertyValue('anchor-name')).toBe('')
})

test('browsers without native popover keep outside dismissal, Escape return and the original draft', async () => {
  bounds(); const f = seat('A'), user = userEvent.setup(); render(f.ui)
  const trigger = screen.getByRole('button', { name: 'First' }), draft = screen.getByRole('textbox', { name: 'A draft' })
  await user.click(trigger)
  expect(screen.getByRole('dialog', { name: 'Choose model' })).not.toHaveAttribute('popover')
  await user.click(draft); expect(screen.queryByRole('dialog', { name: 'Choose model' })).not.toBeInTheDocument()
  await user.click(trigger); await user.keyboard('{Escape}')
  expect(trigger).toHaveFocus(); expect(draft).toHaveValue('Unsent A')
})
