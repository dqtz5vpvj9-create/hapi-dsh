import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NativeActions, ObservedActions, type NativeActionsApi } from './native-actions.tsx'
import { installSourceStateView } from './source-state-view.tsx'
import type { HapiRemoteApi } from '../client-api.ts'
import { useSourceQueuedEditing } from './source-queued-edit.tsx'
import { NativePlanControls } from './native-plan.tsx'
import { useLayoutEffect, useState } from 'react'
import { useWorkspacePane } from './surface/pane-context.tsx'

type SourceDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'hapiWorkspace'>

/**
 * Source approvals, queue receipts and settings are additive composer content.
 * The original Conversation owns its whole header and chat/input subtree.
 */
export function installNativeActionDock(ctx: Context, native: NativeActionsApi, api: HapiRemoteApi): () => void {
    const sourceView = installSourceStateView(ctx)
    const SourceDock = (props: SourceDockProps) => {
        const { sessionId, useProjection, t } = props
        const queued = useSourceQueuedEditing(ctx, api, props)
        const actions: NativeActionsApi = { ...native, ...(queued.actions ? { queuedEditing: queued.actions } : {}) }
        const projection = useProjection('hapi'), observed = useProjection('hapiObserved')
        const pane = useWorkspacePane(ctx)
        const [statusTarget, setStatusTarget] = useState<HTMLElement | null>(null)
        useLayoutEffect(() => {
            setStatusTarget(pane ? document.querySelector<HTMLElement>(`[data-hapi-pane-status="${CSS.escape(pane.paneId)}"]`) : null)
        }, [pane?.paneId, sessionId])
        sourceView.useSourceState(sessionId, Boolean(projection || observed))
        if (!(projection || observed)) return null
        const scope = `.hapi-host-frame [data-conversation-session="${CSS.escape(sessionId)}"]`
        const activeDelivery = (rows: readonly { state: string }[]): boolean => rows.some(row => !['invoked', 'cancelled'].includes(row.state))
        // Only actionable/exceptional states produce a dock element; routine
        // metadata rows are gone, so an empty dock must not occupy composer space.
        const hasActions = Boolean(
            projection && (projection.pendingRequests.length > 0 || activeDelivery(projection.delivery) || projection.error
                || projection.readOnly || projection.nativeConnection !== 'attached')
            || observed && !observed.dshChild && (observed.pendingRequests.length > 0 || activeDelivery(observed.delivery) || observed.error || observed.readOnly)
            || queued.panel)
        return <>
            <style>{`${scope} [data-slot="conversation.input.model"],${scope} [data-slot="conversation.input.permission"],${scope} [data-slot="conversation.input.plan"]{display:none!important}${native.branchLabel ? `${scope} [data-turn-tail] [data-clock="end"] button[aria-label="${CSS.escape(native.branchLabel())}"]{display:none!important}` : ''}`}</style>
            {/* The initial read also restores a receipt after its proposal has
                been consumed. The component returns null without a plan or
                receipt, so this must stay outside the other action gates. */}
            {projection && native.controls && <NativePlanControls ledger={native.controls} sessionId={sessionId}
                planId={projection.planId} disabled={projection.readOnly || projection.nativeConnection !== 'attached'} t={t}
                identity={{ hubId: projection.hubId, sessionId, hapiSessionId: projection.hapiSessionId, engine: 'codex-native',
                    ...(projection.machineId === null ? {} : { machineId: projection.machineId }) }}/>}
            {hasActions && <div className="hapi-native-dock" data-hapi-source-controls={sessionId}>
                <NativeActions sessionId={sessionId} projection={projection} api={actions} t={t} statusTarget={statusTarget} recovery={queued.panel}/>
                <ObservedActions sessionId={sessionId} projection={observed} api={actions} t={t} statusTarget={statusTarget} recovery={queued.panel}/>
            </div>}
        </>
    }
    const stopDock = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'hapi.source-controls', order: -100, locale: 'hapiWorkspace',
    }, SourceDock))
    const style = document.createElement('style'); style.textContent = `.hapi-queued-edit-recovery{font-size:12px;min-width:0;padding:8px;border:1px solid var(--border-secondary,#8884);border-radius:8px}.hapi-queued-edit-recovery pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:150px;overflow:auto}.hapi-queued-edit-recovery section{padding:8px 0;border-top:1px solid var(--border-secondary,#8884)}.hapi-queued-edit-recovery small{display:block;overflow-wrap:anywhere}.hapi-queued-edit-recovery button{cursor:pointer;margin:4px 4px 4px 0}.hapi-queued-edit-recovery button:disabled{opacity:.5;cursor:default}`; document.head.append(style)
    return () => { stopDock(); sourceView.dispose(); style.remove() }
}
