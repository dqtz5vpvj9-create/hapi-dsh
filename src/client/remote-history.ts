/** Shared accepted source entries, with one independent official history feed per Pane. */
import type { Budget, HistoryDeltaV1, HistoryFeedV1, HistoryReadV1, HistorySnapshotV1, SessionEventChange, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceChanges, SourceChangesRequest, SourceEntry, SourcePage, SourceReadRequest, SourceSession } from '../remote/protocol.ts'

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
  if (!Array.isArray(parsed) || parsed[0] !== epoch || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) throw new RemoteHistoryError('STALE_VERSION', 'The source replaced this history cursor.')
  return parsed[1] as number
}

interface CachedPage { readonly page: Omit<SourcePage, 'entries'>; readonly seqs: readonly number[]; used: number }
interface CachedEntry { entry: SourceEntry; version: number; used: number }

/** One cache is shared by readers of one machine/engine/native-thread identity. */
export class RemoteSourceHistory {
  private epoch: string | undefined
  private version = 0
  private readonly entries = new Map<number, CachedEntry>()
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
    this.lifetime.signal.throwIfAborted()
    signal?.throwIfAborted()
    const existing = this.windows.get(viewId)
    if (existing) return existing
    const baseline = await waitFor(this.initialize(), signal)
    signal?.throwIfAborted()
    // Concurrent calls for the same official occurrence retain the same feed.
    const current = this.windows.get(viewId)
    if (current) return current
    const window = new RemoteHistoryWindow(this, viewId, baseline, budget)
    this.windows.set(viewId, window)
    this.startFollow()
    return window
  }

  private initialize(): Promise<SourcePage> {
    for (const window of this.windows.values()) {
      const head = window.cachedHead(this.lastSession)
      if (head && !this.connectionError) return Promise.resolve(head)
    }
    if (!this.initializing) {
      this.initializing = this.fetchPage({ sessionId: this.sessionId, limit: PAGE_EVENTS }, true)
      void this.initializing.catch(() => { this.initializing = undefined })
    }
    return this.initializing.then(page => this.materializePage(page))
  }

  async page(request: Omit<SourceReadRequest, 'sessionId'>, signal: AbortSignal): Promise<SourcePage> {
    this.lifetime.signal.throwIfAborted(); signal.throwIfAborted()
    if (this.connectionError) {
      this.connectionError = undefined
      this.startFollow()
    }
    const result = await waitFor(this.fetchPage({ ...request, sessionId: this.sessionId, epoch: this.sourceEpoch, limit: request.limit ?? PAGE_EVENTS }), signal)
    if (result.epoch !== this.epoch) throw new RemoteHistoryError('STALE_VERSION', 'The history changed while this page was loading.')
    await this.waitVersion(result.version, signal)
    return this.materializePage(result)
  }

  private key(request: SourceReadRequest): string { return JSON.stringify([request.epoch ?? this.epoch ?? '', request.before ?? null, request.after ?? null, request.around ?? null, request.limit ?? PAGE_EVENTS]) }

  private fetchPage(request: SourceReadRequest, baseline = false): Promise<SourcePage> {
    const key = this.key(request)
    const cached = this.pages.get(key)
    if (cached && cached.seqs.every(seq => this.entries.has(seq))) {
      cached.used = ++this.clock
      return Promise.resolve({ ...cached.page, entries: cached.seqs.map(seq => this.entries.get(seq)!.entry) })
    }
    const pending = this.reads.get(key)
    if (pending) return pending
    const expectedEpoch = this.epoch
    const read = this.transport.read(request, this.lifetime.signal).then(page => {
      this.lifetime.signal.throwIfAborted()
      if (page.session.id !== this.sessionId) throw new RemoteHistoryError('TARGET_UNAVAILABLE', 'A history page belongs to another source.')
      if (expectedEpoch && this.epoch !== expectedEpoch) throw new RemoteHistoryError('STALE_VERSION', 'A late history page was superseded.')
      if (!this.epoch || baseline) {
        if (this.epoch && page.epoch !== this.epoch) { this.pages.clear(); this.entries.clear() }
        this.epoch = page.epoch; this.version = page.version
      } else if (page.epoch !== this.epoch) throw new RemoteHistoryError('STALE_VERSION', 'The source history was replaced.')
      for (const entry of page.entries) {
        const previous = this.entries.get(entry.event.seq)
        if (!previous || previous.version <= page.version) this.entries.set(entry.event.seq, { entry: previous && JSON.stringify(previous.entry) === JSON.stringify(entry) ? previous.entry : entry, version: page.version, used: ++this.clock })
      }
      this.acceptSession(page.session)
      const { entries: _entries, ...metadata } = page
      this.pages.set(this.key({ ...request, epoch: page.epoch }), { page: metadata, seqs: page.entries.map(entry => entry.event.seq), used: ++this.clock })
      return page
    }).finally(() => { if (this.reads.get(key) === read) this.reads.delete(key) })
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
    const controller = new AbortController()
    this.connection = controller
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    void (async () => {
      try {
        for await (const change of this.transport.changes({ sessionId: this.sessionId, epoch: this.sourceEpoch, version: this.version }, signal)) {
          signal.throwIfAborted()
          if (change.session.id !== this.sessionId) throw new RemoteHistoryError('TARGET_UNAVAILABLE', 'A source update crossed session scopes.')
          if (change.reset || change.epoch !== this.epoch) {
            this.epoch = change.epoch; this.version = change.version
            this.entries.clear(); this.pages.clear(); this.initializing = undefined
            for (const entry of change.upserts) this.entries.set(entry.event.seq, { entry, version: change.version, used: ++this.clock })
            this.acceptSession(change.session)
            for (const window of this.windows.values()) void window.recover().catch(error => { window.fail(error) })
            this.notifyVersion()
            continue
          }
          if (change.version <= this.version) continue
          if (change.base !== this.version) throw new RemoteHistoryError('STALE_VERSION', 'The source update stream has a version gap; history remains readable until recovery.')
          for (const seq of change.removed) this.entries.delete(seq)
          for (const entry of change.upserts) this.entries.set(entry.event.seq, { entry, version: change.version, used: ++this.clock })
          this.version = change.version
          this.acceptSession(change.session)
          for (const [key, page] of this.pages) {
            // A cached boundary remains reusable on edits. New tail content
            // invalidates only the cached head read, never already-read pages.
            if (!page.page.hasAfter && change.upserts.some(entry => entry.event.seq > (page.page.after ?? -1)) || change.removed.some(seq => page.seqs.includes(seq))) this.pages.delete(key)
          }
          for (const window of this.windows.values()) window.accept(change)
          this.notifyVersion()
          this.trimCache()
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
    if (version <= this.version) return Promise.resolve()
    return waitFor(new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (this.connectionError) { this.versionObservers.delete(check); reject(this.connectionError) }
        else if (version <= this.version) { this.versionObservers.delete(check); resolve() }
        else if (signal.aborted) { this.versionObservers.delete(check); reject(signal.reason ?? aborted()) }
      }
      this.versionObservers.add(check)
      signal.addEventListener('abort', check, { once: true })
      check()
    }), signal)
  }
  private notifyVersion(): void { for (const observer of [...this.versionObservers]) observer() }
  private acceptSession(session: SourceSession): void { this.lastSession = session; for (const observer of this.observers) observer(session) }

  currentEntries(seqs: readonly number[]): SessionEventLikeEntry[] { return seqs.flatMap(seq => { const value = this.entries.get(seq); if (!value) return []; value.used = ++this.clock; return [value.entry] }) }

  /** Evict unpinned pages only under actual pressure; a DOM range is never a cache budget. */
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
    this.windows.delete(window.viewId)
    this.trimCache()
    if (this.windows.size === 0) {
      this.connection?.abort(); this.connection = undefined
      // A future open rechecks the head before resuming from its exact version.
      this.initializing = undefined
      for (const [key, page] of this.pages) if (!page.page.hasAfter) this.pages.delete(key)
    }
  }
  dispose(): void {
    this.lifetime.abort(); this.connection?.abort(); this.connection = undefined
    for (const window of [...this.windows.values()]) window.release()
    this.entries.clear(); this.pages.clear(); this.observers.clear(); this.notifyVersion()
  }
}

