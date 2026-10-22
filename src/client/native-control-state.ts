import { randomId } from './random-id.ts'
/** Durable UI intent ownership. Native receipts, not optimistic values, decide completion. */
import { remoteValue, type HapiRemoteApi, type NativeForkCloseResult, type NativeForkRequest, type NativeForkState, type NativeForkView, type NativeSettingChange, type NativeSettingReceipt, type NativeSettings } from '../client-api.ts'
import { errorMessage } from './controller.ts'
import { NativePlanController, type NativePlanApi } from './native-plan-state.ts'

type ControlApi = Pick<HapiRemoteApi, 'nativeSettings' | 'nativeApplySetting' | 'nativeForkState' | 'nativeFork' | 'nativeForkOperation' | 'nativeForkClose'> & NativePlanApi
type Listener = () => void
const settledSetting = (receipt: NativeSettingReceipt): boolean => ['confirmed', 'observed', 'rejected'].includes(receipt.status)
function rejected(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const code: unknown = Reflect.get(error, 'code')
    const details: unknown = Reflect.get(error, 'details')
    return code === 'gateway/bad-request' || code === 'hapi/request' && Boolean(details && typeof details === 'object' && Reflect.get(details, 'outcome') === 'rejected')
}

export interface NativeSettingsSnapshot {
    data: NativeSettings | null
    loading: boolean
    busy: boolean
    pending: { operationId: string; change: NativeSettingChange } | null
    receipt: NativeSettingReceipt | null
    error: string | null
}

export class NativeSettingsController {
    private snapshot: NativeSettingsSnapshot = { data: null, loading: false, busy: false, pending: null, receipt: null, error: null }
    private readonly listeners = new Set<Listener>()
    private read: Promise<void> | undefined
    private epoch = 0
    constructor(private readonly api: ControlApi, readonly sessionId: string, private readonly nextId: () => string) {}
    getSnapshot = (): NativeSettingsSnapshot => this.snapshot
    subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<NativeSettingsSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener()
    }
    refresh = (): Promise<void> => {
        if (this.read) return this.read
        const epoch = this.epoch
        this.publish({ loading: true, error: null })
        this.read = (async () => {
            try {
                const data = remoteValue(await this.api.nativeSettings({ sessionId: this.sessionId }))
                if (epoch !== this.epoch) return
                const receipt = this.snapshot.pending ? data.operations.find(row => row.operationId === this.snapshot.pending!.operationId)
                    : data.operations.findLast(row => !settledSetting(row))
                this.publish({ data, error: null, ...(receipt ? { receipt, pending: settledSetting(receipt) ? null : { operationId: receipt.operationId, change: receipt.change } } : {}) })
            } catch (error) { if (epoch === this.epoch) this.publish({ error: errorMessage(error) }) }
            finally { this.read = undefined; this.publish({ loading: false }) }
        })()
        return this.read
    }
    async apply(change: NativeSettingChange): Promise<boolean> {
        if (this.snapshot.busy || this.snapshot.pending || !this.snapshot.data || this.snapshot.data.readOnly) return false
        const pending = { operationId: this.nextId(), change }
        let operationError: string | null = null
        ++this.epoch
        this.publish({ busy: true, pending, receipt: null, error: null })
        try {
            const receipt = remoteValue(await this.api.nativeApplySetting({ sessionId: this.sessionId, ...pending }))
            this.publish({ receipt, pending: settledSetting(receipt) ? null : pending, error: receipt.status === 'rejected' ? receipt.message : null })
        } catch (error) {
            // A transport error cannot prove that HAPI did not receive the write.
            // Keep this operation identity; later reads can confirm its receipt.
            operationError = errorMessage(error)
            this.publish({ error: operationError, ...(rejected(error) ? { pending: null } : {}) })
        } finally {
            // Let any pre-write read settle, then obtain source-owned values.
            await this.read
            await this.refresh()
            this.publish({ busy: false, ...(operationError && (this.snapshot.pending || !this.snapshot.receipt) ? { error: operationError } : {}) })
        }
        return this.snapshot.receipt?.status === 'confirmed' || this.snapshot.receipt?.status === 'observed'
    }
}

export function nativeForkUnresolved(view: NativeForkView): boolean {
    if (view.sessionId || view.submission === 'rejected' || view.operation?.status === 'rejected') return false
    return true
}

export interface NativeForkSnapshot {
    source: NativeForkState | null
    operations: readonly NativeForkView[]
    loading: boolean
    busy: boolean
    error: string | null
    closure: NativeForkCloseResult | null
}

