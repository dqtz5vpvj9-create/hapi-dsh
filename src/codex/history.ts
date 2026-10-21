import type { HapiMessage, HapiMessagesQuery, HapiTransport } from './contracts.js'
import { compareNativeMessages } from './native.js'

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

interface Pass { rows: HapiMessage[]; complete: boolean }

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
async function readPass(transport: HapiTransport, sessionId: string): Promise<Pass> {
  const first = await transport.readMessages(sessionId, { limit: PAGE_SIZE, bounded: true })
  const epoch = first.page.epoch
  const snapshotHeadAt = first.page.snapshotHeadAt, snapshotHeadSeq = first.page.snapshotHeadSeq
  const rows: HapiMessage[] = [...first.messages]
  let page = first
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
    rows.push(...page.messages)
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
  return { rows, complete: true }
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
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pass = await readPass(transport, sessionId)
    if (pass.complete) return uniqueNewestFirst(pass.rows)
  }
  throw new Error('Native history changed repeatedly during pagination; refresh when the source snapshot is available')
}
