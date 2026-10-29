/**
 * Public client Session composition for original HAPI transcripts.
 *
 * The official ClientSessions owner remains the only lease/lifecycle/native
 * control owner. For a HAPI display identity this facade returns one stable
 * SessionFace/binding/eventSource per original source lifetime, delegates every
 * native verb to that original face, and replaces only the data window:
 *
 * - one resident source-identity history, read through an independent body feed;
 * - a HAPI-shaped persistent event window for Conversation;
 * - a source-wide official `turnOutline` projection;
 * - direct source-identity `loadThrough` and bounded older/forward pages.
 *
 * Ordinary DSH sessions pass through unchanged. No upstream object, prototype,
 * private field, or node_modules file is mutated.
 */
import { Context } from '@deepseek-ai/cordis'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ISessions, ProjectionsFace, SessionBinding, SessionEventChange, SessionEventLikeEntry, SessionEventSource,
  SessionFace, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionSnapshot, SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SourceHistoryOutlinePageValue, SourceHistoryOutlineValue, SourceHistoryWindowPageStreamItem,
  SourceHistoryWindowRequest, SourceHistoryWindowValue } from '../source-window-types.ts'
import type { SourceHistoryAttachmentValue } from '../source-attachment-types.ts'
import { decodeSourceAttachmentValue, readSourceAttachmentWithFallback } from '../source-attachment-types.ts'
import { isSourceDisplayId, isSourceChildDisplayId } from '../shared/source-display-id.ts'
import { SOURCE_FRAME_EVENT, type SourceFrame, type SourceFrameBatch, type SourceWindowProgress } from '../shared/source-frames.ts'
import { SourceWindowStore, legacySourceFrames } from './source-window-store.ts'
import { SourceEventFeed } from './source-event-feed.ts'
import { sliceSourceHistoryPage, SourceHistoryPageCache } from './source-history-page-cache.ts'
import { sourceSequenceForMessage } from './source-event-order.ts'
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
/** Temporary latest-window measurement only; committed history is never evicted. */
const MAX_CANDIDATE_EVENTS = 1_500
const MAX_CANDIDATE_BYTES = 12 * 1024 * 1024
/** Keep the event fan-out of an interactive commit near HAPI's regular 50-row pager. */
const SOURCE_HISTORY_PAGE_SIZE = 50
/** Match HAPI's 800-message resident history while bounding DSH's larger event projection. */
const SOURCE_WINDOW_MAX_GROUPS = 800
const SOURCE_WINDOW_MAX_EVENTS = 8_000
const SOURCE_WINDOW_MAX_BYTES = 8 * 1024 * 1024

export interface SourceSessionsApi {
  sourceWindowFollow?(request: { sessionId: string }, signal?: AbortSignal): AsyncIterable<SourceFrameBatch> & { dispose?(): void }
  sourceHistoryOutline(request: { sessionId: string }): Promise<{ ok: true; value: SourceHistoryOutlineValue } | { ok: false; error: unknown }>
  sourceHistoryOutlinePage(request: { sessionId: string; beforeAt?: number; beforeSeq?: number; epoch?: number; limit?: number }): Promise<{ ok: true; value: SourceHistoryOutlinePageValue } | { ok: false; error: unknown }>
  sourceHistoryWindowPage(request: SourceHistoryWindowRequest): Promise<{ ok: true; value: SourceHistoryWindowValue } | { ok: false; error: unknown }>
  sourceHistoryWindowPageStream?(request: SourceHistoryWindowRequest, signal?: AbortSignal): AsyncIterable<SourceHistoryWindowPageStreamItem> & { dispose?(): void }
  sourceHistoryHead?(request: { sessionId: string }): Promise<{ ok: true; value: { messageId: string; at: number; seq: number } } | { ok: false; error: unknown }>
  sourceHistoryAttachment?(request: { sessionId: string; attachmentId: string }): Promise<RemoteResult<SourceHistoryAttachmentValue>>
  sourceReadingAnchor?(request: { sessionId: string; seq: number }): Promise<{ ok: true; value: { sourceMessageId: string | null } } | { ok: false; error: unknown }>
}

/** Source readiness is independent of optional directory metadata. */
export interface SourcePreparationReference extends SessionReference {
  readonly preparationReady: Promise<SessionBinding>
}

export interface SourceWindowReader {
  available(): boolean
  read(): SourceWindowViewport | undefined
  /** Capture the official reader immediately before a source window is published. */
  preparePrepend?(): { commit(): void; cancel(): void } | undefined
}

/** Optional capability owned by this facade, outside the official Session face. */
export interface SourceWindowPreparer {
  available(): boolean
  /** Settle only after the temporary official chat occurrence has unmounted. */
  prepare(reference: SessionReference, signal: AbortSignal): Promise<boolean>
}