class RemoteHistoryWindow implements HistoryFeedV1 {
  readonly initial: HistorySnapshotV1
  private state: HistorySnapshotV1
  private seqs: number[]
  private context = new Set<number>()
  private revision = 0
  private readonly abort = new AbortController()
  private readonly journal: HistoryDeltaV1[] = []
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, Promise<HistorySnapshotV1>>()
  private error: unknown
  private navigation = 0

  constructor(private readonly owner: RemoteSourceHistory, readonly viewId: string, page: SourcePage, private budget: Budget) {
    this.context = new Set(page.context)
    this.seqs = page.entries.map(entry => entry.event.seq)
    this.state = this.snapshot(page.entries, page.before, page.after, page.hasBefore, page.hasAfter)
    this.initial = this.state
  }
  sequences(): number[] { return this.seqs }
  private snapshot(entries: readonly SessionEventLikeEntry[], before: number | null, after: number | null, hasBefore: boolean, hasAfter: boolean): HistorySnapshotV1 {
    return { version: token(this.owner.sourceEpoch, this.owner.sourceVersion, ++this.revision), entries: entriesBySeq(entries), before: cursor(this.owner.sourceEpoch, before), after: cursor(this.owner.sourceEpoch, after), hasBefore, hasAfter }
  }

  read(request: HistoryReadV1, budget: Budget, signal: AbortSignal): Promise<HistorySnapshotV1> {
    this.abort.signal.throwIfAborted(); signal.throwIfAborted()
    const key = JSON.stringify(request)
    const existing = this.pending.get(key)
    if (existing) return waitFor(existing, signal)
    const navigation = request.kind === 'latest' || request.kind === 'around' ? ++this.navigation : this.navigation
    const work = this.performRead(request, budget, AbortSignal.any([signal, this.abort.signal]), navigation)
    this.pending.set(key, work)
    void work.finally(() => { if (this.pending.get(key) === work) this.pending.delete(key) }).catch(() => {})
    return work
  }

