import type { HapiMessage, HapiMessagesQuery, HapiTransport } from './contracts.js'
import { compareNativeMessages, envelopeFor, nativeExecutionFor, record } from './native.js'

const PAGE_SIZE = 200
const MAX_ATTEMPTS = 4

interface Position { at: number; seq: number }

const isBefore = (left: Position, right: Position): boolean =>
  left.at < right.at || left.at === right.at && left.seq < right.seq

function uniqueNewestFirst(rows: readonly HapiMessage[]): HapiMessage[] {
  // A cursor page can repeat a row whose position changed between requests
  // (queued input becoming invoked); identity must win over transport placement.
  const unique = new Map<string, HapiMessage>()
  for (const row of rows) unique.set(row.id, row)
  return [...unique.values()].sort(compareNativeMessages)
}

interface Pass { rows: HapiMessage[]; complete: boolean; epoch?: number }

export interface NativeHistoryTail extends Pass {
  context: 'previous-turn' | 'history-start' | 'limited'
  /** Authoritative cursor immediately before this window's oldest row. */
  before?: { at: number; seq: number }
}
export class NativeHistoryEpochChangedError extends Error {}

/** Native turn identities distinguish steering inputs from a previous turn.
 * Other source engines use their invoked human inputs as turn boundaries. */
export function includesPreviousTurn(rows: readonly HapiMessage[]): boolean {
  const turns = new Set<string>(), inputs = new Set<string>()
  for (const row of uniqueNewestFirst(rows)) {
    const envelope = envelopeFor(row.content), content = record(envelope?.content), data = record(content?.data)
    const meta = record(envelope?.meta), execution = nativeExecutionFor(meta?.nativeExecution ?? data?.nativeExecution)
    if (execution) turns.add(execution.turnId)
    if (envelope?.role === 'user' && (execution || row.invokedAt != null) && meta?.deliveryMode !== 'steer') {
      const turn = execution?.turnId ?? row.localId ?? row.id
      turns.add(turn); inputs.add(turn)
    }
  }
  const last = [...turns].slice(-2)
  return last.length === 2 && last.every(turn => inputs.has(turn))
}

/** Bounded initial context, independent of the later full-history backfill.
 * All retry passes share a 4,000-row budget and validate the original epoch. */
export async function readNativeHistoryTail(transport: HapiTransport, sessionId: string, pages = 20): Promise<NativeHistoryTail> {
  let remaining = 20
  for (let attempt = 0; attempt < MAX_ATTEMPTS && remaining > 0; attempt++) {
    remaining--
    const first = await transport.readMessages(sessionId, { limit: PAGE_SIZE, bounded: true })
    if (first.page.reset) continue
    let page = first, rows = [...first.messages], invalidated = false, pagesRead = 1
    const epoch = first.page.epoch
    while (page.page.hasMore && !includesPreviousTurn(rows) && remaining > 0 && pagesRead < pages) {
      const at = page.page.nextBeforeAt, seq = page.page.nextBeforeSeq
      if (at === null || seq === null) break
      remaining--
      pagesRead++
      const next = await transport.readMessages(sessionId, { limit: PAGE_SIZE, beforeAt: at, beforeSeq: seq, epoch, bounded: true })
      if (next.page.reset || next.page.epoch !== epoch) { invalidated = true; break }
      if (next.page.hasMore && (next.page.nextBeforeAt === null || next.page.nextBeforeSeq === null
        || !isBefore({ at: next.page.nextBeforeAt, seq: next.page.nextBeforeSeq }, { at, seq }))) break
      rows.push(...next.messages); page = next
    }
    if (invalidated) continue
    const at = first.page.snapshotHeadAt, seq = first.page.snapshotHeadSeq
    if (at !== null && seq !== null) {
      const check = await transport.readMessages(sessionId, { limit: 1, beforeAt: at, beforeSeq: seq, epoch, bounded: true })
      if (check.page.reset || check.page.epoch !== epoch) continue
    }
    rows = uniqueNewestFirst(rows)
    const oldest = rows[0]
    const before = page.page.nextBeforeAt !== null && page.page.nextBeforeSeq !== null
      ? { at: page.page.nextBeforeAt, seq: page.page.nextBeforeSeq }
      : oldest ? { at: oldest.invokedAt ?? oldest.createdAt, seq: oldest.seq ?? 0 } : undefined
    return { rows, epoch, ...(before === undefined ? {} : { before }),
      complete: !page.page.hasMore, context: includesPreviousTurn(rows) ? 'previous-turn' : !page.page.hasMore ? 'history-start' : 'limited' }
  }
  throw new Error('Native history changed repeatedly while reading the initial Turn context; refresh when the source snapshot is available')
}

