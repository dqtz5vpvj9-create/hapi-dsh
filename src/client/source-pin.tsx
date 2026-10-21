import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { errorMessage, type WorkspaceCatalogRow, type WorkspaceController } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { observedProjection } from '../workspace/presentation.ts'
import { sourceIdentity } from '../workspace/legacy.ts'

type Api = Pick<HapiRemoteApi, 'nativeSourceOperation' | 'nativeOperation' | 'sourceOperation' | 'sourceOperationRead'>
type PinIntent = { operationId: string; sessionId: string; owner: 'native' | 'observed'; mode: 'none' | 'project' | 'global' }
type PinReceipt = { operationId: string; status: string; message: string | null }
type Snapshot = { pending: PinIntent | null; receipt: PinReceipt | null; busy: boolean; error: string | null }
type Store = Pick<Storage, 'getItem' | 'setItem'>

/** A quick pin changes the original source. No official display bookmark is mutated. */
export class SourcePinController {
    private state: Snapshot = { pending: null, receipt: null, busy: false, error: null }
    private readonly listeners = new Set<() => void>()
    constructor(private readonly api: Api, private readonly storage?: Store, private readonly key = 'source-pin', private readonly nextId: () => string = () => crypto.randomUUID()) {
        try {
            const saved: unknown = JSON.parse(storage?.getItem(key) ?? 'null')
            if (saved && typeof saved === 'object') {
                const value = saved as Record<string, unknown>
                if (typeof value.operationId === 'string' && /^[0-9a-f-]{36}$/i.test(value.operationId) && typeof value.sessionId === 'string'
                    && ['native', 'observed'].includes(String(value.owner)) && ['none', 'project', 'global'].includes(String(value.mode))) this.state.pending = value as PinIntent
            }
        } catch { /* Source receipt history remains authoritative. */ }
    }
    getSnapshot = (): Snapshot => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<Snapshot>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
    private persist(): void { try { this.storage?.setItem(this.key, JSON.stringify(this.state.pending)) } catch { /* The server journals the operation before mutation. */ } }
    private accept(receipt: PinReceipt): boolean {
        if (receipt.operationId !== this.state.pending?.operationId) return false
        const confirmed = receipt.status === 'confirmed'
        this.publish({ receipt, pending: confirmed || receipt.status === 'rejected' ? null : this.state.pending,
            error: receipt.status === 'rejected' ? receipt.message : null })
        this.persist(); return confirmed
    }
    async set(sessionId: string, owner: PinIntent['owner'], mode: PinIntent['mode']): Promise<boolean> {
        if (this.state.pending || this.state.busy) return false
        const intent: PinIntent = { operationId: this.nextId(), sessionId, owner, mode }
        this.publish({ pending: intent, busy: true, receipt: null, error: null }); this.persist()
        const request = { operationId: intent.operationId, sessionId, action: { kind: 'pin' as const, mode } }
        try { return this.accept(remoteValue<PinReceipt>(await (owner === 'native' ? this.api.nativeSourceOperation(request) : this.api.sourceOperation(request)))) }
        catch (error) { this.publish({ error: errorMessage(error) }); return false }
        finally { this.publish({ busy: false }) }
    }
    async inspect(): Promise<boolean> {
        const intent = this.state.pending
        if (!intent || this.state.busy) return false
        this.publish({ busy: true, error: null })
        try {
            return this.accept(remoteValue<PinReceipt>(await (intent.owner === 'native'
                ? this.api.nativeOperation({ operationId: intent.operationId })
                : this.api.sourceOperationRead({ operationId: intent.operationId, action: 'read' }))))
        } catch (error) { this.publish({ error: errorMessage(error) }); return false }
        finally { this.publish({ busy: false }) }
    }
}

const ledgers = new WeakMap<Api, Map<string, SourcePinController>>()
function pinController(api: Api, workspace: WorkspaceController, row: WorkspaceCatalogRow): SourcePinController {
    let ledger = ledgers.get(api)
    if (!ledger) { ledger = new Map(); ledgers.set(api, ledger) }
    const source = sourceIdentity(row)!
    const key = `${workspace.options.storageKey}:source-pin:${JSON.stringify([source.hubId, source.sessionId])}`
    let controller = ledger.get(key)
    if (!controller) { controller = new SourcePinController(api, workspace.options.storage, key); ledger.set(key, controller) }
    return controller
}

export function SourcePinButton({ api, workspace, row, t, mode = 'project' }: { api: HapiRemoteApi; workspace: WorkspaceController; row: WorkspaceCatalogRow; t: WorkspaceTranslate; mode?: 'project' | 'global' }) {
    const controller = useMemo(() => pinController(api, workspace, row), [api, workspace, row.id])
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const pinned = row.sourcePinMode === mode
    const refresh = async (): Promise<void> => {
        try { workspace.setSourceCatalog(remoteValue(await api.catalog()).sessions) }
        catch (error) { workspace.report(error) }
    }
    useEffect(() => {
        if (!state.pending) return
        const inspect = (): void => { void controller.inspect().then(confirmed => { if (confirmed) void refresh() }) }
        inspect(); const timer = setInterval(inspect, 3000)
        return () => { clearInterval(timer) }
    }, [controller, state.pending?.operationId])
    const perform = async (): Promise<void> => {
        const confirmed = state.pending ? await controller.inspect() : await controller.set(row.sourceSessionId, observedProjection(row) ? 'observed' : 'native', pinned ? 'none' : mode)
        if (confirmed) await refresh()
        else if (controller.getSnapshot().error) workspace.report(controller.getSnapshot().error)
    }
    return <button type="button" role="menuitem" disabled={state.busy} title={state.error ?? state.receipt?.message ?? undefined} data-source-pin-state={state.receipt?.status ?? (state.pending ? 'pending' : undefined)} onClick={() => { void perform() }}>
        {state.pending ? t('sourceSettingCheck') : t(mode === 'global' ? pinned ? 'unpinGlobal' : 'pinGlobal' : pinned ? 'unpinProject' : 'pinProject')}{state.pending && ' · …'}
    </button>
}
