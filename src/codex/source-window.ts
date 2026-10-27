/**
 * A display-side history window over an original HAPI Session.
 *
 * The official Session keeps only the bounded opening seed. This adapter
 * serves older DSH event pages from the original source cursors on demand and
 * maps their sequence/turn coordinates into the same wire journal, so the
 * official Conversation can prepend history without replacing the display
 * Session, its editor, or its operation owner.
 */
import type {
  SessionFollowFrame, SessionHistoryRecord, SessionPage, SessionPageRequest, SessionProjectionBaseline,
  SessionProjectionValues, SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { HapiMessage, HapiMessagesPage, HapiTransport } from './contracts.js'
import { compareNativeMessages, envelopeFor, nativeExecutionFor, record } from './native.js'
import type { NativeForkBoundary } from './control-types.ts'
import { SourceWindowAttachments } from '../source-window-attachments.ts'
import { DISPLAY_SEQ_OFFSET } from '../shared/history-window.ts'

/** Leaves room below the live seed for every page of a long source history. */
export { DISPLAY_SEQ_OFFSET } from '../shared/history-window.ts'
/** Live displays start above every rendered source-history page. */
export const DISPLAY_TURN_BASE = 1_000_000
/** Detached source steps cannot collide with the original seed's local steps. */
export const SOURCE_WINDOW_STEP_BASE = 1_000_000_000

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
  readonly lastTurn: number
  readonly sources: ReadonlyMap<string, number>
  readonly rewinds: ReadonlyMap<number, string>
  readonly forks: ReadonlyMap<string, NativeForkBoundary>
  /** First source row rendered for each detached display turn. */
  readonly turnAnchors?: ReadonlyMap<number, { readonly id: string; readonly at: number; readonly seq: number; readonly key: string | null }>
  /** Stable source step key mapped to this detached renderer's coordinates. */
  readonly stepAnchors?: ReadonlyMap<string, { readonly turn: number; readonly step: number }>
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
  readonly hasMoreBefore: boolean
  readonly hasMoreAfter: boolean
  readonly before: SourcePosition | null
  readonly after: SourcePosition | null
  readonly epoch?: number
  readonly beforeMessageId?: string
  readonly afterMessageId?: string
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
  renderHistoryPage(rows: readonly HapiMessage[]): Promise<RenderedHistoryPage>
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

function pluginSurfaceSeq(type: string): boolean {
  return type === 'plugin:hapi-dsh/native-item' || type === 'plugin:hapi-dsh/notify-summary'
    || type === 'plugin:hapi-dsh/codex-review' || type === 'plugin:hapi-dsh/generated-media'
    || type === 'plugin:hapi-dsh-observed/item'
}

/** Translate one durable display event into the virtual journal coordinates. */
export function wireEvent(event: SessionEvent, offset = DISPLAY_SEQ_OFFSET): SessionWireEvent {
  const data = event.data as Record<string, unknown> | null
  let nextData = data
  if (data && pluginSurfaceSeq(event.type) && typeof data.surfaceSeq === 'number') {
    nextData = { ...data, surfaceSeq: data.surfaceSeq + offset }
  }
  const sourceEventSeqs = event.sourceEventSeqs?.map(seq => seq + offset)
  const surfaceOp = typeof event.surfaceOp === 'object' && event.surfaceOp !== null
    ? { ...event.surfaceOp, startSeq: event.surfaceOp.startSeq + offset, endSeq: event.surfaceOp.endSeq + offset }
    : event.surfaceOp
  return {
    type: event.type, seq: event.seq + offset, time: event.time, data: nextData as never,
    ...(event.ignorable === true ? { ignorable: true as const } : {}),
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  }
}

/** Apply the virtual sequence range to a rendered detached history page. */
export function wireRenderedEvent(event: SessionEvent, localSeq: number, start: number): SessionWireEvent {
  const shifted = { ...event, seq: localSeq }
  return wireEvent(shifted as SessionEvent, start)
}

function shiftTurnValue(value: unknown, delta: number): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const recordValue = value as Record<string, unknown>
  let next: Record<string, unknown> | undefined
  for (const key of ['turn', 'displayTurn']) {
    if (typeof recordValue[key] === 'number') {
      next ??= { ...recordValue }
      next[key] = (recordValue[key] as number) + delta
    }
  }
  return next
}

/** History pages render from 1; move their turn coordinates under the live seed. */
export function shiftEventTurns(event: SessionEvent, delta: number): SessionEvent {
  if (delta === 0) return event
  const data = event.data as Record<string, unknown> | null
  const shifted = shiftTurnValue(data, delta)
  return shifted ? { ...event, data: shifted as never } : event
}

