import { useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceViewportSession } from '../source-sessions.ts'
import type { RemotePaneSession } from '../remote-reading-session.ts'
import { useWorkspacePane } from './pane-context.tsx'

const emptySourceWindow = Object.freeze({ hasMoreAfter: false, before: null })
const noSourceWindow = {
    getSnapshot: () => emptySourceWindow,
    subscribe: (_listener: () => void) => () => {},
}
const noReading = { getSnapshot: () => undefined, subscribe: (_listener: () => void) => () => {} }

/** Every direct-source action remains on the selected official reading occurrence. */
export function installSourceWindowNavigation(ctx: Context): () => void {
    const Latest = (props: PropsRuntime<'conversation.input.dock'> & PropsLocale<'chat'>) => {
        const { sessionId, useSession, t } = props
        const pane = useWorkspacePane(ctx)
        const session = (props.sessionBinding ?? ctx.sessions.binding(sessionId))?.session as
            (SessionFace & Partial<SourceViewportSession & RemotePaneSession>) | undefined
        const window = session?.sourceWindow
        const sourceWindow = useSyncExternalStore(window?.subscribe ?? noSourceWindow.subscribe,
            window?.getSnapshot ?? noSourceWindow.getSnapshot, window?.getSnapshot ?? noSourceWindow.getSnapshot)
        const reader = session?.readingView
        const reading = useSyncExternalStore(reader?.snapshot.subscribe ?? noReading.subscribe,
            reader?.snapshot.getSnapshot ?? noReading.getSnapshot, reader?.snapshot.getSnapshot ?? noReading.getSnapshot)
        const legacyBusy = useSession(value => value.loadingOlder)
        const [retryError, setRetryError] = useState<string | undefined>()
        const busy = reading?.busy ?? legacyBusy
        const failure = reading?.phase === 'error' || reading?.correction === 'failed' || sourceWindow.pagingError
        const detached = reading?.hasAfter ?? sourceWindow.hasMoreAfter
        if (!pane || (!detached && !failure)) return null
        if (failure) return <div className="hapi-source-latest hapi-history-page-error"
            data-history-page-error role="status" aria-live="polite">
            <span>{retryError ?? t('chat.loadError', { message: t('chat.loadOlder'), code: reading?.failure ?? 'history_page_failed' })}</span>
            <button type="button" disabled={busy} onClick={() => {
                setRetryError(undefined)
                const recovery = reader ? reader.refresh() : session?.loadOlder()
                void recovery?.catch((error: unknown) => { setRetryError(error instanceof Error ? error.message : String(error)) })
            }}>{busy ? t('chat.loadingHistory') : t('chat.loadOlder')}</button>
        </div>
        return <div className="hapi-source-latest">
            <button type="button" aria-label={t('chat.toBottom')} disabled={busy}
                onClick={() => pane.locate({ kind: 'latest' })}>{t('chat.toBottom')} ↓</button>
        </div>
    }
    return ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'hapi.source-latest', order: -100, locale: 'chat',
    }, Latest))
}
