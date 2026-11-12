/** Current source row facts; no independent session polling. */
import { useSyncExternalStore } from 'react'
import type { SourceSession } from '../remote/protocol.ts'
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

export function SessionRowState({ source, t }: { source: SourceSession | undefined; t: WorkspaceTranslate }) {
    const pending = source?.pendingRequests.length ?? 0
    return pending > 0 ? <span className="hapi-session-request-count" title={t('pendingRequestCount', { n: pending })}
        aria-label={t('pendingRequestCount', { n: pending })}>! {pending}</span> : null
}

/** Synchronization acknowledgement remains distinct from the unread activity dot. */
export function ReadStateIndicator({ status, chinese }: { status: 'pending' | 'ready' | 'error' | 'unavailable' | undefined; chinese: boolean }) {
    if (!status || status === 'ready') return null
    const label = status === 'pending' ? chinese ? '阅读状态同步中' : 'Synchronizing reading state'
        : status === 'unavailable' ? chinese ? '原始阅读位置不可用' : 'Original reading position unavailable'
        : chinese ? '阅读状态尚未同步' : 'Reading state is not synchronized'
    return <span className="hapi-session-read-state" role="status" aria-label={label} title={label}>{status === 'pending' ? '↻' : '?'}</span>
}