/**
 * Read one bounded, latest-first pass pinned to one HAPI message epoch.
 *
 * HAPI rejects `untilAt/untilSeq` without an `afterAt/afterSeq` pair, so the
 * first page's snapshot head cannot bound older pages. What does guarantee a
 * coherent read is the message epoch: HAPI bumps it only when history changes
 * structurally (rewind/truncate/delete/fork/out-of-order insert), not for
 * normal appends. Every backward page therefore carries the epoch captured
 * from the first page; a `reset` response (or any epoch change) means the
 * snapshot was invalidated and the pass restarts from a fresh latest page. A
 * final epoch-stable check proves nothing changed while the rows were read.
 * Falling back to "read whatever is there now" would publish rows the source
 * has already removed; callers keep their previous cache instead.
 */
async function readPass(transport: HapiTransport, sessionId: string, yieldEveryPages = 8): Promise<Pass> {
  const first = await transport.readMessages(sessionId, { limit: PAGE_SIZE, bounded: true })
  const epoch = first.page.epoch
  const snapshotHeadAt = first.page.snapshotHeadAt, snapshotHeadSeq = first.page.snapshotHeadSeq
  const rows: HapiMessage[] = [...first.messages]
  let page = first, pagesRead = 1
  while (page.page.hasMore) {
    const at = page.page.nextBeforeAt, seq = page.page.nextBeforeSeq
    if (at === null || seq === null) return { rows, complete: false }
    page = await transport.readMessages(sessionId, { limit: PAGE_SIZE, beforeAt: at, beforeSeq: seq, epoch, bounded: true })
    if (page.page.reset || page.page.epoch !== epoch) return { rows: [], complete: false }
    const nextAt = page.page.nextBeforeAt, nextSeq = page.page.nextBeforeSeq
    if (page.page.hasMore) {
      if (nextAt === null || nextSeq === null) return { rows, complete: false }
      if (!isBefore({ at: nextAt, seq: nextSeq }, { at, seq })) return { rows, complete: false }
    }
    rows.push(...page.messages); pagesRead++
    // Archive pagination is network/CPU work, not an interactive priority.
    // Yield after a small bounded slice so input, live suffixes and the
    // already-published latest page are not starved by a long backfill.
    if (yieldEveryPages > 0 && pagesRead % yieldEveryPages === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }
  // Final validation: re-issue a cursor page under the same epoch. HAPI only
  // reports a stale snapshot when a cursor is supplied, so anchor the check on
  // the first page's snapshot head. A `reset` here proves the pass read a
  // history that structurally changed under it.
  if (snapshotHeadAt !== null && snapshotHeadSeq !== null) {
    const check = await transport.readMessages(sessionId, {
      limit: 1, beforeAt: snapshotHeadAt, beforeSeq: snapshotHeadSeq, epoch, bounded: true,
    })
    if (check.page.reset || check.page.epoch !== epoch) return { rows: [], complete: false }
  }
  return { rows, complete: true, epoch }
}

/**
 * Read native history through HAPI's bounded cursor page contract.
 *
 * Large live sessions page through many requests while the source is still
 * appending. Normal appends keep the epoch stable, so one anchored pass reads
 * the whole window; a structural change (rewind/truncation/deletion/fork)
 * invalidates the pass and it restarts from a fresh latest page.
 *
 * Only a complete anchored pass is published. Rows read before a reset may name
 * messages the source has already removed, so an exhausted read reports an
 * explicitly retryable error instead of presenting invalidated rows as
 * authoritative history; callers keep their own cache and unknown-state rules.
 */
export async function readNativeHistory(transport: HapiTransport, sessionId: string): Promise<HapiMessage[]> {
  return (await readNativeHistorySnapshot(transport, sessionId)).rows
}

export async function readNativeHistorySnapshot(transport: HapiTransport, sessionId: string, options: { yieldEveryPages?: number } = {}): Promise<{ rows: HapiMessage[]; epoch: number }> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pass = await readPass(transport, sessionId, options.yieldEveryPages)
    if (pass.complete) return { rows: uniqueNewestFirst(pass.rows), epoch: pass.epoch! }
  }
  throw new Error('Native history changed repeatedly during pagination; refresh when the source snapshot is available')
}

