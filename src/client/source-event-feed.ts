import type { SessionEventLikeEntry, SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'

type WindowNode =
  | { kind: 'leaf'; entries: readonly SessionEventLikeEntry[]; length: number }
  | { kind: 'concat'; left: WindowNode; right: WindowNode; length: number }

function leaf(entries: readonly SessionEventLikeEntry[]): WindowNode { return { kind: 'leaf', entries, length: entries.length } }
function concat(left: WindowNode, right: WindowNode): WindowNode { return { kind: 'concat', left, right, length: left.length + right.length } }
function materialize(node: WindowNode): readonly SessionEventLikeEntry[] {
  if (node.kind === 'leaf') return node.entries
  const entries = new Array<SessionEventLikeEntry>(node.length)
  const pending: WindowNode[] = [node as WindowNode]
  let index = 0
  while (pending.length) {
    const current = pending.pop()!
    if (current.kind === 'concat') pending.push(current.right, current.left)
    else for (const entry of current.entries) entries[index++] = entry
  }
  return entries
}
function snapshotOf(node: WindowNode, hasMore: boolean, revision: number,
  change: SessionEventWindow['change']): SessionEventWindow {
  let entries: readonly SessionEventLikeEntry[] | undefined
  return { get entries() {
    if (entries === undefined) entries = [...materialize(node)].sort((left, right) => left.event.seq - right.event.seq)
    return entries
  }, hasMore, revision, change }
}

type FeedChange = 'replace' | 'prepend' | 'append' | 'unchanged'
type FeedMetrics = { previous: number; next: number; added: number; identityOffset: number | null;
  identityOverlap: number; identityOrderPreserved: boolean; identityBefore: number; identityBetween: number; identityAfter: number;
  keyOverlap: number; stableKeySeq: number; keyOrderPreserved: boolean; keyBefore: number; keyBetween: number; keyAfter: number;
  identityChangesByType: Record<string, number>; payloadChangesByType: Record<string, number> }
type FeedTrace = ((change: FeedChange, metrics?: FeedMetrics) => void) & { captureMetrics?: boolean }
type FeedTraceGlobal = typeof globalThis & { __hapiDshSourceFeedTrace?: FeedTrace }
function traceFeedChange(change: FeedChange, metrics?: () => FeedMetrics): void {
  try {
    const trace = (globalThis as FeedTraceGlobal).__hapiDshSourceFeedTrace
    if (trace) trace(change, trace.captureMetrics ? metrics?.() : undefined)
  } catch { /* diagnostics are optional */ }
}
function feedMetrics(previous: readonly SessionEventLikeEntry[], entries: readonly SessionEventLikeEntry[]): FeedMetrics {
  const indexByIdentity = new Map(entries.map((entry, index) => [entry, index]))
  let identityOverlap = 0, identityOffset: number | null = previous.length === 0 ? 0 : null
  let offset: number | undefined, contiguous = true, identityOrderPreserved = true
  let previousPosition = -1, firstPosition = -1, lastPosition = -1
  for (const [index, entry] of previous.entries()) {
    const position = indexByIdentity.get(entry)
    if (position === undefined) continue
    identityOverlap++
    if (firstPosition < 0) firstPosition = position
    if (position <= previousPosition) identityOrderPreserved = false
    previousPosition = position; lastPosition = position
    if (offset === undefined) offset = position - index
    else if (position - index !== offset) contiguous = false
  }
  if (identityOverlap === previous.length && contiguous && offset !== undefined) identityOffset = offset
  const keyOf = (entry: SessionEventLikeEntry): string | undefined =>
    (entry as SessionEventLikeEntry & { sourceFrameKey?: string }).sourceFrameKey
  const oldKeys = new Map(previous.flatMap(entry => { const key = keyOf(entry); return key ? [[key, entry.event.seq] as const] : [] }))
  const indexByKey = new Map(entries.flatMap((entry, index) => { const key = keyOf(entry); return key ? [[key, index] as const] : [] }))
  let keyOverlap = 0, stableKeySeq = 0, keyOrderPreserved = true, keyFirst = -1, keyLast = -1, keyPreviousPosition = -1
  const identityChangesByType: Record<string, number> = {}, payloadChangesByType: Record<string, number> = {}
  const payload = (entry: SessionEventLikeEntry): string => {
    const data = { ...((entry.event.data ?? {}) as Record<string, unknown>) }
    for (const field of ['turn', 'step', 'displayTurn', 'displayStep', 'surfaceSeq']) delete data[field]
    const event = entry.event as unknown as Record<string, unknown>
    const operation = event.surfaceOp as Record<string, unknown> | undefined
    const stableOperation = operation ? { ...operation } : undefined
    if (stableOperation) { delete stableOperation.startSeq; delete stableOperation.endSeq }
    return JSON.stringify({ type: event.type, time: event.time, data, surfaceOp: stableOperation })
  }
  for (const old of previous) {
    const key = keyOf(old), position = key ? indexByKey.get(key) : undefined
    if (key === undefined || position === undefined) continue
    keyOverlap++
    if (keyFirst < 0) keyFirst = position
    if (position <= keyPreviousPosition) keyOrderPreserved = false
    keyPreviousPosition = position; keyLast = position
    if (oldKeys.get(key) === entries[position]!.event.seq) stableKeySeq++
    if (old !== entries[position]) {
      const type = String(old.event.type)
      identityChangesByType[type] = (identityChangesByType[type] ?? 0) + 1
      if (payload(old) !== payload(entries[position]!)) payloadChangesByType[type] = (payloadChangesByType[type] ?? 0) + 1
    }
  }
  return { previous: previous.length, next: entries.length, added: entries.length - previous.length,
    identityOffset, identityOverlap, identityOrderPreserved,
    identityBefore: Math.max(0, firstPosition), identityBetween: identityOrderPreserved ? Math.max(0, lastPosition - firstPosition + 1 - identityOverlap) : -1,
    identityAfter: Math.max(0, entries.length - lastPosition - 1),
    keyOverlap, stableKeySeq, keyOrderPreserved,
    keyBefore: Math.max(0, keyFirst), keyBetween: keyOrderPreserved ? Math.max(0, keyLast - keyFirst + 1 - keyOverlap) : -1,
    keyAfter: Math.max(0, entries.length - keyLast - 1), identityChangesByType, payloadChangesByType }
}

/** Persistent contiguous event window matching HAPI, with one append per source batch. */
class PersistentSessionEventSource implements SessionEventSource {
  private readonly listeners = new Set<() => void>()
  private window = leaf([])
  private snapshot = snapshotOf(this.window, false, 0, { kind: 'replace', entries: [] })

  getSnapshot(): SessionEventWindow { return this.snapshot }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.window = leaf(entries)
    this.publish(hasMore, { kind: 'replace', entries })
  }
  prepend(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.window = concat(leaf(entries), this.window)
    this.publish(hasMore, { kind: 'prepend', entries })
  }
  append(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    if (!entries.length) {
      if (hasMore !== this.snapshot.hasMore) this.publish(hasMore, { kind: 'append', entries: [] })
      return
    }
    this.window = concat(this.window, leaf(entries))
    this.publish(hasMore, { kind: 'append', entries })
  }

  private publish(hasMore: boolean, change: SessionEventWindow['change']): void {
    this.snapshot = snapshotOf(this.window, hasMore, this.snapshot.revision + 1, change)
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { console.error('[hapi-dsh] source event subscriber failed:', error) }
    }
  }
}

