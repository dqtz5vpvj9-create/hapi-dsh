import type { FederationHost } from '../client-api.ts'

export interface FederatedHostRuntime { revoke?(): void | Promise<void>; stop(): Promise<void> }
/** A pairing removal must remain distinguishable from ordinary graph teardown. */
export class FederatedHostRevocation extends Error {}
interface HostEntry { host: FederationHost; abort: AbortController; runtime?: FederatedHostRuntime; revoked?: boolean }

async function stopRuntime(runtime: FederatedHostRuntime, revoked: boolean): Promise<void> {
    try { if (revoked) await runtime.revoke?.() } finally { await runtime.stop() }
}

/** A connection observation does not own the lifetime of an opened Host graph. */
export class FederationHosts {
    private readonly entries = new Map<string, HostEntry>()
    private readonly knownHosts = new Map<string, FederationHost>()
    private disposed = false

    constructor(private readonly options: {
        enqueue(id: string, start: () => Promise<void>): void
        boot(host: FederationHost, signal: AbortSignal): Promise<FederatedHostRuntime>
        ready(host: FederationHost): void
        failed(host: FederationHost, error: unknown): void
        /** Also clears a previously persisted Host whose new boot was still queued. */
        revoked?(host: FederationHost): void | Promise<void>
    }) {}

    /** Only a successfully read, complete pairing inventory can revoke a Host. */
    async reconcile(hosts: readonly FederationHost[], complete: boolean): Promise<void> {
        if (this.disposed) return
        const current = new Map(hosts.map(host => [host.id, host]))
        const stopped: Promise<void>[] = []
        for (const [id, host] of this.knownHosts) if (!current.has(id) && complete) {
            this.knownHosts.delete(id)
            if (!this.entries.has(id)) stopped.push((async () => { await this.options.revoked?.(host) })())
        }
        for (const host of hosts) if (host.id !== 'local') this.knownHosts.set(host.id, host)
        for (const [id, entry] of this.entries) {
            const host = current.get(id)
            if (!host && complete) {
                this.entries.delete(id)
                entry.revoked = true
                const removal = (async () => {
                    try {
                        if (entry.runtime) await entry.runtime.revoke?.()
                    } finally {
                        entry.abort.abort(new FederatedHostRevocation('The paired Host was removed.'))
                        try { await entry.runtime?.stop() } finally { await this.options.revoked?.(entry.host) }
                    }
                })()
                stopped.push(removal)
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
                    if (entry.revoked || entry.abort.signal.aborted || this.disposed) {
                        try { await stopRuntime(runtime, entry.revoked === true) }
                        finally { if (entry.revoked) await this.options.revoked?.(entry.host) }
                        return
                    }
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
        this.knownHosts.clear()
        await Promise.allSettled(stopped)
    }
}
