/**
 * Share target preparation/filtering adapted from HAPI 0f8ef697:
 * web/src/routes/share/index.tsx, lib/sharePickerSessions.ts and
 * components/SessionList.tsx. Copyright HAPI contributors. AGPL-3.0-only.
 * A snapshot is a list of display facts, not a lease on another Host's Session.
 */
import type { WorkspaceCatalog, WorkspaceCatalogRow } from '../client/controller.ts'
import { sessionLocation } from '../client/controller.ts'
import type { CatalogMachine, CatalogSession } from '../client-api.ts'
import { shareTargetKey, type SharePayload, type ShareTarget } from '../client/share-transfer.ts'
import { isSourceChild, sourceIdentity } from './legacy.ts'
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
    readonly globallyPinned: boolean
    readonly sourceListFacts: CatalogSession['sourceListFacts'] | null
    readonly fields: Readonly<{ [K in keyof SidebarSearchFields]: readonly string[] }>
}
export interface SharePickerSnapshot {
    readonly candidates: readonly SharePickerCandidate[]
    readonly activityDates: ReadonlySet<string>
}

/** A cold HAPI display must never fall back to a normal DSH delivery identity. */
export function shareTargetForRow(row: WorkspaceCatalogRow): ShareTarget | null {
    if (isSourceChild(row)) return null
    const source = sourceIdentity(row)
    if (source) return source.hubId && source.sessionId ? { kind: 'hapi', hubId: source.hubId, sessionId: source.sessionId } : null
    if (/^(?:hapi-codex-|hapi-observed-)/u.test(row.sourceSessionId)) return null
    return { kind: 'dsh', hostId: row.hostId, sessionId: row.sourceSessionId }
}

/** Official ids are the Host's catalog membership; retained fallback rows are not new targets. */
export function listedShareRows(catalog: WorkspaceCatalog): WorkspaceCatalogRow[] {
    return [...new Set(catalog.ids)].flatMap(id => {
        const row = catalog.byId[id]
        return row && !isSourceChild(row) ? [row] : []
    })
}

function nativeGroup(candidate: SharePickerCandidate): string | null {
    const facts = candidate.sourceListFacts, target = candidate.target
    if (target?.kind !== 'hapi' || !facts?.agentSessionId?.trim()) return null
    const identity = facts.flavor === 'codex'
        ? ['codex', candidate.machineId, facts.codexStoreId, facts.agentSessionId.trim()]
        : [facts.flavor ?? 'unknown', facts.agentSessionId.trim()]
    // Original HAPI preparation runs within one Hub. The unified picker must
    // not merge separate Hubs or serving graph identities with coincident IDs.
    return JSON.stringify([candidate.hostId, target.hubId, ...identity])
}
function preferred(left: SharePickerCandidate, right: SharePickerCandidate): number {
    return Number(right.active) - Number(left.active) || Number(right.globallyPinned) - Number(left.globallyPinned)
        || Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt
}
function emptySourceStub(candidate: SharePickerCandidate): boolean {
    const facts = candidate.sourceListFacts
    if (candidate.target?.kind !== 'hapi' || !facts || facts.hasConversationContent !== false) return false
    if (candidate.active || candidate.pinned || candidate.globallyPinned || facts.agentSessionId?.trim() || facts.hasTitleSignal) return false
    return true
}

/** Clone the published fields once. Live titles, activity and metadata cannot
 * silently move the target beneath a pointer while a share is being chosen. */
export function captureSharePicker(catalog: WorkspaceCatalog, machines: readonly CatalogMachine[] = []): SharePickerSnapshot {
    const labels = new Map(machines.map(machine => [machine.id, machine.label]))
    const candidates = listedShareRows(catalog).map((row): SharePickerCandidate => {
        const source = sourceIdentity(row), location = sessionLocation(row)
        const machineLabel = source && row.hostId === 'local' && location.machineId
            ? labels.get(location.machineId) ?? location.machineName ?? location.machineId
            : location.machineName ?? location.machineId ?? row.hostLabel
        const fields = collectSidebarSearchFields(row, { ...location, machineName: machineLabel })
        if (!fields.machine.includes(row.hostLabel)) fields.machine.push(row.hostLabel)
        const sourceTime = source ? row.sourceLastActiveAt : undefined
        return Object.freeze({ id: row.id, hostId: row.hostId, hostLabel: row.hostLabel,
            sourceSessionId: row.sourceSessionId, target: shareTargetForRow(row),
            title: row.displayTitle, directory: sessionFolder(row).path, machineId: location.machineId ?? null,
            machineLabel, engine: location.engine,
            updatedAt: typeof sourceTime === 'number' && Number.isFinite(sourceTime) ? sourceTime : row.updatedAt,
            active: sidebarSessionActive(row), pinned: row.pinned, globallyPinned: row.sourcePinMode === 'global',
            sourceListFacts: row.sourceListFacts ? Object.freeze({ ...row.sourceListFacts }) : null,
            fields: Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, Object.freeze([...values])])) as SharePickerCandidate['fields']),
        })
    })
    const grouped = new Map<string, number>(), prepared: SharePickerCandidate[] = []
    for (const candidate of candidates) {
        const key = nativeGroup(candidate)
        const index = key ? grouped.get(key) : undefined
        if (index === undefined) { if (key) grouped.set(key, prepared.length); prepared.push(candidate) }
        else if (preferred(candidate, prepared[index]!) < 0) prepared[index] = candidate
    }
    // The source preparation filters duplicate placeholders before choosing a
    // preview. Unknown content facts and normal DSH rows always survive.
    const selected = prepared.filter(candidate => !emptySourceStub(candidate))
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
