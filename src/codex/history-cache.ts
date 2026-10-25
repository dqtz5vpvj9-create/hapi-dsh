import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableJson } from './durable-file.ts'
import { z } from 'zod'
import type { HapiMessage } from './contracts.js'
import { record } from './native.js'

/** A larger disposable cache must not create a second unseen full history or
 * a multi-hundred-MiB synchronous JSON string on the Host main thread. */
export const MAX_HISTORY_CACHE_BYTES = 8 * 1024 * 1024

/** Keep a contiguous newest tail under a byte budget; one oversized newest row
 * is preserved whole because replacing it with a truncated row would be wrong. */
export function newestWithin(rows: readonly HapiMessage[], maxBytes: number, maxRows = Number.POSITIVE_INFINITY): HapiMessage[] {
  let bytes = 0, start = rows.length
  while (start > 0 && rows.length - start < maxRows) {
    const size = JSON.stringify(rows[start - 1]).length + 1
    if (bytes + size > maxBytes && start < rows.length) break
    bytes += size; start--
  }
  return rows.slice(start)
}

const cacheSchema = z.object({ version: z.literal(1), complete: z.boolean().optional(), epoch: z.number().optional(), rows: z.array(z.object({
  id: z.string(), seq: z.number().nullable(), localId: z.string().nullable(), content: z.unknown(),
  createdAt: z.number(), invokedAt: z.number().nullable().optional(), scheduledAt: z.number().nullable().optional(),
  deliveryState: z.enum(['dispatching', 'indeterminate']).optional(), steered: z.boolean().optional(),
})) })

/** Disposable read cache. It is never used to infer delivery or approval outcomes. */
export class NativeHistoryCache {
  private readonly filename: string
  private readonly openingFile: string
  constructor(directory: string, sessionId: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${sessionId}.history.json`)
    this.openingFile = join(directory, `${sessionId}.opening.json`)
  }
  read(): HapiMessage[] | undefined {
    return this.snapshot()?.rows
  }
  snapshot(opening = false): { rows: HapiMessage[]; complete: boolean; epoch?: number } | undefined {
    try {
      const value = cacheSchema.parse(JSON.parse(readFileSync(opening ? this.openingFile : this.filename, 'utf8')))
      return { complete: value.complete ?? true, ...(value.epoch === undefined ? {} : { epoch: value.epoch }), rows: value.rows.map(row => ({
        id: row.id, seq: row.seq, localId: row.localId, content: row.content, createdAt: row.createdAt,
        ...(row.invokedAt !== undefined ? { invokedAt: row.invokedAt } : {}),
        ...(row.scheduledAt !== undefined ? { scheduledAt: row.scheduledAt } : {}),
        ...(row.deliveryState !== undefined ? { deliveryState: row.deliveryState } : {}),
        ...(row.steered !== undefined ? { steered: row.steered } : {}),
      })) }
    } catch (error) { if (record(error)?.code === 'ENOENT') return undefined; throw error }
  }
  write(rows: readonly HapiMessage[], complete = true, epoch?: number, maxBytes = MAX_HISTORY_CACHE_BYTES): void {
    // Both files are disposable. When an archive exceeds the byte budget the
    // newest tail remains useful for a stale fallback, while dropping older
    // cached rows is safe because the source remains authoritative.
    const bounded = newestWithin(rows, maxBytes), truncated = bounded.length !== rows.length
    writeDurableJson(this.filename, { version: 1, complete: complete && !truncated, rows: bounded, ...(epoch === undefined ? {} : { epoch }) })
    this.writeOpening(bounded, complete && !truncated, epoch, maxBytes)
  }
  writeOpening(rows: readonly HapiMessage[], complete = false, epoch?: number, maxBytes = MAX_HISTORY_CACHE_BYTES): void {
    // A startup view reads a small file, not the full archive followed by a
    // slice. Both are disposable, identity-scoped caches; source epoch checks
    // and reconciliation remain authoritative if the process stops between writes.
    const opening = newestWithin(rows, maxBytes, 200)
    writeDurableJson(this.openingFile, { version: 1, complete: complete && rows.length === opening.length,
      rows: opening, ...(epoch === undefined ? {} : { epoch }) })
  }
}
