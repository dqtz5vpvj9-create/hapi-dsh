import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { Context } from '@deepseek-ai/cordis'
import { installComposerPicker, type InputProps } from '../../src/client/composer-picker/index.tsx'
/** Production settings state; only native RPC is synthetic. No model inference is performed. */
import { expect, test, vi } from 'vitest'
import { CodexSettingsController } from '../../src/client/remote-codex-controls.tsx'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { SourceSession } from '../../src/remote/protocol.ts'
import type { CodexCall, CodexCallResult } from '../../src/remote/codex-access.ts'
const metadata: SourceSession = { id: 'hhpi:machine:source:codex:original', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'original', title: 'Task', cwd: '/fixture', status: 'idle', updatedAt: 1, activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, codex: { model: 'first', reasoningEffort: 'medium', parentThreadId: null, agentNickname: null } }
function fixture() {
  let model = 'first'
  const write = Promise.withResolvers<CodexCallResult>()
  const calls: CodexCall[] = []
  const api = { nativeCall: vi.fn(async (request: CodexCall) => {
    calls.push(request)
    if (request.method === 'thread/settings/update') return { ok: true, value: await write.promise }
    const result = request.method === 'model/list' ? { data: ['first', 'second'].map(model => ({ model, displayName: model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] })), nextCursor: null }
      : request.method === 'thread/read' ? { thread: { id: 'original', model, reasoningEffort: 'medium' } } : { data: [] }
    return { ok: true, value: { status: 'accepted', message: 'read', result } }
  }), nativeReceipt: vi.fn(async () => ({ ok: true, value: { status: 'accepted', message: 'accepted', resultUnavailable: true } })) } as unknown as HhpiRemoteApi
  return { api, controller: new CodexSettingsController(api, metadata), write, calls, observeModel: (next: string) => { model = next } }
}
test('model changes retain the confirmed source value, reject repeated clicks, then reconcile by readback', async () => {
  const f = fixture(); await f.controller.refresh()
  const change = f.controller.apply({ kind: 'model', value: 'second' })
  expect(f.controller.getSnapshot().data?.model).toBe('first')
  expect(f.controller.getSnapshot().pending).not.toBeNull()
  expect(await f.controller.apply({ kind: 'model', value: 'first' })).toBe(false)
  f.observeModel('second'); f.write.resolve({ status: 'accepted', message: 'native acknowledgement' })
  expect(await change).toBe(true)
  expect(f.controller.getSnapshot().data?.model).toBe('second')
  expect(f.controller.getSnapshot().pending).toBeNull()
  const writes = f.calls.filter(call => call.method === 'thread/settings/update')
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ sourceId: 'source', params: { threadId: 'original', model: 'second' } })
})
test('an uncertain write stays pending across refresh and is never automatically resent', async () => {
  const f = fixture(); await f.controller.refresh()
  const change = f.controller.apply({ kind: 'model', value: 'second' })
  f.write.resolve({ status: 'indeterminate', message: 'lost acknowledgement' }); await change
  await f.controller.refresh()
  expect(f.controller.getSnapshot().data?.model).toBe('first')
  expect(f.controller.getSnapshot().pending).not.toBeNull()
  expect(f.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(1)
})


test('registered native composer keeps one remote service across renders and opens the existing model picker', async () => {
  const f = fixture()
  let serviceReads = 0
  let Entry!: (props: InputProps) => React.ReactNode
  const ctx = {
    remote: { get hhpi() { ++serviceReads; return { ...f.api } } },
    get: () => undefined,
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    slots: {
      inject: (_name: string, install: () => () => void) => install(),
      register: (_spec: unknown, entry: typeof Entry) => { Entry = entry; return () => {} },
    },
  } as unknown as Context
  const stop = installComposerPicker(ctx, {} as never, {} as never)
  const session = { metadata: { getSnapshot: () => metadata, subscribe: () => () => {} } }
  const props = { sessionId: metadata.id, sessionBinding: { session }, useProjection: () => undefined,
    useInput: (select: (state: { phase: string }) => unknown) => select({ phase: 'idle' }),
  } as unknown as InputProps
  const view = render(<Entry {...props}/> )
  await waitFor(() => expect(f.calls.filter(call => call.method === 'thread/read')).toHaveLength(1))
  view.rerender(<Entry {...props}/> )
  expect(serviceReads).toBe(1)
  await userEvent.click(screen.getByRole('button', { name: 'first' }))
  expect(screen.getByRole('dialog', { name: 'Choose model' })).toBeVisible()
  expect(f.calls.filter(call => call.operationId)).toHaveLength(0)
  view.unmount(); stop()
})