export function wireRecord(event: SessionEvent, localSeq: number, start: number): SessionHistoryRecord {
  return { type: 'event', event: wireRenderedEvent(event, localSeq, start) }
}

function wireAssistantStream(frame: NonNullable<Extract<SessionFollowFrame, { type: 'snapshot' }>['assistantStream']>, offset: number): NonNullable<Extract<SessionFollowFrame, { type: 'snapshot' }>['assistantStream']> {
  const attempt = frame.activeAttempt
  return {
    ...frame,
    ...(attempt === undefined ? {} : { activeAttempt: {
      ...attempt,
      startedAfterSeq: (attempt.startedAfterSeq === -1 ? -1 : attempt.startedAfterSeq + offset) as typeof attempt.startedAfterSeq,
    } }),
  }
}

export function translateProjectionValues(values: SessionProjectionValues, offset = DISPLAY_SEQ_OFFSET): SessionProjectionValues {
  const outline = values.turnOutline
  if (!Array.isArray(outline)) return values
  return { ...values, turnOutline: outline.map(entry => entry && typeof entry === 'object' && typeof (entry as { seq?: unknown }).seq === 'number'
    ? { ...entry, seq: (entry as { seq: number }).seq + offset } : entry) } as unknown as SessionProjectionValues
}

export function translateProjectionBaseline(baseline: SessionProjectionBaseline, offset = DISPLAY_SEQ_OFFSET): SessionProjectionBaseline {
  return { asOfSeq: baseline.asOfSeq < 0 ? -1 : baseline.asOfSeq + offset, values: translateProjectionValues(baseline.values, offset) }
}

export function translateFollowFrame(frame: SessionFollowFrame, offset = DISPLAY_SEQ_OFFSET): SessionFollowFrame {
  if (frame.type === 'snapshot') return {
    ...frame,
    cursor: frame.cursor + offset,
    records: frame.records.map(entry => ({ type: 'event', event: wireEvent(entry.event as unknown as SessionEvent, offset) })),
    projections: translateProjectionBaseline(frame.projections, offset),
    ...(frame.assistantStream === undefined ? {} : { assistantStream: wireAssistantStream(frame.assistantStream, offset) }),
  }
  if (frame.type === 'event') return { type: 'event', event: wireEvent(frame.event as unknown as SessionEvent, offset) }
  const assistant = frame.frame
  if (assistant.type !== 'start' && assistant.type !== 'chunk') {
    if (assistant.type === 'end' && assistant.outcome.kind === 'committed') {
      return { ...frame, frame: { ...assistant, outcome: { ...assistant.outcome, seq: assistant.outcome.seq + offset } } }
    }
    return frame
  }
  if (assistant.type === 'start') return { ...frame, frame: { ...assistant,
    startedAfterSeq: (assistant.startedAfterSeq === -1 ? -1 : assistant.startedAfterSeq + offset) as typeof assistant.startedAfterSeq } }
  return frame
}

interface Descriptor {
  readonly end: number
  before: SourcePosition
  turnTop: number
  hasOlder: boolean
  epoch?: number
  records?: { readonly rows: readonly SessionHistoryRecord[]; readonly bytes: number; readonly sources: ReadonlyMap<string, number>;
    readonly rewinds: ReadonlyMap<number, string>; readonly forks: ReadonlyMap<string, NativeForkBoundary> }
}

const MAX_FETCH_PAGES = 80
const MAX_PAGE_ROWS = 400
const MAX_GIANT_ROWS = 2_000
const PAGE_CACHE_BYTES = 8 * 1024 * 1024
const MAX_SOURCE_MAPPINGS = 20_000
const MAX_DESCRIPTORS = 4_096

