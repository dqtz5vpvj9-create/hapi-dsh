import { createHash } from 'node:crypto'
import type { HapiEvent, HapiMessage } from './contracts.js'
import { compareNativeMessages, envelopeFor, record } from './native.js'

export interface HistoryCheckpoint { readonly generation: number; readonly sequence: number }

/** A changed source or an overrun buffer requires a fresh authoritative read. */
export class HistoryReadInvalidatedError extends Error {
  override readonly name = 'HistoryReadInvalidatedError'
  constructor(message = 'Source history changed while it was being reconciled; retrying from the current source') { super(message) }
}

/** Stable source identities also join a provisional stream with its committed row. */
export function sourceHistoryKey(row: HapiMessage): string {
  const envelope = envelopeFor(row.content), content = record(envelope?.content), data = record(content?.data)
  if (envelope?.role === 'agent' && content?.type === 'codex' && typeof data?.id === 'string'
    && (data.type === 'message' || data.type === 'reasoning')) return `stream:${data.id}`
  return row.localId ? `local:${row.localId}` : `row:${row.id}`
}

function prefer(previous: HapiMessage | undefined, next: HapiMessage): HapiMessage {
  // An in-flight REST page or a delayed SSE snapshot cannot undo an invoked
  // input / committed stream. A structural invalidation clears this protection
  // by starting a new journal generation and reading a new display seed.
  if (previous?.localId && !next.localId) return previous
  if (previous?.invokedAt != null && next.invokedAt == null) return previous
  if (previous && !previous.localId && !next.localId && sourceHistoryKey(previous).startsWith('stream:')) {
    const before = record(record(envelopeFor(previous.content)?.content)?.data)?.message
    const after = record(record(envelopeFor(next.content)?.content)?.data)?.message
    if (typeof before === 'string' && typeof after === 'string' && before.startsWith(after)) return previous
  }
  return next
}

class SourceRows {
  private readonly rows = new Map<string, HapiMessage>()
  private readonly ids = new Map<string, string>()
  add(row: HapiMessage, historical = false): void {
    const key = sourceHistoryKey(row), previousKey = this.ids.get(row.id), previous = this.rows.get(previousKey ?? key)
    // A pre-read journal entry proves monotonic source facts, while a current
    // REST overlap may legitimately correct an already committed message.
    const selected = historical && previous ? prefer(row, previous) : prefer(previous, row)
    if (previous) this.ids.delete(previous.id)
    if (previousKey && previousKey !== key) this.rows.delete(previousKey)
    this.rows.set(sourceHistoryKey(selected), selected); this.ids.set(selected.id, sourceHistoryKey(selected))
  }
  remove(messageId: string, localId?: string): void {
    const key = this.ids.get(messageId)
    if (key) { this.rows.delete(key); this.ids.delete(messageId) }
    if (localId) {
      const local = this.rows.get(`local:${localId}`)
      if (local) { this.rows.delete(`local:${localId}`); this.ids.delete(local.id) }
    }
  }
  sorted(): HapiMessage[] { return [...this.rows.values()].sort(compareNativeMessages) }
}

export function mergeSourceRows(base: readonly HapiMessage[], overlay: readonly HapiMessage[]): HapiMessage[] {
  const rows = new SourceRows()
  for (const row of base) rows.add(row)
  for (const row of overlay) rows.add(row)
  return rows.sorted()
}

type TailEvent = Extract<HapiEvent, { type: 'message-received' | 'message-cancelled' }>
type EvictedProof = { key: string; id: string; local?: string; committed: boolean; invoked: boolean; cancelled: boolean }
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * One bounded, append-only receive journal per source, captured BEFORE the
 * service's asynchronous event queue. It bridges an in-flight REST snapshot
 * and live events without assigning a second owner to the native execution.
 * Structural invalidation is a barrier: pre-rewind rows never cross it.
 */
