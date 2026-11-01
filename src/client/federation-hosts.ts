import type { FederationHost } from '../client-api.ts'

export interface FederatedHostRuntime { stop(): Promise<void> }
interface HostEntry { host: FederationHost; abort: AbortController; runtime?: FederatedHostRuntime }

/** A connection observation does not own the lifetime of an opened Host graph. */
export class FederationHosts {
    private readonly entries = new Map<string, HostEntry>()
    private disposed = false

    constructor(private readonly options: {
        enqueue(id: string, start: () => Promise<void>): void
        boot(host: FederationHost, signal: AbortSignal): Promise<FederatedHostRuntime>
        ready(host: FederationHost): void
        failed(host: FederationHost, error: unknown): void
    }) {}

    /** Only a successfully read, complete pairing inventory can revoke a Host. */
    async reconcile(hosts: readonly FederationHost[], complete: boolean): Promise<void> {
        if (this.disposed) return
        const current = new Map(hosts.map(host => [host.id, host]))
        const stopped: Promise<void>[] = []
        for (const [id, entry] of this.entries) {
            const host = current.get(id)
            if (!host && complete) {
                this.entries.delete(id)
                entry.abort.abort()
                if (entry.runtime) stopped.push(entry.runtime.stop())
            } else {
                const recovered = host?.online && !entry.host.online
                entry.host = host ?? { ...entry.host, online: false }
                if (recovered && entry.runtime) this.options.ready(entry.host)
            }
        }
        for (const host of hosts) {
            if (host.id === 'local' || !host.online || this.entries.has(host.id)) continue
            const entry: HostEntry = { host, abort: new AbortController() }
            this.entries.set(host.id, entry)
            this.options.enqueue(host.id, async () => {
                if (entry.abort.signal.aborted || this.disposed) return
                if (!entry.host.online) {
                    this.entries.delete(host.id)
                    return
                }
                try {
                    const runtime = await this.options.boot(entry.host, entry.abort.signal)
                    if (entry.abort.signal.aborted || this.disposed) { await runtime.stop(); return }
                    entry.runtime = runtime
                    if (entry.host.online) this.options.ready(entry.host)
                } catch (error) {
                    if (this.entries.get(host.id) === entry) this.entries.delete(host.id)
                    if (!entry.abort.signal.aborted && !this.disposed && entry.host.online) this.options.failed(entry.host, error)
                }
            })
        }
        await Promise.allSettled(stopped)
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        const stopped: Promise<void>[] = []
        for (const entry of this.entries.values()) {
            entry.abort.abort()
            if (entry.runtime) stopped.push(entry.runtime.stop())
        }
        this.entries.clear()
        await Promise.allSettled(stopped)
    }
}
