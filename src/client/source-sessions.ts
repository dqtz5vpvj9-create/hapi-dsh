/**
 * Public client Session composition for original HAPI transcripts.
 *
 * The official ClientSessions owner remains the only lease/lifecycle/native
 * control owner. For a HAPI display identity this facade returns one stable
 * SessionFace/binding/eventSource per original source lifetime, delegates every
 * native verb to that original face, and replaces only the data window:
 *
 * - a bounded MutableSessionEventSource mirrored from the original window;
 * - a source-wide official `turnOutline` projection;
 * - direct bounded `loadThrough`/`loadOlder` over HAPI message context.
 *
 * Ordinary DSH sessions pass through unchanged. No upstream object, prototype,
 * private field, or node_modules file is mutated.
 */
import { Context } from '@deepseek-ai/cordis'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ISessions, ProjectionsFace, SessionBinding, SessionEventChange, SessionEventLikeEntry, SessionEventSource, SessionEventWindow,
  SessionFace, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionSnapshot, SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SourceHistoryOutlinePageValue, SourceHistoryOutlineValue, SourceHistoryWindowRequest, SourceHistoryWindowValue } from '../source-window-types.ts'
import type { SourceHistoryAttachmentValue } from '../source-attachment-types.ts'
import { decodeSourceAttachmentValue, readSourceAttachmentWithFallback } from '../source-attachment-types.ts'
import { isSourceDisplayId } from '../shared/source-display-id.ts'
import { DISPLAY_SEQ_OFFSET } from '../shared/history-window.ts'
import { hasLateSourceRows, orderSourceWindow } from './source-event-order.ts'
import { pinSourceViewport, protectSourcePage, sourceGroups, sourceRetentionPlan, type SourceWindowPin, type SourceWindowViewport } from './source-window-retention.ts'
export type { SourceWindowViewport } from './source-window-retention.ts'

function diagnosticMark(name: string): void {
  try { performance.clearMarks(name); performance.mark(name) } catch { /* diagnostics are optional */ }
}


declare module '@deepseek-ai/cordis' { interface Context { hapiSourceSessions: SourceSessions } }

/** The display seq range owned by direct source windows. */
export const SOURCE_WINDOW_SEQ_BASE = 3_000_000_000
/** Outline route ids begin here; they are never event seqs. */
export const SOURCE_OUTLINE_SEQ_BASE = 2_000_000_000
/** Active window budget; an indivisible oversized source row stays complete. */
export const MAX_SOURCE_EVENTS = 5_000
/** Active client transcript byte ceiling; trimming keeps the reading-direction side. */
export const MAX_SOURCE_BYTES = 12 * 1024 * 1024

export interface SourceSessionsApi {
  sourceHistoryOutline(request: { sessionId: string }): Promise<{ ok: true; value: SourceHistoryOutlineValue } | { ok: false; error: unknown }>
  sourceHistoryOutlinePage(request: { sessionId: string; beforeAt?: number; beforeSeq?: number; epoch?: number; limit?: number }): Promise<{ ok: true; value: SourceHistoryOutlinePageValue } | { ok: false; error: unknown }>
  sourceHistoryWindowPage(request: SourceHistoryWindowRequest): Promise<{ ok: true; value: SourceHistoryWindowValue } | { ok: false; error: unknown }>
  sourceHistoryAttachment?(request: { sessionId: string; attachmentId: string }): Promise<RemoteResult<SourceHistoryAttachmentValue>>
  sourceReadingAnchor?(request: { sessionId: string; seq: number }): Promise<{ ok: true; value: { sourceMessageId: string | null } } | { ok: false; error: unknown }>
}

/** Internal render preparation; public readiness still includes the complete outline. */
export interface SourcePreparationReference extends SessionReference {
  readonly preparationReady: Promise<SessionBinding>
}

/** Optional capability owned by this facade, outside the official Session face. */
export interface SourceWindowPreparer {
  available(): boolean
  /** Settle only after the temporary official chat occurrence has unmounted. */
  prepare(reference: SessionReference, signal: AbortSignal): Promise<boolean>
}

export interface SourceWindowReader {
  available(): boolean
  read(): SourceWindowViewport | undefined
}

export interface SourceViewportSession {
  /** Source paging state is independent of the official scrollport's bottom. */
  readonly sourceWindow: {
    getSnapshot(): { readonly hasMoreAfter: boolean }
    subscribe(listener: () => void): () => void
  }
  /** Progressive directory state; navigation only, never a body prerequisite. */
  readonly sourceOutline: {
    getSnapshot(): { readonly status: 'none' | 'partial' | 'ready' | 'degraded'; readonly pages: number; readonly error: string | undefined }
    subscribe(listener: () => void): () => void
  }
  /** Retry a degraded directory; resolves after the next bounded page. */
  retrySourceOutline(): Promise<void>
  loadViewportPage(limit?: number): Promise<void>
  registerWindowPreparer?(preparer: SourceWindowPreparer): () => void
  registerWindowReader?(reader: SourceWindowReader): () => void
}

export interface SourceOutlineValue {
  turn: number
  seq: number
  prompt: string
  response: string
}

class ValueSource<T> {
  private value: T
  private readonly listeners = new Set<() => void>()
  constructor(value: T) { this.value = value }
  readonly getSnapshot = (): T => this.value
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(next: T): void {
    this.value = next
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { console.error('[hapi-dsh] source session projection listener failed', error) }
    }
  }
}

const snapshotFields = ['sessionId', 'running', 'removed', 'openState', 'openError', 'blank', 'lastAgentError',
  'promptAttempted', 'awaitingFirstTurn', 'pendingSubmissions', 'promptError', 'subagent', 'hasMore', 'loadingOlder'] as const
function sameLifecycle(left: SessionSnapshot, right: SessionSnapshot): boolean {
  for (const key of snapshotFields) if (left[key] !== right[key]) return false
  return true
}

function outlineOf(value: unknown): readonly SourceOutlineValue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as { turn?: unknown; seq?: unknown; prompt?: unknown; response?: unknown }
    if (typeof row.turn !== 'number' || !Number.isSafeInteger(row.turn) || row.turn < 0) return []
    if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0) return []
    return [{ turn: row.turn, seq: row.seq, prompt: typeof row.prompt === 'string' ? row.prompt : '',
      response: typeof row.response === 'string' ? row.response : '' }]
  })
}

function hostsOutline(value: SourceHistoryOutlineValue): readonly SourceOutlineValue[] {
  return value.entries.map(entry => ({ turn: entry.turn, seq: entry.seq, prompt: entry.prompt, response: entry.response }))
}

function mergeOutline(host: readonly SourceOutlineValue[] | undefined, tail: readonly SourceOutlineValue[]): readonly SourceOutlineValue[] {
  const byTurn = new Map<number, SourceOutlineValue>()
  for (const entry of host ?? []) byTurn.set(entry.turn, entry)
  for (const entry of tail) if (!byTurn.has(entry.turn)) byTurn.set(entry.turn, entry)
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn)
}

function applyChange(target: MutableSessionEventSource, change: SessionEventChange, hasMore: boolean): void {
  switch (change.kind) {
    case 'replace': target.replace(change.entries, hasMore); break
    case 'prepend': target.prepend(change.entries, hasMore); break
    case 'append': for (const entry of change.entries) target.append(entry); break
    case 'settle-assistant': target.settleAssistant(change.attemptId, change.entry); break
  }
}

interface SourcePosition { messageId: string; at: number; seq: number; epoch?: number }

/** A prepared window may contain pages from different source revisions. */
type PreparedWindowValue = SourceHistoryWindowValue & { beforeEpoch: number | undefined; afterEpoch: number | undefined }

function preparedWindowValue(value: SourceHistoryWindowValue): PreparedWindowValue {
  return { ...value, beforeEpoch: value.epoch, afterEpoch: value.epoch }
}

interface SourceWindowState {
  before: { at: number; seq: number } | null
  after: { at: number; seq: number } | null
  beforeEpoch: number | undefined
  afterEpoch: number | undefined
  beforeMessageId: string | undefined
  afterMessageId: string | undefined
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  firstSeq: number | null
  lastSeq: number | null
  firstTurn: number
  lastTurn: number
}

interface SourcePageRetention {
  pin: SourceWindowPin
  readers: Map<SourceWindowReader, SourceWindowPin | undefined>
}

interface SourceReadCapture {
  readonly source: SessionEventSource
  readonly boundary: number
  readonly turnBoundary: number
  readonly changes: SessionEventChange[]
  /** The successful HTTP snapshot may already contain captured durable items. */
  committed?: readonly SessionEventLikeEntry[]
  overlapWinners?: ReadonlyMap<string, 'http' | 'capture'>
}

/** Existing protocol primary keys, after turn/step coordinates are remapped.
 * Only used at a successful HTTP/live handoff, never for ordinary streaming. */
function capturedEventKey(type: string, data: Record<string, unknown> | null): string | undefined {
  if (!data) return undefined
  if (type === 'turn/start' || type === 'turn/end') return typeof data.turn === 'number' ? `${type}:${data.turn}` : undefined
  if (type === 'step/start' || type === 'step/end') return typeof data.turn === 'number' && typeof data.step === 'number'
    ? `${type}:${data.turn}:${data.step}` : undefined
  const message = data.message as { id?: unknown } | undefined
  const id = type === 'user/message' ? data.id
    : type === 'assistant/message' || type === 'tool/result' ? message?.id
    : type === 'tool/call' ? data.callId
    : type === 'plugin:hapi-dsh/native-item' || type === 'plugin:hapi-dsh-observed/item'
      ? data.key ?? data.sourceMessageId ?? data.sourceRowId
      : data.messageId
  return typeof id === 'string' ? `${type}:${id}` : undefined
}

type ItemEvidence = { source?: { at: number; seq: number }; version?: unknown }

/** Compare existing source positions and native fingerprints. Event coordinates
 * belong to separate display windows and cannot order source revisions. */