/** Publish through a HAPI-shaped persistent event window so a prepend retains its pages.
 * Unchanged resident entry identities distinguish paging from a real rebase. */
export class SourceEventFeed implements SessionEventSource {
  private readonly source = new PersistentSessionEventSource()

  getSnapshot(): SessionEventWindow { return this.source.getSnapshot() }
  subscribe(listener: () => void): () => void { return this.source.subscribe(listener) }

  /** Explicit source reset must remain observable even when the rows match. */
  replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    traceFeedChange('replace')
    this.source.replace(entries, hasMore)
  }

  /** Classify a projection commit and use the official append/prepend operations. */
  update(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    const previous = this.snapshot.entries
    const previousSet = new Set(previous)
    const nextPositions = new Map(entries.map((entry, index) => [entry, index]))
    const additions = entries.filter(entry => !previousSet.has(entry))
    let previousPosition = -1
    const preservesPreviousOrder = previous.every(entry => {
      const position = nextPositions.get(entry)
      if (position === undefined || position <= previousPosition) return false
      previousPosition = position
      return true
    })
    const onlyAddsRows = preservesPreviousOrder && previous.every(entry => nextPositions.has(entry))
      && nextPositions.size === entries.length && entries.length === previous.length + additions.length
    if (onlyAddsRows && additions.length === 0 && hasMore === this.snapshot.hasMore) {
      traceFeedChange('unchanged'); return
    }
    if (onlyAddsRows && additions.length === 0) {
      traceFeedChange('prepend')
      this.source.prepend([], hasMore)
    } else if (onlyAddsRows && hasMore === this.snapshot.hasMore && previous.every((entry, index) => entries[index] === entry)) {
      traceFeedChange('append')
      this.source.append(additions, hasMore)
    } else if (onlyAddsRows) {
      // A source page can add rows inside a turn that is already resident.
      // The conversation assembler sorts fresh entries by their stable event
      // sequence and incrementally refreshes affected contexts.
      traceFeedChange('prepend')
      this.source.prepend(additions, hasMore)
    } else { traceFeedChange('replace', () => feedMetrics(previous, entries)); this.source.replace(entries, hasMore) }
  }

  private get snapshot(): SessionEventWindow { return this.source.getSnapshot() }
}
