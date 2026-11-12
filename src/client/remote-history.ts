/** Shared accepted source entries and independent, transactionally published Pane windows. */
import type { Budget, HistoryDeltaV1, HistoryFeedV1, HistoryReadV1, HistorySnapshotV1, SessionEventChange, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceChanges, SourceChangesRequest, SourceEntry, SourcePage, SourceReadRequest, SourceSession } from '../remote/protocol.ts'
import { sourceRetentionPlan } from './source-window-retention.ts'
import { RemoteRecovery } from './remote-recovery.ts'
import { RemoteSessionState } from './remote-session-state.ts'
import { HistoryPublication, type PublishedWindow } from './history-publication.ts'
import { boundedSourceRead, recoverableSourceRead, revokedSourceRead, sourceReadFailureCode, waitForSourceReadRecovery } from './remote-read-recovery.ts'
import type { SourceReadingCache, SourceReadingCheckpoint } from './remote-reading-cache.ts'

export interface RemoteHistoryTransport {
  read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage>
  changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges>
}
export class RemoteHistoryError extends Error {
  constructor(readonly code: 'STALE_VERSION' | 'CAPACITY_EXCEEDED' | 'TARGET_UNAVAILABLE' | 'INVALID_REQUEST' | 'DISPOSED', message: string) { super(message); this.name = 'RemoteHistoryError' }
}
const PAGE_EVENTS = 160
const CACHE_BYTES = 32 * 1024 * 1024
const CACHE_EVENTS = 20_000
const REPLAY_DELTAS = 128
const encoder = new TextEncoder()
const bytes = new WeakMap<object, number>()
function size(entry: SessionEventLikeEntry): number {
  let value = bytes.get(entry)
  if (value === undefined) { value = encoder.encode(JSON.stringify(entry)).byteLength; bytes.set(entry, value) }
  return value
}
function windowBytes(entries: readonly SessionEventLikeEntry[]): number { return entries.reduce((total, entry) => total + size(entry), 0) }
function aborted(): DOMException { return new DOMException('The reading window was released.', 'AbortError') }
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason ?? aborted()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
function entriesBySeq(entries: readonly SessionEventLikeEntry[]): SessionEventLikeEntry[] {
  return [...new Map(entries.map(entry => [entry.event.seq, entry])).values()].sort((a, b) => a.event.seq - b.event.seq)
}
function token(epoch: string, version: number, revision: number): string { return JSON.stringify([epoch, version, revision]) }
function cursor(epoch: string, position: number | null): string | null { return position === null ? null : JSON.stringify([epoch, position]) }
function parseCursor(value: string, epoch: string): number {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new RemoteHistoryError('STALE_VERSION', 'Invalid history cursor.') }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== epoch || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) throw new RemoteHistoryError('STALE_VERSION', 'The source replaced this history cursor.')
  return parsed[1] as number
}
interface CachedPage { readonly page: Omit<SourcePage, 'entries'>; readonly seqs: readonly number[]; used: number }
interface CachedEntry { entry: SourceEntry; version: number; used: number }
interface PendingRead { promise: Promise<HistorySnapshotV1>; abort: AbortController; users: number; settled: boolean }
interface PendingPage { promise: Promise<SourcePage>; abort: AbortController; users: number; settled: boolean }
interface WindowMetadata { epoch: string; navigation: number; context: readonly number[]; budget: Budget }
export type RemoteReadingIntent = { kind: 'latest' } | { kind: 'around'; seq: number }
export interface AcceptedReadingPosition { epoch: string; seq: number; at: number }

