/** HAPI 0f8ef697 lib/relativeTime.ts. Copyright HAPI contributors; AGPL-3.0-only. */
export type RelativeTimeKey = 'timeJustNow' | 'timeMinutesAgo' | 'timeHoursAgo' | 'timeDaysAgo'
export function sourceTimeMilliseconds(value: number): number | null {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value
    return Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null
}
export function sessionRelativeTime(value: number, translate: (key: RelativeTimeKey, params?: Record<string, unknown>) => string, now = Date.now()): string | null {
    const milliseconds = sourceTimeMilliseconds(value)
    if (milliseconds === null) return null
    const delta = now - milliseconds
    if (delta < 60_000) return translate('timeJustNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return translate('timeMinutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return translate('timeHoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return translate('timeDaysAgo', { n: days })
    const date = new Date(milliseconds)
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
}
