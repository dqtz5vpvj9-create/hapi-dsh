import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerBlock, ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceTranslate } from './locales.ts'
import type {} from '../hapi-agent/projection-types.ts'
import type {} from './remote-sessions.ts'

/** Use the official composer admission face, preserving other plugins' blocks. */
export function installNativeComposerAdmission(
    sessions: Pick<ISessions, 'list'>,
    blocks: ComposerBlocks,
    locale: { t: WorkspaceTranslate; subscribe(listener: () => void): () => void },
): () => void {
    type Entry = { block: ComposerBlock; store: ReturnType<ComposerBlocks['storeFor']>; unsubscribe: () => void }
    const entries = new Map<SessionId, Entry>()
    let disposed = false
    const remove = (id: SessionId, entry: Entry): void => {
        entries.delete(id)
        entry.unsubscribe()
        if (entry.store.getSnapshot() === entry.block && blocks.storeFor(id) === entry.store) blocks.set(id, undefined)
    }
    const sync = (): void => {
        if (disposed) return
        const needed = new Set<SessionId>()
        for (const row of Object.values(sessions.list.getSnapshot().byId)) {
            // The legacy HAPI path accepts durable delivery. Direct HHPI input
            // follows its source capability, including metadata-only recovery.
            const source = row.projectionValues?.hhpiSource
            const observed = row.projectionValues?.hapiObserved
            const engineOwned = Boolean(observed && (observed.controlledByUser || observed.readOnlyReason === 'engine-owned'))
            const unavailable = source?.status === 'offline'
            const readOnly = source && !source.capabilities.send
            if (!unavailable && !readOnly && !engineOwned) continue
            const id = row.id
            needed.add(id)
            const reason = locale.t(unavailable ? 'sourceDisconnected' : readOnly ? 'sourceReadOnly' : 'sourceLocallyControlled')
            const store = blocks.storeFor(id)
            let entry = entries.get(id)
            if (entry && entry.store !== store) { remove(id, entry); entry = undefined }
            if (!entry) {
                const next: Entry = { block: { reason }, store, unsubscribe: () => {} }
                const apply = (): void => {
                    // A model/provider/third-party reason still prevents
                    // sending. Do not replace it, and do not erase it later.
                    if (!disposed && entries.get(id) === next && store.getSnapshot() === undefined) blocks.set(id, next.block)
                }
                entries.set(id, next)
                next.unsubscribe = store.subscribe(apply)
                apply()
            } else if (entry.block.reason !== reason) {
                const owned = store.getSnapshot() === entry.block
                entry.block = { reason }
                if (owned) blocks.set(id, entry.block)
            }
        }
        for (const [id, entry] of entries) if (!needed.has(id)) remove(id, entry)
    }
    const unsubscribers = [sessions.list.subscribe(sync), locale.subscribe(sync)]
    sync()
    return () => {
        if (disposed) return
        disposed = true
        for (const unsubscribe of unsubscribers) unsubscribe()
        for (const [id, entry] of entries) remove(id, entry)
    }
}
