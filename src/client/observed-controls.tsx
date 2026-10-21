import { randomId } from './random-id.ts'
/** Source engines keep their own settings values and operation finality. */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import type { ObservedSettingChange, ObservedSettingReceipt, ObservedSettings } from '../hapi-agent/control-types.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { errorMessage } from './controller.ts'

type Api = Pick<HapiRemoteApi, 'observedSettings' | 'observedApplySetting' | 'observedSetting'>
type Snapshot = { data: ObservedSettings | null; loading: boolean; busy: boolean; pending: { operationId: string; change: ObservedSettingChange } | null; receipt: ObservedSettingReceipt | null; error: string | null }
const final = (receipt: ObservedSettingReceipt): boolean => receipt.status === 'applied' || receipt.status === 'rejected'

export class ObservedSettingsController {
    private snapshot: Snapshot = { data: null, loading: false, busy: false, pending: null, receipt: null, error: null }
    private readonly listeners = new Set<() => void>()
    private reading: Promise<void> | undefined
    constructor(private readonly api: Api, readonly sessionId: string, private readonly nextId = () => randomId()) {}
    getSnapshot = (): Snapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(value: Partial<Snapshot>): void { this.snapshot = { ...this.snapshot, ...value }; for (const listener of this.listeners) listener() }
    refresh = (): Promise<void> => {
        if (this.reading) return this.reading
        this.publish({ loading: true })
        this.reading = (async () => {
            try {
                const pending = this.snapshot.pending
                if (pending) {
                    const receipt = remoteValue(await this.api.observedSetting({ sessionId: this.sessionId, operationId: pending.operationId }))
                    if (this.snapshot.pending?.operationId === receipt.operationId) this.publish({ receipt, ...(final(receipt) ? { pending: null } : {}) })
                }
                const data = remoteValue(await this.api.observedSettings({ sessionId: this.sessionId }))
                const receipt = this.snapshot.pending ? data.receipts.find(row => row.operationId === this.snapshot.pending!.operationId) : data.receipts.findLast(row => !final(row))
                this.publish({ data, error: null, ...(receipt ? { receipt, pending: final(receipt) ? null : { operationId: receipt.operationId, change: receipt.change } } : {}) })
            } catch (error) { this.publish({ error: errorMessage(error) }) }
            finally { this.reading = undefined; this.publish({ loading: false }) }
        })()
        return this.reading
    }
    async apply(change: ObservedSettingChange): Promise<boolean> {
        const { data } = this.snapshot
        if (!data || this.snapshot.busy || this.snapshot.pending || !data.editable[change.kind] || (data.readOnly && change.kind !== 'control')) return false
        const pending = { operationId: this.nextId(), change }
        this.publish({ busy: true, pending, error: null, receipt: null })
        try {
            const receipt = remoteValue(await this.api.observedApplySetting({ sessionId: this.sessionId, ...pending }))
            this.publish({ receipt, pending: final(receipt) ? null : pending, error: receipt.status === 'rejected' ? receipt.message : null })
        } catch (error) {
            // The immutable operation id remains. A missing transport reply is
            // observed through reads and is never submitted a second time here.
            this.publish({ error: errorMessage(error) })
        } finally { this.publish({ busy: false }); await this.reading; await this.refresh() }
        return this.snapshot.receipt?.status === 'applied'
    }
}

export class ObservedControlLedger {
    private readonly entries = new Map<string, ObservedSettingsController>()
    constructor(private readonly api: Api) {}
    settings(id: string): ObservedSettingsController {
        let value = this.entries.get(id)
        if (!value) { value = new ObservedSettingsController(this.api, id); this.entries.set(id, value) }
        return value
    }
    clear(): void { this.entries.clear() }
}

export function ObservedSettingsControls({ ledger, sessionId, t }: { ledger: ObservedControlLedger; sessionId: string; t: WorkspaceTranslate }) {
    const controller = useMemo(() => ledger.settings(sessionId), [ledger, sessionId])
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    useEffect(() => { void controller.refresh() }, [controller])
    useEffect(() => {
        if (!state.pending) return
        const timer = setInterval(() => { void controller.refresh() }, 2000)
        return () => { clearInterval(timer) }
    }, [controller, state.pending?.operationId])
    const { data } = state
    const blocked = state.busy || Boolean(state.pending) || Boolean(data?.readOnly)
    const select = (label: string, kind: Exclude<ObservedSettingChange['kind'], 'control'>, value: unknown, options: Array<{ value: unknown; label: string }>) => {
        const encoded = JSON.stringify(value)
        const choices = options.some(option => JSON.stringify(option.value) === encoded) ? options : [{ value, label: value == null ? t('sourceUnreportedValue') : typeof value === 'string' ? value : encoded }, ...options]
        return <label>{label}<select aria-label={label} value={encoded} disabled={blocked || !data?.editable[kind]} onChange={event => {
            const chosen = choices.find(option => JSON.stringify(option.value) === event.currentTarget.value)
            if (chosen) void controller.apply({ kind, value: chosen.value } as ObservedSettingChange)
        }}>{choices.map((option, index) => <option key={`${JSON.stringify(option.value)}:${index}`} value={JSON.stringify(option.value)}>{option.label}</option>)}</select></label>
    }
    return <details className="hapi-native-settings"><summary>{t('sourceSettings')}{data ? ` · ${data.flavor}` : ''}</summary>
        {data && <>
            {data.editable.control && data.values.control === 'local' && <button type="button" disabled={state.busy || Boolean(state.pending)} onClick={() => { void controller.apply({ kind: 'control', value: 'remote' }) }}>{t('takeRemoteControl')}</button>}
            {select(t('model'), 'model', data.values.model, data.models.map(row => ({ value: row.value, label: row.provider ? `${row.provider} · ${row.label}` : row.label })))}
            {data.editable.effort && select(t('reasoning'), 'effort', data.values.effort, data.efforts)}
            {data.editable.permission && select(t('permission'), 'permission', data.values.permission, data.permissions.map(value => ({ value, label: value })))}
            {data.editable.collaboration && select(t('sourceCollaboration'), 'collaboration', data.values.collaboration, ['default', 'plan'].map(value => ({ value, label: value })))}
            {data.editable.serviceTier && select(t('sourceServiceTier'), 'serviceTier', data.values.serviceTier, data.serviceTiers.map(value => ({ value, label: value })))}
            {data.editable.copilotMode && select(t('sourceCopilotMode'), 'copilotMode', data.values.copilotMode, ['interactive', 'plan', 'autopilot'].map(value => ({ value, label: value })))}
            {data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        </>}
        {state.receipt && <p role="status" data-source-setting-state={state.receipt.status}>{t(state.receipt.status === 'applied' ? 'sourceApplied' : state.receipt.status === 'indeterminate' ? 'sourceUnknown' : state.receipt.status === 'rejected' ? 'sourceRejected' : 'sourceSubmitted')}{state.receipt.message ? ` · ${state.receipt.message}` : ''}</p>}
        <button type="button" disabled={state.loading} onClick={() => { void controller.refresh() }}>{t('sourceSettingCheck')}</button>
        {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
    </details>
}
