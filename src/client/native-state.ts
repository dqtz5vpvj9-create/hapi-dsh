/** An action receipt is not an approval resolution or execution completion. */
import { errorMessage } from './controller.ts'
export interface NativeActionSnapshot { busy: boolean; submitted: boolean; error: string | null; result: unknown }

export class NativeAction {
    private snapshot: NativeActionSnapshot = { busy: false, submitted: false, error: null, result: undefined }
    private readonly listeners = new Set<() => void>()
    getSnapshot = (): NativeActionSnapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<NativeActionSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch }
        for (const listener of this.listeners) listener()
    }
    async run(operation: () => Promise<unknown>, waitForNativeResolution: boolean): Promise<boolean> {
        if (this.snapshot.busy || this.snapshot.submitted) return false
        this.publish({ busy: true, error: null, result: undefined })
        try {
            const result = await operation()
            this.publish({ busy: false, submitted: waitForNativeResolution, result })
            return true
        } catch (error) {
            this.publish({ busy: false, error: errorMessage(error) })
            return false
        }
    }
}

/** Request-id ownership survives pane switches and temporary component unmounts. */
export class NativeActionLedger {
    private readonly entries = new Map<string, NativeAction>()
    action(sessionId: string, kind: 'approval' | 'delivery', id: string): NativeAction {
        const key = JSON.stringify([sessionId, kind, id])
        let action = this.entries.get(key)
        if (!action) { action = new NativeAction(); this.entries.set(key, action) }
        return action
    }
    resolved(sessionId: string, requestIds: readonly string[]): void {
        for (const id of requestIds) this.entries.delete(JSON.stringify([sessionId, 'approval', id]))
    }
    clear(): void { this.entries.clear() }
}
