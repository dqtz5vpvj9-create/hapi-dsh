import { useEffect, useState, useSyncExternalStore } from 'react'
import type { NativeForkRequest, NativeForkView, NativeSettingChange, NativeSettings } from '../client-api.ts'
import { NativeControlLedger, nativeForkUnresolved } from './native-control-state.ts'
import type { WorkspaceTranslate } from './locales.ts'

function currentChoice(current: string | null, choices: readonly string[], unknown: string) {
    return current === null ? <option value="" disabled>{unknown}</option>
        : choices.includes(current) ? null : <option value={current} disabled>{current}</option>
}

function SettingsForm({ data, disabled, change, t }: { data: NativeSettings; disabled: boolean; change: (change: NativeSettingChange) => void; t: WorkspaceTranslate }) {
    const current = data.values
    const model = data.models.find(row => row.id === current.model)
    const efforts = model?.reasoningEfforts ?? []
    // Native Codex always accepts its standard/default tier; catalogs may
    // advertise only the optional fast tier.
    const tiers = ['standard', ...(model?.serviceTiers.includes('fast') ? ['fast'] : [])]
    return <fieldset className="hapi-native-settings-fields" disabled={disabled}>
        <label>{t('model')}<select aria-label={t('nativeModel')} value={current.model ?? ''} disabled={disabled || !data.models.length} onChange={event => change({ kind: 'model', value: event.currentTarget.value })}>
            {currentChoice(current.model, data.models.map(row => row.id), t('sourceUnreported'))}
            {data.models.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select></label>
        <label>{t('reasoning')}<select aria-label={t('nativeReasoning')} value={current.reasoningEffort ?? ''} disabled={disabled || !efforts.length} onChange={event => change({ kind: 'reasoningEffort', value: event.currentTarget.value || null })}>
            <option value="">{t('modelDefault')}</option>
            {current.reasoningEffort !== null && !efforts.includes(current.reasoningEffort) && <option value={current.reasoningEffort} disabled>{current.reasoningEffort}</option>}
            {efforts.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label>{t('permission')}<select aria-label={t('nativePermission')} value={current.permissionMode ?? ''} onChange={event => change({ kind: 'permissionMode', value: event.currentTarget.value as 'default' | 'read-only' | 'yolo' })}>
            {currentChoice(current.permissionMode, ['default', 'read-only', 'yolo'], t('sourceUnreported'))}
            <option value="default">{t('permissionDefault')}</option><option value="read-only">{t('permissionReadOnly')}</option><option value="yolo">{t('permissionYolo')}</option>
        </select></label>
        <label>{t('collaboration')}<select aria-label={t('nativeCollaboration')} value={current.collaborationMode ?? ''} onChange={event => change({ kind: 'collaborationMode', value: event.currentTarget.value as 'default' | 'plan' })}>
            {currentChoice(current.collaborationMode, ['default', 'plan'], t('sourceUnreported'))}
            <option value="default">{t('collaborationDefault')}</option><option value="plan">{t('collaborationPlan')}</option>
        </select></label>
        {(tiers.length > 0 || current.serviceTier !== null) && <label>{t('serviceTier')}<select aria-label={t('nativeServiceTier')} disabled={disabled || !tiers.length} value={current.serviceTier ?? ''} onChange={event => change({ kind: 'serviceTier', value: event.currentTarget.value as 'fast' | 'standard' })}>
            {currentChoice(current.serviceTier, tiers, t('sourceUnreported'))}{tiers.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>}
    </fieldset>
}

export function NativeSettingsControls({ ledger, sessionId, disabled, t }: { ledger: NativeControlLedger; sessionId: string; disabled: boolean; t: WorkspaceTranslate }) {
    const controller = ledger.settings(sessionId)
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const [open, setOpen] = useState(false)
    useEffect(() => {
        if (!open && !state.pending) return
        void controller.refresh()
        const timer = setInterval(() => { void controller.refresh() }, 3000)
        return () => { clearInterval(timer) }
    }, [controller, open, Boolean(state.pending)])
    const pending = state.pending || state.data?.operations.some(row => ['submitting', 'indeterminate'].includes(row.status))
    return <details className="hapi-native-settings" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>{t('nativeSettings')}{pending ? ` · ${t('awaitingConfirmation')}` : ''}</summary>
        {state.data && <SettingsForm data={state.data} disabled={disabled || state.busy || Boolean(pending) || state.data.readOnly} change={change => { void controller.apply(change) }} t={t}/>}
        {!state.data && state.loading && <p role="status">{t('loading')}</p>}
        {state.data?.warnings.map((message, index) => <p key={index}>{message}</p>)}
        {state.pending && <p role="status">{t('settingUnknown')} <code>{state.pending.operationId}</code></p>}
        {state.receipt && <p><strong>{state.receipt.status}</strong>{state.receipt.message && ` · ${state.receipt.message}`}</p>}
        {state.error && <p className="hapi-error" role="alert">{state.error}</p>}
        <button type="button" disabled={state.loading || state.busy} onClick={() => { void controller.refresh() }}>{t('checkNativeResult')}</button>
    </details>
}

function ForkReceipt({ view, busy, inspect, closeIntent, retryWithRisk, open, t }: {
    view: NativeForkView; busy: boolean; inspect: (action: 'read' | 'reconcile') => void; closeIntent: () => void;
    retryWithRisk: () => void; open: (sessionId: string) => void; t: WorkspaceTranslate
}) {
    const [risk, setRisk] = useState(false)
    const unresolved = nativeForkUnresolved(view)
    const unknown = view.submission === 'indeterminate' || view.operation?.status === 'indeterminate'
    return <article className="hapi-fork-receipt" data-fork-operation={view.operationId}>
        <header><strong>{view.operation?.status ?? view.submission}{view.operation?.status === 'created' ? ` · ${view.operation.binding}` : ''}</strong></header>
        <code>{view.operationId}</code>
        {view.message && <p>{view.message}</p>}
        {view.operation?.message && view.operation.message !== view.message && <p>{view.operation.message}</p>}
        <div className="hapi-button-row">
            {view.sessionId && <button type="button" onClick={() => open(view.sessionId!)}>{t('openFork')}</button>}
            {unresolved && <>
                <button type="button" disabled={busy} onClick={() => inspect('read')}>{t('checkNativeResult')}</button>
                <button type="button" disabled={busy} onClick={() => inspect('reconcile')}>{t('reconcileFork')}</button>
                <button type="button" disabled={busy} onClick={closeIntent}>{t('closeForkIntent')}</button>
            </>}
        </div>
        {unknown && <details><summary>{t('forkRecovery')}</summary><p>{t('forkDuplicateHelp')}</p>
            <label className="hapi-risk-checkbox"><input type="checkbox" checked={risk} onChange={event => setRisk(event.currentTarget.checked)}/>{t('forkDuplicateAccept')}</label>
            <button type="button" disabled={busy || !risk} onClick={retryWithRisk}>{t('forkDuplicate')}</button>
        </details>}
    </article>
}

/** Same native operation ID is inspected/reconciled; an uncertain create is never replayed. */
export function NativeForkContent({ ledger, sessionId, boundary, open, t }: {
    ledger: NativeControlLedger; sessionId: string; boundary?: Pick<NativeForkRequest, 'messageLocalId' | 'nativeBoundary' | 'displayMessageId'>;
    open: (sessionId: string) => void; t: WorkspaceTranslate
}) {
    const controller = ledger.fork(sessionId)
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    useEffect(() => {
        void controller.refresh()
        const timer = setInterval(() => { void controller.refresh() }, 3000)
        return () => { clearInterval(timer) }
    }, [controller])
    const create = (duplicateRiskOf?: string): void => {
        void controller.create(duplicateRiskOf ? { duplicateRiskOf } : boundary).then(view => { if (view?.sessionId) open(view.sessionId) })
    }
    const blocked = state.operations.some(nativeForkUnresolved) || Boolean(state.source?.blockingSourceSessionId)
    return <div className="hapi-native-fork">
        <p>{boundary ? t('forkBoundaryHelp') : t('forkLatestHelp')}</p>
        {state.source?.message && <p>{state.source.message}</p>}
        {state.error && <p className="hapi-error" role="alert">{state.error}</p>}
        <div className="hapi-button-row"><button type="button" disabled={!state.source || state.busy || blocked} onClick={() => create()}>{t('fork')}</button>
            <button type="button" disabled={state.loading || state.busy} onClick={() => { void controller.refresh() }}>{t('refresh')}</button></div>
        {state.operations.map(view => <ForkReceipt key={view.operationId} view={view} busy={state.busy}
            inspect={action => { void controller.inspect(view.operationId, action) }} closeIntent={() => { void controller.closeIntent(view.operationId) }}
            retryWithRisk={() => create(view.operationId)} open={open} t={t}/>)}
        {state.closure && <p role="status">{state.closure.closure}{state.closure.message ? ` · ${state.closure.message}` : ''}</p>}
    </div>
}
