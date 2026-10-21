import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalJson, record, type NativeBinding } from './native.js'
import { writeDurableJson } from './durable-file.js'

const markerSchema = z.object({ version: z.literal(1), initialBinding: z.string().regex(/^[0-9a-f]{64}$/) })

/**
 * Delivery and approval receipts belong to a thread/home/machine binding,
 * not just a Hub row. Preserve the original directory for existing installs;
 * later identities have separate durable namespaces. A display-only rewind
 * keeps the same binding and therefore the same receipts.
 */
export function nativeStateDirectory(root: string, logicalSessionId: string, binding: NativeBinding): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const fingerprint = createHash('sha256').update(canonicalJson(binding)).digest('hex')
  const markerFile = join(root, `${logicalSessionId}.binding.json`)
  let initialBinding: string
  try { initialBinding = markerSchema.parse(JSON.parse(readFileSync(markerFile, 'utf8'))).initialBinding }
  catch (error) {
    if (record(error)?.code !== 'ENOENT') throw error
    writeDurableJson(markerFile, { version: 1, initialBinding: fingerprint })
    initialBinding = fingerprint
  }
  return initialBinding === fingerprint ? root : join(root, 'identities', logicalSessionId, fingerprint)
}
