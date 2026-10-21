/**
 * Metadata search adapted from HAPI 0f8ef697 web/src/lib/sessionListSearch.ts
 * and shared/src/search.ts. Copyright HAPI contributors. AGPL-3.0-only.
 * Search consumes published source fields; it never reads a different Host.
 */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CatalogSession } from '../client-api.ts'

export type SidebarSearchRow = Pick<SessionSummary, 'id' | 'displayTitle' | 'updatedAt' | 'title' | 'cwd' | 'projectionValues'> & {
    readonly hostLabel?: string
    readonly sourceSessionId?: string
    readonly sourceSummary?: CatalogSession['sourceSummary']
    readonly sourceWorktree?: CatalogSession['sourceWorktree']
    readonly sourceSubagentSearch?: readonly string[]
}
export type SidebarSearchLocation = { engine: string; machineName?: string; machineId?: string; nativeId?: string }
export const SIDEBAR_SEARCH_WEIGHTS = { title: 10, worktreeLabel: 5, summary: 3, flavor: 2, subagent: 3, machine: 2, path: 1, id: .5 } as const
export type SidebarSearchFields = Record<keyof typeof SIDEBAR_SEARCH_WEIGHTS, string[]>
export type SidebarSearchIndex = { scores: Map<string, number>; matchedIds: Set<string> }
const strings = (values: readonly (string | null | undefined)[]): string[] => values.filter((value): value is string => typeof value === 'string' && value.length > 0)

export function sourceWorktreeLabel(row: Pick<SidebarSearchRow, 'sourceWorktree' | 'cwd'>): string | null {
    const tree = row.sourceWorktree
    if (!tree) return null
    if (tree.name.trim()) return tree.name.trim()
    return (tree.worktreePath ?? row.cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean).at(-1) ?? null
}
export function collectSidebarSearchFields(row: SidebarSearchRow, location: SidebarSearchLocation): SidebarSearchFields {
    const projection: unknown = row.projectionValues && (Reflect.get(row.projectionValues, 'hapi') ?? Reflect.get(row.projectionValues, 'hapiObserved'))
    const sourceId: unknown = projection && typeof projection === 'object' ? Reflect.get(projection, 'hapiSessionId') : undefined
    return {
        title: strings([row.displayTitle, row.title]),
        worktreeLabel: strings([sourceWorktreeLabel(row)]),
        summary: strings([row.sourceSummary]),
        flavor: strings([location.engine]),
        subagent: strings(row.sourceSubagentSearch ?? []),
        machine: strings([location.machineName ?? row.hostLabel, location.machineId]),
        path: strings([row.cwd, row.sourceWorktree?.basePath, row.sourceWorktree?.worktreePath]),
        id: strings([row.id, row.sourceSessionId, location.nativeId, typeof sourceId === 'string' ? sourceId : undefined]),
    }
}
export const isSidebarWildcard = (query: string): boolean => query.includes('*') || query.includes('?')

/** Only * and ? are patterns. No user-supplied regular expression is evaluated. */
export function matchesSidebarSearch(value: string, query: string): boolean {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return true
    if (!isSidebarWildcard(normalized)) return value.toLowerCase().includes(normalized)
    const input = Array.from(value.toLowerCase()), tokens = Array.from(normalized)
    let inputIndex = 0, tokenIndex = 0, starIndex = -1, retryIndex = 0
    while (inputIndex < input.length) {
        const token = tokens[tokenIndex]
        if (token !== undefined && (token === '?' || token === input[inputIndex])) { inputIndex++; tokenIndex++ }
        else if (token === '*') { starIndex = tokenIndex++; retryIndex = inputIndex }
        else if (starIndex >= 0) { tokenIndex = starIndex + 1; inputIndex = ++retryIndex }
        else return false
    }
    while (tokens[tokenIndex] === '*') tokenIndex++
    return tokenIndex === tokens.length
}
export function hasSidebarSearchBoundary(value: string, query: string): boolean {
    if (!query) return true
    const escaped = query.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(value.toLowerCase())
}
export function scoreSidebarSearch(fields: SidebarSearchFields, query: string): { matched: boolean; score: number } {
    const normalized = query.trim().toLowerCase(), wildcard = isSidebarWildcard(normalized)
    const terms = wildcard ? [normalized] : normalized.split(/\s+/).filter(Boolean)
    if (!terms.length) return { matched: true, score: 0 }
    let score = 0
    for (const term of terms) {
        let best = 0
        for (const [field, weight] of Object.entries(SIDEBAR_SEARCH_WEIGHTS) as Array<[keyof SidebarSearchFields, number]>) {
            const values = fields[field]
            if (!values.some(value => matchesSidebarSearch(value, term))) continue
            const boundary = wildcard || values.some(value => hasSidebarSearchBoundary(value, term))
            best = Math.max(best, weight * (boundary ? 1.75 : 1))
        }
        if (!best) return { matched: false, score: 0 }
        score += best
    }
    if (!wildcard) {
        const bonus = fields.title.reduce((max, title) => {
            const normalizedTitle = title.trim().toLowerCase()
            return Math.max(max, normalizedTitle === normalized ? 50 : normalized.includes(' ') && normalizedTitle.includes(normalized) ? 25 : 0)
        }, 0)
        score += bonus
    }
    return { matched: true, score }
}
export function buildSidebarSearchIndex<T extends SidebarSearchRow>(rows: readonly T[], query: string, location: (row: T) => SidebarSearchLocation): SidebarSearchIndex {
    const index: SidebarSearchIndex = { scores: new Map(), matchedIds: new Set() }
    if (!query.trim()) return index
    for (const row of rows) {
        const result = scoreSidebarSearch(collectSidebarSearchFields(row, location(row)), query)
        if (result.matched) { index.matchedIds.add(row.id); index.scores.set(row.id, result.score) }
    }
    return index
}
export function compareSidebarSearch(left: Pick<SidebarSearchRow, 'id' | 'updatedAt'>, right: Pick<SidebarSearchRow, 'id' | 'updatedAt'>, index: SidebarSearchIndex): number {
    return (index.scores.get(right.id) ?? 0) - (index.scores.get(left.id) ?? 0) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}
