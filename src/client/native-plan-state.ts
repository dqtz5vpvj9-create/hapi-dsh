/** Native plan intent ownership. No text heuristics, optimistic execution, or automatic replay. */
import { remoteValue, type HapiRemoteApi, type NativePlanReceipt, type NativePlanState } from '../client-api.ts'
import { errorMessage } from './controller.ts'

export type NativePlanApi = Pick<HapiRemoteApi, 'nativePlan' | 'nativeImplementPlan'>
export interface NativePlanSnapshot {
    data: NativePlanState | null
    operations: readonly NativePlanReceipt[]
    loading: boolean
    busy: boolean
    error: string | null
}

export class NativePlanController {
    private snapshot: NativePlanSnapshot = { data: null, operations: [], loading: false, busy: false, error: null }
    private readonly listeners = new Set<() => void>()
    private readonly operations = new Map<string, NativePlanReceipt>()
    private read: Promise<void> | undefined
    private epoch = 0
    constructor(private readonly api: NativePlanApi, readonly sessionId: string, private readonly nextId: () => string) {}
    getSnapshot = (): NativePlanSnapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<NativePlanSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch, operations: [...this.operations.values()] }
        for (const listener of this.listeners) listener()
    }
    refresh = (): Promise<void> => {
        if (this.read) return this.read
        const epoch = this.epoch
        this.publish({ loading: true })
        this.read = (async () => {
            try {
                const data = remoteValue(await this.api.nativePlan({ sessionId: this.sessionId }))
                if (epoch !== this.epoch) return
                for (const operation of data.operations) this.operations.set(operation.operationId, operation)
                this.publish({ data, error: null })
            } catch (reason) { if (epoch === this.epoch) this.publish({ error: errorMessage(reason) }) }
            finally { this.read = undefined; this.publish({ loading: false }) }
        })()
        return this.read
    }
    async implement(planId: string): Promise<NativePlanReceipt | null> {
        const data = this.snapshot.data
        if (!data || data.readOnly || data.planId !== planId || this.snapshot.busy
            || this.snapshot.operations.some(row => row.planId === planId && row.status !== 'rejected')) return null
        const operationId = this.nextId()
        const now = Date.now()
        // This is a local submitting intent, not a native acknowledgement.
        const initial: NativePlanReceipt = { operationId, planId, localId: `${planId}:implement`, status: 'submitting',
            createdAt: now, updatedAt: now, message: null, sourceCode: null }
        this.operations.set(operationId, initial)
        ++this.epoch; this.publish({ busy: true, error: null })
        try {
            const result = remoteValue(await this.api.nativeImplementPlan({ sessionId: this.sessionId, planId, operationId }))
            this.operations.set(operationId, result); this.publish({})
            return result
        } catch (reason) {
            const details: unknown = reason && typeof reason === 'object' ? Reflect.get(reason, 'details') : undefined
            const code: unknown = reason && typeof reason === 'object' ? Reflect.get(reason, 'code') : undefined
            const rejected = code === 'gateway/bad-request' || code === 'hapi/request' && Boolean(details && typeof details === 'object' && Reflect.get(details, 'outcome') === 'rejected')
            this.operations.set(operationId, { ...initial, status: rejected ? 'rejected' : 'indeterminate', updatedAt: Date.now(), message: errorMessage(reason) })
            this.publish({ error: errorMessage(reason) })
            return null
        } finally {
            await this.read
            await this.refresh()
            this.publish({ busy: false })
        }
    }
}
