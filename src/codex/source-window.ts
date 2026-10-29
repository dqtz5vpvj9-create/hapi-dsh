/** Source-owned history cursors, navigation metadata and attachment grants.
 * Body projection is request-local; only the client assigns display coordinates.
 */
import type {
  SessionHistoryRecord, SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { HapiMessage, HapiMessagesPage, HapiTransport } from './contracts.js'
import { compareNativeMessages, envelopeFor, nativeExecutionFor, record } from './native.js'
import type { NativeForkBoundary } from './control-types.ts'
import { SourceWindowAttachments } from '../source-window-attachments.ts'
import { DISPLAY_SEQ_OFFSET } from '../shared/history-window.ts'
import type { ProjectionEventSource } from '../shared/projection-event-sink.ts'
import { toSourceFrames } from '../shared/source-frame-builder.ts'
import type { SourceFrame, SourceFrameBatch } from '../shared/source-frames.ts'

/** Leaves room below the live seed for every page of a long source history. */
export { DISPLAY_SEQ_OFFSET } from '../shared/history-window.ts'
/** Live displays start above every rendered source-history page. */
export const DISPLAY_TURN_BASE = 1_000_000

export interface SourcePosition { readonly at: number; readonly seq: number }
export interface HistoryWindowAnchor {
  readonly epoch: number
  readonly before: SourcePosition
  readonly firstTurn: number
  readonly hasOlder: boolean
  /** The oldest source row already present in the live seed. */
  readonly oldest?: { readonly id: string; readonly at: number; readonly seq: number }
  /** The seed begins in the middle of this source turn. */
  readonly partial?: boolean
  /** Compatibility name retained for persisted/older callers. */
  readonly omitTurnKey?: string
}

export interface RenderedHistoryPage {
  readonly events: readonly SessionEvent[]
  /** Source row captured when each event was emitted, including lifecycle events. */
  readonly eventSources?: ReadonlyMap<number, ProjectionEventSource>
  readonly lastTurn: number
  readonly sources: ReadonlyMap<string, number>
  readonly rewinds: ReadonlyMap<number, string>
  readonly forks: ReadonlyMap<string, NativeForkBoundary>
  /** First source row rendered for each detached display turn. */
  readonly turnAnchors?: ReadonlyMap<number, { readonly id: string; readonly at: number; readonly seq: number; readonly key: string | null }>
  /** Stable source step key mapped to this detached renderer's coordinates. */
  readonly stepAnchors?: ReadonlyMap<string, { readonly turn: number; readonly step: number }>
  /** Optional attachment conversion that must not delay transcript paging. */
  readonly resourceEnrichment?: Promise<RenderedHistoryPage>
}

/** Native Codex message ids carry their stable turn identity in part 2. */
export function outlineTurnKey(messageId: string): string {
  const parts = messageId.split(':')
  return parts[0] === 'native' && parts.length >= 3 ? parts[2]! : messageId
}

/** One lightweight source outline row, already capped by HAPI's own route. */
export interface SourceOutlineRow {
  readonly messageId: string
  readonly label: string
  readonly at: number
  readonly seq: number
  readonly createdAt: number
}
export interface SourceOutlinePage {
  readonly entries: readonly SourceOutlineRow[]
  readonly page: {
    readonly epoch: number
    readonly hasMore: boolean
    readonly beforeCursor: { readonly at: number; readonly seq: number } | null
    readonly complete?: boolean
    readonly reset?: boolean
    readonly indexing?: boolean
    readonly unreadable?: boolean
    readonly scannedThrough?: number
    readonly headSeq?: number
  }
}
export type SourceOutlineReader = (query: { limit?: number; beforeAt?: number; beforeSeq?: number; epoch?: number }) => Promise<SourceOutlinePage>
export interface SourceContextPage {
  readonly messages: readonly HapiMessage[]
  readonly page: { readonly beforeCursor: SourcePosition; readonly afterCursor: SourcePosition;
    readonly hasMoreBefore: boolean; readonly hasMoreAfter: boolean; readonly epoch: number; readonly reset: boolean }
}
export type SourceContextReader = (messageId: string, radius: number) => Promise<SourceContextPage>
export interface CanonicalOutlineEntry {
  readonly turn: number
  readonly seq: number
  readonly prompt: string
  readonly response: string
  readonly messageId: string
  readonly at: number
  readonly sourceSeq: number
}

interface CanonicalOutlineValue {
  entries: readonly CanonicalOutlineEntry[]
  seedIndex: number
  firstTurn: number
  epoch: number
  complete: boolean
  indexing: boolean
  unreadable: boolean
  scannedThrough?: number
  headSeq?: number
}
/** Progressive outline preview plus the cursor that reads the next older page. */
export interface CanonicalOutlinePageValue extends CanonicalOutlineValue {
  readonly cursor: { at: number; seq: number } | null
  readonly hasMore: boolean
  /** Pages already accumulated for this scan, not rows. */
  readonly pageSize: number
}
export interface SourceWindowPage {
  readonly records: readonly SessionHistoryRecord[]
  readonly frames: SourceFrame[]
  readonly hasMoreBefore: boolean
  readonly hasMoreAfter: boolean
  readonly before: SourcePosition | null
  readonly after: SourcePosition | null
  readonly epoch?: number
  readonly beforeMessageId?: string
  readonly afterMessageId?: string
  /** Internal background update; removed before the RPC response is serialized. */
  readonly resourceEnrichment?: Promise<SourceFrame[]>
}
type CachedSourcePage = Omit<SourceWindowPage, 'resourceEnrichment'>
type SourcePageCacheEntry = { owner: string; source: string; value: CachedSourcePage; bytes: number }

/** HAPI-shaped bounded LRU for already projected history pages. */
export class SourceHistoryPageCache {
  private readonly entries = new Map<string, SourcePageCacheEntry>()
  private readonly sourceBytes = new Map<string, number>()
  private total = 0
  constructor(private readonly limits = { totalBytes: 32 * 1024 * 1024, sourceBytes: 8 * 1024 * 1024, sources: 8 }) {}
  get bytes(): number { return this.total }
  private id(owner: string, key: string): string { return JSON.stringify([owner, key]) }
  get(owner: string, key: string): CachedSourcePage | undefined {
    const id = this.id(owner, key), entry = this.entries.get(id)
    if (!entry) return undefined
    this.entries.delete(id); this.entries.set(id, entry)
    return entry.value
  }
  set(owner: string, source: string, key: string, value: CachedSourcePage): void {
    const id = this.id(owner, key), previous = this.entries.get(id)
    if (previous) this.remove(id)
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (bytes > this.limits.sourceBytes) return
    this.entries.set(id, { owner, source, value, bytes }); this.total += bytes
    this.sourceBytes.set(source, (this.sourceBytes.get(source) ?? 0) + bytes)
    this.trim()
  }
  removeOwner(owner: string): void { for (const [id, entry] of this.entries) if (entry.owner === owner) this.remove(id) }
  clear(): void { this.entries.clear(); this.sourceBytes.clear(); this.total = 0 }
  private remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id); this.total -= entry.bytes
    const remaining = (this.sourceBytes.get(entry.source) ?? 0) - entry.bytes
    if (remaining <= 0) this.sourceBytes.delete(entry.source)
    else this.sourceBytes.set(entry.source, remaining)
  }
  private trim(): void {
    while (this.total > this.limits.totalBytes || [...this.sourceBytes.values()].some(size => size > this.limits.sourceBytes)
      || this.sourceBytes.size > this.limits.sources) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.remove(oldest)
    }
  }
}
interface SourceCursorPage {
  readonly messages: readonly HapiMessage[]
  readonly hasMore: boolean
  readonly next: SourcePosition | null
  readonly epoch?: number
  readonly reset?: boolean
}

