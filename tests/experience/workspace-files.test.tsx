/** Production Files accessories/editor/state; remote workspace and browser modal/storage are explicit boundaries. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentProps } from 'react'
import type { NativeDocumentJournal } from '../../src/client/native-document-journal.ts'
import { discardSourceDocumentDraft } from '../../src/client/workbench-drafts.ts'
import { SourceActions, SourceTools } from '../../src/client/source-file-actions.tsx'
import { createSourceFileMutations } from '../../src/client/source-file-mutation-journal.ts'
import { createWorkspaceUpdatePreparations } from '../../src/client/update-preparation.ts'
import type { SourceFileClient, SourceFileContext } from '../../src/client/source-workspace-provider.ts'
import { SourceFileLocksFixture, SourceFileStorageFixture } from '../source-file-mutation-fixture.ts'
import { documentJournalFixture, fileContext, fileOwner } from '../source-file-context-fixture.ts'

// Syntax highlighting is a presentation boundary; the textarea and all lifecycle logic are production.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre> }))
beforeEach(() => {
  const prototype = HTMLDialogElement.prototype
  const show = Object.getOwnPropertyDescriptor(prototype, 'showModal'), close = Object.getOwnPropertyDescriptor(prototype, 'close')
  Object.defineProperty(prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false } })
  onTestFinished(() => {
    if (show) Object.defineProperty(prototype, 'showModal', show); else Reflect.deleteProperty(prototype, 'showModal')
    if (close) Object.defineProperty(prototype, 'close', close); else Reflect.deleteProperty(prototype, 'close')
  })
})
const locale = { active: 'en' }, t = (key: string) => key
function fixture(context = fileContext(), client: SourceFileClient = { resolve: async () => context }, writable = true, documentJournal: NativeDocumentJournal = documentJournalFixture()) {
  const storage = new SourceFileStorageFixture(), journal = createSourceFileMutations({ storage, locks: new SourceFileLocksFixture(), channel: null })
  const actions = new SourceActions(client, t, journal, documentJournal)
  let sessionId = context.owner.binding.target.sessionId
  const ctx = { get: () => undefined, locale: { subscribe: () => () => {}, getSnapshot: () => locale },
    sidebarRight: { mounted: { getSnapshot: () => sessionId }, openResource: vi.fn() } } as unknown as Context
  const props = () => ({ absolutePath: '/source/file.txt', sessionId, useAccess: () => writable }) as ComponentProps<typeof SourceTools>['props']
  const view = render(<SourceTools ctx={ctx} actions={actions} props={props()} directory={false} t={t}/> )
  onTestFinished(() => { view.unmount(); actions.dispose(); journal.dispose() })
  return { context, actions, storage, ...view, switchTo(next: string) { sessionId = next; view.rerender(<SourceTools ctx={ctx} actions={actions} props={props()} directory={false} t={t}/> ) } }
}

test('read-only source tools expose reading but disable every file mutation', async () => {
  const context = fileContext(), { mutations: _omitted, ...readonly } = context.services
  const f = fixture({ ...context, services: readonly }), user = userEvent.setup()
  expect(await screen.findByRole('button', { name: 'edit' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'tools' }))
  expect(await screen.findByText('readOnly')).toBeVisible()
  expect(screen.getByRole('button', { name: 'execute' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'upload' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'search' })).toBeEnabled()
  expect(f.actions.edits.size).toBe(0)
})

test('ordinary DSH Files keep their native tools without resolving an HHPI workspace', () => {
  const context = fileContext(); context.owner.binding.target.sessionId = 'ordinary-dsh'
  const resolve = vi.fn(async () => { throw new Error('Ordinary Files must stay on the official DSH owner') })
  const view = fixture(context, { resolve })
  expect(view.container).toBeEmptyDOMElement(); expect(resolve).not.toHaveBeenCalled()
})

test('a late workspace resolution cannot reopen tools or send to a previous source session', async () => {
  const first = fileContext(), second = fileContext(fileOwner()), pending = Promise.withResolvers<SourceFileContext>(), signals: AbortSignal[] = []
  const secondRead = vi.fn(second.services.documents.open)
  second.services.documents.open = secondRead
  const client = { resolve: vi.fn((id: string, signal: AbortSignal) => { signals.push(signal); return id === first.owner.binding.target.sessionId ? pending.promise : Promise.resolve(second) }) }
  const f = fixture(first, client); f.switchTo(second.owner.binding.target.sessionId)
  await waitFor(() => expect(screen.getByRole('button', { name: 'edit' })).toBeEnabled())
  expect(signals[0]?.aborted).toBe(true)
  await act(async () => pending.resolve(first))
  await userEvent.click(screen.getByRole('button', { name: 'edit' }))
  expect(await screen.findByRole('textbox', { name: 'content' })).toHaveValue('original')
  expect(secondRead).toHaveBeenCalledOnce()
  expect([...f.actions.edits.values()][0]?.context.owner.binding.target).toEqual(second.owner.binding.target)
})

test('typing during a pending source save keeps the newer visible draft and never sends it implicitly', async () => {
  const context = fileContext(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>()
  const save = vi.fn(async (request: Parameters<NonNullable<typeof context.services.mutations>['save']>[0]) => {
    entered.resolve(); await reply.promise
    return { status: 'applied' as const, operationId: request.operationId, value: { absolutePath: '/source/file.txt', version: 'source:next', bytes: 10 } }
  })
  context.services.mutations!.save = save
  fixture(context); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'edit' }))
  const input = await screen.findByRole('textbox', { name: 'content' })
  await user.clear(input); await user.type(input, 'submitted draft')
  await user.click(screen.getByRole('button', { name: 'save' })); await entered.promise
  expect(screen.getByRole('button', { name: 'save' })).toBeDisabled()
  await user.clear(input); await user.type(input, 'later unsaved draft')
  await act(async () => reply.resolve())
  expect(input).toHaveValue('later unsaved draft')
  expect(screen.getByRole('button', { name: 'save' })).toBeEnabled()
  expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]?.[0].text).toBe('submitted draft')
})


test('closing and reopening a retained dirty editor restores its text and selection without a source save', async () => {
  const f = fixture(), user = userEvent.setup(), save = vi.spyOn(f.context.services.mutations!, 'save')
  await user.click(await screen.findByRole('button', { name: 'edit' }))
  const input = await screen.findByRole('textbox', { name: 'content' }) as HTMLTextAreaElement
  await user.clear(input); await user.type(input, 'retained cursor draft')
  input.setSelectionRange(2, 9, 'backward'); fireEvent.select(input)
  const editor = [...f.actions.edits.values()][0]!; await act(async () => editor.checkpoint())
  expect(f.actions.beforeClose()).toBe(true)
  await user.click(screen.getAllByRole('button', { name: 'close' }).at(-1)!)
  await user.click(screen.getByRole('button', { name: 'edit' }))
  const reopened = await screen.findByRole('textbox', { name: 'content' }) as HTMLTextAreaElement
  expect(reopened).toHaveValue('retained cursor draft'); expect(reopened.selectionStart).toBe(2); expect(reopened.selectionEnd).toBe(9)
  expect(reopened.selectionDirection).toBe('backward'); expect(save).not.toHaveBeenCalled()
})

test('refreshing a dirty editor restores durable text and cursor after memory and view disposal', async () => {
  const context = fileContext(), journal = documentJournalFixture(), user = userEvent.setup()
  const first = fixture(context, undefined, true, journal)
  await user.click(await screen.findByRole('button', { name: 'edit' }))
  const input = await screen.findByRole('textbox', { name: 'content' }) as HTMLTextAreaElement
  await user.clear(input); await user.type(input, 'durable refresh draft')
  input.setSelectionRange(3, 8, 'forward'); fireEvent.select(input)
  await act(async () => first.actions.prepareReload()); expect(first.actions.preparedForReload).toBe(true)
  first.unmount(); first.actions.dispose(); discardSourceDocumentDraft(context.owner, { kind: 'file', path: '/source/file.txt' })
  fixture(context, undefined, true, journal)
  await user.click(await screen.findByRole('button', { name: 'edit' }))
  const restored = await screen.findByRole('textbox', { name: 'content' }) as HTMLTextAreaElement
  expect(restored).toHaveValue('durable refresh draft'); expect(restored.selectionStart).toBe(3); expect(restored.selectionEnd).toBe(8)
})

test('updating waits for document storage without mistaking its completion for another edit', async () => {
  const journal = documentJournalFixture(), write = journal.write
  let release!: () => void
  const durable = new Promise<void>(resolve => { release = resolve })
  const writeStarted = vi.fn()
  journal.write = async (...args) => { writeStarted(); await durable; return write(...args) }
  const f = fixture(fileContext(), undefined, true, journal)
  await userEvent.click(await screen.findByRole('button', { name: 'edit' }))
  const input = await screen.findByRole('textbox', { name: 'content' })
  fireEvent.change(input, { target: { value: 'keep this edit through update' } })
  await waitFor(() => expect(writeStarted).toHaveBeenCalled())
  const updates = createWorkspaceUpdatePreparations()
  onTestFinished(() => updates.dispose())
  updates.registerCheckpoint({ kind: 'document', label: 'Source file editors',
    revision: f.actions.getCheckpointRevision, current: () => true, save: () => f.actions.prepareReload() })
  let complete = false
  const pending = updates.checkpoint().then(() => { complete = true })
  await act(async () => { await Promise.resolve() })
  expect(complete).toBe(false)
  await act(async () => { release(); await pending })
  expect(complete).toBe(true)
  expect(input).toHaveValue('keep this edit through update')
  expect(f.actions.preparedForReload).toBe(true)
})

test('a durable unknown file operation releases its view and reopening only inspects the original receipt', async () => {
  const f = fixture(), manage = vi.fn(async () => { throw new Error('Lost source reply') }), receipt = vi.fn(async (_operationId: string) => null)
  f.context.services.mutations!.manage = manage; f.context.services.mutations!.receipt = receipt
  await waitFor(() => expect(screen.getByRole('button', { name: 'edit' })).toBeEnabled())
  const operation = f.actions.mutation(f.context)
  await act(async () => { await operation.manage({ action: 'create-file', path: '/source/new' }) })
  const id = operation.getSnapshot().operationId
  expect(operation.getSnapshot().uncertain).toBe(true); expect(f.actions.beforeClose()).toBe(true)
  await act(async () => f.actions.prepareReload()); expect(f.actions.preparedForReload).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: 'recover' }))
  await userEvent.click(screen.getByRole('button', { name: 'inspect' }))
  expect(receipt).toHaveBeenCalledOnce(); expect(receipt.mock.calls[0]?.[0]).toBe(id); expect(manage).toHaveBeenCalledOnce()
})


test('failed browser persistence keeps the editor visible and prevents close and reload', async () => {
  const context = fileContext(), journal = documentJournalFixture(), user = userEvent.setup()
  journal.write = async () => { throw new Error('Storage quota denied') }
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
  const f = fixture(context, undefined, true, journal)
  await user.click(await screen.findByRole('button', { name: 'edit' }))
  const input = await screen.findByRole('textbox', { name: 'content' })
  await user.clear(input); await user.type(input, 'do not lose this draft')
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Storage quota denied'))
  expect(f.actions.beforeClose()).toBe(false); expect(alert).toHaveBeenCalledOnce()
  await expect(f.actions.prepareReload()).rejects.toThrow('Storage quota denied')
  expect(input).toHaveValue('do not lose this draft'); expect(f.actions.preparedForReload).toBe(false)
})

test('two editor views keep their own dirty text and selections when their browser drafts conflict', async () => {
  const context = fileContext(), journal = documentJournalFixture(), first = fixture(context, undefined, true, journal), user = userEvent.setup()
  await user.click(await within(first.container).findByRole('button', { name: 'edit' }))
  const inputA = await within(first.container).findByRole('textbox', { name: 'content' }) as HTMLTextAreaElement
  await user.clear(inputA); await user.type(inputA, 'first view draft')
  inputA.setSelectionRange(1, 4, 'backward'); fireEvent.select(inputA)
  await act(async () => [...first.actions.edits.values()][0]!.checkpoint())
  const second = fixture(context, undefined, true, journal)
  await user.click(await within(second.container).findByRole('button', { name: 'edit' }))
  const inputB = await within(second.container).findByRole('textbox', { name: 'content' }) as HTMLTextAreaElement
  await user.clear(inputB); await user.type(inputB, 'second view draft')
  inputB.setSelectionRange(5, 8, 'forward'); fireEvent.select(inputB)
  await act(async () => [...second.actions.edits.values()][0]!.checkpoint())
  // The first editor cannot overwrite the second view's retained revision.
  await user.type(inputA, ' changed')
  await waitFor(() => expect(within(first.container).getByRole('alert')).toHaveTextContent('newer draft'))
  expect(inputA).toHaveValue('first view draft changed'); expect(inputB).toHaveValue('second view draft')
  expect(inputB.selectionStart).toBe(5); expect(inputB.selectionEnd).toBe(8)
  expect([...first.actions.edits.values()][0]!.getSnapshot().text).not.toBe([...second.actions.edits.values()][0]!.getSnapshot().text)
})
