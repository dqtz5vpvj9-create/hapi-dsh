import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installComposerAutosave } from '../../src/client/composer-autosave-seat.tsx'
import { accountComposerDraftKey, composerRecoveryKey } from '../../src/client/composer-autosave.ts'
import { WorkspaceApplicationIdentity } from '../../src/client/application-identity.ts'
import { createWorkspaceUpdatePreparations } from '../../src/client/update-preparation.ts'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import { context, input, pane, slots } from './fixtures.tsx'

function fixture(authenticated = true) {
  const registered = slots(), inputs = new Map<string, ReturnType<typeof input>>()
  const updates = createWorkspaceUpdatePreparations()
  const application = new WorkspaceApplicationIdentity()
  if (authenticated) application.set({ accountId: 'one', origin: 'https://experience.invalid' }, 'device')
  const ctx = context({ get: (name: string) => name === 'hapiWorkspaceUi' ? { updates } : undefined,
    slots: registered.registry, locale: { getSnapshot: () => ({ active: 'en' }) },
    sessions: { binding: (id: string) => inputs.has(id) ? { ctx: inputs.get(id) } : undefined },
    conversation: { input: { for: (value: ReturnType<typeof input>) => value.composer } } })
  const stop = installComposerAutosave(ctx, application), Seat = registered.component('hapi.composer-autosave')
  function add(id: string, initial = '', sourceId = 'source-a') {
    const sessionId = `dsh-${sourceId}`
    const editor = input(initial); inputs.set(sessionId, editor)
    const props = { sessionId: sessionId as SessionId, inputActions: editor.actions, useInput: editor.useInput } as PropsRuntime<'conversation.input.dock'>
    const Pane = ({ label }: { label: string }) => <WorkspacePaneProvider value={pane(label)}><Seat {...props}/><editor.Editor label={label}/></WorkspacePaneProvider>
    return { ...editor, Pane }
  }
  return { add, stop: () => { stop(); updates.dispose() }, application, updates,
    key: accountComposerDraftKey(application.getSnapshot()?.scope ?? 'unknown', 'fixture-host', 'dsh-source-a') }
}

test('typed Chinese draft survives close and a new Pane binding without being sent', async () => {
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

test('an unknown account never recovers an unscoped draft and keeps the original copy', () => {
  const original = JSON.stringify({ version: 1, draft: { text: 'Private old draft', references: [] } })
  localStorage.setItem('hapi-dsh:composer-draft:v1:["dsh","fixture-host","dsh-source-a"]', original)
  const f = fixture(false), current = f.add('unknown')
  render(<current.Pane label="Unknown account"/>)
  expect(screen.getByRole('textbox', { name: 'Unknown account' })).toHaveValue('')
  expect(localStorage.length).toBe(1); expect(localStorage.getItem(localStorage.key(0)!)).toBe(original)
  f.stop()
})

test('the same source under another account cannot recover the first account draft', async () => {
  const f = fixture(), first = f.add('first'), user = userEvent.setup()
  const view = render(<first.Pane label="Account one"/>)
  await user.type(screen.getByRole('textbox', { name: 'Account one' }), 'Private account one')
  view.unmount()
  f.application.set({ accountId: 'two', origin: 'https://experience.invalid' }, 'device')
  const second = f.add('second')
  const next = render(<second.Pane label="Account two"/>)
  expect(screen.getByRole('textbox', { name: 'Account two' })).toHaveValue('')
  expect(JSON.parse(localStorage.getItem(f.key)!).draft.text).toBe('Private account one')
  next.unmount()
  f.application.set({ accountId: 'one', origin: 'https://experience.invalid' }, 'device')
  const original = f.add('restored')
  render(<original.Pane label="Original account"/>)
  expect(screen.getByRole('textbox', { name: 'Original account' })).toHaveValue('Private account one')
  f.stop()
})

test('changing accounts retires late autosaves from the original input', async () => {
  const f = fixture(), first = f.add('first'), user = userEvent.setup()
  const view = render(<first.Pane label="Original input"/>)
  await user.type(screen.getByRole('textbox', { name: 'Original input' }), 'Original private bytes')
  await act(async () => f.application.set({ accountId: 'two', origin: 'https://experience.invalid' }, 'device'))
  await user.type(screen.getByRole('textbox', { name: 'Original input' }), ' late')
  view.unmount()
  const newKey = accountComposerDraftKey(f.application.getSnapshot()!.scope, 'fixture-host', 'dsh-source-a')
  expect(localStorage.getItem(newKey)).toBeNull()
  expect(JSON.parse(localStorage.getItem(f.key)!).draft.text).toBe('Original private bytes')
  expect(first.composer.notify).toHaveBeenCalledWith('error', expect.stringContaining('earlier authenticated draft'))
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

test('the installed autosave participant rejects an unsaved checkpoint and retries the original draft after storage recovers', async () => {
  const f = fixture(), current = f.add('checkpoint'), user = userEvent.setup()
  render(<current.Pane label="Checkpoint draft"/>)
  const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Draft quota', 'QuotaExceededError') })
  await user.type(screen.getByRole('textbox', { name: 'Checkpoint draft' }), 'Retained checkpoint text')
  await expect(f.updates.checkpoint()).rejects.toThrow(/Message drafts: .*Draft quota/)
  expect(screen.getByRole('textbox', { name: 'Checkpoint draft' })).toHaveValue('Retained checkpoint text')
  failure.mockRestore(); await f.updates.checkpoint()
  expect(JSON.parse(localStorage.getItem(f.key)!).draft.text).toBe('Retained checkpoint text')
  expect(current.actions.submit).not.toHaveBeenCalled(); f.stop()
})

test('an unknown account cannot update away a live unsaved input while its original text remains in the editor', async () => {
  const f = fixture(false), current = f.add('unassigned'), user = userEvent.setup()
  render(<current.Pane label="Unassigned draft"/>)
  await user.type(screen.getByRole('textbox', { name: 'Unassigned draft' }), 'Keep until account is ready')
  await expect(f.updates.checkpoint()).rejects.toThrow(/Draft account is unavailable/)
  expect(screen.getByRole('textbox', { name: 'Unassigned draft' })).toHaveValue('Keep until account is ready')
  expect(localStorage.length).toBe(0); f.stop()
})
