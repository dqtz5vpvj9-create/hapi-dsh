/** Production message action and operation owner; native transport and Pane navigation are explicit boundaries. */
import { expect, onTestFinished, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { CodexCall, CodexCallResult } from '../../src/remote/codex-access.ts'
import type { SourceSession } from '../../src/remote/protocol.ts'
import { sourceSessionId } from '../../src/remote/protocol.ts'
import type { RemoteSourceSession } from '../../src/client/remote-sessions.ts'
import { NativeActionOwner } from '../../src/client/remote-native-actions.ts'
import { SourceDirectory } from '../../src/client/source-capabilities.ts'
import { installRemoteNativeFork, nativeForkTurn, RemoteNativeForkAction } from '../../src/client/remote-native-fork.tsx'
import { WorkspacePaneProvider } from '../../src/client/surface/pane-context.tsx'
import type { WorkspacePaneNavigation } from '../../src/client/pane-navigation.ts'
import { memoryOperations } from '../fixtures/operation-transactions.ts'

function fixture() {
  const metadata = { id: sourceSessionId({ machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'original:thread' }),
    machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'original:thread', title: 'Original task', cwd: '/original',
    status: 'idle', updatedAt: 1, activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: false, cancel: true, approve: false, files: false },
    codex: { model: 'fixture', reasoningEffort: null, parentThreadId: null, agentNickname: null } } as SourceSession
  const calls: CodexCall[] = [], receipts: CodexCall[] = [], opened = vi.fn()
  let write: (request: CodexCall) => Promise<CodexCallResult> = async () => ({ status: 'accepted', message: 'Branch created', result: { thread: { id: 'exact-child' } } })
  const owner = new NativeActionOwner({ async call(request) { calls.push(request); return write(request) }, async receipt(request) {
    receipts.push(request); return { status: 'accepted', message: 'Original branch found', result: { thread: { id: 'exact-child' } } }
  } }, { createLedger: memoryOperations })
  owner.setStorage({ storage: localStorage, scope: 'original-account' })
  const api: Pick<HhpiRemoteApi, 'nativeCapabilities' | 'nativeCall'> = { async nativeCapabilities() { return { ok: true, value: { protocolVersion: '0.165.0', runtime: 'fixture', methods: { 'thread/fork': 'write' }, unavailable: {} } } } }
  const directory = new SourceDirectory(api, metadata.sourceId)
  const session = { sessionId: metadata.id, metadata: { getSnapshot: () => metadata, subscribe: () => () => {} }, nativeActions: owner,
    sourceDirectory: () => directory, getSnapshot: () => ({ removed: false }) } as unknown as RemoteSourceSession
  const messageId = `codex:${encodeURIComponent(metadata.nativeId)}:${encodeURIComponent('exact:turn')}:exact-item`
  onTestFinished(() => { owner.dispose(); directory.dispose() })
  const Action = () => <RemoteNativeForkAction session={session} messageId={messageId} finished chinese={false} open={opened}/>
  return { session, owner, opened, metadata, calls, receipts, messageId, Action, onWrite(next: typeof write) { write = next } }
}

test('a finalized message forks its exact inclusive native turn and reopens the same confirmed child while keeping the parent draft', async () => {
  const f = fixture(), user = userEvent.setup()
  render(<><textarea aria-label="Parent draft" defaultValue="父任务未发送草稿"/><f.Action/></>)
  const draft = screen.getByRole('textbox', { name: 'Parent draft' }) as HTMLTextAreaElement; draft.setSelectionRange(1, 4)
  await user.click(screen.getByRole('button', { name: 'Branch from this message' }))
  await waitFor(() => expect(f.opened).toHaveBeenCalledWith(sourceSessionId({ ...f.metadata, nativeId: 'exact-child' })))
  expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ sourceId: 'source', method: 'thread/fork',
    params: { threadId: 'original:thread', lastTurnId: 'exact:turn', excludeTurns: true } })
  expect(f.calls[0]?.params).not.toHaveProperty('beforeTurnId')
  await user.click(screen.getByRole('button', { name: 'Open message branch' }))
  expect(f.calls).toHaveLength(1); expect(f.opened).toHaveBeenCalledTimes(2)
  expect(draft).toHaveValue('父任务未发送草稿'); expect(draft.selectionStart).toBe(1); expect(draft.selectionEnd).toBe(4)
})

