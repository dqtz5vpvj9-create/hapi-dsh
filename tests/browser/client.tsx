/** Real installed official UI and production HHPI readers; only shell and IO are fixtures. */
import { createElement, useState } from 'react'
import { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MountedChatV1 } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime, PropsRenderFactories, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { createWindowCommitFactory } from 'hhpi-window-commit'
import { ACTIVE_CONVERSATION_INPUT } from '../contracts/conversation-content-input.ts'
import { RemoteSessions } from '../../src/client/remote-sessions.ts'
import { SourceSessions } from '../../src/client/source-sessions.ts'
import { RemotePaneSession } from '../../src/client/remote-reading-session.ts'
import { installSeamlessHistory, type SeamlessHistoryEvent } from '../../src/client/seamless/controller.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import type { SourceChanges } from '../../src/remote/protocol.ts'
import { readingAnchor, anchorDrift, stableAnchorDrift, waitForOlderSourceCommit, observeReadingCommit } from './reading-probe.ts'
import { installSourceCommandViews } from '../../src/client/source-command-view.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'hhpi.lab.pane': { kind: 'single'; scope: 'session' } } }
const runtime = window as unknown as { __HHPI_REQUIRE__(id: string): any; __hhpi: any; __hhpiFailure?: string }
function store<T>(value: T) {
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set(next: T): void { value = next; for (const fn of listeners) fn() } }
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-hhpi-fixture': '1' }, body: JSON.stringify(body) }) })
  if (!response.ok) throw new Error(`Synthetic transport returned ${response.status}`)
  return response.json() as Promise<T>
}
const ctx = new Context(), controls = new Map<string, MountedChatV1>()
const original = { list: store({ ids: [], byId: {}, phase: 'ready' }), windowCommit: createWindowCommitFactory(),
  binding: () => undefined, scope: () => undefined, scopeOf: () => undefined, sessionOf: () => undefined,
  retainInfo: () => store({ referenceCount: 0, retainedBy: {} }), searchResultLimit: 100, refresh: async () => {} } as unknown as ISessions
const api: HhpiRemoteApi = {
  catalog: signal => request('/api/catalog', undefined, signal),
  read: (value, signal) => request('/api/read', value, signal),
  operate: value => request('/api/operate', value),
  resource: (value, signal) => request('/api/resource', value, signal),
  async *changes(value, signal): AsyncIterable<SourceChanges> {
    const response = await fetch('/api/changes?request=' + encodeURIComponent(JSON.stringify(value)), { signal })
    if (!response.ok || !response.body) throw new Error('Synthetic change stream unavailable')
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffered = ''
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break
        buffered += decoder.decode(item.value, { stream: true })
        let at: number
        while ((at = buffered.indexOf('\n')) >= 0) { yield JSON.parse(buffered.slice(0, at)); buffered = buffered.slice(at + 1) }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  },
} as HhpiRemoteApi
const remote = new RemoteSessions(ctx, original, api), sessions = new SourceSessions(remote)
await remote.refresh()
ctx.reflect.provide('sessions', sessions)
const { RemoteStream } = runtime.__HHPI_REQUIRE__('@deepseek-ai/dsh-api-gateway/client') as typeof import('@deepseek-ai/dsh-api-gateway/client')
const generation = store({} as never)
ctx.reflect.provide('remote', { $on: () => () => {}, $host: { home: '/synthetic' },
  $stream: options => new RemoteStream({ generation }, options) } as Context['remote'])
ctx.reflect.provide('remote.session', {} as never)
ctx.reflect.provide('remoteAccess', { source: () => store(true) } as unknown as Context['remoteAccess'])
const dictionaries = new Map<string, Record<string, string>>()
const localeState = store({ revision: 0, active: 'en' })
const translate = (namespace: string) => (key: string, params: Record<string, unknown> = {}): string => {
  const value = dictionaries.get(namespace)?.[key] ?? key
  return value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}
