/** Actual pinned Conversation/Chat grouping and production native projection.
 * Source bytes and DOM geometry are explicit fixtures; this is not browser layout evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { build } from 'esbuild'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CodexHistory } from '../../src/remote/codex-history.ts'
import { CodexAttachments } from '../../src/remote/codex-attachments.ts'
import { CodexUploads } from '../../src/remote/codex-uploads.ts'
import type { CodexAccessBridge } from '../../src/remote/codex-access-bridge.ts'
import { SourceAttachments } from '../../src/workspace/source-attachments.ts'
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceDocumentService } from '../../src/workspace/service-types.ts'
import type { SourceFileClient } from '../../src/client/source-workspace-provider.ts'
import { parseWorkspaceDocumentAddress } from '../../src/workspace/artifacts.ts'
import { loadWorkspaceArtifact, readWorkspaceArtifactBytes } from '../../src/client/artifact-content.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import { fixture } from './hhpi-reading-fixture.ts'
import { installDomGeometry } from './dom-geometry.ts'
import { ACTIVE_CONVERSATION_INPUT } from './conversation-content-input.ts'
import { resolveOfficialBrowserDependency } from './official-browser-library.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'hhpi.test.native-presentation': { kind: 'single'; scope: 'session' } }
}

test('native process → response → process preserves groups, primary plans/images and errors within native tool details', { timeout: 15000 }, async t => {
  const f = await fixture(t), geometry = installDomGeometry(f.dom.window, { width: 800, height: 600 })
  const require = createRequire(import.meta.url)
  const installRegistryPlugin = async (name: string) => {
    assert.equal(require(`${name}/package.json`).version, '0.2.2-rc.1')
    let registration: { factory(resolve: typeof resolveOfficialBrowserDependency): { apply(ctx: Context): void; inject: string[] } } | undefined
    const target = f.dom.window as unknown as Window & { __ModuleLoader__?: { load(value: typeof registration): void } }
    target.__ModuleLoader__ = { load(value) { registration = value } }
    try { new Function('window', readFileSync(require.resolve(`${name}/client`), 'utf8'))(target) }
    finally { delete target.__ModuleLoader__ }
    assert.ok(registration)
    await f.ctx.plugin(registration.factory(resolveOfficialBrowserDependency))
  }
  await installRegistryPlugin('@deepseek-ai/dsh-client-ui-attachment')
  const output = await build({ stdin: { contents: "export { installSourceTranscript } from './src/client/source-transcript.tsx'; export { installToolProgressDisplay } from './src/client/tool-progress-display.tsx'; export { installSourceChatFiles } from './src/client/source-chat-files.tsx';", resolveDir: resolve(import.meta.dirname, '../..'), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime'], write: false, logLevel: 'silent', jsx: 'automatic' })
  const module = { exports: {} as { installSourceTranscript: typeof import('../../src/client/source-transcript.tsx').installSourceTranscript; installToolProgressDisplay: typeof import('../../src/client/tool-progress-display.tsx').installToolProgressDisplay; installSourceChatFiles: typeof import('../../src/client/source-chat-files.tsx').installSourceChatFiles } }
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(resolveOfficialBrowserDependency, module, module.exports)
  const { installSourceTranscript, installToolProgressDisplay, installSourceChatFiles } = module.exports
  // The shared paging fixture starts with 1,440 user rows. This journey uses a
  // small native Turn so virtualization does not keep the new process offscreen.
  f.index.edit(f.index.session, () => f.index.removeFrom(1))
  const source = f.index.session, directory = await mkdtemp('/mnt/cache/data-cache/hhpi-presentation-')
  const lifetime = new AbortController(), prepared = Promise.withResolvers<void>(), historicalImagePrepared = Promise.withResolvers<void>()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
  const attachments = new CodexAttachments(f.index, join(directory, 'images'), async () => ({ dataBase64: png }), lifetime.signal, ({ turnId, itemId }) => {
    const state = history.itemState(turnId, itemId)!; history.acceptItem(source, turnId, state.item, state.completed)
    if (itemId === 'generated-image') prepared.resolve()
    if (itemId === 'historical-user-image') historicalImagePrepared.resolve()
  })
  const uploads = new CodexUploads(join(directory, 'receipts'), { call() { throw new Error('Presentation must not dispatch native writes') } } as unknown as CodexAccessBridge)
  const history = new CodexHistory(f.index, { userContent: (turnId, item) => uploads.content(source.id, item, attachments.content(turnId, item)) ?? attachments.content(turnId, item),
    toolContent: (turnId, item) => attachments.content(turnId, item) })
  const storage = new Context(), binding: WorkspaceBinding = { target: { hostId: 'local', sessionId: source.id }, machineId: source.machineId,
    workspaceId: 'native-presentation', root: source.cwd, pathStyle: 'posix' }
  const access: WorkspaceAccess = { scope: 'native-presentation-account', signal: lifetime.signal, assertAllowed(target) { assert.deepEqual(target, binding.target); lifetime.signal.throwIfAborted() } }
  const owner = new SourceAttachments(storage, { directory: join(directory, 'immutable'), receipts: join(directory, 'receipts'), async generated(_binding, id) {
    const value = await attachments.read(`attachment:${id}`, lifetime.signal)
    return { data: Buffer.from(value.content, 'base64'), name: value.attachment!.name ?? 'Generated image', mimeType: value.mimeType, version: value.attachment!.attachmentId }
  } })
  const documents = owner.documents(binding, { open() { throw new Error('No display filesystem fallback') }, bytes() { throw new Error('No display filesystem fallback') } } as unknown as WorkspaceDocumentService)
  const fileClient: SourceFileClient = { async resolve(id, signal) { assert.equal(id, source.id); signal.throwIfAborted()
    return { owner: { scope: access.scope, binding }, services: { binding, files: {} as never, documents } } } }
  const opened: string[] = []
  Object.assign(f.ctx.sidebarRight, { openResourceIn(id: string, address: string) { assert.equal(id, source.id); opened.push(address) } })
  const operationId = crypto.randomUUID(), originalFile = Buffer.from('原始附件正文'), staging = join(directory, 'original-upload')
  await writeFile(staging, originalFile)
  const upload = await owner.commit(binding, { target: binding.target, operationId, destination: { kind: 'attachment', name: '中文 原附件' }, bytes: originalFile.length, mimeType: 'text/plain' }, staging, access)
  assert.equal(upload.status, 'applied'); await uploads.associate(source.id, operationId, [operationId]); const [uploadedInput] = await uploads.inputs(source.id, [operationId])
  // Only the source RPC boundary is controlled; projection, grants, native
  // image store, Session attachment reader and official gallery remain real.
  const api = (f.remote as unknown as { api: HhpiRemoteApi }).api
  const imageReads: string[] = []
  api.resource = async request => {
    assert.equal(request.sessionId, source.id)
    imageReads.push(request.path)
    return { ok: true, value: await attachments.read(request.path) }
  }
  history.beginTurn(source, { id: 'native-turn', status: 'inProgress', items: [] })
  history.acceptItem(source, 'native-turn', { id: 'reason-a', type: 'reasoning', summary: ['Process A'] }, false)
  f.ctx.reflect.provide('chatPresentationConsumer', { presentation: () => ({ foldCompletedTurns: false, stepGrouping: 'collapsed', virtualizeGroupMembers: false, liveProcessExpansion: true }) })
  const pane = await f.open('presentation'), chat = pane.conversation.target('chat')
  await f.ctx.plugin({ name: 'native-presentation-contract', inject: ['slots', 'uiConversation'], apply(ctx: Context) {
    const stops = [installSourceTranscript(ctx, fileClient), installSourceChatFiles(ctx, fileClient), installToolProgressDisplay(ctx)]
    const workspaces = { items: [], phase: 'ready' }, panelInfo = { activePanelId: null }
    ctx.slots.provideRoot({ hooks: {
      workspaces: { getSnapshot: () => workspaces, subscribe: () => () => {} },
      panelInfo: { getSnapshot: () => panelInfo, subscribe: () => () => {} },
    } })
    ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'hhpi.test.native-presentation': { kind: 'single', scope: 'session' } } },
      (props: PropsRuntime<'root'> & PropsRenderSlots<'hhpi.test.native-presentation'>) => createElement(props.SessionProvider,
        { session: pane.reference, children: props.renderSlot('hhpi.test.native-presentation', {}) }))
    ctx.slots.register({ name: 'hhpi.test.native-presentation' }, (props: PropsRenderFactories) => props.renderFactorySlot('conversation.content', ACTIVE_CONVERSATION_INPUT))
    return () => { for (const stop of stops.reverse()) stop() }
  } })
  const container = f.dom.window.document.getElementById('root')!
  let unmount: (() => void) | undefined
  const headers = () => [...container.querySelectorAll<HTMLButtonElement>('[data-process-activity]')]
  const row = (text: string) => [...container.querySelectorAll<HTMLElement>('[data-chat-flow-kind="assistant-step"]')].find(element => element.textContent?.includes(text))
  const commit = async (write: () => void | Promise<void>, accepted: () => boolean) => {
    const done = Promise.withResolvers<void>()
    const stop = chat.subscribe(() => { if (accepted()) done.resolve() })
    try {
      await act(async () => { await write(); if (accepted()) done.resolve(); await done.promise })
      await act(async () => { await new Promise<void>(resolve => f.dom.window.requestAnimationFrame(() => resolve())) })
    }
    finally { stop() }
  }
  try {
    await act(async () => { unmount = f.ctx.uiRenderer.mount(container) })
    const first = headers()[0]!
    assert.ok(first)
    assert.equal(first.getAttribute('aria-expanded'), 'true')
    assert.ok(row('Process A'), 'the process is actual native reasoning content, not a disclosure-only fixture')
    await commit(() => {
      history.acceptItem(source, 'native-turn', { id: 'reason-a', type: 'reasoning', summary: ['Process A'] }, true)
      history.acceptItem(source, 'native-turn', { id: 'reply-a', type: 'agentMessage', text: 'Ordinary response A' }, true)
    }, () => f.body(pane).includes('Ordinary response A'))
    assert.equal(headers()[0], first)
    assert.equal(first.getAttribute('aria-expanded'), 'false')
    assert.equal(row('Ordinary response A')?.closest('[data-chat-group-key]'), null)
    await commit(() => history.acceptItem(source, 'native-turn', { id: 'reason-b', type: 'reasoning', summary: ['Process B'] }, false), () => f.body(pane).includes('Process B'))
    const second = headers()[1]!
    assert.ok(second, JSON.stringify([...container.querySelectorAll<HTMLElement>('[data-chat-flow-kind]')].slice(-8).map(element => ({ kind: element.dataset.chatFlowKind, part: element.dataset.chatGroupPart, text: element.textContent?.slice(0, 150) }))))
    assert.equal(first.getAttribute('aria-expanded'), 'false')
    assert.equal(second.getAttribute('aria-expanded'), 'true')
    await act(async () => { first.click(); second.click() })
    assert.equal(first.getAttribute('aria-expanded'), 'true')
    assert.equal(second.getAttribute('aria-expanded'), 'false')
    await commit(() => {
      history.acceptItem(source, 'native-turn', { id: 'reason-b', type: 'reasoning', summary: ['Process B'] }, true)
      history.acceptItem(source, 'native-turn', { id: 'plan', type: 'plan', text: '1. Keep the result readable' }, true)
    }, () => f.body(pane).some(text => text.includes('<proposed_plan>')))
    assert.equal(row('Keep the result readable')?.closest('[data-chat-group-key]'), null)
    assert.equal(first.getAttribute('aria-expanded'), 'true', 'ordinary source content cannot overwrite a manual expansion')
    assert.equal(second.getAttribute('aria-expanded'), 'false', 'a manually closed live group stays closed')
    await commit(() => history.acceptItem(source, 'native-turn', { id: 'historical-user-file', type: 'userMessage', clientId: operationId,
      content: [uploadedInput, { type: 'text', text: 'Historical file request' }] }, true),
      () => history.itemState('native-turn', 'historical-user-file')?.presentationContent?.some(block => block.type === 'file') ?? false)
    const fileButton = container.querySelector<HTMLButtonElement>('[aria-label="Open source file 中文 原附件"]')
    assert.ok(fileButton, 'the admitted native receipt reaches the installed official user.file Slot')
    assert.equal(fileButton.querySelector('button,a'), null, 'the official card must not nest interactive elements inside the source action')
    assert.equal(fileButton.firstElementChild?.tagName, 'SPAN', 'the published official file card remains the original span')
    const readOriginal = async (button: HTMLButtonElement, kind: 'artifact' | 'generated-media') => {
      const previous = opened.length
      await act(async () => { button.click() })
      assert.equal(opened.length, previous + 1)
      const resource = parseWorkspaceDocumentAddress(opened.at(-1)!)
      assert.ok(resource); assert.deepEqual(resource.target, binding.target); assert.equal(resource.document.kind, kind)
      const loaded = await loadWorkspaceArtifact(fileClient, resource, lifetime.signal)
      return { loaded, bytes: await readWorkspaceArtifactBytes(loaded, lifetime.signal) }
    }
    const original = await readOriginal(fileButton, 'artifact')
    assert.equal(original.loaded.metadata.fileName, '中文 原附件')
    assert.deepEqual(original.bytes, new Uint8Array(originalFile))
    await commit(async () => {
      history.acceptItem(source, 'native-turn', { id: 'historical-user-image', type: 'userMessage', content: [
        { type: 'text', text: 'Historical image upload' }, { type: 'localImage', path: '/synthetic/history-upload.png' },
      ] }, true)
      attachments.schedule(f.index.read({ sessionId: source.id, limit: 100 }).entries)
      await historicalImagePrepared.promise
    }, () => history.itemState('native-turn', 'historical-user-image')?.presentationContent?.some(block => block.type === 'image') ?? false)
    const historicalImage = [...container.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"]')]
      .find(element => element.textContent?.includes('Historical image upload'))
    assert.ok(historicalImage?.querySelector('[data-align]'), 'historical native user images use the official gallery')
    assert.equal(container.querySelector('[aria-label="Open source file history-upload.png"]'), null,
      'the official gallery keeps its own open/download actions without an extra source-storage action')
    await commit(async () => {
      history.acceptItem(source, 'native-turn', { id: 'generated-image', type: 'imageGeneration', savedPath: '/synthetic/generated.png', status: 'completed' }, true)
      attachments.schedule(f.index.read({ sessionId: source.id, limit: 100 }).entries)
      await prepared.promise
    }, () => [...chat.getSnapshot()!.nodes.values()].some(node => node.kind === 'assistant-step' && (node as ChatNode<'assistant-step'>).data.blocks.some(block => block.kind === 'image')))
    const imageRow = [...container.querySelectorAll<HTMLElement>('[data-chat-flow-kind="assistant-step"]')].find(element => element.querySelector('[data-align]'))
    assert.ok(imageRow, 'the actual official gallery must render the prepared native image')
    assert.equal(imageRow.closest('[data-chat-group-key]'), null, 'a generated image is answer material outside the process disclosure')
    assert.equal(imageRow.querySelectorAll('[data-align]').length, 1, 'delegating the image Slot renders the official gallery once')
    assert.equal(imageRow.querySelector('.hhpi-source-image-originals'), null,
      'the removed source-original toolbar is not reintroduced by Slot delegation')
    assert.ok(imageReads.some(path => path.startsWith('attachment:')), 'the gallery reads its granted native image through the actual Session attachment method')
    const originalFailure = `Native failure remains readable\n${'Original detailed failure output\n'.repeat(30)}`
    const commandResult = () => [...chat.getSnapshot()!.nodes.values()].flatMap(node => {
      if (node.kind !== 'tool-call') return []
      const block = (node as ChatNode<'tool-call'>).data.root
      return 'kind' in block && block.kind === 'tool-result' && block.callId.includes('failed-command') ? [block] : []
    })
    await commit(() => history.acceptItem(source, 'native-turn', { id: 'failed-command', type: 'commandExecution', command: 'synthetic-failure', aggregatedOutput: originalFailure, exitCode: 7, status: 'completed' }, true),
      () => commandResult().some(block => block.isError))
    assert.equal(commandResult().length, 1, 'a command failure has one official tool result')
    assert.ok(JSON.stringify(commandResult()[0]!.content).includes('Original detailed failure output'), 'native tool details retain the failure output')
    assert.equal(container.querySelector('.hhpi-native-tool-failure') !== null, false, 'an ordinary command failure does not create an extra user alert')
    assert.equal([...chat.getSnapshot()!.nodes.values()].some(node => String(node.kind) === 'hhpi-native-tool-failure'), false, 'no additional failure node enters the reading flow')
    assert.doesNotMatch(container.textContent!, /Source tool failed|源工具执行失败/)
    await commit(() => history.acceptItem(source, 'native-turn', { id: 'failed-command', type: 'commandExecution', command: 'synthetic-failure', aggregatedOutput: 'Source corrected this result', exitCode: 0, status: 'completed' }, true),
      () => commandResult().some(block => !block.isError))
    assert.equal(commandResult().length, 1, 'a corrected result updates its native tool row')
    assert.ok(JSON.stringify(commandResult()[0]!.content).includes('Source corrected this result'))
    await commit(() => history.acceptTurn(source, { id: 'native-turn', status: 'completed', items: [] }),
      () => chat.getSnapshot()?.timeline.turns.get(1)?.status === 'closed')
    assert.equal(first.getAttribute('aria-expanded'), 'true')
    assert.equal(second.getAttribute('aria-expanded'), 'false')
    assert.equal(f.writes.length, 0)
  } finally {
    if (unmount) await act(async () => unmount?.())
    lifetime.abort(); await attachments.dispose(); await storage.fiber.dispose(); await rm(directory, { recursive: true, force: true }); geometry.dispose()
  }
})
