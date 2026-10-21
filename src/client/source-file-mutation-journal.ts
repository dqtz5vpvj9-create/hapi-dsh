import { randomId } from './random-id.ts'
/** Small, source-bound file-operation receipts. File/upload bytes never enter this store. */
import { z } from 'zod'
import { nativeFileManagementSchema, nativeFileOperationSchema, workbenchSourceSchema,
  type WorkbenchResponse, type WorkbenchSource } from '../workbench-types.ts'

export const sourceFileOwnerSchema = z.strictObject({
  sourceHubId: workbenchSourceSchema.shape.sourceHubId.unwrap(),
  sourceSessionId: workbenchSourceSchema.shape.sourceSessionId,
  machineId: workbenchSourceSchema.shape.machineId.unwrap(),
})
export type SourceFileOwner = z.infer<typeof sourceFileOwnerSchema>
export const sourceFileMutationRequestSchema = z.union([nativeFileOperationSchema,
  z.strictObject({ action: z.literal('upload'), path: z.string().min(1).max(8192).refine(value => !value.includes('\0')) }),
])
export type SourceFileMutationRequest = z.infer<typeof sourceFileMutationRequestSchema>
const resultSchema = nativeFileManagementSchema.extend({
  error: z.string().max(8192).optional(), deletedPaths: z.array(z.string().max(8192)).max(32).optional(),
  entry: nativeFileManagementSchema.shape.entry.unwrap().extend({ name: z.string().max(1024) }).optional(),
})
const observedSchema = z.array(z.strictObject({ path: z.string().min(1).max(8192), result: resultSchema })).max(2)
export const sourceFileMutationReceiptSchema = z.strictObject({
  operationId: z.string().uuid(), request: sourceFileMutationRequestSchema,
  phase: z.enum(['pending', 'unknown', 'confirmed', 'reviewed']),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  result: resultSchema.nullable(), observed: observedSchema.nullable(),
  omittedPaths: z.number().int().nonnegative(), error: z.string().max(8192).nullable(),
})
export type SourceFileMutationReceipt = z.infer<typeof sourceFileMutationReceiptSchema>
export const sourceFileMutationEntrySchema = z.strictObject({
  version: z.literal(1), revision: z.string().uuid(), owner: sourceFileOwnerSchema, receipt: sourceFileMutationReceiptSchema,
})
export type SourceFileMutationEntry = z.infer<typeof sourceFileMutationEntrySchema>
export const SOURCE_FILE_MUTATION_DATABASE = 'hapi-dsh-source-file-mutations'
const maxRecordBytes = 2 * 1024 * 1024

export function sourceFileMutationKey(source: WorkbenchSource): string {
  const owner = sourceFileOwnerSchema.parse(source)
  return JSON.stringify([owner.sourceHubId, owner.sourceSessionId, owner.machineId])
}
function parsedEntry(value: unknown, owner: SourceFileOwner): SourceFileMutationEntry | null {
  if (value === undefined || value === null) return null
  const parsed = sourceFileMutationEntrySchema.safeParse(value)
  if (!parsed.success || sourceFileMutationKey(parsed.data.owner) !== sourceFileMutationKey(owner)) {
    throw new Error('The saved source file operation is incompatible or belongs to another owner. Its existing record was retained.')
  }
  return parsed.data
}
/** Keep source evidence, with an explicit count when a large partial-delete list is bounded. */
export function sourceFileMutationResult(value: WorkbenchResponse<'nativeFileManage'>): { result: SourceFileMutationReceipt['result']; omittedPaths: number } {
  const parsed = nativeFileManagementSchema.parse(value)
  const result = resultSchema.parse({ ...parsed,
    ...(parsed.error === undefined ? {} : { error: parsed.error.slice(0, 8192) }),
    ...(parsed.entry === undefined ? {} : { entry: { ...parsed.entry, name: parsed.entry.name.slice(0, 1024) } }),
    ...(parsed.deletedPaths === undefined ? {} : { deletedPaths: parsed.deletedPaths.slice(0, 32) }),
  })
  return { result, omittedPaths: Math.max(0, (parsed.deletedPaths?.length ?? 0) - 32) }
}

export interface SourceFileMutationStorage {
  read(owner: SourceFileOwner): Promise<SourceFileMutationEntry | null>
  /** One atomic transaction; a different window's receipt is never overwritten. */
  write(owner: SourceFileOwner, expectedRevision: string | null, receipt: SourceFileMutationReceipt): Promise<SourceFileMutationEntry>
  close?(): void
}

