import type { CatalogMachine } from '../client-api.ts'
import type { WorkspaceCatalogRow } from '../client/controller.ts'
import { discoveredSourceKey, type DiscoveredSourceSession, type SourceDiscovery } from '../source-discovery-types.ts'
import { sourceIdentity } from './legacy.ts'
import { scoreSidebarSearch, type SidebarSearchFields } from './sidebar-search.ts'
import type { SidebarFilter } from './sidebar-state.ts'
import { matchesSidebarTime } from './sidebar-time.ts'

export interface SourceDiscoveryFilters {
    query?: string | undefined
    engine?: string | undefined
    machine?: string | undefined
    archived?: boolean | undefined
    activeOnly?: boolean | undefined
    filter?: SidebarFilter | undefined
    timeRange?: { start: number; end: number } | null | undefined
    /** Unread is not inferred from a missing display binding. */
    isUnread?: ((source: DiscoveredSourceSession) => boolean) | undefined
}
export interface SourceDiscoveryRow { source: DiscoveredSourceSession; machineLabel: string; score: number }
const strings = (values: readonly (string | null | undefined)[]): string[] =>
    values.filter((value): value is string => typeof value === 'string' && value.length > 0)

/** Search all original summaries before applying any row preview or page size. */
export function sourceDiscoveryRows(discovery: SourceDiscovery | null | undefined,
    catalogRows: readonly Pick<WorkspaceCatalogRow, 'projectionValues'>[], machines: readonly Pick<CatalogMachine, 'id' | 'label'>[],
    filters: SourceDiscoveryFilters = {}): SourceDiscoveryRow[] {
    if (!discovery) return []
    const listed = new Set(catalogRows.flatMap(row => {
        const identity = sourceIdentity(row)
        return identity?.hubId ? [discoveredSourceKey({ hubId: identity.hubId, sourceSessionId: identity.sessionId })] : []
    }))
    const labels = new Map(machines.map(machine => [machine.id, machine.label]))
    const unique = new Map(discovery.sessions.map(source => [discoveredSourceKey(source), source]))
    const rows: SourceDiscoveryRow[] = []
    for (const [key, source] of unique) {
        if (listed.has(key)) continue
        const machineLabel = (source.machineId ? labels.get(source.machineId) : undefined) ?? source.machineName ?? source.machineId ?? ''
        if (filters.engine && source.engine !== filters.engine || filters.machine && source.machineId !== filters.machine && machineLabel !== filters.machine) continue
        if ((source.lifecycleState === 'archived') !== Boolean(filters.archived)) continue
        if (!matchesSidebarTime(source.updatedAt, filters.timeRange ?? null)) continue
        const pending = (source.pendingRequestsCount ?? 0) > 0 || source.waitingOn.length > 0
        if (filters.activeOnly && !source.active && !pending) continue
        if (filters.filter === 'running' && (!source.thinking || pending)) continue
        if (filters.filter === 'attention' && !pending && source.binding !== 'failed') continue
        if (filters.filter === 'unread' && filters.isUnread?.(source) !== true) continue
        const worktreeLabel = source.worktree?.name.trim() || (source.worktree
            ? (source.worktree.worktreePath ?? source.cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]+/).at(-1) : undefined)
        const fields: SidebarSearchFields = {
            title: [source.title], worktreeLabel: strings([worktreeLabel]), summary: strings([source.summary]),
            flavor: strings([source.engine]), subagent: source.subagentSearch,
            machine: strings([machineLabel, source.machineId]),
            path: strings([source.cwd, source.worktree?.basePath, source.worktree?.worktreePath]),
            id: strings([source.sourceSessionId, source.nativeId]),
        }
        const result = scoreSidebarSearch(fields, filters.query ?? '')
        if (result.matched) rows.push({ source, machineLabel, score: result.score })
    }
    return rows.sort((left, right) => right.score - left.score || right.source.updatedAt - left.source.updatedAt
        || discoveredSourceKey(left.source).localeCompare(discoveredSourceKey(right.source)))
}

/** The sole navigation target is an original Hub/session tuple. */
export function discoveredSourceTarget(source: Pick<DiscoveredSourceSession, 'hubId' | 'sourceSessionId'>): { hubId: string; sessionId: string } {
    return { hubId: source.hubId, sessionId: source.sourceSessionId }
}