  private async performRead(request: HistoryReadV1, budget: Budget, signal: AbortSignal, navigation: number): Promise<HistorySnapshotV1> {
    this.budget = budget
    const epoch = this.owner.sourceEpoch
    let input: Omit<SourceReadRequest, 'sessionId'>
    switch (request.kind) {
      case 'before': input = { before: parseCursor(request.cursor, epoch) }; break
      case 'after': input = { after: parseCursor(request.cursor, epoch) }; break
      case 'around': input = { around: Number(request.target.seq) }; break
      case 'latest': {
        if (!this.state.hasAfter && !this.error && this.seqs.length > 0) return this.state
        input = {}; break
      }
    }
    const page = await this.owner.page(input, signal)
    signal.throwIfAborted()
    if (navigation !== this.navigation || epoch !== this.owner.sourceEpoch) throw new RemoteHistoryError('STALE_VERSION', 'A newer navigation superseded this page.')
    const extending = request.kind === 'before' || request.kind === 'after'
    let entries = entriesBySeq(extending ? [...this.owner.currentEntries(this.seqs), ...page.entries] : page.entries)
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
    const maxEntries = Math.min(budget.events, budget.nodes * 3)
    let countBytes = entries.reduce((total, entry) => total + size(entry), 0)
    // The official coordinator re-measures and validates anchor membership just
    // before publishing this candidate, so scrolling during IO can veto eviction.
    while (entries.length > maxEntries || countBytes > budget.bytes) {
      const candidate = request.kind === 'before' ? entries.at(-1) : entries[0]
      if (!candidate || entries.length <= page.context.length + 1) throw new RemoteHistoryError('CAPACITY_EXCEEDED', 'This source item exceeds the reading budget.')
      if (nextContext.has(candidate.event.seq)) {
        // Dependencies at the opposite edge are retained with their content.
        throw new RemoteHistoryError('CAPACITY_EXCEEDED', 'The visible history dependencies exceed this window budget.')
      }
      entries = request.kind === 'before' ? entries.slice(0, -1) : entries.slice(1)
      countBytes -= size(candidate)
      const body = entries.filter(entry => !nextContext.has(entry.event.seq))
      if (request.kind === 'before') { after = body.at(-1)?.event.seq ?? null; hasAfter = true }
      else { before = body[0]?.event.seq ?? null; hasBefore = true }
    }
    this.context = nextContext
    this.seqs = entries.map(entry => entry.event.seq)
    this.error = undefined
    this.state = this.snapshot(entries, before, after, hasBefore, hasAfter)
    this.owner.trimCache()
    return this.state
  }

