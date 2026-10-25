/**
 * Browser-owned display leases for the Host-side source Session.
 *
 * The reference count follows the official Client SessionReference lifetime
 * (panes plus the bounded warm cache). This module never inspects DOM state and
 * never aborts source execution. The Host retires only its local observation
 * Session after the last reference is gone.
 *
 * A frozen tab can outlive its lease. On foreground/network/bfcache resume the
 * client probes immediately; a missing lease is re-acquired and a retired
 * display generation is recovered through the public source resolver. One
 * in-flight RPC plus one retry timer bounds this work: a hung heartbeat can
 * never turn every minute into a new Promise chain.
 */
import type { HapiRemoteApi } from '../../client-api.ts'
import { randomId } from '../random-id.ts'

type Api = Pick<HapiRemoteApi, 'sourceDisplayLease'> & Partial<Pick<HapiRemoteApi, 'sourceSessionResolve'>>
export interface DisplayIdentity { hubId: string; sourceSessionId: string }
export interface DisplayLeaseOptions {
    heartbeatMs?: number
    leaseTtlMs?: number
    retryBaseMs?: number
    retryMaxMs?: number
    rpcTimeoutMs?: number
    /** The normal catalog/controller refresh after a new Host generation exists. */
    onRecover?: (() => void | Promise<void>) | undefined
}

const HEARTBEAT_MS = 60_000
const LEASE_TTL_MS = 5 * 60_000
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000
const RPC_TIMEOUT_MS = 15_000

/** Await transport settlement, not a detached Promise.race. Official RPC
 * cancellation aborts its request; an adapter that ignores cancellation stays
 * single-flight until it settles instead of accumulating abandoned requests. */
const timeout = async <T>(operation: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('The source display lease request did not settle in time')), ms)
    try { return await operation(controller.signal) }
    finally { clearTimeout(timer) }
}

class DisplayLease {
    private refs = 0
    private leaseId = randomId()
    private acquired = false
    private everAcquired = false
    private lost = false
    private disposed = false
    private timer: ReturnType<typeof setInterval> | undefined
    private retryTimer: ReturnType<typeof setTimeout> | undefined
    private pumpTask: Promise<void> | undefined
    private dirty = false
    private recovery: Promise<void> | undefined
    private recoveryToken = 0
    private retryDelay: number
    constructor(private readonly api: Api, private readonly identity: DisplayIdentity,
        private readonly onError: (error: unknown) => void, private readonly options: DisplayLeaseOptions) {
        this.retryDelay = options.retryBaseMs ?? RETRY_BASE_MS
    }

    retain(): void {
        if (this.disposed) return
        this.refs++
        if (this.refs !== 1) return
        if (this.timer === undefined) this.timer = setInterval(() => this.probe(), this.options.heartbeatMs ?? HEARTBEAT_MS)
        this.probe()
    }

    release(): number {
        if (this.disposed || this.refs === 0) return this.refs
        this.refs--
        if (this.refs !== 0) return this.refs
        this.stopTimers()
        this.dirty = true
        void this.pump()
        return 0
    }

    dispose(): void {
        if (this.disposed) return
        this.refs = 0
        this.disposed = true
        this.stopTimers()
        this.dirty = true
        void this.pump()
    }

    /** Foreground/bfcache/online recovery must not wait for the heartbeat. */
    resume(): void { this.probe() }

    async flush(): Promise<void> {
        while (this.pumpTask) await this.pumpTask
    }

    private probe(): void {
        if (this.disposed || this.refs === 0) return
        this.dirty = true
        void this.pump()
    }

    private pump(): Promise<void> {
        if (this.pumpTask) { this.dirty = true; return this.pumpTask }
        const task = (async () => {
            do {
                this.dirty = false
                try { await this.step() }
                catch (error) {
                    if (this.refs > 0 && !this.disposed) {
                        try { this.onError(error) } catch { /* reporting is best effort */ }
                        this.scheduleRetry()
                    }
                }
            } while (this.dirty)
        })()
        this.pumpTask = task
        void task.finally(() => { if (this.pumpTask === task) this.pumpTask = undefined }).catch(() => {})
        return task
    }

    private async step(): Promise<void> {
        if (this.refs === 0) {
            if (this.acquired || this.everAcquired) await this.send('release')
            this.acquired = false; this.lost = false; this.everAcquired = false
            return
        }
        if (!this.acquired || this.lost) await this.acquire()
        else await this.renew()
    }

    private async acquire(): Promise<void> {
        const leaseId = this.leaseId
        const hadLease = this.everAcquired
        // A close may race an acquire whose acknowledgement is lost. Remember
        // the attempt so the queued close still sends its idempotent release.
        this.everAcquired = true
        const result = await this.send('acquire')
        if (this.leaseId !== leaseId || this.refs === 0 || this.disposed) return
        this.acquired = true
        this.everAcquired = true
        // The first acquire may legitimately precede the controller opening the
        // display. Only a lease that existed before this re-acquire can prove a
        // retired generation; an initial false must be recovered by the normal
        // catalog/controller path instead of creating a competing display.
        if (hadLease && result.attached === false) {
            this.lost = true
            this.triggerRecovery()
        } else this.lost = result.leaseActive === false
    }

