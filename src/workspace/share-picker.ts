/**
 * Share target preparation/filtering adapted from HAPI 0f8ef697:
 * web/src/routes/share/index.tsx, lib/sharePickerSessions.ts and
 * components/SessionList.tsx. Copyright HAPI contributors. AGPL-3.0-only.
 * A snapshot is a list of display facts, not a lease on another Host's Session.
 */
import type { WorkspaceCatalog, WorkspaceCatalogRow } from '../client/controller.ts'
import { sessionLocation } from '../client/controller.ts'
import type { CatalogMachine } from '../client-api.ts'
import { shareTargetKey, type SharePayload, type ShareTarget } from '../client/share-transfer.ts'
import { sourceRoute } from '../shared/source-capability.ts'
import { sessionFolder } from './presentation.ts'
import { collectSidebarSearchFields, scoreSidebarSearch, type SidebarSearchFields } from './sidebar-search.ts'
import { normalizeSessionPreviewLimit, sidebarSessionActive } from './sidebar-sections.ts'
import { localDayKey, matchesSidebarTime, sidebarTimeRange } from './sidebar-time.ts'

export interface SharePickerCandidate {
    readonly id: string
    readonly hostId: string
    readonly hostLabel: string
    readonly sourceSessionId: string
    readonly target: ShareTarget | null
    readonly title: string
    readonly directory: string
    readonly machineId: string | null
    readonly machineLabel: string
    readonly engine: string
    readonly updatedAt: number
    readonly active: boolean
    readonly pinned: boolean
    readonly fields: Readonly<{ [K in keyof SidebarSearchFields]: readonly string[] }>
}
export interface SharePickerSnapshot {
    readonly candidates: readonly SharePickerCandidate[]
    readonly activityDates: ReadonlySet<string>
}

/** Resolve only the actual original route; cold legacy display IDs cannot become DSH sessions. */
export function shareTargetForRow(row: WorkspaceCatalogRow): ShareTarget | null {
    try { return sourceRoute(row.hostId, row.sourceSessionId, 'local') }
    catch { return null }
}
export function listedShareRows(catalog: WorkspaceCatalog): WorkspaceCatalogRow[] {
    return [...new Set(catalog.ids)].flatMap(id => catalog.byId[id] ? [catalog.byId[id]!] : [])
}

/** Clone the published fields once. Live titles, activity and metadata cannot
 * silently move the target beneath a pointer while a share is being chosen. */
export function captureSharePicker(catalog: WorkspaceCatalog, machines: readonly CatalogMachine[] = []): SharePickerSnapshot {
    const labels = new Map(machines.map(machine => [machine.id, machine.label]))
    const candidates = listedShareRows(catalog).map((row): SharePickerCandidate => {
        const location = sessionLocation(row)
        const machineLabel = row.hostId === 'local' && location.machineId
            ? labels.get(location.machineId) ?? location.machineName ?? location.machineId
            : location.machineName ?? location.machineId ?? row.hostLabel
        const fields = collectSidebarSearchFields(row, { ...location, machineName: machineLabel })
        if (!fields.machine.includes(row.hostLabel)) fields.machine.push(row.hostLabel)
        return Object.freeze({ id: row.id, hostId: row.hostId, hostLabel: row.hostLabel,
            sourceSessionId: row.sourceSessionId, target: shareTargetForRow(row),
            title: row.displayTitle, directory: sessionFolder(row).path, machineId: location.machineId ?? null,
            machineLabel, engine: location.engine,
            updatedAt: row.updatedAt,
            active: sidebarSessionActive(row), pinned: row.pinned,
            fields: Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, Object.freeze([...values])])) as SharePickerCandidate['fields']),
        })
    })
    const selected = candidates.filter(candidate => candidate.target !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt)
    return Object.freeze({ candidates: Object.freeze(selected), activityDates: new Set(selected.map(candidate => localDayKey(candidate.updatedAt))) })
}

export function filterSharePicker(snapshot: SharePickerSnapshot, query: string, range: ReturnType<typeof sidebarTimeRange>, previewLimit: number): {
    candidates: readonly SharePickerCandidate[]; hiddenActive: number; searching: boolean
} {
    const searching = Boolean(query.trim() || range)
    if (searching) return { candidates: snapshot.candidates.filter(candidate => matchesSidebarTime(candidate.updatedAt, range)
        && scoreSidebarSearch(candidate.fields, query).matched), hiddenActive: 0, searching }
    const active = snapshot.candidates.filter(candidate => candidate.active), limit = normalizeSessionPreviewLimit(previewLimit)
    return { candidates: active.slice(0, limit), hiddenActive: Math.max(0, active.length - limit), searching }
}

export type ShareCandidateResolution = { status: 'ready'; row: WorkspaceCatalogRow; target: ShareTarget }
    | { status: 'pending' | 'missing' | 'offline' | 'ambiguous' }

function liveTargets(catalog: WorkspaceCatalog): Map<string, WorkspaceCatalogRow[]> {
    const index = new Map<string, WorkspaceCatalogRow[]>()
    for (const row of listedShareRows(catalog)) {
        const target = shareTargetForRow(row)
        if (!target) continue
        const key = JSON.stringify([row.hostId, shareTargetKey(target)]), rows = index.get(key) ?? []
        rows.push(row); index.set(key, rows)
    }
    return index
}
function resolveFromIndex(candidate: SharePickerCandidate, index: ReadonlyMap<string, readonly WorkspaceCatalogRow[]>): ShareCandidateResolution {
    if (!candidate.target) return { status: 'pending' }
    const matches = index.get(JSON.stringify([candidate.hostId, shareTargetKey(candidate.target)])) ?? []
    if (!matches.length) return { status: 'missing' }
    if (matches.length !== 1) return { status: 'ambiguous' }
    const row = matches[0]!
    return row.hostOnline ? { status: 'ready', row, target: candidate.target } : { status: 'offline' }
}
export function resolveShareCandidates(candidates: readonly SharePickerCandidate[], catalog: WorkspaceCatalog): ReadonlyMap<string, ShareCandidateResolution> {
    const index = liveTargets(catalog)
    return new Map(candidates.map(candidate => [candidate.id, resolveFromIndex(candidate, index)]))
}

/** Recheck the immutable source address, never a display ID reused by a different source. */
export function resolveShareCandidate(candidate: SharePickerCandidate, catalog: WorkspaceCatalog): ShareCandidateResolution {
    return resolveFromIndex(candidate, liveTargets(catalog))
}

export function sharePreviewText(payload: Pick<SharePayload, 'text' | 'url' | 'title'>, maximum = 200): string {
    const text = (payload.text || payload.url || payload.title).trim()
    return text.length > maximum ? `${text.slice(0, maximum).trimEnd()}…` : text
}
export function shareFileSize(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
