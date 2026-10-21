import { createWorkspaceUiPreferences, type WorkspaceUiPreferences } from './ui-preferences.ts'
import { createSourceSummaryCoordinator, type SourceSummaryCoordinator } from './notify-summary-state.ts'
import { WorkspaceShareInbox } from './share-inbox-state.ts'
import { createWorkspaceUpdatePreparations, type WorkspaceUpdatePreparations } from './update-preparation.ts'
import { WorkspaceDraftHandoffs } from './draft-handoff.ts'
import { createSourceScheduleDrafts, type SourceScheduleDrafts } from './schedule-draft.ts'
import { createSourceFileMutations, type SourceFileMutationJournal } from './source-file-mutation-journal.ts'

/** Microphone ownership is shared explicitly; ordinary plugin stores are not. */
export interface WorkspaceVoice {
    claim(id: string, stop: () => void | Promise<void>): boolean
    owns(id: string): boolean
    release(id: string): void
    /** An explicit user action may stop the current owner in another pane. */
    stop(): Promise<void>
    getSnapshot(): string | null
    subscribe(listener: () => void): () => void
}

export interface WorkspaceUiScope {
    readonly preferences: WorkspaceUiPreferences
    readonly voice: WorkspaceVoice
    readonly sourceSummaries: SourceSummaryCoordinator
    readonly shareInbox: WorkspaceShareInbox
    readonly handoffs: WorkspaceDraftHandoffs
    readonly sourceScheduleDrafts: SourceScheduleDrafts
    readonly sourceFileMutations: SourceFileMutationJournal
    readonly updates: WorkspaceUpdatePreparations
    /** Read only the original HAPI scratchlist key for this source session. */
    readLegacyScratchlist(sourceSessionId: string): string | null
}

export interface WorkspaceUiLease extends WorkspaceUiScope {
    /** Used when an individual plugin graph restarts, without stopping other panes. */
    stopOwnedVoice(): Promise<void>
    dispose(): Promise<void>
}

export function createWorkspaceVoiceCoordinator() {
    type Owner = { scope: symbol; id: string; callback: () => void | Promise<void>; stopping?: Promise<void> }
    let owner: Owner | undefined
    let disposed = false
    const listeners = new Set<() => void>()
    const publish = (): void => { for (const listener of [...listeners]) listener() }
    const stop = (): Promise<void> => {
        const current = owner
        if (!current) return Promise.resolve()
        if (current.stopping) return current.stopping
        // Keep the claim until the actual audio owner has stopped. A failed
        // cleanup remains visible and cannot admit a second microphone owner.
        const pending = Promise.resolve().then(current.callback).then(() => {
            if (owner === current) { owner = undefined; publish() }
        }, error => { delete current.stopping; throw error })
        current.stopping = pending
        return pending
    }
    return {
        createScope() {
            const scope = Symbol('workspace-voice-scope')
            let closed = false
            const scopeListeners = new Set<() => void>()
            const voice: WorkspaceVoice = {
                claim(id, callback) {
                    if (closed || disposed || !id || id.length > 1024 || typeof callback !== 'function') return false
                    if (owner) {
                        if (owner.scope !== scope || owner.id !== id || owner.stopping) return false
                        owner.callback = callback
                        return true
                    }
                    owner = { scope, id, callback }; publish(); return true
                },
                owns: id => owner?.scope === scope && owner.id === id,
                release(id) {
                    if (owner?.scope !== scope || owner.id !== id || owner.stopping) return
                    owner = undefined; publish()
                },
                stop,
                getSnapshot: () => owner?.id ?? null,
                subscribe(listener) {
                    if (closed) return () => {}
                    const subscription = (): void => listener()
                    listeners.add(subscription); scopeListeners.add(subscription)
                    return () => { listeners.delete(subscription); scopeListeners.delete(subscription) }
                },
            }
            const stopOwnedVoice = (): Promise<void> => owner?.scope === scope ? stop() : Promise.resolve()
            return { voice, stopOwnedVoice, async dispose(): Promise<void> {
                closed = true
                for (const listener of scopeListeners) listeners.delete(listener)
                scopeListeners.clear()
                await stopOwnedVoice()
            } }
        },
        async dispose(): Promise<void> { disposed = true; try { await stop() } finally { listeners.clear() } },
    }
}

export function createWorkspaceUiBridge(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    events?: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    windowStorage?: Pick<Storage, 'getItem' | 'setItem'>) {
    const preferences = createWorkspaceUiPreferences(storage, events)
    const coordinator = createWorkspaceVoiceCoordinator()
    const sourceSummaries = createSourceSummaryCoordinator()
    // A window's hand-off owner must never be shared through localStorage.
    const shareInbox = new WorkspaceShareInbox(undefined, windowStorage)
    const updates = createWorkspaceUpdatePreparations()
    const handoffs = new WorkspaceDraftHandoffs(shareInbox.owner, undefined, () => updates.checkpoint())
    const sourceScheduleDrafts = createSourceScheduleDrafts(storage, events)
    const sourceFileMutations = createSourceFileMutations({ ...(events ? { events } : {}) })
    updates.register('Conversation draft transfer', () => handoffs.checkpoint())
    const readLegacyScratchlist = (sourceSessionId: string): string | null => {
        if (!sourceSessionId || sourceSessionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(sourceSessionId)) throw new Error('Invalid original source session identity')
        if (!storage) throw new Error('Original HAPI browser storage is unavailable')
        return storage.getItem(`hapi.scratchlist.v1.${sourceSessionId}`)
    }
    const createScope = (): WorkspaceUiLease => ({ preferences, sourceSummaries, shareInbox, handoffs, sourceScheduleDrafts, sourceFileMutations, updates, readLegacyScratchlist, ...coordinator.createScope() })
    const root = createScope()
    return { root, createScope, async dispose(): Promise<void> {
        try { await coordinator.dispose() } finally { updates.dispose(); handoffs.dispose(); shareInbox.dispose(); sourceScheduleDrafts.dispose(); sourceFileMutations.dispose(); sourceSummaries.dispose(); preferences.dispose() }
    } }
}

declare module '@deepseek-ai/cordis' {
    interface Context { hapiWorkspaceUi: WorkspaceUiScope }
}