export class RemoteSourceHistory {
  private readonly accepted = new RemoteSessionState()
  private epoch: string | undefined
  private version = 0
  private generation = 0
  private metadataVersion = -1
  private readonly entries = new Map<number, CachedEntry>()
  private readonly removed = new Map<number, number>()
  private readonly pages = new Map<string, CachedPage>()
  private readonly reads = new Map<string, PendingPage>()
  private readonly windows = new Map<string, RemoteHistoryWindow>()
  private readonly observers = new Set<(session: SourceSession) => void>()
  private readonly entryObservers = new Set<(entries: readonly SourceEntry[]) => void>()
  private readonly versionObservers = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private connection: AbortController | undefined
  private releaseTimer: ReturnType<typeof setTimeout> | undefined
  private clock = 0
  private connectionError: unknown
  private lastSession: SourceSession | undefined
  private restoredMetadata = false
  private cachedOpening: SourcePage | undefined
  /** Only an opening read in this lifetime can establish the current tail. */
  private preparedOpening: SourcePage | undefined
  private cacheRevoked = false
  private readonly cachedWindows = new Map<string, SourcePage>()
  constructor(readonly sessionId: string, private readonly transport: RemoteHistoryTransport,
    private readonly limits = { bytes: CACHE_BYTES, events: CACHE_EVENTS }, private readonly cache?: SourceReadingCache) {
    const saved = cache?.read(sessionId)
    if (!saved) return
    this.restoreCache(saved)
  }
  private restoreCache(saved: SourceReadingCheckpoint): void {
    this.restoredMetadata = true
    this.epoch = saved.epoch; this.version = saved.version; this.lastSession = saved.session; this.metadataVersion = saved.version
    this.cachedOpening = saved.head
    for (const window of saved.windows) this.cachedWindows.set(window.viewId, window.page)
    for (const page of [saved.head, ...saved.windows.map(window => window.page)]) for (const entry of page.entries) {
      const prior = this.entries.get(entry.event.seq)
      if (!prior || prior.version <= page.version) this.entries.set(entry.event.seq, { entry, version: page.version, used: ++this.clock })
    }
  }
  subscribeSession(listener: (session: SourceSession) => void): () => void {
    this.observers.add(listener)
    if (this.lastSession) listener(this.lastSession)
    return () => { this.observers.delete(listener) }
  }
  /** Accepted native identities support receipt reconciliation without another history request. */
  subscribeEntries(listener: (entries: readonly SourceEntry[]) => void): () => void {
    this.entryObservers.add(listener)
    listener([...this.entries.values()].map(value => value.entry))
    return () => { this.entryObservers.delete(listener) }
  }
  private notifyEntries(entries: readonly SourceEntry[]): void {
    for (const observer of this.entryObservers) observer(entries)
  }
  get sourceEpoch(): string { if (!this.epoch) throw new Error('Source baseline is not open'); return this.epoch }
  get sourceVersion(): number { return this.version }
  /** Read only the exact window the official reader accepted, never a prepared successor. */
  acceptedReadingPosition(viewId: string, version: string, seq: number): AcceptedReadingPosition | undefined {
    if (this.lifetime.signal.aborted) return undefined
    return this.windows.get(viewId)?.acceptedReadingPosition(version, seq)
  }
  get retainedBytes(): number { return [...this.entries.values()].reduce((total, value) => total + size(value.entry), 0) }
  get retainedEvents(): number { return this.entries.size }
  /** An inactive warm reader owns no live subscription or native execution. */
  suspend(): void {
    this.preparedOpening = undefined
    if (this.windows.size !== 0 || this.releaseTimer !== undefined) return
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined
      if (this.windows.size === 0) { this.connection?.abort(); this.connection = undefined }
    }, 300)
    this.releaseTimer.unref?.()
  }
  beginSnapshot(): () => void { return this.accepted.beginSnapshot() }
  get recoveryTarget(): string { return JSON.stringify([this.epoch, this.generation]) }
  reconcilePages(pages: readonly SourcePage[]): SourcePage { return this.accepted.merge(pages, this.sourceEpoch, this.version, this.lastSession ?? pages.at(-1)!.session) }
  get metadataFromCache(): boolean { return this.restoredMetadata }
  savedAnchor(cacheId: string): { epoch: string; seq: number } | undefined { return this.cacheRevoked ? undefined : this.cache?.readAnchor(this.sessionId, cacheId) }
  prepare(signal?: AbortSignal): Promise<SourcePage> {
    // Cached metadata may prepare the canonical operation owner immediately.
    // The Pane separately obtains its requested authoritative reading window.
    if (this.cachedOpening) return Promise.resolve(this.cachedOpening)
    return this.initialize({ kind: 'latest' }, signal).then(page => { this.preparedOpening = page; return page })
  }
  async openView(viewId: string, budget: Budget, signal?: AbortSignal, cacheId = viewId, intent: RemoteReadingIntent = { kind: 'latest' }): Promise<HistoryFeedV1> {
    this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
    const existing = this.windows.get(viewId)
    if (existing) return existing
    if (this.releaseTimer !== undefined) { clearTimeout(this.releaseTimer); this.releaseTimer = undefined }
    const baseline = intent.kind === 'latest' && this.preparedOpening
      ? this.materializePage(this.preparedOpening) : await this.initialize(intent, signal)
    this.preparedOpening = undefined
    this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
    const current = this.windows.get(viewId)
    if (current) return current
    const window = new RemoteHistoryWindow(this, viewId, baseline, budget, cacheId)
    this.cachedWindows.delete(cacheId)
    this.windows.set(viewId, window); this.startFollow(); this.persist()
    return window
  }
  private async initialize(intent: RemoteReadingIntent, signal: AbortSignal = this.lifetime.signal): Promise<SourcePage> {
    this.lifetime.signal.throwIfAborted()
    // A new Pane is a new navigation, not a request to replay its saved tail.
    // Existing readers keep their own window and stream checkpoint.
    // A quick remount still owns the source subscription through the release
    // debounce. Revalidate the tail without tearing down that live cursor.
    const baseline = this.windows.size === 0 && (!this.connection || this.connection.signal.aborted)
    if (baseline) { this.connection?.abort(); this.connection = undefined }
    const saved = intent.kind === 'latest' ? this.cachedOpening : [...this.cachedWindows.values(), ...(this.cachedOpening ? [this.cachedOpening] : [])]
      .find(page => page.entries.some(entry => entry.event.seq === intent.seq))
    try {
      const page = await this.fetchPage({ sessionId: this.sessionId, limit: PAGE_EVENTS,
        ...(intent.kind === 'around' ? { around: intent.seq } : {}) }, baseline, true, signal, Boolean(saved))
      return this.materializePage(page)
    } catch (error) {
      signal.throwIfAborted()
      if (!saved || this.cacheRevoked || !recoverableSourceRead(error)) throw error
      // Offline content remains readable, but its historical tail is not a
      // current-tail claim. Returning to latest will perform a live read.
      return { ...saved, hasAfter: true }
    }
  }
  async page(request: Omit<SourceReadRequest, 'sessionId'>, signal: AbortSignal): Promise<SourcePage> {
    this.lifetime.signal.throwIfAborted(); signal.throwIfAborted()
    if (this.connectionError) { this.connectionError = undefined; this.startFollow() }
    const result = await this.fetchPage({ ...request, sessionId: this.sessionId, epoch: this.sourceEpoch, limit: request.limit ?? PAGE_EVENTS }, false, false, signal)
    if (result.epoch !== this.epoch) throw new RemoteHistoryError('STALE_VERSION', 'The history changed while this page was loading.')
    if (request.before !== undefined || request.after !== undefined) await this.waitVersion(result.version, signal)
    return this.materializePage(result)
  }
  /** A replay gap revalidates the retained range using authoritative source pages, not stale resident tails. */
  async reconcilePage(request: Omit<SourceReadRequest, 'sessionId'>, signal: AbortSignal): Promise<SourcePage> {
    const page = await this.fetchPage({ ...request, sessionId: this.sessionId, epoch: this.sourceEpoch, limit: request.limit ?? PAGE_EVENTS }, false, true, signal)
    await this.waitVersion(page.version, signal)
    return page
  }
  private key(request: SourceReadRequest): string { return JSON.stringify([request.epoch ?? this.epoch ?? '', request.before ?? null, request.after ?? null, request.around ?? null, request.limit ?? PAGE_EVENTS]) }
  private async readAvailable(request: SourceReadRequest, signal: AbortSignal): Promise<SourcePage> {
    return boundedSourceRead(async lifetime => {
      for (let attempt = 0; ; ++attempt) {
        lifetime.throwIfAborted()
        try { return await this.transport.read(request, lifetime) }
        catch (error) {
          if (revokedSourceRead(error)) this.revokeCachedReading()
          if (!recoverableSourceRead(error)) throw error
          await waitForSourceReadRecovery(attempt, lifetime)
        }
      }
    }, signal)
  }
  private sharePage(pending: PendingPage, signal: AbortSignal): Promise<SourcePage> {
    ++pending.users
    return waitFor(pending.promise, signal).finally(() => { if (--pending.users === 0 && !pending.settled) pending.abort.abort() })
  }
  private fetchPage(request: SourceReadRequest, baseline = false, fresh = false, signal: AbortSignal = this.lifetime.signal, once = false): Promise<SourcePage> {
    signal.throwIfAborted()
    const key = this.key(request), cached = this.pages.get(key)
    if (!fresh && cached && cached.seqs.every(seq => {
      const entry = this.entries.get(seq)
      return entry !== undefined && entry.version <= Math.max(cached.page.version, this.version)
    })) {
      cached.used = ++this.clock
      return Promise.resolve({ ...cached.page, entries: cached.seqs.map(seq => this.entries.get(seq)!.entry) })
    }
    const pending = this.reads.get(key)
    if (pending && !pending.abort.signal.aborted) return this.sharePage(pending, signal)
    const expectedEpoch = this.epoch, generation = this.generation
    const abort = new AbortController()
    const lifetime = AbortSignal.any([this.lifetime.signal, abort.signal]), releaseSnapshot = this.beginSnapshot()
    const read = (once ? boundedSourceRead(live => this.transport.read(request, live), lifetime) : this.readAvailable(request, lifetime)).then(received => {
      this.lifetime.signal.throwIfAborted()
      let page = received
      if (page.session.id !== this.sessionId) throw new RemoteHistoryError('TARGET_UNAVAILABLE', 'A history page belongs to another source.')
      if (generation !== this.generation || expectedEpoch && this.epoch !== expectedEpoch) throw new RemoteHistoryError('STALE_VERSION', 'A late history page was superseded.')
      if (!this.epoch || baseline) {
        if (this.epoch === page.epoch && page.version < this.version) throw new RemoteHistoryError('STALE_VERSION', 'The source returned an older opening baseline.')
        if (this.epoch && (page.epoch !== this.epoch || page.version !== this.version)) {
          if (page.epoch !== this.epoch) this.cache?.remove(this.sessionId)
          ++this.generation
          this.pages.clear(); if (page.epoch !== this.epoch) this.entries.clear(); this.removed.clear(); this.metadataVersion = -1; this.cachedOpening = undefined; this.cachedWindows.clear()
        }
        if (this.windows.size === 0) { this.entries.clear(); this.pages.clear() }
        this.epoch = page.epoch; this.version = page.version; this.connectionError = undefined
      } else if (page.epoch !== this.epoch) throw new RemoteHistoryError('STALE_VERSION', 'The source history was replaced.')
      if (page.version < this.version) page = this.accepted.materialize(page, this.sourceEpoch, this.version, this.lastSession ?? page.session)
      if (baseline && !page.hasAfter && page.before !== null) {
        const present = new Set<number>(page.entries.map(entry => entry.event.seq))
        for (const seq of this.entries.keys()) if (seq >= page.before && !present.has(seq)) this.entries.delete(seq)
      }
      for (const entry of page.entries) {
        if ((this.removed.get(entry.event.seq) ?? -1) >= page.version) continue
        const previous = this.entries.get(entry.event.seq)
        if (!previous || previous.version <= page.version) this.entries.set(entry.event.seq, {
          entry: previous && JSON.stringify(previous.entry) === JSON.stringify(entry) ? previous.entry : entry,
          version: page.version, used: ++this.clock,
        })
      }
      this.acceptSession(page.session, page.version)
      this.notifyEntries(page.entries.flatMap(entry => { const value = this.entries.get(entry.event.seq); return value ? [value.entry] : [] }))
      const { entries: _entries, ...metadata } = page
      this.pages.set(this.key({ ...request, epoch: page.epoch }), { page: metadata,
        seqs: page.entries.filter(entry => this.entries.has(entry.event.seq)).map(entry => entry.event.seq), used: ++this.clock })
      if (request.before === undefined && request.after === undefined && request.around === undefined) {
        this.cachedOpening = this.materializePage(page)
      }
      this.persist()
      return page
    }).catch(error => { if (revokedSourceRead(error)) this.revokeCachedReading(); throw error }).finally(() => {
      releaseSnapshot()
      held.settled = true
      if (this.reads.get(key) === held) this.reads.delete(key)
      if (this.reads.size === 0) this.removed.clear()
    })
    const held: PendingPage = { promise: read, abort, users: 0, settled: false }
    this.reads.set(key, held)
    return this.sharePage(held, signal)
  }
  private materializePage(page: SourcePage): SourcePage {
    if (page.epoch !== this.epoch) throw new RemoteHistoryError('STALE_VERSION', 'The history baseline was replaced.')
    const version = Math.max(page.version, this.version)
    const entries = page.entries.flatMap(entry => {
      const accepted = this.entries.get(entry.event.seq)
      return accepted ? [accepted.version <= version ? accepted.entry : entry] : []
    })
    const appended = page.hasAfter ? [] : this.entriesAfter(page.after ?? -1)
    return { ...page, version: Math.max(page.version, this.version), session: this.lastSession ?? page.session,
      entries: entriesBySeq([...entries, ...appended]) as SourceEntry[],
      after: appended.length ? Math.max(page.after ?? 0, ...appended.map(entry => entry.event.seq)) : page.after }
  }
  private startFollow(): void {
    if (this.connection || this.lifetime.signal.aborted || !this.epoch || this.windows.size === 0) return
    const controller = new AbortController(); this.connection = controller
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    void (async () => {
      try {
        let attempt = 0
        while (!signal.aborted) {
          try {
            for await (const change of this.transport.changes({ sessionId: this.sessionId, epoch: this.sourceEpoch, version: this.version }, signal)) {
              signal.throwIfAborted()
              attempt = 0
              if (change.session.id !== this.sessionId) throw new RemoteHistoryError('INVALID_REQUEST', 'A source update crossed session scopes.')
              if (change.reset || change.epoch !== this.epoch) {
                const replaced = change.epoch !== this.epoch
                // Journal expiry does not revoke the source identity or the accepted reader.
                // Keep its body mounted until authoritative pages of the same range commit.
                if (replaced) this.cache?.remove(this.sessionId)
                ++this.generation
                this.accepted.reset()
                this.epoch = change.epoch; this.version = change.version; this.metadataVersion = -1
                if (replaced) this.entries.clear()
                this.pages.clear(); this.removed.clear(); this.cachedOpening = undefined; this.cachedWindows.clear()
                for (const entry of change.upserts) if (this.entries.has(entry.event.seq)) this.entries.set(entry.event.seq, { entry, version: change.version, used: ++this.clock })
                this.acceptSession(change.session, change.version)
                this.notifyEntries(change.upserts)
                for (const window of this.windows.values()) void window.recover().catch(error => { window.fail(error) })
                this.notifyVersion(); continue
              }
              if (change.version <= this.version) continue
              if (change.base !== this.version) throw new RemoteHistoryError('STALE_VERSION', 'The source update stream has a version gap; accepted history remains readable.')
              const retainedUpdates = new Set([...this.windows.values()].flatMap(window => window.relevantUpdates(change).map(entry => entry.event.seq)))
              for (const seq of change.removed) {
                if ((this.entries.get(seq)?.version ?? -1) <= change.version) this.entries.delete(seq)
                this.removed.set(seq, change.version)
              }
              const acceptedUpserts = change.upserts.map(entry => {
                this.removed.delete(entry.event.seq)
                const resident = this.entries.get(entry.event.seq), previous = resident?.entry
                if (resident && resident.version > change.version) return entry
                const accepted = previous && (previous === entry || JSON.stringify(previous) === JSON.stringify(entry)) ? previous : entry
                if (resident || retainedUpdates.has(entry.event.seq)) {
                  this.entries.set(entry.event.seq, { entry: accepted, version: change.version, used: ++this.clock })
                }
                return accepted
              })
              this.accepted.record(change)
              this.version = change.version; this.acceptSession(change.session, change.version)
              this.notifyEntries(acceptedUpserts)
              if (this.cachedOpening?.epoch === change.epoch && this.cachedOpening.version <= change.version) {
                const head = this.cachedOpening, seqs = head.entries.map(entry => entry.event.seq)
                this.cachedOpening = !head.hasAfter && change.upserts.some(entry => entry.event.seq > (head.after ?? -1) && !this.entries.has(entry.event.seq)) ? undefined : { ...head, session: change.session, version: change.version,
                  entries: entriesBySeq([...this.currentEntries(seqs), ...head.hasAfter ? [] : this.entriesAfter(head.after ?? -1)]) as SourceEntry[],
                  after: head.hasAfter ? head.after : Math.max(head.after ?? 0, ...change.upserts.map(entry => entry.event.seq)) }
              }
              for (const [key, page] of this.pages) {
                if ((!page.page.hasAfter && change.upserts.some(entry => entry.event.seq > (page.page.after ?? -1))) || change.removed.some(seq => page.seqs.includes(seq))) this.pages.delete(key)
              }
              for (const window of this.windows.values()) window.accept({ ...change, upserts: acceptedUpserts })
              this.notifyVersion(); this.trimCache(); this.persist()
              if (this.reads.size === 0) this.removed.clear()
              else if (this.removed.size > this.limits.events) { ++this.generation; this.removed.clear() }
            }
            if (!signal.aborted) throw new RemoteHistoryError('TARGET_UNAVAILABLE', 'The source subscription is reconnecting.')
          } catch (error) {
            signal.throwIfAborted()
            if (sourceReadFailureCode(error) === 'STALE_VERSION') {
              // A missing journal segment requires a new authoritative baseline.
              // Existing Pane snapshots stay mounted until their replacements commit.
              await this.fetchPage({ sessionId: this.sessionId, limit: PAGE_EVENTS }, true, true, signal)
              signal.throwIfAborted()
              for (const window of this.windows.values()) void window.recover().catch(cause => { window.fail(cause) })
              this.notifyVersion()
              await waitForSourceReadRecovery(attempt++, signal)
            } else {
              if (!recoverableSourceRead(error)) throw error
              await waitForSourceReadRecovery(attempt++, signal)
            }
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          if (revokedSourceRead(error)) this.revokeCachedReading()
          this.connectionError = error
          for (const window of this.windows.values()) window.fail(error)
          this.notifyVersion()
        }
      } finally { if (this.connection === controller) this.connection = undefined }
    })()
  }
  private waitVersion(version: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
    if (version <= this.version) return Promise.resolve()
    return boundedSourceRead(lifetime => new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.versionObservers.delete(check)
        lifetime.removeEventListener('abort', check); this.lifetime.signal.removeEventListener('abort', check)
      }
      const check = (): void => {
        if (lifetime.aborted || this.lifetime.signal.aborted) { cleanup(); reject(lifetime.reason ?? this.lifetime.signal.reason ?? aborted()) }
        else if (this.connectionError) { cleanup(); reject(this.connectionError) }
        else if (version <= this.version) { cleanup(); resolve() }
      }
      this.versionObservers.add(check)
      lifetime.addEventListener('abort', check, { once: true }); this.lifetime.signal.addEventListener('abort', check, { once: true }); check()
    }), signal)
  }
  private notifyVersion(): void { for (const observer of [...this.versionObservers]) observer() }
  private acceptSession(session: SourceSession, version: number): void {
    if (version < this.metadataVersion) return
    this.restoredMetadata = false
    this.metadataVersion = version; this.lastSession = session
    for (const observer of this.observers) observer(session)
  }
  /** Capture only current source versions; persistence never controls the native execution. */
  persist(): void {
    if (this.cacheRevoked || !this.cache || !this.lastSession || !this.epoch || this.metadataVersion > this.version) return
    // Keep the prior coherent checkpoint until every displayed window has
    // published this version. Source acceptance alone does not move a reader.
    if ([...this.windows.values()].some(window => window.publication.published && !window.cachePage(this.lastSession!))) return
    const windows = [...this.windows.values()].flatMap(window => {
      const page = window.cachePage(this.lastSession!)
      return page ? [{ viewId: window.cacheId, page }] : []
    })
    const head = this.cachedOpening ?? windows.find(window => !window.page.hasAfter)?.page ?? windows[0]?.page
    if (head?.epoch !== this.epoch || head.version !== this.version) return
    if ([head, ...windows.map(window => window.page)].some(page => page.entries.some(entry => (this.entries.get(entry.event.seq)?.version ?? 0) > this.version))) return
    const pages = [...this.pages.values()].filter(page => page.page.epoch === this.epoch && page.page.version <= this.version && page.seqs.every(seq => {
      const entry = this.entries.get(seq); return entry !== undefined && entry.version <= this.version
    })).map(page => ({
      ...page.page, session: this.lastSession!, version: this.version, entries: page.seqs.map(seq => this.entries.get(seq)!.entry),
    }))
    this.cache.write({ session: this.lastSession, epoch: this.epoch, version: this.version, head, windows, pages })
  }
  /** Explicit source/account revocation cannot be undone by a delayed Pane release. */
  revokeCachedReading(): void {
    this.cacheRevoked = true; this.cache?.remove(this.sessionId); this.cachedOpening = undefined; this.cachedWindows.clear()
  }
  discardReconciledEntries(previous: readonly number[], page: SourcePage): void {
    const present = new Set<number>(page.entries.map(entry => entry.event.seq))
    for (const seq of previous) if (!present.has(seq)) this.entries.delete(seq)
  }
  currentEntries(seqs: readonly number[]): SessionEventLikeEntry[] {
    return seqs.flatMap(seq => { const value = this.entries.get(seq); if (!value) return []; value.used = ++this.clock; return [value.entry] })
  }
  entriesAfter(seq: number): SourceEntry[] { return [...this.entries.values()].filter(value => value.version <= this.version).map(value => value.entry).filter(entry => entry.event.seq > seq).sort((a, b) => a.event.seq - b.event.seq) }
  /** Pressure is source-wide; page admission remains a separate contract. */
  admitWindow(window: RemoteHistoryWindow, entries: readonly SessionEventLikeEntry[], context: ReadonlySet<number>,
    requested: readonly SessionEventLikeEntry[], direction: 'older' | 'newer'): SessionEventLikeEntry[] {
    const other = new Set([...this.windows.values()].filter(value => value !== window).flatMap(value => value.sequences()))
    const present = new Set(entries.map(entry => entry.event.seq))
    const outside = [...other].filter(seq => !present.has(seq))
    const events = this.limits.events - outside.length
    const availableBytes = this.limits.bytes - outside.reduce((total, seq) => total + (this.entries.has(seq) ? size(this.entries.get(seq)!.entry) : 0), 0)
    if (entries.length <= events && windowBytes(entries) <= availableBytes) return [...entries]
    // Explicit dependency rows and the requested body must survive together.
    // Official windowCommit still validates every visible reader before trim.
    const required = new Set([...context, ...[...other].filter(seq => present.has(seq)), ...requested.map(entry => entry.event.seq)])
    // Keep source groups intact, then verify all explicit dependencies survived.
    const plan = sourceRetentionPlan(entries, [], direction, { events, bytes: availableBytes, size })
    const retained = entries.slice(plan.first, plan.last), retainedSeqs = new Set(retained.map(entry => entry.event.seq))
    if (!plan.fits || retained.length > events || windowBytes(retained) > availableBytes
      || entries.some(entry => required.has(entry.event.seq) && !retainedSeqs.has(entry.event.seq))) {
      throw new RemoteHistoryError('CAPACITY_EXCEEDED', 'The requested history and protected readers exceed this source cache budget. Existing history is unchanged.')
    }
    return retained
  }
  trimCache(): void {
    let used = [...this.entries.values()].reduce((total, value) => total + size(value.entry), 0)
    if (used <= this.limits.bytes && this.entries.size <= this.limits.events) return
    this.cachedOpening = undefined; this.cachedWindows.clear()
    const pinned = new Set([...this.windows.values()].flatMap(window => window.sequences()))
    const candidates = [...this.entries].filter(([seq]) => !pinned.has(seq)).sort((a, b) => a[1].used - b[1].used)
    for (const [seq, value] of candidates) {
      if (used <= this.limits.bytes && this.entries.size <= this.limits.events) break
      this.entries.delete(seq); used -= size(value.entry)
    }
    for (const [key, page] of this.pages) if (page.seqs.some(seq => !this.entries.has(seq))) this.pages.delete(key)
  }
  release(window: RemoteHistoryWindow): void {
    if (this.windows.get(window.viewId) !== window) return
    this.persist()
    const accepted = this.lastSession && window.cachePage(this.lastSession)
    if (this.cache && accepted) {
      this.cachedWindows.delete(window.cacheId); this.cachedWindows.set(window.cacheId, accepted)
      while (this.cachedWindows.size > this.cache.maxWindows) this.cachedWindows.delete(this.cachedWindows.keys().next().value!)
    }
    this.windows.delete(window.viewId); this.trimCache()
    if (this.windows.size === 0) {
      this.preparedOpening = undefined
      this.suspend()
      // A durable retain may restore this checkpoint; memory-only callers
      // still obtain a fresh baseline before opening another live view.
      if (!this.cache) {
        this.cachedOpening = undefined
        for (const [key, page] of this.pages) if (!page.page.hasAfter) this.pages.delete(key)
      }
    }
  }
  dispose(): void {
    if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer)
    ++this.generation; this.lifetime.abort(); this.connection?.abort(); this.connection = undefined
    for (const window of [...this.windows.values()]) window.release()
    this.entries.clear(); this.pages.clear(); this.removed.clear(); this.observers.clear(); this.entryObservers.clear(); this.notifyVersion()
  }
}