function itemEvidence(entries: readonly SessionEventLikeEntry[]): Map<string, ItemEvidence> {
  const bySurface = new Map<number, ItemEvidence>()
  for (const row of entries) {
    if (!['plugin:hapi-dsh/native-item', 'plugin:hapi-dsh-observed/item'].includes(String(row.event.type))) continue
    const data = row.event.data as Record<string, unknown>
    if (typeof data.surfaceSeq !== 'number') continue
    bySurface.set(data.surfaceSeq, {
      ...(typeof data.sourceAt === 'number' && typeof data.sourceSeq === 'number'
        ? { source: { at: data.sourceAt, seq: data.sourceSeq } } : {}),
      ...(typeof data.fingerprint === 'string' ? { version: data.fingerprint } : {}),
    })
  }
  const result = new Map<string, ItemEvidence>()
  for (const row of entries) {
    const type = String(row.event.type), data = row.event.data as Record<string, unknown> | null
    const key = capturedEventKey(type, data)
    if (!key || !data || type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end') continue
    const annotated = bySurface.get(Number(row.event.seq))
    const source = (row as unknown as { source?: { at: number; seq: number } }).source ?? annotated?.source
      ?? (typeof data.sourceAt === 'number' && typeof data.sourceSeq === 'number' ? { at: data.sourceAt, seq: data.sourceSeq } : undefined)
    // Native fingerprints already cover the source body. Other public message
    // records use their payload directly; no extra hash or retained body cache.
    const version = annotated?.version ?? data.fingerprint
      ?? (type === 'user/message' ? data : type === 'assistant/message' || type === 'tool/result' ? data.message
        : type === 'tool/call' ? { name: data.name, arguments: data.arguments } : undefined)
    result.set(key, { ...(source ? { source } : {}), ...(version === undefined ? {} : { version }) })
  }
  return result
}

function sameItemVersion(left: unknown, right: unknown): boolean {
  return left === right || typeof left === 'object' && typeof right === 'object' && JSON.stringify(left) === JSON.stringify(right)
}

function recordTurns(records: readonly SessionEventLikeEntry[]): { first: number | undefined; last: number | undefined } {
  let first: number | undefined
  let last: number | undefined
  for (const entry of records) {
    const data = entry.event.data as Record<string, unknown> | null
    const turn = data && typeof data.turn === 'number' && Number.isSafeInteger(data.turn) ? data.turn : undefined
    if (turn === undefined) continue
    if (first === undefined || turn < first) first = turn
    if (last === undefined || turn > last) last = turn
  }
  return { first, last }
}

/** Stop a local readiness wait without claiming the transport RPC was cancelled. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await untilAborted(new Promise<void>(resolve => { timer = setTimeout(resolve, ms) }), signal) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Immutable entry objects keep one UTF-8 length; WeakMap lets them GC with the window. */
const entryBytes = new WeakMap<object, number>()
const utf8 = new TextEncoder()
function bytesOfEntry(entry: SessionEventLikeEntry): number {
  const key = entry as unknown as object
  const cached = entryBytes.get(key)
  if (cached !== undefined) return cached
  const size = utf8.encode(JSON.stringify(entry)).length
  entryBytes.set(key, size)
  return size
}

class SourceRecord {
  readonly eventSource = new MutableSessionEventSource()
  readonly sourceWindow = new ValueSource({ hasMoreAfter: false })
  readonly sourceOutline = new ValueSource<{ status: 'none' | 'partial' | 'ready' | 'degraded'; pages: number; error: string | undefined }>(
    { status: 'none', pages: 0, error: undefined })
  readonly outline = new ValueSource<readonly SourceOutlineValue[]>([])
  readonly snapshotListeners = new Set<() => void>()
  readonly session: SourceSession
  readonly bindingValue: SessionBinding
  originalFace: SessionFace
  originalEventSource: SessionEventSource
  snapshot: SessionSnapshot
  hostOutline: readonly SourceOutlineValue[] | undefined
  newestOutline: SourceOutlineValue | undefined
  sourceHead: { messageId: string; at: number; seq: number } | undefined
  /** Progressive directory state; only navigation depends on it, never the body. */
  outlineStatus: 'none' | 'partial' | 'ready' | 'degraded' = 'none'
  outlinePages = 0
  outlineError: string | undefined
  tailOutline: readonly SourceOutlineValue[]
  tail: SessionEventWindow
  mode: 'tail' | 'target' | 'latest' = 'tail'
  target: SourceWindowState | undefined
  hasMore: boolean
  loadingOlder = false
  nextWindow = 0
  references = 0
  disposed = false
  private outlinePromise: Promise<void> | undefined
  private readonly outlineLifetime = new AbortController()
  private outlineRefreshes = 0
  private outlineTimer: ReturnType<typeof setTimeout> | undefined
  private outlineRecoveryAttempt = 0
  private trimTimer: ReturnType<typeof setTimeout> | undefined
  private officialPagerWorks = false
  private readonly nullDataWarned = new Set<string>()
  private adoptingOlderCursor = false
  private outlineFailure: { phase: 'first' | 'continuation'; attempt: number; pages: number; durationMs: number; code: string } | undefined
  private jump = 0
  private liveTurnBase = -1
  private liveTurnOffset = 0
  private liveSeqBase = -1
  private liveGap = false
  private readonly nativeTurns = new Map<string, number>()
  private readonly originalTurns = new Map<number, number>()
  private readonly sourceSteps = new Map<string, number>()
  private readonly sourceStepTurns = new Map<string, number>()
  private readonly originalSteps = new Map<string, number>()
  private readonly originalSeqs = new Map<number, number>()
  private nextStep = 1_500_000_000
  private readonly liveQueue: SessionEventLikeEntry[] = []
  private liveFlushScheduled = false
  private readonly tailChanges: SessionEventChange[] = []
  private tailFlushScheduled = false
  private tailNeedsResync = false
  private liveCapture: SourceReadCapture | undefined
  private readonly windowReaders = new Set<SourceWindowReader>()
  private pendingPage: SourcePageRetention | undefined
  private readonly windowPreparers = new Set<SourceWindowPreparer>()
  private hadWindowPreparer = false
  private preparation: { controller: AbortController; done: Promise<unknown>; preparer: SourceWindowPreparer } | undefined
  private readonly stops: Array<() => void> = []
  private readonly originals = new Set<SessionReference>()

  constructor(readonly owner: SourceSessions, readonly sessionId: SessionId, first: SessionReference) {
    const base = first.binding
    this.originals.add(first)
    this.references = 1
    void first.ready.catch(() => {})
    this.originalFace = base.session
    this.originalEventSource = base.eventSource
    const initial = base.eventSource.getSnapshot()
    this.eventSource.replace(initial.entries, initial.hasMore)
    this.tail = initial
    this.hasMore = initial.hasMore
    this.snapshot = base.session.getSnapshot()
    this.tailOutline = outlineOf(base.session.projections.faceOf('turnOutline').getSnapshot())
    this.hostOutline = undefined
    this.outline.set(mergeOutline(undefined, this.tailOutline))
    this.session = new SourceSession(this)
    this.bindingValue = { sessionId: this.sessionId, session: this.session, eventSource: this.eventSource, ctx: base.ctx }
    this.watch(base)
    this.session.publish()
  }

  get binding(): SessionBinding { return this.bindingValue }

  private watch(binding: SessionBinding): void {
    this.stops.push(binding.session.subscribe(() => { if (!this.disposed) this.session.publish() }))
    this.stops.push(binding.session.projections.faceOf('turnOutline').subscribe(() => {
      if (this.disposed) return
      const next = outlineOf(binding.session.projections.faceOf('turnOutline').getSnapshot())
      // A transient empty projection while a target window is loaded must not
      // erase the retained live-tail turn ladder.
      if (next.length > 0 || this.tailOutline.length === 0) this.tailOutline = next
      this.outline.set(mergeOutline(this.hostOutline, this.tailOutline))
    }))
    this.stops.push(binding.eventSource.subscribe(() => {
      if (this.disposed) return
      try { performance.mark('hapi-dsh:live:change') } catch { /* optional */ }
      this.tail = binding.eventSource.getSnapshot()
      if (this.liveCapture?.source === binding.eventSource) {
        this.liveCapture.changes.push(this.tail.change)
        return
      }
      if (this.mode === 'latest') {
        this.appendLive(binding, this.tail.change)
        return
      }
      if (this.mode === 'target') {
        // Old readers keep their window while the original stream continues.
        this.appendLive(binding, this.tail.change)
        return
      }
      this.tailChanges.push(this.tail.change)
      if (!this.tailFlushScheduled) {
        this.tailFlushScheduled = true
        queueMicrotask(() => { this.tailFlushScheduled = false; this.flushTail() })
      }
    }))
  }

  private flushTail(): void {
    const changes = this.tailChanges.splice(0)
    if (this.disposed || this.mode !== 'tail' || (!changes.length && !this.tailNeedsResync)) return
    // The official seed pager publishes before loadOlder() resolves. Protect
    // that prefix in this flush, just as the direct source pager protects its
    // page, while the DOM still measures the pre-page reader position.
    const afterReplace = changes.findLastIndex(change => change.kind === 'replace') + 1
    if (afterReplace && this.pendingPage) {
      const keys = new Set(sourceGroups(this.tail.entries).map(group => group.key))
      if (!keys.has(this.pendingPage.pin.first) || !keys.has(this.pendingPage.pin.last)) this.pendingPage = undefined
    }
    try { performance.mark(`hapi-dsh:flush:changes:${changes.length}`) } catch { /* diagnostics are optional */ }
    const prefixSeqs = new Set(changes.slice(afterReplace).flatMap(change => change.kind === 'prepend'
      ? change.entries.map(row => Number(row.event.seq)) : []))
    // Multiple prepends arrive newest-page first. Protect their final window
    // order, and exclude pages superseded by a later snapshot replacement.
    const prefix = this.tail.entries.filter(row => prefixSeqs.has(Number(row.event.seq)))
    const page = prefix.length ? this.preparePageRetention(prefix) : undefined
    const pins = page?.pins ?? this.readerPins(true)
    // Retrying a deferred flush must not forget that this page was requested.
    // Only reader movement releases the protected prefix, including on a
    // budget conflict that leaves the previous visible window untouched.
    if (page) this.pendingPage = page.pending
    const direction = page || pins.some(pin => pin.requestedPage) ? 'older' : 'newer'
    let effectivePins = pins
    let locality = this.retentionPlan(this.tail.entries, effectivePins, direction)
    const missingBoundary = !locality.fits && locality.first === 0 && locality.last === this.tail.entries.length
    if (missingBoundary && page?.pending !== undefined && direction === 'older') {
      // A DOM-captured reader boundary can name a group the page no longer
      // carries. A clean requested page still belongs in the window; retain the
      // older-inclusive span without the stale pin instead of dropping it.
      const unpinned = this.retentionPlan(this.tail.entries, [], 'older')
      if (unpinned.fits) {
        locality = unpinned
        effectivePins = []
        try { performance.mark('hapi-dsh:flush:unpinned-fallback') } catch { /* diagnostics are optional */ }
      }
    }
    try { performance.mark(`hapi-dsh:flush:prefix:${prefix.length}:fits:${locality.fits}`) } catch { /* diagnostics are optional */ }
    if (!locality.fits) { this.tailNeedsResync = true; return }
    const overBudget = this.tail.entries.length > MAX_SOURCE_EVENTS
      || this.tail.entries.reduce((bytes, row) => bytes + bytesOfEntry(row), 0) > MAX_SOURCE_BYTES
    const prependPage = direction === 'older' && this.mode !== 'tail' && changes.some(change => change.kind === 'prepend')
    const pageAppendOnly = (page?.pending !== undefined || prependPage) && !this.tailNeedsResync && !overBudget
      && locality.first === 0 && locality.last === this.tail.entries.length
      && !hasLateSourceRows([], this.tail.entries)
    // A clean page that fits the whole proposed window is merged in place:
    // replacing the window would remount every row and lose the reading anchor.
    if (pageAppendOnly) {
      try { performance.mark('hapi-dsh:flush:page-append') } catch { /* diagnostics are optional */ }
      for (const change of changes) applyChange(this.eventSource, this.normalizeChange(change), this.tail.hasMore)
      const mergedSnapshot = this.eventSource.getSnapshot()
      const merged = mergedSnapshot.entries
      const sources = merged.flatMap(row => {
        const source = (row as unknown as { source?: SourcePosition }).source
        return source ? [source] : []
      }).sort((a, b) => a.at - b.at || a.seq - b.seq)
      const first = sources[0], last = sources.at(-1), turns = recordTurns(merged)
      this.mode = 'latest'
      // A prepend may add rows whose source cursor is not stored on the public
      // entries. Keep the previous older boundary in that case instead of
      // dropping the only cursor that can request the next page.
      const changeSource = changes
        .flatMap(change => change.kind === 'prepend' ? change.entries : [])
        .map(entry => (entry as unknown as { source?: SourcePosition }).source).find(Boolean)
      const tailSource = (this.tail.entries[0] as unknown as { source?: SourcePosition } | undefined)?.source
      const cursor = first ?? changeSource ?? tailSource
      const before = cursor ? { at: cursor.at, seq: cursor.seq }
        : this.target?.before ?? null
      this.target = { before,
        after: last ? { at: last.at, seq: last.seq } : null, hasMoreBefore: mergedSnapshot.hasMore,
        beforeEpoch: cursor?.epoch ?? this.target?.beforeEpoch, afterEpoch: last?.epoch, beforeMessageId: first?.messageId ?? this.target?.beforeMessageId, afterMessageId: last?.messageId,
        hasMoreAfter: false, firstSeq: merged[0]?.event.seq ?? null, lastSeq: merged.at(-1)?.event.seq ?? null,
        firstTurn: turns.first ?? 0, lastTurn: turns.last ?? 0 }
      this.liveSeqBase = merged.reduce((max, row) => Math.max(max, Number(row.event.seq)), -1)
      this.liveTurnBase = this.maxTailTurn()
      this.learnTargetTurns(merged)
      this.hasMore = mergedSnapshot.hasMore
      this.session.publish()
      return
    }
    if (this.tailNeedsResync || overBudget || locality.first > 0 || locality.last < this.tail.entries.length || hasLateSourceRows([], this.tail.entries)) {
      const records = orderSourceWindow(this.tail.entries)
      if (!this.retentionFits(records, effectivePins, direction)) {
          try { performance.mark(`hapi-dsh:flush:retention-no:${records.length}`) } catch { /* diagnostics are optional */ }
          this.tailNeedsResync = true
          return
      }
      try { performance.mark(`hapi-dsh:flush:replace:${records.length}`) } catch { /* diagnostics are optional */ }
      this.eventSource.replace(this.normalizeEventData(records), this.tail.hasMore)
      const replacedSnapshot = this.eventSource.getSnapshot()
      if (this.trimTimer !== undefined) { clearTimeout(this.trimTimer); this.trimTimer = undefined }
      this.tailNeedsResync = false
      const sources = records.flatMap(row => {
        const source = (row as unknown as { source?: SourcePosition }).source
        return source ? [source] : []
      }).sort((a, b) => a.at - b.at || a.seq - b.seq)
      const first = sources[0], last = sources.at(-1), turns = recordTurns(records)
      this.mode = 'latest'
      this.target = { before: first ? { at: first.at, seq: first.seq } : null,
        after: last ? { at: last.at, seq: last.seq } : null, hasMoreBefore: replacedSnapshot.hasMore,
        beforeEpoch: first?.epoch, afterEpoch: last?.epoch, beforeMessageId: first?.messageId, afterMessageId: last?.messageId,
        hasMoreAfter: false, firstSeq: records[0]?.event.seq ?? null, lastSeq: records.at(-1)?.event.seq ?? null,
        firstTurn: turns.first ?? 0, lastTurn: turns.last ?? 0 }
      this.liveSeqBase = this.tail.entries.reduce((max, row) => Math.max(max, Number(row.event.seq)), -1)
      this.liveTurnBase = this.maxTailTurn()
      this.learnTargetTurns(records)
      this.trimWindow(direction, effectivePins)
    } else {
      // Delay only through the projector's synchronous burst, so annotations
      // and their bodies arrive together before the official feed sees them.
      for (const change of changes) applyChange(this.eventSource, change, this.tail.hasMore)
    }
    this.hasMore = this.target?.hasMoreBefore ?? this.tail.hasMore
    this.session.publish()
  }

  /**
   * The official conversation assembler reads `event.data.turn`; an event that
   * arrives with null/undefined data crashes the event-feed subscriber and the
   * pane can never mount. Normalize the payload at this emission boundary and
   * report each offending event type once.
   */
  private normalizeEventData(entries: readonly SessionEventLikeEntry[]): SessionEventLikeEntry[] {
    const normalized: SessionEventLikeEntry[] = []
    for (const entry of entries) {
      const event = entry.event as unknown as { type?: unknown; data?: unknown }
      if (event.data !== null && event.data !== undefined) { normalized.push(entry); continue }
      const type = String(event.type ?? 'unknown')
      if (!this.nullDataWarned.has(type)) {
        this.nullDataWarned.add(type)
        console.warn(`[hapi-dsh] normalized emitted event with null data: type=${type}`)
      }
      normalized.push({ ...entry, event: { ...(entry.event as object), data: {} } } as unknown as SessionEventLikeEntry)
    }
    return normalized
  }

  private appendLive(_binding: SessionBinding, change: SessionEventChange, entriesOverride?: readonly SessionEventLikeEntry[]): void {
    try { performance.mark(`hapi-dsh:live:append:${String(change.kind)}`) } catch { /* optional */ }
    if (this.disposed || this.target === undefined) return
    let entries = entriesOverride ?? (change.kind === 'append' ? change.entries
      : change.kind === 'settle-assistant' && change.entry ? [change.entry] : [])
    if (change.kind === 'replace') {
      // The public journal may compact its retained live window without
      // changing the source owner. An overlapping snapshot proves continuity;
      // only its unseen suffix belongs in this independently paged view.
      this.flushLive()
      const overlaps = change.entries.some(row => Number(row.event.seq) === this.liveSeqBase)
      if (!overlaps && this.mode === 'latest' && this.sourceHead) {
        void this.loadNewest(this.newestOutline)
        return
      }
      // A replacement snapshot can repeat rows this paged window already
      // retained; only its unseen suffix (or a changed payload) belongs here.
      const resident = new Map(this.eventSource.getSnapshot().entries.map(row => [Number(row.event.seq), row.event]))
      entries = change.entries.filter(row => {
        const seq = Number(row.event.seq)
        if (seq <= this.liveSeqBase) return false
        const prior = resident.get(seq)
        if (prior === undefined) return true
        return JSON.stringify(prior) !== JSON.stringify(row.event)
      })
    }
    if (!entries.length) return
    this.liveQueue.push(...entries)
    if (this.liveQueue.length >= 256) { this.flushLive(); return }
    if (this.liveFlushScheduled) return
    this.liveFlushScheduled = true
    queueMicrotask(() => { this.liveFlushScheduled = false; this.flushLive() })
  }

  /** Drain one synchronous projector burst after its trailing native-item annotations arrived. */
  /** Normalize a change payload before the official event source publishes it. */
  private normalizeChange(change: SessionEventChange): SessionEventChange {
    if (change.kind === 'append' || change.kind === 'prepend' || change.kind === 'replace') {
      return { ...change, entries: this.normalizeEventData(change.entries) }
    }
    if (change.kind === 'settle-assistant' && change.entry) return { ...change, entry: this.normalizeEventData([change.entry])[0]! } as SessionEventChange
    return change
  }

  private flushLive(overlap?: readonly SessionEventLikeEntry[], winners?: ReadonlyMap<string, 'http' | 'capture'>): void {
    try { performance.mark(`hapi-dsh:live:flush-start:${String(this.liveQueue.length)}`) } catch { /* optional */ }
    if (this.disposed || this.target === undefined) { this.liveQueue.length = 0; return }
    let entries = this.liveQueue.splice(0)
    if (!entries.length) return
    try {
      const queueTypes = [...new Set(entries.map(entry => String(entry.event.type)))].join('|')
      performance.mark(`hapi-dsh:live:queue:${entries.length}:${queueTypes.slice(0, 90)}`)
    } catch { /* optional */ }
    const pins = this.readerPins(true)
    const observedLast = Math.max(this.liveSeqBase, ...entries.map(row => Number(row.event.seq)))
    // Once a source gap exists, a later live row cannot jump across it. Keep
    // resident-item revisions; the authoritative forward pager owns filling
    // the gap, even if the reader has since reached this window's bottom.
    // Only a real source gap may withhold live rows. A reader that is merely
    // not attached to the tail still receives appended output below its
    // viewport; dropping it would make streamed answers disappear entirely.
    if (this.liveGap) {
      const resident = new Set(sourceGroups(this.eventSource.getSnapshot().entries).map(group => group.key))
      const groups = sourceGroups(entries)
      const present = groups.filter(group => resident.has(group.key))
      if (present.length !== groups.length) {
        if (groups.some(group => group.content && !resident.has(group.key))) {
          this.target.hasMoreAfter = true
          this.liveGap = true
        }
        entries = present.flatMap(group => entries.slice(group.start, group.end))
        if (!entries.length) { this.liveSeqBase = observedLast; this.session.publish(); return }
      }
    }
    // Group by stable native turnId, never by a numeric ordinal difference.
    const localTurns = new Map<number, number>()
    const localSteps = new Map<string, number>()
    const sourceBySurfaceSeq = new Map<number, SourcePosition>()
    const pluginSources = new Map<SessionEventLikeEntry, SourcePosition>()
    let nextTurn = this.target.lastTurn
    for (const entry of entries) {
      if (!['plugin:hapi-dsh/native-item', 'plugin:hapi-dsh-observed/item'].includes(String(entry.event.type))) continue
      const data = (entry.event as unknown as { data?: Record<string, unknown> }).data ?? {}
      const sourceMessageId = typeof data?.sourceMessageId === 'string' ? data.sourceMessageId : typeof data?.sourceRowId === 'string' ? data.sourceRowId : undefined
      if (sourceMessageId) {
        const source = (entry as unknown as { source?: SourcePosition }).source ?? { messageId: sourceMessageId,
          at: typeof data.sourceAt === 'number' ? data.sourceAt : 0,
          seq: typeof data.sourceSeq === 'number' ? data.sourceSeq : 0 }
        pluginSources.set(entry, source)
        if (typeof data.surfaceSeq === 'number') sourceBySurfaceSeq.set(data.surfaceSeq, source)
      }
      const native = typeof data?.nativeTurnId === 'string' ? data.nativeTurnId : undefined
      const original = typeof data?.displayTurn === 'number' ? data.displayTurn : undefined
      const stepId = typeof data?.nativeStepId === 'string' ? data.nativeStepId
        : typeof data?.sourceStepId === 'string' ? data.sourceStepId : undefined
      if (stepId && original !== undefined && typeof data?.displayStep === 'number' && data.displayStep > 0) {
        const key = `${original}:${data.displayStep}`
        let step = this.sourceSteps.get(stepId) ?? this.originalSteps.get(key)
        const priorTurn = this.sourceStepTurns.get(stepId)
        if (priorTurn !== undefined) { localTurns.set(original, priorTurn); this.originalTurns.set(original, priorTurn) }
        if (step === undefined) { step = ++this.nextStep; this.sourceSteps.set(stepId, step) }
        this.sourceSteps.set(stepId, step)
        localSteps.set(key, step); this.originalSteps.set(key, step)
      }
      if (!native || original === undefined) continue
      let mapped = this.nativeTurns.get(native) ?? localTurns.get(original) ?? this.originalTurns.get(original)
      if (mapped === undefined) { mapped = ++nextTurn; this.nativeTurns.set(native, mapped) }
      this.nativeTurns.set(native, mapped)
      localTurns.set(original, mapped)
      this.originalTurns.set(original, mapped)
    }
    const accepted: SessionEventLikeEntry[] = []
    const replaced = new Map<number, SessionEventLikeEntry>()
    let liveSkipped = 0
    const seqMap = this.originalSeqs
    const committed = new Map<string, SessionEventLikeEntry>()
    for (const row of overlap ?? []) {
      const key = capturedEventKey(String(row.event.type), row.event.data as Record<string, unknown> | null)
      if (key !== undefined) committed.set(key, row)
    }
    for (const entry of entries) {
      const originalSeq = Number(entry.event.seq)
      if (originalSeq <= this.liveSeqBase) { liveSkipped++; continue }
      this.liveSeqBase = originalSeq
      const data = entry.event.data as Record<string, unknown> | null
      const originalTurn = data && typeof data.turn === 'number' ? data.turn
        : data && typeof data.displayTurn === 'number' ? data.displayTurn : undefined
      let mappedTurn = originalTurn === undefined ? this.target.lastTurn
        : localTurns.get(originalTurn) ?? this.originalTurns.get(originalTurn)
          ?? (originalTurn <= this.liveTurnBase ? this.target.lastTurn : undefined)
      if (mappedTurn === undefined) {
        mappedTurn = ++nextTurn
        this.originalTurns.set(originalTurn!, mappedTurn)
      }
      nextTurn = Math.max(nextTurn, mappedTurn)
      this.target.lastTurn = Math.max(this.target.lastTurn, mappedTurn)
      let nextData = data
      if (data) {
        let changed: Record<string, unknown> | undefined
        if (originalTurn !== undefined) { changed = { ...data, turn: mappedTurn } }
        if (typeof data.displayTurn === 'number') { changed ??= { ...data }; changed.displayTurn = mappedTurn }
        for (const field of ['step', 'displayStep'] as const) {
          const step = data[field]
          if (typeof step !== 'number' || originalTurn === undefined || step <= 0) continue
          const key = `${originalTurn}:${step}`
          let mapped = localSteps.get(key) ?? this.originalSteps.get(key)
          if (mapped === undefined) { mapped = ++this.nextStep; this.originalSteps.set(key, mapped) }
          changed ??= { ...data }; changed[field] = mapped
        }
        if (typeof data.surfaceSeq === 'number') { changed ??= { ...data }; changed.surfaceSeq = seqMap.get(data.surfaceSeq) ?? data.surfaceSeq }
        nextData = changed ?? data
      }
      const key = overlap === undefined ? undefined : capturedEventKey(String(entry.event.type), nextData)
      const existing = key === undefined ? undefined : committed.get(key)
      // Identity proves placement, not equal content. A captured settlement or
      // replacement overlays the HTTP row at its original coordinate instead
      // of either duplicating the item or silently discarding its newer body.
      const nextSeq = existing ? Number(existing.event.seq) : (this.target.lastSeq ?? SOURCE_WINDOW_SEQ_BASE) + 1
      if (!existing) this.target.lastSeq = nextSeq
      seqMap.set(originalSeq, nextSeq)
      if (existing && (key === undefined || winners?.get(key) !== 'capture')) continue
      const raw = entry.event as unknown as Record<string, unknown>
      const nextEvent: Record<string, unknown> = { ...raw, seq: nextSeq }
      if (nextData !== data) nextEvent.data = nextData
      if (Array.isArray(raw.sourceEventSeqs)) {
        nextEvent.sourceEventSeqs = (raw.sourceEventSeqs as number[]).map(value => seqMap.get(value) ?? value)
      }
      if (raw.surfaceOp && typeof raw.surfaceOp === 'object') {
        const op = raw.surfaceOp as Record<string, unknown>
        nextEvent.surfaceOp = { ...op,
          ...(typeof op.startSeq === 'number' ? { startSeq: seqMap.get(op.startSeq) ?? op.startSeq } : {}),
          ...(typeof op.endSeq === 'number' ? { endSeq: seqMap.get(op.endSeq) ?? op.endSeq } : {}) }
      }
      const explicitSource = (entry as unknown as { source?: SourcePosition }).source
      const existingSource = (existing as unknown as { source?: SourcePosition } | undefined)?.source
      const source = explicitSource ?? existingSource ?? pluginSources.get(entry) ?? sourceBySurfaceSeq.get(originalSeq)
      const mapped = { type: 'event', event: nextEvent, ...(source === undefined ? {} : { source }) } as unknown as SessionEventLikeEntry
      if (existing) replaced.set(nextSeq, mapped)
      else accepted.push(mapped)
    }
    try {
      const mappedTypes = [...new Set(accepted.map(entry => String(entry.event.type)))].join('|')
      performance.mark(`hapi-dsh:live:mapped:${accepted.length}:${replaced.size}:${liveSkipped}:${mappedTypes.slice(0, 90)}`)
    } catch { /* optional */ }
    this.liveSeqBase = Math.max(this.liveSeqBase, observedLast)
    // Append in one synchronous batch; each accepted record keeps its source
    // annotation so a later eviction can restore the exact source edge.
    const resident = this.eventSource.getSnapshot()
    const retained = replaced.size ? resident.entries.map(row => replaced.get(Number(row.event.seq)) ?? row) : resident.entries
    const combined = [...retained, ...accepted]
    if (!this.retentionFits(combined, pins, 'newer')) {
      const plan = this.retentionPlan(combined, [], 'newer')
      try { performance.mark(`hapi-dsh:live:retention-plan:${String(plan.fits)}:${plan.first}:${plan.last}:${combined.length}`) } catch { /* optional */ }
      if (plan.fits && plan.first > 0) {
        // Live output outranks retained history: evict the older side so the
        // streaming row still lands, keeping a before cursor so the reader can
        // page the evicted interval back in later.
        const keep = combined.slice(plan.first, plan.last)
        const firstKept = plan.groups.find(group => group.start >= plan.first)?.source
        const lastKept = [...plan.groups].reverse().find(group => group.end <= plan.last)?.source
        this.eventSource.replace(this.normalizeEventData(keep), resident.hasMore)
        this.target.before = firstKept ? { at: firstKept.at, seq: firstKept.seq } : null
        this.target.beforeEpoch = (firstKept as unknown as { epoch?: number } | undefined)?.epoch
        this.target.beforeMessageId = firstKept?.messageId
        this.target.after = lastKept ? { at: lastKept.at, seq: lastKept.seq } : null
        this.target.afterEpoch = (lastKept as unknown as { epoch?: number } | undefined)?.epoch
        this.target.afterMessageId = lastKept?.messageId
        this.target.hasMoreBefore = firstKept !== undefined
        this.target.hasMoreAfter = false
        this.target.firstSeq = keep[0]?.event.seq ?? null
        this.target.lastSeq = keep.at(-1)?.event.seq ?? null
        this.liveGap = false
        try { performance.mark(`hapi-dsh:live:evicted-older:${keep.length}`) } catch { /* optional */ }
        this.learnTargetTurns(accepted)
        this.pruneTurnMaps()
        this.session.publish()
        return
      }
      if (!plan.fits) {
        this.target.lastSeq = this.lastSeq()
        const turns = recordTurns(resident.entries)
        this.target.lastTurn = turns.last ?? this.target.firstTurn
        this.target.hasMoreAfter = true
        this.liveGap = true
        try { performance.mark('hapi-dsh:live:retention-fail') } catch { /* optional */ }
        this.pruneTurnMaps()
        this.session.publish()
        return
      }
      // The full window fits without reader pins: a stale pin conflict must not
      // withhold live output, so fall through and append normally.
      try { performance.mark('hapi-dsh:live:retention-pin-ignored') } catch { /* optional */ }
    }
    if (hasLateSourceRows(retained, accepted)) {
      this.eventSource.replace(orderSourceWindow([...retained, ...accepted]), resident.hasMore)
    } else if (replaced.size) {
      this.eventSource.replace([...retained, ...accepted], resident.hasMore)
    } else {
      for (const entry of accepted) this.eventSource.append(entry)
    }
    this.learnTargetTurns(accepted)
    this.target.lastSeq = this.lastSeq()
    this.trimWindow('newer', pins)
    this.pruneTurnMaps()
    this.session.publish()
    try { performance.mark(`hapi-dsh:live:flush-end:${String(this.eventSource.getSnapshot().entries.length)}`) } catch { /* optional */ }
  }

  private pruneTurnMaps(): void {
    const entries = this.eventSource.getSnapshot().entries
    const turns = new Set<number>()
    for (const entry of entries) {
      const data = entry.event.data as Record<string, unknown> | null
      if (data && typeof data.turn === 'number') turns.add(data.turn)
      if (data && typeof data.displayTurn === 'number') turns.add(data.displayTurn)
    }
    for (const [native, display] of this.nativeTurns) if (!turns.has(display)) this.nativeTurns.delete(native)
    for (const [original, display] of this.originalTurns) if (!turns.has(display)) this.originalTurns.delete(original)
    const activeSteps = new Set<number>()
    for (const entry of entries) {
      const data = entry.event.data as Record<string, unknown> | null
      if (typeof data?.step === 'number') activeSteps.add(data.step)
      if (typeof data?.displayStep === 'number') activeSteps.add(data.displayStep)
    }
    for (const [key, step] of this.sourceSteps) if (!activeSteps.has(step)) { this.sourceSteps.delete(key); this.sourceStepTurns.delete(key) }
    for (const [key, step] of this.originalSteps) if (!activeSteps.has(step)) this.originalSteps.delete(key)
    const activeSeqs = new Set(entries.map(row => Number(row.event.seq)))
    for (const [original, mapped] of this.originalSeqs) if (!activeSeqs.has(mapped)) this.originalSeqs.delete(original)
    const cap = Math.max(256, Math.min(MAX_SOURCE_EVENTS, 2_000))
    while (this.nativeTurns.size > cap) this.nativeTurns.delete(this.nativeTurns.keys().next().value as string)
    while (this.originalTurns.size > cap) this.originalTurns.delete(this.originalTurns.keys().next().value as number)
  }

  private originalBinding(): SessionBinding {
    return { sessionId: this.sessionId, session: this.originalFace, eventSource: this.originalEventSource, ctx: this.bindingValue.ctx }
  }

  /** A new navigation owns subsequent changes only after the previous reader
   * has returned its captured natural updates to the retained window. */
  private beginJump(): number {
    this.preparation?.controller.abort()
    this.finishLiveCapture(this.liveCapture)
    this.flushLive()
    this.flushTail()
    return ++this.jump
  }

  private captureLive(): SourceReadCapture {
    const capture: SourceReadCapture = {
      source: this.originalEventSource,
      boundary: this.tail.entries.reduce((max, row) => Math.max(max, Number(row.event.seq)), -1),
      turnBoundary: this.maxTailTurn(), changes: [],
    }
    this.liveCapture = capture
    return capture
  }

  /** The capture object is operation-owned: an old response cannot publish or
   * discard the updates now being collected by its successor. */
  private finishLiveCapture(capture: SourceReadCapture | undefined): void {
    if (!capture || this.liveCapture !== capture) return
    this.liveCapture = undefined
    if (this.disposed || capture.source !== this.originalEventSource) return
    if (this.mode === 'tail') {
      this.tailChanges.push(...capture.changes)
      this.flushTail()
      return
    }
    const observed = capture.changes.flatMap(change => change.kind === 'append' || change.kind === 'replace' ? change.entries
      : change.kind === 'settle-assistant' && change.entry ? [change.entry] : [])
      .filter(row => Number(row.event.seq) > capture.boundary)
    // A replacement can revise an already captured seq, and a settlement may
    // be delivered after its annotations. Keep the latest observation for each
    // original coordinate before applying the ordered durable suffix.
    const bySeq = new Map(observed.map(row => [Number(row.event.seq), row]))
    const entries = [...bySeq.values()].sort((left, right) => Number(left.event.seq) - Number(right.event.seq))
    if (entries.length) {
      // Keep this operation's overlap evidence attached even when the capture
      // is larger than the ordinary 256-event streaming flush threshold.
      this.liveQueue.push(...entries)
      this.flushLive(capture.committed, capture.overlapWinners)
    }
  }

  private initializeWindowLive(records: readonly SessionEventLikeEntry[], capture: SourceReadCapture): void {
    this.pendingPage = undefined
    capture.committed = records
    // Reaching this context's physical bottom does not cover the omitted
    // source interval. Only forward paging or an explicit latest jump can.
    this.liveGap = this.target?.hasMoreAfter ?? false
    this.nativeTurns.clear(); this.originalTurns.clear(); this.sourceSteps.clear(); this.sourceStepTurns.clear(); this.originalSteps.clear(); this.originalSeqs.clear()
    this.learnTargetTurns(records)
    this.liveSeqBase = capture.boundary
    this.liveTurnBase = capture.turnBoundary
    this.liveTurnOffset = (this.target?.lastTurn ?? 0) - this.liveTurnBase
  }

  /** Resolve source-version overlap before publishing the candidate window.
   * A same-position conflict has no ordering proof, so only a subsequent
   * bounded authoritative read can cover it. Fresh conflicts during that read
   * retry within this operation's fixed budget; failure keeps the old window. */
  private async readCapturedWindow(api: SourceSessionsApi, request: SourceHistoryWindowRequest,
    capture: SourceReadCapture, token: number, commit: (value: PreparedWindowValue) => void,
    prepare?: (value: SourceHistoryWindowValue) => Promise<PreparedWindowValue | undefined>, allowEmpty = false): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const coveredChanges = capture.changes.length
      const result = await api.sourceHistoryWindowPage(request)
      if (this.disposed || token !== this.jump || !result.ok) return false
      const value = prepare ? await prepare(result.value) : preparedWindowValue(result.value)
      if (!value || this.disposed || token !== this.jump) return false
      const records = value.records as SessionEventLikeEntry[]
      if (!records.length && !allowEmpty) return false
      const observed = new Map<number, SessionEventLikeEntry>()
      const changedAt = new Map<string, number>()
      capture.changes.forEach((change, index) => {
        const rows = change.kind === 'append' || change.kind === 'replace' ? change.entries
          : change.kind === 'settle-assistant' && change.entry ? [change.entry] : []
        for (const row of rows) {
          if (Number(row.event.seq) <= capture.boundary) continue
          observed.set(Number(row.event.seq), row)
          const key = capturedEventKey(String(row.event.type), row.event.data as Record<string, unknown> | null)
          if (key) changedAt.set(key, index)
        }
      })
      const captured = itemEvidence([...observed.values()].sort((a, b) => Number(a.event.seq) - Number(b.event.seq)))
      const http = itemEvidence(records), winners = new Map<string, 'http' | 'capture'>()
      let conflict = false
      for (const [key, incoming] of captured) {
        const existing = http.get(key)
        if (!existing) continue
        const position = incoming.source && existing.source
          ? incoming.source.at - existing.source.at || incoming.source.seq - existing.source.seq : 0
        if (position) { winners.set(key, position > 0 ? 'capture' : 'http'); continue }
        if (sameItemVersion(incoming.version, existing.version)) { winners.set(key, 'http'); continue }
        if (attempt > 0 && (changedAt.get(key) ?? -1) < coveredChanges) {
          winners.set(key, 'http')
          continue
        }
        conflict = true
      }
      if (conflict) continue
      capture.overlapWinners = winners
      commit(value)
      // Finish synchronously with candidate publication: a later feed frame
      // belongs to normal live delivery, not this operation's earlier snapshot.
      this.finishLiveCapture(capture)
      return !this.disposed && token === this.jump
    }
    throw new Error('Source items changed during the bounded history read; keeping the current conversation window')
  }

  /** A still-live original lease owns the current generation. */
  private liveBinding(): SessionBinding | undefined {
    for (const reference of this.originals) {
      try { return reference.binding } catch { /* released caller */ }
    }
    return undefined
  }

  private rebind(binding: SessionBinding): void {
    if (binding.session === this.originalFace && binding.eventSource === this.originalEventSource) return
    for (const stop of this.stops.splice(0)) { try { stop() } catch { /* best effort */ } }
    this.originalFace = binding.session
    this.originalEventSource = binding.eventSource
    this.watch(binding)
  }

  addReference(reference: SessionReference): void {
    this.originals.add(reference)
    this.references++
    void reference.ready.catch(() => {})
  }

  releaseReference(reference: SessionReference): void {
    if (!this.originals.delete(reference)) return
    reference.release()
    this.references = Math.max(0, this.references - 1)
  }

  /** Single-flight first directory page; older pages continue in background. */
  private ensureOutline(): Promise<void> {
    if (!this.outlinePromise) {
      const outline = this.prefetchOutline(false)
      this.outlinePromise = outline
      void outline.catch(() => { if (this.outlinePromise === outline) this.outlinePromise = undefined })
    }
    return this.outlinePromise
  }

  /** The same binding can render hidden once this caller's original Session opens. */
  async preparationReadyFor(reference: SessionReference): Promise<SessionBinding> {
    await untilAborted(reference.ready, this.outlineLifetime.signal)
    diagnosticMark('hapi-dsh:facade:original-ready')
    if (this.disposed) throw new Error('The source session was released before it opened')
    return this.bindingValue
  }

  /** Wait only for this caller's original generation; the directory loads progressively. */
  async readyFor(preparationReady: Promise<SessionBinding>): Promise<SessionBinding> {
    const firstPage = this.ensureOutline()
    await Promise.all([preparationReady, firstPage])
    if (this.disposed) throw new Error('The source session was released before it opened')
    diagnosticMark('hapi-dsh:facade:ready')
    return this.bindingValue
  }

  /** Stop the shared source; each caller releases its own original lease. */
  retire(): void {
    if (this.disposed) return
    this.disposed = true
    this.outlineLifetime.abort(new Error('The source session was released before it opened'))
    this.preparation?.controller.abort()
    this.windowPreparers.clear()
    this.windowReaders.clear()
    this.pendingPage = undefined
    this.liveCapture = undefined
    this.liveQueue.length = 0
    this.tailChanges.length = 0
    this.liveFlushScheduled = false
    this.nativeTurns.clear(); this.originalTurns.clear(); this.sourceSteps.clear(); this.sourceStepTurns.clear(); this.originalSteps.clear(); this.originalSeqs.clear()
    if (this.outlineTimer !== undefined) clearTimeout(this.outlineTimer)
    if (this.trimTimer !== undefined) { clearTimeout(this.trimTimer); this.trimTimer = undefined }
    for (const stop of this.stops.splice(0)) { try { stop() } catch { /* best effort */ } }
    this.session.publish()
  }

  forceRelease(): void {
    this.retire()
    for (const reference of this.originals) reference.release()
    this.originals.clear()
    this.references = 0
  }

  /**
   * Read one outline page through the paged RPC, or fall back to the older
   * full-outline RPC once. A host without the paged method keeps the previous
   * single-read behaviour instead of failing the open.
   */
  private async readOutlinePage(
    api: SourceSessionsApi,
    request: { sessionId: string; beforeAt?: number; beforeSeq?: number; epoch?: number; limit?: number },
    signal: AbortSignal,
  ): Promise<{ ok: true; value: SourceHistoryOutlinePageValue } | { ok: false; error: unknown }> {
    if (typeof api.sourceHistoryOutlinePage === 'function')
      return untilAborted(api.sourceHistoryOutlinePage(request), signal)
    const full = await untilAborted(api.sourceHistoryOutline({ sessionId: request.sessionId }), signal)
    if (!full.ok) return full
    return { ok: true, value: { ...full.value, hasMore: false, cursor: null, pageSize: 1 } }
  }

  /**
   * First directory page. Opening waits for this single bounded read only;
   * older pages continue in the background and only gate global navigation.
   */
  private async prefetchOutline(_required = false): Promise<void> {
    diagnosticMark('hapi-dsh:facade:outline-start')
    const startedAt = Date.now()
    const signal = this.outlineLifetime.signal
    try {
      const api = await this.owner.whenAttached(signal)
      // Bounded admission: a stalled first page must not hold the open
      // forever. Navigation degrades; the body keeps its own error channel.
      const admission = new AbortController()
      const relay = (): void => admission.abort(signal.reason ?? new Error('released'))
      if (signal.aborted) relay()
      else signal.addEventListener('abort', relay, { once: true })
      const admissionTimer = setTimeout(() => admission.abort(new Error('first directory page timeout')), 5_000)
      let first: SourceHistoryOutlinePageValue | undefined
      try {
        first = await this.readOutlinePageWithRetry(api, {}, admission.signal)
      } finally {
        clearTimeout(admissionTimer)
        signal.removeEventListener('abort', relay)
      }
      if (first === undefined || this.disposed) return
      this.outlinePages = 1
      this.applyOutline(first)
      this.refreshOutlineStatus(first)
      if (this.outlineStatus !== 'ready') {
        void this.continueOutline(api, first.cursor ?? undefined, 1, first.entries.length, Date.now())
      }
    } catch (error) {
      if (this.disposed || signal.aborted) return
      this.outlineStatus = 'degraded'
      this.outlineError = error instanceof Error ? error.message : String(error)
      this.publishOutlineState()
      // A later retain may retry the first page; the body never waits for it.
      this.outlinePromise = undefined
      this.recordOutlineFailure('first', 0, Date.now() - startedAt, error)
      console.warn('[hapi-dsh] source directory first page failed; body and paging stay available', error)
      this.session.publish()
      // A slow source is usually transient; keep recovering in the background
      // instead of leaving navigation degraded until the reader finds Retry.
      this.scheduleOutlineRecovery()
    }
  }

  /**
   * Direct source-window page read. Used when the official pager owns no page
   * for a synthetic or detached session; the facade then acts as its own page
   * provider and mirrors the page into the retained window.
   * @returns whether a page was merged.
   */
  private async loadOlderDirect(limit?: number): Promise<boolean> {
    const api = this.owner.api ?? await this.owner.whenAttached()
    if (this.disposed || !api) return false
    const endSeq = this.firstSeq() ?? SOURCE_WINDOW_SEQ_BASE
    const head = this.eventSource.getSnapshot().entries[0] as unknown as { source?: SourcePosition } | undefined
    const size = limit
    const cursor = this.target?.before ?? head?.source
    const request = cursor
      ? { sessionId: this.sessionId, beforeAt: cursor.at, beforeSeq: cursor.seq, endSeq, ...(size === undefined ? {} : { limit: size }),
        ...(this.target?.beforeEpoch === undefined ? {} : { epoch: this.target.beforeEpoch }),
        ...(this.target?.beforeMessageId === undefined ? {} : { cursorMessageId: this.target.beforeMessageId }) }
      : { sessionId: this.sessionId, fromOldest: true, endSeq, ...(size === undefined ? {} : { limit: size }) }
    const result = await api.sourceHistoryWindowPage(request)
    if (this.disposed) return false
    if (!result.ok) throw result.error
    const value = result.value
    if (!value.records.length) {
      this.hasMore = false
      if (this.target) this.target.hasMoreBefore = false
      return false
    }
    // A seedless synthetic pager can return the already resident suffix; a
    // page that adds no new event is not progress and must not be replayed.
    const current = this.eventSource.getSnapshot().entries
    const resident = new Set(current.map(entry => Number(entry.event.seq)))
    const residentSources = new Set(current.flatMap(entry => {
      const source = (entry as unknown as { source?: SourcePosition }).source
      return source ? [`${source.messageId}@${source.seq}`] : []
    }))
    const records = (value.records as SessionEventLikeEntry[]).filter(entry => {
      if (resident.has(Number(entry.event.seq))) return false
      const source = (entry as unknown as { source?: SourcePosition }).source
      return !(source && residentSources.has(`${source.messageId}@${source.seq}`))
    })
    if (!records.length) {
      this.hasMore = false
      if (this.target) this.target.hasMoreBefore = false
      return false
    }
    const retention = this.preparePageRetention(records)
    const pageRecords = this.normalizeEventData(records)
    this.eventSource.prepend(pageRecords, value.hasMoreBefore)
    this.hasMore = value.hasMoreBefore
    const priorAfter = this.target?.after, priorAfterEpoch = this.target?.afterEpoch
    const priorAfterMessageId = this.target?.afterMessageId
    const priorHasMoreAfter = this.target?.hasMoreAfter
    const priorWasTail = this.mode === 'tail'
    const merged = this.eventSource.getSnapshot().entries
    const sources = merged.flatMap(entry => {
      const source = (entry as unknown as { source?: SourcePosition }).source
      return source ? [source] : []
    })
    const first = sources[0], last = sources.at(-1)
    this.mode = 'target'
    this.target = {
      before: value.before,
      after: priorAfter ?? (last ? { at: last.at, seq: last.seq } : value.after),
      beforeEpoch: value.epoch,
      afterEpoch: priorAfterEpoch ?? last?.epoch ?? value.epoch,
      beforeMessageId: value.beforeMessageId,
      afterMessageId: priorAfterMessageId ?? last?.messageId ?? value.afterMessageId,
      hasMoreBefore: value.hasMoreBefore,
      hasMoreAfter: priorWasTail ? false : (priorHasMoreAfter ?? value.hasMoreAfter),
      firstSeq: merged[0]?.event.seq ?? null,
      lastSeq: merged.at(-1)?.event.seq ?? null,
      firstTurn: 0,
      lastTurn: this.maxTailTurn(),
    }
    void first
    this.pendingPage = retention.pending
    this.flushTail()
    this.trimWindow('older', retention.pins)
    return true
  }

  /**
   * The official pager discards the source cursor of the page it just merged.
   * Adopt it once from the same source page so the next Load earlier can cross
   * that page instead of early-returning on a null boundary. Cache-complete
   * windows skip this: they must not issue an extra page request.
   */
  private adoptOlderCursor(): void {
    const target = this.target
    if (this.disposed || this.adoptingOlderCursor || !target || target.before !== null || !target.hasMoreBefore) return
    this.adoptingOlderCursor = true
    void (async () => {
      try {
        const api = await this.owner.whenAttached()
        if (this.disposed || this.target?.before) return
        const endSeq = this.firstSeq() ?? SOURCE_WINDOW_SEQ_BASE
        const result = await api.sourceHistoryWindowPage({ sessionId: this.sessionId, fromOldest: true, endSeq })
        if (!result.ok || this.disposed) return
        if (this.target && !this.target.before) {
          this.target.before = result.value.before
          this.target.hasMoreBefore = result.value.hasMoreBefore
          this.hasMore = result.value.hasMoreBefore
          this.session.publish()
        }
      } catch { /* paging keeps its previous cursor */ } finally { this.adoptingOlderCursor = false }
    })()
  }

  /** Background completion of the directory, one bounded page at a time. */
  private async continueOutline(api: SourceSessionsApi, cursor: { at: number; seq: number } | undefined,
    pages: number, labels: number, started: number): Promise<void> {
    const signal = this.outlineLifetime.signal
    try {
      for (;;) {
        if (this.disposed) return
        if (pages >= 32 || Date.now() - started > 10_000 || labels >= 10_000) {
          this.outlineStatus = 'partial'
          this.session.publish()
          return
        }
        const next = await this.readOutlinePageWithRetry(api, cursor === undefined ? {} : { beforeAt: cursor.at, beforeSeq: cursor.seq }, signal)
        if (next === undefined || this.disposed) return
        pages += 1
        labels += next.entries.length
        this.outlinePages = next.pageSize ?? pages
        this.applyOutline(next)
        this.refreshOutlineStatus(next)
        if (this.outlineStatus === 'ready' || this.outlineStatus === 'degraded') return
        if (next.indexing === true) {
          // A legacy index can add labels above the read cursor. Wait for it
          // instead of treating the missing cursor as a stall.
          await delay(400, signal)
          continue
        }
        const following = next.cursor
        if (!following) { this.outlineStatus = 'degraded'; this.outlineError = 'cursor-stalled'; this.session.publish(); return }
        cursor = { at: following.at, seq: following.seq }
        this.session.publish()
      }
    } catch (error) {
      if (this.disposed || signal.aborted) return
      this.outlineStatus = 'degraded'
      this.outlineError = error instanceof Error ? error.message : String(error)
      this.recordOutlineFailure('continuation', pages, Date.now() - started, error)
      console.warn('[hapi-dsh] source directory continuation degraded; body and paging stay available', error)
      this.session.publish()
      this.scheduleOutlineRecovery()
    }
  }

  private async readOutlinePageWithRetry(api: SourceSessionsApi,
    request: { beforeAt?: number; beforeSeq?: number; epoch?: number },
    signal: AbortSignal): Promise<SourceHistoryOutlinePageValue | undefined> {
    let failures = 0
    for (;;) {
      try {
        const result = await this.readOutlinePage(api, { sessionId: this.sessionId, ...request }, signal)
        if (!result.ok) throw result.error
        return result.value
      } catch (error) {
        if (signal.aborted) throw error
        if (++failures >= 3) throw error
        await delay(failures === 1 ? 300 : 900, signal)
      }
    }
  }

  private publishOutlineState(): void {
    const next = { status: this.outlineStatus, pages: this.outlinePages, error: this.outlineError }
    const current = this.sourceOutline.getSnapshot()
    if (current.status === next.status && current.pages === next.pages && current.error === next.error) return
    this.sourceOutline.set(next)
  }

  /** Record one sanitized directory failure for diagnosis (no raw payloads). */
  private recordOutlineFailure(phase: 'first' | 'continuation', pages: number, durationMs: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const code = /timeout/i.test(message) ? 'timeout' : /abort/i.test(message) ? 'aborted' : 'rpc'
    this.outlineFailure = { phase, attempt: this.outlineRecoveryAttempt, pages, durationMs: Math.round(durationMs), code }
    console.warn(`[hapi-dsh] outline failure phase=${this.outlineFailure.phase} attempt=${this.outlineFailure.attempt} pages=${pages} durationMs=${this.outlineFailure.durationMs} code=${code} status=${this.outlineStatus}`)
  }

  /** Retry a degraded directory in the background with bounded backoff. */
  private scheduleOutlineRecovery(): void {
    if (this.disposed || this.outlineStatus === 'ready') return
    if (this.outlineRecoveryAttempt >= 3) {
      console.warn(`[hapi-dsh] outline recovery exhausted attempt=${this.outlineRecoveryAttempt} status=${this.outlineStatus}`)
      return
    }
    const attempt = this.outlineRecoveryAttempt++
    if (this.outlineTimer !== undefined) clearTimeout(this.outlineTimer)
    this.outlineTimer = setTimeout(() => {
      this.outlineTimer = undefined
      if (this.disposed || this.outlineStatus === 'ready') return
      console.warn(`[hapi-dsh] outline recovery starting attempt=${attempt} status=${this.outlineStatus} pages=${this.outlinePages}`)
      void this.retrySourceOutline().then(() => {
        console.warn(`[hapi-dsh] outline recovery result attempt=${attempt} status=${this.outlineStatus} pages=${this.outlinePages}`)
        if (this.outlineStatus !== 'ready' && this.outlineStatus !== 'degraded') this.scheduleOutlineRecovery()
      }).catch(() => { /* degraded is published; the next step retries */ })
    }, [2_000, 5_000, 10_000][attempt])
  }

  /** Retry the directory after a degradation; body and paging keep working. */
  async retrySourceOutline(): Promise<void> {
    if (this.disposed || this.outlineStatus === 'ready') return
    this.outlineStatus = 'none'
    this.outlineError = undefined
    this.outlinePromise = undefined
    this.publishOutlineState()
    const pending = this.ensureOutline()
    await pending.catch(() => { /* degraded is published */ })
  }

  private refreshOutlineStatus(value: SourceHistoryOutlinePageValue): void {
    if (value.unreadable === true) { this.outlineStatus = 'degraded'; this.outlineError = 'unreadable' }
    else if (value.indexing === true) { this.outlineStatus = 'partial'; this.outlineError = undefined }
    // Navigation is ready only when the source has no next page, reports the
    // directory complete, and is neither indexing nor unreadable.
    else if (value.hasMore !== true && value.complete === true) { this.outlineStatus = 'ready'; this.outlineError = undefined }
    else this.outlineStatus = 'partial'
    if (this.outlineStatus === 'ready') { this.outlineRecoveryAttempt = 0; this.outlineFailure = undefined }
    this.publishOutlineState()
    this.session.publish()
  }

  private applyOutline(value: SourceHistoryOutlineValue | SourceHistoryOutlinePageValue): void {
    this.owner.rememberHostOutline(this, value)
    // A provisional (indexing) reply may add labels above an already read
    // cursor. Keep the previous navigation ladder until a complete page lands.
    if (value.indexing === true && value.complete !== true) {
      this.sourceHead = value.head ?? this.sourceHead
      return
    }
    const all = hostsOutline(value)
    const newest = all[all.length - 1]
    this.newestOutline = newest
    this.sourceHead = value.head
    const older = all.filter(entry => value.firstTurn === undefined || value.firstTurn <= 0 || entry.turn < value.firstTurn)
    this.hostOutline = newest && !older.some(entry => entry.turn === newest.turn) ? [...older, newest] : older
    this.outline.set(mergeOutline(this.hostOutline, this.tailOutline))
  }

  private scheduleOutlineRefresh(): void {
    if (this.disposed || this.outlineRefreshes >= 2) return
    this.outlineRefreshes++
    this.outlineTimer = setTimeout(() => {
      if (!this.disposed) void this.prefetchOutline(false)
    }, this.outlineRefreshes === 1 ? 5_000 : 15_000)
  }

  private measureReaders(preserveFollowingViewport: boolean): {
    pins: SourceWindowPin[]; readers: Map<SourceWindowReader, SourceWindowPin | undefined>
  } {
    const entries = this.eventSource.getSnapshot().entries
    const pins: SourceWindowPin[] = []
    const readers = new Map<SourceWindowReader, SourceWindowPin | undefined>()
    let unknown = false
    for (const reader of this.windowReaders) {
      if (!reader.available()) continue
      const viewport = reader.read()
      const pin = viewport && pinSourceViewport(entries, viewport)
      readers.set(reader, pin)
      // One visible unknown pane must not be discarded for another pane's
      // locality, nor may a safety trim guess its invisible side.
      if (!pin) {
        unknown = true
        continue
      }
      pins.push(pin)
      if (viewport?.overscan) {
        const overscan = pinSourceViewport(entries, { ...viewport.overscan, followingTail: false })
        if (!overscan) unknown = true
        else pins.push(overscan)
      }
      // Following the tail permits receiving new rows; their source-row count
      // cannot prove that the currently rendered text has left the viewport.
      // Folded tools can add many rows without replacing that readable height.
      // Keep this measured interval until the next layout reports a new one.
      if (preserveFollowingViewport && pin.followingTail) pins.push({ ...pin, followingTail: false })
    }
    if (unknown) {
      const groups = sourceGroups(entries)
      return { readers, pins: groups.length ? [{ first: groups[0]!.key, last: groups.at(-1)!.key,
        visibleGroups: groups.length, followingTail: false, unknownGeometry: true }] : [] }
    }
    return { pins, readers }
  }

  private readerPins(preserveFollowingViewport = false): SourceWindowPin[] {
    const { pins, readers } = this.measureReaders(preserveFollowingViewport)
    const page = this.pendingPage
    if (page) {
      for (const [reader, before] of page.readers) {
        const after = readers.get(reader)
        // An unfinished folded step can extend its last source dependency
        // without moving the reader. Only a new leading boundary proves it.
        if (!readers.has(reader) || before && after && before.first !== after.first) {
          page.readers.delete(reader)
        } else if (!before && after) page.readers.set(reader, after)
      }
      if (page.readers.size) pins.push(page.pin)
      else this.pendingPage = undefined
    }
    return pins
  }

  private preparePageRetention(records: readonly SessionEventLikeEntry[]): {
    pins: SourceWindowPin[]; pending: SourcePageRetention | undefined
  } {
    const measured = this.measureReaders(false)
    const pins = protectSourcePage(records, measured.pins)
    // Keep only the last successful requested page. Repeated old DOM reads,
    // including prepend anchor restoration, do not prove the reader moved.
    return { pins, pending: pins.length > measured.pins.length
      ? { pin: pins.at(-1)!, readers: measured.readers } : undefined }
  }

  private retentionPlan(entries: readonly SessionEventLikeEntry[], pins: readonly SourceWindowPin[], direction: 'older' | 'newer') {
    return sourceRetentionPlan(entries, pins, direction, { events: MAX_SOURCE_EVENTS, bytes: MAX_SOURCE_BYTES, size: bytesOfEntry })
  }

  private retentionFits(entries: readonly SessionEventLikeEntry[], pins: readonly SourceWindowPin[], direction: 'older' | 'newer'): boolean {
    if (this.retentionPlan(entries, pins, direction).fits) return true
    diagnosticMark('hapi-dsh:source-window:visible-budget-conflict')
    console.error('[hapi-dsh] simultaneously visible source ranges exceed the retained window budget; preserving the current reader')
    return false
  }

  private trimWindow(direction: 'older' | 'newer', pins = this.readerPins()): void {
    const entries = this.eventSource.getSnapshot().entries
    if (entries.length === 0) return
    const plan = this.retentionPlan(entries, pins, direction)
    if (!plan.fits) return
    const { first, last } = plan
    const sourceOf = (entry: SessionEventLikeEntry | undefined): SourcePosition | undefined => {
      const index = entry ? entries.indexOf(entry) : -1
      return plan.groups.find(group => group.start <= index && index < group.end)?.source
    }
    const keep = entries.slice(first, last)
    const dropped = first > 0 || last < entries.length
    if (dropped) this.eventSource.replace(this.normalizeEventData(keep), this.eventSource.getSnapshot().hasMore)
    if (!this.target) return
    this.target.firstSeq = keep[0]?.event.seq ?? null
    this.target.lastSeq = keep[keep.length - 1]?.event.seq ?? null
    const turns = recordTurns(keep)
    this.target.firstTurn = turns.first ?? this.target.firstTurn
    this.target.lastTurn = turns.last ?? this.target.lastTurn
    if (!dropped) return
    if (last < entries.length && plan.groups.some(group => group.start >= last && group.content)) {
      let edge: SourcePosition | undefined
      for (let index = keep.length - 1; index >= 0; index--) { edge = sourceOf(keep[index]); if (edge) break }
      this.target.after = edge ? { at: edge.at, seq: edge.seq } : null
      this.target.afterEpoch = edge?.epoch
      this.target.afterMessageId = edge?.messageId
      this.target.hasMoreAfter = edge !== undefined
      this.liveGap = true
    }
    if (first > 0) {
      let edge: SourcePosition | undefined
      for (let index = 0; index < keep.length; index++) { edge = sourceOf(keep[index]); if (edge) break }
      this.target.before = edge ? { at: edge.at, seq: edge.seq } : null
      this.target.beforeEpoch = edge?.epoch
      this.target.beforeMessageId = edge?.messageId
      this.target.hasMoreBefore = edge !== undefined && first > 0
      if (edge) this.hasMore = true
    }
  }

  private firstSeq(): number | null {
    return this.eventSource.getSnapshot().entries[0]?.event.seq ?? null
  }

  private lastSeq(): number | null {
    const entries = this.eventSource.getSnapshot().entries
    return entries[entries.length - 1]?.event.seq ?? null
  }

  private maxTailTurn(): number {
    // Only resident base events prove content presence; a projection may name
    // a turn whose rows are absent from the current original event window.
    let value = -1
    for (const entry of this.tail.entries) {
      const data = entry.event.data as Record<string, unknown> | null
      if (data && typeof data.turn === 'number') value = Math.max(value, data.turn)
    }
    return value
  }

  async loadOlder(limit?: number): Promise<void> {
    try { performance.mark('hapi-dsh:loadOlder:called') } catch { /* diagnostics are optional */ }
    if (this.disposed || this.loadingOlder) {
      try { performance.mark(`hapi-dsh:loadOlder:busy:${this.disposed ? 'disposed' : 'loading'}`) } catch { /* optional */ }
      return
    }
    const target = this.target
    if (this.mode !== 'tail' && (!target?.before || !target.hasMoreBefore)) {
      try { performance.mark(`hapi-dsh:loadOlder:blocked:${this.mode}:${target?.before ? 'before' : 'nobefore'}:${String(target?.hasMoreBefore)}`) } catch { /* optional */ }
      console.warn(`[hapi-dsh] loadOlder blocked mode=${this.mode} before=${Boolean(target?.before)} hasMoreBefore=${String(target?.hasMoreBefore)} hasMore=${String(this.hasMore)} loadingOlder=${String(this.loadingOlder)}`)
      return
    }
    try { performance.mark('hapi-dsh:loadOlder:requesting') } catch { /* optional */ }
    const token = this.beginJump()
    this.loadingOlder = true
    this.session.publish()
    try {
      try { performance.mark('hapi-dsh:loadOlder:delegate') } catch { /* optional */ }
      // Older paging stays owned by the official ClientSession so the public
      // /api/session/page contract remains the single paging path; this facade
      // only mirrors, retains and anchors the resulting window.
      const beforeCount = this.eventSource.getSnapshot().entries.length
      if (limit !== undefined && this.mode !== 'tail') {
        // A measured viewport asks for an exact page size: the facade itself is
        // the only source-paging owner for that read.
        await this.loadOlderDirect(limit)
      } else if (this.mode === 'tail' && (this.firstSeq() ?? DISPLAY_SEQ_OFFSET) > DISPLAY_SEQ_OFFSET) {
        // The opening seed is a suffix of the retained source. Recover its
        // missing prefix through the official pager before any source-cursor
        // page may skip an unreceived event.
        await this.originalFace.loadOlder()
        if (this.disposed || token !== this.jump) return
        this.flushTail()
        this.adoptOlderCursor()
      } else if (this.mode === 'tail') {
        // A complete tail owns no seed prefix; the facade is its page provider.
        await this.loadOlderDirect(limit)
      } else {
        await this.originalFace.loadOlder()
        if (this.disposed || token !== this.jump) return
        this.flushTail()
        const grew = this.eventSource.getSnapshot().entries.length !== beforeCount
        if (grew) this.officialPagerWorks = true
        else if (!this.officialPagerWorks && this.hasMore) await this.loadOlderDirect(limit)
        this.adoptOlderCursor()
      }
    } catch (error) {
      if (this.disposed || token !== this.jump) return
      // A source read failure is not source exhaustion. Keep the current
      // view and cursor, and let the official pager report/retry this failure.
      throw error
    } finally {
      if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() }
    }
  }

  private learnTargetTurns(records: readonly SessionEventLikeEntry[]): void {
    for (const record of records) {
      if (!['plugin:hapi-dsh/native-item', 'plugin:hapi-dsh-observed/item'].includes(String(record.event.type))) continue
      const data = (record.event as unknown as { data?: Record<string, unknown> }).data
      const native = typeof data?.nativeTurnId === 'string' ? data.nativeTurnId : undefined
      const display = typeof data?.displayTurn === 'number' ? data.displayTurn : typeof data?.turn === 'number' ? data.turn : undefined
      if (native && display !== undefined) this.nativeTurns.set(native, display)
      const stepId = typeof data?.nativeStepId === 'string' ? data.nativeStepId
        : typeof data?.sourceStepId === 'string' ? data.sourceStepId : undefined
      if (stepId && typeof data?.displayStep === 'number' && data.displayStep > 0) {
        this.sourceSteps.set(stepId, data.displayStep)
        if (display !== undefined) this.sourceStepTurns.set(stepId, display)
      }
      if (display !== undefined) {
        const original = typeof data?.turn === 'number' ? data.turn : display
        this.originalTurns.set(original, display)
      }
    }
  }

  /** A forward read reserves no sequence space while it is in flight. Live
   * events can arrive first; assign page coordinates only at commit time. */
  private appendPage(records: readonly SessionEventLikeEntry[], pins: readonly SourceWindowPin[]): void {
    if (!records.length) return
    const resident = this.eventSource.getSnapshot()
    const sourceId = (row: SessionEventLikeEntry): string | undefined =>
      (row as unknown as { source?: { messageId: string } }).source?.messageId
    const known = new Set(resident.entries.map(sourceId).filter((id): id is string => id !== undefined))
    const fresh = records.filter(row => !sourceId(row) || !known.has(sourceId(row)!))
    if (!fresh.length) return
    const first = (this.lastSeq() ?? SOURCE_WINDOW_SEQ_BASE) + 1
    const seqs = new Map(fresh.map((row, index) => [Number(row.event.seq), first + index]))
    const mapped = fresh.map((row, index) => {
      const raw = row.event as unknown as Record<string, unknown>
      const data = raw.data as Record<string, unknown> | null
      const event = { ...raw, seq: first + index } as Record<string, unknown>
      if (data && typeof data.surfaceSeq === 'number') event.data = { ...data, surfaceSeq: seqs.get(data.surfaceSeq) ?? data.surfaceSeq }
      if (Array.isArray(raw.sourceEventSeqs)) event.sourceEventSeqs = raw.sourceEventSeqs.map(value => seqs.get(Number(value)) ?? value)
      if (raw.surfaceOp && typeof raw.surfaceOp === 'object') {
        const op = raw.surfaceOp as Record<string, unknown>
        event.surfaceOp = { ...op,
          ...(typeof op.startSeq === 'number' ? { startSeq: seqs.get(op.startSeq) ?? op.startSeq } : {}),
          ...(typeof op.endSeq === 'number' ? { endSeq: seqs.get(op.endSeq) ?? op.endSeq } : {}) }
      }
      return { ...row, event } as unknown as SessionEventLikeEntry
    })
    if (!this.retentionFits([...resident.entries, ...mapped], pins, 'newer')) {
      throw new Error('The visible source ranges exceed the retained window budget')
    }
    if (hasLateSourceRows(resident.entries, mapped)) {
      this.eventSource.replace(orderSourceWindow([...resident.entries, ...mapped]), resident.hasMore)
    } else for (const row of mapped) this.eventSource.append(row)
    this.learnTargetTurns(mapped)
    if (this.target) this.target.lastSeq = this.lastSeq()
  }

  private async loadForward(hostTurn: number, token: number): Promise<void> {
    const api = await this.owner.whenAttached()
    const target = this.target
    if (!target) return
    for (let page = 0; page < 8 && target.lastTurn < hostTurn && target.after && target.hasMoreAfter; page++) {
      if (!await this.readForwardPage(api, target, token)) return
      this.session.publish()
    }
  }

  private async readForwardPage(api: SourceSessionsApi, target: SourceWindowState, token: number): Promise<boolean> {
    if (!target.after) return false
    // Rejected live rows are recovered from the source, not an unbounded
    // client queue. Capture arrivals during this repair so finishing the page
    // cannot lose the messages that arrived after its snapshot was taken.
    const capture = this.liveGap ? this.captureLive() : undefined
    let advanced = false
    const request = { sessionId: this.sessionId, afterAt: target.after.at,
      ...(target.afterEpoch === undefined ? {} : { epoch: target.afterEpoch }),
      ...(target.afterMessageId === undefined ? {} : { cursorMessageId: target.afterMessageId }),
      afterSeq: target.after.seq, startSeq: (target.lastSeq ?? SOURCE_WINDOW_SEQ_BASE) + 1 }
    const commit = (value: SourceHistoryWindowValue): void => {
      const records = value.records as SessionEventLikeEntry[]
      advanced = records.length > 0
      const retention = records.length ? this.preparePageRetention(records)
        : { pins: this.readerPins(), pending: this.pendingPage }
      const pins = retention.pins
      this.appendPage(records, pins)
      if (records.length) this.pendingPage = retention.pending
      // An empty authoritative page confirms exhaustion, not deletion of the
      // last committed source edge needed by a later live-gap recovery.
      if (value.after) {
        target.after = value.after
        target.afterEpoch = value.epoch
        target.afterMessageId = value.afterMessageId
      }
      target.hasMoreAfter = value.hasMoreAfter
      target.lastSeq = this.lastSeq()
      const turns = recordTurns(records)
      if (turns.last !== undefined) target.lastTurn = Math.max(target.lastTurn, turns.last)
      if (capture) this.liveGap = value.hasMoreAfter
      this.trimWindow('newer', pins)
      if (capture) {
        this.liveGap ||= target.hasMoreAfter
        capture.committed = this.eventSource.getSnapshot().entries
      }
    }
    try {
      if (capture) return await this.readCapturedWindow(api, request, capture, token, commit, undefined, true) && advanced
      const result = await api.sourceHistoryWindowPage(request)
      if (this.disposed || token !== this.jump) return false
      if (!result.ok) throw result.error
      if (!result.value.records.length) { target.hasMoreAfter = false; return false }
      commit(result.value)
      return true
    } finally { this.finishLiveCapture(capture) }
  }

  async loadThrough(seq: SessionSeq): Promise<void> {
    if (this.disposed) return
    // loadThrough is an ensure operation. Reading restoration and official
    // navigation may repeat it after layout; a resident target needs no new
    // window, generation or network request.
    if (this.eventSource.getSnapshot().entries.some(row => Number(row.event.seq) === seq)) return
    const host = this.hostOutline?.find(entry => entry.seq === seq)
    if (!host) {
      // A tail-projection route is already resident in the original window;
      // returning to it preserves live follow and the same editor/binding.
      if (this.tailOutline.some(entry => entry.seq === seq)) { this.showTail(); return }
      const api = this.owner.api ?? await this.owner.whenAttached()
      const localSource = (this.eventSource.getSnapshot().entries.find(row => Number(row.event.seq) === seq) as
        unknown as { source?: { messageId: string } } | undefined)?.source
      const anchorResult = localSource ? { ok: true as const, value: { sourceMessageId: localSource.messageId } } : api.sourceReadingAnchor
        ? await api.sourceReadingAnchor({ sessionId: this.sessionId, seq }) : undefined
      if (this.disposed) return
      const anchor = anchorResult?.ok ? anchorResult.value : undefined
      if (!anchor?.sourceMessageId) {
        if (this.disposed) return
        if (this.mode === 'target') this.showTail()
        await this.originalFace.loadThrough(seq)
        return
      }
      const token = this.beginJump()
      const capture = this.captureLive()
      this.loadingOlder = true
      this.session.publish()
      try {
        const startSeq = SOURCE_WINDOW_SEQ_BASE + (++this.nextWindow) * 1_000_000
        await this.readCapturedWindow(api, { sessionId: this.sessionId, messageId: anchor.sourceMessageId, radius: 50, startSeq }, capture, token, value => {
          const records = value.records as SessionEventLikeEntry[], turns = recordTurns(records)
          this.mode = 'target'
          this.eventSource.replace(records, value.hasMoreBefore)
          this.target = { before: value.before, after: value.after, hasMoreBefore: value.hasMoreBefore,
            beforeEpoch: value.beforeEpoch, afterEpoch: value.afterEpoch,
            beforeMessageId: value.beforeMessageId, afterMessageId: value.afterMessageId,
            hasMoreAfter: value.hasMoreAfter, firstSeq: records[0]!.event.seq, lastSeq: records[records.length - 1]!.event.seq,
            firstTurn: turns.first ?? 0, lastTurn: turns.last ?? 0 }
          this.initializeWindowLive(records, capture)
          this.hasMore = value.hasMoreBefore
        })
      } catch (error) { console.warn('[hapi-dsh] direct source window failed', error) }
      finally {
        this.finishLiveCapture(capture)
        if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() }
      }
      return
    }
    const maxHost = Math.max(...(this.hostOutline ?? []).map(entry => entry.turn))
    if (host.turn >= maxHost && host.turn <= this.maxTailTurn()) { this.showTail(); return }
    const outline = this.owner.outlineFor(this, host)
    const api = this.owner.api ?? await this.owner.whenAttached()
    if (!outline) return
    if (this.mode === 'target' && this.target) {
      if (host.turn >= this.target.firstTurn && host.turn <= this.target.lastTurn) return
      if (host.turn > this.target.lastTurn && this.target.after && this.target.hasMoreAfter) {
        const token = this.beginJump()
        this.loadingOlder = true
        this.session.publish()
        try { await this.loadForward(host.turn, token) } catch (error) { console.warn('[hapi-dsh] forward source window failed', error) }
        finally { if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() } }
        if (this.disposed || !this.target || host.turn <= this.target.lastTurn) return
      }
    }
    const token = this.beginJump()
    const capture = this.captureLive()
    this.loadingOlder = true
    this.session.publish()
    try {
      const startSeq = SOURCE_WINDOW_SEQ_BASE + (++this.nextWindow) * 1_000_000
      await this.readCapturedWindow(api, { sessionId: this.sessionId, messageId: outline.messageId,
        radius: 50, startSeq }, capture, token, value => {
        const records = value.records as SessionEventLikeEntry[], turns = recordTurns(records)
        this.mode = 'target'
        this.eventSource.replace(records, value.hasMoreBefore)
        this.target = {
          before: value.before, after: value.after, hasMoreBefore: value.hasMoreBefore, hasMoreAfter: value.hasMoreAfter,
          beforeEpoch: value.beforeEpoch, afterEpoch: value.afterEpoch,
          beforeMessageId: value.beforeMessageId, afterMessageId: value.afterMessageId,
          firstSeq: records[0]!.event.seq, lastSeq: records[records.length - 1]!.event.seq,
          firstTurn: turns.first ?? host.turn, lastTurn: turns.last ?? host.turn,
        }
        this.initializeWindowLive(records, capture)
        this.hasMore = value.hasMoreBefore
      })
    } catch (error) {
      console.warn('[hapi-dsh] direct source window failed', error)
    } finally {
      this.finishLiveCapture(capture)
      if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() }
    }
  }

  /** One normal downward page at the bottom of a detached target window. */
  async loadAfterPage(): Promise<boolean> {
    if (this.disposed || (this.mode !== 'target' && this.mode !== 'latest') || !this.target) return false
    const target = this.target
    if (!target.after || !target.hasMoreAfter || this.loadingOlder) {
      if (process.env.HAPI_DSH_DEBUG_PAGING) console.warn(`[paging] loadAfter blocked mode=${this.mode} after=${Boolean(target.after)} hasMoreAfter=${String(target.hasMoreAfter)} entries=${this.eventSource.getSnapshot().entries.length}`)
      return false
    }
    const token = this.beginJump()
    this.loadingOlder = true
    this.session.publish()
    try {
      const api = this.owner.api ?? await this.owner.whenAttached()
      if (this.disposed || token !== this.jump) return false
      return await this.readForwardPage(api, target, token)
    } catch (error) {
      console.warn('[hapi-dsh] forward source window failed', error)
      return false
    } finally {
      if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() }
    }
  }

  /** Explicit latest intent from the official to-bottom control. */
  returnToLive(signal?: AbortSignal): boolean | Promise<boolean> {
    if (this.disposed || signal?.aborted) return false
    // A resident window already ending at the live tail is authoritative; an
    // explicit latest intent must keep it instead of replacing it with a
    // shorter fresh page.
    if (this.mode !== 'tail' && this.tail.entries.length > 0) {
      const tailLast = this.tail.entries[this.tail.entries.length - 1]
      const windowLast = this.eventSource.getSnapshot().entries.at(-1)
      if (tailLast !== undefined && windowLast !== undefined
        && Number(tailLast.event.seq) === Number(windowLast.event.seq)) return true
    }
    // Explicit latest always reads the authoritative source head by identity.
    // It never compares outline ordinals with native display turns, and never
    // assumes the resident original tail is current.
    if (this.sourceHead) {
      return this.loadNewest(this.newestOutline, signal)
    }
    if (this.mode === 'tail') return false
    this.showTail()
    return true
  }

  private async loadNewest(entry?: SourceOutlineValue, signal?: AbortSignal): Promise<boolean> {
    const api = this.owner.api ?? await this.owner.whenAttached()
    if (this.disposed || signal?.aborted) return false
    const token = this.beginJump()
    const capture = this.captureLive()
    const abort = (): void => {
      if (this.disposed || token !== this.jump) return
      this.beginJump()
      this.loadingOlder = false
      this.session.publish()
    }
    signal?.addEventListener('abort', abort, { once: true })
    this.loadingOlder = true
    this.session.publish()
    try {
      // Explicit latest is the freshness boundary: the stored outline/head may
      // be older than the 5s/15s refresh after a long reading session. Re-read
      // the bounded source outline/head now; never poll, never read the archive.
      // A failed/incomplete refresh must preserve the current reading window and
      // must not present the old head as latest.
      try {
        const fresh = await this.readOutlinePage(api, { sessionId: this.sessionId }, signal ?? new AbortController().signal)
        if (this.disposed || token !== this.jump) return false
        if (!fresh.ok) throw fresh.error
        // A partial directory still carries the authoritative head and the
        // newest labels; only global jump/search stays unavailable.
        this.applyOutline(fresh.value)
      } catch (error) {
        if (this.disposed || token !== this.jump) return false
        diagnosticMark('hapi-dsh:facade:latest-refresh-failed')
        console.warn('[hapi-dsh] latest source head refresh failed; preserving the current window', error)
        return false
      }
      const messageId = this.sourceHead?.messageId
      if (!messageId) return false
      // The source head proves freshness. If it is already in this retained
      // window, the official to-bottom action can reuse that same window.
      // Replacing it with a short raw page can collapse folded tool history
      // into a non-scrollable view and discard history the reader just loaded.
      const resident = this.eventSource.getSnapshot().entries
      const headResident = resident.some(row => {
        const source = (row as unknown as { source?: { messageId: string } }).source
        const data = row.event.data as Record<string, unknown> | null
        return source?.messageId === messageId
          || (String(row.event.type) === 'plugin:hapi-dsh/native-item' && data?.sourceMessageId === messageId)
          || (String(row.event.type) === 'plugin:hapi-dsh-observed/item' && data?.sourceRowId === messageId)
      })
      if (headResident && (!this.target || !this.target.hasMoreAfter)) {
        this.pendingPage = undefined
        if (this.target) this.mode = 'latest'
        return true
      }
      const startSeq = SOURCE_WINDOW_SEQ_BASE + (++this.nextWindow) * 1_000_000
      return await this.readCapturedWindow(api, { sessionId: this.sessionId, messageId, radius: 79, startSeq }, capture, token, value => {
        const records = value.records as SessionEventLikeEntry[], turns = recordTurns(records)
        this.mode = 'latest'
        this.eventSource.replace(records, value.hasMoreBefore)
        this.target = {
          before: value.before, after: value.after, hasMoreBefore: value.hasMoreBefore,
          beforeEpoch: value.beforeEpoch, afterEpoch: value.afterEpoch,
          beforeMessageId: value.beforeMessageId, afterMessageId: value.afterMessageId,
          hasMoreAfter: value.hasMoreAfter, firstSeq: records[0]!.event.seq,
          lastSeq: records[records.length - 1]!.event.seq,
          firstTurn: turns.first ?? entry?.turn ?? 0, lastTurn: turns.last ?? entry?.turn ?? 0,
        }
        this.initializeWindowLive(records, capture)
        this.hasMore = value.hasMoreBefore
      }, value => this.prepareLatestWindow(api, value, token))
    } catch (error) {
      if (!this.disposed && token === this.jump) console.warn('[hapi-dsh] newest source window failed', error)
      return false
    } finally {
      signal?.removeEventListener('abort', abort)
      // Success merges into the new window; failure merges into the unchanged
      // reader window. Superseded operations no longer own this capture.
      this.finishLiveCapture(capture)
      if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() }
    }
  }

  registerWindowReader(reader: SourceWindowReader): () => void {
    this.windowReaders.add(reader)
    return () => {
      this.windowReaders.delete(reader)
      this.pendingPage?.readers.delete(reader)
      if (this.pendingPage?.readers.size === 0) this.pendingPage = undefined
    }
  }

  registerWindowPreparer(preparer: SourceWindowPreparer): () => void {
    this.hadWindowPreparer = true
    this.windowPreparers.add(preparer)
    return () => {
      this.windowPreparers.delete(preparer)
      if (this.preparation?.preparer === preparer) this.preparation.controller.abort()
    }
  }

  /** A mounted reader admits latest with the same official chat renderer before
   * its existing binding changes. Initial admission still belongs to SessionView. */
  private async prepareLatestWindow(api: SourceSessionsApi, value: SourceHistoryWindowValue, token: number): Promise<PreparedWindowValue | undefined> {
    if (!this.hadWindowPreparer) return preparedWindowValue(value)
    await this.preparation?.done
    if (this.disposed || token !== this.jump) return undefined
    const preparer = [...this.windowPreparers].find(item => item.available())
    if (!preparer) return undefined
    const controller = new AbortController()
    const done = (async (): Promise<PreparedWindowValue | undefined> => {
      const candidate = this.owner.createWindowCandidate(this, api, value, controller.signal)
      try {
        await candidate.reference.ready
        if (controller.signal.aborted || !preparer.available()) return undefined
        if (!await preparer.prepare(candidate.reference, controller.signal) || controller.signal.aborted) return undefined
        return candidate.value()
      } finally { await candidate.dispose() }
    })()
    const operation = { controller, done, preparer }
    this.preparation = operation
    try { return await done }
    finally { if (this.preparation === operation) this.preparation = undefined }
  }

  private showTail(): void {
    this.beginJump()
    this.pendingPage = undefined
    const binding = this.liveBinding()
    if (binding) this.rebind(binding)
    this.mode = 'tail'
    this.liveGap = false
    this.target = undefined
    this.nativeTurns.clear(); this.originalTurns.clear(); this.sourceSteps.clear(); this.sourceStepTurns.clear(); this.originalSteps.clear(); this.originalSeqs.clear()
    this.tail = this.originalEventSource.getSnapshot()
    this.tailNeedsResync = false
    this.eventSource.replace(this.tail.entries, this.tail.hasMore)
    this.hasMore = this.tail.hasMore
    this.loadingOlder = false
    this.session.publish()
  }

  publish(): void {
    const hasMoreAfter = !this.disposed && (this.target?.hasMoreAfter ?? false)
    if (this.sourceWindow.getSnapshot().hasMoreAfter !== hasMoreAfter) this.sourceWindow.set({ hasMoreAfter })
    const base = this.originalFace.getSnapshot()
    const next = { ...base, hasMore: this.hasMore, loadingOlder: this.loadingOlder }
    if (sameLifecycle(next, this.snapshot)) return
    this.snapshot = next
    for (const listener of [...this.snapshotListeners]) {
      try { listener() } catch (error) { console.error('[hapi-dsh] source session listener failed', error) }
    }
  }
}

