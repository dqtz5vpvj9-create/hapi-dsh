import type { SidebarFilter } from '../workspace/sidebar-state.ts'
import { readableEngine, type WorkspaceTranslate } from './locales.ts'

/** One working view, plus a direct unread shortcut; all use the existing directory state. */
export function SidebarScope({ filter, counts, onFilter, engines, selectedEngine = '', onEngineChange, onMarkAllRead, t }: {
    filter: SidebarFilter
    counts: Record<SidebarFilter, number>
    onFilter(filter: SidebarFilter): void
    engines?: readonly string[]
    selectedEngine?: string
    onEngineChange?: (engine: string) => void
    onMarkAllRead?: () => void
    t: WorkspaceTranslate
}) {
    return <div className="hapi-sidebar-scope">
        <select aria-label={t('statusFilter')} value={filter} onChange={event => onFilter(event.currentTarget.value as SidebarFilter)}>
            {(['all', 'running', 'attention', 'unread'] as const).map(key => <option key={key} value={key}>
                {t(key === 'all' ? 'allChats' : key)}{key !== 'all' ? ` · ${counts[key]}` : ''}
            </option>)}
        </select>
        <button type="button" aria-pressed={filter === 'unread'} onClick={() => onFilter(filter === 'unread' ? 'all' : 'unread')}>
            {counts.unread > 0 && <span className="hapi-unread-dot"/>}{counts.unread} {t('unread')}
        </button>
        {counts.unread > 0 && onMarkAllRead && <button type="button" className="hapi-mark-all-read" onClick={onMarkAllRead} title={t('markAllRead')}>{t('markAllRead')}</button>}
        {engines && engines.length > 1 && <div className="hapi-engine-pills" role="group" aria-label={t('engine')}>
            <button type="button" aria-pressed={selectedEngine === ''} onClick={() => onEngineChange?.('')}>{t('all')}</button>
            {engines.map(eng => <button key={eng} type="button" aria-pressed={eng === selectedEngine} onClick={() => onEngineChange?.(eng === selectedEngine ? '' : eng)}>{readableEngine(eng)}</button>)}
        </div>}
    </div>
}
