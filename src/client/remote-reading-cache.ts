/** Optional bounded read snapshots, isolated by authenticated Host/account storage identity. */
import { z } from 'zod'
import { sourceSessionSchema } from '../hhpi-api.ts'
import { sourceSessionId, type SourceEntry, type SourcePage, type SourceSession } from '../remote/protocol.ts'

export interface SourceReadingPosition {
  anchorKey: string
  anchorOwnerKey?: string | undefined
  anchorTop: number
  scrollTop: number
}
interface SavedPosition { value: SourceReadingPosition | null; seq?: number | undefined }
export interface SourceReadingCheckpoint {
  session: SourceSession
  epoch: string
  version: number
  head: SourcePage
  windows: Array<{ viewId: string; page: SourcePage }>
  /** Original source pages retain their explicit dependency context when a large window needs compaction. */
  pages?: SourcePage[] | undefined
}
interface SavedReading extends SourceReadingCheckpoint { positions: Record<string, SavedPosition> }
interface IndexEntry { id: string; used: number; bytes: number; session?: SourceSession | undefined; reading?: { epoch: string; positions: Record<string, SavedPosition> } | undefined }
export interface SourceReadingStorage { storage: Storage; scope: string }
const MAX_SESSIONS = 8, MAX_BYTES = 4 * 1024 * 1024, MAX_SESSION_BYTES = 1024 * 1024, MAX_WINDOWS = 8
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), key = z.string().min(1).max(2048)
const event = z.object({ type: z.literal('event'), event: z.object({ type: key, seq, time: z.number().finite(), data: z.unknown() }).passthrough() }) as unknown as z.ZodType<SourceEntry>
const page = z.object({ session: sourceSessionSchema, epoch: key, version: seq, entries: z.array(event).max(20_000), before: seq.nullable(), after: seq.nullable(),
  hasBefore: z.boolean(), hasAfter: z.boolean(), context: z.array(seq).max(20_000) }) satisfies z.ZodType<SourcePage>
const position = z.object({ anchorKey: key, anchorOwnerKey: key.optional(), anchorTop: z.number().finite(), scrollTop: z.number().finite().nonnegative() })
const record = z.object({ session: sourceSessionSchema, epoch: key, version: seq, head: page,
  windows: z.array(z.object({ viewId: key, page })).max(MAX_WINDOWS),
  positions: z.record(key, z.object({ value: position.nullable(), seq: seq.optional() })).refine(value => Object.keys(value).length <= MAX_WINDOWS) }) satisfies z.ZodType<SavedReading>
const index = z.array(z.object({ id: key, used: z.number().finite(), bytes: seq.max(MAX_SESSION_BYTES), session: sourceSessionSchema.optional(),
  reading: z.object({ epoch: key, positions: record.shape.positions }).optional() })).max(MAX_SESSIONS)
  .refine(values => values.reduce((sum, value) => sum + value.bytes, 0) <= MAX_BYTES)
const encoder = new TextEncoder()
const sequences = new WeakMap<SourcePage, Set<number>>()
const eventBytes = new WeakMap<SourceEntry, number>()
function contains(page: SourcePage, seq: number): boolean {
  let keys = sequences.get(page)
  if (!keys) { keys = new Set(page.entries.map(entry => entry.event.seq)); sequences.set(page, keys) }
  return keys.has(seq)
}