/** A route seq is only an outline identity; event windows use their own range. */
export const OUTLINE_ROUTE_BASE = 2_000_000_000

/** The source-owned facts the history window needs from either Agent type. */
export interface HistoryWindowAgent {
  readonly id: SessionId
  readonly binding: { readonly hapiSessionId: string }
  historyWindowAnchor(): HistoryWindowAnchor | undefined
  /** Source identities already projected into the live seed, without I/O. */
  historyTurnAnchors?(): RenderedHistoryPage['turnAnchors']
  sourceFrameBaseline?(): SourceFrameBatch
  sourceHistoryVersion?(): number
  renderHistoryPage(rows: readonly HapiMessage[]): Promise<RenderedHistoryPage>
  publishHistoryPageEnrichment?(frames: readonly SourceFrame[]): void
}

export class SourceHistoryWindowError extends Error {
  override readonly name = 'SourceHistoryWindowError'
}

export function sourcePosition(row: HapiMessage): SourcePosition {
  return { at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0 }
}
export function compareSourcePositions(left: SourcePosition, right: SourcePosition): number {
  return left.at - right.at || left.seq - right.seq
}
export function isSourceTurnStart(row: HapiMessage): boolean {
  if (envelopeFor(row.content)?.role !== 'user' || row.invokedAt == null) return false
  const meta = record(envelopeFor(row.content)?.meta)
  return meta?.deliveryMode !== 'steer'
}
export function sourceTurnKey(row: HapiMessage): string | null {
  const envelope = envelopeFor(row.content), content = record(envelope?.content), data = record(content?.data)
  const meta = record(envelope?.meta)
  const execution = nativeExecutionFor(meta?.nativeExecution ?? data?.nativeExecution)
  return execution?.turnId ?? null
}

/** Keep one source row once, ordered by its original position. */
export function uniqueSourceRows(rows: readonly HapiMessage[]): HapiMessage[] {
  const byKey = new Map<string, HapiMessage>()
  for (const row of rows) {
    const previous = byKey.get(row.id)
    if (!previous || (row.invokedAt ?? 0) > (previous.invokedAt ?? 0)) byKey.set(row.id, row)
  }
  return [...byKey.values()].sort(compareNativeMessages)
}

