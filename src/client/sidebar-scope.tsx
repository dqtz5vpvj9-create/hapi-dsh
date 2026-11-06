import type { SidebarFilter } from '../workspace/sidebar-state.ts'
import type { WorkspaceTranslate } from './locales.ts'

/** One working view, plus a direct unread shortcut; all use the existing directory state. */
export function SidebarScope({ filter, counts, onFilter, t }: {
    filter: SidebarFilter
    counts: Record<SidebarFilter, number>
    onFilter(filter: SidebarFilter): void
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
    </div>
}
