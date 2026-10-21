/** Local view preferences and read bookmarks; these never change native execution. */
import { DEFAULT_SESSION_PREVIEW_LIMIT, normalizeSessionPreviewLimit } from './sidebar-sections.ts'
export type SidebarFilter = 'all' | 'running' | 'attention' | 'unread'
export type SidebarPreferences = {
    mode: 'recent' | 'folders'; filter: SidebarFilter; engine: string; machine: string;
    collapsed: string[]; expanded: string[]; folderOrder: string[];
    pinInProgressSessions: boolean; showActiveSessionsOnly: boolean; sessionPreviewLimit: number;
    statusMode: 'standard' | 'detailed';
}
export type SidebarSnapshot = {
    preferences: SidebarPreferences; baseline: number;
    seen: Readonly<Record<string, number>>; unread: Readonly<Record<string, number>>;
}
export type ReadIntent = { id: string; kind: 'seen' | 'unread'; at: number }
const defaults = (): SidebarSnapshot => ({ preferences: { mode: 'recent', filter: 'all', engine: '', machine: '', collapsed: [], expanded: [], folderOrder: [],
    pinInProgressSessions: false, showActiveSessionsOnly: false, sessionPreviewLimit: DEFAULT_SESSION_PREVIEW_LIMIT, statusMode: 'standard' }, baseline: Date.now(), seen: {}, unread: {} })
