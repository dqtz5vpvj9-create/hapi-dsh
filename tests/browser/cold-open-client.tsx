/** Production SessionViewHost over an unprepared native source; official UI is unmodified. */
import { createElement, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteSessions } from '../../src/client/remote-sessions.ts'
import type { WorkspacePaneNavigation } from '../../src/client/pane-navigation.ts'
import { installSessionViewHost } from '../../src/client/surface/session-view.tsx'
import { resolveMountedChatForPane } from '../../src/client/mounted-chat-control.ts'
import { installNativeComposerAdmission } from '../../src/client/native-composer.ts'
import { en } from '../../src/client/locales.ts'

function state<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of listeners) listener() } }
}
export async function mountColdOpenLab(ctx: Context, canonical: SessionReference, sessions: RemoteSessions, remote: RemoteSessions) {
  const start = performance.now(), failures: string[] = [], ready = new Set<string>(), readyAt = new Map<string, number>()
  const paneStates = { a: state({ visible: true, focused: true }), b: state({ visible: innerWidth > 600, focused: false }) }
  const navigations = Object.fromEntries((['a', 'b'] as const).map(id => [id, { hostId: 'local', paneId: id,
    state: paneStates[id], reading: state(undefined) }])) as unknown as Record<'a' | 'b', WorkspacePaneNavigation>
  const stopAdmission = installNativeComposerAdmission(sessions, ctx.conversation.blocks, { t: key => en[key], subscribe: () => () => {} })
  let host!: ReturnType<typeof installSessionViewHost>
  await ctx.plugin({ name: 'cold-open-lab-shell', inject: ['slots', 'sessions', 'uiConversation'], apply(context: Context) {
    context.slots.provideRoot({ hooks: { workspaces: state({ items: [], phase: 'ready' }), panelInfo: state({ activePanelId: null }) } })
    context.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } } },
      function Shell(props: PropsRenderSlots<'shell.overlay'>) {
        const [active, setActive] = useState('a')
        const select = (key: 'a' | 'b') => {
          setActive(key)
          for (const id of ['a', 'b'] as const) paneStates[id].set({ visible: innerWidth > 600 || id === key, focused: id === key })
        }
        return createElement('main', { className: 'lab' },
          createElement('nav', { className: 'lab-toolbar' }, ...(['a', 'b'] as const).map(id => createElement('button', {
            key: id, 'data-select-pane': id, onClick: () => select(id),
          }, `Pane ${id.toUpperCase()}`))),
          createElement('div', { className: 'lab-panes' }, ...(['a', 'b'] as const).map(id => createElement('section', {
            key: id, id: `cold-pane-${id}`, className: 'hapi-pane', 'data-lab-pane': id, 'data-lab-active': String(active === id),
          }))), props.renderSlot('shell.overlay', {}))
      })
    host = installSessionViewHost(context)
    return () => host.dispose()
  } })
  const unmount = ctx.uiRenderer.mount(document.getElementById('root')!)
  // React owns these two target seats; all conversation descendants are the
  // same official portals used by the production workspace.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const targets = Object.fromEntries(['a', 'b'].map(id => [id, document.getElementById(`cold-pane-${id}`)!])) as Record<'a' | 'b', HTMLElement>
  if (!targets.a || !targets.b) throw new Error('Cold native lab did not mount its workspace seats')
  const mount = (id: 'a' | 'b') => host.mount({ paneId: id, target: targets[id], reference: canonical, navigation: navigations[id],
    onReady: () => { ready.add(id); if (!readyAt.has(id)) readyAt.set(id, Math.round(performance.now() - start)) }, onError: error => failures.push(error instanceof Error ? error.message : String(error)) })
  const handles = { a: mount('a'), b: mount('b') }
  const runtime = window as unknown as { __hhpi: unknown }
  runtime.__hhpi = { ready: true,
    snapshot: () => ({ firstReadMs: readyAt.get('a') ?? null, ready: [...ready], failures,
      sendLabel: ctx.locale.bind('conversation')('input.send'), readonly: ctx.conversation.blocks.storeFor(canonical.sessionId).getSnapshot()?.reason ?? null,
      panes: Object.fromEntries(['a', 'b'].map(id => [id, {
        visible: targets[id as 'a' | 'b'].querySelector<HTMLElement>('[data-hapi-session-reveal]')?.style.visibility,
        body: targets[id as 'a' | 'b'].textContent?.includes('native-body-') ?? false,
      }])) }),
    async older(id: 'a' | 'b') { const reader = resolveMountedChatForPane(targets[id]); if (!reader) throw new Error('Native Pane has no official reader'); await reader.loadOlder() },
    async reopen() { ready.delete('a'); await handles.a.dispose(); handles.a = mount('a') },
    async dispose() {
      await Promise.all([handles.a.dispose(), handles.b.dispose()]); stopAdmission(); unmount()
      canonical.release(); remote.dispose(); await ctx.fiber.dispose()
    },
  }
}
