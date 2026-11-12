/** Actual Recovery, bridge and upload provider. IndexedDB transactions, native
 * input actions and source RPC are controlled boundaries; no browser durability claim. */
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { useState, type ComponentType } from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ComposerAttachment, ComposerAttachmentsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FileUploadProvider } from '@deepseek-ai/dsh-client-file-upload/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceServices, WorkspaceUploadService } from '../../src/workspace/service-types.ts'
import { installSourceComposerBridge } from '../../src/client/source-composer.tsx'
import { installComposerAttachmentRecovery } from '../../src/client/composer-attachment-recovery.tsx'
import { installRemoteFileUpload } from '../../src/client/remote-file-upload.ts'
import { WorkspaceApplicationIdentity } from '../../src/client/application-identity.ts'
import { accountComposerDraftKey } from '../../src/client/composer-autosave.ts'
import { createWorkspaceUpdatePreparations } from '../../src/client/update-preparation.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import { input, pane } from './fixtures.tsx'

/** Minimal asynchronous IndexedDB boundary with manually releasable commit. */
function databaseBoundary() {
  const records = new Map<string, unknown>(), pending: Array<() => void> = [], reads: string[] = [], writes: string[] = []
  let hold = true
  const database = { close() {}, transaction(_name: string, mode?: string) {
    const staged = new Map<string, unknown>()
    let aborted = false
    const transaction = { oncomplete: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined,
      abort() { aborted = true; queueMicrotask(() => transaction.onabort?.()) }, objectStore() { return {
        get(key: string) {
          const request = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined }
          queueMicrotask(() => {
            reads.push(key); request.result = structuredClone(records.get(key)); request.onsuccess?.()
            if (mode === 'readwrite' && !aborted) {
              const commit = () => { if (!aborted) { for (const [key, value] of staged) records.set(key, structuredClone(value)); transaction.oncomplete?.() } }
              if (hold) pending.push(commit); else queueMicrotask(commit)
            }
          })
          return request
        },
        put(value: unknown, key: string) { writes.push(key); staged.set(key, value) },
      } },
    }
    return transaction
  } }
  const indexedDB = { open() {
    const request = { result: database, onsuccess: undefined as (() => void) | undefined }
    queueMicrotask(() => request.onsuccess?.()); return request
  } }
  return { indexedDB, records, reads, writes, pending, release() { hold = false; for (const commit of pending.splice(0)) commit() } }
}

