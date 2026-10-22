/** Deliberate navigation, separate from focus, source updates and history I/O. */
export type PaneReadingTarget = { readonly kind: 'latest' }
    | { readonly kind: 'message'; readonly messageId: string; readonly origin: 'search' | 'link' | 'notification' }
    | { readonly kind: 'approval'; readonly requestId: string }
    | { readonly kind: 'delivery'; readonly localId: string }

export interface PaneReadingIntent {
    readonly revision: number
    readonly sessionId: string
    readonly target: PaneReadingTarget
}

/** A late latest/history completion cannot replace a newer explicit target. */
export class PaneReadingIntents {
    private sequence = 0
    private readonly entries = new Map<string, PaneReadingIntent>()

    request(paneId: string, sessionId: string, target: PaneReadingTarget): PaneReadingIntent {
        const intent = { revision: ++this.sequence, sessionId, target }
        this.entries.set(paneId, intent)
        return intent
    }
    read(paneId: string): PaneReadingIntent | undefined { return this.entries.get(paneId) }
    current(paneId: string, intent: PaneReadingIntent): boolean { return this.entries.get(paneId) === intent }
    retain(paneIds: ReadonlySet<string>): void {
        for (const id of this.entries.keys()) if (!paneIds.has(id)) this.entries.delete(id)
    }
    clear(): void { this.entries.clear() }
}
