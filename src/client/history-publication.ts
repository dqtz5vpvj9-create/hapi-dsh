/** Immutable candidate ownership until the official reader publishes a window. */
import type { HistorySnapshotV1 } from '@deepseek-ai/dsh-api-session-controller/client'

export interface PublishedWindow<T> {
  readonly snapshot: HistorySnapshotV1
  readonly metadata: T
  readonly order: number
  readonly bytes: number
}
export class HistoryPublication<T> {
  private readonly candidates = new Map<string, PublishedWindow<T>>()
  private accepted: PublishedWindow<T> | undefined
  private order = 0
  private disposed = false
  private used = 0
  constructor(private readonly validateRecord: (record: PublishedWindow<T>) => void,
    private readonly onAccept: (record: PublishedWindow<T>) => void,
    private readonly onDiscard: (record: PublishedWindow<T>) => void,
    private readonly limits = { snapshots: 32, bytes: 32 * 1024 * 1024 }) {}

  stage(snapshot: HistorySnapshotV1, metadata: T, bytes: number): void {
    this.assertLive()
    const previous = this.candidates.get(snapshot.version)
    if (previous) {
      if (previous.snapshot !== snapshot) throw this.stale('A candidate version was reused for different history.')
      return
    }
    const record = { snapshot, metadata, bytes, order: ++this.order }
    this.candidates.set(snapshot.version, record); this.used += bytes
    // Only a bounded set of unaccepted proposals is retained. Expiration causes
    // an explicit stale-candidate error before publication, never an eviction
    // of the currently displayed reader window.
    for (const [version, candidate] of this.candidates) {
      if (this.candidates.size <= this.limits.snapshots && this.used <= this.limits.bytes) break
      if (candidate === this.accepted || candidate === record) continue
      this.candidates.delete(version); this.used -= candidate.bytes
    }
  }
  validate(version: string): void {
    this.assertLive()
    const candidate = this.candidates.get(version)
    if (!candidate || this.accepted && candidate.order < this.accepted.order) throw this.stale('The prepared window was superseded before publication.')
    this.validateRecord(candidate)
  }
  accept(version: string): void {
    this.validate(version)
    const candidate = this.candidates.get(version)!
    if (candidate === this.accepted) return
    this.accepted = candidate
    for (const [key, prior] of this.candidates) if (prior.order < candidate.order) { this.candidates.delete(key); this.used -= prior.bytes }
    this.onAccept(candidate)
  }
  discard(version: string): void {
    if (this.disposed) return
    const candidate = this.candidates.get(version)
    if (!candidate || candidate === this.accepted) return
    this.candidates.delete(version); this.used -= candidate.bytes
    this.onDiscard(candidate)
  }
  get published(): PublishedWindow<T> | undefined { return this.accepted }
  windows(): readonly PublishedWindow<T>[] { return [...this.candidates.values()] }
  dispose(): void { this.disposed = true; this.candidates.clear(); this.accepted = undefined; this.used = 0 }
  private assertLive(): void { if (this.disposed) throw Object.assign(new Error('The reading view was released.'), { code: 'DISPOSED' }) }
  private stale(message: string): Error & { code: string } { return Object.assign(new Error(message), { code: 'STALE_VERSION' }) }
}