  accept(change: SourceChanges): void {
    if (this.abort.signal.aborted) return
    const previous = this.state
    const present = new Set(this.seqs)
    const tail = previous.after ? parseCursor(previous.after, this.owner.sourceEpoch) : -1
    let updates = change.upserts.filter(entry => present.has(entry.event.seq) || !previous.hasAfter && entry.event.seq > tail)
    const removed = new Set(change.removed)
    let entries = entriesBySeq([...this.owner.currentEntries(this.seqs).filter(entry => !removed.has(entry.event.seq)), ...updates])
    const atCapacity = entries.length > Math.min(this.budget.events, this.budget.nodes * 3) || entries.reduce((total, entry) => total + size(entry), 0) > this.budget.bytes
    const hasAfter = previous.hasAfter || atCapacity
    if (atCapacity) {
      updates = updates.filter(entry => present.has(entry.event.seq))
      entries = entriesBySeq([...this.owner.currentEntries(this.seqs).filter(entry => !removed.has(entry.event.seq)), ...updates])
    }
    this.seqs = entries.map(entry => entry.event.seq)
    const appended = updates.some(entry => entry.event.seq > tail)
    const changed = updates.length > 0 || change.removed.some(seq => present.has(seq))
    const before = previous.before ? parseCursor(previous.before, this.owner.sourceEpoch) : null
    const after = !previous.hasAfter && appended ? entries.filter(entry => !this.context.has(entry.event.seq)).at(-1)?.event.seq ?? null : previous.after ? parseCursor(previous.after, this.owner.sourceEpoch) : null
    this.state = this.snapshot(entries, before, after, previous.hasBefore, hasAfter)
    let changes: SessionEventChange[] = []
    if (changed) {
      const onlyAppend = updates.every(entry => entry.event.seq > tail) && removed.size === 0
      changes = onlyAppend ? [{ kind: 'append', entries: updates }] : [{ kind: 'replace', entries }]
    }
    this.record({ base: previous.version, version: this.state.version, changes, headChanged: hasAfter && change.upserts.some(entry => entry.event.seq > tail) })
  }

  cachedHead(session: SourceSession | undefined): SourcePage | undefined {
    if (!session || this.error || this.state.hasAfter || this.abort.signal.aborted) return undefined
    return { session, epoch: this.owner.sourceEpoch, version: this.owner.sourceVersion,
      entries: this.owner.currentEntries(this.seqs) as SourceEntry[],
      before: this.state.before ? parseCursor(this.state.before, this.owner.sourceEpoch) : null,
      after: this.state.after ? parseCursor(this.state.after, this.owner.sourceEpoch) : null,
      hasBefore: this.state.hasBefore, hasAfter: false, context: [...this.context] }
  }

  /** Reconnect restores this window; the explicit latest action has its own verb. */
  async refresh(budget: Budget = this.budget, signal: AbortSignal = this.abort.signal): Promise<HistorySnapshotV1> {
    this.abort.signal.throwIfAborted(); signal.throwIfAborted()
    if (!this.error) return this.state
    const body = this.state.entries.filter(entry => !this.context.has(entry.event.seq))
    const target = body[Math.floor(body.length / 2)]
    this.error = undefined
    return this.read(target ? { kind: 'around', target: { key: String(target.event.seq), seq: target.event.seq as never } } : { kind: 'latest' }, budget, signal)
  }

  async recover(): Promise<void> {
    const prior = this.state
    ++this.navigation
    this.error = undefined
    const body = prior.entries.find(entry => !this.context.has(entry.event.seq))
    const page = await this.owner.page(body ? { around: body.event.seq } : {}, this.abort.signal)
    this.abort.signal.throwIfAborted()
    this.context = new Set(page.context); this.seqs = page.entries.map(entry => entry.event.seq)
    this.state = this.snapshot(page.entries, page.before, page.after, page.hasBefore, page.hasAfter)
    this.record({ base: prior.version, version: this.state.version, changes: [{ kind: 'replace', entries: this.state.entries }], headChanged: page.hasAfter })
  }

  fail(error: unknown): void { this.error = error; for (const listener of this.listeners) listener() }
  private record(delta: HistoryDeltaV1): void {
    this.journal.push(delta)
    while (this.journal.length > REPLAY_DELTAS) this.journal.shift()
    for (const listener of this.listeners) listener()
  }
  async *changes(after: string, signal: AbortSignal): AsyncIterable<HistoryDeltaV1> {
    const lifetime = AbortSignal.any([signal, this.abort.signal])
    let current = after
    while (!lifetime.aborted) {
      if (this.error) throw this.error
      const delta = this.journal.find(value => value.base === current)
      if (delta) { current = delta.version; yield delta; continue }
      if (current !== this.state.version) throw new RemoteHistoryError('STALE_VERSION', 'This reader fell behind the bounded change journal.')
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => { cleanup(); resolve() }
        const stop = (): void => { cleanup(); reject(lifetime.reason ?? aborted()) }
        const cleanup = (): void => { this.listeners.delete(wake); lifetime.removeEventListener('abort', stop) }
        this.listeners.add(wake); lifetime.addEventListener('abort', stop, { once: true })
        if (lifetime.aborted) stop()
        else if (this.error || this.state.version !== current) wake()
      })
    }
    lifetime.throwIfAborted()
  }
  release(): void {
    if (this.abort.signal.aborted) return
    this.abort.abort(); this.owner.release(this); this.listeners.clear(); this.journal.length = 0
  }
}