    private async renew(): Promise<void> {
        const leaseId = this.leaseId
        const result = await this.send('renew')
        if (this.leaseId !== leaseId || this.refs === 0 || this.disposed) return
        if (result.leaseActive !== true) {
            // Expired lease or Host restart. Rotate the id so a delayed release
            // of the old lease can never delete the replacement.
            this.acquired = false
            this.lost = true
            this.leaseId = randomId()
            this.dirty = true
            return
        }
        this.acquired = true
        if (result.attached === false || result.released === true) {
            this.lost = true
            this.triggerRecovery()
        } else this.lost = false
    }

    private async send(action: 'acquire' | 'renew' | 'release') {
        const leaseId = this.leaseId
        const result = await timeout(signal => this.api.sourceDisplayLease({
            hubId: this.identity.hubId, sourceSessionId: this.identity.sourceSessionId,
            leaseId, action, ttlMs: this.options.leaseTtlMs ?? LEASE_TTL_MS,
        }, signal), this.options.rpcTimeoutMs ?? RPC_TIMEOUT_MS)
        if (!result.ok) throw result.error
        if (action === 'release') { this.acquired = false; this.lost = false }
        return result.value
    }

    private triggerRecovery(): void {
        if (this.disposed || this.refs === 0 || this.recovery || !this.api.sourceSessionResolve) return
        const token = ++this.recoveryToken
        const work = (async () => {
            const result = await timeout(signal => this.api.sourceSessionResolve!({
                hubId: this.identity.hubId, sourceSessionId: this.identity.sourceSessionId,
            }, signal), this.options.rpcTimeoutMs ?? RPC_TIMEOUT_MS)
            if (!result.ok) throw result.error
            if (token !== this.recoveryToken || this.disposed || this.refs === 0) return
            if (result.value.hubId !== this.identity.hubId || result.value.sourceSessionId !== this.identity.sourceSessionId) {
                throw new Error('The Host resolved another source identity while recovering its display')
            }
            await this.options.onRecover?.()
            if (token !== this.recoveryToken || this.disposed || this.refs === 0) return
            this.lost = false
            this.retryDelay = this.options.retryBaseMs ?? RETRY_BASE_MS
        })()
        const tracked = work.finally(() => { if (this.recovery === tracked) this.recovery = undefined })
        this.recovery = tracked
        void tracked.catch(error => {
            if (this.disposed || this.refs === 0) return
            this.onError(error)
            this.scheduleRetry()
        })
    }

    private scheduleRetry(): void {
        if (this.disposed || this.refs === 0 || this.retryTimer) return
        const delay = this.retryDelay
        this.retryDelay = Math.min(this.options.retryMaxMs ?? RETRY_MAX_MS, Math.max(250, this.retryDelay * 2))
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined
            if (this.disposed || this.refs === 0) return
            this.dirty = true
            void this.pump()
        }, delay)
    }

    private stopTimers(): void {
        if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined }
        if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    }
}

export interface DisplayLeaseRegistry {
    /** Remember the exact source identity before a pane or warm reference. */
    remember(displaySessionId: string, identity: DisplayIdentity): void
    retain(displaySessionId: string): void
    release(displaySessionId: string): void
    /** Probe every live lease now; used by foreground/online/bfcache restore. */
    resume(): void
    flush(): Promise<void>
    dispose(): void
}

export function createDisplayLeaseRegistry(
    api: Api,
    onError: (error: unknown) => void = () => {},
    options: DisplayLeaseOptions = {},
): DisplayLeaseRegistry {
    const identities = new Map<string, DisplayIdentity>()
    const leases = new Map<string, DisplayLease>()
    let disposed = false
    let refreshTask: Promise<void> | undefined
    // Several panes can recover from one foreground event. Coalesce their
    // catalog refreshes instead of starting one full Host refresh per pane.
    const refresh = async (): Promise<void> => {
        if (!options.onRecover) return
        refreshTask ??= Promise.resolve(options.onRecover()).then(() => undefined, error => {
            refreshTask = undefined
            throw error
        })
        await refreshTask
        refreshTask = undefined
    }
    const leaseFor = (displaySessionId: string): DisplayLease | undefined => {
        let lease = leases.get(displaySessionId)
        if (lease) return lease
        const identity = identities.get(displaySessionId)
        if (!identity) return undefined
        lease = new DisplayLease(api, identity, onError, { ...options, onRecover: refresh })
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
    const resume = (): void => { for (const lease of leases.values()) lease.resume() }
    const visible = (): void => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') resume() }
    const pageShow = (event: PageTransitionEvent): void => { if (event.persisted) resume() }
    if (typeof window !== 'undefined') {
        window.addEventListener('online', resume)
        window.addEventListener('pageshow', pageShow)
        document.addEventListener('visibilitychange', visible)
    }
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
        resume,
        async flush() { await Promise.allSettled([...leases.values()].map(lease => lease.flush())) },
        dispose() {
            if (disposed) return
            disposed = true
            if (typeof window !== 'undefined') {
                window.removeEventListener('online', resume)
                window.removeEventListener('pageshow', pageShow)
                document.removeEventListener('visibilitychange', visible)
            }
            for (const lease of leases.values()) lease.dispose()
            leases.clear(); identities.clear()
        },
    }
}
