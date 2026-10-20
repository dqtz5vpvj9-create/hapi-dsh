import { useEffect, useSyncExternalStore } from 'react'
import type { NativeControlLedger } from './native-control-state.ts'
import type { WorkspaceTranslate, WorkspaceKey } from './locales.ts'
import type { NativePlanReceipt } from '../client-api.ts'

const labels: Record<NativePlanReceipt['status'], WorkspaceKey> = {
    submitting: 'planSubmitting', submitted: 'planSubmitted', queued: 'planQueued', invoked: 'planInvoked', indeterminate: 'planUnknown', rejected: 'planRejected',
}

/** Plan prose remains in official Conversation; this is only the source-owned action and receipt. */
export function NativePlanControls({ ledger, sessionId, planId, disabled, t }: {
    ledger: NativeControlLedger; sessionId: string; planId: string | null; disabled: boolean; t: WorkspaceTranslate
}) {
    const controller = ledger.plan(sessionId)
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const watch = Boolean(planId || state.data?.planId || state.operations.some(row => !['invoked', 'rejected'].includes(row.status)))
    useEffect(() => {
        void controller.refresh()
        if (!watch) return
        const timer = setInterval(() => { void controller.refresh() }, 3000)
        return () => { clearInterval(timer) }
    }, [controller, planId, watch])
    if (!planId && !state.data?.planId && !state.operations.length && !state.error) return null
    const sourcePlanId = state.data?.planId
    const requested = sourcePlanId && state.operations.some(row => row.planId === sourcePlanId && row.status !== 'rejected')
    const blocked = disabled || state.busy || state.loading || !sourcePlanId || Boolean(state.data?.readOnly) || Boolean(requested)
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
        {state.error && <p className="hapi-error" role="alert">{state.error}</p>}
    </section>
}