const MAX_SOURCE_MAPPINGS = 20_000

export class SourceHistoryWindow {
  private readonly rewindsByMessageId = new Map<string, string>()
  private readonly forksByMessageId = new Map<string, NativeForkBoundary>()
  private readonly cursorAnchors = new Map<string, { id: string; at: number; seq: number }>()
  private snapshotEpoch: number | undefined
  private anchor: HistoryWindowAnchor | undefined
  private disposed = false
  /** Bounded grants for image refs this window actually served. */
  private attachmentIndex: SourceWindowAttachments
  private historyVersion: number | undefined
  private readonly pageCache: SourceHistoryPageCache
  get attachments(): SourceWindowAttachments { this.syncHistoryVersion(); return this.attachmentIndex }

  private outlineRead: Promise<CanonicalOutlineValue | undefined> | undefined
  private outlineValue: CanonicalOutlineValue | undefined
  private outlineAt = 0
  // Incremental outline accumulator. One page per call; the published preview
  // is recomputed from every page read so far, so the seed keeps one turn
  // number while older pages are prepended.
  private outlineRows = new Map<string, SourceOutlineRow>()
  private outlineCursor: { at: number; seq: number } | null = null
  private outlineEpoch: number | undefined
  private outlineComplete = false
  private outlineIndexing = false
  private outlineUnreadable = false
  private outlineScannedThrough: number | undefined
  private outlineHeadSeq: number | undefined
  private outlinePageCount = 0
  constructor(
    readonly agent: HistoryWindowAgent,
    _transport: HapiTransport,
    _budget?: undefined,
    private readonly readOutline?: SourceOutlineReader,
    private readonly readContext?: SourceContextReader,
    pageCache = new SourceHistoryPageCache(),
  ) {
    this.pageCache = pageCache
    this.attachmentIndex = new SourceWindowAttachments(agent.id, agent.binding.hapiSessionId)
    this.refreshAnchor()
  }

  /**
   * Lightweight source-wide outline mapped onto display turn coordinates.
   * Follow the source's real cursor to exhaustion. The requested 100 labels
   * are only a per-page ceiling; Native HAPI can return 31 source items.
   * Only labels accumulate here, never transcript bodies or rendered events.
   */
  async canonicalOutline(): Promise<CanonicalOutlineValue | undefined> {
    if (this.disposed) return undefined
    this.refreshAnchor()
    const anchor = this.anchor
    if (!anchor?.oldest || !this.readOutline) { this.outlineValue = undefined; return undefined }
    if (this.outlineRead) return this.outlineRead
    if (this.outlineComplete && Date.now() - this.outlineAt < 5_000) return this.outlineValue
    const historyVersion = this.syncHistoryVersion()
    const read = (async () => {
      // Compatibility entry point: a fresh full scan, one bounded page at a
      // time. Callers that need progressive availability use outlinePage().
      this.resetOutlineAccumulator()
      let pages = 0
      let last: CanonicalOutlinePageValue | undefined
      while (pages++ < 80) {
        last = await this.outlinePage({ limit: 100 })
        if (!last) return undefined
        this.assertHistoryVersion(historyVersion)
        if (this.outlineComplete || this.outlineIndexing || this.outlineUnreadable || !last.hasMore) break
      }
      // A provisional reply is returned but not published; the caller can see
      // indexing without replacing previously complete coordinates.
      if (!last) return this.outlineValue
      // A published preview keeps its identity so repeated callers reuse it.
      const published = this.outlineValue
      if (published && published.complete === last.complete && published.indexing === last.indexing
        && published.unreadable === last.unreadable && published.epoch === last.epoch
        && published.entries.length === last.entries.length) return published
      // Page geometry belongs to outlinePage; keep the canonical value shape.
      const { cursor: _cursor, hasMore: _hasMore, pageSize: _pageSize, ...value } = last
      return value
    })()
    this.outlineRead = read
    try { return await read } finally { if (this.outlineRead === read) this.outlineRead = undefined }
  }

  /** Start a new progressive scan; the published preview restarts from this page. */
  resetOutlineAccumulator(): void {
    this.outlineRows.clear()
    this.outlineCursor = null
    this.outlineEpoch = undefined
    this.outlineComplete = false
    this.outlineIndexing = false
    this.outlineUnreadable = false
    this.outlineScannedThrough = undefined
    this.outlineHeadSeq = undefined
    this.outlinePageCount = 0
  }

  /** Whether the accumulator already holds every source label. */
  get outlineSettled(): boolean {
    return this.outlineComplete || this.outlineIndexing || this.outlineUnreadable
  }

