import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableJson } from './durable-file.ts'
import { z } from 'zod'
import type { HapiMessage } from './contracts.js'
import { record } from './native.js'

const cacheSchema = z.object({ version: z.literal(1), rows: z.array(z.object({
  id: z.string(), seq: z.number().nullable(), localId: z.string().nullable(), content: z.unknown(),
  createdAt: z.number(), invokedAt: z.number().nullable().optional(), scheduledAt: z.number().nullable().optional(),
  deliveryState: z.enum(['dispatching', 'indeterminate']).optional(), steered: z.boolean().optional(),
})) })

/** Disposable read cache. It is never used to infer delivery or approval outcomes. */
export class NativeHistoryCache {
  private readonly filename: string
  constructor(directory: string, sessionId: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${sessionId}.history.json`)
  }
  read(): HapiMessage[] | undefined {
    try {
      return cacheSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8'))).rows.map(row => ({
        id: row.id, seq: row.seq, localId: row.localId, content: row.content, createdAt: row.createdAt,
        ...(row.invokedAt !== undefined ? { invokedAt: row.invokedAt } : {}),
        ...(row.scheduledAt !== undefined ? { scheduledAt: row.scheduledAt } : {}),
        ...(row.deliveryState !== undefined ? { deliveryState: row.deliveryState } : {}),
        ...(row.steered !== undefined ? { steered: row.steered } : {}),
      }))
    } catch (error) { if (record(error)?.code === 'ENOENT') return undefined; throw error }
  }
  write(rows: readonly HapiMessage[]): void {
    writeDurableJson(this.filename, { version: 1, rows })
  }
}
