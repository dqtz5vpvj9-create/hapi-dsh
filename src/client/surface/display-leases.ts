/**
 * Browser-owned display leases for the Host-side source Session.
 *
 * The reference count follows the official Client SessionReference lifetime
 * (panes plus the bounded warm cache). This module never inspects DOM state and
 * never aborts source execution. The Host retires only its local observation
 * Session after the last reference is gone.
 */
import type { HapiRemoteApi } from '../../client-api.ts'

type Api = Pick<HapiRemoteApi, 'sourceDisplayLease'>
export interface DisplayIdentity { hubId: string; sourceSessionId: string }

const HEARTBEAT_MS = 60_000
const LEASE_TTL_MS = 5 * 60_000

class DisplayLease {
    private refs = 0
    private acquired = false
    private timer: ReturnType<typeof setInterval> | undefined
    private queue: Promise<void> = Promise.resolve()
    private disposed = false
    constructor(private readonly api: Api, private readonly identity: DisplayIdentity,
        private readonly leaseId: string, private readonly onError: (error: unknown) => void) {}

    retain(): void {
        if (this.disposed) return
        this.refs++
        if (this.refs !== 1) return
        this.send('acquire')
        if (this.timer === undefined) this.timer = setInterval(() => {
            if (this.refs > 0) this.send(this.acquired ? 'renew' : 'acquire')
        }, HEARTBEAT_MS)
    }

    release(): number {
        if (this.disposed || this.refs === 0) return this.refs
        this.refs--
        if (this.refs !== 0) return this.refs
        if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined }
        this.send('release')
        return 0
    }

    dispose(): void {
        if (this.disposed) return
        if (this.refs > 0) {
            this.refs = 0
            if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined }
            this.send('release')
        }
        this.disposed = true
    }

    async flush(): Promise<void> { await this.queue }

    private send(action: 'acquire' | 'renew' | 'release'): void {
        const request = {
            hubId: this.identity.hubId, sourceSessionId: this.identity.sourceSessionId,
            leaseId: this.leaseId, action, ttlMs: LEASE_TTL_MS,
        } as const
        this.queue = this.queue.then(async () => {
            const result = await this.api.sourceDisplayLease(request)
            if (!result.ok) throw result.error
            if (action === 'acquire') this.acquired = true
            if (action === 'release') this.acquired = false
        }).catch(this.onError)
    }
}

export interface DisplayLeaseRegistry {
    /** Remember the exact source identity before a pane or warm reference. */
    remember(displaySessionId: string, identity: DisplayIdentity): void
    retain(displaySessionId: string): void
    release(displaySessionId: string): void
    flush(): Promise<void>
    dispose(): void
}

export function createDisplayLeaseRegistry(api: Api, onError: (error: unknown) => void = () => {}): DisplayLeaseRegistry {
    const identities = new Map<string, DisplayIdentity>()
    const leases = new Map<string, DisplayLease>()
    let disposed = false
    const leaseFor = (displaySessionId: string): DisplayLease | undefined => {
        let lease = leases.get(displaySessionId)
        if (lease) return lease
        const identity = identities.get(displaySessionId)
        if (!identity) return undefined
        const leaseId = globalThis.crypto?.randomUUID?.() ?? `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`
        lease = new DisplayLease(api, identity, leaseId, onError)
        leases.set(displaySessionId, lease)
        return lease
    }
    const release = (displaySessionId: string): void => {
        const lease = leases.get(displaySessionId)
        if (!lease) return
        // Keep the object until every pane/warm reference has released it;
        // deleting at the first release strands later releases with no owner.
        if (lease.release() === 0) leases.delete(displaySessionId)
    }
    // A reload/crash cannot reliably send its final release. Its old lease
    // expires by TTL while the successor page acquires a new lease id; releasing
    // on pagehide would race that successor and could retire a display it is
    // already reopening.
    return {
        remember(displaySessionId, identity) {
            if (disposed) return
            const previous = identities.get(displaySessionId)
            if (previous && previous.hubId === identity.hubId && previous.sourceSessionId === identity.sourceSessionId) return
            const live = leases.get(displaySessionId)
            if (live) { live.dispose(); leases.delete(displaySessionId) }
            identities.set(displaySessionId, identity)
        },
        retain(displaySessionId) {
            if (disposed) return
            leaseFor(displaySessionId)?.retain()
        },
        release,
        async flush() { await Promise.allSettled([...leases.values()].map(lease => lease.flush())) },
        dispose() {
            if (disposed) return
            disposed = true
            for (const lease of leases.values()) lease.dispose()
            leases.clear(); identities.clear()
        },
    }
}