export class SourceHistoryJournal {
  private generation = 0
  private sequence = 0
  private droppedThrough = 0
  private retainedBytes = 0
  private coverageLost = false
  private readonly evicted = new Map<string, EvictedProof>()
  private readonly entries: Array<{ sequence: number; event: TailEvent; bytes: number }> = []
  constructor(private readonly capacity = 1024, private readonly byteBudget = 8 * 1024 * 1024, private readonly proofCapacity = 4096) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('A history journal needs a positive bounded capacity')
    if (!Number.isInteger(byteBudget) || byteBudget < 1 || !Number.isInteger(proofCapacity) || proofCapacity < 1) throw new Error('A history journal needs positive byte and proof bounds')
  }
  checkpoint(): HistoryCheckpoint { return { generation: this.generation, sequence: this.sequence } }
  capture(event: HapiEvent): void {
    if (event.type === 'messages-invalidated' && event.reason !== 'native-history' || event.type === 'session-removed'
      || event.type === 'connection-changed' && event.data?.resume === 'gap') {
      this.generation++; this.entries.length = 0; this.retainedBytes = 0; this.evicted.clear(); this.coverageLost = false; this.droppedThrough = ++this.sequence
      return
    }
    if (event.type !== 'message-received' && event.type !== 'message-cancelled') return
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    this.entries.push({ sequence: ++this.sequence, event, bytes }); this.retainedBytes += bytes
    // Keep only fixed-size hashes after a payload is evicted. A later read
    // must account for that live identity before it can be called complete.
    while (this.entries.length > this.capacity || this.retainedBytes > this.byteBudget) {
      const dropped = this.entries.shift()!; this.droppedThrough = dropped.sequence; this.retainedBytes -= dropped.bytes
      const value = dropped.event
      const row = value.type === 'message-received' ? value.message : undefined
      const key = fingerprint(row ? sourceHistoryKey(row) : `cancel:${value.type === 'message-cancelled' ? value.messageId : ''}`)
      const previous = this.evicted.get(key)
      if (this.evicted.size >= this.proofCapacity && !this.evicted.has(key)) this.coverageLost = true
      else this.evicted.set(key, { key, id: fingerprint(row?.id ?? (value as Extract<TailEvent, { type: 'message-cancelled' }>).messageId),
        ...(row?.localId ? { local: fingerprint(row.localId) } : value.type === 'message-cancelled' && value.localId ? { local: fingerprint(value.localId) }
          : previous?.local ? { local: previous.local } : {}),
        committed: !!row?.localId || !!previous?.committed, invoked: row?.invokedAt != null || !!previous?.invoked, cancelled: value.type === 'message-cancelled' })
    }
  }
  get size(): number { return this.entries.length }
  get bytes(): number { return this.retainedBytes }
  get incomplete(): boolean { return this.coverageLost || this.evicted.size > 0 }
  assertCurrent(checkpoint: HistoryCheckpoint): void {
    if (checkpoint.generation !== this.generation || checkpoint.sequence < this.droppedThrough) throw new HistoryReadInvalidatedError()
  }
  /** Cache is explicitly stale; replay the retained suffix before displaying it. */
  overlayCache(rows: readonly HapiMessage[]): HapiMessage[] {
    return this.merge(rows, { generation: this.generation, sequence: this.droppedThrough }, false)
  }
  merge(rows: readonly HapiMessage[], checkpoint: HistoryCheckpoint, authoritative = true): HapiMessage[] {
    this.assertCurrent(checkpoint)
    const merged = new SourceRows()
    for (const row of rows) merged.add(row)
    for (const entry of this.entries) {
      const event = entry.event
      if (event.type === 'message-received') {
        // Source history indexing may lag its SSE publication. Keep an
        // unacknowledged live row even when it arrived before this read began;
        // a newer authoritative overlap wins. Only an explicit structural
        // barrier is allowed to forget that live suffix.
        merged.add(event.message, entry.sequence <= checkpoint.sequence)
      }
      else merged.remove(event.messageId, event.localId)
    }
    const result = merged.sorted()
    if (authoritative) {
      if (this.coverageLost) throw new HistoryReadInvalidatedError('The live history journal exceeded its bounded coverage proofs; source history remains stale until a structural resynchronization')
      const available = new Map(result.map(row => [fingerprint(sourceHistoryKey(row)), row]))
      const sourceIds = new Set(rows.flatMap(row => [fingerprint(row.id), ...(row.localId ? [fingerprint(row.localId)] : [])]))
      for (const [key, proof] of this.evicted) {
        if (proof.cancelled) {
          if (sourceIds.has(proof.id) || proof.local && sourceIds.has(proof.local)) throw new HistoryReadInvalidatedError('Source history still includes an evicted cancellation; reconciling the live journal')
        } else {
          const cancelled = this.entries.some(entry => entry.event.type === 'message-cancelled'
            && (fingerprint(entry.event.messageId) === proof.id || !!entry.event.localId && fingerprint(entry.event.localId) === proof.local))
          const row = available.get(key)
          if (!cancelled && (!row || proof.committed && !row.localId || proof.invoked && row.invokedAt == null)) {
            throw new HistoryReadInvalidatedError('Source history has not indexed an evicted live row; the history cache remains stale')
          }
        }
      }
      // All evicted observations now have coverage in this authoritative
      // snapshot plus its retained live suffix. The payload budget stays fixed.
      this.evicted.clear()
    }
    return result
  }
}

/** Detect historical insertion before an already published append-only log. */
export class SourceHistoryOrder {
  private readonly keys = new Set<string>()
  private latest: HapiMessage | undefined
  overlapsLatest(row: HapiMessage): boolean { return !!this.latest && sourceHistoryKey(row) === sourceHistoryKey(this.latest) }
  needsReseed(rows: readonly HapiMessage[]): boolean {
    const latest = this.latest
    if (!latest) return false
    return rows.some(row => !this.keys.has(sourceHistoryKey(row)) && compareNativeMessages(row, latest) < 0)
  }
  accept(rows: readonly HapiMessage[], authoritative: boolean): void {
    if (authoritative) { this.keys.clear(); this.latest = undefined }
    for (const row of rows) {
      this.keys.add(sourceHistoryKey(row))
      if (!this.latest || compareNativeMessages(row, this.latest) > 0) this.latest = row
    }
  }
}