export class NativeForkController {
    private snapshot: NativeForkSnapshot = { source: null, operations: [], loading: false, busy: false, error: null, closure: null }
    private readonly listeners = new Set<Listener>()
    private readonly operations = new Map<string, NativeForkView>()
    private read: Promise<void> | undefined
    private epoch = 0
    constructor(private readonly api: ControlApi, readonly sessionId: string, private readonly nextId: () => string) {}
    getSnapshot = (): NativeForkSnapshot => this.snapshot
    subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<NativeForkSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch, operations: [...this.operations.values()] }; for (const listener of this.listeners) listener()
    }
    private acceptSource(source: NativeForkState): void {
        for (const view of source.operations) this.operations.set(view.operationId, view)
        this.publish({ source })
    }
    refresh = (): Promise<void> => {
        if (this.read) return this.read
        const epoch = this.epoch
        this.publish({ loading: true })
        this.read = (async () => {
            try {
                const source = remoteValue(await this.api.nativeForkState({ sessionId: this.sessionId }))
                if (epoch !== this.epoch) return
                this.acceptSource(source); this.publish({ error: null })
            } catch (error) { if (epoch === this.epoch) this.publish({ error: errorMessage(error) }) }
            finally { this.read = undefined; this.publish({ loading: false }) }
        })()
        return this.read
    }
    async create(boundary: Pick<NativeForkRequest, 'messageLocalId' | 'nativeBoundary' | 'displayMessageId' | 'duplicateRiskOf'> = {}): Promise<NativeForkView | null> {
        const source = this.snapshot.source
        if (!source || this.snapshot.busy) return null
        const unresolved = this.snapshot.operations.filter(nativeForkUnresolved)
        if (!boundary.duplicateRiskOf && (unresolved.length || source.blockingSourceSessionId)) return null
        if (boundary.duplicateRiskOf && !unresolved.some(view => view.operationId === boundary.duplicateRiskOf)) return null
        const operationId = this.nextId()
        const initial: NativeForkView = { operationId, submission: 'submitting', operation: null, sessionId: null, message: null }
        this.operations.set(operationId, initial)
        ++this.epoch
        this.publish({ busy: true, error: null, closure: null })
        try {
            const view = remoteValue(await this.api.nativeFork({ sessionId: this.sessionId, operationId, expectedForkRevision: source.revision, ...boundary }))
            this.operations.set(operationId, view); this.publish({})
            return view
        } catch (error) {
            this.operations.set(operationId, { ...initial, submission: rejected(error) ? 'rejected' : 'indeterminate', message: errorMessage(error) })
            this.publish({ error: errorMessage(error) }); return null
        } finally { await this.read; await this.refresh(); this.publish({ busy: false }) }
    }
    async inspect(operationId: string, action: 'read' | 'reconcile'): Promise<NativeForkView | null> {
        if (this.snapshot.busy) return null
        ++this.epoch; this.publish({ busy: true, error: null })
        try {
            const view = remoteValue(await this.api.nativeForkOperation({ sessionId: this.sessionId, operationId, action }))
            this.operations.set(operationId, view); this.publish({}); return view
        } catch (error) { this.publish({ error: errorMessage(error) }); return null }
        finally { await this.read; await this.refresh(); this.publish({ busy: false }) }
    }
    async closeIntent(operationId: string): Promise<void> {
        const source = this.snapshot.source
        if (!source || this.snapshot.busy) return
        ++this.epoch; this.publish({ busy: true, error: null })
        try {
            const closure = remoteValue(await this.api.nativeForkClose({ sessionId: this.sessionId, operationId, expectedForkRevision: source.revision }))
            this.operations.set(operationId, closure.view); this.acceptSource(closure.source)
            this.publish({ closure })
        } catch (error) { this.publish({ error: errorMessage(error) }) }
        finally { this.publish({ busy: false }) }
    }
}

/** Lives beside pane references, so closing a dialog never erases an unknown write. */
export class NativeControlLedger {
    private readonly settingEntries = new Map<string, NativeSettingsController>()
    private readonly forkEntries = new Map<string, NativeForkController>()
    private readonly planEntries = new Map<string, NativePlanController>()
    constructor(private readonly api: ControlApi, private readonly nextId: () => string = () => randomId()) {}
    settings(sessionId: string): NativeSettingsController {
        let entry = this.settingEntries.get(sessionId)
        if (!entry) { entry = new NativeSettingsController(this.api, sessionId, this.nextId); this.settingEntries.set(sessionId, entry) }
        return entry
    }
    fork(sessionId: string): NativeForkController {
        let entry = this.forkEntries.get(sessionId)
        if (!entry) { entry = new NativeForkController(this.api, sessionId, this.nextId); this.forkEntries.set(sessionId, entry) }
        return entry
    }
    plan(sessionId: string): NativePlanController {
        let entry = this.planEntries.get(sessionId)
        if (!entry) { entry = new NativePlanController(this.api, sessionId, this.nextId); this.planEntries.set(sessionId, entry) }
        return entry
    }
    clear(): void { this.settingEntries.clear(); this.forkEntries.clear(); this.planEntries.clear() }
}