class RemoteHistoryWindow implements HistoryFeedV1 {
  readonly mode = 'complete-window' as const
  readonly initial: HistorySnapshotV1
  readonly publication: HistoryPublication<WindowMetadata>
  private state: HistorySnapshotV1
  private stateEpoch: string
  /** A target page may be ahead of the shared stream without blocking its Pane. */
  private sourceVersion: number
  private seqs: number[]
  private context = new Set<number>()
  private revision = 0
  /** Transport observations may validate an unchanged candidate without rebuilding it. */
  private readonly coveredVersions = new WeakMap<HistorySnapshotV1, number>()
  private readonly abort = new AbortController()
  private readonly journal: HistoryDeltaV1[] = []
  private journalBytes = 0
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, PendingRead>()
  private error: unknown
  private navigation = 0
  private readonly recoveryTask = new RemoteRecovery()
  private get recovery(): Promise<void> | undefined { return this.recoveryTask.pending }
  constructor(private readonly owner: RemoteSourceHistory, readonly viewId: string, page: SourcePage, private budget: Budget, readonly cacheId: string) {
    this.stateEpoch = page.epoch; this.sourceVersion = page.version; this.context = new Set(page.context); this.seqs = page.entries.map(entry => entry.event.seq)
    this.state = this.snapshot(page.entries, page.before, page.after, page.hasBefore, page.hasAfter); this.initial = this.state
    this.publication = new HistoryPublication(record => {
      this.abort.signal.throwIfAborted()
      if (record.metadata.epoch !== this.owner.sourceEpoch || record.metadata.navigation !== this.navigation) throw new RemoteHistoryError('STALE_VERSION', 'A newer source or navigation superseded this candidate.')
    }, () => { this.owner.trimCache(); this.owner.persist() }, record => { this.restorePublished(record) })
    this.stage()
  }
  sequences(): number[] { return [...new Set([...this.seqs, ...this.publication.windows().flatMap(record => record.snapshot.entries.map(entry => entry.event.seq))])] }
  relevantUpdates(change: Pick<SourceChanges, 'upserts' | 'version'>): SourceEntry[] {
    if (this.stateEpoch !== this.owner.sourceEpoch || change.version <= this.sourceVersion) return []
    const present = new Set(this.sequences()), tail = this.state.after ? parseCursor(this.state.after, this.stateEpoch) : -1
    const updates = change.upserts.filter(entry => present.has(entry.event.seq) || !this.state.hasAfter && entry.event.seq > tail)
    // A large reconnect backlog is an unread range, not one giant UI append.
    // Preserve revisions to the retained body; latest navigation seeks its tail.
    return updates.length > this.budget.events || windowBytes(updates) > this.budget.bytes
      ? updates.filter(entry => present.has(entry.event.seq)) : updates
  }
  private snapshot(entries: readonly SessionEventLikeEntry[], before: number | null, after: number | null, hasBefore: boolean, hasAfter: boolean): HistorySnapshotV1 {
    const snapshot = { version: token(this.stateEpoch, this.sourceVersion, ++this.revision), entries: entriesBySeq(entries), before: cursor(this.stateEpoch, before), after: cursor(this.stateEpoch, after), hasBefore, hasAfter }
    this.coveredVersions.set(snapshot, this.sourceVersion)
    return snapshot
  }
  private stage(): void {
    this.publication.stage(this.state, { epoch: this.stateEpoch, navigation: this.navigation, context: [...this.context], budget: this.budget }, windowBytes(this.state.entries))
  }
  acceptedReadingPosition(version: string, seq: number): AcceptedReadingPosition | undefined {
    const published = this.publication.published
    if (this.abort.signal.aborted || !published || published.snapshot.version !== version
      || published.metadata.epoch !== this.owner.sourceEpoch) return undefined
    const entry = published.snapshot.entries.find(entry => entry.type === 'event' && entry.event.seq === seq)
    return entry ? { epoch: published.metadata.epoch, seq, at: entry.event.time } : undefined
  }
  cachePage(session: SourceSession): SourcePage | undefined {
    const published = this.publication.published
    if (!published || published.metadata.epoch !== this.owner.sourceEpoch || this.coveredVersions.get(published.snapshot) !== this.owner.sourceVersion) return undefined
    const { snapshot, metadata } = published
    return { session, epoch: metadata.epoch, version: this.owner.sourceVersion, entries: snapshot.entries as SourceEntry[],
      before: snapshot.before ? parseCursor(snapshot.before, metadata.epoch) : null,
      after: snapshot.after ? parseCursor(snapshot.after, metadata.epoch) : null,
      hasBefore: snapshot.hasBefore, hasAfter: snapshot.hasAfter, context: [...metadata.context] }
  }
  private restorePublished(discarded: PublishedWindow<WindowMetadata>): void {
    const accepted = this.publication.published
    if (!accepted || accepted.order > discarded.order || discarded.metadata.navigation !== this.navigation || this.abort.signal.aborted) return
    ++this.navigation
    this.state = accepted.snapshot; this.stateEpoch = accepted.metadata.epoch; this.budget = accepted.metadata.budget
    this.sourceVersion = this.coveredVersions.get(accepted.snapshot) ?? this.owner.sourceVersion
    this.context = new Set(accepted.metadata.context); this.seqs = accepted.snapshot.entries.map(entry => entry.event.seq)
    this.journal.length = 0; this.journalBytes = 0
    if (this.stateEpoch !== this.owner.sourceEpoch) { void this.recover().catch(error => { this.fail(error) }); return }
    const entries = this.owner.currentEntries(this.seqs) as SourceEntry[], present = new Set<number>(entries.map(entry => entry.event.seq))
    const tail = this.state.after ? parseCursor(this.state.after, this.stateEpoch) : -1
    const appended = this.state.hasAfter ? [] : this.owner.entriesAfter(tail), removed = this.seqs.filter(seq => !present.has(seq))
    if (removed.length || appended.length || entries.some((entry, index) => entry !== this.state.entries[index])) {
      // Reapply changes already covered by the discarded candidate.
      const version = this.owner.sourceVersion
      this.sourceVersion = Math.min(this.sourceVersion, version - 1)
      this.accept({ upserts: [...entries, ...appended], removed, version })
    }
    this.owner.trimCache()
  }
  read(request: HistoryReadV1, budget: Budget, signal: AbortSignal): Promise<HistorySnapshotV1> {
    this.abort.signal.throwIfAborted(); signal.throwIfAborted()
    if (this.recovery) return waitFor(this.recovery, signal).then(() => this.read(request, budget, signal))
    const key = JSON.stringify(request)
    let pending = this.pending.get(key)
    if (!pending) {
      const navigation = request.kind === 'latest' || request.kind === 'around' ? ++this.navigation : this.navigation
      const abort = new AbortController(), work = this.performRead(request, budget, AbortSignal.any([abort.signal, this.abort.signal]), navigation)
      pending = { promise: work, abort, users: 0, settled: false }; this.pending.set(key, pending)
      const current = pending
      void work.finally(() => { current.settled = true; if (this.pending.get(key) === current) this.pending.delete(key) }).catch(() => {})
    }
    const current = pending; ++current.users
    return waitFor(current.promise, signal).finally(() => { if (--current.users === 0 && !current.settled) current.abort.abort() })
  }
  private async performRead(request: HistoryReadV1, budget: Budget, signal: AbortSignal, navigation: number): Promise<HistorySnapshotV1> {
    const epoch = this.owner.sourceEpoch
    let input: Omit<SourceReadRequest, 'sessionId'>
    switch (request.kind) {
      case 'before': input = { before: parseCursor(request.cursor, epoch) }; break
      case 'after': input = { after: parseCursor(request.cursor, epoch) }; break
      case 'around': input = { around: Number(request.target.seq) }; break
      case 'latest': {
        if (!this.state.hasAfter && !this.error && this.seqs.length > 0 && this.stateEpoch === epoch) {
          // Navigation changed even when all requested content is resident.
          this.state = this.snapshot(this.state.entries, this.state.before ? parseCursor(this.state.before, epoch) : null,
            this.state.after ? parseCursor(this.state.after, epoch) : null, this.state.hasBefore, false)
          this.stage(); return this.state
        }
        input = {}; break
      }
    }
    const page = await this.owner.page(input, signal)
    signal.throwIfAborted()
    if (navigation !== this.navigation || epoch !== this.owner.sourceEpoch) throw new RemoteHistoryError('STALE_VERSION', 'A newer navigation superseded this page.')
    const extending = request.kind === 'before' || request.kind === 'after'
    // The budget admits one source page. Previously accepted history belongs to
    // this reader until release; charging it again turns paging into a hard stop.
    if (page.entries.length > budget.events || windowBytes(page.entries) > budget.bytes) {
      throw new RemoteHistoryError('CAPACITY_EXCEEDED', 'This source page and its dependencies exceed the reading admission budget.')
    }
    let entries = entriesBySeq(extending ? [...this.state.entries, ...page.entries] : page.entries)
    const nextContext = new Set(extending ? [...this.context, ...page.context] : page.context)
    for (const entry of page.entries) if (!page.context.includes(entry.event.seq)) nextContext.delete(entry.event.seq)
    let hasBefore = request.kind === 'after' ? this.state.hasBefore : page.hasBefore
    let hasAfter = request.kind === 'before' ? this.state.hasAfter : page.hasAfter
    let before = request.kind === 'after' && this.state.before ? parseCursor(this.state.before, epoch) : page.before
    let after = request.kind === 'before' && this.state.after ? parseCursor(this.state.after, epoch) : page.after
    if (extending && this.state.before) {
      const prior = parseCursor(this.state.before, epoch)
      if (before === null || prior <= before) { before = prior; hasBefore = this.state.hasBefore }
    }
    if (extending && this.state.after) {
      const prior = parseCursor(this.state.after, epoch)
      if (after === null || prior >= after) { after = prior; hasAfter = this.state.hasAfter }
    }
    let admitted: SessionEventLikeEntry[]
    try { admitted = this.owner.admitWindow(this, entries, nextContext, page.entries, request.kind === 'before' ? 'older' : 'newer') }
    catch (error) { this.owner.trimCache(); throw error }
    if (admitted.length !== entries.length) {
      if (admitted[0] !== entries[0]) { before = admitted.find(entry => !nextContext.has(entry.event.seq))?.event.seq ?? null; hasBefore = true }
      if (admitted.at(-1) !== entries.at(-1)) { after = admitted.filter(entry => !nextContext.has(entry.event.seq)).at(-1)?.event.seq ?? null; hasAfter = true }
      entries = admitted
    }
    this.budget = budget; this.stateEpoch = epoch; this.sourceVersion = page.version; this.context = nextContext; this.seqs = entries.map(entry => entry.event.seq); this.error = undefined
    this.state = this.snapshot(entries, before, after, hasBefore, hasAfter); this.stage(); this.owner.trimCache()
    return this.state
  }
  accept(change: Pick<SourceChanges, 'upserts' | 'removed' | 'version'>): void {
    if (this.abort.signal.aborted || this.stateEpoch !== this.owner.sourceEpoch) return
    if (change.version <= this.sourceVersion) return
    const previous = this.state, present = new Set(this.seqs), tail = previous.after ? parseCursor(previous.after, this.stateEpoch) : -1
    const updates = this.relevantUpdates(change)
    const deferredTail = !previous.hasAfter && change.upserts.some(entry => entry.event.seq > tail)
      && !updates.some(entry => entry.event.seq > tail)
    this.sourceVersion = change.version
    const removed = new Set(change.removed)
    const headChanged = deferredTail || previous.hasAfter && change.upserts.some(entry => entry.event.seq > tail)
    if (updates.length > this.budget.events || windowBytes(updates) > this.budget.bytes) {
      this.fail(new RemoteHistoryError('CAPACITY_EXCEEDED', 'This source revision exceeds the reading admission budget.')); return
    }
    let entries = entriesBySeq([...previous.entries.filter(entry => !removed.has(entry.event.seq)), ...updates])
    try { entries = this.owner.admitWindow(this, entries, this.context, updates, 'newer') }
    catch (error) { this.fail(error); return }
    const trimmedBefore = entries[0] !== previous.entries[0]
    const hasAfter = previous.hasAfter || deferredTail
    const changed = entries.length !== previous.entries.length || entries.some((entry, index) => entry !== previous.entries[index])
    if (!changed && !headChanged) {
      // Source versions and cache provenance advance for repeated or unrelated
      // records, without rebuilding the exact unchanged reading candidate.
      this.coveredVersions.set(previous, this.sourceVersion)
      return
    }
    this.seqs = entries.map(entry => entry.event.seq)
    const appended = updates.some(entry => entry.event.seq > tail)
    const before = trimmedBefore ? entries.find(entry => !this.context.has(entry.event.seq))?.event.seq ?? null : previous.before ? parseCursor(previous.before, this.stateEpoch) : null
    const after = !previous.hasAfter && appended ? entries.filter(entry => !this.context.has(entry.event.seq)).at(-1)?.event.seq ?? null : previous.after ? parseCursor(previous.after, this.stateEpoch) : null
    this.state = this.snapshot(entries, before, after, previous.hasBefore || trimmedBefore, hasAfter); this.stage()
    let changes: SessionEventChange[] = []
    if (changed) changes = updates.every(entry => entry.event.seq > tail) && removed.size === 0 ? [{ kind: 'append', entries: updates }] : [{ kind: 'replace', entries }]
    this.record({ base: previous.version, version: this.state.version, changes, headChanged, snapshot: this.state })
  }
  cachedHead(session: SourceSession | undefined): SourcePage | undefined {
    if (!session || this.error || this.state.hasAfter || this.abort.signal.aborted || this.stateEpoch !== this.owner.sourceEpoch
      || this.coveredVersions.get(this.state) !== this.owner.sourceVersion) return undefined
    return { session, epoch: this.owner.sourceEpoch, version: this.owner.sourceVersion, entries: this.owner.currentEntries(this.seqs) as SourceEntry[],
      before: this.state.before ? parseCursor(this.state.before, this.stateEpoch) : null, after: this.state.after ? parseCursor(this.state.after, this.stateEpoch) : null,
      hasBefore: this.state.hasBefore, hasAfter: false, context: [...this.context] }
  }
  async refresh(budget: Budget = this.budget, signal: AbortSignal = this.abort.signal): Promise<HistorySnapshotV1> {
    this.abort.signal.throwIfAborted(); signal.throwIfAborted()
    if (!this.error && this.stateEpoch === this.owner.sourceEpoch) { this.stage(); return this.state }
    const committed = this.publication.published, snapshot = committed?.snapshot ?? this.state, context = new Set(committed?.metadata.context ?? this.context)
    const body = snapshot.entries.filter(entry => !context.has(entry.event.seq)), target = body[Math.floor(body.length / 2)]
    return this.read(target ? { kind: 'around', target: { key: String(target.event.seq), seq: target.event.seq as never } } : { kind: 'latest' }, budget, signal)
  }
  recover(): Promise<void> {
    return this.recoveryTask.request(this.owner.recoveryTarget, async current => {
      const release = this.owner.beginSnapshot()
      try {
        try { await this.performRecovery(current) }
        catch (error) {
          if (!current() || sourceReadFailureCode(error) !== 'STALE_VERSION') throw error
          await this.performRecovery(current)
        }
      } finally { release() }
    })
  }