  /**
   * Read exactly one bounded outline page and republish the canonical preview.
   * The requested limit is a per-page ceiling (HAPI can return fewer rows).
   */
  async outlinePage(query: { limit?: number; beforeAt?: number; beforeSeq?: number; epoch?: number } = {}): Promise<CanonicalOutlinePageValue | undefined> {
    if (this.disposed) return undefined
    this.refreshAnchor()
    const anchor = this.anchor
    if (!anchor?.oldest || !this.readOutline) { this.outlineValue = undefined; return undefined }
    if (this.outlineSettled && Date.now() - this.outlineAt < 5_000) {
      return { ...(this.outlineValue ?? { entries: [], seedIndex: 0, firstTurn: anchor.firstTurn,
        epoch: this.outlineEpoch ?? anchor.epoch, complete: this.outlineComplete,
        indexing: this.outlineIndexing, unreadable: this.outlineUnreadable }),
        cursor: this.outlineCursor, hasMore: false, pageSize: this.outlinePageCount }
    }
    const request: { limit: number; beforeAt?: number; beforeSeq?: number; epoch?: number } = { limit: Math.max(1, Math.min(100, query.limit ?? 100)) }
    const explicitCursor = query.beforeAt !== undefined && query.beforeSeq !== undefined
      ? { at: query.beforeAt, seq: query.beforeSeq } : this.outlineCursor
    if (explicitCursor) { request.beforeAt = explicitCursor.at; request.beforeSeq = explicitCursor.seq }
    const requestEpoch = query.epoch ?? this.outlineEpoch
    if (requestEpoch !== undefined) request.epoch = requestEpoch
    const historyVersion = this.syncHistoryVersion()
    const value = await this.readOutline(request)
    if (this.disposed) return undefined
    this.assertHistoryVersion(historyVersion)
    this.observeSnapshotEpoch(value.page.epoch)
    if (value.page.reset || this.outlineEpoch !== undefined && value.page.epoch !== this.outlineEpoch) {
      this.invalidateSnapshot(this.outlineEpoch ?? value.page.epoch)
      throw new SourceHistoryWindowError('The source outline epoch changed while paging; retry the outline')
    }
    this.outlineEpoch = value.page.epoch
    for (const row of value.entries) {
      const key = outlineTurnKey(row.messageId)
      if (!this.outlineRows.has(key)) this.outlineRows.set(key, row)
    }
    this.outlineScannedThrough = value.page.scannedThrough
    this.outlineHeadSeq = value.page.headSeq
    this.outlineIndexing = value.page.indexing === true
      || this.outlineScannedThrough !== undefined && this.outlineHeadSeq !== undefined && this.outlineScannedThrough < this.outlineHeadSeq
    this.outlineUnreadable = value.page.unreadable === true
    this.outlinePageCount++
    const hasMore = value.page.hasMore && !this.outlineIndexing && !this.outlineUnreadable
    this.outlineComplete = !hasMore && value.page.complete !== false && !this.outlineIndexing && !this.outlineUnreadable
    if (hasMore) {
      const next = value.page.beforeCursor
      if (!next || this.outlineCursor && (next.at > this.outlineCursor.at || next.at === this.outlineCursor.at && next.seq >= this.outlineCursor.seq)) {
        throw new SourceHistoryWindowError('The source outline cursor did not advance while older labels remain')
      }
      this.outlineCursor = next
    } else this.outlineCursor = null
    return this.publishOutlinePreview(anchor, value.page.epoch, hasMore)
  }

  /** Recompute the canonical preview from every accumulated label. */
  private publishOutlinePreview(anchor: HistoryWindowAnchor, epoch: number, hasMore: boolean): CanonicalOutlinePageValue {
    const rows = [...this.outlineRows.values()].sort((left, right) => left.at - right.at || left.seq - right.seq)
    const grouped: SourceOutlineRow[] = []
    const seenTurns = new Set<string>()
    for (const row of rows) {
      const key = outlineTurnKey(row.messageId)
      if (seenTurns.has(key)) continue
      seenTurns.add(key)
      grouped.push(row)
    }
    const oldest = anchor.oldest!
    let seedIndex = grouped.findIndex(row => outlineTurnKey(row.messageId) === outlineTurnKey(oldest.id))
    if (seedIndex < 0) {
      for (let index = 0; index < grouped.length; index++) {
        const row = grouped[index]!
        if (row.at < oldest.at || row.at === oldest.at && row.seq <= oldest.seq) seedIndex = index
        else break
      }
    }
    if (seedIndex < 0) seedIndex = 0
    const entries = grouped.map((row, index): CanonicalOutlineEntry => ({
      turn: anchor.firstTurn + index - seedIndex,
      seq: OUTLINE_ROUTE_BASE + index,
      prompt: typeof row.label === 'string' ? row.label : '',
      response: '',
      messageId: row.messageId,
      at: row.at,
      sourceSeq: row.seq,
    }))
    const value: CanonicalOutlineValue = { entries, seedIndex, firstTurn: anchor.firstTurn, epoch,
      complete: this.outlineComplete, indexing: this.outlineIndexing, unreadable: this.outlineUnreadable,
      ...(this.outlineScannedThrough === undefined ? {} : { scannedThrough: this.outlineScannedThrough }),
      ...(this.outlineHeadSeq === undefined ? {} : { headSeq: this.outlineHeadSeq }) }
    if ((this.snapshotEpoch === undefined || value.epoch >= this.snapshotEpoch)
      && (value.complete || !this.outlineValue?.complete)) {
      this.outlineValue = value
      this.outlineAt = Date.now()
    }
    return { ...value, cursor: this.outlineCursor, hasMore, pageSize: this.outlinePageCount }
  }

