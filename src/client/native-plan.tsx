import { useEffect, useSyncExternalStore } from 'react'
import type { NativeControlLedger } from './native-control-state.ts'
import type { WorkspaceTranslate, WorkspaceKey } from './locales.ts'
import type { NativePlanReceipt } from '../client-api.ts'
import { recordSourceFailure, type DiagnosticIdentity } from './diagnostics/index.ts'

const labels: Record<NativePlanReceipt['status'], WorkspaceKey> = {
    submitting: 'planSubmitting', submitted: 'planSubmitted', queued: 'planQueued', invoked: 'planInvoked', indeterminate: 'planUnknown', rejected: 'planRejected',
}

/** Background refresh failures are diagnostics evidence, never a visible plan panel. */
export function nativePlanVisible(input: { planId: string | null; sourcePlanId?: string | null; operations: number }): boolean {
    return Boolean(input.planId || input.sourcePlanId || input.operations > 0)
}

/** Plan prose remains in official Conversation; this is only the source-owned action and receipt. */
export function NativePlanControls({ ledger, sessionId, planId, disabled, t, identity }: {
    ledger: NativeControlLedger; sessionId: string; planId: string | null; disabled: boolean; t: WorkspaceTranslate
    identity?: DiagnosticIdentity | undefined
}) {
    const controller = ledger.plan(sessionId)
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const sourcePlanId = state.data?.planId ?? null
    const visible = nativePlanVisible({ planId, sourcePlanId, operations: state.operations.length })
    const watch = Boolean(planId || sourcePlanId || state.operations.some(row => !['invoked', 'rejected'].includes(row.status)))
    useEffect(() => {
        // One probe restores a durable receipt even when the source no longer
        // advertises a plan; background failures never create or expand a panel.
        void controller.refresh()
    }, [controller, planId, sessionId])
    useEffect(() => {
        if (!visible || !watch) return
        const timer = setInterval(() => { void controller.refresh() }, 3000)
        return () => { clearInterval(timer) }
    }, [controller, visible, watch])
    useEffect(() => {
        if (state.error) recordSourceFailure(sessionId, 'plan', state.error, identity)
    }, [sessionId, state.error, identity?.hubId, identity?.hapiSessionId])
    const requested = sourcePlanId && state.operations.some(row => row.planId === sourcePlanId && row.status !== 'rejected')
    const blocked = disabled || state.busy || state.loading || !sourcePlanId || Boolean(state.data?.readOnly) || Boolean(requested)
    if (!visible) return null
    return <section className="hapi-native-plan" aria-label={t('nativePlan')}>
        <div className="hapi-button-row">
            <strong>{t('nativePlan')}</strong>
            {sourcePlanId && <button type="button" disabled={blocked} onClick={() => { void controller.implement(sourcePlanId) }}>{t('implementPlan')}</button>}
            <button type="button" disabled={state.loading || state.busy} onClick={() => { void controller.refresh() }}>{t('checkNativeResult')}</button>
        </div>
        {state.operations.map(row => <div key={row.operationId} className="hapi-plan-receipt" data-plan-operation={row.operationId} data-plan-state={row.status}>
            <p role="status">{t(labels[row.status])}</p>
            {row.message && <p>{row.message}</p>}
            <details><summary>{t('more')}</summary><code>{row.operationId}</code></details>
        </div>)}
    </section>
}
