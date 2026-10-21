/** Shared by the root workspace and every independently loaded Client graph. */
export interface SourceSummarySettings { hubId: string; sessionSummaryInChat: boolean }
export interface SourceSummaryPreference {
    readonly getSnapshot: () => boolean
    readonly subscribe: (listener: () => void) => () => void
    /** Register this graph's authenticated read without creating another poller. */
    retain(read: () => Promise<SourceSummarySettings>): () => void
}
export interface SourceSummaryCoordinator {
    forHub(hubId: string): SourceSummaryPreference
    /** Only source-confirmed settings or an authoritative read may enter here. */
    accept(value: SourceSummarySettings): void
    /** One read per active Hub, with concurrent reads coalesced. */
    refresh(): Promise<void>
    dispose(): void
}

interface Entry {
    value: boolean
    loaded: boolean
    revision: number
    listeners: Set<() => void>
    readers: Map<symbol, () => Promise<SourceSummarySettings>>
    reading: Promise<void> | undefined
    source: SourceSummaryPreference
}

/**
 * This object must be created once by the workspace and passed through its
 * public hapiWorkspaceUi capability. A module-local singleton would not be
 * shared by the official, separately evaluated pane graphs.
 */
export function createSourceSummaryCoordinator(options: { pollMs?: number } = {}): SourceSummaryCoordinator {
    const entries = new Map<string, Entry>()
    const pollMs = options.pollMs ?? 30_000
    let timer: ReturnType<typeof setInterval> | undefined, disposed = false
    const publish = (entry: Entry, value: boolean): void => {
        const changed = entry.value !== value
        entry.value = value; entry.loaded = true; entry.revision++
        if (changed) for (const listener of [...entry.listeners]) listener()
    }
    const read = (hubId: string, entry: Entry): Promise<void> => {
        if (disposed || entry.reading) return entry.reading ?? Promise.resolve()
        const reader = entry.readers.values().next().value
        if (!reader) return Promise.resolve()
        const revision = entry.revision
        // Defer the call so even a synchronously rejected reader has a tracked
        // in-flight seat before another mounted message asks for the value.
        const pending = Promise.resolve().then(reader).then(value => {
            if (disposed || entry.revision !== revision || value.hubId !== hubId || typeof value.sessionSummaryInChat !== 'boolean') return
            publish(entry, value.sessionSummaryInChat)
        }).catch(() => {
            // The original default is hidden. A temporary read failure retains
            // the last observed source preference and never implies a write.
        }).finally(() => { if (entry.reading === pending) entry.reading = undefined })
        entry.reading = pending
        return pending
    }
    const refresh = async (): Promise<void> => { await Promise.all([...entries].map(([hubId, entry]) => read(hubId, entry))) }
    const updateTimer = (): void => {
        const active = !disposed && [...entries.values()].some(entry => entry.readers.size > 0)
        if (!active && timer !== undefined) { clearInterval(timer); timer = undefined }
        else if (active && timer === undefined && pollMs > 0) timer = setInterval(() => { void refresh() }, pollMs)
    }
    const forHub = (hubId: string): SourceSummaryPreference => {
        if (!hubId || hubId.length > 512) throw new Error('Invalid source Hub identity for summary display')
        let entry = entries.get(hubId)
        if (entry) return entry.source
        const created: Entry = { value: false, loaded: false, revision: 0, listeners: new Set(), readers: new Map(), reading: undefined,
            source: {
                getSnapshot: () => created.value,
                subscribe(listener) {
                    if (disposed) return () => {}
                    created.listeners.add(listener)
                    return () => { created.listeners.delete(listener) }
                },
                retain(reader) {
                    if (disposed) return () => {}
                    const token = Symbol('source-summary-reader'), wasEmpty = created.readers.size === 0
                    created.readers.set(token, reader); updateTimer()
                    if (!created.loaded || wasEmpty) void read(hubId, created)
                    return () => { created.readers.delete(token); updateTimer() }
                },
            },
        }
        entries.set(hubId, created)
        return created.source
    }
    return {
        forHub, refresh,
        accept(value) {
            if (disposed || typeof value.sessionSummaryInChat !== 'boolean') return
            forHub(value.hubId)
            // Increment even for the same boolean: a stale read started before
            // this confirmed mutation must not undo the source acknowledgement.
            publish(entries.get(value.hubId)!, value.sessionSummaryInChat)
        },
        dispose() {
            disposed = true; updateTimer()
            for (const entry of entries.values()) { entry.readers.clear(); entry.listeners.clear() }
            entries.clear()
        },
    }
}

export function notifySourceSummarySettings(coordinator: SourceSummaryCoordinator | undefined, value: SourceSummarySettings): void {
    coordinator?.accept(value)
}