class SourceSession implements SessionFace, SourceViewportSession {
  readonly projections: ProjectionsFace
  get sourceWindow(): SourceViewportSession['sourceWindow'] { return this.record.sourceWindow }
  get sourceOutline(): SourceViewportSession['sourceOutline'] { return this.record.sourceOutline }
  retrySourceOutline(): Promise<void> { return this.record.retrySourceOutline() }
  constructor(private readonly record: SourceRecord) {
    const outline = record.outline
    this.projections = {
      faceOf: (key: string) => key === 'turnOutline' ? outline : this.record.originalFace.projections.faceOf(key),
    }
  }
  get sessionId(): SessionId { return this.record.sessionId }
  beginSubmission(...args: Parameters<SessionFace['beginSubmission']>): ReturnType<SessionFace['beginSubmission']> {
    return this.record.originalFace.beginSubmission(...args)
  }
  prompt(...args: Parameters<SessionFace['prompt']>): ReturnType<SessionFace['prompt']> { return this.record.originalFace.prompt(...args) }
  readAttachment(...args: Parameters<SessionFace['readAttachment']>): ReturnType<SessionFace['readAttachment']> {
    const [attachmentId] = args
    return readSourceAttachmentWithFallback(
      () => this.record.originalFace.readAttachment(...args),
      async () => {
        // Only the official "not in this log" denial reaches the source page
        // adapter. Every other authorization/storage failure stays official.
        const api = this.record.owner.api
        if (!api?.sourceHistoryAttachment || this.record.disposed) return undefined
        const result = await api.sourceHistoryAttachment({
          sessionId: this.sessionId,
          attachmentId: String(attachmentId),
        })
        if (!result.ok || this.record.disposed) return undefined
        try { return { ok: true as const, value: decodeSourceAttachmentValue(result.value) } }
        catch { return undefined }
      },
    )
  }
  updateQueue(...args: Parameters<SessionFace['updateQueue']>): ReturnType<SessionFace['updateQueue']> { return this.record.originalFace.updateQueue(...args) }
  cancel(...args: Parameters<SessionFace['cancel']>): ReturnType<SessionFace['cancel']> { return this.record.originalFace.cancel(...args) }
  rename(...args: Parameters<SessionFace['rename']>): ReturnType<SessionFace['rename']> { return this.record.originalFace.rename(...args) }
  command(...args: Parameters<SessionFace['command']>): ReturnType<SessionFace['command']> { return this.record.originalFace.command(...args) }
  loadOlder(): Promise<void> { return this.record.loadOlder() }
  /** The caller sizes a bounded page from the official viewport's measured deficit. */
  loadViewportPage(limit = 20): Promise<void> { return this.record.loadOlder(limit) }
  registerWindowPreparer(preparer: SourceWindowPreparer): () => void { return this.record.registerWindowPreparer(preparer) }
  registerWindowReader(reader: SourceWindowReader): () => void { return this.record.registerWindowReader(reader) }
  loadThrough(seq: SessionSeq): Promise<void> { return this.record.loadThrough(seq) }
  /** Normal downward reading; not part of the pinned ISession contract. */
  loadAfter(): Promise<boolean> { return this.record.loadAfterPage() }
  /** Explicit latest intent; not part of the pinned ISession contract. */
  returnToLive(signal?: AbortSignal): boolean | Promise<boolean> { return this.record.returnToLive(signal) }
  getSnapshot(): SessionSnapshot { return this.record.snapshot }
  subscribe(listener: () => void): () => void {
    this.record.snapshotListeners.add(listener)
    return () => { this.record.snapshotListeners.delete(listener) }
  }
  publish(): void { this.record.publish() }
}

