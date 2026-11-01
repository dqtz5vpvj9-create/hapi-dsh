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
interface IndexEntry { id: string; used: number; bytes: number }
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
const index = z.array(z.object({ id: key, used: z.number().finite(), bytes: seq.max(MAX_SESSION_BYTES) })).max(MAX_SESSIONS)
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
  for (const page of [saved.head, ...saved.windows.map(window => window.page)]) for (const entry of page.entries) {
    let size = eventBytes.get(entry)
    if (size === undefined) { size = encoder.encode(JSON.stringify(entry)).byteLength + 1; eventBytes.set(entry, size) }
    if ((bytes += size) > MAX_SESSION_BYTES) return false
  }
  return true
}
function boundedCheckpoint(saved: SavedReading): { saved: SavedReading; data: string } | undefined {
  try {
    const { pages = [], ...bounded } = saved
    bounded.positions = { ...saved.positions }
    let data = bodyFits(bounded) ? JSON.stringify(bounded) : undefined
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
      if (data === undefined && bodyFits(bounded)) data = JSON.stringify(bounded)
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
  private timer: ReturnType<typeof setTimeout> | undefined
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
  private storageKey(id: string): string { return `${this.prefix}${id}` }
  read(id: string): SourceReadingCheckpoint | undefined { return this.load(id) }
  sessions(): SourceSession[] { return [...this.entries.keys()].flatMap(id => { const saved = this.load(id); return saved ? [saved.session] : [] }) }
  private load(id: string): SavedReading | undefined {
    const cached = this.records.get(id)
    if (cached) return cached
    if (!this.entries.has(id)) return undefined
    try {
      const raw = this.access.storage.getItem(this.storageKey(id))
      if (!raw || encoder.encode(raw).byteLength > MAX_SESSION_BYTES) { this.remove(id); return undefined }
      const parsed = record.safeParse(JSON.parse(raw))
      if (!parsed.success) { this.remove(id); return undefined }
      const value = parsed.data
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
    // An accepted source replacement invalidates the old durable epoch even
    // when its replacement cannot fit or the browser exits before batching.
    if (prior && prior.epoch !== checkpoint.epoch) this.remove(checkpoint.session.id)
    const positions = prior?.epoch === checkpoint.epoch ? prior.positions : {}
    const windows = new Map(prior?.epoch === checkpoint.epoch && prior.version === checkpoint.version ? prior.windows.map(window => [window.viewId, window]) : [])
    for (const window of checkpoint.windows) { windows.delete(window.viewId); windows.set(window.viewId, window) }
    this.records.set(checkpoint.session.id, { ...checkpoint, windows: [...windows.values()].slice(-MAX_WINDOWS), positions })
    this.entries.set(checkpoint.session.id, { id: checkpoint.session.id, used: Date.now(), bytes: this.entries.get(checkpoint.session.id)?.bytes ?? 0 })
    this.changed(checkpoint.session.id)
  }
  readPosition(id: string, viewId: string): SourceReadingPosition | null {
    const saved = this.load(id), position = saved?.positions[viewId]
    if (!saved || !position?.value) return null
    const page = saved.windows.find(window => window.viewId === viewId)?.page ?? saved.head
    return position.seq === undefined || contains(page, position.seq) ? position.value : null
  }
  writePosition(id: string, viewId: string, value: SourceReadingPosition | null, target?: number): boolean {
    if (this.disposed) return false
    const saved = this.load(id)
    if (!saved) return false
    const page = saved.windows.find(window => window.viewId === viewId)?.page ?? saved.head
    if (value && target !== undefined && !contains(page, target)) return false
    saved.positions[viewId] = { value, ...target === undefined ? {} : { seq: target } }
    const keys = Object.keys(saved.positions)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_WINDOWS))) delete saved.positions[key]
    this.changed(id)
    return true
  }
  private changed(id: string): void {
    this.dirty.add(id)
    if (this.timer !== undefined) return
    this.timer = setTimeout(this.flush, 750); this.timer.unref?.()
  }
  readonly flush = (): void => {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const id of this.dirty) {
      const saved = this.records.get(id)
      if (!saved) continue
      const bounded = boundedCheckpoint(saved)
      if (!bounded) {
        // Keep the previous valid checkpoint if a live turn has outgrown its
        // budget. Inventing a truncated turn loses native tool dependencies.
        if (!this.entries.get(id)?.bytes) this.remove(id)
        else { this.records.delete(id); this.load(id) }
        continue
      }
      const { data } = bounded
      this.records.set(id, bounded.saved)
      this.entries.set(id, { id, used: Date.now(), bytes: encoder.encode(data).byteLength })
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