  /** Pure source frames are independent of directory and display coordinates. */
  private sourcePage(rendered: RenderedHistoryPage, rows: readonly HapiMessage[], epoch: number | undefined): Pick<SourceWindowPage, 'records' | 'frames'> {
    if (!rendered.eventSources) throw new SourceHistoryWindowError('Source projection omitted event origins')
    this.observeSnapshotEpoch(epoch)
    const frames = toSourceFrames({ ...rendered, eventSources: rendered.eventSources })
    if (epoch !== undefined) for (const row of rows) this.rememberCursor(sourcePosition(row), row, epoch)
    for (const [messageId, boundary] of rendered.forks) this.forksByMessageId.set(messageId, boundary)
    for (const event of rendered.events) {
      const localId = rendered.rewinds.get(event.seq)
      if (localId && event.type === 'user/message') this.rewindsByMessageId.set(event.data.id, localId)
    }
    for (const mapping of [this.rewindsByMessageId, this.forksByMessageId]) {
      while (mapping.size > MAX_SOURCE_MAPPINGS) mapping.delete(mapping.keys().next().value!)
    }
    const records: SessionHistoryRecord[] = frames.map(frame => ({ type: 'event', event: frame.event as unknown as SessionWireEvent }))
    this.attachments.grant(records, epoch ?? this.anchor?.epoch)
    return { records: [], frames }
  }

  /** Keep message paging independent from optional resource bytes. */
  private pageBody(rendered: RenderedHistoryPage, rows: readonly HapiMessage[], epoch: number | undefined,
    historyVersion: number | undefined): Pick<SourceWindowPage, 'records' | 'frames' | 'resourceEnrichment'> {
    const body = this.sourcePage(rendered, rows, epoch)
    if (!rendered.resourceEnrichment) return body
    return { ...body, resourceEnrichment: rendered.resourceEnrichment.then(enriched => {
      this.assertHistoryVersion(historyVersion)
      const hydrated = this.sourcePage(enriched, rows, epoch)
      return hydrated.frames.map(frame => ({ ...frame, contentRevision: 1 }))
    }) }
  }

  sourceFrameBaseline(): SourceFrameBatch | undefined { return this.agent.sourceFrameBaseline?.() }

  grantSourceFrames(frames: readonly SourceFrame[], historyVersion?: number): void {
    this.syncHistoryVersion(historyVersion)
    this.refreshAnchor()
    if (historyVersion !== undefined && this.historyVersion !== historyVersion) return
    this.attachments.grant(frames.map(frame => ({ type: 'event', event: frame.event as unknown as SessionWireEvent })), this.epoch)
  }

  /** Canonical source outline for the official rail. */
  async outline(): Promise<readonly CanonicalOutlineEntry[] | undefined> {
    return (await this.canonicalOutline())?.entries
  }

  /**
   * Direct bounded context window at one source message. No intervening
   * transcript is read; the caller owns the returned records.
   * @param messageId - source outline/anchor message identity.
   * @param radius - HAPI context radius cap (1..99).
   * @param _startSeq - ignored compatibility input; source identity owns the page.
   * @param readContext - HAPI context route.
   */
  async windowAt(messageId: string, radius: number, _startSeq: number,
    readContext: SourceContextReader = this.readContext!,
  ): Promise<SourceWindowPage> {
    this.assertLive()
    const historyVersion = this.syncHistoryVersion()
    const context = await readContext(messageId, Math.max(1, Math.min(99, radius)))
    this.assertHistoryVersion(historyVersion)
    this.observeSnapshotEpoch(context.page.epoch)
    if (context.page.reset) {
      this.invalidateSnapshot(context.page.epoch)
      throw new SourceHistoryWindowError('The source context changed while reading; retry the message')
    }
    const rows = uniqueSourceRows(context.messages)
    if (!rows.length) return { records: [], frames: [], hasMoreBefore: false, hasMoreAfter: false, before: context.page.beforeCursor, after: context.page.afterCursor, epoch: context.page.epoch }
    this.rememberCursor(context.page.beforeCursor, rows[0]!, context.page.epoch)
    this.rememberCursor(context.page.afterCursor, rows[rows.length - 1]!, context.page.epoch)
    const rendered = await this.agent.renderHistoryPage(rows)
    this.assertHistoryVersion(historyVersion)
    const body = this.pageBody(rendered, rows, context.page.epoch, historyVersion)
    return { ...body, hasMoreBefore: context.page.hasMoreBefore,
      hasMoreAfter: context.page.hasMoreAfter, before: context.page.beforeCursor, after: context.page.afterCursor, epoch: context.page.epoch,
      beforeMessageId: rows[0]!.id, afterMessageId: rows[rows.length - 1]!.id }
  }

