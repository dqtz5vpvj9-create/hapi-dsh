/** Atomic storage/Web Lock fixtures; production always uses browser IDB + Web Locks. */
import { sourceFileMutationEntrySchema, sourceFileMutationKey, type SourceFileExclusiveResult,
  type SourceFileMutationEntry, type SourceFileMutationLocks, type SourceFileMutationReceipt,
  type SourceFileMutationStorage, type SourceFileOwner } from '../src/client/source-file-mutation-journal.ts'

export class SourceFileStorageFixture implements SourceFileMutationStorage {
  readonly rows = new Map<string, unknown>()
  writes = 0
  beforeWrite?: ((index: number, receipt: SourceFileMutationReceipt) => Promise<void>) | undefined
  async read(owner: SourceFileOwner): Promise<SourceFileMutationEntry | null> {
    const value = this.rows.get(sourceFileMutationKey(owner))
    if (value === undefined) return null
    const row = sourceFileMutationEntrySchema.parse(structuredClone(value))
    if (sourceFileMutationKey(row.owner) !== sourceFileMutationKey(owner)) throw new Error('Wrong saved owner')
    return row
  }
  async write(owner: SourceFileOwner, expected: string | null, receipt: SourceFileMutationReceipt): Promise<SourceFileMutationEntry> {
    const index = ++this.writes
    await this.beforeWrite?.(index, receipt)
    // Read/CAS/write is deliberately synchronous, matching one IDB transaction.
    const value = this.rows.get(sourceFileMutationKey(owner))
    const previous = value === undefined ? null : sourceFileMutationEntrySchema.parse(value)
    if ((previous?.revision ?? null) !== expected) throw new Error('CAS conflict')
    if (previous && sourceFileMutationKey(previous.owner) !== sourceFileMutationKey(owner)) throw new Error('Wrong saved owner')
    const next = sourceFileMutationEntrySchema.parse({ version: 1, revision: crypto.randomUUID(), owner, receipt })
    this.rows.set(sourceFileMutationKey(owner), structuredClone(next)); return structuredClone(next)
  }
}
export class SourceFileLocksFixture implements SourceFileMutationLocks {
  readonly keys = new Set<string>()
  async exclusive<T>(key: string, action: () => Promise<T>): Promise<SourceFileExclusiveResult<T>> {
    if (this.keys.has(key)) return { acquired: false }
    this.keys.add(key)
    try { return { acquired: true, value: await action() } } finally { this.keys.delete(key) }
  }
  async held(key: string): Promise<boolean> { return this.keys.has(key) }
}
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
