/** Plugin evaluation is main-thread work. Open the selected Host before the
 * background catalogs instead of initializing every complete graph at once. */
export class HostBootQueue {
    private readonly pending = new Map<string, () => Promise<void>>()
    private readonly active = new Set<string>()
    private disposed = false
    private timer: ReturnType<typeof setTimeout> | undefined
    constructor(private readonly preferred: () => string | undefined,
        private readonly foregroundPending: () => boolean = () => false) {}
    add(id: string, start: () => Promise<void>): void {
        if (this.disposed) return
        this.pending.set(id, start)
        this.schedule()
    }
    remove(id: string): void { this.pending.delete(id) }
    prioritize = (): void => { this.schedule() }
    private schedule(delay = 0): void {
        if (this.disposed || this.active.size >= 2 || this.timer !== undefined || !this.pending.size) return
        this.timer = setTimeout(() => { this.timer = undefined; void this.pump() }, delay)
    }
    private async pump(): Promise<void> {
        const preferred = this.preferred()
        if ((!preferred || !this.pending.has(preferred)) && this.foregroundPending()) {
            this.schedule(50); return
        }
        const id = preferred && this.pending.has(preferred) ? preferred : this.active.size ? undefined : this.pending.keys().next().value
        if (id === undefined || this.disposed) return
        const task = this.pending.get(id)!
        this.pending.delete(id); this.active.add(id)
        try { await task() } finally { this.active.delete(id); this.schedule() }
    }
    dispose(): void { this.disposed = true; this.pending.clear(); clearTimeout(this.timer) }
}
import { isSourceSessionId, parseSourceSessionId } from '../../remote/protocol.ts'

/** A canonical's paired original machine is a foreground discovery demand,
 * even while its saved Pane still points at the central read-only shadow.
 * This schedules its catalog only; exact row/access validation still owns routing. */
export function preferredSourceBootHost(address: { hostId: string; sessionId: string },
    hosts: readonly { id: string; online: boolean }[]): string {
    if (address.hostId !== 'local' || !isSourceSessionId(address.sessionId)) return address.hostId
    try {
        const { machineId } = parseSourceSessionId(address.sessionId)
        if (hosts.some(host => host.id === machineId && host.id !== 'local' && host.online)) return machineId
    } catch { /* Invalid identities keep their existing failed local route. */ }
    return address.hostId
}
