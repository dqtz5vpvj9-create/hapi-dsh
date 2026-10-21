/**
 * Adapted from HAPI 0f8ef697 SessionListSearch / SessionDateRangePicker.
 * Copyright HAPI contributors. AGPL-3.0-only; see NOTICE.
 */
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import type { WorkspaceTranslate } from './locales.ts'
import { localDayKey, parseLocalDate, selectSidebarDate } from '../workspace/sidebar-time.ts'

function SearchIcon() {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></svg>
}
function CalendarIcon() {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
}

export function SidebarSearchControls({ query, onQueryChange, start, end, onDatesChange, activityDates, expanded, onExpandedChange, inputRef, t }: {
    query: string
    onQueryChange: (value: string) => void
    start: string
    end: string
    onDatesChange: (start: string, end: string) => void
    activityDates: ReadonlySet<string>
    expanded: boolean
    onExpandedChange: (value: boolean) => void
    inputRef: RefObject<HTMLInputElement>
    t: WorkspaceTranslate
}) {
    const [calendar, setCalendar] = useState(false)
    const searchButton = useRef<HTMLButtonElement>(null), dateButton = useRef<HTMLButtonElement>(null)
    const dialogId = useId()
    const hasRange = Boolean(start && end)
    const focusSearch = (): void => { (expanded ? inputRef.current : searchButton.current)?.focus() }
    const focusAfterDate = (): void => { (expanded ? inputRef.current : dateButton.current)?.focus() }
    const closeCalendar = (): void => { setCalendar(false); focusAfterDate() }
    useEffect(() => { if (expanded) inputRef.current?.focus(); else setCalendar(false) }, [expanded, inputRef])
    return <div className={`hapi-sidebar-search-controls${expanded ? ' hapi-sidebar-search-expanded' : ''}`}
        onBlur={event => { if (expanded && !event.currentTarget.contains(event.relatedTarget as Node | null)) onExpandedChange(false) }}
        onKeyDown={event => {
            if (event.key !== 'Escape') return
            event.preventDefault(); event.stopPropagation()
            if (calendar) closeCalendar()
            else { onExpandedChange(false); requestAnimationFrame(() => searchButton.current?.focus()) }
        }}>
        {expanded ? <div className="hapi-search"><SearchIcon/>
            <input ref={inputRef} type="search" value={query} onChange={event => onQueryChange(event.currentTarget.value)} aria-label={t('search')} placeholder={t('search')}/>
            {query && <button type="button" className="hapi-search-clear" aria-label={t('clearSearch')} title={t('clearSearch')} onClick={() => { onQueryChange(''); focusSearch() }}>×</button>}
        </div> : <div className={`hapi-search-chip${query ? ' hapi-search-chip-active' : ''}`}>
            <button ref={searchButton} type="button" aria-label={query ? `${t('openSearch')}: ${query}` : t('openSearch')} title={query || t('openSearch')}
                onClick={() => onExpandedChange(true)}><SearchIcon/><span>{query || t('openSearch')}</span></button>
            {query && <button type="button" className="hapi-search-clear" aria-label={t('clearSearch')} onClick={() => { onQueryChange(''); focusSearch() }}>×</button>}
        </div>}
        <button ref={dateButton} type="button" className={`hapi-calendar-trigger${hasRange ? ' hapi-calendar-active' : ''}`} aria-label={t('dateRange')}
            title={hasRange ? `${t('dateRange')}: ${start} – ${end}` : t('dateRange')} aria-expanded={calendar} aria-controls={calendar ? dialogId : undefined}
            onClick={() => setCalendar(value => !value)}><CalendarIcon/>{hasRange && <span aria-hidden="true"/>}</button>
        {calendar && <>
            <button type="button" className="hapi-calendar-backdrop" aria-label={t('closeDateRange')} onClick={closeCalendar}/>
            <SidebarCalendar id={dialogId} start={start} end={end} activityDates={activityDates} onDatesChange={onDatesChange}
                onComplete={closeCalendar} onClear={() => { onDatesChange('', ''); focusAfterDate() }} t={t}/>
        </>}
    </div>
}

function SidebarCalendar({ id, start, end, activityDates, onDatesChange, onComplete, onClear, t }: {
    id: string; start: string; end: string; activityDates: ReadonlySet<string>
    onDatesChange: (start: string, end: string) => void; onComplete: () => void; onClear: () => void; t: WorkspaceTranslate
}) {
    const initial = parseLocalDate(start) ?? new Date()
    const [month, setMonth] = useState(() => new Date(initial.getFullYear(), initial.getMonth(), 1))
    const today = localDayKey(Date.now()), locale = document.documentElement.lang || undefined
    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay()
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
    const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(2026, 5, 7 + index)))
    const select = (value: string): void => {
        const next = selectSidebarDate(start, end, value)
        onDatesChange(next.start, next.end)
        if (next.complete) onComplete()
    }
    return <section id={id} role="dialog" aria-label={t('dateRange')} className="hapi-sidebar-calendar">
        <header><button type="button" aria-label={t('previousMonth')} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
            <strong aria-live="polite">{month.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</strong>
            <button type="button" aria-label={t('nextMonth')} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button></header>
        <div className="hapi-calendar-weekdays" aria-hidden="true">{weekdays.map((label, index) => <span key={index}>{label}</span>)}</div>
        <div className="hapi-calendar-days">
            {Array.from({ length: firstDay }, (_, index) => <span key={`blank-${index}`} aria-hidden="true"/>)}
            {Array.from({ length: count }, (_, index) => {
                const value = localDayKey(new Date(month.getFullYear(), month.getMonth(), index + 1).getTime())
                const endpoint = value === start || value === end, inRange = Boolean(start && end && value > start && value < end)
                const active = activityDates.has(value)
                return <button key={value} type="button" data-date={value} data-activity={active || undefined} data-in-range={inRange || undefined}
                    aria-label={active ? `${value} · ${t('sessionActivityDate')}` : value} aria-current={value === today ? 'date' : undefined}
                    aria-pressed={endpoint} onClick={() => select(value)}>{index + 1}</button>
            })}
        </div>
        <div className="hapi-calendar-inputs"><label>{t('dateFrom')}<input type="date" aria-label={t('dateFrom')} value={start} max={end || undefined} onChange={event => onDatesChange(event.currentTarget.value, end)}/></label>
            <label>{t('dateThrough')}<input type="date" aria-label={t('dateThrough')} value={end} min={start || undefined} onChange={event => onDatesChange(start, event.currentTarget.value)}/></label></div>
        <footer><span>{!start ? t('pickStartDate') : !end ? t('pickEndDate') : `${start} – ${end}`}</span>
            {(start || end) && <button type="button" onClick={onClear}>{t('clearDateRange')}</button>}</footer>
    </section>
}