export class BrowserSourceFileMutationStorage implements SourceFileMutationStorage {
  private opening: Promise<IDBDatabase> | undefined
  private closed = false
  private generation = 0
  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('The source file receipt store has closed'))
    if (this.opening) return this.opening
    const generation = ++this.generation
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown): void => { if (!settled) { settled = true; reject(error) } }
      if (typeof indexedDB === 'undefined') { reject(new Error('Durable browser storage is unavailable. No source file operation has been sent.')); return }
      const request = indexedDB.open(SOURCE_FILE_MUTATION_DATABASE, 1)
      request.onupgradeneeded = () => {
        if (settled || this.closed || generation !== this.generation) { request.transaction?.abort(); return }
        request.result.createObjectStore('receipts')
      }
      request.onsuccess = () => {
        if (settled || this.closed || generation !== this.generation) { request.result.close(); fail(new Error('The source file receipt store has closed')); return }
        settled = true
        request.result.onversionchange = () => { request.result.close(); if (generation === this.generation) { this.opening = undefined; this.generation++ } }
        resolve(request.result)
      }
      request.onerror = () => fail(request.error ?? new Error('The source file receipt store could not be opened'))
      request.onblocked = () => fail(new Error('Another window is blocking the source file receipt store upgrade'))
    }).catch(error => { if (generation === this.generation) this.opening = undefined; throw error })
    this.opening = opening; return opening
  }
  async read(source: SourceFileOwner): Promise<SourceFileMutationEntry | null> {
    const owner = sourceFileOwnerSchema.parse(source), key = sourceFileMutationKey(owner), database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('receipts', 'readonly'), request = transaction.objectStore('receipts').get(key)
      let value: SourceFileMutationEntry | null = null, reason: unknown
      request.onsuccess = () => { try { value = parsedEntry(request.result, owner) } catch (error) { reason = error; transaction.abort() } }
      transaction.oncomplete = () => resolve(value)
      transaction.onerror = transaction.onabort = () => reject(reason ?? transaction.error ?? new Error('The saved source file operation could not be read'))
    })
  }
  async write(source: SourceFileOwner, expectedRevision: string | null, input: SourceFileMutationReceipt): Promise<SourceFileMutationEntry> {
    const owner = sourceFileOwnerSchema.parse(source), key = sourceFileMutationKey(owner)
    const value = sourceFileMutationEntrySchema.parse({ version: 1, revision: randomId(), owner, receipt: input })
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxRecordBytes) throw new Error('The source file receipt exceeds its metadata limit. Upload content cannot be stored here.')
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('receipts', 'readwrite', { durability: 'strict' }), store = transaction.objectStore('receipts'), current = store.get(key)
      let reason: unknown
      current.onsuccess = () => {
        try {
          const previous = parsedEntry(current.result, owner)
          if ((previous?.revision ?? null) !== expectedRevision) throw new Error('Another view changed this source file operation. Read its saved receipt before continuing.')
          store.put(value, key)
        } catch (error) { reason = error; transaction.abort() }
      }
      transaction.oncomplete = () => resolve(value)
      transaction.onerror = transaction.onabort = () => reject(reason ?? transaction.error ?? new Error('The source file operation could not be saved durably'))
    })
  }
  close(): void {
    this.closed = true; this.generation++
    void this.opening?.then(database => { database.close() }, () => {})
  }
}

type JournalEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>
type JournalChannel = Pick<BroadcastChannel, 'addEventListener' | 'removeEventListener' | 'postMessage' | 'close'>
export type SourceFileExclusiveResult<T> = { acquired: false } | { acquired: true; value: T }
/** Explicit fixture seam. Production uses the browser's cross-window Web Locks. */
export interface SourceFileMutationLocks {
  exclusive<T>(key: string, action: () => Promise<T>): Promise<SourceFileExclusiveResult<T>>
  held(key: string): Promise<boolean>
}
const lockName = (key: string): string => `${SOURCE_FILE_MUTATION_DATABASE}:${key}`
class BrowserSourceFileMutationLocks implements SourceFileMutationLocks {
  private manager(): LockManager {
    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('File changes require a browser with Web Locks on trusted HTTPS or localhost. Cross-window protection is unavailable here, so no file operation was sent. Source reading and downloading remain available.')
    return navigator.locks
  }
  async exclusive<T>(key: string, action: () => Promise<T>): Promise<SourceFileExclusiveResult<T>> {
    return this.manager().request(lockName(key), { mode: 'exclusive', ifAvailable: true }, async lock =>
      lock ? { acquired: true as const, value: await action() } : { acquired: false as const })
  }
  async held(key: string): Promise<boolean> {
    return Boolean((await this.manager().query()).held?.some(lock => lock.name === lockName(key)))
  }
}
export interface SourceFileMutationJournal {
  read(owner: SourceFileOwner): Promise<SourceFileMutationEntry | null>
  write(owner: SourceFileOwner, expectedRevision: string | null, receipt: SourceFileMutationReceipt): Promise<SourceFileMutationEntry>
  subscribe(owner: SourceFileOwner, listener: () => void): () => void
  /** Synchronous same-root ownership plus an authoritative cross-window query. */
  active(owner: SourceFileOwner): boolean
  held(owner: SourceFileOwner): Promise<boolean>
  /** Non-queueing: a blocked action is never replayed when another view releases its lock. */
  exclusive<T>(owner: SourceFileOwner, operationId: string, action: () => Promise<T>): Promise<SourceFileExclusiveResult<T>>
  dispose(): void
}

/** One public root instance is passed to pane graphs. Durable CAS also spans
 * independent windows; notifications merely request fresh reads. */
export function createSourceFileMutations(options: { storage?: SourceFileMutationStorage; locks?: SourceFileMutationLocks; events?: JournalEvents; channel?: JournalChannel | null } = {}): SourceFileMutationJournal {
  const storage = options.storage ?? new BrowserSourceFileMutationStorage()
  const locks = options.locks ?? new BrowserSourceFileMutationLocks()
  const events = options.events ?? (typeof window === 'undefined' ? undefined : window)
  const channel = options.channel === undefined ? typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(SOURCE_FILE_MUTATION_DATABASE) : null : options.channel
  const listeners = new Map<string, Set<() => void>>(), active = new Map<string, Set<symbol>>()
  let disposed = false
  const assertOpen = (): void => { if (disposed) throw new Error('The shared source file receipt owner has closed') }
  const publish = (key: string): void => { for (const listener of [...listeners.get(key) ?? []]) { try { listener() } catch { /* A view listener cannot invalidate a committed transaction. */ } } }
  const notify = (key: string): void => {
    publish(key)
    try { channel?.postMessage({ key }) } catch { /* Durability/locks do not depend on notification delivery. */ }
  }
  const received = (event: MessageEvent<unknown>): void => {
    if (!event.data || typeof event.data !== 'object') return
    const key = Reflect.get(event.data, 'key')
    if (typeof key === 'string' && key.length <= 6_200 && listeners.has(key)) publish(key)
  }
  const focused = (): void => { for (const key of listeners.keys()) publish(key) }
  channel?.addEventListener('message', received); events?.addEventListener('focus', focused)
  return {
    read(owner) { assertOpen(); return storage.read(sourceFileOwnerSchema.parse(owner)) },
    async write(owner, expectedRevision, receipt) {
      assertOpen()
      const result = await storage.write(sourceFileOwnerSchema.parse(owner), expectedRevision, sourceFileMutationReceiptSchema.parse(receipt))
      const key = sourceFileMutationKey(owner); notify(key)
      return result
    },
    subscribe(owner, listener) {
      assertOpen(); const key = sourceFileMutationKey(owner), group = listeners.get(key) ?? new Set<() => void>()
      listeners.set(key, group); group.add(listener)
      return () => { group.delete(listener); if (!group.size) listeners.delete(key) }
    },
    active(owner) { return Boolean(active.get(sourceFileMutationKey(owner))?.size) },
    held(owner) { assertOpen(); return locks.held(sourceFileMutationKey(owner)) },
    async exclusive(owner, operationId, action) {
      assertOpen(); const key = sourceFileMutationKey(owner), token = Symbol(operationId)
      let acquired = false
      try {
        return await locks.exclusive(key, async () => {
          assertOpen(); acquired = true
          const group = active.get(key) ?? new Set<symbol>(); active.set(key, group); group.add(token); notify(key)
          return action()
        })
      } finally {
        if (acquired) { const group = active.get(key); group?.delete(token); if (!group?.size) active.delete(key); notify(key) }
      }
    },
    dispose() { if (disposed) return; disposed = true; events?.removeEventListener('focus', focused); channel?.removeEventListener('message', received); channel?.close(); listeners.clear(); active.clear(); storage.close?.() },
  }
}
