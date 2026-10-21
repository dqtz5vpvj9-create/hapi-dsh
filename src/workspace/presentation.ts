/**
 * HAPI workspace content labels, activity priority and W/P destinations adapted
 * from windowIdentity.ts/sessionActivity.ts at 0f8ef697.
 * Copyright HAPI contributors. SPDX-License-Identifier: AGPL-3.0-only
 */
import type { WorkspaceCatalogRow } from '../client/controller.ts'
import { panes, type PaneNode, type WorkspaceState, type WorkspaceWindow } from '../client/model.ts'
import type { HapiProjection } from '../codex/projection-types.ts'
import type { HapiObservedProjection } from '../hapi-agent/projection-types.ts'
import { documentName } from './documents.ts'
import { dshPaneTitle } from './dsh-view.ts'

export type ActivityKind = 'error' | 'permission' | 'input' | 'running' | 'background' | 'idle' | 'offline'
export type SessionActivity = { kind: ActivityKind; running: boolean; pending: boolean; compacting: boolean }
export const activityPriority: Record<ActivityKind, number> = { error: 6, permission: 5, input: 4, running: 3, background: 2, idle: 1, offline: 0 }

export function nativeProjection(row: Pick<WorkspaceCatalogRow, 'projectionValues'> | undefined): HapiProjection {
    const value: unknown = row?.projectionValues && Reflect.get(row.projectionValues, 'hapi')
    return value && typeof value === 'object' && Reflect.get(value, 'engine') === 'codex' ? value as HapiProjection : null
}

export function observedProjection(row: Pick<WorkspaceCatalogRow, 'projectionValues'> | undefined): HapiObservedProjection {
    const value: unknown = row?.projectionValues && Reflect.get(row.projectionValues, 'hapiObserved')
    return value && typeof value === 'object' && Reflect.get(value, 'ownership') === 'hapi-runner' ? value as HapiObservedProjection : null
}

export function sessionActivity(row: Pick<WorkspaceCatalogRow, 'running' | 'projectionValues' | 'hostOnline' | 'sourceRowState'> | undefined): SessionActivity {
    const native = nativeProjection(row)
    const observed = observedProjection(row)
    const requests = native?.pendingRequests ?? observed?.pendingRequests ?? []
    const pending = requests.length > 0 || (row?.sourceRowState?.pendingRequestsCount ?? 0) > 0
    if (!row || row.hostOnline === false || (native && (native.nativeConnection !== 'attached' || native.execution?.status === 'disconnected')) || (observed && (observed.connection === 'disconnected' || !observed.active))) {
        return { kind: 'offline', running: false, pending, compacting: false }
    }
    const blocking = requests.filter(request => request.blocking)
    const waiting = native?.execution?.waitingOn ?? []
    const input = (tool: string): boolean => /request.?user.?input|ask.?user.?question/i.test(tool)
    const kind: ActivityKind = native?.execution?.status === 'systemError' || observed?.error ? 'error'
        : waiting.includes('approval') || blocking.some(request => !input(request.tool)) ? 'permission'
        : waiting.includes('input') || blocking.some(request => input(request.tool)) ? 'input'
        : (native?.execution ? native.execution.status === 'active' : observed ? observed.thinking : row.running) ? 'running'
        : (row.sourceRowState?.backgroundTaskCount ?? 0) > 0 ? 'background' : 'idle'
    return { kind, running: kind === 'running' || kind === 'background', pending, compacting: native?.execution?.compacting === true }
}

export function windowAlias(window: WorkspaceWindow, position: number): string {
    if (window.autoName === false) return window.name
    return window.autoName === true || /^(?:Window|窗口)\s*\d+$/.test(window.name) ? `W${position}` : window.name
}

export function paneTitle(pane: PaneNode, rows: Readonly<Record<string, WorkspaceCatalogRow>>, empty: string): string {
    const resource = pane.resource
    if (resource.kind === 'empty') return empty
    const session = rows[resource.sessionId]?.displayTitle ?? resource.sourceSessionId ?? resource.sessionId
    if (resource.kind === 'document') return resource.title ?? documentName(resource.document)
    if (resource.kind === 'terminal') return `Terminal · ${session}`
    if (resource.kind === 'view') return resource.title ?? dshPaneTitle(resource.target)
    return session
}

export function windowTitle(window: WorkspaceWindow, focusedId: string | undefined, rows: Readonly<Record<string, WorkspaceCatalogRow>>, empty: string): string {
    const available = panes(window.root)
    return paneTitle(available.find(pane => pane.id === focusedId) ?? available[0]!, rows, empty)
}

export function windowActivity(window: WorkspaceWindow, rows: Readonly<Record<string, WorkspaceCatalogRow>>): ActivityKind {
    let result: ActivityKind = 'offline'
    for (const pane of panes(window.root)) {
        if (pane.resource.kind === 'empty') continue
        const kind = sessionActivity(rows[pane.resource.sessionId]).kind
        if (activityPriority[kind] > activityPriority[result]) result = kind
    }
    return result
}

export type PaneDestination = { windowId: string; paneId: string; window: number; pane: number; label: string }
export function sessionDestinations(layout: WorkspaceState): Map<string, PaneDestination> {
    const result = new Map<string, PaneDestination>()
    layout.windows.forEach((window, index) => panes(window.root).forEach((pane, paneIndex) => {
        if (pane.resource.kind === 'chat') result.set(pane.resource.sessionId, { windowId: window.id, paneId: pane.id, window: index + 1, pane: paneIndex + 1, label: `W${index + 1} · P${paneIndex + 1}` })
    }))
    return result
}

/** Preserve live row positions; a deliberate Recent/Refresh action reseeds them. */
export function stableSessionOrder(previous: readonly string[], rows: readonly Pick<WorkspaceCatalogRow, 'id' | 'updatedAt'>[], refresh = false): string[] {
    const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(row => row.id as string)
    if (refresh) return sorted
    const available = new Set(sorted), known = new Set(previous)
    return [...sorted.filter(id => !known.has(id)), ...previous.filter(id => available.has(id))]
}

/** Same path on two machines remains two distinct folders. */
export function sessionFolder(row: WorkspaceCatalogRow): { key: string; path: string; machine: string } {
    const native = nativeProjection(row) ?? observedProjection(row)
    const machine = native?.machineName ?? native?.machineId ?? row.hostLabel
    const identity = native ? `${native.hubId}:${native.machineId ?? row.hostId}` : row.hostId
    const path = row.sourceWorktree?.basePath ?? row.cwd ?? ''
    return { key: JSON.stringify([identity, path]), path, machine }
}
