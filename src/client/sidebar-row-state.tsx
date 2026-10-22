/** Source row facts layered on the HAPI sidebar; no independent session polling. */
import { useSyncExternalStore } from 'react'
import type { CatalogSession } from '../client-api.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { sessionRelativeTime, sourceTimeMilliseconds } from '../workspace/sidebar-row.ts'

// Original HAPI's shared minute clock; a clock tick only refreshes time labels,
// not the catalog, search index, ordering, or every virtual row's content.
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
let now = Date.now()
function tick(): void {
    now = Date.now()
    for (const listener of listeners) listener()
    timer = listeners.size ? setTimeout(tick, 60_000 - Date.now() % 60_000) : undefined
}
function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (!timer) { now = Date.now(); timer = setTimeout(tick, 60_000 - now % 60_000) }
    return () => { listeners.delete(listener); if (!listeners.size) { clearTimeout(timer); timer = undefined } }
}
const snapshot = (): number => now
const serverSnapshot = (): number => 0

export function SessionTime({ at, t }: { at: number; t: WorkspaceTranslate }) {
    const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
    const milliseconds = sourceTimeMilliseconds(at), label = sessionRelativeTime(at, t, current)
    if (milliseconds === null || label === null) return null
    return <time className="hapi-session-time" dateTime={new Date(milliseconds).toISOString()} title={new Date(milliseconds).toLocaleString()}>{label}</time>
}

export function SessionRowState({ state, detailed, t }: { state: CatalogSession['sourceRowState']; detailed: boolean; t: WorkspaceTranslate }) {
    if (!state) return null
    const progress = state.todoProgress && state.todoProgress.completed < state.todoProgress.total ? state.todoProgress : null
    const pending = state.pendingRequestsCount, scheduled = state.futureScheduledMessageCount, background = state.backgroundTaskCount
    const scheduledTime = state.nextScheduledAt === null ? null : sourceTimeMilliseconds(state.nextScheduledAt)
    return <>
        {state.serviceTier === 'fast' && <span className="hapi-session-tier" aria-label={t('fastServiceTier')} title={t('fastServiceTier')}>ϟ</span>}
        {progress && <span className="hapi-session-todos" aria-label={t('todoProgress', progress)} title={t('todoProgress', progress)}><span aria-hidden="true">◈</span> {progress.completed}/{progress.total}</span>}
        {pending !== null && pending > 0 && <span className="hapi-session-request-count" title={t('pendingRequestCount', { n: pending })} aria-label={t('pendingRequestCount', { n: pending })}>! {pending}</span>}
        {detailed && background !== null && background > 0 && <span className="hapi-session-background-count" title={t('backgroundTaskCount', { n: background })} aria-label={t('backgroundTaskCount', { n: background })}>◌ {background}</span>}
        {detailed && scheduled !== null && scheduled > 0 && <span className="hapi-session-scheduled" aria-label={t('scheduledMessageCount', { n: scheduled })}
            title={[t('scheduledMessageCount', { n: scheduled }), scheduledTime === null ? null : new Date(scheduledTime).toLocaleString()].filter(Boolean).join('\n')}>◷ {scheduled}</span>}
    </>
}
