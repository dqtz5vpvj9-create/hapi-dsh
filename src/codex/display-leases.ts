/**
 * Bounded display leases shared by the native and observed source services.
 *
 * The browser owns the authoritative SessionReference lifetime. A lease only
 * records that at least one live view/warm reference still needs the Host-side
 * display Session. It never starts, stops or transfers source execution.
 *
 * Expiry exists solely for an abruptly closed browser that cannot send its
 * final release. A live page renews well inside the TTL; an absent client is
 * not guessed from DOM state. The release itself is still serialized behind
 * the service's source queue and rechecks for a late acquire.
 */

export const DISPLAY_LEASE_TTL_MS = 5 * 60_000
export const DISPLAY_RELEASE_GRACE_MS = 10_000

export interface DisplayLeaseView {
  readonly hubId: string
  readonly sourceSessionId: string
  readonly leaseId: string
  readonly action: 'acquire' | 'renew' | 'release'
  readonly ttlMs?: number | undefined
}

/** One source may be shown by several panes and several browser clients. */
export class DisplayLeases {
  private readonly bySource = new Map<string, Map<string, number>>()
  constructor(private readonly now: () => number = Date.now) {}

  acquire(sourceId: string, leaseId: string, ttlMs = DISPLAY_LEASE_TTL_MS): void {
    let source = this.bySource.get(sourceId)
    if (!source) { source = new Map(); this.bySource.set(sourceId, source) }
    source.set(leaseId, this.now() + Math.max(1_000, ttlMs))
  }

  /** A renewal for an unknown lease is ignored; the original acquire owns it. */
  renew(sourceId: string, leaseId: string, ttlMs = DISPLAY_LEASE_TTL_MS): void {
    const source = this.bySource.get(sourceId)
    if (!source?.has(leaseId)) return
    source.set(leaseId, this.now() + Math.max(1_000, ttlMs))
  }

  /** Returns true only after the final lease for this source is gone. */
  release(sourceId: string, leaseId: string): boolean {
    const source = this.bySource.get(sourceId)
    if (!source) return true
    source.delete(leaseId)
    if (source.size) return false
    this.bySource.delete(sourceId)
    return true
  }

  has(sourceId: string): boolean { return (this.bySource.get(sourceId)?.size ?? 0) > 0 }
  size(sourceId: string): number { return this.bySource.get(sourceId)?.size ?? 0 }
  /** Forget a removed source even when an old browser lease is still open. */
  drop(sourceId: string): void { this.bySource.delete(sourceId) }

  /** Drop expired leases and report the sources that just lost their last one. */
  expire(): string[] {
    const now = this.now(), empty: string[] = []
    for (const [sourceId, leases] of this.bySource) {
      for (const [leaseId, expiresAt] of leases) if (expiresAt <= now) leases.delete(leaseId)
      if (!leases.size) { this.bySource.delete(sourceId); empty.push(sourceId) }
    }
    return empty
  }

  clear(): void { this.bySource.clear() }
}
