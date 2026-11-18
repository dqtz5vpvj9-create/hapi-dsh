import { act, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { userEvent } from '@testing-library/user-event'
import type { Context } from '@deepseek-ai/cordis'
import { SourceControls, installComposerPicker, type InputProps } from '../../src/client/composer-picker/index.tsx'
/** Production settings state; only native RPC is synthetic. No model inference is performed. */
import { afterEach, expect, test, vi } from 'vitest'
import { CodexSettingsController } from '../../src/client/remote-codex-controls.tsx'
import { CodexActions } from '../../src/client/remote-codex-actions.tsx'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { SourceSession } from '../../src/remote/protocol.ts'
import type { CodexCall, CodexCallResult } from '../../src/remote/codex-access.ts'
import { NativeActionOwner } from '../../src/client/remote-native-actions.ts'
import { SourceDirectory } from '../../src/client/source-capabilities.ts'
import { memoryOperations } from '../fixtures/operation-transactions.ts'
import { nativeServicesFixture } from '../fixtures/native-services.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives)
const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop() })
const metadata: SourceSession = { id: 'hhpi:machine:source:codex:original', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'original', title: 'Task', cwd: '/fixture', status: 'idle', updatedAt: 1, activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: false, cancel: true, approve: false, files: false }, codex: { model: 'first', reasoningEffort: 'medium', parentThreadId: null, agentNickname: null } }
function fixture(displayNames: Record<string, string> = {}) {
  let model = 'first'
  const write = Promise.withResolvers<CodexCallResult>()
  const calls: CodexCall[] = []
  const api = { nativeCapabilities: vi.fn(async () => ({ ok: true, value: { sourceId: 'source', methods: { 'thread/settings/update': 'write', 'model/list': 'read', 'permissionProfile/list': 'read' }, unavailable: {} } })), nativeCall: vi.fn(async (request: CodexCall) => {
    calls.push(request)
    if (request.method === 'thread/settings/update') return { ok: true, value: await write.promise }
    const result = request.method === 'model/list' ? { data: ['first', 'second'].map(model => ({ model, displayName: displayNames[model] ?? model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] })), nextCursor: null }
      : request.method === 'thread/read' ? { thread: { id: 'original', model, reasoningEffort: 'medium' } }
      : request.method === 'permissionProfile/list' ? { data: [{ id: ':workspace', allowed: true }, { id: ':read-only', allowed: true }] } : { data: [] }
    return { ok: true, value: { status: 'accepted', message: 'read', result } }
  }), nativeReceipt: vi.fn(async () => ({ ok: true, value: { status: 'indeterminate', message: 'receipt pending' } })) } as unknown as HhpiRemoteApi
  const actions = new NativeActionOwner({ call: async request => { const response = await api.nativeCall!(request); if (!response.ok) throw response.error; return response.value }, receipt: async request => { const response = await api.nativeReceipt!(request); if (!response.ok) throw response.error; return response.value } }, { createLedger: memoryOperations })
  actions.setStorage({ storage: localStorage, scope: crypto.randomUUID() })
  const directory = new SourceDirectory(api, 'source')
  const services = { actions, directory: () => directory }
  const controller = new CodexSettingsController(api, metadata, services)
  cleanup.push(() => { controller.dispose(); actions.dispose(); directory.dispose() })
  return { api, controller, actions, directory, services, write, calls, observeModel: (next: string) => { model = next } }
}
test('model changes retain the confirmed source value, reject repeated clicks, then reconcile by readback', async () => {
  const f = fixture(); await f.controller.refresh()
  const change = f.controller.apply({ kind: 'model', value: 'second' })
  expect(f.controller.getSnapshot().data?.model).toBe('first')
  await waitFor(() => expect(f.controller.getSnapshot().pending).not.toBeNull())
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
      entries: () => [], subscribe: () => () => {},
    },
  } as unknown as Context
  const stop = installComposerPicker(ctx)
  const session = { nativeActions: f.actions, sourceDirectory: () => f.directory, metadata: { getSnapshot: () => metadata, subscribe: () => () => {} } }
  const props = { sessionId: metadata.id, sessionBinding: { session }, useProjection: () => undefined,
    useInput: (select: (state: { phase: string }) => unknown) => select({ phase: 'idle' }),
    useSession: (select: (state: { running: boolean }) => unknown) => select({ running: false }),
    renderSlot: () => null,
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


test('matching metadata cannot settle an uncertain native action, including a remounted picker', async () => {
  const f = fixture(); await f.controller.refresh()
  const change = f.controller.apply({ kind: 'model', value: 'second' })
  f.write.resolve({ status: 'indeterminate', message: 'lost reply' }); await change
  f.observeModel('second')
  f.controller.observe({ ...metadata, codex: { ...metadata.codex!, model: 'second' } })
  expect(f.controller.getSnapshot().pending).not.toBeNull()
  f.controller.dispose()
  const next = new CodexSettingsController(f.api, metadata, f.services)
  cleanup.push(() => next.dispose())
  await next.refresh()
  expect(next.getSnapshot().data?.model).toBe('second')
  expect(next.getSnapshot().pending).not.toBeNull()
  vi.mocked(f.api.nativeReceipt!).mockResolvedValue({ ok: true, value: { status: 'accepted', message: 'exact original receipt' } })
  await next.refresh()
  expect(next.getSnapshot().pending).toBeNull()
  expect(f.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(1)
})

test('Fast uses the source priority ID and works independently of steer capability', async () => {
  const f = fixture(); await f.controller.refresh()
  expect(f.controller.getSnapshot().data?.editable.fast).toBe(true)
  f.write.resolve({ status: 'accepted', message: 'accepted' })
  await f.controller.apply({ kind: 'fast', value: true })
  expect(f.calls.find(call => call.method === 'thread/settings/update')?.params).toEqual({ threadId: 'original', serviceTier: 'priority' })
})

test('Plan capsule sends the native collaboration payload once and displays only source-confirmed mode', async () => {
  const f = fixture(); await f.controller.refresh()
  const user = userEvent.setup(); render(<SettingsSeat controller={f.controller}/>)
  const plan = screen.getByRole('button', { name: 'Plan' })
  expect(plan).toHaveAttribute('aria-pressed', 'false')
  await user.click(plan)
  await waitFor(() => expect(plan).toBeDisabled())
  expect(plan).toHaveAttribute('aria-pressed', 'false')
  await user.click(plan)
  expect(f.calls.filter(call => call.method === 'thread/settings/update')).toMatchObject([{
    sourceId: 'source', params: { threadId: 'original', collaborationMode: { mode: 'plan', settings: {
      model: 'first', reasoning_effort: 'medium', developer_instructions: null,
    } } },
  }])
  f.write.resolve({ status: 'accepted', message: 'source accepted' })
  await waitFor(() => expect(plan).toBeEnabled())
  expect(plan).toHaveAttribute('aria-pressed', 'false')
  act(() => f.controller.observe({ ...metadata, codex: { ...metadata.codex!, settings: { collaborationMode: { mode: 'plan' } } } }))
  expect(plan).toHaveAttribute('aria-pressed', 'true')
  await user.click(plan)
  await waitFor(() => expect(f.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(2))
  expect(f.calls.filter(call => call.method === 'thread/settings/update')[1]?.params).toMatchObject({ collaborationMode: { mode: 'default' } })
  await waitFor(() => expect(plan).toBeEnabled())
})

test('Plan cannot write without a known model or while its source is offline', async () => {
  const f = fixture(); await f.controller.refresh()
  f.controller.observe({ ...metadata, codex: { ...metadata.codex!, model: null } })
  expect(f.controller.getSnapshot().data?.editable.collaboration).toBe(false)
  expect(await f.controller.apply({ kind: 'collaboration', value: 'plan' })).toBe(false)
  f.controller.observe({ ...metadata, connection: { state: 'offline' } } as SourceSession)
  expect(f.controller.getSnapshot().data?.editable.collaboration).toBe(false)
  expect(await f.controller.apply({ kind: 'collaboration', value: 'plan' })).toBe(false)
  expect(f.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(0)
})

test('a recovered catalog clears its old read error', async () => {
  const f = fixture()
  const original = f.api.nativeCall!
  let failed = false
  f.api.nativeCall = vi.fn(async (request, signal) => {
    if (request.method === 'model/list' && !failed) { failed = true; throw new Error('catalog disconnected') }
    return original(request, signal)
  })
  await f.controller.refresh()
  expect(f.controller.getSnapshot().error).toBe('catalog disconnected')
  await f.controller.refresh()
  expect(f.controller.getSnapshot().data?.model).toBe('first')
  expect(f.controller.getSnapshot().error).toBeNull()
})

function SettingsSeat({ controller }: { controller: CodexSettingsController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const ctx = { get: () => undefined, locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} } } as unknown as Context
  const props = { sessionId: metadata.id, sessionBinding: { session: { metadata: { getSnapshot: () => metadata } } }, useInput: () => false, useSession: () => false, renderSlot: () => null } as unknown as InputProps
  return <SourceControls ctx={ctx} props={props} initial={{ model: 'first', effort: 'medium', permission: null, serviceTier: null }}
    permissionCapable data={state.data} pending={state.pending} applied={state.applied} busy={state.busy} loading={state.loading}
    error={state.error} sourceLocked={false} refresh={controller.refresh} apply={controller.apply}/>
}

test('model selection displays the source name, submits its original ID and returns without replacing the draft', async () => {
  const f = fixture({ first: 'GPT-6-Astra', second: 'GPT-6.1-Sol' }); await f.controller.refresh()
  // The textarea is the retained editor boundary; settings/RPC state is production.
  render(<><textarea aria-label="Unsent draft" defaultValue="Keep this unsent paragraph"/><SettingsSeat controller={f.controller}/></>)
  const draft = screen.getByRole('textbox', { name: 'Unsent draft' }), user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'GPT-6-Astra' }))
  await user.click(screen.getByRole('radio', { name: 'GPT-6.1-Sol' }))
  expect(screen.getByRole('button', { name: 'GPT-6-Astra' })).toBeInTheDocument()
  f.observeModel('second'); f.write.resolve({ status: 'accepted', message: 'native acknowledgement' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose model' })).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'GPT-6.1-Sol' })).toHaveFocus()
  expect(screen.getByRole('textbox', { name: 'Unsent draft' })).toBe(draft)
  expect(draft).toHaveValue('Keep this unsent paragraph')
  expect(f.calls.filter(call => call.method === 'thread/settings/update')).toMatchObject([{ sourceId: 'source', params: { threadId: 'original', model: 'second' } }])
})

test('an accepted permission change confirms the action without inventing current settings or resending on reopen', async () => {
  const f = fixture(); await f.controller.refresh()
  const user = userEvent.setup(), view = render(<SettingsSeat controller={f.controller}/>)
  await user.click(screen.getByRole('button', { name: /Session permissions/ }))
  await user.click(screen.getByRole('radio', { name: 'Workspace access' }))
  expect(screen.getByRole('radio', { name: 'Workspace access' })).not.toBeChecked()
  expect(screen.queryByText(/Applied:/)).not.toBeInTheDocument()
  f.write.resolve({ status: 'accepted', message: 'source accepted', result: {} })
  expect(await screen.findByText('Applied: Permissions: Workspace access')).toBeVisible()
  expect(screen.getByText('The source has not reported the current permissions.')).toBeVisible()
  expect(screen.getByRole('radio', { name: 'Workspace access' })).not.toBeChecked()
  expect(f.controller.getSnapshot().data?.permission).toBeNull()
  const operationId = f.controller.getSnapshot().applied?.operationId
  expect(operationId).toBeTruthy()
  view.unmount(); f.controller.dispose()
  const next = new CodexSettingsController(f.api, metadata, f.services); cleanup.push(() => next.dispose())
  await next.refresh()
  render(<SettingsSeat controller={next}/>)
  await user.click(screen.getByRole('button', { name: /Session permissions/ }))
  expect(screen.getByText('Applied: Permissions: Workspace access')).toBeVisible()
  expect(next.getSnapshot().applied?.operationId).toBe(operationId)
  expect(next.getSnapshot().data?.permission).toBeNull()
  expect(f.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(1)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Permissions' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Session permissions/ })).toHaveFocus()
})

test('approval policy has its own native field and only source metadata checks its current value', async () => {
  const f = fixture(); await f.controller.refresh()
  const user = userEvent.setup(); render(<SettingsSeat controller={f.controller}/>)
  await user.click(screen.getByRole('button', { name: /Session permissions/ }))
  const approval = screen.getByRole('radiogroup', { name: 'Approval requests' })
  await user.click(within(approval).getByRole('radio', { name: 'Ask when needed' }))
  await waitFor(() => expect(f.controller.getSnapshot().pending?.change).toEqual({ kind: 'approvalPolicy', value: 'on-request' }))
  expect(await f.controller.apply({ kind: 'approvalPolicy', value: 'never' })).toBe(false)
  expect(within(approval).getByRole('radio', { name: 'Ask when needed' })).not.toBeChecked()
  f.write.resolve({ status: 'accepted', message: 'source accepted', result: {} })
  expect(await screen.findByText('Applied: Approval requests: Ask when needed')).toBeVisible()
  expect(f.controller.getSnapshot().data?.approvalPolicy).toBeNull()
  expect(f.calls.filter(call => call.method === 'thread/settings/update')).toMatchObject([{ sourceId: 'source', params: { threadId: 'original', approvalPolicy: 'on-request' } }])
  f.controller.observe({ ...metadata, codex: { ...metadata.codex!, settings: { approvalPolicy: 'on-request', activePermissionProfile: { id: ':workspace' } } } })
  await waitFor(() => expect(within(approval).getByRole('radio', { name: 'Ask when needed' })).toBeChecked())
  expect(screen.getByRole('radio', { name: 'Workspace access' })).toBeChecked()
  expect(screen.queryByText('The source has not reported the current approval policy.')).not.toBeInTheDocument()
})

test('rejected or uncertain settings never show applied and unadvertised policy values cannot write', async () => {
  const f = fixture(); await f.controller.refresh()
  expect(await f.controller.apply({ kind: 'approvalPolicy', value: 'custom' })).toBe(false)
  const write = f.controller.apply({ kind: 'approvalPolicy', value: 'on-request' })
  f.write.resolve({ status: 'indeterminate', message: 'unknown acknowledgement' }); await write
  expect(f.controller.getSnapshot().applied).toBeNull()
  vi.mocked(f.api.nativeReceipt!).mockResolvedValue({ ok: true, value: { status: 'rejected', message: 'source policy denied' } })
  await f.controller.refresh()
  expect(f.controller.getSnapshot().applied).toBeNull()
  expect(f.controller.getSnapshot().error).toBe('source policy denied')
  expect(f.controller.getSnapshot().data?.approvalPolicy).toBeNull()
  expect(f.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(1)
})

test('services subpage isolates outer actions, returns focus and preserves retained drafts when closed and reopened', async () => {
  const f = nativeServicesFixture(), user = userEvent.setup()
  cleanup.push(() => f.close())
  const original = f.session.metadata.getSnapshot()
  const source: SourceSession = { ...original, status: 'running', activeTurnId: 'active-turn', capabilities: { ...original.capabilities, steer: true } }
  const session = { ...f.session, metadata: { getSnapshot: () => source, subscribe: () => () => {} } } as unknown as typeof f.session
  const input = { phase: 'plain', draft: '保留草稿', attachmentIds: [] as string[] }
  const submit = vi.fn(), bindingCtx = {}
  const forInput = vi.fn(() => ({ submit }))
  const ctx = { get: () => undefined, remote: { hhpi: f.api }, hhpiSessions: { captureWorkspaceAccess: f.captureAccess },
    locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} }, conversation: { input: { for: forInput } },
  } as unknown as Context
  const props = { sessionId: source.id, sessionBinding: { session, ctx: bindingCtx },
    useInput: (select: (value: typeof input) => unknown) => select(input),
    useSession: (select: (value: { running: boolean }) => unknown) => select({ running: source.status === 'running' }),
    renderSlot: (name: string) => name === 'hapi.source.composer-navigation'
      ? <button type="button">搜索当前会话</button>
      : name === 'hapi.source.composer-actions' ? <input aria-label="暂存草稿" defaultValue="保留附件说明"/>
      : name === 'hapi.source.composer-details' ? <span>上下文详情</span> : null,
  } as unknown as InputProps
  const ui = () => <SourceControls ctx={ctx} props={props} initial={{ model: 'fixture', effort: null, permission: null, serviceTier: null }}
    permissionCapable={false} data={null} loading={false} busy={false} pending={null} error={null} sourceLocked={false}
    refresh={async () => {}} apply={async () => false}
    actionsContent={(onSubpageChange, actionsOpen) => <CodexActions ctx={ctx} session={session} metadata={source} zh onSubpageChange={onSubpageChange} actionsOpen={actionsOpen}/>}/>
  const view = render(ui())
  await user.click(screen.getByRole('button', { name: '插话' }))
  expect(forInput).toHaveBeenCalledWith(bindingCtx)
  expect(submit).toHaveBeenCalledExactlyOnceWith('steer', 'click')
  await user.click(screen.getByRole('button', { name: '更多输入控件' }))
  const parked = screen.getByRole('textbox', { name: '暂存草稿' })
  await user.type(parked, '，未保存')
  expect(screen.getByRole('button', { name: '立即插话发送' })).toBeVisible()
  expect(screen.queryByRole('textbox', { name: '会话名称' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '切换为规划模式' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '源连接与后台任务' }))
  expect(await screen.findByText('Repository service')).toBeVisible()
  const panel = screen.getByRole('dialog', { name: '源连接与后台任务' })
  expect(within(panel).queryByRole('button', { name: '搜索当前会话' })).not.toBeInTheDocument()
  expect(within(panel).queryByRole('button', { name: '立即插话发送' })).not.toBeInTheDocument()
  expect(within(panel).queryByRole('textbox', { name: '暂存草稿' })).not.toBeInTheDocument()
  expect(within(panel).getByText('上下文详情')).not.toBeVisible()
  expect(panel.querySelector('.hapi-composer-overflow-section')).toHaveAttribute('hidden')
  expect(within(panel).getByText('已连接 · 已配置令牌 · 1 项工具')).toHaveClass('hapi-service-status')
  await user.click(within(panel).getByRole('button', { name: '返回会话操作' }))
  expect(screen.getByRole('button', { name: '源连接与后台任务' })).toHaveFocus()
  expect(screen.getByRole('textbox', { name: '暂存草稿' })).toBe(parked)
  expect(parked).toHaveValue('保留附件说明，未保存')
  await user.click(screen.getByRole('button', { name: '源连接与后台任务' }))
  await screen.findByText('Repository service')
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '更多输入控件' }))
  expect(screen.getByRole('dialog', { name: '更多输入控件' })).toBeVisible()
  expect(screen.getByRole('button', { name: '搜索当前会话' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: '暂存草稿' })).toBe(parked)
  expect(f.writes).toHaveLength(0)
  // The inline action follows the retained input and current native turn.
  input.draft = '  '; view.rerender(ui())
  expect(screen.queryByRole('button', { name: '插话' })).not.toBeInTheDocument()
  input.attachmentIds = ['image']; view.rerender(ui())
  expect(screen.getByRole('button', { name: '插话' })).toBeVisible()
  source.activeTurnId = null; view.rerender(ui())
  expect(screen.queryByRole('button', { name: '插话' })).not.toBeInTheDocument()
  source.activeTurnId = 'active-turn'; source.connection = { state: 'offline', observedAt: 1 }; view.rerender(ui())
  expect(screen.queryByRole('button', { name: '插话' })).not.toBeInTheDocument()
  source.connection = { state: 'online', observedAt: 2 }; input.phase = 'submitting'; view.rerender(ui())
  expect(screen.queryByRole('button', { name: '插话' })).not.toBeInTheDocument()
  expect(submit).toHaveBeenCalledTimes(1)
})
