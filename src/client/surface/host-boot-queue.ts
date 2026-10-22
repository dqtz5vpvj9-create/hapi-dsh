/** Plugin evaluation is main-thread work. Open the selected Host before the
 * background catalogs instead of initializing every complete graph at once. */
export class HostBootQueue {
    private readonly pending = new Map<string, () => Promise<void>>()
    private readonly active = new Set<string>()
    private disposed = false
    private timer: ReturnType<typeof setTimeout> | undefined
    constructor(private readonly preferred: () => string | undefined) {}
    add(id: string, start: () => Promise<void>): void {
        if (this.disposed) return
        this.pending.set(id, start)
        this.schedule()
    }
    prioritize = (): void => { this.schedule() }
    private schedule(): void {
        if (this.disposed || this.active.size >= 2 || this.timer !== undefined || !this.pending.size) return
        this.timer = setTimeout(() => { this.timer = undefined; void this.pump() }, 0)
    }
    private async pump(): Promise<void> {
        const preferred = this.preferred()
        const id = preferred && this.pending.has(preferred) ? preferred : this.active.size ? undefined : this.pending.keys().next().value
        if (id === undefined || this.disposed) return
        const task = this.pending.get(id)!
        this.pending.delete(id); this.active.add(id)
        try { await task() } finally { this.active.delete(id); this.schedule() }
    }
    dispose(): void { this.disposed = true; this.pending.clear(); clearTimeout(this.timer) }
}