test('a lost branch receipt survives remount and checks the original operation without a second native fork', async () => {
  const f = fixture(), user = userEvent.setup(); f.onWrite(async () => { throw new Error('Native acknowledgement lost') })
  const view = render(<f.Action/>); await user.click(screen.getByRole('button', { name: 'Branch from this message' }))
  await screen.findByRole('button', { name: 'Check original message branch' }); view.unmount()
  render(<f.Action/>); expect(f.calls).toHaveLength(1); expect(f.opened).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Check original message branch' }))
  await waitFor(() => expect(f.opened).toHaveBeenCalledTimes(1))
  expect(f.calls).toHaveLength(1); expect(f.receipts).toEqual(f.calls)
})

test('an explicitly rejected message branch shows a local failure and keeps the original view available', async () => {
  const f = fixture(), user = userEvent.setup()
  f.onWrite(async () => ({ status: 'rejected', message: 'Native source rejected the message boundary' }))
  render(<f.Action/>); await user.click(screen.getByRole('button', { name: 'Branch from this message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/did not create this message branch/)
  expect(screen.getByRole('button', { name: 'Branch from this message' })).toBeEnabled()
  expect(f.opened).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(1); expect(f.receipts).toHaveLength(0)
})

test('leaving the message before its accepted receipt retains the result without navigating the replacement view', async () => {
  const f = fixture(), user = userEvent.setup(); let finish!: (result: CodexCallResult) => void
  f.onWrite(() => new Promise(resolve => { finish = resolve }))
  const view = render(<f.Action/>); await user.click(screen.getByRole('button', { name: 'Branch from this message' }))
  await waitFor(() => expect(f.calls).toHaveLength(1)); view.unmount()
  finish({ status: 'accepted', message: 'Original accepted', result: { thread: { id: 'exact-child' } } })
  await waitFor(() => expect(f.owner.get(f.session.sessionId, `fork:${f.messageId}`)?.phase).toBe('accepted'))
  expect(f.opened).not.toHaveBeenCalled()
  render(<f.Action/>); await user.click(screen.getByRole('button', { name: 'Open message branch' }))
  expect(f.calls).toHaveLength(1); expect(f.opened).toHaveBeenCalledTimes(1)
})

test('the actual assistant-action installer requires its rendered Pane binding and a completed message, never a focused-session substitute', async () => {
  const f = fixture(), bind = vi.fn(() => { throw new Error('Canonical binding must not be borrowed') })
  let Component: ComponentType<Record<string, unknown>> | undefined
  const ctx = { get: () => undefined, sessions: { binding: bind }, locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    slots: { inject: (_name: string, callback: () => unknown) => callback(), register: (_definition: unknown, value: typeof Component) => { Component = value; return () => {} } },
  } as unknown as Context
  const stop = installRemoteNativeFork(ctx); onTestFinished(stop)
  const openSession = vi.fn(), pane = { state: { getSnapshot: () => ({ visible: true }) }, openSession } as unknown as WorkspacePaneNavigation
  const snapshot = { nodes: new Map([['message', { kind: 'assistant-step', data: { finalNode: { messageId: f.messageId } }, location: { kind: 'step', turn: { status: 'closed' } } }]]) }
  const props = { sessionId: f.session.sessionId, sessionBinding: { sessionId: f.session.sessionId, session: f.session }, messageId: f.messageId,
    useChat: (select: (value: typeof snapshot) => unknown) => select(snapshot) }
  const Installed = Component!
  const view = render(<WorkspacePaneProvider value={pane}><Installed {...props}/></WorkspacePaneProvider>)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Branch from this message' }))
  await waitFor(() => expect(openSession).toHaveBeenCalledWith(sourceSessionId({ ...f.metadata, nativeId: 'exact-child' }), { beside: 'horizontal' }))
  view.rerender(<WorkspacePaneProvider value={pane}><Installed {...props} sessionBinding={undefined}/></WorkspacePaneProvider>)
  expect(screen.queryByRole('button', { name: /message branch|from this message/ })).toBeNull(); expect(bind).not.toHaveBeenCalled()
  expect(nativeForkTurn('codex:another-thread:exact-turn:item', f.metadata.nativeId)).toBeUndefined()
  expect(nativeForkTurn('codex:%ZZ:turn:item', f.metadata.nativeId)).toBeUndefined()
})
