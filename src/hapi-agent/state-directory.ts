import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalJson, record } from '../codex/native.js'
import { writeDurableJson } from '../codex/durable-file.js'
import type { ObservedBinding } from './identity.js'

const bindingSchema = z.object({ hubId: z.string(), hapiSessionId: z.string(), flavor: z.string(), nativeId: z.string().nullable(), machineId: z.string().nullable() })
const schema = z.object({ version: z.literal(1), initial: bindingSchema })

/** Preserve startup readiness promotion, isolate receipts after a real source-thread replacement. */
export function observedStateDirectory(root: string, logicalId: string, binding: ObservedBinding): string {
  const filename = join(root, `${logicalId}.binding.json`)
  let initial: ObservedBinding
  try { initial = schema.parse(JSON.parse(readFileSync(filename, 'utf8'))).initial }
  catch (error) {
    if (record(error)?.code !== 'ENOENT') throw error
    writeDurableJson(filename, { version: 1, initial: binding })
    return root
  }
  if (canonicalJson(initial) === canonicalJson(binding)) return root
  if (initial.nativeId === null && initial.hapiSessionId === binding.hapiSessionId && initial.hubId === binding.hubId
    && initial.machineId === binding.machineId && initial.flavor === binding.flavor) {
    writeDurableJson(filename, { version: 1, initial: binding })
    return root
  }
  return join(root, 'identities', logicalId, createHash('sha256').update(canonicalJson(binding)).digest('hex'))
}
