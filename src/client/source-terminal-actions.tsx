/** Public keyed-seat composition of the unchanged official Terminal component. */
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, LocaleNamespaceMap, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './workspace-ui.ts'
import type {} from './pane-navigation.ts'
import { composedTerminalBody, type TerminalBodyFace } from './source-terminal/view.tsx'
import { en, zh, type TerminalTranslationKey } from './source-terminal/locales.ts'
import { terminalStyles } from './source-terminal/styles.ts'
import type { TerminalPublicView } from './source-terminal/input.ts'
import type { HapiRemoteApi } from '../client-api.ts'
import { terminalTheme } from './appearance/terminal-theme.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { hapiTerminalKeys: TerminalTranslationKey } }
export const OFFICIAL_TERMINAL_SEAT = '@deepseek-ai/dsh-client-ui-sidebar-terminal'

/** Public registry only: preserve the pinned original inject/locale; restore on dispose/reload. */
export function installSourceTerminalActions(ctx: Context, api?: Pick<HapiRemoteApi, 'nativeTerminalText'>): () => void {
  const unlocale = ctx.locale.register('hapiTerminalKeys', { en, zh })
  const style = document.createElement('style'); style.dataset.hapiTerminalActions = ''; style.textContent = terminalStyles; document.head.append(style)
  const removeScope = ctx.slots.inject('sidebar.right.pane.tab', () => {
    let original: StoredEntry | undefined, wrapped: ((props: TerminalBodyFace) => ReactNode) | undefined, remove: (() => void) | undefined, updating = false
    const update = (): void => {
      if (updating) return
      const entry = ctx.slots.entries('sidebar.right.pane.tab').find(candidate => candidate.options.key === OFFICIAL_TERMINAL_SEAT && candidate.component !== wrapped)
      if (entry === original) return
      updating = true
      try {
        remove?.(); remove = undefined; original = entry
        // The pinned terminal seat owns no store or child-slot subtree. A
        // different owner contract is left to that plugin instead of stolen.
        if (!entry || entry.children || entry.store || typeof entry.inject !== 'function') return
        wrapped = composedTerminalBody(ctx, entry.component as ComponentType<TerminalBodyFace>, ctx.locale.bind('hapiTerminalKeys'), api)
        const inject = entry.inject as (sessionId: SessionId) => { view: (key: string) => TerminalPublicView; hooks: { theme: HostObservable<ThemeSnapshot> } }
        remove = ctx.slots.register({ name: 'sidebar.right.pane.tab', key: OFFICIAL_TERMINAL_SEAT,
          priority: (entry.options.priority ?? 0) - 1,
          ...(entry.locale ? { locale: entry.locale as keyof LocaleNamespaceMap } : {}),
          inject: (sessionId: SessionId) => {
            const face = inject(sessionId)
            const preferences = ctx.get('hapiWorkspaceUi')?.preferences ?? ctx.get('hapiWorkspacePane')?.preferences
            return preferences && face.hooks?.theme
              ? { ...face, hooks: { ...face.hooks, theme: terminalTheme(face.hooks.theme, preferences) } }
              : face
          },
        }, wrapped)
      } finally { updating = false }
    }
    const unsubscribe = ctx.slots.subscribe('sidebar.right.pane.tab', update)
    update()
    return () => { unsubscribe(); remove?.() }
  })
  return () => { removeScope(); style.remove(); unlocale() }
}
