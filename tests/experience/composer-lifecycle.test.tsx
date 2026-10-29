import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installComposerAutosave } from '../../src/client/composer-autosave-seat.tsx'
import { composerDraftKey, composerRecoveryKey } from '../../src/client/composer-autosave.ts'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import { context, input, pane, slots } from './fixtures.tsx'

function fixture() {
  const registered = slots(), inputs = new Map<string, ReturnType<typeof input>>()
  const ctx = context({ slots: registered.registry, locale: { getSnapshot: () => ({ active: 'en' }) },
    sessions: { binding: (id: string) => inputs.has(id) ? { ctx: inputs.get(id) } : undefined },
    conversation: { input: { for: (value: ReturnType<typeof input>) => value.composer } } })
  const stop = installComposerAutosave(ctx), Seat = registered.component('hapi.composer-autosave')
  function add(id: string, initial = '', sourceId = 'source-a') {
    const editor = input(initial); inputs.set(id, editor)
    const props = { sessionId: id as SessionId, inputActions: editor.actions, useInput: editor.useInput,
      useProjection: (name: string) => name === 'hapi' ? { hubId: 'hub', hapiSessionId: sourceId } : undefined } as PropsRuntime<'conversation.input.dock'>
    const Pane = ({ label }: { label: string }) => <WorkspacePaneProvider value={pane(label)}><Seat {...props}/><editor.Editor label={label}/></WorkspacePaneProvider>
    return { ...editor, Pane }
  }
  return { add, stop, key: composerDraftKey('fixture-host', 'unused', { hubId: 'hub', hapiSessionId: 'source-a' }) }
}

test('typed Chinese draft survives close and a new display generation without being sent', async () => {
  const f = fixture(), first = f.add('hapi-codex-first'), user = userEvent.setup()
  const view = render(<StrictMode><first.Pane label="First draft"/></StrictMode>)
  await user.type(screen.getByRole('textbox', { name: 'First draft' }), '中文草稿，还没发送')
  view.unmount()
  const next = f.add('hapi-codex-next')
  render(<StrictMode><next.Pane label="Restored draft"/></StrictMode>)
  expect(screen.getByRole('textbox', { name: 'Restored draft' })).toHaveValue('中文草稿，还没发送')
  expect(first.actions.submit).not.toHaveBeenCalled(); expect(next.actions.submit).not.toHaveBeenCalled()
  f.stop()
})

test('closing a duplicate pane keeps autosave subscribed to the surviving input', async () => {
  const f = fixture(), shared = f.add('hapi-codex-shared'), user = userEvent.setup()
  const view = render(<><shared.Pane key="left" label="Left draft"/><shared.Pane key="right" label="Right draft"/></>)
  await user.type(screen.getByRole('textbox', { name: 'Left draft' }), 'before close')
  view.rerender(<shared.Pane key="right" label="Right draft"/>)
  await user.type(screen.getByRole('textbox', { name: 'Right draft' }), ' then continued')
  view.unmount()
  const next = f.add('hapi-codex-reopened')
  render(<next.Pane label="Recovered"/>)
  expect(screen.getByRole('textbox', { name: 'Recovered' })).toHaveValue('before close then continued')
  f.stop()
})

test('a different source never inherits another source draft', async () => {
  const f = fixture(), first = f.add('hapi-codex-a'), user = userEvent.setup()
  const view = render(<first.Pane label="A"/>)
  await user.type(screen.getByRole('textbox', { name: 'A' }), 'Only for source A')
  view.unmount()
  const second = f.add('hapi-codex-b', '', 'source-b')
  render(<second.Pane label="B"/>)
  expect(screen.getByRole('textbox', { name: 'B' })).toHaveValue('')
  f.stop()
})

test('a conflicting saved draft is offered for explicit recovery and cannot be appended during submission', async () => {
  const f = fixture(), user = userEvent.setup()
  localStorage.setItem(f.key, JSON.stringify({ version: 1, draft: { text: 'Saved draft', references: [] } }))
  const current = f.add('hapi-codex-current', 'Current draft')
  render(<current.Pane label="Current"/>)
  expect(screen.getByRole('textbox', { name: 'Current' })).toHaveValue('Current draft')
  await user.click(screen.getByText('Recover another unsent draft'))
  await act(async () => current.composer.state.set({ ...current.composer.state.getSnapshot(), phase: 'submitting' }))
  expect(screen.getByRole('button', { name: 'Append to current draft' })).toBeDisabled()
  await act(async () => current.composer.state.set({ ...current.composer.state.getSnapshot(), phase: 'plain' }))
  await user.click(screen.getByRole('button', { name: 'Append to current draft' }))
  expect(screen.getByRole('textbox', { name: 'Current' })).toHaveValue('Current draft\n\nSaved draft')
  expect(localStorage.getItem(composerRecoveryKey(f.key))).toBe('[]')
  expect(current.actions.submit).not.toHaveBeenCalled()
  f.stop()
})

test('storage quota failure reports an error while preserving typed text', async () => {
  const f = fixture(), current = f.add('hapi-codex-current'), user = userEvent.setup()
  render(<current.Pane label="Draft"/>)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })
  await user.type(screen.getByRole('textbox', { name: 'Draft' }), 'Keep this locally')
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this locally')
  expect(current.composer.notify).toHaveBeenCalledWith('error', expect.stringContaining('Quota exceeded'))
  expect(current.actions.submit).not.toHaveBeenCalled()
  f.stop()
})