  private async performRecovery(current: () => boolean): Promise<void> {
    const prior = this.state, navigation = ++this.navigation, epoch = this.owner.sourceEpoch
    const body = (this.publication.published?.snapshot ?? prior).entries.filter(entry => !this.context.has(entry.event.seq))
    const first = body[0]?.event.seq, last = body.at(-1)?.event.seq
    let page: SourcePage
    const pages: SourcePage[] = []
    if (this.stateEpoch === epoch && first !== undefined && last !== undefined) {
      // A journal gap invalidates cached revisions, not the reader's range.
      // Revalidate the complete retained interval before its atomic replacement.
      page = await this.owner.reconcilePage(first > 0 ? { after: first - 1, limit: 500 } : { around: first, limit: 500 }, this.abort.signal)
      pages.push(page)
      while (page.hasAfter && page.after !== null && page.after < last) {
        const next = await this.owner.reconcilePage({ after: page.after, limit: 500 }, this.abort.signal)
        if (next.after === null || next.after <= page.after) throw new RemoteHistoryError('INVALID_REQUEST', 'The source recovery cursor did not advance.')
        pages.push(next); page = next
      }
    } else { page = await this.owner.reconcilePage(first === undefined ? {} : { around: first }, this.abort.signal); pages.push(page) }
    this.abort.signal.throwIfAborted()
    if (!current() || navigation !== this.navigation || epoch !== this.owner.sourceEpoch) return
    page = this.owner.reconcilePages(pages)
    this.owner.discardReconciledEntries(this.seqs, page)
    // Live revisions may have published while the retained range was loading.
    // Its replacement must extend that current chain, not fork the old cursor.
    const base = this.state.version
    this.error = undefined; this.stateEpoch = epoch; this.sourceVersion = page.version; this.context = new Set(page.context); this.seqs = page.entries.map(entry => entry.event.seq)
    this.state = this.snapshot(page.entries, page.before, page.after, page.hasBefore, page.hasAfter); this.stage()
    this.record({ base, version: this.state.version, changes: [{ kind: 'replace', entries: this.state.entries }], headChanged: page.hasAfter, snapshot: this.state })
  }
  fail(error: unknown): void { this.error = error; for (const listener of this.listeners) listener() }
  private record(delta: HistoryDeltaV1): void {
    this.journal.push(delta); this.journalBytes += delta.snapshot ? windowBytes(delta.snapshot.entries) : 0
    // The newest checkpoint references the already resident window. Expiring
    // that single frame would make its current reader stale immediately.
    while (this.journal.length > 1 && (this.journal.length > REPLAY_DELTAS || this.journalBytes > CACHE_BYTES)) {
      const expired = this.journal.shift()!; this.journalBytes -= expired.snapshot ? windowBytes(expired.snapshot.entries) : 0
    }
    for (const listener of this.listeners) listener()
  }
  async *changes(after: string, signal: AbortSignal): AsyncIterable<HistoryDeltaV1> {
    const lifetime = AbortSignal.any([signal, this.abort.signal]); let current = after
    while (!lifetime.aborted) {
      if (this.error) throw this.error
      const delta = this.journal.find(value => value.base === current)
      if (delta) { current = delta.version; yield delta; continue }
      if (current !== this.state.version) throw new RemoteHistoryError('STALE_VERSION', 'This reader fell behind the bounded change journal.')
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => { cleanup(); resolve() }, stop = (): void => { cleanup(); reject(lifetime.reason ?? aborted()) }
        const cleanup = (): void => { this.listeners.delete(wake); lifetime.removeEventListener('abort', stop) }
        this.listeners.add(wake); lifetime.addEventListener('abort', stop, { once: true })
        if (lifetime.aborted) stop(); else if (this.error || this.state.version !== current) wake()
      })
    }
    lifetime.throwIfAborted()
  }
  release(): void {
    if (this.abort.signal.aborted) return
    this.abort.abort(); this.owner.release(this); this.publication.dispose(); this.listeners.clear(); this.journal.length = 0; this.journalBytes = 0
  }
}
