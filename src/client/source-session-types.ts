/** Optional reading capabilities shared by native HHPI and official DSH occurrences. No transport or facade owner. */
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

export interface SourceWindowViewport {
    firstSeq: number
    lastSeq: number
    followingTail: boolean
    overscan?: { firstSeq: number; lastSeq: number }
}

export interface SourceWindowProgress {
    olderRevision?: number | undefined
    before: { at: number; seq: number } | null
    pagingError?: true | undefined
    historyId?: string | undefined
    historyVersion?: number | undefined
}

export interface SourcePreparationReference extends SessionReference {
    readonly preparationReady: Promise<SessionBinding>
}

export interface SourceWindowReader {
    available(): boolean
    read(): SourceWindowViewport | undefined
    preparePrepend?(): { commit(): void; cancel(): void } | undefined
}

export interface SourceWindowPreparer {
    available(): boolean
    prepare(reference: SessionReference, signal: AbortSignal): Promise<boolean>
}

export interface SourceViewportSession {
    readonly sourceWindow: {
        getSnapshot(): { readonly hasMoreAfter: boolean } & Partial<SourceWindowProgress>
        subscribe(listener: () => void): () => void
    }
    prefetchOlderPage?(limit?: number): Promise<void>
    cancelOlderPage?(reason?: unknown): void
    loadViewportPage?(limit?: number): Promise<void>
    loadSourceMessage?(messageId: string, signal?: AbortSignal): Promise<SessionSeq | undefined>
    registerWindowPreparer?(preparer: SourceWindowPreparer): () => void
    registerWindowReader?(reader: SourceWindowReader): () => void
}
