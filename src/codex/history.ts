import type { HapiMessage, HapiMessagesPage, HapiMessagesQuery, HapiTransport } from './contracts.js'
import { compareNativeMessages } from './native.js'

const PAGE_SIZE = 200
const MAX_ATTEMPTS = 4

interface SnapshotHead { at: number; seq: number }

function headOf(page: HapiMessagesPage): SnapshotHead | null {
  const { snapshotHeadAt, snapshotHeadSeq } = page.page
  if (snapshotHeadAt === null || snapshotHeadSeq === null) return null
  return { at: snapshotHeadAt, seq: snapshotHeadSeq }
}

/** Newest known position, used when a source does not publish its snapshot head. */
function newestOf(rows: readonly HapiMessage[]): SnapshotHead | null {
  let found: SnapshotHead | null = null
  for (const row of rows) {
    if (row.seq === null) continue
    const at = row.invokedAt ?? row.createdAt
    if (!found || at > found.at || at === found.at && row.seq > found.seq) found = { at, seq: row.seq }
  }
  return found
}

const isBefore = (left: SnapshotHead, right: SnapshotHead): boolean =>
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
 * Read one bounded, latest-first pass anchored to the first page's snapshot
 * head. Later pages carry the head as `untilAt/untilSeq` and never re-send an
 * epoch: a source that keeps appending or rewrites its active stream item
 * cannot reset this read half way through. The only real restart conditions
 * are an authoritative `reset` or a snapshot head that moved backwards
 * (rewind/truncation).
 */
async function readPass(transport: HapiTransport, sessionId: string): Promise<Pass> {
  const first = await transport.readMessages(sessionId, { limit: PAGE_SIZE, bounded: true })
  const pinned = headOf(first) ?? newestOf(first.messages)
  const rows: HapiMessage[] = [...first.messages]
  const cursors = new Set<string>()
  let page = first
  while (page.page.hasMore) {
    const at = page.page.nextBeforeAt, seq = page.page.nextBeforeSeq
    if (at === null || seq === null) return { rows, complete: false }
    const key = `${at}:${seq}`
    if (cursors.has(key)) return { rows, complete: false }
    cursors.add(key)
    const query: HapiMessagesQuery = {
      limit: PAGE_SIZE, beforeAt: at, beforeSeq: seq, bounded: true,
      ...(pinned ? { untilAt: pinned.at, untilSeq: pinned.seq } : {}),
    }
    page = await transport.readMessages(sessionId, query)
    if (page.page.reset) return { rows: [], complete: false }
    const current = headOf(page)
    if (pinned && current && isBefore(current, pinned)) return { rows: [], complete: false }
    rows.push(...page.messages)
  }
  return { rows, complete: true }
}

/**
 * Read native history through HAPI's bounded cursor page contract.
 *
 * Large live sessions page through many requests while the source is still
 * appending. Each pass is anchored to one snapshot head, so a source that keeps
 * appending or rewrites its active stream item no longer restarts the read on a
 * new epoch. A real rewind or truncation still restarts the pass because the
 * head moves backwards (or the source reports an authoritative reset).
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
