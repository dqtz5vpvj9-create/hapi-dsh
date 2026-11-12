/** Production disclosure and operation state; native RPC and storage are explicit boundaries. */
import { createElement, useState, type ComponentType } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useLiveDisclosure } from '../../src/client/live-disclosure.ts'
import { SourcePlanOperation, proposedPlanText } from '../../src/client/source-plan.tsx'
import { CompactAttachmentButton, installSourceComposerBridge } from '../../src/client/source-composer.tsx'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { CodexCall } from '../../src/remote/codex-access.ts'
import type { SourceSession } from '../../src/remote/protocol.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ComposerAttachmentsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NativeActionOwner } from '../../src/client/remote-native-actions.ts'
import { SourceDirectory } from '../../src/client/source-capabilities.ts'
import type { RemoteSourceSession } from '../../src/client/remote-sessions.ts'
import { memoryOperations } from '../fixtures/operation-transactions.ts'
const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })

function useNativeDisclosure() { const [expanded, setExpanded] = useState(false); return { expanded, setExpanded, toggle: () => setExpanded(!expanded) } }
function Row({ running }: { running: boolean }) {
  const disclosure = useLiveDisclosure(useNativeDisclosure, running)
  return <><button aria-expanded={disclosure.expanded} onClick={disclosure.toggle}>Process</button>{disclosure.expanded && <div>Actual process output</div>}</>
}
test('only the running process opens automatically, and completion closes it', () => {
  const view = render(<Row running/> )
  expect(screen.getByText('Actual process output')).toBeVisible()
  view.rerender(<Row running={false}/> )
  expect(screen.queryByText('Actual process output')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Process' }))
  view.rerender(<Row running={false}/> )
  expect(screen.getByText('Actual process output')).toBeVisible()
})
test('a manual collapse during execution is not undone by later deltas', () => {
  const view = render(<Row running/> )
  fireEvent.click(screen.getByRole('button', { name: 'Process' }))
  view.rerender(<Row running/> )
  expect(screen.queryByText('Actual process output')).toBeNull()
  view.rerender(<Row running={false}/> )
  expect(screen.queryByText('Actual process output')).toBeNull()
})
const metadata: SourceSession = { id: 'hhpi:machine:source:codex:original', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'original', title: 'Task', cwd: '/fixture', status: 'idle', updatedAt: 1, activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, codex: { model: 'fixture-model', reasoningEffort: 'high', parentThreadId: null, agentNickname: null } }
function planFixture(immediate = false) {
  const gate = Promise.withResolvers<never>()
  const nativeCall = vi.fn((_request: CodexCall) => immediate ? Promise.resolve({ ok: true as const, value: { status: 'accepted' as const, message: 'received' } }) : gate.promise)
  const nativeReceipt = vi.fn(async () => ({ ok: true as const, value: { status: 'accepted' as const, message: 'Source receipt' } }))
  const api = { nativeCall, nativeReceipt, nativeCapabilities: async () => ({ ok: true, value: { methods: { 'turn/start': 'write' }, unavailable: {} } }) } as unknown as HhpiRemoteApi
  const actions = new NativeActionOwner({ call: async request => { const value = await api.nativeCall!(request); if (!value.ok) throw value.error; return value.value },
    receipt: async request => { const value = await api.nativeReceipt!(request); if (!value.ok) throw value.error; return value.value } }, { createLedger: memoryOperations })
  actions.setStorage({ storage: localStorage, scope: crypto.randomUUID() })
  const directory = new SourceDirectory(api, 'source')
  const session = { sessionId: metadata.id, metadata: { getSnapshot: () => metadata }, nativeActions: actions, sourceDirectory: () => directory } as unknown as RemoteSourceSession
  stops.push(() => { actions.dispose(); directory.dispose() })
  return { gate, nativeCall, nativeReceipt, operation: new SourcePlanOperation(session, 'fixture-plan'), remount: () => new SourcePlanOperation(session, 'fixture-plan') }
}
test('plan actions persist intent before dispatch and never resend an uncertain request after remount', async () => {
  const f = planFixture()
  const pending = f.operation.submit(metadata, 'Approved plan body', 'default')
  await waitFor(() => expect(f.nativeCall).toHaveBeenCalledTimes(1))
  expect(f.operation.read()?.request.method).toBe('turn/start')
  expect(await f.operation.submit(metadata, 'Approved plan body', 'default')).toBeNull()
  f.gate.reject(new Error('connection interrupted'))
  expect((await pending)?.status).toBe('indeterminate')
  expect((await f.remount().submit(metadata, 'Approved plan body', 'default'))?.status).toBe('accepted')
  expect(f.nativeCall).toHaveBeenCalledTimes(1)
  expect(f.nativeReceipt).toHaveBeenCalledTimes(1)
  expect(f.nativeCall.mock.calls[0]?.[0]).toMatchObject({ sourceId: 'source', method: 'turn/start', params: { threadId: 'original', collaborationMode: { mode: 'default', settings: { model: 'fixture-model', reasoning_effort: 'high' } }, input: [{ type: 'text', text: 'Implement this plan.\n\nApproved plan body' }] } })
})
test('continuing a plan uses native plan mode and refuses a running source', async () => {
  const f = planFixture(true), operation = f.operation
  await expect(operation.submit({ ...metadata, status: 'running' }, 'Plan', 'plan')).rejects.toThrow('idle')
  expect(f.nativeCall).not.toHaveBeenCalled()
  await operation.submit(metadata, 'Plan', 'plan')
  expect(f.nativeCall).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ collaborationMode: expect.objectContaining({ mode: 'plan' }) }) }))
  expect(proposedPlanText([{ kind: 'text', text: 'I plan to help.' }])).toBeNull()
  expect(proposedPlanText([{ kind: 'text', text: '<proposed_plan>\nNative plan\n</proposed_plan>' }])).toBe('Native plan')
})
test('file chooser results stay with the editor that opened the chooser', () => {
  const focus = vi.fn(), onAddFiles = vi.fn()
  const ctx = { locale: { getSnapshot: () => ({ active: 'en' }) }, conversation: { input: { for: () => ({ focus }) } } } as unknown as Context
  const owner = { inputActions: {}, canAcceptDrop: true, onAddFiles, sessionBinding: { ctx: {} } } as unknown as ComposerAttachmentsProps
  const view = render(<CompactAttachmentButton ctx={ctx} props={owner}/> )
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
  const file = new File(['fixture'], 'example.txt')
  fireEvent.change(view.container.querySelector('input')!, { target: { files: [file] } })
  expect(onAddFiles).toHaveBeenCalledWith([file]); expect(focus).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
  const other = vi.fn()
  view.rerender(<CompactAttachmentButton ctx={ctx} props={{ ...owner, inputActions: {} as ComposerAttachmentsProps['inputActions'], onAddFiles: other }}/> )
  act(() => fireEvent.change(view.container.querySelector('input')!, { target: { files: [file] } }))
  expect(other).not.toHaveBeenCalled(); expect(onAddFiles).toHaveBeenCalledTimes(1)
})


