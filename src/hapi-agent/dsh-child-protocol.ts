import { createHash } from 'node:crypto'
import type { HapiSession } from '../codex/contracts.js'
import { canonicalJson, record } from '../codex/native.js'
import { NativeHistoryChangedError } from '../codex/projector.js'
import type { HapiObservedTransport } from './agent.js'
import { sourceDshChildDescriptorSchema, sourceDshChildPageSchema,
  type SourceDshChildBinding, type SourceDshChildDescriptor, type SourceDshChildMessage, type SourceDshChildPage } from './dsh-child-types.js'
import type { ObservedItem } from './parser.js'

export class SourceDshChildUnavailable extends Error {}
export function sourceDshChildCatalog(source: HapiSession): SourceDshChildDescriptor[] {
  if (source.metadata?.flavor !== 'dsh') return []
  const value = record(source.metadata)?.dshSubagents
  if (value === undefined) return []
  const children = sourceDshChildDescriptorSchema.array().parse(value)
  // Optional source fields may be explicitly undefined in an in-process
  // source adapter. Official plugin records require the same JSON shape as
  // the actual Hub wire, where those absent fields are omitted.
  for (const child of children) for (const [key, entry] of Object.entries(child)) if (entry === undefined) Reflect.deleteProperty(child, key)
  if (new Set(children.map(child => child.sessionId)).size !== children.length) throw new Error('The original DSH child catalog contains duplicate identities')
  return children
}
export function sourceDshChildBinding(hubId: string, source: HapiSession, child: SourceDshChildDescriptor): SourceDshChildBinding {
  const metadata = source.metadata
  if (metadata?.flavor !== 'dsh' || !metadata.dshSessionId || !metadata.machineId) throw new SourceDshChildUnavailable('The source DSH parent has no current Runner identity')
  return { hubId, namespace: source.namespace, sourceSessionId: source.id, parentDshSessionId: metadata.dshSessionId,
    machineId: metadata.machineId, childDshSessionId: child.sessionId, childCreatedAt: child.createdAt }
}
export function validateSourceDshChild(binding: SourceDshChildBinding, source: HapiSession, writable = false): SourceDshChildDescriptor {
  const child = sourceDshChildCatalog(source).find(value => value.sessionId === binding.childDshSessionId)
  const metadata = source.metadata
  if (source.id !== binding.sourceSessionId || source.namespace !== binding.namespace || metadata?.flavor !== 'dsh'
    || metadata.dshSessionId !== binding.parentDshSessionId || metadata.machineId !== binding.machineId
    || !child || child.createdAt !== binding.childCreatedAt) throw new SourceDshChildUnavailable('This DSH child no longer belongs to its original parent and Runner; acquire its current source display')
  if (!source.active) throw new SourceDshChildUnavailable('The original DSH parent is not attached to an active Runner')
  if (writable && child.mode !== 'continuable') throw new SourceDshChildUnavailable('Only a source-owned continuable DSH child accepts prompts and interrupts')
  return child
}
export function sourceDshChildPath(binding: SourceDshChildBinding, operation: 'messages' | 'prompt' | 'interrupt'): string {
  return `/api/sessions/${encodeURIComponent(binding.sourceSessionId)}/dsh-subagents/${encodeURIComponent(binding.childDshSessionId)}/${operation}`
}

export interface SourceDshChildHistory {
  epoch: string; after: number; rows: SourceDshChildMessage[]; truncated: boolean
}
const pageLimit = 100, maximumPages = 400, maximumCharacters = 32 * 1024 * 1024
function ordinal(row: SourceDshChildMessage, childId: string): number {
  const prefix = `${childId}:`
  if (!row.id.startsWith(prefix) || !/^(0|[1-9][0-9]*)$/.test(row.id.slice(prefix.length))) throw new Error('The original DSH transcript returned an unrelated row identity')
  const value = Number(row.id.slice(prefix.length))
  if (!Number.isSafeInteger(value)) throw new Error('The original DSH transcript cursor exceeds the supported range')
  return value
}
function checkedPage(raw: unknown, childId: string): SourceDshChildPage & { epoch: string; after: number } {
  const page = sourceDshChildPageSchema.parse(raw)
  if (page.sessionId !== childId) throw new Error('The original transcript belongs to another DSH child')
  if (!page.epoch || page.after === undefined) throw new Error('The original DSH transcript did not provide its epoch and cursor')
  let previous: number | undefined
  for (const row of page.messages) {
    const index = ordinal(row, childId)
    if (previous !== undefined && index !== previous + 1) throw new Error('The original DSH transcript contains a gap or reordered rows')
    previous = index
  }
  if (page.messages.length && ordinal(page.messages.at(-1)!, childId) >= page.after) throw new Error('The source DSH cursor does not cover the returned transcript')
  return { ...page, epoch: page.epoch, after: page.after }
}

/**
 * The source API exposes stable child-log ordinals, not original DSH events.
 * Read all available history, then catch up its append cursor. Every older page
 * must remain in the same epoch; a different epoch replaces a display generation.
 */
