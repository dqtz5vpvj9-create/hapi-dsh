import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationHistoryViewV1, HistoryViewSnapshotV1 } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SourceViewportSession } from '../source-session-types.ts'
import type { SourceWindowProgress } from '../source-session-types.ts'
import { useWorkspacePane } from './pane-context.tsx'
import { findChatElement, messageNodeTarget } from '../reading-anchor.ts'
import { resolveMountedChatForPane, subscribePaneMountedChat, type MountedChatControlV1 } from '../mounted-chat-control.ts'

type WindowProgress = { readonly hasMoreAfter: boolean } & Partial<SourceWindowProgress>
const emptySourceWindow: WindowProgress = Object.freeze({ hasMoreAfter: false, before: null })
const noSourceWindow = {
    getSnapshot: (): WindowProgress => emptySourceWindow,
    subscribe: (_listener: () => void) => () => {},
}
const noReading = { getSnapshot: (): HistoryViewSnapshotV1 | undefined => undefined, subscribe: (_listener: () => void) => () => {} }

/** Every direct-source action remains on the selected official reading occurrence. */
export function installSourceWindowNavigation(ctx: Context): () => void {
    const Latest = (props: PropsRuntime<'conversation.input.dock'> & PropsLocale<'chat'>) => {
        const { sessionId, useSession, t } = props
        const pane = useWorkspacePane(ctx)
        const binding = props.sessionBinding ?? ctx.sessions.binding(sessionId)
        const session = binding?.session as
            (SessionFace & Partial<SourceViewportSession> & { readonly readingView?: ConversationHistoryViewV1; readonly resumeReadingTarget?: number }) | undefined
        const window = session?.sourceWindow
        const sourceWindow = useSyncExternalStore<WindowProgress>(window?.subscribe ?? noSourceWindow.subscribe,
            window?.getSnapshot ?? noSourceWindow.getSnapshot, window?.getSnapshot ?? noSourceWindow.getSnapshot)
        const reader = session?.readingView
        const reading = useSyncExternalStore<HistoryViewSnapshotV1 | undefined>(reader?.snapshot.subscribe ?? noReading.subscribe,
            reader?.snapshot.getSnapshot ?? noReading.getSnapshot, reader?.snapshot.getSnapshot ?? noReading.getSnapshot)
        const legacyBusy = useSession(value => value.loadingOlder)
        const [retryError, setRetryError] = useState<string | undefined>()
        const dock = useRef<HTMLDivElement>(null)
        const [resumed, setResumed] = useState<{ session: object; seq: number }>()
        const opening = useRef({ session, intent: pane?.reading?.getSnapshot() })
        if (opening.current.session !== session) opening.current = { session, intent: pane?.reading?.getSnapshot() }
        const busy = reading?.busy ?? legacyBusy
        const failure = reading?.phase === 'error' || reading?.correction === 'failed' || sourceWindow.pagingError
        const detached = reading?.hasAfter ?? sourceWindow.hasMoreAfter
        const savedTarget = session?.resumeReadingTarget
        const resume = resumed?.session === session && resumed?.seq === savedTarget ? undefined : savedTarget
        useLayoutEffect(() => {
            if (!pane?.reading || !session || resume === undefined) return
            const changed = (): void => {
                const intent = pane.reading.getSnapshot()
                if (!intent || intent === opening.current.intent || intent.sessionId !== sessionId) return
                // Startup latest, page commits and source updates are not user
                // destinations. A newer explicit destination ends this offer.
                if (intent.target.kind !== 'message' || intent.target.messageId !== String(resume)) setResumed({ session, seq: resume })
            }
            const stop = pane.reading.subscribe(changed)
            changed()
            return stop
        }, [pane, session, sessionId, resume])
        useLayoutEffect(() => {
            if (!pane || !binding || !session || !reader || resume === undefined || failure) return
            const root = dock.current?.closest<HTMLElement>('[data-hhpi-reading-owner]')
            const frame = root?.ownerDocument.defaultView
            if (!root || !frame) return
            const chat = ctx.uiConversation.binding(binding).target('chat')
            let stopped = false, scheduled: number | undefined, control: MountedChatControlV1 | undefined
            let stopControl = (): void => {}
            const sample = (): void => {
                scheduled = undefined
                if (stopped || !pane.state.getSnapshot().visible || !root.isConnected || root.hidden
                    || root.ownerDocument.visibilityState === 'hidden' || !control) return
                const reading = reader.snapshot.getSnapshot(), facts = control.read()
                if (reading.phase !== 'ready' || reading.busy || reading.correction === 'failed' || facts.busy
                    || !facts.renderRevision || !control.renderedNode) return
                const snapshot = chat.getSnapshot(), target = messageNodeTarget(snapshot, resume, reading.entries)
                const node = target && snapshot?.nodes.get(target.key)
                if (!node || control.renderedNode(node.key) !== node) return
                const row = findChatElement(root, node.key), port = root.querySelector<HTMLElement>('[data-conversation-scroll]')
                if (!row || !port || !port.contains(row) || row.closest('[hidden],[aria-hidden="true"],[data-turn-process-hidden="true"]')
                    || !row.getClientRects().length || frame.getComputedStyle(row).visibility !== 'visible') return
                const box = port.getBoundingClientRect(), rect = row.getBoundingClientRect()
                const bottom = Math.min(frame.innerHeight, box.bottom - (port.querySelector<HTMLElement>('[data-composer-seat]')?.offsetHeight ?? 0))
                if (rect.height <= 0 || rect.width <= 0 || rect.bottom <= Math.max(0, box.top) || rect.top >= bottom
                    || rect.right <= Math.max(0, box.left) || rect.left >= Math.min(frame.innerWidth, box.right)) return
                // Only this occurrence's rendered, visible destination retires
                // its reminder. Loading a page or clicking a failed jump does not.
                setResumed({ session, seq: resume })
            }
            const schedule = (): void => { if (!stopped && scheduled === undefined) scheduled = frame.requestAnimationFrame(sample) }
            const mounted = (): void => {
                stopControl(); control = resolveMountedChatForPane(root)
                stopControl = control?.subscribe(schedule) ?? (() => {})
                schedule()
            }
            const stops = [subscribePaneMountedChat(root, mounted), pane.state.subscribe(schedule),
                reader.snapshot.subscribe(schedule), chat.subscribe(schedule)]
            const observer = new frame.MutationObserver(schedule)
            observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'data-hapi-reading'] })
            const navigation = (event: Event): void => {
                if (!event.isTrusted || !pane.state.getSnapshot().visible) return
                const button = (event.target as Element | null)?.closest?.('button')
                if (!button || button.disabled) return
                const latest = button.className.includes('toBottom') && button.getAttribute('aria-label') === t('chat.toBottom')
                const rail = button.closest('nav[aria-label]')
                const turn = button.getAttribute('data-index') !== null
                    && rail?.getAttribute('aria-label') === ctx.locale.bind('chat')('chat.turnNavigation.label')
                if (latest || turn) setResumed({ session, seq: resume })
            }
            root.addEventListener('click', navigation, true)
            root.addEventListener('scroll', schedule, { capture: true, passive: true })
            root.ownerDocument.addEventListener('visibilitychange', schedule)
            mounted()
            return () => {
                stopped = true
                if (scheduled !== undefined) frame.cancelAnimationFrame(scheduled)
                stopControl(); for (const stop of stops) stop(); observer.disconnect()
                root.removeEventListener('click', navigation, true)
                root.removeEventListener('scroll', schedule, true)
                root.ownerDocument.removeEventListener('visibilitychange', schedule)
            }
        }, [ctx, pane, binding, session, reader, resume, failure])
        if (!pane || (!detached && !failure && resume === undefined)) return null
        if (failure) return <div className="hapi-source-latest hapi-history-page-error"
            data-history-page-error role="status" aria-live="polite">
            <span>{retryError ?? t('chat.loadError', { message: t('chat.loadOlder'), code: reading?.failure ?? 'history_page_failed' })}</span>
            <button type="button" disabled={busy} onClick={() => {
                setRetryError(undefined)
                const recovery = reader ? reader.refresh() : session?.loadOlder()
                void recovery?.catch((error: unknown) => { setRetryError(error instanceof Error ? error.message : String(error)) })
            }}>{busy ? t('chat.loadingHistory') : t('chat.loadOlder')}</button>
        </div>
        return <div className="hapi-source-latest" ref={dock}>
            {resume !== undefined && <button type="button" disabled={busy} onClick={() => {
                pane.locate({ kind: 'message', messageId: String(resume), origin: 'link' })
            }}>{ctx.locale.getSnapshot().active.startsWith('zh') ? '继续上次阅读' : 'Continue reading'} ↑</button>}
            {detached && <button type="button" aria-label={t('chat.toBottom')} disabled={busy}
                onClick={() => pane.locate({ kind: 'latest' })}>{t('chat.toBottom')} ↓</button>}
        </div>
    }
    return ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'hapi.source-latest', order: -100, locale: 'chat',
    }, Latest))
}