/** Temporary read-only face for measuring an official chat window. It owns no
 * native lease, trigger scope, stream, or control path. */
class WindowCandidateSession extends SourceSession {
  readonly eventSource = new MutableSessionEventSource()
  private readonly state: ValueSource<SessionSnapshot>
  private value: PreparedWindowValue
  private pages = 0
  constructor(readonly alias: SessionId, private readonly source: SourceRecord, private readonly api: SourceSessionsApi,
    value: SourceHistoryWindowValue, private readonly signal: AbortSignal) {
    super(source)
    this.value = preparedWindowValue(value)
    this.eventSource.replace(value.records as SessionEventLikeEntry[], value.hasMoreBefore)
    this.state = new ValueSource({ ...source.snapshot, sessionId: alias, loadingOlder: false, hasMore: value.hasMoreBefore })
  }
  override get sessionId(): SessionId { return this.alias }
  override getSnapshot(): SessionSnapshot { return this.state.getSnapshot() }
  override subscribe(listener: () => void): () => void { return this.state.subscribe(listener) }
  override readAttachment(...args: Parameters<SessionFace['readAttachment']>): ReturnType<SessionFace['readAttachment']> {
    return this.source.session.readAttachment(...args)
  }
  override beginSubmission(): never { throw new Error('A window candidate is read-only') }
  override prompt(): never { throw new Error('A window candidate is read-only') }
  override updateQueue(): never { throw new Error('A window candidate is read-only') }
  override cancel(): never { throw new Error('A window candidate is read-only') }
  override rename(): never { throw new Error('A window candidate is read-only') }
  override command(): never { throw new Error('A window candidate is read-only') }
  override loadThrough(): Promise<void> { return Promise.resolve() }
  override returnToLive(): boolean { return false }
  override loadAfter(): Promise<boolean> { return Promise.resolve(false) }
  override registerWindowPreparer(): () => void { return () => {} }
  override registerWindowReader(): () => void { return () => {} }
  override publish(): void {}
  override loadOlder(): Promise<void> { return this.loadViewportPage() }
  override async loadViewportPage(limit = 20): Promise<void> {
    const state = this.state.getSnapshot(), before = this.value.before
    if (this.signal.aborted || state.loadingOlder || !state.hasMore || !before) return
    if (++this.pages > 12) throw new Error('The candidate viewport exceeded its bounded page budget')
    this.state.set({ ...state, loadingOlder: true })
    try {
      const retained = this.eventSource.getSnapshot().entries
      const result = await this.api.sourceHistoryWindowPage({ sessionId: this.source.sessionId,
        ...(this.value.beforeEpoch === undefined ? {} : { epoch: this.value.beforeEpoch }),
        ...(this.value.beforeMessageId === undefined ? {} : { cursorMessageId: this.value.beforeMessageId }),
        beforeAt: before.at, beforeSeq: before.seq, endSeq: Number(retained[0]?.event.seq), limit })
      if (this.signal.aborted) return
      if (!result.ok) throw result.error
      const records = result.value.records as SessionEventLikeEntry[]
      if (!records.length && result.value.hasMoreBefore) throw new Error('The candidate source cursor did not advance')
      const merged = [...records, ...retained]
      if (merged.length > MAX_SOURCE_EVENTS || merged.reduce((bytes, row) => bytes + bytesOfEntry(row), 0) > MAX_SOURCE_BYTES) {
        throw new Error('The candidate viewport exceeded its retained window budget')
      }
      this.value = { ...this.value, records: merged, before: result.value.before, hasMoreBefore: result.value.hasMoreBefore,
        beforeEpoch: result.value.epoch, beforeMessageId: result.value.beforeMessageId }
      this.eventSource.prepend(records, result.value.hasMoreBefore)
    } finally {
      this.state.set({ ...this.state.getSnapshot(), loadingOlder: false, hasMore: this.value.hasMoreBefore })
    }
  }
  windowValue(): PreparedWindowValue { return this.value }
}