const timestamps = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== 'object') return {}
    return Object.fromEntries(Object.entries(value).filter(([id, at]) => id.length <= 256 && typeof at === 'number' && Number.isFinite(at) && at >= 0))
}
export class SidebarState {
    private snapshot: SidebarSnapshot = defaults()
    private readonly listeners = new Set<() => void>()
    private readonly intents = new Set<(intent: ReadIntent) => void>()
    constructor(private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>, private readonly key = 'hapi-dsh:sidebar') {
        try {
            const limit = storage?.getItem('hapi-session-preview-limit')
            const originalStatus = storage?.getItem('hapi-session-list-status-mode')
            this.snapshot.preferences.pinInProgressSessions = storage?.getItem('hapi-pin-in-progress-sessions') === 'true'
            this.snapshot.preferences.showActiveSessionsOnly = storage?.getItem('hapi-show-active-sessions-only') === 'true'
            this.snapshot.preferences.sessionPreviewLimit = limit?.trim() ? normalizeSessionPreviewLimit(Number(limit)) : DEFAULT_SESSION_PREVIEW_LIMIT
            this.snapshot.preferences.statusMode = originalStatus === 'detailed' ? 'detailed' : 'standard'
            const raw: unknown = JSON.parse(storage?.getItem(key) ?? 'null')
            if (raw && typeof raw === 'object') {
                const value = raw as Partial<SidebarSnapshot>
                const preferences = value.preferences
                const list = (items: unknown): string[] => Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string' && item.length < 10000).slice(0, 10000) : []
                this.snapshot = { baseline: typeof value.baseline === 'number' && Number.isFinite(value.baseline) ? value.baseline : Date.now(), seen: timestamps(value.seen), unread: timestamps(value.unread), preferences: {
                    mode: preferences?.mode === 'folders' ? 'folders' : 'recent',
                    filter: preferences && ['all', 'running', 'attention', 'unread'].includes(preferences.filter) ? preferences.filter : 'all',
                    engine: typeof preferences?.engine === 'string' ? preferences.engine : '', machine: typeof preferences?.machine === 'string' ? preferences.machine : '',
                    collapsed: list(preferences?.collapsed), expanded: list(preferences?.expanded), folderOrder: list(preferences?.folderOrder),
                    pinInProgressSessions: typeof preferences?.pinInProgressSessions === 'boolean' ? preferences.pinInProgressSessions : this.snapshot.preferences.pinInProgressSessions,
                    showActiveSessionsOnly: typeof preferences?.showActiveSessionsOnly === 'boolean' ? preferences.showActiveSessionsOnly : this.snapshot.preferences.showActiveSessionsOnly,
                    sessionPreviewLimit: preferences?.sessionPreviewLimit === undefined ? this.snapshot.preferences.sessionPreviewLimit : normalizeSessionPreviewLimit(preferences.sessionPreviewLimit),
                    statusMode: originalStatus !== undefined && originalStatus !== null ? originalStatus === 'detailed' ? 'detailed' : 'standard'
                        : preferences?.statusMode === 'standard' || preferences?.statusMode === 'detailed' ? preferences.statusMode : this.snapshot.preferences.statusMode,
                } }
            }
        } catch { /* A damaged view preference must not prevent opening conversations. */ }
    }
    getSnapshot = (): SidebarSnapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    onReadIntent(listener: (intent: ReadIntent) => void): () => void { this.intents.add(listener); return () => { this.intents.delete(listener) } }
    private commit(snapshot: SidebarSnapshot): void {
        this.snapshot = snapshot
        try { this.storage?.setItem(this.key, JSON.stringify(snapshot)) } catch { /* Session access stays available in storage-restricted browsers. */ }
        for (const listener of this.listeners) listener()
    }
    change(patch: Partial<SidebarPreferences>): void {
        const next = { ...patch, ...(patch.sessionPreviewLimit === undefined ? {} : { sessionPreviewLimit: normalizeSessionPreviewLimit(patch.sessionPreviewLimit) }) }
        this.commit({ ...this.snapshot, preferences: { ...this.snapshot.preferences, ...next } })
        try {
            if (next.pinInProgressSessions !== undefined) this.storage?.setItem('hapi-pin-in-progress-sessions', String(next.pinInProgressSessions))
            if (next.showActiveSessionsOnly !== undefined) this.storage?.setItem('hapi-show-active-sessions-only', String(next.showActiveSessionsOnly))
            if (next.sessionPreviewLimit !== undefined) this.storage?.setItem('hapi-session-preview-limit', String(next.sessionPreviewLimit))
            if (next.statusMode !== undefined) this.storage?.setItem('hapi-session-list-status-mode', next.statusMode)
        } catch { /* As in original HAPI, a view preference remains usable this page. */ }
    }
    /** Browser storage events are observations, not another write to the shared original key. */
    receiveOriginalPreference(key: string | null, value: string | null): void {
        const patch: Partial<SidebarPreferences> = key === 'hapi-session-list-status-mode' ? { statusMode: value === 'detailed' ? 'detailed' : 'standard' }
            : key === 'hapi-pin-in-progress-sessions' ? { pinInProgressSessions: value === 'true' }
            : key === 'hapi-show-active-sessions-only' ? { showActiveSessionsOnly: value === 'true' }
            : key === 'hapi-session-preview-limit' ? { sessionPreviewLimit: value?.trim() ? normalizeSessionPreviewLimit(Number(value)) : DEFAULT_SESSION_PREVIEW_LIMIT } : {}
        if (!Object.entries(patch).some(([key, value]) => this.snapshot.preferences[key as keyof SidebarPreferences] !== value)) return
        this.commit({ ...this.snapshot, preferences: { ...this.snapshot.preferences, ...patch } })
    }
    isUnread(id: string, updatedAt: number): boolean {
        return this.snapshot.unread[id] !== undefined || updatedAt > (this.snapshot.seen[id] ?? this.snapshot.baseline)
    }
    markSeen(id: string, updatedAt: number): void {
        if (!Number.isFinite(updatedAt) || updatedAt < 0) return
        if ((this.snapshot.seen[id] ?? 0) >= updatedAt && this.snapshot.unread[id] === undefined) return
        const unread = { ...this.snapshot.unread }; delete unread[id]
        this.commit({ ...this.snapshot, seen: { ...this.snapshot.seen, [id]: Math.max(this.snapshot.seen[id] ?? 0, updatedAt) }, unread })
        for (const listener of this.intents) listener({ id, kind: 'seen', at: updatedAt })
    }
    markUnread(id: string, updatedAt: number): void {
        this.commit({ ...this.snapshot, unread: { ...this.snapshot.unread, [id]: updatedAt } })
        for (const listener of this.intents) listener({ id, kind: 'unread', at: updatedAt })
    }
    markAllSeen(rows: readonly { id: string; updatedAt: number }[]): void {
        const seen = { ...this.snapshot.seen }, unread = { ...this.snapshot.unread }
        for (const row of rows) { seen[row.id] = Math.max(seen[row.id] ?? 0, row.updatedAt); delete unread[row.id] }
        this.commit({ ...this.snapshot, seen, unread })
        for (const row of rows) for (const listener of this.intents) listener({ id: row.id, kind: 'seen', at: row.updatedAt })
    }
    mergeSource(records: readonly { id: string; seenAt: number; manualUnreadAt: number | null }[]): void {
        const seen = { ...this.snapshot.seen }, unread = { ...this.snapshot.unread }
        let changed = false
        for (const record of records) {
            if (seen[record.id] !== record.seenAt) { seen[record.id] = record.seenAt; changed = true }
            const value = record.manualUnreadAt ?? undefined
            if (unread[record.id] !== value) {
                if (value === undefined) delete unread[record.id]
                else unread[record.id] = value
                changed = true
            }
        }
        if (changed) this.commit({ ...this.snapshot, seen, unread })
    }
    toggle(field: 'collapsed' | 'expanded', id: string): void {
        const values = this.snapshot.preferences[field]
        this.change({ [field]: values.includes(id) ? values.filter(value => value !== id) : [...values, id] })
    }
}