export class SourceHistoryWindow {
  private readonly descriptors = new Map<number, Descriptor>()
  private readonly cache = new Map<number, Descriptor & { records: NonNullable<Descriptor['records']> }>()
  private readonly sourceSeq = new Map<number, string>()
  private readonly sourceVSeq = new Map<string, number>()
  private readonly rewindsBySeq = new Map<number, string>()
  private readonly forksByMessageId = new Map<string, NativeForkBoundary>()
  private readonly sourceSteps = new Map<string, number>()
  private readonly cursorAnchors = new Map<string, { id: string; at: number; seq: number }>()
  private snapshotEpoch: number | undefined
  private nextSourceStep = SOURCE_WINDOW_STEP_BASE
  private byteTotal = 0
  private work: Promise<unknown> = Promise.resolve()
  private anchor: HistoryWindowAnchor | undefined
  private disposed = false
  /** Bounded grants for image refs this window actually served. */
  readonly attachments: SourceWindowAttachments
  private oldestKey = DISPLAY_SEQ_OFFSET

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
    private readonly transport: HapiTransport,
    private readonly budget?: { added(window: SourceHistoryWindow, bytes: number): void; removed(window: SourceHistoryWindow, bytes: number): void },
    private readonly readOutline?: SourceOutlineReader,
    private readonly readContext?: SourceContextReader,
  ) {
    this.attachments = new SourceWindowAttachments(agent.id, agent.binding.hapiSessionId)
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
    const read = (async () => {
      // Compatibility entry point: a fresh full scan, one bounded page at a
      // time. Callers that need progressive availability use outlinePage().
      this.resetOutlineAccumulator()
      let pages = 0
      let last: CanonicalOutlinePageValue | undefined
      while (pages++ < 80) {
        last = await this.outlinePage({ limit: 100 })
        if (!last) return undefined
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
    const value = await this.readOutline(request)
    if (this.disposed) return undefined
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

  private canonicalTurn(at: number, seq: number, key?: string | null): number | undefined {
    const outline = this.outlineValue
    if (!outline) return undefined
    // A native turn's first body row may precede its directory label. Its stable
    // identity still names that turn; position alone would select the prior one.
    if (key != null) {
      const entry = outline.entries.find(row => outlineTurnKey(row.messageId) === key)
      if (entry) return entry.turn
    }
    let found = -1
    for (let index = 0; index < outline.entries.length; index++) {
      const row = outline.entries[index]!
      if (row.at < at || row.at === at && row.sourceSeq <= seq) found = index
      else break
    }
    return found < 0 ? undefined : outline.firstTurn + found - outline.seedIndex
  }

  private remapTurns(rendered: RenderedHistoryPage, start: number, rows?: readonly HapiMessage[], epoch?: number, turnDelta = 0): SessionHistoryRecord[] {
    if (rows && epoch !== undefined) for (const row of rows) this.rememberCursor(sourcePosition(row), row, epoch)
    const seqs = new Map(rendered.events.map((event, index) => [Number(event.seq), start + index]))
    const byLocal = new Map<number, { messageId: string; at: number; seq: number }>()
    if (rows) {
      const byId = new Map(rows.map(row => [row.id, row]))
      for (const [rowId, localSeq] of rendered.sources) {
        const row = byId.get(rowId)
        if (!row) continue
        byLocal.set(localSeq, { messageId: rowId, at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0 })
      }
    }
    let currentSource: { messageId: string; at: number; seq: number } | undefined
    if (rows?.length) currentSource = { messageId: rows[0]!.id, at: rows[0]!.invokedAt ?? rows[0]!.createdAt, seq: rows[0]!.seq ?? 0 }
    const turns = new Map<number, number>()
    for (const [turn, anchor] of rendered.turnAnchors ?? []) {
      const canonical = this.canonicalTurn(anchor.at, anchor.seq, anchor.key)
      if (canonical !== undefined) turns.set(turn, canonical)
    }
    const steps = new Map<string, number>()
    for (const [key, local] of rendered.stepAnchors ?? []) {
      const step = this.sourceSteps.get(key) ?? ++this.nextSourceStep
      this.sourceSteps.delete(key)
      this.sourceSteps.set(key, step)
      steps.set(`${local.turn}:${local.step}`, step)
    }
    for (const [rowId, local] of rendered.sources) {
      const virtual = seqs.get(local)
      if (virtual === undefined) continue
      const previous = this.sourceSeq.get(virtual)
      if (previous !== undefined && previous !== rowId && this.sourceVSeq.get(previous) === virtual) this.sourceVSeq.delete(previous)
      this.sourceSeq.set(virtual, rowId)
      this.sourceVSeq.set(rowId, virtual)
    }
    for (const [local, localId] of rendered.rewinds) {
      const virtual = seqs.get(local)
      if (virtual !== undefined) this.rewindsBySeq.set(virtual, localId)
    }
    for (const [messageId, boundary] of rendered.forks) this.forksByMessageId.set(messageId, boundary)
    this.trimMappings()
    const records = rendered.events.map((event, index) => {
      const localSeq = rendered.events[index]!.seq
      const source = byLocal.get(localSeq) ?? currentSource
      if (source) currentSource = source
      const data = event.data as Record<string, unknown> | null
      let next = event
      if (data) {
        let changed: Record<string, unknown> | undefined
        for (const key of ['turn', 'displayTurn'] as const) {
          const value = data[key]
          if (typeof value === 'number' && (turns.has(value) || turnDelta !== 0)) {
            changed ??= { ...data }
            changed[key] = turns.get(value) ?? value + turnDelta
          }
        }
        for (const [turnKey, stepKey] of [['turn', 'step'], ['displayTurn', 'displayStep']] as const) {
          if (typeof data[turnKey] !== 'number' || typeof data[stepKey] !== 'number') continue
          const step = steps.get(`${data[turnKey]}:${data[stepKey]}`)
          if (step === undefined) continue
          changed ??= { ...data }
          changed[stepKey] = step
        }
        if (changed) next = { ...event, data: changed as never }
      }
      const nextData = next.data as Record<string, unknown> | null
      const sourceEventSeqs = next.sourceEventSeqs?.map(seq => seqs.get(seq) ?? seq)
      const surfaceOp = typeof next.surfaceOp === 'object' && next.surfaceOp !== null
        ? { ...next.surfaceOp, startSeq: seqs.get(next.surfaceOp.startSeq) ?? next.surfaceOp.startSeq,
          endSeq: seqs.get(next.surfaceOp.endSeq) ?? next.surfaceOp.endSeq }
        : next.surfaceOp
      return { type: 'event' as const, event: { ...next, seq: start + index,
        ...(nextData && typeof nextData.surfaceSeq === 'number'
          ? { data: { ...nextData, surfaceSeq: seqs.get(nextData.surfaceSeq) ?? nextData.surfaceSeq } } : {}),
        ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
        ...(surfaceOp === undefined ? {} : { surfaceOp }),
      } as SessionEvent,
        ...(source ? { source: { ...source, ...(epoch === undefined ? {} : { epoch }) } } : {}) } as unknown as SessionHistoryRecord
    })
    // Authorization is scoped to the exact refs this display's page presents.
    this.refreshAnchor()
    this.observeSnapshotEpoch(epoch)
    this.attachments.grant(records, epoch ?? this.anchor?.epoch)
    return records
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
   * @param startSeq - first display seq assigned to this window.
   * @param readContext - HAPI context route.
   */
  async windowAt(messageId: string, radius: number, startSeq: number,
    readContext: SourceContextReader = this.readContext!,
  ): Promise<SourceWindowPage> {
    this.assertLive()
    // Turn mapping uses whatever pages are published; a direct window read
    // primes at most one page instead of waiting for a full directory scan.
    await this.primeOutlineForMapping()
    this.assertLive()
    const context = await readContext(messageId, Math.max(1, Math.min(99, radius)))
    this.assertLive()
    this.observeSnapshotEpoch(context.page.epoch)
    if (context.page.reset) {
      this.invalidateSnapshot(context.page.epoch)
      throw new SourceHistoryWindowError('The source context changed while reading; retry the message')
    }
    const rows = uniqueSourceRows(context.messages)
    if (!rows.length) return { records: [], hasMoreBefore: false, hasMoreAfter: false, before: context.page.beforeCursor, after: context.page.afterCursor, epoch: context.page.epoch }
    this.rememberCursor(context.page.beforeCursor, rows[0]!, context.page.epoch)
    this.rememberCursor(context.page.afterCursor, rows[rows.length - 1]!, context.page.epoch)
    const rendered = await this.agent.renderHistoryPage(rows)
    this.assertLive()
    return { records: this.remapTurns(rendered, startSeq, rows, context.page.epoch), hasMoreBefore: context.page.hasMoreBefore,
      hasMoreAfter: context.page.hasMoreAfter, before: context.page.beforeCursor, after: context.page.afterCursor, epoch: context.page.epoch,
      beforeMessageId: rows[0]!.id, afterMessageId: rows[rows.length - 1]!.id }
  }

  /** Older contiguous page below an existing direct window. */
  /** One bounded page, only when a window read has no turn map at all. */
  private async primeOutlineForMapping(): Promise<void> {
    if (this.outlineValue || this.outlineSettled || this.disposed) return
    try { await this.outlinePage({ limit: 100 }) } catch { /* mapping stays native */ }
  }

  async windowBefore(before: SourcePosition, endSeq: number,
    readBefore: (before: SourcePosition, epoch?: number) => Promise<{ messages: readonly HapiMessage[]; hasMore: boolean; next: SourcePosition | null;
      epoch?: number; reset?: boolean }>,
    epoch?: number,
    cursorMessageId?: string,
  ): Promise<SourceWindowPage> {
    this.assertLive()
    await this.primeOutlineForMapping()
    this.assertLive()
    const page = await this.readCursorPage(before, epoch, readBefore, cursorMessageId)
    const rows = uniqueSourceRows(page.messages)
    if (page.next && rows.length && page.epoch !== undefined) this.rememberCursor(page.next, rows[0]!, page.epoch)
    const rendered = await this.agent.renderHistoryPage(rows)
    this.assertLive()
    const records = this.remapTurns(rendered, Math.max(1, endSeq - rendered.events.length), rows, page.epoch)
    // A prepended page cannot name the upper edge of the combined resident
    // interval; report that honestly instead of a cursor that cannot route.
    return { records, hasMoreBefore: page.hasMore, hasMoreAfter: false, before: page.next, after: null,
      ...(page.epoch === undefined ? {} : { epoch: page.epoch }),
      ...(rows[0] ? { beforeMessageId: rows[0].id } : {}) }
  }

  /** Newer contiguous page above an existing direct window. */
  async windowAfter(after: SourcePosition, startSeq: number,
    readAfter: (after: SourcePosition, epoch?: number) => Promise<{ messages: readonly HapiMessage[]; hasMore: boolean; next: SourcePosition | null;
      epoch?: number; reset?: boolean }>,
    epoch?: number,
    cursorMessageId?: string,
  ): Promise<SourceWindowPage> {
    this.assertLive()
    this.assertLive()
    const page = await this.readCursorPage(after, epoch, readAfter, cursorMessageId)
    const rows = uniqueSourceRows(page.messages)
    if (page.next && rows.length && page.epoch !== undefined) this.rememberCursor(page.next, rows[rows.length - 1]!, page.epoch)
    const rendered = await this.agent.renderHistoryPage(rows)
    this.assertLive()
    return { records: this.remapTurns(rendered, startSeq, rows, page.epoch), hasMoreBefore: true, hasMoreAfter: page.hasMore,
      before: null, after: page.next, ...(page.epoch === undefined ? {} : { epoch: page.epoch }),
      ...(rows.length ? { afterMessageId: rows[rows.length - 1]!.id } : {}) }
  }

  /** Older page below the seed's oldest resident source row. */
  async windowOldest(endSeq: number,
    readBefore: (before: SourcePosition, epoch?: number) => Promise<{ messages: readonly HapiMessage[]; hasMore: boolean; next: SourcePosition | null;
      epoch?: number; reset?: boolean }>,
  ): Promise<SourceWindowPage> {
    this.refreshAnchor()
    // The tail reader's authoritative `before` cursor is always a valid HAPI
    // position. A viewport row may have no source seq (compaction/system rows),
    // so never pass a synthetic zero to the strict before route.
    const before = this.anchor?.before ?? this.anchor?.oldest
    if (!before) return { records: [], hasMoreBefore: false, hasMoreAfter: true, before: null, after: null }
    if (this.anchor?.oldest) this.rememberCursor(before, this.anchor.oldest, this.anchor.epoch)
    return this.windowBefore({ at: before.at, seq: before.seq }, endSeq, readBefore, this.anchor?.epoch)
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
      this.attachments.clear('source-snapshot-changed')
      this.trimTo(0)
      this.outlineAt = 0
    }
    this.snapshotEpoch = epoch
  }

  invalidateSnapshot(epoch: number | undefined): void {
    if (epoch !== undefined && this.attachments.epoch === epoch) this.attachments.clear('source-snapshot-changed')
  }

  /** A reset invalidates a cursor snapshot, not the native execution owner.
   * Reuse it only after its stable source row proves the coordinates survived. */
  private async readCursorPage(position: SourcePosition, epoch: number | undefined,
    read: (position: SourcePosition, epoch?: number) => Promise<SourceCursorPage>, cursorMessageId?: string): Promise<SourceCursorPage> {
    const expected = epoch ?? this.anchor?.epoch
    let page = await read(position, expected)
    this.assertLive()
    this.observeSnapshotEpoch(page.epoch)
    const changed = (value: SourceCursorPage, expectedEpoch: number | undefined): boolean => value.reset === true
      || value.epoch !== undefined && expectedEpoch !== undefined && value.epoch !== expectedEpoch
    if (!changed(page, expected)) return page
    this.invalidateSnapshot(expected)
    this.trimTo(0)
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
    page = await read(position, context.page.epoch)
    this.assertLive()
    this.observeSnapshotEpoch(page.epoch)
    if (changed(page, context.page.epoch)) {
      this.invalidateSnapshot(context.page.epoch)
      throw new SourceHistoryWindowError('The source changed again while paging; retry the page')
    }
    this.rememberCursor(position, current, context.page.epoch)
    return page
  }

  get cacheBytes(): number { return this.byteTotal }
  /** Grant metadata only; image bytes remain owned by the official store. */
  get attachmentBytes(): number { return this.attachments.bytes }
  get retainedBytes(): number { return this.byteTotal + this.attachments.bytes }
  get epoch(): number | undefined { this.refreshAnchor(); return this.snapshotEpoch ?? this.anchor?.epoch }
  get mappingCount(): number { return this.sourceSeq.size + this.sourceVSeq.size + this.forksByMessageId.size + this.rewindsBySeq.size + this.sourceSteps.size }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.attachments.dispose('window-disposed')
    this.cache.clear(); this.descriptors.clear(); this.sourceSeq.clear(); this.sourceVSeq.clear()
    this.rewindsBySeq.clear(); this.forksByMessageId.clear()
    this.sourceSteps.clear()
    this.cursorAnchors.clear()
    this.outlineRead = undefined
    this.outlineValue = undefined
    this.outlineAt = 0
    this.byteTotal = 0
  }
  /** Remove oldest cached page bodies first; descriptors and tiny maps remain. */
  trimTo(bytes: number): void {
    let removed = 0
    while (this.byteTotal > bytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value as number
      const page = this.cache.get(oldest)
      if (!page) break
      this.cache.delete(oldest); this.byteTotal -= page.records.bytes; removed += page.records.bytes
    }
    if (removed) this.budget?.removed(this, removed)
  }

  private assertLive(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.disposed) throw new SourceHistoryWindowError('The source history window was released')
  }

  private refreshAnchor(): void {
    if (this.anchor) {
      this.observeSnapshotEpoch(this.agent.historyWindowAnchor()?.epoch)
      return
    }
    const anchor = this.agent.historyWindowAnchor()
    if (!anchor) return
    this.anchor = anchor
    this.observeSnapshotEpoch(anchor.epoch)
    if (anchor.oldest) this.rememberCursor(anchor.before, anchor.oldest, anchor.epoch)
    if (!this.descriptors.has(DISPLAY_SEQ_OFFSET)) this.descriptors.set(DISPLAY_SEQ_OFFSET, {
      end: DISPLAY_SEQ_OFFSET, before: anchor.before, turnTop: anchor.firstTurn - 1, hasOlder: anchor.hasOlder, epoch: anchor.epoch,
    })
  }

  get offset(): number { return DISPLAY_SEQ_OFFSET }
  get bound(): boolean { this.refreshAnchor(); return this.anchor !== undefined }
  hasOlder(): boolean { this.refreshAnchor(); return this.anchor?.hasOlder === true }
  get oldest(): HistoryWindowAnchor['oldest'] { this.refreshAnchor(); return this.anchor?.oldest }
  get partial(): boolean { this.refreshAnchor(); return this.anchor?.partial === true }
  sourceMessageAtVirtualSeq(seq: number): string | undefined { return this.sourceSeq.get(seq) }
  virtualSeqForSourceMessage(id: string): number | undefined { return this.sourceVSeq.get(id) }

  /** Resolve a virtual display seq back through the loaded history window. */
  resolveRewind(seq: number): string | undefined { return this.rewindsBySeq.get(seq) }
  resolveFork(messageId: string): NativeForkBoundary | undefined { return this.forksByMessageId.get(messageId) }

  /** Read a page in virtual coordinates, or delegate a live-seed page. */
  async page(request: SessionPageRequest, signal: AbortSignal | undefined,
    ordinaryPage: (request: SessionPageRequest) => Promise<SessionPage>): Promise<SessionPage> {
    this.assertLive(signal)
    const before = request.beforeSeq ?? request.throughSeq + 1
    if (before > DISPLAY_SEQ_OFFSET) return this.realPage(request, before, signal, ordinaryPage)
    this.refreshAnchor()
    if (!this.anchor) return Promise.resolve({ records: [], hasMore: false })
    return this.enqueue(() => this.historyPage(before, signal))
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.work.then(work, work)
    this.work = task.catch(() => {})
    return task
  }

  private async realPage(request: SessionPageRequest, before: number, signal: AbortSignal | undefined,
    ordinaryPage: (request: SessionPageRequest) => Promise<SessionPage>): Promise<SessionPage> {
    const realBefore = before - DISPLAY_SEQ_OFFSET
    const page = await ordinaryPage({ ...request,
      throughSeq: Math.max(0, request.throughSeq - DISPLAY_SEQ_OFFSET),
      ...(request.beforeSeq === undefined ? {} : { beforeSeq: Math.max(0, realBefore) }) })
    this.assertLive(signal)
    const records: SessionHistoryRecord[] = page.records.map(entry => ({
      type: 'event', event: wireEvent(entry.event as unknown as SessionEvent),
    }))
    const first = records[0]?.event.seq
    return { records, hasMore: page.hasMore || first === DISPLAY_SEQ_OFFSET && this.hasOlder() }
  }

  private async historyPage(end: number, signal?: AbortSignal): Promise<SessionPage> {
    this.assertLive(signal)
    const cached = this.cache.get(end)
    if (cached) {
      this.cache.delete(end); this.cache.set(end, cached)
      // A cached body may outlive a metadata trim; re-assert only its refs.
      this.attachments.grant(cached.records.rows, cached.epoch)
      return { records: cached.records.rows, hasMore: cached.hasOlder }
    }
    const descriptor = this.descriptors.get(end)
    if (!descriptor) throw new SourceHistoryWindowError('The source history window has no cursor for this page; reopen the conversation')
    if (!descriptor.hasOlder) return { records: [], hasMore: false }
    const fetched = await this.fetchOlder(descriptor.before, descriptor.epoch, signal)
    this.assertLive(signal)
    if (!fetched.rows.length) { descriptor.hasOlder = false; return { records: [], hasMore: false } }
    const rendered = await this.agent.renderHistoryPage(fetched.rows)
    this.assertLive(signal)
    const delta = descriptor.turnTop - rendered.lastTurn
    const start = end - rendered.events.length
    if (start < 1) throw new SourceHistoryWindowError('The source history page exceeds the display journal range')
    const rows = this.remapTurns(rendered, start, fetched.rows, fetched.epoch, delta)
    const bytes = rows.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0)
    const next: Descriptor = {
      end: start, before: fetched.nextBefore, turnTop: descriptor.turnTop - rendered.lastTurn,
      hasOlder: fetched.hasOlder,
      ...(fetched.epoch === undefined ? {} : { epoch: fetched.epoch }),
    }
    this.descriptors.set(start, next)
    this.oldestKey = Math.min(this.oldestKey, start)
    while (this.descriptors.size > MAX_DESCRIPTORS) {
      const oldest = this.descriptors.keys().next().value as number | undefined
      if (oldest === undefined || oldest === DISPLAY_SEQ_OFFSET) break
      this.descriptors.delete(oldest)
    }
    const page = { ...next, records: { rows, bytes, sources: rendered.sources, rewinds: rendered.rewinds, forks: rendered.forks } }
    // A single page larger than the per-window budget is served once but never
    // retained; the retained cache therefore has a hard ceiling.
    if (bytes <= PAGE_CACHE_BYTES) {
      this.cache.set(end, page)
      this.byteTotal += bytes
      this.budget?.added(this, bytes)
      this.trimTo(PAGE_CACHE_BYTES)
    }
    return { records: rows, hasMore: next.hasOlder }
  }

  private trimMappings(): void {
    while (this.sourceSeq.size > MAX_SOURCE_MAPPINGS) {
      const key = this.sourceSeq.keys().next().value as number | undefined
      if (key === undefined) break
      this.sourceSeq.delete(key)
    }
    while (this.sourceVSeq.size > MAX_SOURCE_MAPPINGS) {
      const key = this.sourceVSeq.keys().next().value as string | undefined
      if (key === undefined) break
      this.sourceVSeq.delete(key)
    }
    while (this.rewindsBySeq.size > MAX_SOURCE_MAPPINGS) {
      const key = this.rewindsBySeq.keys().next().value as number | undefined
      if (key === undefined) break
      this.rewindsBySeq.delete(key)
    }
    while (this.forksByMessageId.size > MAX_SOURCE_MAPPINGS) {
      const key = this.forksByMessageId.keys().next().value as string | undefined
      if (key === undefined) break
      this.forksByMessageId.delete(key)
    }
    while (this.sourceSteps.size > MAX_SOURCE_MAPPINGS) {
      const key = this.sourceSteps.keys().next().value
      if (key === undefined) break
      this.sourceSteps.delete(key)
    }
  }

  private async fetchOlder(before: SourcePosition, expectedEpoch: number | undefined, signal?: AbortSignal): Promise<{ rows: HapiMessage[]; nextBefore: SourcePosition; hasOlder: boolean; epoch?: number }> {
    const result = await this.readCursorPage(before, expectedEpoch, async (before, epoch) => {
      let rows: HapiMessage[] = []
      let cursor = before
      let exhausted = false
      let pages = 0
      for (; pages < MAX_FETCH_PAGES && rows.length < MAX_GIANT_ROWS; pages++) {
        const page: HapiMessagesPage = await this.transport.readMessages(this.agent.binding.hapiSessionId, {
          limit: 200, bounded: true, ...(epoch === undefined ? {} : { epoch }), beforeAt: cursor.at, beforeSeq: cursor.seq,
        })
        signal?.throwIfAborted()
        if (page.page.reset || page.page.epoch !== epoch) {
          return { messages: [], next: null, hasMore: false, reset: true, epoch: page.page.epoch }
        }
        const batch = uniqueSourceRows(page.messages)
        if (!batch.length) { exhausted = true; break }
        rows = [...batch, ...rows]
        const oldest = batch[0]!
        cursor = sourcePosition(oldest)
        if (rows.flatMap((row, index) => isSourceTurnStart(row) ? [index] : []).length >= 2) break
        if (!page.page.hasMore) { exhausted = true; break }
        if (page.page.nextBeforeAt === null || page.page.nextBeforeSeq === null) { exhausted = true; break }
      }
      rows = uniqueSourceRows(rows)
      // A partial oldest source turn is valid resident history: never discard
      // rows just because their user/start already lives in the live seed. The
      // page's first synthetic turn/start is suppressed below and its turn
      // coordinates continue the seed turn.
      // Cut at the oldest invoked human input so a page never splits one source
      // turn. Two turns are preferred; one is used when the source starts there.
      const starts = rows.flatMap((row, index) => isSourceTurnStart(row) ? [index] : [])
      let cut = 0
      if (starts.length >= 2) cut = starts[0]!
      else if (starts.length === 1) cut = starts[0]!
      // A giant single source turn is delivered as bounded partial pages. Its
      // stable native turnId/itemId keep the display turn open across pages;
      // no valid prefix is discarded and no hard oversized-turn error is raised.
      const selected = rows.slice(cut)
      const nextBefore = cut < rows.length ? sourcePosition(rows[cut]!) : cursor
      return { messages: selected, next: nextBefore, hasMore: cut > 0 || !exhausted, ...(epoch === undefined ? {} : { epoch }) }
    })
    return { rows: [...result.messages], nextBefore: result.next ?? before, hasOlder: result.hasMore,
      ...(result.epoch === undefined ? {} : { epoch: result.epoch }) }
  }
}