class SourceReference implements SourcePreparationReference {
  [Symbol.dispose](): void { this.release() }
  constructor(readonly sessionId: SessionId, readonly binding: SessionBinding, readonly ready: Promise<SessionBinding>,
    private readonly releaseRecord: () => void, readonly preparationReady: Promise<SessionBinding> = ready) {}
  release(): void { this.releaseRecord() }
}

/** Routing ISessions facade: ordinary sessions delegate; HAPI displays are bounded source faces. */
export class SourceSessions implements ISessions {
  private readonly records = new Map<SessionId, SourceRecord>()
  private readonly candidates = new Map<SessionId, SessionBinding>()
  private candidateSequence = 0
  api: SourceSessionsApi | undefined
  private readonly attached: Promise<void>
  private attachedResolve: (() => void) | undefined
  /** Host outline entry identity, kept beside the wire projection. */
  readonly hostEntries = new WeakMap<SourceRecord, ReadonlyMap<number, { messageId: string }>>()
  constructor(private readonly original: ISessions) {
    this.attached = new Promise(resolve => { this.attachedResolve = resolve })
  }

  get list(): ISessions['list'] { return this.original.list }
  get searchResultLimit(): number { return this.original.searchResultLimit }

  attach(api: SourceSessionsApi): void {
    this.api = api
    this.attachedResolve?.()
  }

