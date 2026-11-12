/** One account coordinator consumes actual reader commits from all Host graphs. */
import { sourceRoute } from '../shared/source-capability.ts'
import { SourceReadSync, type AppReadApi, type SourceReadStatus } from '../workspace/read-sync.ts'
import { sessionResourceId, type WorkspaceController, type WorkspaceCatalogRow } from './controller.ts'
import type { WorkspaceUiScope } from './workspace-ui.ts'
import type { ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'

export function installWorkspaceReadSync(controller: WorkspaceController, api: AppReadApi, ui: WorkspaceUiScope,
    status: (value: SourceReadStatus) => void, connection?: ConnectionStateSource): () => void {
    let cleanup = (): void => {}
    const route = (row: WorkspaceCatalogRow) => {
        try { return sourceRoute(row.hostId, row.sourceSessionId, 'local') } catch { return null }
    }
    const start = (): void => {
        cleanup(); cleanup = () => {}; status('pending')
        const identity = ui.application.getSnapshot()
        if (!identity) return
        const sync = new SourceReadSync(controller, api, { scope: identity.account, deviceId: identity.deviceId,
            isOnline: () => navigator.onLine !== false && !['disconnected', 'connecting'].includes(connection?.getSnapshot() ?? ''),
            routeForRow: route, headForRow: async (row, signal) => {
                const source = route(row)
                return source ? controller.host(row.hostId)?.readHead?.(source, signal) ?? null : null
            } }, status)
        const stop = ui.readCommits.subscribe(commit => {
            if (identity.signal.aborted) return
            const id = sessionResourceId(commit.hostId, commit.sessionBinding.sessionId)
            const row = controller.getSnapshot().catalog.byId[id], source = row && route(row)
            if (source) sync.commitReading(id, source, commit.position, commit.at)
        })
        sync.start()
        const online = (): void => { sync.reconnect() }
        const visible = (): void => { if (document.visibilityState === 'visible') online() }
        const abort = (): void => { sync.dispose() }
        const stopConnection = connection?.subscribe(() => { if (connection.getSnapshot() === 'connected') online() })
        window.addEventListener('online', online)
        window.addEventListener('pageshow', online)
        document.addEventListener('visibilitychange', visible)
        identity.signal.addEventListener('abort', abort, { once: true })
        cleanup = () => { window.removeEventListener('online', online); window.removeEventListener('pageshow', online)
            document.removeEventListener('visibilitychange', visible); identity.signal.removeEventListener('abort', abort)
            stopConnection?.(); stop(); sync.dispose() }
    }
    const stopIdentity = ui.application.subscribe(start)
    start()
    return () => { stopIdentity(); cleanup() }
}