ctx.reflect.provide('locale', { ...localeState, register(namespace: string, values: { en: Record<string, string> }) { dictionaries.set(namespace, values.en); return () => { dictionaries.delete(namespace) } }, bind: translate } as unknown as Context['locale'])
ctx.reflect.provide('configForms', { get: () => ({ ...store({ value: {} }), set: async () => {} }), developerTools: { enabled: store(false) } } as unknown as Context['configForms'])
ctx.reflect.provide('uiWorkspace', { openSession: () => {}, openWorkspace: async () => {} } as unknown as Context['uiWorkspace'])
ctx.reflect.provide('fileUpload', {} as Context['fileUpload'])
ctx.reflect.provide('sidebarRight', { openResource: () => {}, openTab: () => {} } as unknown as Context['sidebarRight'])
for (const name of ['renderer', 'session', 'conversation', 'chat']) {
  await ctx.plugin(runtime.__HHPI_REQUIRE__(`@deepseek-ai/dsh-client-ui-${name}`))
  if (name === 'renderer') ctx.slots.installLocale({ ...localeState, bind: translate })
}
if (new URLSearchParams(location.search).has('codex-rendering')) {
  await ctx.plugin(runtime.__HHPI_REQUIRE__('@deepseek-ai/dsh-client-ui-tool'))
  await ctx.plugin(runtime.__HHPI_REQUIRE__('@deepseek-ai/dsh-client-ui-attachment'))
  ctx.effect(() => installSourceCommandViews(ctx))
}
ctx.reflect.provide('mountedChatConsumer', { onMountedChat(control: MountedChatV1 | null, element: HTMLElement) {
  const id = element.closest<HTMLElement>('[data-lab-pane]')?.dataset.labPane
  if (!id) throw new Error('Official reader lost its occurrence')
  if (control) controls.set(id, control); else controls.delete(id)
} })
const id = sessions.list.getSnapshot().ids[0]!
const canonical = sessions.retain(id, { source: 'hapiWorkspace' })
await canonical.ready
async function open(viewId: string) {
  const reference = sessions.openReadingView(canonical, viewId)
  if (!reference) throw new Error('Installed source occurrence capability unavailable')
  const conversation = ctx.uiConversation.binding(reference.binding), reading = conversation.readingView
  if (!reading) throw new Error('Official reading window unavailable')
  const session = reference.binding.session as RemotePaneSession
  session.attach(reading); await reference.ready
  return { reference, conversation, reading, session, input: ctx.conversation.input.for(reference.binding.ctx) }
}
const panes = { a: await open('browser-a'), b: await open('browser-b') }
function owner(element?: HTMLElement) { const key = element?.closest<HTMLElement>('[data-lab-pane]')?.dataset.labPane; return key === 'a' || key === 'b' ? { id: key, ...panes[key] } : undefined }
const events: SeamlessHistoryEvent[] = [], corrections: Array<{ key: string; delta: number | null; requestDelta: number | null }> = []
const readingFailures: string[] = []
const stopPaging = installSeamlessHistory(document, {
  loadEarlierLabel: () => translate('chat')('chat.loadOlder'),
  sourceWindowProgress: (_id, element) => owner(element)?.session.sourceWindow.getSnapshot(),
  subscribeSourceWindow: (_id, listener, element) => owner(element)?.session.sourceWindow.subscribe(listener),
  cancelSourcePage: (_id, reason, element) => owner(element)?.session.cancelOlderPage(reason),
  loadOlderProgrammatically: async (element, _id, signal) => {
    const pane = owner(element), control = pane && controls.get(pane.id)
    if (!control) return false
    const participation = pane.conversation.windowCommit
    if (!participation) throw new Error('The official commit checkpoint is unavailable.')
    const requested = readingAnchor(element)
    const previousRevision = pane.session.sourceWindow.getSnapshot().olderRevision ?? 0
    const probe = observeReadingCommit(element, participant => participation.register(pane.reference.binding.viewId!, participant))
    const cancel = (): void => pane.session.cancelOlderPage(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await control.loadOlder(signal)
      await waitForOlderSourceCommit(pane.session.sourceWindow, pane.session, pane.reading.snapshot, previousRevision, signal)
      const before = probe.anchor()
      if (!before || probe.count() !== 1) throw new Error('The older read did not produce exactly one measured official commit.')
      const delta = await stableAnchorDrift(element, before, { signal })
      corrections.push({ key: before.key, delta, requestDelta: requested ? anchorDrift(element, requested) : null })
      return true
    } catch (error) {
      readingFailures.push(error instanceof Error ? error.stack ?? error.message : String(error))
      throw error
    } finally { probe.release(); signal.removeEventListener('abort', cancel) }
  },
  loadAfter: async element => owner(element)?.session.loadAfter() ?? false,
  returnToLive: async (element, _id, signal) => { const pane = owner(element); if (!pane) return false; await controls.get(pane.id)!.toLatest(signal); return true },
  onEvent: event => events.push(event),
})
await ctx.plugin({ name: 'hhpi-browser-lab-shell', inject: ['slots'], apply(context: Context) {
  context.slots.provideRoot({ hooks: { workspaces: store({ items: [], phase: 'ready' }), panelInfo: store({ activePanelId: null }) } })
  context.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'hhpi.lab.pane': { kind: 'single', scope: 'session' } } },
    function Shell(props: PropsRuntime<'root'> & PropsRenderSlots<'hhpi.lab.pane'>) {
      const [active, setActive] = useState('a')
      return createElement('main', { className: 'lab' },
        createElement('nav', { className: 'lab-toolbar', 'aria-label': 'Synthetic pane selection' },
          ...(['a', 'b'] as const).map(key => createElement('button', { key, 'data-select-pane': key, onClick: () => setActive(key) }, `Pane ${key.toUpperCase()}`))),
        createElement('div', { className: 'lab-panes' }, ...(['a', 'b'] as const).map(key => createElement('section', {
          key, className: 'hapi-pane', 'data-pane-id': key, 'data-lab-pane': key, 'data-lab-active': String(active === key),
          'data-hapi-pane-visible': String(innerWidth > 600 || active === key),
        }, createElement(props.SessionProvider, { session: panes[key].reference }, props.renderSlot('hhpi.lab.pane', {}))))))
    })
  context.slots.register({ name: 'hhpi.lab.pane' }, (props: PropsRenderFactories) => props.renderFactorySlot('conversation.content', ACTIVE_CONVERSATION_INPUT))
} })
const unmount = ctx.uiRenderer.mount(document.getElementById('root')!)
const frames: number[] = []; let last = 0, raf = 0, collecting = true
function sample(now: number): void { if (last) frames.push(now - last); last = now; if (collecting) raf = requestAnimationFrame(sample) }
raf = requestAnimationFrame(sample)
function snapshot() {
  const result = Object.fromEntries((['a', 'b'] as const).map(key => {
    const pane = panes[key], state = pane.reading.snapshot.getSnapshot(), chat = pane.conversation.target('chat').getSnapshot()
    return [key, { rows: chat?.order.length ?? 0, before: state.before, busy: state.busy, phase: state.phase, draft: pane.input.state.getSnapshot().draft, control: !!controls.get(key) }]
  }))
  return { ...result, errors: events.filter(event => event.type === 'failed' || event.type === 'suspended').map(event => ({ type: event.type, detail: event.detail })), corrections, readingFailures,
    frames: { samples: frames.length, p95: [...frames].sort((a, b) => a - b)[Math.floor(frames.length * .95)] ?? null, max: frames.length ? Math.max(...frames) : null } }
}
runtime.__hhpi = {
  ready: true, snapshot,
  async latest(key: 'a' | 'b'): Promise<void> { const control = controls.get(key); if (!control) throw new Error('No mounted control'); await control.toLatest() },
  async dispose(): Promise<void> { collecting = false; cancelAnimationFrame(raf); stopPaging(); unmount(); panes.a.reference.release(); panes.b.reference.release(); canonical.release(); sessions.dispose(); remote.dispose(); await ctx.fiber.dispose() },
}
