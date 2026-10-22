/** The OS badge observes the sidebar's source-backed read watermarks. Like
 * original HAPI useAppBadge, search/date filters do not change the app badge. */
import type { WorkspaceCatalogRow, WorkspaceController } from '../client/controller.ts'
import type { SourceNotificationsUiOptions } from '../client/source-notifications/runtime.ts'
import type { SourceReadStatus } from './read-sync.ts'
import { sidebarTree } from './sidebar-tree.ts'

export interface WorkspaceNotificationsBridge extends SourceNotificationsUiOptions {
    readStatus(value: SourceReadStatus): void
    dispose(): void
}

export function createWorkspaceNotifications(controller: WorkspaceController): WorkspaceNotificationsBridge {
    const listeners = new Set<() => void>()
    let readState: SourceReadStatus = 'pending'
    const publish = (): void => { for (const listener of [...listeners]) listener() }
    const stops = [controller.subscribe(publish), controller.sidebar.subscribe(publish)]
    return {
        getUnreadCount() {
            const { catalog } = controller.getSnapshot()
            if (readState !== 'ready' || catalog.phase !== 'ready') return null
            // These are exactly the sidebar's eligible, non-archived roots.
            // A retained hidden child is not a second independent notification.
            const rows = catalog.ids.map(id => catalog.byId[id]).filter((row): row is WorkspaceCatalogRow => row !== undefined && !row.archived)
            return sidebarTree(rows).filter(({ row }) => controller.sidebar.isUnread(row.id, row.updatedAt)).length
        },
        subscribeUnread(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
        openSource(source) { return controller.openSourceSession({ hubId: source.hubId, sessionId: source.sessionId,
            ...(source.messageId ? { messageId: source.messageId } : {}), ...(source.requestId ? { requestId: source.requestId } : {}) }) },
        readStatus(value) { if (readState !== value) { readState = value; publish() } },
        dispose() { for (const stop of stops) stop(); listeners.clear() },
    }
}