  /** Older contiguous page below an existing direct window. */
  async windowBefore(before: SourcePosition, _endSeq: number,
    readBefore: (before: SourcePosition, epoch?: number) => Promise<{ messages: readonly HapiMessage[]; hasMore: boolean; next: SourcePosition | null;
      epoch?: number; reset?: boolean }>,
    epoch?: number,
    cursorMessageId?: string,
    signal?: AbortSignal,
    limit?: number,
  ): Promise<SourceWindowPage> {
    this.assertLive()
    signal?.throwIfAborted()
    const historyVersion = this.syncHistoryVersion()
    const cacheKey = this.pageCacheKey('before', before, epoch, cursorMessageId, limit, historyVersion)
    const cached = this.pageCache.get(this.agent.binding.hapiSessionId, cacheKey)
    if (cached) { this.grantCachedPage(cached); return cached }
    const page = await this.readCursorPage(before, epoch, readBefore, cursorMessageId, signal)
    this.assertHistoryVersion(historyVersion)
    signal?.throwIfAborted()
    const rows = uniqueSourceRows(page.messages)
    if (page.next && rows.length && page.epoch !== undefined) this.rememberCursor(page.next, rows[0]!, page.epoch)
    const rendered = await this.agent.renderHistoryPage(rows)
    this.assertHistoryVersion(historyVersion)
    signal?.throwIfAborted()
    const body = this.pageBody(rendered, rows, page.epoch, historyVersion)
    // A prepended page cannot name the upper edge of the combined resident
    // interval; report that honestly instead of a cursor that cannot route.
    const result = { ...body, hasMoreBefore: page.hasMore, hasMoreAfter: false, before: page.next, after: null,
      ...(page.epoch === undefined ? {} : { epoch: page.epoch }),
      ...(rows[0] ? { beforeMessageId: rows[0].id } : {}) }
    this.rememberPage(cacheKey, result)
    return result
  }

  /** Newer contiguous page above an existing direct window. */
  async windowAfter(after: SourcePosition, _startSeq: number,
    readAfter: (after: SourcePosition, epoch?: number) => Promise<{ messages: readonly HapiMessage[]; hasMore: boolean; next: SourcePosition | null;
      epoch?: number; reset?: boolean }>,
    epoch?: number,
    cursorMessageId?: string,
    signal?: AbortSignal,
    limit?: number,
  ): Promise<SourceWindowPage> {
    this.assertLive()
    signal?.throwIfAborted()
    const historyVersion = this.syncHistoryVersion()
    const cacheKey = this.pageCacheKey('after', after, epoch, cursorMessageId, limit, historyVersion)
    const cached = this.pageCache.get(this.agent.binding.hapiSessionId, cacheKey)
    if (cached) { this.grantCachedPage(cached); return cached }
    const page = await this.readCursorPage(after, epoch, readAfter, cursorMessageId, signal)
    this.assertHistoryVersion(historyVersion)
    signal?.throwIfAborted()
    const rows = uniqueSourceRows(page.messages)
    if (page.next && rows.length && page.epoch !== undefined) this.rememberCursor(page.next, rows[rows.length - 1]!, page.epoch)
    const rendered = await this.agent.renderHistoryPage(rows)
    this.assertHistoryVersion(historyVersion)
    signal?.throwIfAborted()
    const body = this.pageBody(rendered, rows, page.epoch, historyVersion)
    const result = { ...body, hasMoreBefore: true, hasMoreAfter: page.hasMore,
      before: null, after: page.next, ...(page.epoch === undefined ? {} : { epoch: page.epoch }),
      ...(rows.length ? { afterMessageId: rows[rows.length - 1]!.id } : {}) }
    this.rememberPage(cacheKey, result)
    return result
  }

  /** Older page below the seed's oldest resident source row. */
  async windowOldest(endSeq: number,
    readBefore: (before: SourcePosition, epoch?: number) => Promise<{ messages: readonly HapiMessage[]; hasMore: boolean; next: SourcePosition | null;
      epoch?: number; reset?: boolean }>,
    signal?: AbortSignal, limit?: number,
  ): Promise<SourceWindowPage> {
    signal?.throwIfAborted()
    this.refreshAnchor()
    // The tail reader's authoritative `before` cursor is always a valid HAPI
    // position. A viewport row may have no source seq (compaction/system rows),
    // so never pass a synthetic zero to the strict before route.
    const before = this.anchor?.before ?? this.anchor?.oldest
    if (!before) return { records: [], frames: [], hasMoreBefore: false, hasMoreAfter: true, before: null, after: null }
    if (this.anchor?.oldest) this.rememberCursor(before, this.anchor.oldest, this.anchor.epoch)
    return this.windowBefore({ at: before.at, seq: before.seq }, endSeq, readBefore, this.anchor?.epoch, undefined, signal, limit)
  }

