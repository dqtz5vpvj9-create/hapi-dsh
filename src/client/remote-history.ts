/** Shared accepted source entries and independent, transactionally published Pane windows. */
import type { Budget, HistoryDeltaV1, HistoryFeedV1, HistoryReadV1, HistorySnapshotV1, SessionEventChange, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceChanges, SourceChangesRequest, SourceEntry, SourcePage, SourceReadRequest, SourceSession } from '../remote/protocol.ts'
import { HistoryPublication, type PublishedWindow } from './history-publication.ts'

export interface RemoteHistoryTransport {
  read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage>
  changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges>
}
export class RemoteHistoryError extends Error {
  constructor(readonly code: 'STALE_VERSION' | 'CAPACITY_EXCEEDED' | 'TARGET_UNAVAILABLE' | 'DISPOSED', message: string) { super(message); this.name = 'RemoteHistoryError' }
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
interface WindowMetadata { epoch: string; navigation: number; context: readonly number[]; budget: Budget }

export class RemoteSourceHistory {
  private epoch: string | undefined
  private version = 0
  private generation = 0
  private metadataVersion = -1
  private readonly entries = new Map<number, CachedEntry>()
  private readonly removed = new Map<number, number>()
  private readonly pages = new Map<string, CachedPage>()
  private readonly reads = new Map<string, Promise<SourcePage>>()
  private readonly windows = new Map<string, RemoteHistoryWindow>()
  private readonly observers = new Set<(session: SourceSession) => void>()
  private readonly versionObservers = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private connection: AbortController | undefined
  private initializing: Promise<SourcePage> | undefined
  private clock = 0
  private connectionError: unknown
  private lastSession: SourceSession | undefined
  constructor(readonly sessionId: string, private readonly transport: RemoteHistoryTransport,
    private readonly limits = { bytes: CACHE_BYTES, events: CACHE_EVENTS }) {}
  subscribeSession(listener: (session: SourceSession) => void): () => void {
    this.observers.add(listener)
    if (this.lastSession) listener(this.lastSession)
    return () => { this.observers.delete(listener) }
  }
  get sourceEpoch(): string { if (!this.epoch) throw new Error('Source baseline is not open'); return this.epoch }
  get sourceVersion(): number { return this.version }
  prepare(): Promise<SourcePage> { return this.initialize() }
  async openView(viewId: string, budget: Budget, signal?: AbortSignal): Promise<HistoryFeedV1> {
    this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
    const existing = this.windows.get(viewId)
    if (existing) return existing
    const baseline = await waitFor(this.initialize(), signal)
    this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
    const current = this.windows.get(viewId)
    if (current) return current
    const window = new RemoteHistoryWindow(this, viewId, baseline, budget)
    this.windows.set(viewId, window); this.startFollow()
    return window
  }
  private initialize(): Promise<SourcePage> {
    this.lifetime.signal.throwIfAborted()
    for (const window of this.windows.values()) {
      const head = window.cachedHead(this.lastSession)
      if (head && !this.connectionError) return Promise.resolve(head)
    }
    if (!this.initializing) {
      const work = this.fetchPage({ sessionId: this.sessionId, limit: PAGE_EVENTS }, this.windows.size === 0)
        .then(async page => { await this.waitVersion(page.version, this.lifetime.signal); return this.materializePage(page) })
      this.initializing = work
      void work.finally(() => { if (this.initializing === work) this.initializing = undefined }).catch(() => {})
    }
    return this.initializing
  }
  async page(request: Omit<SourceReadRequest, 'sessionId'>, signal: AbortSignal): Promise<SourcePage> {
    this.lifetime.signal.throwIfAborted(); signal.throwIfAborted()
    if (this.connectionError) { this.connectionError = undefined; this.startFollow() }
    const result = await waitFor(this.fetchPage({ ...request, sessionId: this.sessionId, epoch: this.sourceEpoch, limit: request.limit ?? PAGE_EVENTS }), signal)
    if (result.epoch !== this.epoch) throw new RemoteHistoryError('STALE_VERSION', 'The history changed while this page was loading.')
    await this.waitVersion(result.version, signal)
    return this.materializePage(result)
  }
  private key(request: SourceReadRequest): string { return JSON.stringify([request.epoch ?? this.epoch ?? '', request.before ?? null, request.after ?? null, request.around ?? null, request.limit ?? PAGE_EVENTS]) }
  private fetchPage(request: SourceReadRequest, baseline = false): Promise<SourcePage> {
    const key = this.key(request), cached = this.pages.get(key)
    if (cached && cached.seqs.every(seq => this.entries.has(seq))) {
      cached.used = ++this.clock
      return Promise.resolve({ ...cached.page, entries: cached.seqs.map(seq => this.entries.get(seq)!.entry) })
    }
    const pending = this.reads.get(key)
    if (pending) return pending
    const expectedEpoch = this.epoch, generation = this.generation
    const read = this.transport.read(request, this.lifetime.signal).then(page => {
      this.lifetime.signal.throwIfAborted()
      if (page.session.id !== this.sessionId) throw new RemoteHistoryError('TARGET_UNAVAILABLE', 'A history page belongs to another source.')
      if (generation !== this.generation || expectedEpoch && this.epoch !== expectedEpoch) throw new RemoteHistoryError('STALE_VERSION', 'A late history page was superseded.')
      if (!this.epoch || baseline) {
        if (this.epoch === page.epoch && page.version < this.version) throw new RemoteHistoryError('STALE_VERSION', 'The source returned an older opening baseline.')
        if (this.epoch && (page.epoch !== this.epoch || page.version !== this.version)) {
          ++this.generation
          this.pages.clear(); this.entries.clear(); this.removed.clear(); this.metadataVersion = -1
        }
        this.epoch = page.epoch; this.version = page.version; this.connectionError = undefined
      } else if (page.epoch !== this.epoch) throw new RemoteHistoryError('STALE_VERSION', 'The source history was replaced.')
      for (const entry of page.entries) {
        if ((this.removed.get(entry.event.seq) ?? -1) >= page.version) continue
        const previous = this.entries.get(entry.event.seq)
        if (!previous || previous.version <= page.version) this.entries.set(entry.event.seq, {
          entry: previous && JSON.stringify(previous.entry) === JSON.stringify(entry) ? previous.entry : entry,
          version: page.version, used: ++this.clock,
        })
      }
      this.acceptSession(page.session, page.version)
      const { entries: _entries, ...metadata } = page
      this.pages.set(this.key({ ...request, epoch: page.epoch }), { page: metadata,
        seqs: page.entries.filter(entry => this.entries.has(entry.event.seq)).map(entry => entry.event.seq), used: ++this.clock })
      return page
    }).finally(() => {
      if (this.reads.get(key) === read) this.reads.delete(key)
      if (this.reads.size === 0) this.removed.clear()
    })
    this.reads.set(key, read)
    return read
  }
  private materializePage(page: SourcePage): SourcePage {
    if (page.epoch !== this.epoch) throw new RemoteHistoryError('STALE_VERSION', 'The history baseline was replaced.')
    return { ...page, version: Math.max(page.version, this.version), session: this.lastSession ?? page.session,
      entries: page.entries.flatMap(entry => { const accepted = this.entries.get(entry.event.seq); return accepted ? [accepted.entry] : [] }) }
  }
  private startFollow(): void {
    if (this.connection || this.lifetime.signal.aborted || !this.epoch || this.windows.size === 0) return
    const controller = new AbortController(); this.connection = controller
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    void (async () => {
      try {
        for await (const change of this.transport.changes({ sessionId: this.sessionId, epoch: this.sourceEpoch, version: this.version }, signal)) {
          signal.throwIfAborted()
          if (change.session.id !== this.sessionId) throw new RemoteHistoryError('TARGET_UNAVAILABLE', 'A source update crossed session scopes.')
          if (change.reset || change.epoch !== this.epoch) {
            ++this.generation
            this.epoch = change.epoch; this.version = change.version; this.metadataVersion = -1
            this.entries.clear(); this.pages.clear(); this.removed.clear(); this.initializing = undefined
            for (const entry of change.upserts) this.entries.set(entry.event.seq, { entry, version: change.version, used: ++this.clock })
            this.acceptSession(change.session, change.version)
            for (const window of this.windows.values()) void window.recover().catch(error => { window.fail(error) })
            this.notifyVersion(); continue
          }
          if (change.version <= this.version) continue
          if (change.base !== this.version) throw new RemoteHistoryError('STALE_VERSION', 'The source update stream has a version gap; accepted history remains readable.')
          for (const seq of change.removed) { this.entries.delete(seq); this.removed.set(seq, change.version) }
          for (const entry of change.upserts) { this.removed.delete(entry.event.seq); this.entries.set(entry.event.seq, { entry, version: change.version, used: ++this.clock }) }
          this.version = change.version; this.acceptSession(change.session, change.version)
          for (const [key, page] of this.pages) {
            if ((!page.page.hasAfter && change.upserts.some(entry => entry.event.seq > (page.page.after ?? -1))) || change.removed.some(seq => page.seqs.includes(seq))) this.pages.delete(key)
          }
          for (const window of this.windows.values()) window.accept(change)
          this.notifyVersion(); this.trimCache()
          if (this.reads.size === 0) this.removed.clear()
          else if (this.removed.size > this.limits.events) { ++this.generation; this.removed.clear() }
        }
        if (!signal.aborted) throw new RemoteHistoryError('TARGET_UNAVAILABLE', 'The source subscription closed. Retry history to reconnect.')
      } catch (error) {
        if (!signal.aborted) {
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
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.versionObservers.delete(check)
        signal.removeEventListener('abort', check); this.lifetime.signal.removeEventListener('abort', check)
      }
      const check = (): void => {
        if (signal.aborted || this.lifetime.signal.aborted) { cleanup(); reject(signal.reason ?? this.lifetime.signal.reason ?? aborted()) }
        else if (this.connectionError) { cleanup(); reject(this.connectionError) }
        else if (version <= this.version) { cleanup(); resolve() }
      }
      this.versionObservers.add(check)
      signal.addEventListener('abort', check, { once: true }); this.lifetime.signal.addEventListener('abort', check, { once: true }); check()
    })
  }
  private notifyVersion(): void { for (const observer of [...this.versionObservers]) observer() }
  private acceptSession(session: SourceSession, version: number): void {
    if (version < this.metadataVersion) return
    this.metadataVersion = version; this.lastSession = session
    for (const observer of this.observers) observer(session)
  }
  currentEntries(seqs: readonly number[]): SessionEventLikeEntry[] {
    return seqs.flatMap(seq => { const value = this.entries.get(seq); if (!value) return []; value.used = ++this.clock; return [value.entry] })
  }
  entriesAfter(seq: number): SourceEntry[] { return [...this.entries.values()].map(value => value.entry).filter(entry => entry.event.seq > seq).sort((a, b) => a.event.seq - b.event.seq) }
  trimCache(): void {
    let used = [...this.entries.values()].reduce((total, value) => total + size(value.entry), 0)
    if (used <= this.limits.bytes && this.entries.size <= this.limits.events) return
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
    this.windows.delete(window.viewId); this.trimCache()
    if (this.windows.size === 0) {
      this.connection?.abort(); this.connection = undefined; this.initializing = undefined
      for (const [key, page] of this.pages) if (!page.page.hasAfter) this.pages.delete(key)
    }
  }
  dispose(): void {
    ++this.generation; this.lifetime.abort(); this.connection?.abort(); this.connection = undefined
    for (const window of [...this.windows.values()]) window.release()
    this.entries.clear(); this.pages.clear(); this.removed.clear(); this.observers.clear(); this.notifyVersion()
  }
}

class RemoteHistoryWindow implements HistoryFeedV1 {
  readonly mode = 'complete-window' as const
  readonly initial: HistorySnapshotV1
  readonly publication: HistoryPublication<WindowMetadata>
  private state: HistorySnapshotV1
  private stateEpoch: string
  private seqs: number[]
  private context = new Set<number>()
  private revision = 0
  private readonly abort = new AbortController()
  private readonly journal: HistoryDeltaV1[] = []
  private journalBytes = 0
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, PendingRead>()
  private error: unknown
  private navigation = 0
  constructor(private readonly owner: RemoteSourceHistory, readonly viewId: string, page: SourcePage, private budget: Budget) {
    this.stateEpoch = page.epoch; this.context = new Set(page.context); this.seqs = page.entries.map(entry => entry.event.seq)
    this.state = this.snapshot(page.entries, page.before, page.after, page.hasBefore, page.hasAfter); this.initial = this.state
    this.publication = new HistoryPublication(record => {
      this.abort.signal.throwIfAborted()
      if (record.metadata.epoch !== this.owner.sourceEpoch || record.metadata.navigation !== this.navigation) throw new RemoteHistoryError('STALE_VERSION', 'A newer source or navigation superseded this candidate.')
    }, () => { this.owner.trimCache() }, record => { this.restorePublished(record) })
    this.stage()
  }
  sequences(): number[] { return [...new Set([...this.seqs, ...this.publication.windows().flatMap(record => record.snapshot.entries.map(entry => entry.event.seq))])] }
  private snapshot(entries: readonly SessionEventLikeEntry[], before: number | null, after: number | null, hasBefore: boolean, hasAfter: boolean): HistorySnapshotV1 {
    return { version: token(this.owner.sourceEpoch, this.owner.sourceVersion, ++this.revision), entries: entriesBySeq(entries), before: cursor(this.owner.sourceEpoch, before), after: cursor(this.owner.sourceEpoch, after), hasBefore, hasAfter }
  }
  private stage(): void {
    this.publication.stage(this.state, { epoch: this.stateEpoch, navigation: this.navigation, context: [...this.context], budget: this.budget }, windowBytes(this.state.entries))
  }
  private restorePublished(discarded: PublishedWindow<WindowMetadata>): void {
    const accepted = this.publication.published
    if (!accepted || accepted.order > discarded.order || discarded.metadata.navigation !== this.navigation || this.abort.signal.aborted) return
    ++this.navigation
    this.state = accepted.snapshot; this.stateEpoch = accepted.metadata.epoch; this.budget = accepted.metadata.budget
    this.context = new Set(accepted.metadata.context); this.seqs = accepted.snapshot.entries.map(entry => entry.event.seq)
    this.journal.length = 0; this.journalBytes = 0
    if (this.stateEpoch !== this.owner.sourceEpoch) { void this.recover().catch(error => { this.fail(error) }); return }
    const entries = this.owner.currentEntries(this.seqs) as SourceEntry[], present = new Set<number>(entries.map(entry => entry.event.seq))
    const tail = this.state.after ? parseCursor(this.state.after, this.stateEpoch) : -1
    this.accept({ upserts: [...entries, ...this.state.hasAfter ? [] : this.owner.entriesAfter(tail)], removed: this.seqs.filter(seq => !present.has(seq)) })
    this.owner.trimCache()
  }
  read(request: HistoryReadV1, budget: Budget, signal: AbortSignal): Promise<HistorySnapshotV1> {
    this.abort.signal.throwIfAborted(); signal.throwIfAborted()
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
    const entries = entriesBySeq(extending ? [...this.owner.currentEntries(this.seqs), ...page.entries] : page.entries)
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
    this.budget = budget; this.stateEpoch = epoch; this.context = nextContext; this.seqs = entries.map(entry => entry.event.seq); this.error = undefined
    this.state = this.snapshot(entries, before, after, hasBefore, hasAfter); this.stage(); this.owner.trimCache()
    return this.state
  }
  accept(change: Pick<SourceChanges, 'upserts' | 'removed'>): void {
    if (this.abort.signal.aborted || this.stateEpoch !== this.owner.sourceEpoch) return
    const previous = this.state, present = new Set(this.seqs), tail = previous.after ? parseCursor(previous.after, this.stateEpoch) : -1
    const updates = change.upserts.filter(entry => present.has(entry.event.seq) || !previous.hasAfter && entry.event.seq > tail)
    const removed = new Set(change.removed)
    if (updates.length > this.budget.events || windowBytes(updates) > this.budget.bytes) {
      this.fail(new RemoteHistoryError('CAPACITY_EXCEEDED', 'This source revision exceeds the reading admission budget.')); return
    }
    const entries = entriesBySeq([...this.owner.currentEntries(this.seqs).filter(entry => !removed.has(entry.event.seq)), ...updates])
    const hasAfter = previous.hasAfter
    this.seqs = entries.map(entry => entry.event.seq)
    const appended = updates.some(entry => entry.event.seq > tail), changed = updates.length > 0 || change.removed.some(seq => present.has(seq))
    const before = previous.before ? parseCursor(previous.before, this.stateEpoch) : null
    const after = !previous.hasAfter && appended ? entries.filter(entry => !this.context.has(entry.event.seq)).at(-1)?.event.seq ?? null : previous.after ? parseCursor(previous.after, this.stateEpoch) : null
    this.state = this.snapshot(entries, before, after, previous.hasBefore, hasAfter); this.stage()
    let changes: SessionEventChange[] = []
    if (changed) changes = updates.every(entry => entry.event.seq > tail) && removed.size === 0 ? [{ kind: 'append', entries: updates }] : [{ kind: 'replace', entries }]
    this.record({ base: previous.version, version: this.state.version, changes, headChanged: hasAfter && change.upserts.some(entry => entry.event.seq > tail), snapshot: this.state })
  }
  cachedHead(session: SourceSession | undefined): SourcePage | undefined {
    if (!session || this.error || this.state.hasAfter || this.abort.signal.aborted || this.stateEpoch !== this.owner.sourceEpoch) return undefined
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
  async recover(): Promise<void> {
    const prior = this.state, navigation = ++this.navigation, epoch = this.owner.sourceEpoch
    const body = (this.publication.published?.snapshot ?? prior).entries.find(entry => !this.context.has(entry.event.seq))
    const page = await this.owner.page(body ? { around: body.event.seq } : {}, this.abort.signal)
    this.abort.signal.throwIfAborted()
    if (navigation !== this.navigation || epoch !== this.owner.sourceEpoch) return
    this.error = undefined; this.stateEpoch = epoch; this.context = new Set(page.context); this.seqs = page.entries.map(entry => entry.event.seq)
    this.state = this.snapshot(page.entries, page.before, page.after, page.hasBefore, page.hasAfter); this.stage()
    this.record({ base: prior.version, version: this.state.version, changes: [{ kind: 'replace', entries: this.state.entries }], headChanged: page.hasAfter, snapshot: this.state })
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
