import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SourceViewportSession } from '../source-sessions.ts'
import { useWorkspacePane } from './pane-context.tsx'

const noSourceWindow = {
    getSnapshot: () => false,
    subscribe: (_listener: () => void) => () => {},
}

/** Short archive contexts have a local bottom but still omit newer source
 * history. The public dock offers the existing explicit latest destination;
 * Chat remains the sole owner of scrolling and tail following. */
export function installSourceWindowNavigation(ctx: Context): () => void {
    const Latest = ({ sessionId, useSession, t }: PropsRuntime<'conversation.input.dock'> & PropsLocale<'chat'>) => {
        const pane = useWorkspacePane(ctx)
        const session = ctx.sessions.binding(sessionId)?.session as Partial<SourceViewportSession> | undefined
        const window = session?.sourceWindow
        const hasMoreAfter = useSyncExternalStore(window?.subscribe ?? noSourceWindow.subscribe,
            window ? () => window.getSnapshot().hasMoreAfter : noSourceWindow.getSnapshot,
            window ? () => window.getSnapshot().hasMoreAfter : noSourceWindow.getSnapshot)
        const busy = useSession(value => value.loadingOlder)
        if (!pane || !hasMoreAfter) return null
        return <div className="hapi-source-latest">
            <button type="button" aria-label={t('chat.toBottom')} disabled={busy}
                onClick={() => pane.locate({ kind: 'latest' })}>{t('chat.toBottom')} ↓</button>
        </div>
    }
    const stopLatest = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'hapi.source-latest', order: -100, locale: 'chat',
    }, Latest))
    return () => { stopLatest() }
}
