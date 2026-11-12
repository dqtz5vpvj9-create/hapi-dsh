/**
 * Adapted from HAPI 0f8ef697 SessionListSearch / SessionDateRangePicker.
 * Copyright HAPI contributors. AGPL-3.0-only; see NOTICE.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { NativeSourceSearch, type NativeHistoryTarget, type NativeSearchOccurrence, type NativeThreadSummary } from './sidebar-search-query.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { localDayKey, parseLocalDate, selectSidebarDate } from '../workspace/sidebar-time.ts'

function SearchIcon() {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></svg>
}
function CalendarIcon() {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
}

export function SidebarSearchControls({ query, onQueryChange, start, end, onDatesChange, activityDates, expanded, onExpandedChange, inputRef, t, persistent = false }: {
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
    persistent?: boolean
}) {
    const [calendar, setCalendar] = useState(false)
    const searchButton = useRef<HTMLButtonElement>(null), dateButton = useRef<HTMLButtonElement>(null)
    const dialogId = useId()
    const hasRange = Boolean(start && end)
    const visible = persistent || expanded
    const focusSearch = (): void => { (visible ? inputRef.current : searchButton.current)?.focus() }
    const focusAfterDate = (): void => { (visible ? inputRef.current : dateButton.current)?.focus() }
    const closeCalendar = (): void => { setCalendar(false); focusAfterDate() }
    useEffect(() => { if (expanded) inputRef.current?.focus(); else setCalendar(false) }, [expanded, inputRef])
    return <div className={`hapi-sidebar-search-controls${visible ? ' hapi-sidebar-search-expanded' : ''}`}
        onBlur={event => { if (!persistent && expanded && !event.currentTarget.contains(event.relatedTarget as Node | null)) onExpandedChange(false) }}
        onKeyDown={event => {
            if (event.key !== 'Escape') return
            event.preventDefault(); event.stopPropagation()
            if (calendar) closeCalendar()
            else if (!persistent) { onExpandedChange(false); requestAnimationFrame(() => searchButton.current?.focus()) }
        }}>
        {visible ? <div className="hapi-search"><SearchIcon/>
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

/** This panel queries the source, while SidebarSearchControls filters metadata already on this device. */
export function NativeSourceSearchPanel({ controller, open, origin, conversationSessionId, language = 'en' }: {
    controller: NativeSourceSearch; open(target: NativeHistoryTarget): void | Promise<void>; origin?: NativeHistoryTarget; conversationSessionId?: string; language?: string
}) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const [query, setQuery] = useState(state.query), [opening, setOpening] = useState(false), [error, setError] = useState('')
    const generation = useRef(0), submission = useRef<symbol | null>(null), scopeId = useId(), zh = language.startsWith('zh')
    useEffect(() => { ++generation.current; submission.current = null; setQuery(controller.getSnapshot().query); setOpening(false); setError(''); return () => { ++generation.current } }, [controller])
    useEffect(() => setQuery(state.query), [state.query])
    const select = async (row: NativeThreadSummary) => {
        const current = generation.current
        try { await controller.select(row) } catch (cause) { if (current === generation.current) setError(String(cause)) }
    }
    const back = async () => {
        const current = generation.current
        try { await controller.returnToOrigin(open, origin) } catch (cause) { if (current === generation.current) setError(String(cause)) }
    }
    const navigate = async (row: NativeThreadSummary, occurrence?: NativeSearchOccurrence) => {
        const current = generation.current
        setOpening(true); setError('')
        try { await controller.open(row, occurrence, open, origin) }
        catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
        finally { if (current === generation.current) setOpening(false) }
    }
    const searching = state.busy || state.occurrenceBusy
    const submit = (archived = state.archived) => {
        if (submission.current || searching || opening) return
        if (state.scope === 'conversation' && (!conversationSessionId || !query.trim())) return
        const token = Symbol(); submission.current = token; setError('')
        const work = state.scope === 'conversation' ? controller.searchConversation(query, conversationSessionId!) : controller.search(query, archived)
        void work.finally(() => { if (submission.current === token) submission.current = null }).catch(() => {})
    }
    return <section className="hhpi-native-history" aria-label={zh ? '来源历史搜索' : 'Source history search'}>
        <h3>{state.scope === 'conversation' ? zh ? '搜索当前会话' : 'Search this conversation' : zh ? '搜索来源正文' : 'Search source history'}</h3>
        {conversationSessionId && <fieldset disabled={searching || opening}><legend>{zh ? '搜索范围' : 'Search scope'}</legend>
            <label><input type="radio" name={scopeId} checked={state.scope === 'conversation'} onChange={() => controller.setScope('conversation')}/>{zh ? '当前会话' : 'Current conversation'}</label>
            <label><input type="radio" name={scopeId} checked={state.scope === 'source'} onChange={() => controller.setScope('source')}/>{zh ? '整个来源' : 'Entire source'}</label>
        </fieldset>}
        <p>{state.scope === 'conversation' ? zh ? '查找当前会话的用户与助手正文。' : 'Find messages in this conversation.'
            : zh ? '搜索整个来源的用户与助手正文，包括代码块。结果会逐步显示，可随时取消。' : 'Search user and assistant messages across this source, including code blocks. Results appear as the search continues; cancel at any time.'}</p>
        <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); submit() }}>
            <label>{zh ? '正文查询' : 'Message query'}<input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}/></label>
            {state.scope === 'source' && <label><input type="checkbox" disabled={searching || opening} checked={state.archived} onChange={event => submit(event.currentTarget.checked)}/>{zh ? '搜索已归档历史' : 'Search archived history'}</label>}
            <button type="submit" disabled={searching || opening || !query.trim()}>{state.scope === 'conversation' ? zh ? '搜索当前会话' : 'Search conversation' : zh ? '搜索来源' : 'Search source'}</button>
            {searching && <button type="button" onClick={() => { submission.current = null; controller.cancelSearch(); controller.cancelOccurrences() }}>{zh ? '取消搜索' : 'Cancel search'}</button>}
        </form>
        {state.busy && !state.occurrenceBusy && <p role="status">{state.scope === 'conversation' ? zh ? '正在搜索当前会话…' : 'Searching conversation…' : zh ? '正在搜索来源…' : 'Searching source…'}</p>}
        {(state.error || error) && <p role="alert">{state.error || error}</p>}
        {state.scope === 'source' && !!state.query.trim() && !state.busy && !state.error && state.complete && !state.rows.length && <p>{zh ? '来源没有返回匹配记录。' : 'The source returned no matches.'}</p>}
        {state.scope === 'source' && !!state.query.trim() && !state.busy && !state.error && !state.complete && <p role="status">{zh ? '搜索已停止，已找到的结果会保留。可以重新搜索。' : 'Search stopped. Matches already found are kept. You can search again.'}</p>}
        {state.scope === 'source' && <ul>{state.rows.map(row => <li key={row.sessionId}>
            <strong>{row.title}</strong><small> · {row.cwd} · {row.status}</small><p>{row.snippet}</p>
            <button type="button" disabled={opening} onClick={() => { void navigate(row) }}>{zh ? '打开此会话' : 'Open conversation'}</button>
            <button type="button" disabled={state.occurrenceBusy && state.selected?.nativeId === row.nativeId} onClick={() => { void select(row) }}>{zh ? '查看正文命中' : 'Show message matches'}</button>
        </li>)}</ul>}
        {state.selected && <section aria-label={zh ? '正文命中' : 'Message matches'}><h4>{state.selected.title}</h4>
            {state.scope === 'source' && <button type="button" onClick={() => controller.closeOccurrences()}>{zh ? '返回搜索结果' : 'Back to results'}</button>}
            {state.occurrenceBusy && <p role="status">{zh ? '正在查找正文位置…' : 'Finding message positions…'}</p>}
            {state.scope === 'source' && state.occurrenceBusy && <button type="button" onClick={() => controller.cancelOccurrences()}>{zh ? '取消查找位置' : 'Cancel message lookup'}</button>}
            {state.occurrenceError && <p role="alert">{state.occurrenceError}</p>}
            {!state.occurrenceBusy && !state.occurrenceError && !state.occurrences.length && <p>{zh ? '来源没有返回可定位的正文命中。' : 'The source returned no message occurrences.'}</p>}
            <ol>{state.occurrences.map(value => <li key={JSON.stringify([value.turnId, value.itemId])}><p>{value.snippet.slice(0, value.start)}<mark>{value.snippet.slice(value.start, value.end)}</mark>{value.snippet.slice(value.end)}</p>
                <button type="button" disabled={opening} onClick={() => { void navigate(state.selected!, value) }}>{zh ? '打开此处' : 'Open this match'}</button></li>)}</ol>
            {state.occurrenceCursor && <button type="button" disabled={state.occurrenceBusy} onClick={() => { void controller.nextOccurrences() }}>{zh ? '读取下一页正文命中' : 'Read next matches'}</button>}
        </section>}
        {(state.origin || origin) && <button type="button" disabled={opening} onClick={() => { void back() }}>{zh ? '返回原入口' : 'Return to origin'}</button>}
    </section>
}
