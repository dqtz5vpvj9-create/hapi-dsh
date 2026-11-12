/** One authenticated application generation shared by every workspace Pane. */
import { appScopeKey, type AppAccountScope } from '../workspace/app-service-types.ts'

export interface ApplicationIdentity {
    readonly scope: string
    readonly account: AppAccountScope
    readonly deviceId: string
    readonly signal: AbortSignal
}

export class WorkspaceApplicationIdentity {
    private value: ApplicationIdentity | undefined
    private lifetime: AbortController | undefined
    private readonly listeners = new Set<() => void>()
    readonly getSnapshot = (): ApplicationIdentity | undefined => this.value
    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }
    set(account: AppAccountScope, deviceId: string): void {
        const scope = appScopeKey(account)
        if (this.value?.scope === scope && this.value.deviceId === deviceId) return
        this.lifetime?.abort()
        this.lifetime = new AbortController()
        this.value = { scope, account: { ...account }, deviceId, signal: this.lifetime.signal }
        for (const listener of this.listeners) listener()
    }
    clear(): void {
        if (!this.value) return
        this.lifetime?.abort(); this.lifetime = undefined; this.value = undefined
        for (const listener of this.listeners) listener()
    }
    dispose(): void { this.clear(); this.listeners.clear() }
}