/**
 * Read forward from the last displayed source position in bounded pages.
 *
 * A long disconnect can exceed the backwards overlap walk; it is a catch-up,
 * not a structural rewrite. Each pass applies rows in source order and can be
 * continued by the next scheduled refresh without reading the full archive.
 */
export async function readNativeHistoryForward(transport: HapiTransport, sessionId: string, epoch: number,
  after: { at: number; seq: number }, maxPages = 12): Promise<{ rows: HapiMessage[]; hasMore: boolean; next: { at: number; seq: number } | null }> {
  let cursor = after
  let hasMore = false
  const rows: HapiMessage[] = []
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await transport.readMessages(sessionId, { limit: PAGE_SIZE, bounded: true, epoch,
      afterAt: cursor.at, afterSeq: cursor.seq })
    if (page.page.reset || page.page.epoch !== epoch) throw new NativeHistoryEpochChangedError('Native source history changed structurally during catch-up')
    rows.push(...page.messages)
    hasMore = page.page.hasMore
    if (!hasMore || page.page.nextAfterAt === null || page.page.nextAfterSeq === null) {
      return { rows: uniqueNewestFirst(rows), hasMore: false, next: null }
    }
    if (page.page.nextAfterAt === cursor.at && page.page.nextAfterSeq === cursor.seq) break
    cursor = { at: page.page.nextAfterAt, seq: page.page.nextAfterSeq }
  }
  return { rows: uniqueNewestFirst(rows), hasMore, next: cursor }
}

/** An append notification is not a rewind. Read only back to the last observed
 * source row, under the seed's structural epoch. A reset or an uncovered gap
 * requests the existing full reconciliation path; no prefix is guessed. */
export async function readNativeHistoryUpdate(transport: HapiTransport, sessionId: string, epoch: number,
  overlaps: (row: HapiMessage) => boolean): Promise<HapiMessage[] | null> {
  // Most hints update the current stream or append one item. Keep the hot
  // request small; a larger burst still pages backward until it overlaps.
  let page = await transport.readMessages(sessionId, { limit: 32, bounded: true })
  const head = page.page, rows: HapiMessage[] = []
  for (let count = 0; count < 20; count++) {
    if (page.page.reset || page.page.epoch !== epoch) throw new NativeHistoryEpochChangedError('Native source history changed structurally')
    rows.push(...page.messages)
    if (page.messages.some(overlaps)) {
      if (head.snapshotHeadAt !== null && head.snapshotHeadSeq !== null) {
        const check = await transport.readMessages(sessionId, { limit: 1, bounded: true, epoch,
          beforeAt: head.snapshotHeadAt, beforeSeq: head.snapshotHeadSeq })
        if (check.page.reset || check.page.epoch !== epoch) throw new NativeHistoryEpochChangedError('Native source history changed structurally')
      }
      return uniqueNewestFirst(rows)
    }
    const at = page.page.nextBeforeAt, seq = page.page.nextBeforeSeq
    if (!page.page.hasMore || at === null || seq === null) return null
    page = await transport.readMessages(sessionId, { limit: PAGE_SIZE, bounded: true, epoch, beforeAt: at, beforeSeq: seq })
  }
  return null
}