export async function readSourceDshChildHistory(transport: Pick<HapiObservedTransport, 'request'>, binding: SourceDshChildBinding,
  previous?: SourceDshChildHistory, authoritative = false): Promise<SourceDshChildHistory> {
  let pages = 0
  const read = async (query: { before?: number; after?: number; epoch?: string } = {}) => {
    if (++pages > maximumPages) throw new Error('The source child transcript exceeds this read budget; its complete history has not been confirmed')
    const search = new URLSearchParams({ limit: String(pageLimit) })
    for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value))
    return checkedPage(await transport.request(`${sourceDshChildPath(binding, 'messages')}?${search}`), binding.childDshSessionId)
  }
  const latest = await read(previous ? { epoch: previous.epoch } : {})
  if (previous && (latest.reset || latest.epoch !== previous.epoch || latest.after < previous.after)) {
    throw new NativeHistoryChangedError('The original DSH child transcript epoch or length changed')
  }
  const rows = new Map<number, SourceDshChildMessage>()
  let characters = 0
  const add = (row: SourceDshChildMessage) => {
    const index = ordinal(row, binding.childDshSessionId), found = rows.get(index)
    if (found) {
      if (canonicalJson(found) !== canonicalJson(row)) throw new NativeHistoryChangedError('The original DSH child changed a displayed row')
      return
    }
    characters += JSON.stringify(row).length
    if (characters > maximumCharacters) throw new Error('The source child history is larger than the complete-history safety limit')
    rows.set(index, row)
  }
  if (previous && !authoritative) previous.rows.forEach(add)
  latest.messages.forEach(add)
  let before = latest.before
  if (!previous || authoritative) {
    while (before !== null) {
      if (!latest.hasMore && pages === 1) throw new Error('The original DSH transcript supplied inconsistent pagination')
      const page = await read({ before, epoch: latest.epoch })
      if (page.reset || page.epoch !== latest.epoch) throw new NativeHistoryChangedError('The source child changed while its history was being read')
      if (!page.messages.length || ordinal(page.messages.at(-1)!, binding.childDshSessionId) !== before - 1
        || page.before !== null && page.before >= before) throw new Error('The source DSH history did not advance its older cursor')
      page.messages.forEach(add); before = page.before
    }
  } else {
    // The latest page may be more than one page ahead of the previous cursor.
    let after = previous.after
    while (after < latest.after) {
      const page = await read({ after, epoch: latest.epoch })
      if (page.reset || page.epoch !== latest.epoch) throw new NativeHistoryChangedError('The source child changed while catching up its transcript')
      if (page.after <= after || !page.messages.length || ordinal(page.messages[0]!, binding.childDshSessionId) !== after) throw new Error('The source DSH history did not advance its newer cursor')
      page.messages.forEach(add); after = page.after
    }
  }
  const ordered = [...rows].sort((a, b) => a[0] - b[0])
  for (let index = 0; index < ordered.length; index++) if (ordered[index]![0] !== index) throw new Error('The original DSH transcript did not supply its complete prefix')
  if (ordered.length < latest.after) throw new Error('The original DSH transcript tail is incomplete')
  if (previous && authoritative) {
    for (let index = 0; index < previous.rows.length; index++) if (!ordered[index]
      || canonicalJson(previous.rows[index]) !== canonicalJson(ordered[index]![1])) throw new NativeHistoryChangedError('The original DSH child replaced an earlier displayed row')
  }
  return { epoch: latest.epoch, after: ordered.length, rows: ordered.map(([, row]) => row),
    truncated: latest.truncated === true || ordered.some(([, row]) => row.truncated === true) }
}

/** Display grouping derives only actual neutral rows; no guessed turn/end. */
export function sourceDshChildItems(history: SourceDshChildHistory, childId: string): ObservedItem[] {
  return history.rows.map((row): ObservedItem => {
    const base = { key: `dsh-child:${history.epoch}:${row.id}`, rowId: row.id, localId: null, seq: null,
      createdAt: row.createdAt, scopeId: `dsh-child:${childId}`, parentToolCallId: null, model: null,
      fingerprint: createHash('sha256').update(canonicalJson(row)).digest('hex') }
    if (row.kind === 'tool-call') return { ...base, kind: 'tool-call', callId: row.callId ?? `unidentified:${row.id}`,
      name: row.toolName ?? 'Tool', input: row.input ?? row.text }
    if (row.kind === 'tool-result' || row.role === 'tool') return { ...base, kind: 'tool-result', callId: row.callId ?? `unidentified-result:${row.id}`,
      output: row.output ?? row.text, parts: [{ type: 'text', text: row.text }], isError: row.isError === true }
    if (row.role === 'user') return { ...base, kind: 'user', text: row.text,
      parts: [{ type: 'text', text: row.text }], invoked: true, mode: 'queue' }
    return { ...base, kind: 'assistant', text: row.text, reasoning: row.kind === 'reasoning', live: false, cumulative: false,
      parts: [{ type: row.kind === 'reasoning' ? 'reasoning' : 'text', text: row.text }] }
  })
}