test('the source composer preserves native injected attachment ownership and retains the attach button', () => {
  const nativeOwner = vi.fn(), nativeInject = vi.fn(() => ({ readFileDrag: nativeOwner }))
  function Official(props: { readFileDrag: unknown }) {
    expect(props.readFileDrag).toBe(nativeOwner)
    return <span>Native attachment component</span>
  }
  const original = { options: {}, component: Official, inject: nativeInject }
  let Component!: ComponentType<ComposerAttachmentsProps>, options!: { inject: typeof nativeInject }
  const ctx = { slots: { entries: () => [original], subscribe: () => () => {},
    register(value: typeof options, component: typeof Component) { options = value; Component = component; return () => {} },
  }, reflect: { provide: () => () => {} }, locale: { getSnapshot: () => ({ active: 'en' }) } } as unknown as Context
  const bridge = installSourceComposerBridge(ctx)
  expect(options.inject).toBe(nativeInject)
  const file = new File(['fixture'], 'shot.png', { type: 'image/png' })
  const owner = { sessionId: 'hhpi:machine:source:codex:thread', attachments: [{ id: 'fixture', kind: 'image', file, previewUrl: 'blob:fixture' }], uploads: {}, inputActions: {}, canAcceptDrop: true } as unknown as ComposerAttachmentsProps
  const view = render(createElement(Component, { ...owner, ...options.inject() }))
  expect(screen.getByRole('button', { name: 'Attach files' })).toBeVisible()
  expect(screen.getByText('Native attachment component')).toBeVisible()
  expect(bridge.inspectSubmission(owner.sessionId!, owner.inputActions!, [])).toBe('ready')
  expect(bridge.captureFiles(owner.sessionId!, ['fixture'])[0]?.file).toBe(file)
  view.unmount(); bridge.dispose()
})
