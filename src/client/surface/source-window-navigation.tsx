import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceViewportSession } from '../source-sessions.ts'
import { useWorkspacePane } from './pane-context.tsx'

const emptySourceWindow = Object.freeze({ hasMoreAfter: false, before: null })
const noSourceWindow = {
    getSnapshot: () => emptySourceWindow,
    subscribe: (_listener: () => void) => () => {},
}

/** Short archive contexts have a local bottom but still omit newer source
 * history. The public dock offers the existing explicit latest destination;
 * Chat remains the sole owner of scrolling and tail following. */
export function installSourceWindowNavigation(ctx: Context): () => void {
    const Latest = ({ sessionId, useSession, t }: PropsRuntime<'conversation.input.dock'> & PropsLocale<'chat'>) => {
        const pane = useWorkspacePane(ctx)
        const session = ctx.sessions.binding(sessionId)?.session as (SessionFace & Partial<SourceViewportSession>) | undefined
        const window = session?.sourceWindow
        const sourceWindow = useSyncExternalStore(window?.subscribe ?? noSourceWindow.subscribe,
            window?.getSnapshot ?? noSourceWindow.getSnapshot,
            window?.getSnapshot ?? noSourceWindow.getSnapshot)
        const busy = useSession(value => value.loadingOlder)
        if (!pane || (!sourceWindow.hasMoreAfter && !sourceWindow.pagingError)) return null
        if (sourceWindow.pagingError) return <div className="hapi-source-latest hapi-history-page-error"
            data-history-page-error role="status" aria-live="polite">
            <span>{t('chat.loadError', { message: t('chat.loadOlder'), code: 'history_page_failed' })}</span>
            <button type="button" disabled={busy} onClick={() => { void session?.loadOlder().catch(() => {}) }}>
                {busy ? t('chat.loadingHistory') : t('chat.loadOlder')}
            </button>
        </div>
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
