import type {} from '@deepseek-ai/dsh-api-session-controller/client'
/** Application links keep the original source and position through asynchronous resolution. */
import { appTargetSchema, type AppTarget } from '../workspace/app-service-types.ts'
import { remoteValue } from '../client-api.ts'
import { sessionResourceId, type WorkspaceController } from './controller.ts'
import type { PaneReadingTarget } from './reading-intent.ts'
import { panes } from './model.ts'

/** An existing conversation occurrence captured by its originating action. */
export interface AppTargetPane { readonly hostId: string; readonly paneId: string; readonly sessionId: string }

export function createAppTargetNavigation(controller: Pick<WorkspaceController, 'host' | 'openSession'> & { store: Pick<WorkspaceController['store'], 'focusedPane' | 'getSnapshot' | 'focus'> }) {
    let revision = 0
    return async (raw: AppTarget, requestState: 'pending' | 'settled' | undefined, signal: AbortSignal, destination?: AppTargetPane): Promise<void> => {
        const mine = ++revision, target = appTargetSchema.parse(raw), layout = controller.store.getSnapshot()
        const paneAt = () => destination && controller.store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.id === destination.paneId)
        const original = paneAt()
        const originalResource = original && JSON.stringify(original.resource)
        const current = (): void => {
            signal.throwIfAborted()
            if (mine !== revision || !destination && controller.store.getSnapshot() !== layout) throw new Error('A newer navigation replaced this target.')
            if (destination && (destination.hostId !== target.source.hostId || !original
                || original.resource.kind !== 'chat' && !(original.resource.kind === 'view' && original.resource.target.type === 'conversation')
                || original.resource.sessionId !== sessionResourceId(destination.hostId, destination.sessionId)
                || JSON.stringify(paneAt()?.resource) !== originalResource)) throw new Error('The original conversation pane changed. Open history again from its current conversation.')
        }
        current()
        const host = controller.host(target.source.hostId)
        if (!host) throw new Error('The original machine is not connected. Reconnect it and open this notification again.')
        let reading: PaneReadingTarget = { kind: 'latest' }
        if (target.kind === 'request' && requestState === 'pending' && target.source.kind === 'hhpi') reading = { kind: 'approval', requestId: target.requestId }
        else if (target.kind !== 'session') {
            let position = target.position
            if (position.kind === 'native') {
                if (!host.locateSourcePosition) throw new Error('The original source cannot resolve this notification position.')
                const value = remoteValue(await host.locateSourcePosition({ sessionId: target.source.sessionId,
                    position: { turnId: position.turnId, ...(position.itemId ? { itemId: position.itemId } : {}) } }, signal))
                current(); position = { kind: 'hhpi', ...value }
            }
            reading = { kind: 'message', messageId: String(position.seq), origin: 'notification',
                ...(position.kind === 'hhpi' ? { epoch: position.epoch } : {}) }
        }
        current()
        if (controller.host(host.id) !== host) throw new Error('The source connection changed. Open this notification again.')
        const resourceId = sessionResourceId(host.id, target.source.sessionId)
        if (destination) controller.store.focus(destination.paneId)
        controller.openSession(resourceId, undefined, reading)
        const pane = destination ? paneAt() : controller.store.focusedPane()
        if (!pane || pane.resource.kind !== 'chat' || pane.resource.sessionId !== resourceId) throw new Error('Keep or save the open document before changing conversations.')
    }
}
