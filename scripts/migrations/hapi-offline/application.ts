/** X4 offline application conversion. No Hub client, notification sender or execution owner. */
import { appAccountScopeSchema, appScopeKey, appSourceRouteSchema, type AppAccountScope, type AppSourceRoute } from '../../../src/workspace/app-service-types.ts'
import { sourceAliasDocumentSchema, type SourceAliasDocument, type LegacySourceReference } from '../../../src/workspace/source-aliases.ts'
import { parseWorkspaceState, panes, type WorkspaceNode, type WorkspaceState } from '../../../src/client/model.ts'
import { legacyWorkspaceSnapshotSchema } from './workspace-schema.ts'
import { sessionResourceId, parseSessionResourceId } from '../../../src/shared/session-resource-id.ts'
import { parseDocumentRef } from '../../../src/workspace/documents.ts'
import type { OfflineStage } from './index.ts'
import type { RecoveryObjectIndex } from './common.ts'
import { domainObject, domainReport, isRecord, jsonInput, originalKey } from './domain.ts'

export interface ApplicationMigrationInput {
    inputId: string
    kind: 'workspace' | 'workspace-v2' | 'browser-export' | 'read-state' | 'notification-preferences'
    /** Required for an original HAPI workspace whose session IDs have no Hub field. */
    hubId?: string
}
export interface ApplicationMigrationOptions {
    scope: AppAccountScope
    inputs: readonly ApplicationMigrationInput[]
    aliases: SourceAliasDocument
    /** Frozen exact current sources admitted by the migration operator, not looked up online. */
    current: readonly AppSourceRoute[]
}
const resourceId = (source: AppSourceRoute) => sessionResourceId(source.hostId, source.sessionId)
function legacyMatch(a: LegacySourceReference, b: LegacySourceReference): boolean {
    return a.kind === 'hapi-display' && b.kind === 'hapi-display' ? a.hostId === b.hostId && a.displayId === b.displayId
        : a.kind === 'hapi-session' && b.kind === 'hapi-session' && a.hubId === b.hubId && a.sessionId === b.sessionId && a.namespace === b.namespace
}