/** Count imported pages only as diagnostics; no source body is retained here. */
export function historyWindowNumbers(window: SourceHistoryWindow): { bound: boolean; hasOlder: boolean } {
  return { bound: window.bound, hasOlder: window.hasOlder() }
}


/** Process-wide bounded registry; display retirement drops source/agent refs. */
export class DisplayHistoryWindows {
  private readonly windows = new Map<string, SourceHistoryWindow>()
  private total = 0
  constructor(private readonly globalBytes = 24 * 1024 * 1024) {}
  get size(): number { return this.windows.size }
  get bytes(): number { return this.total }
  window(displayId: string, agent: HistoryWindowAgent, transport: HapiTransport, readOutline?: SourceOutlineReader, readContext?: SourceContextReader): SourceHistoryWindow {
    const existing = this.windows.get(displayId)
    if (existing && existing.agent === agent) return existing
    if (existing) this.retire(displayId)
    let value: SourceHistoryWindow
    const budget = {
      added: (window: SourceHistoryWindow, bytes: number) => { this.total += bytes; this.enforce() },
      removed: (window: SourceHistoryWindow, bytes: number) => { this.total = Math.max(0, this.total - bytes) },
    }
    value = new SourceHistoryWindow(agent, transport, budget, readOutline, readContext)
    this.windows.set(displayId, value)
    this.pruneWindowOrder()
    return value
  }
  peek(displayId: string): SourceHistoryWindow | undefined { return this.windows.get(displayId) }
  retire(displayId: string): void {
    const window = this.windows.get(displayId)
    if (!window) return
    this.total -= window.cacheBytes
    window.dispose(); this.windows.delete(displayId)
  }
  retireSource(sourceId: string): void {
    for (const [id, window] of this.windows) if (window.agent.binding.hapiSessionId === sourceId) this.retire(id)
  }
  prune(valid: (displayId: string) => boolean): void {
    for (const id of [...this.windows.keys()]) if (!valid(id)) this.retire(id)
  }
  clear(): void { for (const id of [...this.windows.keys()]) this.retire(id); this.total = 0 }
  private enforce(): void {
    while (this.total > this.globalBytes) {
      let largest: [string, SourceHistoryWindow] | undefined
      for (const entry of this.windows) if (!largest || entry[1].cacheBytes > largest[1].cacheBytes) largest = entry
      if (!largest || largest[1].cacheBytes === 0) break
      const before = largest[1].cacheBytes
      largest[1].trimTo(Math.max(0, before - Math.ceil((this.total - this.globalBytes) / Math.max(1, this.windows.size))))
      if (largest[1].cacheBytes >= before) break
    }
  }
  private pruneWindowOrder(): void {
    while (this.windows.size > 12) {
      const oldest = this.windows.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.retire(oldest)
    }
  }
}
