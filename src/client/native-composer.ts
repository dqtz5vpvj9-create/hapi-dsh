import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerBlock, ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HapiProjection } from '../codex/projection-types.ts'
import type { WorkspaceTranslate } from './locales.ts'

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
            const projection: HapiProjection | undefined = row.projectionValues?.hapi
            if (!projection || projection.engine !== 'codex' || (!projection.readOnly && projection.nativeConnection === 'attached')) continue
            const id = row.id
            needed.add(id)
            const reason = locale.t(projection.nativeConnection === 'disconnected' ? 'nativeReconnecting'
                : projection.nativeConnection === 'history' ? 'nativeResumeToSend' : 'nativeReadOnly')
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