  /** The HAPI Remote namespace is attached by the product client entry. */
  async whenAttached(signal?: AbortSignal): Promise<SourceSessionsApi> {
    signal?.throwIfAborted()
    if (this.api) return this.api
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const attached = Promise.race([this.attached, new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The HAPI Remote API did not attach; source-only history cannot be loaded')), 30_000)
      })])
      await (signal ? untilAborted(attached, signal) : attached)
    } finally { if (timer !== undefined) clearTimeout(timer) }
    if (!this.api) throw new Error('The HAPI Remote API is unavailable')
    return this.api
  }

  outlineFor(record: SourceRecord, entry: SourceOutlineValue): { messageId: string } | undefined {
    return this.hostEntries.get(record)?.get(entry.seq)
  }

  messageIdFor(record: SourceRecord, entry: SourceOutlineValue): string | undefined {
    return this.hostEntries.get(record)?.get(entry.seq)?.messageId
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    if (typeof target !== 'string' || !isSourceDisplayId(target)) return this.original.retain(target, options)
    // Every caller owns one original lease with its own public source label;
    // all leases share one stable custom binding.
    const original = this.original.retain(target, options)
    let record = this.records.get(target)
    if (record === undefined) {
      record = new SourceRecord(this, target, original)
      this.records.set(target, record)
      this.hostEntries.set(record, new Map())
    } else record.addReference(original)
    let released = false
    const preparationReady = record.preparationReadyFor(original)
    const ready = record.readyFor(preparationReady)
    void ready.catch(() => {})
    return new SourceReference(target, record.binding, ready, () => {
      if (released) return
      released = true
      record.releaseReference(original)
      if (record.references <= 0) this.retire(target, record)
    }, preparationReady)
  }

  async using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T> {
    if (typeof target !== 'string' || !isSourceDisplayId(target)) return this.original.using(target, options, operation)
    const reference = this.retain(target, options)
    try { return await operation(reference) } finally { reference.release() }
  }

  retainInfo(id: SessionId): { getSnapshot(): SessionRetainInfo; subscribe(listener: () => void): () => void } {
    return this.original.retainInfo(id)
  }

  create(...args: Parameters<ISessions['create']>): ReturnType<ISessions['create']> { return this.original.create(...args) }
  subagentAddress(...args: Parameters<ISessions['subagentAddress']>): ReturnType<ISessions['subagentAddress']> { return this.original.subagentAddress(...args) }
  refreshProjections(...args: Parameters<ISessions['refreshProjections']>): ReturnType<ISessions['refreshProjections']> { return this.original.refreshProjections(...args) }
  refresh(): Promise<void> { return this.original.refresh() }
  search(...args: Parameters<ISessions['search']>): ReturnType<ISessions['search']> { return this.original.search(...args) }
  fork(...args: Parameters<ISessions['fork']>): ReturnType<ISessions['fork']> { return this.original.fork(...args) }

  scope(id: SessionId) { return this.candidates.get(id)?.ctx ?? this.original.scope(id) }
  scopeOf(ctx: Parameters<ISessions['scopeOf']>[0]) { return this.original.scopeOf(ctx) }
  sessionOf(ctx: Parameters<ISessions['sessionOf']>[0]): SessionFace | undefined {
    const id = this.original.scopeOf(ctx)
    if (id === undefined) return undefined
    return this.records.get(id)?.session ?? this.original.sessionOf(ctx)
  }
  binding(id: SessionId): SessionBinding | undefined {
    return this.candidates.get(id) ?? this.records.get(id)?.binding ?? this.original.binding(id)
  }

  /** Borrowed local alias for the public SessionProvider identity contract.
   * Starting at root deliberately omits native session tags and scoped Remote:
   * the input shell cannot create a native trigger/controller for this reader. */
  createWindowCandidate(record: SourceRecord, api: SourceSessionsApi, value: SourceHistoryWindowValue, signal: AbortSignal) {
    const alias = `hapi-window-candidate-${++this.candidateSequence}` as SessionId
    const session = new WindowCandidateSession(alias, record, api, value, signal)
    const originalContext = record.binding.ctx as Context
    const scope = originalContext.root.extend({ [Context.isolate]: Object.create(originalContext[Context.isolate]) }).isolate('sessions')
    const fiber = scope.plugin({ name: 'hapi-window-candidate', apply: (ctx: Context) => { ctx.reflect.provide('sessions', this) } })
    const binding: SessionBinding = { sessionId: alias, session, eventSource: session.eventSource, ctx: fiber.ctx as SessionBinding['ctx'] }
    this.candidates.set(alias, binding)
    const ready = Promise.resolve(fiber).then(() => binding)
    void ready.catch(() => {})
    const reference = new SourceReference(alias, binding, ready, () => {})
    return { reference, value: () => session.windowValue(), dispose: async () => {
      this.candidates.delete(alias)
      await fiber.dispose()
    } }
  }

  dispose(): void {
    for (const [id, record] of [...this.records]) {
      this.records.delete(id)
      this.hostEntries.delete(record)
      record.forceRelease()
    }
    this.api = undefined
  }

  private retire(id: SessionId, record: SourceRecord): void {
    if (this.records.get(id) !== record) return
    this.records.delete(id)
    this.hostEntries.delete(record)
    record.retire()
  }

  /** Called by SourceRecord after the Host outline resolves. */
  rememberHostOutline(record: SourceRecord, value: SourceHistoryOutlineValue): void {
    const entries = new Map<number, { messageId: string }>()
    for (const entry of value.entries) entries.set(entry.seq, { messageId: entry.messageId })
    this.hostEntries.set(record, entries)
  }
}
