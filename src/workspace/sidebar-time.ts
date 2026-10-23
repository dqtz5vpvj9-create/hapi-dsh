/**
 * Adapted from HAPI 0f8ef697 useSessionListOrder.ts, RecentSessionList.tsx and
 * SessionList.tsx. Copyright HAPI contributors. AGPL-3.0-only; see NOTICE.
 */
export type TimedSession = { id: string; updatedAt: number }

/** Live output cannot move a row or its day heading; deliberate refresh can. */
export class SidebarRecency {
    private times = new Map<string, number>()
    reconcile(rows: readonly TimedSession[], refresh = false): string[] {
        if (refresh) this.times = new Map()
        const live = new Set(rows.map(row => row.id))
        for (const id of this.times.keys()) if (!live.has(id)) this.times.delete(id)
        for (const row of rows) if (!this.times.has(row.id)) this.times.set(row.id, row.updatedAt)
        return [...rows].sort((left, right) => this.timeFor(right) - this.timeFor(left) || left.id.localeCompare(right.id)).map(row => row.id)
    }
    timeFor(row: TimedSession): number { return this.times.get(row.id) ?? row.updatedAt }
}

export function localDayKey(time: number): string {
    const date = new Date(time)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

let dayFormatter: { locale: string | undefined; format: Intl.DateTimeFormat } | undefined
export function sidebarDayLabel(time: number, previousTime: number | undefined, labels: { today: string; yesterday: string }, locale?: string, now = Date.now()): string | null {
    const date = new Date(time)
    if (!Number.isFinite(date.getTime()) || previousTime !== undefined && localDayKey(previousTime) === localDayKey(time)) return null
    const today = new Date(now), yesterday = new Date(now); yesterday.setDate(today.getDate() - 1)
    if (localDayKey(time) === localDayKey(today.getTime())) return labels.today
    if (localDayKey(time) === localDayKey(yesterday.getTime())) return labels.yesterday
    // Reuse ICU setup across day headings and catalog updates. The large
    // production catalog otherwise creates hundreds of formatters at boot.
    if (!dayFormatter || dayFormatter.locale !== locale) dayFormatter = { locale, format: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }) }
    return dayFormatter.format.format(date)
}

export function parseLocalDate(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return null
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
    const date = new Date(year, month - 1, day)
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

/** Original HAPI calendar: first click starts, second click completes in either direction. */
export function selectSidebarDate(start: string, end: string, value: string): { start: string; end: string; complete: boolean } {
    if (!parseLocalDate(value)) return { start, end, complete: false }
    if (!parseLocalDate(start) || end) return { start: value, end: '', complete: false }
    return value < start ? { start: value, end: start, complete: true } : { start, end: value, complete: true }
}

/** Whole local dates, including a 23/25-hour DST day; never fixed 24h addition. */
export function sidebarTimeRange(start: string, end: string): { start: number; end: number } | null {
    const from = parseLocalDate(start), through = parseLocalDate(end)
    if (!from || !through || through.getTime() < from.getTime()) return null
    through.setDate(through.getDate() + 1)
    return { start: from.getTime(), end: through.getTime() }
}

export function matchesSidebarTime(time: number, range: ReturnType<typeof sidebarTimeRange>): boolean {
    return !range || time >= range.start && time < range.end
}