  private pageCacheKey(direction: 'before' | 'after', cursor: SourcePosition, epoch: number | undefined,
    cursorMessageId: string | undefined, limit: number | undefined, historyVersion: number | undefined): string {
    return JSON.stringify([direction, this.agent.binding.hapiSessionId, epoch ?? this.anchor?.epoch,
      historyVersion, cursor.at, cursor.seq, cursorMessageId, limit ?? null])
  }

  private rememberPage(key: string, page: SourceWindowPage): void {
    const { resourceEnrichment: _resourceEnrichment, ...cached } = page
    this.pageCache.set(this.agent.binding.hapiSessionId, this.agent.binding.hapiSessionId, key, cached)
  }

  private grantCachedPage(page: CachedSourcePage): void {
    const epoch = page.epoch ?? this.anchor?.epoch
    this.attachments.grant(page.frames.map(frame => ({ type: 'event' as const,
      event: frame.event as unknown as SessionWireEvent })), epoch)
  }

  private rememberCursor(cursor: SourcePosition, row: HapiMessage | NonNullable<HistoryWindowAnchor['oldest']>, epoch: number): void {
    const position = 'at' in row ? row : sourcePosition(row)
    const key = `${epoch}:${cursor.at}:${cursor.seq}`
    this.cursorAnchors.delete(key)
    this.cursorAnchors.set(key, { id: row.id, at: position.at, seq: position.seq })
    while (this.cursorAnchors.size > MAX_SOURCE_MAPPINGS) this.cursorAnchors.delete(this.cursorAnchors.keys().next().value!)
  }

  observeSnapshotEpoch(epoch: number | undefined): void {
    if (epoch === undefined) return
    const previous = this.snapshotEpoch ?? this.attachments.epoch ?? this.anchor?.epoch
    // Native revisions and stored-Hub epochs advance monotonically within one
    // source identity. A late older response cannot restore revoked grants.
    if (previous !== undefined && epoch <= previous) return
    if (previous !== undefined) {
      this.pageCache.removeOwner(this.agent.binding.hapiSessionId)
      this.attachments.clear('source-snapshot-changed')
      this.outlineAt = 0
      this.rewindsByMessageId.clear()
      this.forksByMessageId.clear()
    }
    this.snapshotEpoch = epoch
  }

  invalidateSnapshot(epoch: number | undefined): void {
    if (epoch !== undefined && this.attachments.epoch === epoch) this.attachments.clear('source-snapshot-changed')
  }

  /** A reset invalidates a cursor snapshot, not the native execution owner.
   * Reuse it only after its stable source row proves the coordinates survived. */
  private async readCursorPage(position: SourcePosition, epoch: number | undefined,
    read: (position: SourcePosition, epoch?: number, signal?: AbortSignal) => Promise<SourceCursorPage>,
    cursorMessageId?: string, signal?: AbortSignal): Promise<SourceCursorPage> {
    const expected = epoch ?? this.anchor?.epoch
    signal?.throwIfAborted()
    let page = await read(position, expected, signal)
    signal?.throwIfAborted()
    this.assertLive()
    this.observeSnapshotEpoch(page.epoch)
    const changed = (value: SourceCursorPage, expectedEpoch: number | undefined): boolean => value.reset === true
      || value.epoch !== undefined && expectedEpoch !== undefined && value.epoch !== expectedEpoch
    if (!changed(page, expected)) return page
    this.invalidateSnapshot(expected)
    const anchor = this.cursorAnchors.get(`${expected}:${position.at}:${position.seq}`)
      ?? (cursorMessageId ? { id: cursorMessageId, ...position } : undefined)
    if (!anchor || !this.readContext) {
      throw new SourceHistoryWindowError('The source cursor snapshot expired; select the message again')
    }
    const context = await this.readContext(anchor.id, 1)
    this.assertLive()
    this.observeSnapshotEpoch(context.page.epoch)
    const current = context.messages.find(row => row.id === anchor.id)
    if (context.page.reset || !current || compareSourcePositions(sourcePosition(current), anchor) !== 0) {
      throw new SourceHistoryWindowError('The source cursor moved or was removed; select the message again')
    }
    // Exactly one recovery attempt. Never append a response that was obtained
    // using coordinates invalidated again during this bounded read.
    page = await read(position, context.page.epoch, signal)
    signal?.throwIfAborted()
    this.assertLive()
    this.observeSnapshotEpoch(page.epoch)
    if (changed(page, context.page.epoch)) {
      this.invalidateSnapshot(context.page.epoch)
      throw new SourceHistoryWindowError('The source changed again while paging; retry the page')
    }
    this.rememberCursor(position, current, context.page.epoch)
    return page
  }