test('prepared bytes commit with their original draft before begin, survive refresh, and stay private to the authenticated account', async () => {
  vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile)
  const database = databaseBoundary(); vi.stubGlobal('indexedDB', database.indexedDB)
  const application = new WorkspaceApplicationIdentity(); application.set({ accountId: 'one', origin: 'https://experience.invalid' }, 'device')
  const sourceCatalog = createSnapshotStore(0)
  let sourceScope = 'native-one', sourceLifetime = new AbortController()
  const sourceAuthority = { list: sourceCatalog, captureWorkspaceAccess() {
    const generation = sourceLifetime, scope = sourceScope
    return { scope, signal: generation.signal, assertCurrent() { generation.signal.throwIfAborted(); if (generation !== sourceLifetime) throw new Error('Native account replaced') } }
  } }
  const replaceSourceAccount = (scope: string) => { sourceLifetime.abort(); sourceScope = scope; sourceLifetime = new AbortController(); sourceCatalog.set(sourceCatalog.getSnapshot() + 1) }
  const sessionId = 'hhpi:machine:source:codex:thread' as SessionId
  const binding = { target: { hostId: 'fixture-host', sessionId }, machineId: 'machine', workspaceId: 'source', root: '/source', pathStyle: 'posix' as const }
  let transfer: Awaited<ReturnType<WorkspaceUploadService['begin']>> | undefined
  let finished: Awaited<ReturnType<WorkspaceUploadService['finish']>> | undefined
  const operations: string[] = [], uploaded: Uint8Array[] = []
  let rejectNewUpload = false
  const newUploadReply = Promise.withResolvers<void>()
  let publications = 0
  const uploads: WorkspaceUploadService = {
    async begin(request) {
      operations.push(request.operationId)
      if (rejectNewUpload && request.operationId !== transfer?.operationId) { await newUploadReply.promise; throw new Error('New upload reached the source boundary') }
      return transfer ??= { ...request, uploadId: 'transfer', receivedBytes: 0, chunkBytes: 1024, maxBytes: 64 * 1024 * 1024 }
    },
    async status() { return finished ? { state: 'finished', result: finished } : { state: 'uploading', transfer: transfer! } },
    async append(request) { uploaded.push(request.data); transfer = { ...transfer!, receivedBytes: transfer!.receivedBytes + request.data.length }; return { receivedBytes: transfer.receivedBytes } },
    async finish() { publications++; return finished = { status: 'applied', operationId: transfer!.operationId, value: { kind: 'attachment',
      resource: { target: binding.target, document: { kind: 'artifact', id: 'receipt' } },
      value: { receiptId: 'receipt' as never, file: { attachmentId: 'stored' as never, name: 'original.txt', bytes: transfer!.bytes } } } } },
    async cancel() { return { state: 'cancelled' } },
  }
  const native = { options: {}, component: () => null }
  const dock = new Map<string, ComponentType<PropsRuntime<'conversation.input.dock'>>>()
  let Attachments!: ComponentType<ComposerAttachmentsProps>, provider!: FileUploadProvider
  let editor = input('Original unsent text'), currentBinding: object
  const sessionListeners = new Set<() => void>(), eventListeners = new Set<() => void>()
  const sessionSnapshot = { pendingSubmissions: [] }
  const session = { getSnapshot: () => sessionSnapshot, subscribe(callback: () => void) { sessionListeners.add(callback); return () => sessionListeners.delete(callback) }, projections: { faceOf: () => ({ getSnapshot: () => undefined }) } }
  const bind = () => { currentBinding = { sessionId, ctx: editor, session, eventSource: { getSnapshot: () => ({ entries: [] }),
    subscribe(callback: () => void) { eventListeners.add(callback); return () => eventListeners.delete(callback) } } } }; bind()
  const updates = createWorkspaceUpdatePreparations(), services = new Map<string, unknown>()
  const ctx = { locale: { getSnapshot: () => ({ active: 'en' }) },
    get(name: string) { return name === 'hhpiSessions' ? sourceAuthority : services.get(name) },
    inject(_dependencies: unknown, apply: (ctx: Context) => () => void) { const stop = apply(ctx); return { dispose: async () => stop() } },
    reflect: { provide(name: string, service: unknown) { services.set(name, service); return () => { services.delete(name) } } },
    sessions: { binding: () => currentBinding, ownsBinding: (value: object) => value === currentBinding },
    conversation: { input: { for: () => editor.composer } }, hapiWorkspaceUi: { updates, application },
    fileUpload: { registerProvider(value: FileUploadProvider) { provider = value; return () => {} } },
    slots: { entries: () => [native], subscribe: () => () => {}, inject(_name: string, register: () => () => void) { return register() },
      register(options: { name: string; id: string }, component: ComponentType<PropsRuntime<'conversation.input.dock'>>) {
        if (options.name === 'conversation.input.attachments') Attachments = component as unknown as typeof Attachments
        else dock.set(options.id, component)
        return () => {}
      } },
  } as unknown as Context
  const bridge = installSourceComposerBridge(ctx), stopRecovery = installComposerAttachmentRecovery(ctx, bridge, application)
  const stopUpload = installRemoteFileUpload(ctx, { async resolve() { return { owner: { scope: application.getSnapshot()!.scope, binding }, services: { binding, uploads } as unknown as WorkspaceServices } } }, bridge.checkpointUpload)
  const Recovery = dock.get('hapi.attachment-recovery')!, jobs: Array<Promise<unknown>> = []
  function Composer() {
    const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
    const props = { sessionId, sessionBinding: currentBinding, inputActions: editor.actions, useInput: editor.useInput,
      useSession: (select: (value: ReturnType<typeof session.getSnapshot>) => unknown) => select(session.getSnapshot()) } as unknown as PropsRuntime<'conversation.input.dock'>
    return <><Attachments {...props} {...{ sessionId, attachments, uploads: {}, canAcceptDrop: true, inputActions: editor.actions,
      t: ((key: string) => key) as ComposerAttachmentsProps['t'], onRemoveAttachment() {}, onRetryFile() {}, uploadFailureText: () => '', onAddFiles(files: readonly File[]) {
        for (const file of files) { const job = provider.upload(sessionId, file, file.name); jobs.push(job); void job.catch(() => {}) }
        const next = files.map((file, index) => ({ id: `file-${index}` as ComposerAttachment['id'], kind: 'file' as const, file }))
        editor.composer.state.set({ ...editor.composer.state.getSnapshot(), attachmentIds: next.map(value => value.id) }); setAttachments(next)
      } }}/><Recovery {...props}/></>
  }
  const mount = () => render(<WorkspacePaneProvider value={pane('draft')}><Composer/></WorkspacePaneProvider>)
  const first = mount(), accountOne = application.getSnapshot()!.scope
  await waitFor(() => expect(database.reads.length).toBeGreaterThan(0))
  const original = new File(['Exact original binary\u0000\u0080'], 'original.txt')
  act(() => fireEvent.change(first.container.querySelector('input')!, { target: { files: [original] } }))
  await waitFor(() => expect(database.pending.length).toBeGreaterThan(0))
  expect(operations).toEqual([])
  let updateFinished = false
  const updating = updates.checkpoint().then(() => { updateFinished = true })
  await Promise.resolve(); expect(updateFinished).toBe(false)
  act(() => database.release()); await waitFor(() => expect(publications).toBe(1)); await jobs[0]; await updating
  expect(updateFinished).toBe(true)
  expect(publications).toBe(1)
  const key = accountComposerDraftKey(JSON.stringify([accountOne, 'native-one']), 'fixture-host', sessionId)
  const saved = database.records.get(key) as { value: { text: string; files: Array<{ blob: Blob; uploads: Array<[string, { operationId: string; prepared: Blob }]> }> } }
  expect(saved.value.text).toBe('Original unsent text')
  expect(await saved.value.files[0]!.blob.text()).toBe(await original.text())
  expect(saved.value.files[0]!.uploads[0]![1].operationId).toBe(operations[0])
  expect(await saved.value.files[0]!.uploads[0]![1].prepared.text()).toBe(await original.text())
  const writesBeforeSourceUpdates = database.writes.length
  await act(async () => {
    for (let index = 0; index < 20; index++) {
      for (const callback of sessionListeners) callback()
      for (const callback of eventListeners) callback()
    }
    await updates.checkpoint()
  })
  expect(database.writes.length).toBe(writesBeforeSourceUpdates)
  first.unmount()
  application.set({ accountId: 'two', origin: 'https://experience.invalid' }, 'device'); editor = input(''); bind()
  const second = mount(); await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(jobs).toHaveLength(1); expect(operations).toHaveLength(1); expect(database.records.has(key)).toBe(true)
  second.unmount()
  application.set({ accountId: 'one', origin: 'https://experience.invalid' }, 'device'); editor = input('Original unsent text'); bind()
  replaceSourceAccount('native-two')
  const otherNativeAccount = mount(); await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(jobs).toHaveLength(1); expect(operations).toHaveLength(1); expect(database.records.has(key)).toBe(true)
  otherNativeAccount.unmount(); replaceSourceAccount('native-one'); editor = input('Original unsent text'); bind()
  const restored = mount()
  await waitFor(() => expect(operations).toHaveLength(2)); await jobs[1]
  expect(new Set(operations).size).toBe(1); expect(publications).toBe(1)
  expect(Buffer.concat(uploaded)).toEqual(Buffer.from(await original.arrayBuffer()))
  expect(database.reads.every(value => value.startsWith('hhpi:composer-draft:v2:'))).toBe(true)
  restored.unmount()

  // A pending saved copy may be recovered beside newer text, without replacing
  // that text or automatically sending the old operation.
  const pendingCopy = structuredClone(database.records.get(key)) as { value: { mode: string; requestIds?: string[] } }
  pendingCopy.value.mode = 'pending'; pendingCopy.value.requestIds = ['older-send']
  database.records.set(key, pendingCopy)
  editor = input('Newer unsent text'); bind()
  const newer = mount()
  await waitFor(() => expect(dock.has(`attachments:${key}`)).toBe(true))
  const Details = dock.get(`attachments:${key}`)!
  const details = render(<Details {...{ inputActions: editor.actions } as PropsRuntime<'conversation.input.dock'>}/> )
  const restoreButton = await details.findByRole('button', { name: 'Restore saved attachments' })
  act(() => fireEvent.click(restoreButton))
  await waitFor(() => expect(jobs).toHaveLength(3)); await jobs[2]
  expect(editor.composer.state.getSnapshot().draft).toBe('Newer unsent text')
  expect(publications).toBe(1)
  details.unmount(); newer.unmount()

  // Automatic restore of an older draft must retain its bytes while leaving
  // the newer native input able to upload a different file.
  editor = input('Another new draft'); bind()
  const current = mount()
  await waitFor(() => {
    const entry = database.records.get(key) as { value: { previous?: Array<{ text: string }> } }
    expect(entry.value.previous?.[0]?.text).toBe('Newer unsent text')
  })
  expect(editor.composer.state.getSnapshot().draft).toBe('Another new draft')
  rejectNewUpload = true
  const nextFile = new File(['new exact bytes'], 'new.txt'), beforeNewBegin = operations.length
  act(() => fireEvent.change(current.container.querySelector('input')!, { target: { files: [nextFile] } }))
  await waitFor(() => expect(operations.length).toBe(beforeNewBegin + 1))
  const currentSaved = database.records.get(key) as { value: { files: Array<{ blob: Blob }>; previous: Array<{ text: string; files: Array<{ blob: Blob }> }> } }
  expect(await currentSaved.value.files[0]!.blob.text()).toBe('new exact bytes')
  expect(await currentSaved.value.previous[0]!.files[0]!.blob.text()).toBe(await original.text())
  newUploadReply.resolve(); await expect(jobs.at(-1)).rejects.toThrow('New upload reached the source boundary')
  current.unmount(); stopUpload(); stopRecovery(); bridge.dispose(); application.dispose(); updates.dispose()
})