/** Only source-produced pages know every context dependency; never slice event arrays blindly. */
function compact(page: SourcePage, pages: readonly SourcePage[], target = page.after ?? 0): SourcePage | undefined {
  return pages.filter(candidate => candidate.epoch === page.epoch && candidate.version === page.version
    && (candidate.before ?? 0) <= target && (candidate.after ?? -1) >= target)
    .sort((a, b) => a.entries.length - b.entries.length)[0]
}
/** Check the payload budget before concatenating potentially huge shared reader windows. */
function bodyFits(saved: SavedReading): boolean {
  let bytes = 0
  const seen = new Set<number>()
  for (const page of [saved.head, ...saved.windows.map(window => window.page)]) for (const entry of page.entries) {
    if (seen.has(entry.event.seq)) continue
    seen.add(entry.event.seq)
    let size = eventBytes.get(entry)
    if (size === undefined) { size = encoder.encode(JSON.stringify(entry)).byteLength + 1; eventBytes.set(entry, size) }
    if ((bytes += size) > MAX_SESSION_BYTES) return false
  }
  return true
}
/** Persist each accepted event once; independent Pane ranges reference its native sequence. */
function serialize(saved: SavedReading): string {
  const entries = new Map<number, SourceEntry>()
  const reference = (page: SourcePage) => {
    for (const entry of page.entries) entries.set(entry.event.seq, entry)
    const { entries: _entries, session: _session, ...metadata } = page
    return { ...metadata, seqs: page.entries.map(entry => entry.event.seq) }
  }
  const head = reference(saved.head), windows = saved.windows.map(window => ({ viewId: window.viewId, page: reference(window.page) }))
  return JSON.stringify({ format: 2, session: saved.session, epoch: saved.epoch, version: saved.version,
    head, windows, entries: [...entries.values()], positions: saved.positions })
}
const referencePage = page.omit({ entries: true, session: true }).extend({ seqs: z.array(seq).max(20_000) }).strict()
const packed = z.object({ format: z.literal(2), session: sourceSessionSchema, epoch: key, version: seq,
  head: referencePage, windows: z.array(z.object({ viewId: key, page: referencePage })).max(MAX_WINDOWS),
  entries: z.array(event).max(20_000), positions: record.shape.positions })
function deserialize(raw: string): SavedReading | undefined {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || !('format' in value)) return record.parse(value)
  const saved = packed.parse(value), entries = new Map<number, SourceEntry>(saved.entries.map(entry => [entry.event.seq, entry]))
  const materialize = (reference: z.infer<typeof referencePage>): SourcePage => {
    const { seqs, ...metadata } = reference
    return { ...metadata, session: saved.session, entries: seqs.map(seq => {
      const entry = entries.get(seq)
      if (!entry) throw new Error('An optional reading checkpoint is missing a referenced source entry.')
      return entry
    }) }
  }
  return { session: saved.session, epoch: saved.epoch, version: saved.version, positions: saved.positions,
    head: materialize(saved.head), windows: saved.windows.map(window => ({ viewId: window.viewId, page: materialize(window.page) })) }
}
function boundedCheckpoint(saved: SavedReading): { saved: SavedReading; data: string } | undefined {
  try {
    const { pages = [], ...bounded } = saved
    bounded.positions = { ...saved.positions }
    let data = bodyFits(bounded) ? serialize(bounded) : undefined
    if (data === undefined || encoder.encode(data).byteLength > MAX_SESSION_BYTES) {
      bounded.head = compact(saved.head, pages) ?? saved.head
      bounded.windows = saved.windows.flatMap(window => {
        const position = saved.positions[window.viewId]
        const page = position?.value && position.seq === undefined ? undefined : compact(window.page, pages, position?.seq)
        if (page) return [{ ...window, page }]
        delete bounded.positions[window.viewId]
        return []
      })
      data = undefined
    }
    for (;;) {
      if (data === undefined && bodyFits(bounded)) data = serialize(bounded)
      if (data !== undefined && encoder.encode(data).byteLength <= MAX_SESSION_BYTES) return { saved: bounded, data }
      const discarded = bounded.windows.shift()
      if (!discarded) return undefined
      delete bounded.positions[discarded.viewId]; data = undefined
    }
  } catch { return undefined }
}