export interface SourceViewportSession {
  /** Source paging state is independent of the official scrollport's bottom. */
  readonly sourceWindow: {
    getSnapshot(): { readonly hasMoreAfter: boolean } & Partial<SourceWindowProgress>
    subscribe(listener: () => void): () => void
  }
  /** Progressive directory state; navigation only, never a body prerequisite. */
  readonly sourceOutline: {
    getSnapshot(): { readonly status: 'none' | 'partial' | 'ready' | 'degraded'; readonly pages: number; readonly error: string | undefined }
    subscribe(listener: () => void): () => void
  }
  /** Retry a degraded directory; resolves after the next bounded page. */
  retrySourceOutline(): Promise<void>
  /** Warm the adjacent HAPI page without publishing transcript rows. */
  prefetchOlderPage?(limit?: number): Promise<void>
  /** Cancel the current user-facing page when its mounted reader times out. */
  cancelOlderPage?(reason?: unknown): void
  loadViewportPage(limit?: number): Promise<void>
  loadSourceMessage(messageId: string, signal?: AbortSignal): Promise<SessionSeq | undefined>
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

interface SourcePosition { messageId: string; at: number; seq: number; epoch?: number }

interface OlderPagePrefetch {
  readonly key: string
  readonly request: SourceHistoryWindowRequest
  readonly controller: AbortController
  readonly promise: Promise<SourceHistoryWindowValue>
}

function sameOlderPageCursor(left: SourceHistoryWindowRequest, right: SourceHistoryWindowRequest): boolean {
  if (left.sessionId !== right.sessionId || left.fromOldest !== right.fromOldest) return false
  if (left.fromOldest) return left.epoch === right.epoch
  if (left.beforeAt !== right.beforeAt || left.beforeSeq !== right.beforeSeq) return false
  if (left.epoch !== undefined && right.epoch !== undefined && left.epoch !== right.epoch) return false
  return left.cursorMessageId === undefined || right.cursorMessageId === undefined
    || left.cursorMessageId === right.cursorMessageId
}

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

interface SourceReadCapture {
  readonly source: SessionEventSource
  readonly changes: SessionEventChange[]
  covered?: { through: number; frames: ReadonlyMap<string, SourceFrame> }
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

function frameMeaning(frame: SourceFrame): string {
  const { turn: _turn, step: _step, displayTurn: _displayTurn, displayStep: _displayStep,
    surfaceSeq: _surfaceSeq, ...data } = (frame.event.data ?? {}) as Record<string, unknown>
  return JSON.stringify({ type: frame.event.type, data })
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
function sourcePositionOf(entry: SessionEventLikeEntry): SourcePosition | undefined {
  return (entry as SessionEventLikeEntry & { source?: SourcePosition }).source
}

class SourceRecord {
  readonly eventSource = new SourceEventFeed()
  readonly sourceWindow = new ValueSource<{ hasMoreAfter: boolean } & SourceWindowProgress>({ hasMoreAfter: false, before: null })
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
  readonly store = new SourceWindowStore()
  target: SourceWindowState | undefined
  hasMore: boolean
  loadingOlder = false
  pagingError = false
  references = 0
  disposed = false
  private outlinePromise: Promise<void> | undefined
  private readonly outlineLifetime = new AbortController()
  private outlineReadController = new AbortController()
  private outlineRefreshes = 0
  private outlineTimer: ReturnType<typeof setTimeout> | undefined
  private outlineRecoveryAttempt = 0
  private trimTimer: ReturnType<typeof setTimeout> | undefined
  private outlineFailure: { phase: 'first' | 'continuation'; attempt: number; pages: number; durationMs: number; code: string } | undefined
  private jump = 0
  private pageReadController: AbortController | undefined
  private olderPagePrefetch: OlderPagePrefetch | undefined
  private failedOlderPagePrefetchKey: string | undefined
  private readonly changes: SessionEventChange[] = []
  private flushScheduled = false
  private liveCapture: SourceReadCapture | undefined
  private canonicalTransport = false
  private independentFeed = false
  private historyVersion: number | undefined
  private historyId: string | undefined
  private bodyReadyResolve!: () => void
  private readonly bodyReady = new Promise<void>(resolve => { this.bodyReadyResolve = resolve })
  private readonly windowReaders = new Set<SourceWindowReader>()
  private readonly windowPreparers = new Set<SourceWindowPreparer>()
  private lastRetentionCheckEntries = 0
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
    this.ingest({ kind: 'replace', entries: initial.entries }, true)
    this.eventSource.replace(this.store.entries, initial.hasMore)
    this.hasMore = !isSourceChildDisplayId(this.sessionId) && initial.hasMore
    this.snapshot = base.session.getSnapshot()
    this.tailOutline = outlineOf(base.session.projections.faceOf('turnOutline').getSnapshot())
    this.hostOutline = undefined
    this.outline.set(mergeOutline(undefined, this.tailOutline))
    this.session = new SourceSession(this)
    this.bindingValue = { sessionId: this.sessionId, session: this.session, eventSource: this.eventSource, ctx: base.ctx }
    this.watch(base)
    this.session.publish()
    void this.followBody()
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
      const window = binding.eventSource.getSnapshot()
      const change = window.change
      if (this.independentFeed) {
        // Projection state is delegated from the original session face. Its
        // journal events do not belong in the transcript feed: replacing one
        // status row can otherwise rebuild thousands of resident chat events.
        return
      }
      if (!this.target) this.hasMore = !isSourceChildDisplayId(this.sessionId) && window.hasMore
      this.queueChange(change)
    }))
  }

  private queueChange(change: SessionEventChange): void {
    if (change.kind !== 'settle-assistant') {
      for (const entry of change.entries) {
        if (String(entry.event.type) === SOURCE_FRAME_EVENT) {
          this.owner.invalidateHistoryPageChanges(this.sessionId, entry.event.data as SourceFrameBatch)
        }
      }
    }
    if (this.liveCapture) this.liveCapture.changes.push(change)
    else this.changes.push(change)
    if (!this.flushScheduled && !this.liveCapture) {
      this.flushScheduled = true
      queueMicrotask(() => { this.flushScheduled = false; this.flushChanges() })
    }
  }

  private async followBody(): Promise<void> {
    const signal = this.outlineLifetime.signal
    try {
      const api = await this.owner.whenAttached(signal)
      if (!api.sourceWindowFollow || this.disposed) { this.bodyReadyResolve(); return }
      this.independentFeed = true
      this.canonicalTransport = true
      let opening = true, failures = 0
      while (!signal.aborted) {
        let stream: ReturnType<NonNullable<SourceSessionsApi['sourceWindowFollow']>> | undefined
        const dispose = (): void => { stream?.dispose?.() }
        try {
          stream = api.sourceWindowFollow({ sessionId: this.sessionId }, signal)
          signal.addEventListener('abort', dispose, { once: true })
          let first = true
          for await (const batch of stream) {
            if (signal.aborted) return
            if (first && batch.kind !== 'replace') throw new Error('Source body stream omitted its opening baseline')
            first = false
            const rewritten = batch.reset === true || this.historyVersion !== undefined
              && batch.historyVersion !== undefined && batch.historyVersion !== this.historyVersion
              || this.historyId !== undefined && batch.historyId !== undefined && batch.historyId !== this.historyId
            this.historyVersion = batch.historyVersion ?? this.historyVersion
            this.historyId = batch.historyId ?? this.historyId
            if (opening || rewritten) {
              if (rewritten) {
                this.invalidateOutline()
                this.owner.invalidateHistoryPages(this.sessionId)
              } else if (opening) {
                this.owner.retainHistoryPageVersion(this.sessionId, this.historyId, this.historyVersion)
              }
              // A source rewrite invalidates in-flight pages and their captured
              // deltas together. It leaves the official operation owner intact.
              this.pageReadController?.abort()
              this.pageReadController = undefined
              this.invalidateOlderPagePrefetch()
              this.jump++
              this.liveCapture = undefined
              this.changes.length = 0
              this.preparation?.controller.abort()
              this.target = undefined
              this.loadingOlder = false
              this.store.apply({ ...batch, kind: 'replace', ...(rewritten ? { reset: true } : {}) })
              // Seed the source body with the latest state projection once.
              // Later projection updates flow through the original SessionFace;
              // replaying them here would replace the entire transcript window.
              this.ingestControls(this.originalEventSource.getSnapshot().entries)
              this.hasMore = !isSourceChildDisplayId(this.sessionId) && (batch.hasMoreBefore ?? true)
              this.publishWindow(true)
              this.session.publish()
              this.bodyReadyResolve()
              opening = false
            } else {
              this.queueChange({ kind: 'append', entries: [{ type: 'event', event: {
                type: SOURCE_FRAME_EVENT, seq: 0, time: 0, data: batch,
              } } as unknown as SessionEventLikeEntry] })
            }
            failures = 0
          }
        } catch {
          if (signal.aborted) return
          diagnosticMark('hapi-dsh:source-window:reconnecting')
        } finally { signal.removeEventListener('abort', dispose); dispose() }
        if (!signal.aborted) await delay(Math.min(5_000, 250 * 2 ** Math.min(failures++, 5)), signal)
      }
    } catch { /* Source lifetime cancellation also stops pending API attachment. */ }
  }

  private async waitForBody(): Promise<void> {
    if (!this.owner.api && this.store.entries.length) return
    const api = this.owner.api ?? await this.owner.whenAttached(this.outlineLifetime.signal)
    if (api.sourceWindowFollow) await untilAborted(this.bodyReady, this.outlineLifetime.signal)
  }

  private ingest(change: SessionEventChange, initial = false): void {
    if (change.kind === 'settle-assistant') {
      this.store.settle(change.attemptId)
      if (change.entry) this.store.apply({ kind: 'merge', frames: legacySourceFrames([change.entry]) })
      return
    }
    const batches = change.entries.filter(entry => String(entry.event.type) === SOURCE_FRAME_EVENT)
    if (batches.length) {
      this.canonicalTransport = true
      for (const entry of batches) {
        const batch = entry.event.data as SourceFrameBatch
        // The transport snapshot is not a second view window. Once a source
        // window is open, a reconnect merges identities into that same window.
        const replacedStreams = batch.kind === 'replace' ? this.store.frames.filter(frame => frame.transient
          && !batch.frames.some(next => next.key === frame.key)).map(frame => frame.key) : []
        this.store.apply({ ...batch, kind: initial || isSourceChildDisplayId(this.sessionId) ? batch.kind : 'merge',
          removeKeys: [...(batch.removeKeys ?? []), ...replacedStreams] }, !initial && !!this.target?.hasMoreAfter)
      }
    } else if (!this.canonicalTransport) {
      this.store.apply({ kind: initial ? 'replace' : 'merge', frames: legacySourceFrames(change.entries) },
        !initial && !!this.target?.hasMoreAfter)
    }
    if (this.canonicalTransport) this.ingestControls(change.entries)
  }

  private ingestControls(entries: readonly SessionEventLikeEntry[]): void {
    const controls = entries.filter(entry => /^(plugin:hapi-dsh(?:-observed)?\/(?:state|status|session-state|execution|notices))$/.test(String(entry.event.type)))
    if (controls.length) this.store.apply({ kind: 'merge', frames: controls.map(entry =>
      ({ key: `transport:${entry.event.type}`, event: entry.event })) })
  }

  private flushChanges(): void {
    if (this.disposed || !this.changes.length) return
    for (const change of this.changes.splice(0)) this.ingest(change)
    if (!this.target) {
      const first = this.store.frames.find(frame => frame.source)?.source
      const last = this.store.frames.findLast(frame => frame.source)?.source
      if (first && last) this.target = { before: first, after: last,
        beforeEpoch: (first as SourcePosition).epoch, afterEpoch: (last as SourcePosition).epoch,
        beforeMessageId: first.messageId, afterMessageId: last.messageId,
        hasMoreBefore: this.hasMore, hasMoreAfter: false, firstSeq: this.firstSeq(), lastSeq: this.lastSeq(), firstTurn: 0, lastTurn: 0 }
    }
    this.maybeRetainWindow('newer')
    this.publishWindow()
    this.session.publish()
  }

  private pageFrames(value: SourceHistoryWindowValue): SourceFrame[] {
    return value.frames ?? legacySourceFrames(value.records as SessionEventLikeEntry[])
  }

  private acceptWindow(value: PreparedWindowValue): void {
    this.store.apply({ kind: 'replace', frames: this.pageFrames(value) })
    const records = this.store.entries, turns = recordTurns(records)
    this.target = { before: value.before, after: value.after, hasMoreBefore: value.hasMoreBefore,
      hasMoreAfter: value.hasMoreAfter, beforeEpoch: value.beforeEpoch, afterEpoch: value.afterEpoch,
      beforeMessageId: value.beforeMessageId, afterMessageId: value.afterMessageId,
      firstSeq: records[0]?.event.seq ?? null, lastSeq: records.at(-1)?.event.seq ?? null,
      firstTurn: turns.first ?? 0, lastTurn: turns.last ?? 0 }
    this.hasMore = value.hasMoreBefore
    this.retainWindow('newer', this.pageFrames(value))
    this.publishWindow(true)
  }

  /** Merge a fresh tail read with resident pages when the source interval overlaps. */
  private acceptLatestWindow(value: PreparedWindowValue): void {
    const incoming = this.pageFrames(value)
    const residentSources = new Set(this.store.frames.flatMap(frame => frame.source ? [frame.source.messageId] : []))
    const overlaps = incoming.some(frame => frame.source && residentSources.has(frame.source.messageId))
    if (!this.target || !overlaps) {
      this.acceptWindow(value)
      return
    }

    const previous = this.target
    // The latest interval can bridge a formerly detached reader to the tail.
    // Its preparer may also have loaded an older prefix than this reader had.
    // Keep each edge's cursor and metadata together; null with no older page
    // means the interval already reaches the beginning of source history.
    const incomingEarlier = previous.before && value.before
      ? value.before.at < previous.before.at || value.before.at === previous.before.at && value.before.seq <= previous.before.seq
      : value.before === null ? !value.hasMoreBefore : previous.hasMoreBefore
    const oldest = incomingEarlier ? value : previous
    this.store.apply({ kind: 'merge', frames: incoming })
    const records = this.store.entries, turns = recordTurns(records)
    this.target = { before: oldest.before, after: value.after,
      hasMoreBefore: oldest.hasMoreBefore, hasMoreAfter: value.hasMoreAfter,
      beforeEpoch: oldest.beforeEpoch, afterEpoch: value.afterEpoch,
      beforeMessageId: oldest.beforeMessageId, afterMessageId: value.afterMessageId,
      firstSeq: records[0]?.event.seq ?? null, lastSeq: records.at(-1)?.event.seq ?? null,
      firstTurn: turns.first ?? 0, lastTurn: turns.last ?? 0 }
    this.hasMore = oldest.hasMoreBefore
    this.retainWindow('newer', incoming)
    this.publishWindow()
  }

  private beginJump(preserveOlderPrefetch = false): number {
    this.pageReadController?.abort()
    this.pageReadController = undefined
    if (!preserveOlderPrefetch) this.invalidateOlderPagePrefetch()
    this.finishLiveCapture(this.liveCapture)
    this.flushChanges()
    this.preparation?.controller.abort()
    return ++this.jump
  }

  private captureLive(): SourceReadCapture {
    const capture = { source: this.originalEventSource, changes: [] as SessionEventChange[] }
    this.liveCapture = capture
    return capture
  }

  private finishLiveCapture(capture: SourceReadCapture | undefined): void {
    if (!capture || this.liveCapture !== capture) return
    this.liveCapture = undefined
    if (this.disposed || capture.source !== this.originalEventSource) return
    for (const [index, change] of capture.changes.entries()) {
      if (!capture.covered || index >= capture.covered.through || change.kind === 'settle-assistant') {
        this.changes.push(change)
        continue
      }
      const entries = change.entries.map(entry => {
        if (String(entry.event.type) !== SOURCE_FRAME_EVENT) return entry
        const batch = entry.event.data as SourceFrameBatch
        const frames = batch.frames.filter(frame => {
          const authoritative = capture.covered!.frames.get(frame.key)
          return !authoritative?.source || !frame.source || frame.transient
            || frame.source.at > authoritative.source.at
            || frame.source.at === authoritative.source.at && frame.source.seq > authoritative.source.seq
        })
        return { ...entry, event: { ...entry.event, data: { ...batch, frames,
          removeKeys: batch.removeKeys?.filter(key => !capture.covered!.frames.has(key)) } } } as unknown as SessionEventLikeEntry
      })
      this.changes.push({ ...change, entries })
    }
    this.flushChanges()
  }

  private async readCapturedWindow(api: SourceSessionsApi, request: SourceHistoryWindowRequest,
    capture: SourceReadCapture, token: number, commit: (value: PreparedWindowValue) => void,
    prepare?: (value: SourceHistoryWindowValue) => Promise<PreparedWindowValue | undefined>): Promise<boolean> {
    const conflictSince = (frames: SourceFrame[], from: number): boolean => {
      const live = new Map<string, SourceFrame>()
      for (const change of capture.changes.slice(from)) {
        if (change.kind === 'settle-assistant') continue
        for (const entry of change.entries) {
          if (String(entry.event.type) !== SOURCE_FRAME_EVENT) continue
          const batch = entry.event.data as SourceFrameBatch
          for (const key of batch.removeKeys ?? []) live.delete(key)
          for (const frame of batch.frames) live.set(frame.key, frame)
        }
      }
      return frames.some(frame => {
        const update = live.get(frame.key)
        return update && !update.transient && !frame.transient && frame.source && update.source
          && frame.source.at === update.source.at && frame.source.seq === update.source.seq
          && frameMeaning(frame) !== frameMeaning(update)
      })
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const through = capture.changes.length
      const result = await api.sourceHistoryWindowPage(request)
      if (this.disposed || token !== this.jump || this.liveCapture !== capture) return false
      if (!result.ok) throw result.error
      const frames = this.pageFrames(result.value)
      if (!frames.length) return false
      // Same-position edits have no ordered revision number. Read a new bounded
      // authoritative snapshot rather than guessing which payload is newer.
      if (conflictSince(frames, through)) continue
      const value = prepare ? await prepare(result.value) : preparedWindowValue(result.value)
      if (!value || this.disposed || token !== this.jump || this.liveCapture !== capture) return false
      if (conflictSince(this.pageFrames(value), through)) continue
      capture.covered = { through, frames: new Map(this.pageFrames(value).map(frame => [frame.key, frame])) }
      commit(value)
      return true
    }
    return false
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

  /** A source rewrite invalidates directory routes as well as transcript rows. */
  private invalidateOutline(): void {
    this.outlineReadController.abort()
    this.outlineReadController = new AbortController()
    if (this.outlineTimer !== undefined) { clearTimeout(this.outlineTimer); this.outlineTimer = undefined }
    this.outlinePromise = undefined
    this.hostOutline = undefined
    this.newestOutline = undefined
    this.sourceHead = undefined
    this.tailOutline = []
    this.owner.hostEntries.delete(this)
    this.outlineStatus = 'none'
    this.outlinePages = 0
    this.outlineError = undefined
    this.outlineFailure = undefined
    this.outlineRefreshes = 0
    this.outlineRecoveryAttempt = 0
    this.outline.set([])
    this.publishOutlineState()
    if (!isSourceChildDisplayId(this.sessionId)) void this.ensureOutline().catch(() => {})
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
    await this.waitForBody()
    diagnosticMark('hapi-dsh:facade:original-ready')
    if (this.disposed) throw new Error('The source session was released before it opened')
    return this.bindingValue
  }

  /** The original data owner admits the view. Directory work has its own state. */
  async readyFor(preparationReady: Promise<SessionBinding>): Promise<SessionBinding> {
    if (!isSourceChildDisplayId(this.sessionId)) void this.ensureOutline().catch(() => { /* The directory publishes its own failure. */ })
    await preparationReady
    if (this.disposed) throw new Error('The source session was released before it opened')
    diagnosticMark('hapi-dsh:facade:ready')
    return this.bindingValue
  }

  /** Stop the shared source; each caller releases its own original lease. */
  retire(): void {
    if (this.disposed) return
    this.disposed = true
    this.pageReadController?.abort()
    this.pageReadController = undefined
    this.invalidateOlderPagePrefetch()
    this.outlineLifetime.abort(new Error('The source session was released before it opened'))
    this.outlineReadController.abort()
    this.preparation?.controller.abort()
    this.windowReaders.clear()
    this.windowPreparers.clear()
    this.liveCapture = undefined
    this.changes.length = 0
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
    const rpcAt = performance.now()
    if (typeof api.sourceHistoryOutlinePage === 'function') {
      try { return await untilAborted(api.sourceHistoryOutlinePage(request), signal) }
      finally { try { performance.mark(`hapi-dsh:rpc:outline:${Math.round(performance.now() - rpcAt)}`) } catch { /* optional */ } }
    }
    const full = await untilAborted(api.sourceHistoryOutline({ sessionId: request.sessionId }), signal)
    if (!full.ok) return full
    return { ok: true, value: { ...full.value, hasMore: false, cursor: null, pageSize: 1 } }
  }

  /**
   * Directory pages enrich navigation independently of body/lease readiness.
   * A failed or slow directory never delays the source's usable data window.
   */
  private async prefetchOutline(_required = false): Promise<void> {
    diagnosticMark('hapi-dsh:facade:outline-start')
    const startedAt = Date.now()
    const signal = this.outlineReadController.signal
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
      if (first === undefined || this.disposed || signal.aborted) return
      this.outlinePages = 1
      this.applyOutline(first)
      this.refreshOutlineStatus(first)
      if (this.outlineStatus !== 'ready') {
        void this.continueOutline(api, first.cursor ?? undefined, 1, first.entries.length, Date.now(), signal)
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

  private async loadOlderDirect(token: number, limit: number | undefined, signal: AbortSignal): Promise<void> {
    const api = this.owner.api ?? await this.owner.whenAttached(signal)
    if (this.disposed || token !== this.jump || signal.aborted) return
    const first = this.store.frames.find(frame => frame.source)?.source
    let cursor = this.target?.before ?? first
    let cursorMessageId = this.target?.beforeMessageId ?? first?.messageId
    let cursorEpoch = this.target?.beforeEpoch
    for (;;) {
      const request: SourceHistoryWindowRequest = { sessionId: this.sessionId,
        ...(cursor ? { beforeAt: cursor.at, beforeSeq: cursor.seq } : { fromOldest: true }),
        ...(cursorEpoch === undefined ? {} : { epoch: cursorEpoch }),
        ...(cursorMessageId === undefined ? {} : { cursorMessageId }),
        limit: limit ?? SOURCE_HISTORY_PAGE_SIZE }
      const value = await this.readOlderPageForCommit(api, request, signal, token)
      if (!value) return
      if (this.disposed || token !== this.jump || signal.aborted) return

      const next = value.before
      const advanced = cursor === undefined || next !== null
        && (next.at < cursor.at || next.at === cursor.at && next.seq < cursor.seq)
      if (value.hasMoreBefore && (next === null || !advanced)) {
        throw new Error('Source history page cursor did not advance toward older messages')
      }
      this.rememberOlderPage(request, value)
      const frames = this.pageFrames(value)
      if (!frames.length && value.hasMoreBefore) {
        // A raw HAPI page can contain only rows the DSH projector omits. Its
        // source cursor still advanced, so keep this gesture in flight and
        // continue from that cursor instead of returning a false empty success.
        cursor = next!
        cursorMessageId = value.beforeMessageId
        cursorEpoch = value.epoch ?? cursorEpoch
        if (this.target) {
          this.target.before = cursor
          this.target.beforeEpoch = cursorEpoch
          this.target.beforeMessageId = cursorMessageId
          this.target.hasMoreBefore = true
        }
        continue
      }

      this.store.apply({ kind: 'merge', frames })
      this.hasMore = value.hasMoreBefore
      if (!this.target) {
        const last = this.store.frames.findLast(frame => frame.source)?.source
        this.target = { before: value.before, after: last ?? value.after,
          beforeEpoch: value.epoch, afterEpoch: value.epoch, beforeMessageId: value.beforeMessageId,
          afterMessageId: last?.messageId ?? value.afterMessageId,
          hasMoreBefore: value.hasMoreBefore, hasMoreAfter: false,
          firstSeq: this.firstSeq(), lastSeq: this.lastSeq(), firstTurn: 0, lastTurn: 0 }
      } else {
        this.target.before = value.before
        this.target.beforeEpoch = value.epoch
        this.target.beforeMessageId = value.beforeMessageId
        this.target.hasMoreBefore = value.hasMoreBefore
      }
      this.retainWindow('older', frames)
      this.publishWindow()
      return
    }
  }

  private olderPageRequest(limit = SOURCE_HISTORY_PAGE_SIZE): SourceHistoryWindowRequest {
    const first = this.store.frames.find(frame => frame.source)?.source
    const cursor = this.target?.before ?? first
    const cursorMessageId = this.target?.beforeMessageId ?? first?.messageId
    const cursorEpoch = this.target?.beforeEpoch
    return { sessionId: this.sessionId,
      ...(cursor ? { beforeAt: cursor.at, beforeSeq: cursor.seq } : { fromOldest: true }),
      ...(cursorEpoch === undefined ? {} : { epoch: cursorEpoch }),
      ...(cursorMessageId === undefined ? {} : { cursorMessageId }), limit }
  }

  private olderPageKey(request: SourceHistoryWindowRequest): string {
    return JSON.stringify([request, this.historyId, this.historyVersion])
  }

  private async readOlderPage(api: SourceSessionsApi, request: SourceHistoryWindowRequest, signal: AbortSignal,
    token?: number): Promise<SourceHistoryWindowValue | undefined> {
    const cached = this.owner.cachedHistoryPage(this.olderPageKey(request))
    if (cached) return cached
    const covered = this.owner.cachedHistoryPageForRequest({ sessionId: this.sessionId, historyId: this.historyId,
      historyVersion: this.historyVersion, request })
    if (covered) return covered
    if (api.sourceHistoryWindowPageStream) {
      const stream = api.sourceHistoryWindowPageStream(request, signal)
      const frames: SourceFrame[] = []
      let completion: Extract<SourceHistoryWindowPageStreamItem, { kind: 'complete' }>['value'] | undefined
      let ended = false
      const iterator = stream[Symbol.asyncIterator]()
      try {
        for (;;) {
          const next = await untilAborted(iterator.next(), signal)
          if (next.done) { ended = true; break }
          const item = next.value
          if (this.disposed || signal.aborted || token !== undefined && token !== this.jump) {
            stream.dispose?.(); return undefined
          }
          if (completion) throw new Error('Source history page stream continued after its cursor record')
          if (item.kind === 'frames') frames.push(...item.frames)
          else completion = item.value
        }
      } catch (error) {
        if (signal.aborted || this.disposed || token !== undefined && token !== this.jump) return undefined
        throw error
      } finally {
        if (!ended) {
          stream.dispose?.()
          void iterator.return?.().catch(() => {})
        }
      }
      if (!completion) throw new Error('Source history page stream ended before its cursor record')
      return { ...completion, records: [], frames }
    }
    const result = await untilAborted(api.sourceHistoryWindowPage(request), signal)
    if (this.disposed || signal.aborted || token !== undefined && token !== this.jump) return undefined
    if (!result.ok) throw result.error
    return result.value
  }

  /** Read the adjacent HAPI page ahead of the reader without publishing it. */
  prefetchOlderPage(limit = SOURCE_HISTORY_PAGE_SIZE): Promise<void> {
    if (this.disposed || this.loadingOlder || !this.hasMore || isSourceChildDisplayId(this.sessionId)) return Promise.resolve()
    const request = this.olderPageRequest(limit)
    const key = this.olderPageKey(request)
    if (this.olderPagePrefetch?.key === key) return this.olderPagePrefetch.promise.then(() => undefined, () => undefined)
    if (this.olderPagePrefetch) this.invalidateOlderPagePrefetch()
    if (this.failedOlderPagePrefetchKey === key) return Promise.resolve()
    const controller = new AbortController()
    const prefetch: OlderPagePrefetch = {
      key,
      request,
      controller,
      promise: Promise.resolve().then(async () => {
        const api = this.owner.api ?? await this.owner.whenAttached(controller.signal)
        if (this.disposed || controller.signal.aborted) throw controller.signal.reason ?? new Error('Source page prefetch was cancelled')
        const value = await this.readOlderPage(api, request, controller.signal)
        if (!value) throw controller.signal.reason ?? new Error('Source page prefetch was superseded')
        const advanced = !value.hasMoreBefore || value.before !== null
          && (request.beforeAt === undefined || value.before.at < request.beforeAt
            || value.before.at === request.beforeAt && value.before.seq < request.beforeSeq!)
        if (!advanced) throw new Error('Source history page cursor did not advance toward older messages')
        this.rememberOlderPage(request, value)
        return value
      }),
    }
    this.olderPagePrefetch = prefetch
    void prefetch.promise.catch(() => {
      if (this.olderPagePrefetch === prefetch) {
        this.olderPagePrefetch = undefined
        if (!controller.signal.aborted) this.failedOlderPagePrefetchKey = key
      }
    })
    return prefetch.promise.then(() => undefined, () => undefined)
  }

  cancelOlderPage(reason?: unknown): void {
    this.pageReadController?.abort(reason ?? new Error('Source history page was cancelled'))
  }

  private invalidateOlderPagePrefetch(): void {
    const current = this.olderPagePrefetch
    this.olderPagePrefetch = undefined
    this.failedOlderPagePrefetchKey = undefined
    current?.controller.abort(new Error('Source history cursor changed before page prefetch was consumed'))
  }

  private async readOlderPageForCommit(api: SourceSessionsApi, request: SourceHistoryWindowRequest,
    signal: AbortSignal, token: number): Promise<SourceHistoryWindowValue | undefined> {
    const key = this.olderPageKey(request)
    const prefetch = this.olderPagePrefetch
    if (!prefetch || !sameOlderPageCursor(prefetch.request, request)) {
      if (prefetch) this.invalidateOlderPagePrefetch()
      this.failedOlderPagePrefetchKey = undefined
      return this.readOlderPage(api, request, signal, token)
    }
    this.olderPagePrefetch = undefined
    this.failedOlderPagePrefetchKey = undefined
    const abort = (): void => prefetch.controller.abort(signal.reason ?? new Error('History page commit was cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      const value = await prefetch.promise
      return prefetch.key === key ? value
        : sliceSourceHistoryPage(value, request, request.limit ?? SOURCE_HISTORY_PAGE_SIZE) ?? value
    }
    finally {
      signal.removeEventListener('abort', abort)
    }
  }

  /** Background completion of the directory, one bounded page at a time. */
  private async continueOutline(api: SourceSessionsApi, cursor: { at: number; seq: number } | undefined,
    pages: number, labels: number, started: number, signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        if (this.disposed || signal.aborted) return
        if (pages >= 32 || Date.now() - started > 10_000 || labels >= 10_000) {
          this.outlineStatus = 'partial'
          this.session.publish()
          return
        }
        const next = await this.readOutlinePageWithRetry(api, cursor === undefined ? {} : { beforeAt: cursor.at, beforeSeq: cursor.seq }, signal)
        if (next === undefined || this.disposed || signal.aborted) return
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
    const signal = this.outlineReadController.signal
    const attempt = this.outlineRecoveryAttempt++
    if (this.outlineTimer !== undefined) clearTimeout(this.outlineTimer)
    this.outlineTimer = setTimeout(() => {
      this.outlineTimer = undefined
      if (this.disposed || signal.aborted || this.outlineStatus === 'ready') return
      console.warn(`[hapi-dsh] outline recovery starting attempt=${attempt} status=${this.outlineStatus} pages=${this.outlinePages}`)
      void this.retrySourceOutline().then(() => {
        if (signal.aborted) return
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
    this.sourceHead = value.head ?? this.sourceHead
    const older = all.filter(entry => value.firstTurn === undefined || value.firstTurn <= 0 || entry.turn < value.firstTurn)
    this.hostOutline = newest && !older.some(entry => entry.turn === newest.turn) ? [...older, newest] : older
    this.outline.set(mergeOutline(this.hostOutline, this.tailOutline))
  }

  private scheduleOutlineRefresh(): void {
    if (this.disposed || this.outlineRefreshes >= 2) return
    const signal = this.outlineReadController.signal
    this.outlineRefreshes++
    this.outlineTimer = setTimeout(() => {
      if (!this.disposed && !signal.aborted) void this.prefetchOutline(false)
    }, this.outlineRefreshes === 1 ? 5_000 : 15_000)
  }

  private publishWindow(reset = false): void {
    const readerCommits = [...this.windowReaders]
      .filter(reader => reader.available())
      .flatMap(reader => {
        const commit = reader.preparePrepend?.()
        return commit === undefined ? [] : [commit]
      })
    try {
      if (reset) this.eventSource.replace(this.store.entries, this.hasMore)
      else this.eventSource.update(this.store.entries, this.hasMore)
      for (const commit of readerCommits) commit.commit()
    } catch (error) {
      for (const commit of readerCommits) commit.cancel()
      throw error
    }
  }

  private rememberOlderPage(request: SourceHistoryWindowRequest, value: SourceHistoryWindowValue): void {
    this.owner.rememberHistoryPage({ key: this.olderPageKey(request), sessionId: this.sessionId, request,
      historyId: this.historyId, historyVersion: this.historyVersion, value, frames: this.pageFrames(value) })
  }

  private readerPins(entries: readonly SessionEventLikeEntry[]): SourceWindowPin[] {
    const pins: SourceWindowPin[] = []
    for (const reader of this.windowReaders) {
      if (!reader.available()) continue
      const viewport = reader.read()
      if (!viewport) { pins.push({ first: '', last: '', visibleGroups: 0, followingTail: false, unknownGeometry: true }); continue }
      const visible = pinSourceViewport(entries, viewport)
      if (visible) pins.push(visible)
      const overscan = viewport.overscan && pinSourceViewport(entries, { ...viewport.overscan, followingTail: false })
      if (overscan) pins.push(overscan)
    }
    return pins
  }

  /** Keep the official readers and the just-loaded page, as HAPI does with its bounded message window. */
  private retainWindow(direction: 'older' | 'newer', pageFrames: readonly SourceFrame[] = []): void {
    const entries = this.store.entries
    this.lastRetentionCheckEntries = entries.length
    if (!entries.length) return
    const pins = this.readerPins(entries)
    const pageMessages = new Set(pageFrames.flatMap(frame => frame.source ? [frame.source.messageId] : []))
    const pageEntries = pageMessages.size ? sourceGroups(entries).flatMap(group =>
      group.source && pageMessages.has(group.source.messageId) ? entries.slice(group.start, group.end) : []) : []
    const protectedPins = pageEntries.length ? protectSourcePage(pageEntries, pins) : pins
    const plan = sourceRetentionPlan(entries, protectedPins, direction, {
      groups: SOURCE_WINDOW_MAX_GROUPS, events: SOURCE_WINDOW_MAX_EVENTS, bytes: SOURCE_WINDOW_MAX_BYTES,
      size: bytesOfEntry,
    })
    if (!plan.fits || plan.first === 0 && plan.last === entries.length) return
    const kept = entries.slice(plan.first, plan.last)
    if (!kept.length) return
    this.store.retain(kept)
    const next = this.store.entries
    this.lastRetentionCheckEntries = next.length
    const firstSource = next.map(sourcePositionOf).find((source): source is SourcePosition => source !== undefined)
    const lastSource = next.map(sourcePositionOf).findLast((source): source is SourcePosition => source !== undefined)
    if (plan.first > 0 && firstSource) {
      this.target && Object.assign(this.target, { before: firstSource, beforeMessageId: firstSource.messageId, hasMoreBefore: true })
      this.hasMore = true
    }
    if (plan.last < entries.length && lastSource) {
      this.target && Object.assign(this.target, { after: lastSource, afterMessageId: lastSource.messageId, hasMoreAfter: true })
    }
    if (this.target) {
      this.target.firstSeq = Number(next[0]?.event.seq ?? null)
      this.target.lastSeq = Number(next.at(-1)?.event.seq ?? null)
      const turns = recordTurns(next)
      this.target.firstTurn = turns.first ?? this.target.firstTurn
      this.target.lastTurn = turns.last ?? this.target.lastTurn
    }
  }

  private maybeRetainWindow(direction: 'older' | 'newer'): void {
    const count = this.store.entries.length
    if (count > this.lastRetentionCheckEntries + 200) this.retainWindow(direction)
  }

  private firstSeq(): number | null {
    return this.store.entries[0]?.event.seq ?? null
  }

  private lastSeq(): number | null {
    const entries = this.store.entries
    return entries[entries.length - 1]?.event.seq ?? null
  }

  async loadOlder(limit?: number): Promise<void> {
    if (this.disposed || this.loadingOlder || !this.hasMore) return
    const token = this.beginJump(true)
    const controller = new AbortController()
    this.pageReadController = controller
    this.loadingOlder = true
    this.pagingError = false
    let pageSucceeded = false
    this.session.publish()
    try {
      await this.loadOlderDirect(token, limit, controller.signal)
      pageSucceeded = !controller.signal.aborted && token === this.jump
    }
    catch (error) {
      if (controller.signal.aborted || token !== this.jump) return
      if (!this.disposed && token === this.jump) {
        this.pagingError = true
        this.session.publish()
      }
      throw error
    }
    finally {
      if (this.pageReadController === controller) this.pageReadController = undefined
      if (!this.disposed && token === this.jump) {
        this.loadingOlder = false
        this.session.publish()
        // Keep one adjacent page warm after each accepted prepend. HAPI warms
        // its first NativeCodex page at mount and re-evaluates the next edge
        // after a commit; waiting for another swipe makes long reads visible.
        if (pageSucceeded && [...this.windowReaders].some(reader => reader.available())) {
          void this.prefetchOlderPage()
        }
      }
    }
  }

  private async readForwardPage(api: SourceSessionsApi, target: SourceWindowState, token: number): Promise<boolean> {
    if (!target.after) return false
    const result = await api.sourceHistoryWindowPage({ sessionId: this.sessionId,
      afterAt: target.after.at, afterSeq: target.after.seq,
      ...(target.afterEpoch === undefined ? {} : { epoch: target.afterEpoch }),
      ...(target.afterMessageId === undefined ? {} : { cursorMessageId: target.afterMessageId }),
      limit: SOURCE_HISTORY_PAGE_SIZE })
    if (this.disposed || token !== this.jump || this.target !== target) return false
    if (!result.ok) throw result.error
    const value = result.value, frames = this.pageFrames(value)
    if (!frames.length) {
      target.hasMoreAfter = value.hasMoreAfter
      if (!value.hasMoreAfter) target.after = value.after
      return false
    }
    this.store.apply({ kind: 'merge', frames })
    this.retainWindow('newer', frames)
    target.after = value.after
    target.afterEpoch = value.epoch
    target.afterMessageId = value.afterMessageId
    target.hasMoreAfter = value.hasMoreAfter
    this.publishWindow()
    return frames.length > 0
  }

  async loadThrough(seq: SessionSeq): Promise<void> {
    if (this.disposed) return
    // loadThrough is an ensure operation. Reading restoration and official
    // navigation may repeat it after layout; a resident target needs no new
    // window, generation or network request.
    if (this.eventSource.getSnapshot().entries.some(row => Number(row.event.seq) === seq)) return
    const token = this.beginJump()
    this.loadingOlder = true
    this.session.publish()
    try { await this.loadThroughTarget(seq, token) }
    finally { if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() } }
  }

  async loadSourceMessage(messageId: string, signal?: AbortSignal): Promise<SessionSeq | undefined> {
    if (this.disposed || signal?.aborted) return undefined
    const resident = sourceSequenceForMessage(this.store.entries, messageId)
    if (resident !== undefined) return resident as SessionSeq
    if (isSourceChildDisplayId(this.sessionId)) return undefined
    const token = this.beginJump(), capture = this.captureLive()
    const abort = (): void => { if (token === this.jump) { this.beginJump(); this.loadingOlder = false; this.session.publish() } }
    signal?.addEventListener('abort', abort, { once: true })
    this.loadingOlder = true
    this.session.publish()
    try {
      const api = this.owner.api ?? await this.owner.whenAttached(signal)
      if (this.disposed || token !== this.jump || signal?.aborted) return undefined
      await this.readCapturedWindow(api, { sessionId: this.sessionId, messageId, radius: 50 }, capture, token,
        value => this.acceptWindow(value))
      if (this.disposed || token !== this.jump || signal?.aborted) return undefined
      return sourceSequenceForMessage(this.store.entries, messageId) as SessionSeq | undefined
    } finally {
      signal?.removeEventListener('abort', abort)
      this.finishLiveCapture(capture)
      if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() }
    }
  }

  private async loadThroughTarget(seq: SessionSeq, token: number): Promise<void> {
    const host = this.hostOutline?.find(entry => entry.seq === seq)
    const known = host ? this.owner.outlineFor(this, host)?.messageId : this.store.sourceForSeq(seq)?.messageId
    const api = this.owner.api ?? await this.owner.whenAttached()
    if (this.disposed || token !== this.jump) return
    let messageId = known
    if (!messageId && api.sourceReadingAnchor) {
      const result = await api.sourceReadingAnchor({ sessionId: this.sessionId, seq })
      if (this.disposed || token !== this.jump) return
      if (result.ok) messageId = result.value.sourceMessageId ?? undefined
    }
    if (!messageId || this.store.hasSource(messageId)) return
    const capture = this.captureLive()
    try {
      await this.readCapturedWindow(api, { sessionId: this.sessionId, messageId, radius: 50 }, capture, token,
        value => this.acceptWindow(value))
    } finally { this.finishLiveCapture(capture) }
  }

  /** One normal downward page at the bottom of a detached target window. */
  async loadAfterPage(): Promise<boolean> {
    if (this.disposed || !this.target) return false
    const target = this.target
    if (!target.after || !target.hasMoreAfter || this.loadingOlder) {
      return false
    }
    const token = this.beginJump()
    const capture = this.captureLive()
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
      this.finishLiveCapture(capture)
      if (!this.disposed && token === this.jump) { this.loadingOlder = false; this.session.publish() }
    }
  }

  /** Explicit latest intent from the official to-bottom control. */
  returnToLive(signal?: AbortSignal): boolean | Promise<boolean> {
    if (this.disposed || signal?.aborted) return false
    if (isSourceChildDisplayId(this.sessionId)) return true
    // Explicit latest always reads the authoritative source head by identity.
    // It never compares outline ordinals with native display turns, and never
    // assumes the resident original tail is current.
    return this.loadNewest(this.newestOutline, signal)
  }

  private async loadNewest(entry?: SourceOutlineValue, signal?: AbortSignal): Promise<boolean> {
    try { performance.mark('hapi-dsh:open:start') } catch { /* optional */ }
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
      const api = this.owner.api ?? await this.owner.whenAttached()
      if (this.disposed || token !== this.jump || signal?.aborted) return false
      // Explicit latest is the freshness boundary: the stored outline/head may
      // be older than the 5s/15s refresh after a long reading session. Re-read
      // the bounded source outline/head now; never poll, never read the archive.
      // A failed/incomplete refresh must preserve the current reading window and
      // must not present the old head as latest.
      // The open path only needs the newest message identity. Prefer the cheap
      // head probe so the directory page (and its admission budget) stays off
      // the critical path; fall back to the outline for older hosts.
      if (typeof api.sourceHistoryHead === 'function') {
        try {
          const head = await untilAborted(api.sourceHistoryHead({ sessionId: this.sessionId }), signal ?? new AbortController().signal)
          if (this.disposed || token !== this.jump) return false
          if (!head.ok) throw head.error
          this.sourceHead = head.value
        } catch (error) {
          if (this.disposed || token !== this.jump) return false
          diagnosticMark('hapi-dsh:facade:latest-head-failed')
          console.warn('[hapi-dsh] latest source head probe failed; preserving the current window', error)
          return false
        }
      } else {
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
      }
      const messageId = this.sourceHead?.messageId
      if (!messageId) {
        return false
      }
      // The source head proves freshness. If it is already in this loaded
      // history, the official to-bottom action can reuse the same event stream.
      const resident = this.eventSource.getSnapshot().entries
      const headResident = resident.some(row => {
        const source = (row as unknown as { source?: { messageId: string } }).source
        const data = row.event.data as Record<string, unknown> | null
        return source?.messageId === messageId
          || (String(row.event.type) === 'plugin:hapi-dsh/native-item' && data?.sourceMessageId === messageId)
          || (String(row.event.type) === 'plugin:hapi-dsh-observed/item' && data?.sourceRowId === messageId)
      })
      if (headResident && (!this.target || !this.target.hasMoreAfter)) return true
      return await this.readCapturedWindow(api, { sessionId: this.sessionId, messageId, radius: 79 }, capture, token,
        value => this.acceptLatestWindow(value), value => this.prepareLatestWindow(api, value, token))
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

  registerWindowPreparer(preparer: SourceWindowPreparer): () => void {
    this.hadWindowPreparer = true
    this.windowPreparers.add(preparer)
    return () => {
      this.windowPreparers.delete(preparer)
      if (this.preparation?.preparer === preparer) this.preparation.controller.abort()
    }
  }

  registerWindowReader(reader: SourceWindowReader): () => void {
    this.windowReaders.add(reader)
    // Match NativeCodexThread's warmInitial history preload. The initial
    // viewport already has a bounded source cursor, so the first upward
    // gesture should consume an adjacent page that was fetched in the
    // background instead of starting its network read at the history edge.
    if (reader.available() && this.owner.api && this.target && this.hasMore) void this.prefetchOlderPage()
    return () => { this.windowReaders.delete(reader) }
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

  publish(): void {
    this.publishOutlineState()
    const hasMoreAfter = !this.disposed && (this.target?.hasMoreAfter ?? false)
    const before = this.target?.before ?? this.store.frames.find(frame => frame.source)?.source ?? null
    const current = this.sourceWindow.getSnapshot()
    const pagingError = this.pagingError ? true : undefined
    if (current.hasMoreAfter !== hasMoreAfter || current.before?.at !== before?.at || current.before?.seq !== before?.seq
      || current.pagingError !== pagingError || current.historyId !== this.historyId || current.historyVersion !== this.historyVersion) {
      this.sourceWindow.set({ hasMoreAfter, before: before ? { at: before.at, seq: before.seq } : null,
        ...(pagingError ? { pagingError } : {}),
        historyId: this.historyId, historyVersion: this.historyVersion })
    }
    const base = this.originalFace.getSnapshot()
    const blank = !this.store.entries.some(entry => ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(String(entry.event.type)))
    const next = { ...base, blank, awaitingFirstTurn: base.awaitingFirstTurn && blank,
      hasMore: this.hasMore, loadingOlder: this.loadingOlder }
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
  prefetchOlderPage(limit?: number): Promise<void> { return this.record.prefetchOlderPage(limit) }
  cancelOlderPage(reason?: unknown): void { this.record.cancelOlderPage(reason) }
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
  /** The caller sizes admission pages from the official viewport's measured deficit. */
  loadViewportPage(limit = 20): Promise<void> { return this.record.loadOlder(limit) }
  loadSourceMessage(messageId: string, signal?: AbortSignal): Promise<SessionSeq | undefined> {
    return this.record.loadSourceMessage(messageId, signal)
  }
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
  private readonly store = new SourceWindowStore()
  constructor(readonly alias: SessionId, private readonly source: SourceRecord, private readonly api: SourceSessionsApi,
    value: SourceHistoryWindowValue, private readonly signal: AbortSignal) {
    super(source)
    this.value = preparedWindowValue(value)
    this.store.apply({ kind: 'replace', frames: value.frames ?? legacySourceFrames(value.records as SessionEventLikeEntry[]) })
    this.eventSource.replace(this.store.entries, value.hasMoreBefore)
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
  override loadSourceMessage(): Promise<undefined> { return Promise.resolve(undefined) }
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
        beforeAt: before.at, beforeSeq: before.seq, limit })
      if (this.signal.aborted) return
      if (!result.ok) throw result.error
      const frames = result.value.frames ?? legacySourceFrames(result.value.records as SessionEventLikeEntry[])
      if (!frames.length && result.value.hasMoreBefore) throw new Error('The candidate source cursor did not advance')
      this.store.apply({ kind: 'merge', frames })
      const merged = this.store.entries
      if (merged.length > MAX_CANDIDATE_EVENTS || merged.reduce((bytes, row) => bytes + bytesOfEntry(row), 0) > MAX_CANDIDATE_BYTES) {
        throw new Error('The candidate viewport exceeded its retained window budget')
      }
      this.value = { ...this.value, records: [...merged], frames: [...this.store.frames], before: result.value.before, hasMoreBefore: result.value.hasMoreBefore,
        beforeEpoch: result.value.epoch, beforeMessageId: result.value.beforeMessageId }
      this.eventSource.replace(merged, result.value.hasMoreBefore)
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
  private readonly historyPages = new SourceHistoryPageCache()
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
    this.historyPages.clear()
    this.api = undefined
  }

  cachedHistoryPage(key: string): SourceHistoryWindowValue | undefined {
    return this.historyPages.get(key)
  }

  cachedHistoryPageForRequest(input: { sessionId: string; historyId: string | undefined; historyVersion: number | undefined;
    request: SourceHistoryWindowRequest }): SourceHistoryWindowValue | undefined {
    return this.historyPages.getOlder(input)
  }

  rememberHistoryPage(input: Parameters<SourceHistoryPageCache['remember']>[0]): void {
    this.historyPages.remember(input)
  }

  retainHistoryPageVersion(sessionId: string, historyId: string | undefined, historyVersion: number | undefined): void {
    this.historyPages.retainVersion(sessionId, historyId, historyVersion)
  }

  invalidateHistoryPages(sessionId: string): void {
    this.historyPages.invalidateSession(sessionId)
  }

  invalidateHistoryPageChanges(sessionId: string, batch: SourceFrameBatch): void {
    this.historyPages.invalidateChanges(sessionId, batch)
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
