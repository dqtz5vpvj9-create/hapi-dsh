/** Versioned source observations; directory hints never establish active execution facts. */
import type { SourceChanges, SourceEntry, SourcePage, SourceSession } from '../remote/protocol.ts'

export class RemoteSessionState {
  private readonly journal: SourceChanges[] = []
  private bytes = 0
  private readonly sessions = new Map<string, SourceSession>()
  private readonly authoritative = new Set<string>()
  constructor(private readonly maxFrames = 256, private readonly maxBytes = 16 * 1024 * 1024) {}
  observe(session: SourceSession): SourceSession {
    this.authoritative.add(session.id); this.sessions.set(session.id, session); return session
  }
  hint(session: SourceSession): SourceSession {
    const previous = this.sessions.get(session.id)
    const accepted = previous && this.authoritative.has(session.id) ? { ...session, ...previous, ...((session.connection ?? previous.connection) ? { connection: session.connection ?? previous.connection } : {}), updatedAt: Math.max(previous.updatedAt, session.updatedAt),
      status: previous.status === 'offline' && !previous.activeTurnId && !previous.pendingRequests.length ? session.status : previous.status, activeTurnId: previous.activeTurnId, pendingRequests: previous.pendingRequests,
      capabilities: Object.fromEntries(Object.entries(previous.capabilities).map(([key, value]) =>
        [key, value && session.capabilities[key as keyof SourceSession['capabilities']]])) as unknown as SourceSession['capabilities'],
    } : session
    this.sessions.set(session.id, accepted); return accepted
  }
  forget(id: string): void { this.sessions.delete(id); this.authoritative.delete(id) }
  clear(): void { this.sessions.clear(); this.authoritative.clear(); this.reset() }
  reset(): void { this.journal.length = 0; this.bytes = 0 }
  record(change: SourceChanges): void {
    if (change.reset) this.reset()
    else {
      this.journal.push(change); this.bytes += JSON.stringify(change).length * 2
      while (this.journal.length > this.maxFrames || this.bytes > this.maxBytes) this.bytes -= JSON.stringify(this.journal.shift()!).length * 2
    }
  }
  /** Each page is replayed from its own baseline, never merely relabelled. */
  materialize(page: SourcePage, epoch: string, version: number, session: SourceSession): SourcePage {
    if (page.epoch !== epoch || page.version > version) throw this.stale()
    const entries = new Map(page.entries.map(entry => [entry.event.seq, entry]))
    let covered = page.version
    for (const change of this.journal) {
      if (change.version <= covered) continue
      if (change.epoch !== epoch || change.base !== covered) throw this.stale()
      for (const seq of change.removed) entries.delete(seq as SourceEntry['event']['seq'])
      for (const entry of change.upserts) {
        const seq = entry.event.seq
        if (entries.has(seq) || page.before !== null && page.after !== null && seq >= page.before && seq <= page.after
          || !page.hasAfter && seq > (page.after ?? -1)) entries.set(seq, entry)
      }
      covered = change.version
      if (covered === version) break
    }
    if (covered !== version) throw this.stale()
    const sorted = [...entries.values()].sort((a, b) => a.event.seq - b.event.seq)
    const body = sorted.filter(entry => !page.context.includes(entry.event.seq))
    return { ...page, entries: sorted, version, session,
      after: !page.hasAfter ? body.at(-1)?.event.seq ?? null : page.after,
      context: page.context.filter(seq => entries.has(seq as SourceEntry['event']['seq'])) }
  }
  merge(pages: readonly SourcePage[], epoch: string, version: number, session: SourceSession): SourcePage {
    const normalized = pages.map(page => this.materialize(page, epoch, version, session))
    const first = normalized[0]!, last = normalized.at(-1)!
    const entries = new Map<number, SourceEntry>()
    for (const page of normalized) for (const entry of page.entries) entries.set(entry.event.seq, entry)
    return { ...last, before: first.before, hasBefore: first.hasBefore,
      entries: [...entries.values()].sort((a, b) => a.event.seq - b.event.seq), context: [...new Set(normalized.flatMap(page => page.context))] }
  }
  private stale(): Error { return Object.assign(new Error('The recovery journal no longer covers this page. A fresh baseline is required.'), { code: 'STALE_VERSION' }) }
}
