import type { HapiMessage } from '../codex/contracts.ts'
import { isSourceTurnStart } from '../codex/source-window.ts'

export const SOURCE_PROJECTION_MAX_ROWS = 1_000
export const SOURCE_PROJECTION_MAX_BYTES = 4 * 1024 * 1024
export const SOURCE_PROJECTION_MAX_EVENTS = 8_000

/** Retain complete recent turns. An oversized current turn is indivisible;
 * preceding turns leave together with the projector indexes they created. */
export function boundedProjectionRows(rows: readonly HapiMessage[], maxRows = SOURCE_PROJECTION_MAX_ROWS,
  maxBytes = SOURCE_PROJECTION_MAX_BYTES): { rows: readonly HapiMessage[]; trimmed: boolean } {
  let bytes = 0, start = rows.length
  while (start > 0) {
    const next = start - 1
    bytes += Buffer.byteLength(JSON.stringify(rows[next]), 'utf8')
    start = next
    if (rows.length - start >= maxRows || bytes >= maxBytes) break
  }
  if (start === 0 && bytes <= maxBytes) return { rows, trimmed: false }
  // Drop a partial older turn instead of pulling its arbitrarily large prefix
  // into this window. Only the current turn is allowed to exceed the budget.
  const completeStart = rows.findIndex((row, index) => index >= start + (bytes > maxBytes ? 1 : 0) && isSourceTurnStart(row))
  if (completeStart >= 0) start = completeStart
  else while (start > 0 && !isSourceTurnStart(rows[start]!)) start--
  return { rows: start ? rows.slice(start) : rows, trimmed: start > 0 }
}