  /** Bytes retained by the shared bounded source-page cache. */
  get cacheBytes(): number { return this.pageCache.bytes }
  get attachmentBytes(): number { return this.attachments.bytes }
  get retainedBytes(): number { return this.attachments.bytes }
  get epoch(): number | undefined { this.refreshAnchor(); return this.snapshotEpoch ?? this.anchor?.epoch }
  get mappingCount(): number { return this.rewindsByMessageId.size + this.forksByMessageId.size }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.attachments.dispose('window-disposed')
    this.rewindsByMessageId.clear(); this.forksByMessageId.clear()
    this.cursorAnchors.clear()
    this.resetOutlineAccumulator()
    this.outlineRead = undefined
    this.outlineValue = undefined
    this.outlineAt = 0
  }

  private assertLive(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.disposed) throw new SourceHistoryWindowError('The source history window was released')
  }

  private syncHistoryVersion(version = this.agent.sourceHistoryVersion?.()): number | undefined {
    if (version === undefined || this.historyVersion !== undefined && version <= this.historyVersion) return this.historyVersion
    if (this.historyVersion !== undefined) {
      this.pageCache.removeOwner(this.agent.binding.hapiSessionId)
      // A rewrite can keep the HAPI epoch. Retire the old grant owner so an
      // in-flight byte read cannot survive while fresh content can be granted.
      this.attachmentIndex.dispose('source-history-rewritten')
      this.attachmentIndex = new SourceWindowAttachments(this.agent.id, this.agent.binding.hapiSessionId)
      this.rewindsByMessageId.clear(); this.forksByMessageId.clear(); this.cursorAnchors.clear()
      this.resetOutlineAccumulator(); this.outlineValue = undefined; this.outlineAt = 0; this.outlineRead = undefined
    }
    this.historyVersion = version
    return version
  }

  private assertHistoryVersion(version: number | undefined): void {
    this.assertLive()
    if (this.syncHistoryVersion() !== version) throw new SourceHistoryWindowError('The source history changed while reading; retry the page')
  }

  private refreshAnchor(): void {
    this.syncHistoryVersion()
    const anchor = this.agent.historyWindowAnchor()
    if (!anchor) return
    if (this.anchor?.epoch === anchor.epoch && this.anchor.oldest?.id === anchor.oldest?.id) return
    this.observeSnapshotEpoch(anchor.epoch)
    this.anchor = anchor
    if (anchor.oldest) this.rememberCursor(anchor.before, anchor.oldest, anchor.epoch)
  }

  get offset(): number { return DISPLAY_SEQ_OFFSET }
  get bound(): boolean { this.refreshAnchor(); return this.anchor !== undefined }
  hasOlder(): boolean { this.refreshAnchor(); return this.anchor?.hasOlder === true }
  get oldest(): HistoryWindowAnchor['oldest'] { this.refreshAnchor(); return this.anchor?.oldest }
  get partial(): boolean { this.refreshAnchor(); return this.anchor?.partial === true }
  resolveRewindMessage(messageId: string): string | undefined { this.syncHistoryVersion(); return this.rewindsByMessageId.get(messageId) }
  resolveFork(messageId: string): NativeForkBoundary | undefined { this.syncHistoryVersion(); return this.forksByMessageId.get(messageId) }

}

/** Count imported pages only as diagnostics; no source body is retained here. */
export function historyWindowNumbers(window: SourceHistoryWindow): { bound: boolean; hasOlder: boolean } {
  return { bound: window.bound, hasOlder: window.hasOlder() }
}


/** Process-wide bounded registry; display retirement drops source/agent refs. */
export class DisplayHistoryWindows {
  private readonly windows = new Map<string, SourceHistoryWindow>()
  private readonly pageCache = new SourceHistoryPageCache()

  get size(): number { return this.windows.size }
  get bytes(): number { return this.pageCache.bytes }
  window(displayId: string, agent: HistoryWindowAgent, transport: HapiTransport, readOutline?: SourceOutlineReader, readContext?: SourceContextReader): SourceHistoryWindow {
    const existing = this.windows.get(displayId)
    if (existing && existing.agent === agent) return existing
    if (existing) this.retire(displayId)
    const value = new SourceHistoryWindow(agent, transport, undefined, readOutline, readContext, this.pageCache)
    this.windows.set(displayId, value)
    this.pruneWindowOrder()
    return value
  }
  peek(displayId: string): SourceHistoryWindow | undefined { return this.windows.get(displayId) }
  retire(displayId: string): void {
    const window = this.windows.get(displayId)
    if (!window) return
    window.dispose(); this.windows.delete(displayId)
  }
  retireSource(sourceId: string): void {
    for (const [id, window] of this.windows) if (window.agent.binding.hapiSessionId === sourceId) this.retire(id)
  }
  prune(valid: (displayId: string) => boolean): void {
    for (const id of [...this.windows.keys()]) if (!valid(id)) this.retire(id)
  }
  clear(): void { for (const id of [...this.windows.keys()]) this.retire(id); this.pageCache.clear() }
  private pruneWindowOrder(): void {
    while (this.windows.size > 12) {
      const oldest = this.windows.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.retire(oldest)
    }
  }
}
