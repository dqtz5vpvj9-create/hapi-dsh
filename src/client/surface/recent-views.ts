/** Bounded mounted views for return visits; execution remains owned by the source. */
export class RecentViews<T> {
    private readonly entries = new Map<string, { paneId: string; value: T }>()
    constructor(private readonly limit: number, private readonly release: (value: T) => void) {}
    take(paneId: string, sessionId: string): T | undefined {
        const key = JSON.stringify([paneId, sessionId]), entry = this.entries.get(key)
        this.entries.delete(key)
        return entry?.value
    }
    park(paneId: string, sessionId: string, value: T): void {
        const key = JSON.stringify([paneId, sessionId]), previous = this.entries.get(key)
        this.entries.delete(key); this.entries.set(key, { paneId, value })
        if (previous && previous.value !== value) this.release(previous.value)
        while (this.entries.size > this.limit) {
            const [oldest, entry] = this.entries.entries().next().value!
            this.entries.delete(oldest); this.release(entry.value)
        }
    }
    prune(panes: ReadonlySet<string>): void {
        for (const [key, entry] of this.entries) if (!panes.has(entry.paneId)) { this.entries.delete(key); this.release(entry.value) }
    }
    clear(): void { const previous = [...this.entries.values()]; this.entries.clear(); for (const entry of previous) this.release(entry.value) }
}