export function createApplicationStage(options: ApplicationMigrationOptions): OfflineStage {
    const scope = appAccountScopeSchema.parse(options.scope), aliases = sourceAliasDocumentSchema.parse(options.aliases)
    if (appScopeKey(scope) !== appScopeKey(aliases.scope)) throw new Error('Application aliases belong to another account or origin.')
    const current = options.current.map(value => appSourceRouteSchema.parse(value))
    const admitted = new Map(current.map(value => [resourceId(value), value]))
    return { id: 'application', version: '1', configuration: { ...options, scope, aliases, current }, async run({ snapshot, recovery }) {
        const outputs: RecoveryObjectIndex[] = []
        const convertWorkspace = async (input: ApplicationMigrationInput, value: unknown, suffix: string): Promise<void> => {
            let state: WorkspaceState
            try {
                if (input.kind === 'workspace-v2') {
                    const legacy = legacyWorkspaceSnapshotSchema.parse(value)
                    if (!legacy.workspaces.length) {
                        outputs.push(await domainObject(recovery, 'application', { inputId: input.inputId, key: originalKey(input.inputId, suffix), disposition: 'archive', original: value })); return
                    }
                    const map = (node: typeof legacy.workspaces[number]['root']): WorkspaceNode => {
                        if (node.type === 'split') return { ...node, children: node.children.map(map) }
                        if (node.resource.kind === 'empty') return { ...node, resource: node.resource }
                        const identity = { sourceSessionId: node.resource.sessionId, ...(input.hubId ? { sourceHubId: input.hubId } : {}) }
                        return node.resource.kind === 'document'
                            ? { ...node, resource: { ...node.resource, document: parseDocumentRef(node.resource.document), ...identity } }
                            : { ...node, resource: { ...node.resource, ...identity } }
                    }
                    const windows = legacy.workspaces.map(item => ({ ...item, root: map(item.root) }))
                    state = parseWorkspaceState({ schemaVersion: 1, revision: 0, windows, activeWindowId: windows[0]!.id,
                        focused: Object.fromEntries(windows.map(item => [item.id, panes(item.root)[0]!.id])), zoomed: {} })
                } else state = parseWorkspaceState(isRecord(value) && 'state' in value ? value.state : value)
            } catch {
                outputs.push(await domainObject(recovery, 'application', { inputId: input.inputId, key: originalKey(input.inputId, suffix), disposition: 'offline-recovery', original: value,
                    unresolved: true, reason: 'Unsupported workspace schema. Its original bytes and resource identities are retained.' })); return
            }
            const unresolved: Array<{ paneId: string; reason: string }> = []
            const map = (node: WorkspaceNode): WorkspaceNode => {
                if (node.type === 'split') return { ...node, children: node.children.map(map) }
                const resource = node.resource
                if (resource.kind === 'empty') return node
                const address = parseSessionResourceId(resource.sessionId)
                const identity: LegacySourceReference | undefined = resource.sourceHubId && resource.sourceSessionId
                    ? { kind: 'hapi-session', hubId: resource.sourceHubId, sessionId: resource.sourceSessionId }
                    : resource.sourceHubId || resource.sourceSessionId ? undefined : { kind: 'hapi-display', hostId: address.hostId, displayId: address.sessionId }
                const matches = identity ? aliases.entries.filter(entry => legacyMatch(entry.legacy, identity)) : []
                const targets = new Map(matches.flatMap(entry => entry.target ? [[JSON.stringify(entry.target), entry.target] as const] : []))
                const direct = !resource.sourceSessionId && !resource.sourceHubId ? admitted.get(resource.sessionId) : undefined
                const target = direct ?? (targets.size === 1 ? [...targets.values()][0] : undefined)
                if (!target || !admitted.has(resourceId(target))) {
                    unresolved.push({ paneId: node.id, reason: targets.size > 1 ? 'The original identity has multiple targets.' : 'The original identity has no exact admitted target.' }); return node
                }
                // A chat identity does not prove that a legacy terminal or file
                // target belongs to its new provider. X2/X3 retain those objects.
                if (resource.kind !== 'chat') {
                    if (direct) return node
                    unresolved.push({ paneId: node.id, reason: 'The original document or terminal needs its own resource migration.' }); return node
                }
                return { ...node, resource: { kind: 'chat', sessionId: resourceId(target) } }
            }
            const converted = parseWorkspaceState({ ...state, windows: state.windows.map(window => ({ ...window, root: map(window.root) })) })
            outputs.push(await domainObject(recovery, 'application', { inputId: input.inputId, key: originalKey(input.inputId, suffix), disposition: 'migrate', original: value,
                converted: { scope, state: converted, unresolved, install: 'explicit-cas', clearDisplayAnchors: true }, unresolved: unresolved.length > 0,
                ...(unresolved.length ? { reason: 'Some panes retain their original unresolved identities. No title, suffix or focused conversation was used to guess a destination.' } : {}) }))
        }
        for (const input of options.inputs) {
            const raw = await jsonInput(snapshot, input.inputId)
            if (raw.error) {
                outputs.push(await domainObject(recovery, 'application', { inputId: input.inputId, key: originalKey(input.inputId, 'unknown'), disposition: 'offline-recovery', original: raw.value, unresolved: true, reason: raw.error })); continue
            }
            if (input.kind === 'workspace' || input.kind === 'workspace-v2') { await convertWorkspace(input, raw.value, 'workspace'); continue }
            if (input.kind === 'browser-export') {
                const value = raw.value
                if (!isRecord(value) || value.version !== 1 || value.origin !== scope.origin || !Array.isArray(value.localStorage)) {
                    outputs.push(await domainObject(recovery, 'application', { inputId: input.inputId, key: originalKey(input.inputId, 'browser'), disposition: 'offline-recovery', original: value, unresolved: true, reason: 'Browser export version/origin is not the selected application. No browser account is inferred.' })); continue
                }
                for (const [index, item] of value.localStorage.entries()) {
                    const row = isRecord(item) ? item : {}, key = typeof row.key === 'string' ? row.key : `unknown-${index}`
                    const original = typeof row.value === 'string' ? (() => { try { return JSON.parse(row.value) as unknown } catch { return row.value } })() : item
                    if (key.startsWith('hapi-dsh:workspace:v1:') && isRecord(original) && (original.schemaVersion === 1 || 'state' in original)) {
                        await convertWorkspace({ ...input, kind: 'workspace' }, original, key)
                    } else outputs.push(await domainObject(recovery, 'application', { inputId: input.inputId, key: originalKey(input.inputId, key), disposition: 'offline-recovery', original: item,
                        converted: { scope: null, automaticImport: false }, reason: 'Original browser key/value retained. Its account, source and current conflict baseline must be selected explicitly.' }))
                }
                continue
            }
            outputs.push(await domainObject(recovery, 'application', { inputId: input.inputId, key: originalKey(input.inputId, input.kind), disposition: 'archive', original: raw.value,
                converted: input.kind === 'notification-preferences' ? { scope, resubscribe: true, sendHistoricalEvents: false, restoreEndpoint: false }
                    : { scope, automaticWrite: false, reason: 'A legacy display sequence or timestamp cannot become an original-source event coordinate.' } }))
        }
        await domainReport(recovery, 'application', options.inputs, outputs, [])
    } }
}