export class SourceReadingCache {
  private readonly prefix: string
  private readonly indexKey: string
  private readonly entries = new Map<string, IndexEntry>()
  private readonly records = new Map<string, SavedReading>()
  private readonly dirty = new Set<string>()
  /** Small exact anchors survive optional body compaction until an explicit update checkpoint. */
  private readonly pendingPositions = new Map<string, { epoch: string; positions: Record<string, SavedPosition> }>()
  private revisionValue = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private idle: number | undefined
  private disposed = false
  private readonly window = typeof window === 'undefined' ? undefined : window
  private readonly hidden = (): void => { if (this.window?.document.visibilityState === 'hidden') this.flush() }
  constructor(private readonly access: SourceReadingStorage) {
    this.prefix = `hhpi:reading:v1:${access.scope}:`; this.indexKey = `${this.prefix}index`
    try {
      const parsed = index.safeParse(JSON.parse(access.storage.getItem(this.indexKey) ?? '[]'))
      if (parsed.success) for (const entry of parsed.data) this.entries.set(entry.id, entry)
    } catch { /* An unavailable or corrupt optional cache does not block live reading. */ }
    try {
      const known = new Set([...this.entries.keys()].map(id => this.storageKey(id)))
      // A browser may have committed the record but lost the batched index.
      // Unindexed data is never a source of authority and must stay bounded.
      for (let at = access.storage.length - 1; at >= 0; --at) {
        const key = access.storage.key(at)
        if (key?.startsWith(this.prefix) && key !== this.indexKey && !known.has(key)) access.storage.removeItem(key)
      }
    } catch { /* Optional storage can also be unavailable during cleanup. */ }
    this.window?.addEventListener('pagehide', this.flush)
    this.window?.document.addEventListener('visibilitychange', this.hidden)
  }
  get scope(): string { return this.access.scope }
  get revision(): number { return this.revisionValue }
  get maxSessions(): number { return MAX_SESSIONS }
  get maxWindows(): number { return MAX_WINDOWS }
  private storageKey(id: string): string { return `${this.prefix}${id}` }
  read(id: string): SourceReadingCheckpoint | undefined { return this.load(id) }
  sessions(): SourceSession[] { return [...this.entries.values()].flatMap(entry => {
    if (entry.session?.id === entry.id && sourceSessionId(entry.session) === entry.id) return [entry.session]
    const saved = this.load(entry.id)
    if (saved) entry.session = saved.session
    return saved ? [saved.session] : []
  }) }
  private load(id: string): SavedReading | undefined {
    const cached = this.records.get(id)
    if (cached) return cached
    if (!this.entries.has(id)) return undefined
    try {
      const raw = this.access.storage.getItem(this.storageKey(id))
      if (!raw && (this.entries.get(id)?.reading || this.pendingPositions.has(id))) return undefined
      if (!raw || encoder.encode(raw).byteLength > MAX_SESSION_BYTES) { this.remove(id); return undefined }
      const value = deserialize(raw)
      if (!value) { this.remove(id); return undefined }
      if (value.session.id !== id || sourceSessionId(value.session) !== id
        || [value.head, ...value.windows.map(window => window.page)].some(page => page.session.id !== id || sourceSessionId(page.session) !== id || page.epoch !== value.epoch || page.version !== value.version)) {
        this.remove(id); return undefined
      }
      this.records.set(id, value)
      return value
    } catch { this.remove(id); return undefined }
  }
  write(checkpoint: SourceReadingCheckpoint): void {
    if (this.disposed) return
    const prior = this.load(checkpoint.session.id)
    if (this.pendingPositions.get(checkpoint.session.id)?.epoch !== checkpoint.epoch) this.pendingPositions.delete(checkpoint.session.id)
    // An accepted source replacement invalidates the old durable epoch even
    // when its replacement cannot fit or the browser exits before batching.
    if (prior && prior.epoch !== checkpoint.epoch) this.remove(checkpoint.session.id)
    const positions = prior?.epoch === checkpoint.epoch ? prior.positions : {}
    const windows = new Map(prior?.epoch === checkpoint.epoch && prior.version === checkpoint.version ? prior.windows.map(window => [window.viewId, window]) : [])
    for (const window of checkpoint.windows) { windows.delete(window.viewId); windows.set(window.viewId, window) }
    this.records.set(checkpoint.session.id, { ...checkpoint, windows: [...windows.values()].slice(-MAX_WINDOWS), positions })
    this.entries.set(checkpoint.session.id, { id: checkpoint.session.id, used: Date.now(), bytes: this.entries.get(checkpoint.session.id)?.bytes ?? 0, session: checkpoint.session })
    this.changed(checkpoint.session.id)
  }
  readPosition(id: string, viewId: string): SourceReadingPosition | null {
    const saved = this.load(id), position = saved?.positions[viewId]
    if (!saved || !position?.value) return null
    const page = saved.windows.find(window => window.viewId === viewId)?.page ?? saved.head
    return position.seq === undefined || contains(page, position.seq) ? position.value : null
  }
  /** An explicit resume target survives bounded body eviction within its epoch. */
  readAnchor(id: string, viewId: string): { epoch: string; seq: number } | undefined {
    const saved = this.load(id), reading = this.entries.get(id)?.reading, position = reading?.positions[viewId] ?? saved?.positions[viewId]
    const epoch = reading?.epoch ?? saved?.epoch
    return epoch && position?.value && position.seq !== undefined ? { epoch, seq: position.seq } : undefined
  }
  writePosition(id: string, viewId: string, value: SourceReadingPosition | null, target?: number): boolean {
    if (this.disposed) return false
    const saved = this.load(id)
    if (!saved) return false
    const page = saved.windows.find(window => window.viewId === viewId)?.page ?? saved.head
    if (value && target !== undefined && !contains(page, target)) return false
    const entry = this.entries.get(id)
    if (entry) delete entry.reading
    saved.positions[viewId] = { value, ...target === undefined ? {} : { seq: target } }
    const keys = Object.keys(saved.positions)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_WINDOWS))) delete saved.positions[key]
    this.pendingPositions.set(id, { epoch: saved.epoch, positions: { ...saved.positions } })
    this.changed(id)
    return true
  }
  private changed(id: string): void {
    this.revisionValue++
    this.dirty.add(id)
    if (this.timer !== undefined || this.idle !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      // Durable snapshots are optional: serialize during idle time, rather than
      // interrupting an active scroll gesture with a synchronous storage write.
      if (this.window?.requestIdleCallback) this.idle = this.window.requestIdleCallback(() => { this.idle = undefined; this.flush() })
      else this.flush()
    }, 750)
    this.timer.unref?.()
  }
  readonly flush = (): void => {
    if (this.idle !== undefined) this.window?.cancelIdleCallback(this.idle)
    this.idle = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const id of this.dirty) {
      const saved = this.records.get(id)
      if (!saved) continue
      const bounded = boundedCheckpoint(saved)
      if (!bounded) {
        // Keep the previous valid checkpoint if a live turn has outgrown its
        // budget. Inventing a truncated turn loses native tool dependencies.
        if (!this.entries.get(id)?.bytes) {
          if (this.pendingPositions.has(id)) { this.records.delete(id); this.entries.set(id, { id, used: Date.now(), bytes: 0, session: saved.session }); this.evict(id) }
          else this.remove(id)
        }
        else { this.records.delete(id); this.load(id) }
        continue
      }
      const { data } = bounded
      this.records.set(id, bounded.saved)
      this.entries.set(id, { id, used: Date.now(), bytes: encoder.encode(data).byteLength, session: saved.session })
      this.evict(id)
      try { this.access.storage.setItem(this.storageKey(id), data) }
      catch {
        // Reading cache pressure never removes drafts or pending operations.
        for (const old of [...this.entries.values()].filter(entry => entry.id !== id).sort((a, b) => a.used - b.used)) {
          this.remove(old.id)
          try { this.access.storage.setItem(this.storageKey(id), data); break } catch { /* Try a smaller read-only cache. */ }
        }
      }
    }
    this.dirty.clear()
    this.saveIndex()
  }
  /** Explicit update preparation: unlike optional flush(), storage failures reject the update. */
  checkpoint(): void {
    if (this.disposed) throw new Error('The original reading cache is closed. The page has not been updated.')
    const revision = this.revisionValue
    const prepared: Array<{ id: string; saved: SavedReading; data: string; bytes: number }> = []
    const anchors = new Map<string, { epoch: string; positions: Record<string, SavedPosition> }>()
    for (const id of new Set([...this.records.keys(), ...this.pendingPositions.keys()])) {
      const saved = this.load(id), pending = this.pendingPositions.get(id)
      if (pending) anchors.set(id, pending)
      if (!saved) { if (pending && Object.values(pending.positions).some(position => position.value && position.seq === undefined)) throw new Error('The current reading position has no exact native source anchor. Reopen its source window before updating.'); continue }
      const bounded = boundedCheckpoint(saved)
      if (!bounded) { if (!pending) continue; if (Object.values(pending.positions).some(position => position.value && position.seq === undefined)) throw new Error('The current reading position has no exact native source anchor. Reopen its source window before updating.'); continue }
      if (pending?.epoch === saved.epoch) bounded.saved.positions = { ...pending.positions }
      const data = serialize(bounded.saved), bytes = encoder.encode(data).byteLength
      if (bytes > MAX_SESSION_BYTES) throw new Error('The current reading position could not fit in its checkpoint. The page remains open.')
      prepared.push({ id, saved: bounded.saved, data, bytes })
    }
    if (prepared.length > MAX_SESSIONS || prepared.reduce((sum, item) => sum + item.bytes, 0) > MAX_BYTES) throw new Error('The current reading checkpoints exceed their storage budget. The page remains open.')
    const next = new Map(this.entries)
    for (const item of prepared) next.set(item.id, { ...next.get(item.id), id: item.id, used: Date.now(), bytes: item.bytes, session: item.saved.session })
    for (const [id, reading] of anchors) {
      const entry = next.get(id)
      if (!entry) throw new Error('The current reading source is no longer retained. The page remains open.')
      next.set(id, { ...entry, reading })
    }
    if (next.size > MAX_SESSIONS || [...next.values()].reduce((sum, item) => sum + item.bytes, 0) > MAX_BYTES) throw new Error('The reading cache is still trimming older checkpoints. Try the update again after it finishes.')
    for (const item of prepared) {
      this.access.storage.setItem(this.storageKey(item.id), item.data)
    }
    this.access.storage.setItem(this.indexKey, JSON.stringify([...next.values()]))
    if (revision !== this.revisionValue || this.disposed) throw new Error('The reading position or source changed while saving. Try the update again.')
    for (const [id, entry] of next) this.entries.set(id, entry)
    for (const item of prepared) { this.records.set(item.id, item.saved); this.dirty.delete(item.id) }
    const bodies = new Set(prepared.map(item => item.id))
    for (const id of anchors.keys()) {
      this.dirty.delete(id)
      if (!bodies.has(id)) this.records.delete(id)
    }
  }
  private evict(keep: string): void {
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const old of [...this.entries.values()].filter(entry => entry.id !== keep).sort((a, b) => a.used - b.used)) {
      if (this.entries.size <= MAX_SESSIONS && total <= MAX_BYTES) break
      total -= old.bytes; this.remove(old.id)
    }
  }
  private saveIndex(): void { try { this.access.storage.setItem(this.indexKey, JSON.stringify([...this.entries.values()])) } catch { /* Optional read cache. */ } }
  remove(id: string): void {
    this.records.delete(id); this.entries.delete(id); this.dirty.delete(id)
    this.pendingPositions.delete(id); this.revisionValue++
    try { this.access.storage.removeItem(this.storageKey(id)) } catch { /* Optional read cache. */ }
    this.saveIndex()
  }
  clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id)
    try {
      for (let at = this.access.storage.length - 1; at >= 0; --at) {
        const key = this.access.storage.key(at)
        if (key?.startsWith(this.prefix)) this.access.storage.removeItem(key)
      }
    } catch { /* Unavailable optional storage cannot block scope disposal. */ }
  }
  dispose(): void {
    this.flush()
    this.disposed = true
    this.window?.removeEventListener('pagehide', this.flush)
    this.window?.document.removeEventListener('visibilitychange', this.hidden)
  }
}
