import { createHash } from 'node:crypto'
import type { HapiAttachment, HapiMessage } from '../codex/contracts.js'
import { canonicalJson, envelopeFor, nativeExecutionFor, record, type NativeExecution } from '../codex/native.js'
import type { ObservedNotice, ObservedUsage } from './projection-types.js'
import { ObservedScopeIndex } from './scopes.js'
import type { SourceGeneratedMedia } from './generated-media-types.js'
import { sourceStandaloneReview, type SourceCodexReview } from './codex-review.js'

export type SourcePart = { type: 'text'; text: string } | { type: 'reasoning'; text: string }
  | { type: 'artifact'; artifact: unknown } | { type: 'upload'; attachment: HapiAttachment }
  | { type: 'inline'; fileName: string; mimeType: string; base64: string }
  | { type: 'generated-media'; media: SourceGeneratedMedia }
  | { type: 'resource-link'; name: string; uri: string } | { type: 'unsupported'; label: string }

interface ObservedBase {
  key: string; rowId: string; localId: string | null; seq: number | null; createdAt: number
  scopeId: string | null; parentToolCallId: string | null; fingerprint: string; model: string | null
  nativeExecution?: NativeExecution
}
export type ObservedItem = ObservedBase & (
  | { kind: 'user'; parts: SourcePart[]; text: string; invoked: boolean; mode: 'queue' | 'steer' }
  | { kind: 'assistant'; parts: SourcePart[]; text: string; reasoning: boolean; live: boolean; cumulative: boolean; review?: SourceCodexReview }
  | { kind: 'tool-call'; callId: string; name: string; input: unknown; progress?: unknown }
  | { kind: 'tool-result'; callId: string; output: unknown; parts: SourcePart[]; isError: boolean }
  | { kind: 'end'; reason: 'completed' | 'error' | 'aborted'; error: string | null }
  | { kind: 'notice'; notice: ObservedNotice }
  | { kind: 'usage'; usage: ObservedUsage }
)

const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Protocol/lifecycle rows describe source execution state, not transcript text. */
const NON_TRANSCRIPT_TYPES = new Set(['native-turn', 'thread_goal_updated', 'thread_goal_cleared',
  'agent-run-start', 'agent-run-update', 'agent-run-trace'])
/** Unknown protocol rows stay visible as one readable notice; raw JSON never enters a transcript. */
function unknownProtocolLabel(data: Record<string, unknown>): string {
  const type = str(data.type)
  return type ? `Unsupported source event: ${type}` : 'Unsupported source event'
}
/** Readable error text from a source fact; a source payload is not a transcript body. */
function sourceErrorText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value
  const found = record(value)
  const nested = record(found?.error)
  const text = str(found?.message) ?? str(nested?.message) ?? (typeof found?.error === 'string' ? found.error : undefined)
  return text?.trim() || fallback
}

/** Interpret only documented HAPI / Claude wire blocks; URLs stay links. */
export function sourceParts(value: unknown): SourcePart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): SourcePart[] => {
    const p = record(raw)
    if (!p) return []
    if (p.type === 'text' && typeof p.text === 'string') return [{ type: 'text', text: p.text }]
    if (p.type === 'thinking' && typeof p.thinking === 'string') return [{ type: 'reasoning', text: p.thinking }]
    if (p.type === 'reasoning' && typeof p.text === 'string') return [{ type: 'reasoning', text: p.text }]
    if (p.type === 'artifact') return [{ type: 'artifact', artifact: p.artifact }]
    if (p.type === 'resource-link' && typeof p.name === 'string' && typeof p.uri === 'string') return [{ type: 'resource-link', name: p.name, uri: p.uri }]
    if (p.type === 'unsupported' && typeof p.label === 'string') return [{ type: 'unsupported', label: p.label }]
    if (p.type === 'image' || p.type === 'document') {
      const s = record(p.source)
      if (s?.type === 'base64' && typeof s.data === 'string' && typeof s.media_type === 'string') return [{
        type: 'inline', fileName: str(p.title) ?? str(p.name) ?? (p.type === 'image' ? 'source-image' : 'source-document'),
        mimeType: s.media_type, base64: s.data,
      }]
      if (s?.type === 'url' && typeof s.url === 'string') return [{ type: 'resource-link', name: str(p.title) ?? String(p.type), uri: s.url }]
      return [{ type: 'unsupported', label: `${String(p.type)} source is unavailable` }]
    }
    return []
  })
}

function uploadParts(value: unknown): SourcePart[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): SourcePart[] => {
    const a = record(raw)
    if (!a) return []
    if (record(a.artifact)) return [{ type: 'artifact', artifact: a.artifact }]
    if (typeof a.id !== 'string' || typeof a.filename !== 'string' || typeof a.mimeType !== 'string'
      || typeof a.size !== 'number' || a.size < 0 || typeof a.path !== 'string') return []
    return [{ type: 'upload', attachment: { id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size, path: a.path,
      ...(typeof a.previewUrl === 'string' ? { previewUrl: a.previewUrl } : {}) } }]
  })
}

function inputParts(content: unknown): SourcePart[] {
  if (typeof content === 'string' || Array.isArray(content)) return sourceParts(content)
  const c = record(content)
  if (c?.type !== 'text' || typeof c.text !== 'string') return []
  // Source-native parts already contain the text and artifact attachments.
  const parts = sourceParts(c.parts)
  if (parts.length) return parts
  return [{ type: 'text', text: c.text }, ...uploadParts(c.attachments)]
}

function textOf(parts: readonly SourcePart[]): string { return parts.flatMap(part => part.type === 'text' || part.type === 'reasoning' ? [part.text] : []).join('\n') }

function usageOf(value: unknown, base: ObservedBase, inclusive: boolean): ObservedUsage | undefined {
  const info = record(value)
  if (!info) return undefined
  const u = record(info.last ?? info.lastTokenUsage ?? info.last_token_usage)
    ?? record(info.total ?? info.totalTokenUsage ?? info.total_token_usage) ?? info
  const input = count(u.inputTokens ?? u.input_tokens)
  const output = count(u.outputTokens ?? u.output_tokens)
  if (input === null || output === null) return undefined
  const cached = count(u.cachedInputTokens ?? u.cached_input_tokens ?? u.cacheReadInputTokens ?? u.cache_read_input_tokens)
  const creation = count(u.cacheWriteInputTokens ?? u.cache_creation_input_tokens)
  const context = count(info.contextTokens ?? info.context_tokens) ?? input + (inclusive ? 0 : (cached ?? 0) + (creation ?? 0)) + output
  const window = count(info.modelContextWindow ?? info.model_context_window ?? info.context_window)
  return { id: base.key, createdAt: base.createdAt, model: base.model, inputTokens: input, outputTokens: output,
    cachedInputTokens: cached, cacheCreationTokens: creation, inputIncludesCache: inclusive,
    contextTokens: context, contextWindow: window && window > 0 ? window : null }
}

function fingerprint(item: ObservedItem): ObservedItem {
  item.fingerprint = createHash('sha256').update(canonicalJson({
    ...item, rowId: undefined, localId: undefined, seq: undefined, createdAt: undefined, fingerprint: undefined,
    nativeExecution: item.nativeExecution ? { ...item.nativeExecution, turn: undefined } : undefined,
    ...(item.kind === 'assistant' ? { live: undefined } : {}), ...(item.kind === 'tool-call' ? { progress: undefined } : {}),
  })).digest('hex')
  return item
}

function parseObservedBody(row: HapiMessage, scopes: ObservedScopeIndex): ObservedItem[] {
  const envelope = envelopeFor(row.content)
  if (!envelope) return []
  const content = record(envelope.content)
  let data = record(content?.data)
  const sdk = content?.type === 'output'
  const { scopeId, parentToolCallId } = scopes.forRow(row)
  const childTrace = data?.type === 'agent-run-trace' && scopeId !== null
  if (childTrace) {
    data = record(data?.message)
    if (!data) return []
    const child = scopes.scopes().find(value => value.scopeId === scopeId)
    const threadId = str(record(data.nativeExecution)?.threadId)
    if (threadId && child?.sourceAgentId && threadId !== child.sourceAgentId) throw new Error('The source child trace belongs to a different agent identity')
  }
  const namespace = scopeId ? `${scopeId}:` : ''
  const sourceKey = childTrace ? str(data?.id) ?? row.id : row.id
  const nativeExecution = nativeExecutionFor(childTrace ? data?.nativeExecution : record(envelope.meta)?.nativeExecution ?? data?.nativeExecution)
  const base: ObservedBase = { key: `${namespace}${sourceKey}`, rowId: row.id, localId: row.localId, seq: row.seq, createdAt: row.createdAt,
    scopeId, parentToolCallId,
    fingerprint: '', model: str(record(data?.message)?.model) ?? str(data?.model) ?? null,
    ...(nativeExecution ? { nativeExecution } : {}) }
  const values: ObservedItem[] = []
  const push = (item: ObservedItem): void => { values.push(fingerprint(item)) }
  const notice = (kind: ObservedNotice['kind'], text: string, suffix = 'notice', details?: string): void => {
    const key = `${base.key}:${suffix}`
    push({ ...base, key, kind: 'notice', notice: { id: key, createdAt: base.createdAt, kind, text, scopeId,
      ...(details === undefined ? {} : { details }) } })
  }
  if (envelope.role === 'user') {
    const parts = inputParts(envelope.content)
    if (parts.length) push({ ...base, key: `user:${row.localId ?? row.id}`, kind: 'user', parts, text: textOf(parts),
      invoked: nativeExecution !== undefined || row.localId === null || row.invokedAt != null,
      mode: record(envelope.meta)?.deliveryMode === 'steer' || row.steered ? 'steer' : 'queue' })
    return values
  }
  if (envelope.role !== 'agent' || !content || !data) return []
  // A source-native lifecycle row carries turn facts; it is not an assistant
  // response or a diagnostic JSON notice. parseObservedMessage consumes its
  // actual terminal fact below, including archived/non-native Codex sessions.
  if (data.type === 'native-turn' && nativeExecution) return values
  if (content.type === 'event' && !childTrace) {
    if (data.type === 'ready') push({ ...base, kind: 'end', reason: 'completed', error: null })
    else if (data.type === 'abort-restore') {
      push({ ...base, kind: 'end', reason: 'aborted', error: null })
      if (typeof data.text === 'string') notice('message', data.text, 'aborted-input')
    } else if (data.type === 'message' || data.type === 'error') notice(data.type, sourceErrorText(data, data.type === 'error'
      ? 'The source engine reported an error' : 'The source sent a message event without text'), 'notice', str(data.details))
    else if (data.type === 'compact-summary') notice('summary', str(data.summary) ?? '')
    else if (data.type === 'compact') notice('compact', str(data.message) ?? 'Source context was compacted.')
    else notice('source-event', unknownProtocolLabel(data))
    return values
  }
  if (content.type === 'codex' || childTrace) {
    const id = str(data.id)
    if ((data.type === 'message' || data.type === 'reasoning') && typeof data.message === 'string') {
      const reasoning = data.type === 'reasoning'
      const cumulative = reasoning && id !== undefined || data.streamSnapshot === true || childTrace && id !== undefined || Boolean(id?.match(/^pi-.+-turn-\d+-message-\d+-text-\d+$/))
      // Shared Codex history keeps streamSnapshot=true on completed items.
      // Only a durable source identity confirms completion: execution-bearing
      // rows compare against their stable message id, other codex rows require
      // the durable localId so a completed answer is not re-detected as live.
      const live = data.live === true || (nativeExecution
        ? id === undefined || row.localId !== id
        : !reasoning && cumulative && (childTrace
          ? row.localId !== id || data.streamSnapshot === true
          : row.localId === null))
      const review = !reasoning && !live ? sourceStandaloneReview(data.message, data) : null
      push({ ...base, key: `${namespace}${reasoning ? 'reasoning' : 'text'}:${cumulative && id ? id : sourceKey}`,
        kind: 'assistant', parts: [{ type: reasoning ? 'reasoning' : 'text', text: data.message }],
        text: data.message, reasoning, cumulative, live,
        ...(review ? { review } : {}) })
    } else if (data.type === 'tool-call' && typeof data.callId === 'string') {
      push({ ...base, key: `${namespace}tool:${data.callId}`, kind: 'tool-call', callId: data.callId,
        name: str(data.name) ?? 'unknown', input: data.input ?? {}, ...('progress' in data ? { progress: data.progress } : {}) })
    } else if (data.type === 'tool-call-result' && typeof data.callId === 'string') {
      const output = data.output ?? null
      push({ ...base, key: `${namespace}result:${data.callId}:${sourceKey}`, kind: 'tool-result', callId: data.callId, output,
        parts: sourceParts(record(output)?.content ?? output), isError: data.is_error === true || record(output)?.exit_code !== undefined && record(output)?.exit_code !== 0 })
    } else if (data.type === 'plan' || data.type === 'plan_update') {
      const plan = data.entries ?? data.plan ?? data.update ?? data.items ?? data.steps
      if (Array.isArray(plan)) {
        const callId = `${namespace}source-plan:${sourceKey}`
        push({ ...base, key: `${callId}:call`, kind: 'tool-call', callId, name: 'update_plan', input: { plan } })
        push({ ...base, key: `${callId}:result`, kind: 'tool-result', callId, output: { plan }, parts: [], isError: false })
      }
    } else if (data.type === 'token_count') {
      const usage = usageOf(data.info, base, true)
      if (usage) push({ ...base, kind: 'usage', usage })
    } else if (data.type === 'error') notice('error', sourceErrorText(data, 'The source engine reported an error'), 'notice', str(data.details))
    else if (data.type === 'context_compacted') notice('compact', 'The source context was compacted.')
    else if (data.type === 'compact-summary') notice('summary', str(data.summary) ?? '')
    else if (data.type === 'generated-image') {
      const s = record(data.source)
      const imageId = str(data.imageId ?? data.image_id)
      const parts: SourcePart[] = s?.type === 'base64' && typeof s.data === 'string'
        ? [{ type: 'inline', fileName: str(data.fileName) ?? 'generated-image', mimeType: str(data.mimeType) ?? 'image/png', base64: s.data }]
        : s?.type === 'url' && typeof s.url === 'string' ? [{ type: 'resource-link', name: str(data.fileName) ?? 'generated-image', uri: s.url }]
        : imageId ? [{ type: 'generated-media', media: { imageId, fileName: str(data.fileName ?? data.file_name) ?? 'generated-media', mimeType: str(data.mimeType ?? data.mime_type) ?? null } }]
        : [{ type: 'unsupported', label: `Generated image ${imageId ?? row.id} requires its source resource` }]
      push({ ...base, kind: 'assistant', parts, text: '', reasoning: false, cumulative: false, live: false })
    } else if (NON_TRANSCRIPT_TYPES.has(String(data.type))) return values
    else notice('source-event', unknownProtocolLabel(data))
    return values
  }
  if (!sdk || data.isMeta === true || data.isCompactSummary === true) return []
  if (data.type === 'assistant' || data.type === 'user') {
    const m = record(data.message)
    if (!m) return []
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    const uuid = str(data.uuid) ?? row.id
    const userOnly = data.type === 'user' && blocks.length > 0 && blocks.every(b => ['text', 'image', 'document'].includes(String(record(b)?.type)))
    if (userOnly) {
      const parts = sourceParts(blocks)
      push({ ...base, key: `${namespace}sdk-user:${uuid}`, kind: 'user', parts, text: textOf(parts), invoked: true, mode: 'queue' })
    } else blocks.forEach((raw, index) => {
      const b = record(raw)
      if (!b) return
      const key = `sdk:${scopeId ?? 'root'}:${uuid}:${index}`
      if (b.type === 'tool_use' && typeof b.id === 'string') push({ ...base, key, kind: 'tool-call', callId: b.id, name: str(b.name) ?? 'unknown', input: b.input ?? {} })
      else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const output = data.toolUseResult ?? b.content ?? null
        push({ ...base, key, kind: 'tool-result', callId: b.tool_use_id, output, parts: sourceParts(b.content), isError: b.is_error === true })
      } else {
        const parts = sourceParts([b])
        if (parts.length) push({ ...base, key, kind: 'assistant', parts, text: textOf(parts), reasoning: b.type === 'thinking', live: false, cumulative: false })
      }
    })
    const usage = usageOf(m.usage, base, false)
    if (usage) push({ ...base, key: `${base.key}:usage`, kind: 'usage', usage })
  } else if (data.type === 'result' || data.type === 'system' && data.subtype === 'turn_duration') {
    push({ ...base, kind: 'end', reason: data.is_error === true ? 'error' : 'completed',
      error: data.is_error === true ? sourceErrorText(data.result ?? data.errors ?? data, 'The source engine reported an error') : null })
    const usage = usageOf(record(data.resultSummary)?.usage ?? data.usage, base, false)
    if (usage) push({ ...base, key: `${base.key}:usage`, kind: 'usage', usage })
  } else if (data.type === 'summary') notice('summary', str(data.summary) ?? '')
  else if (data.type === 'system' && data.subtype === 'api_error') notice('error', sourceErrorText(data.error ?? data, 'The source provider reported an API error'))
  else if (data.type === 'system' && ['compact_boundary', 'microcompact_boundary'].includes(String(data.subtype))) notice('compact', 'Source context was compacted.')
  else if (data.type === 'system' && data.subtype === 'away_summary') notice('summary', str(data.content) ?? '')
  else if (data.type === 'agy_message' && typeof data.content === 'string') push({ ...base, kind: 'assistant', parts: [{ type: 'text', text: data.content }],
    text: data.content, reasoning: false, cumulative: false, live: false })
  else if (data.type === 'agy_tool_action') {
    const callId = str(data.toolUseId) ?? row.id
    push({ ...base, key: `${row.id}:call`, kind: 'tool-call', callId, name: str(data.toolName) ?? str(data.name) ?? 'unknown', input: data.input ?? {} })
    push({ ...base, key: `${row.id}:result`, kind: 'tool-result', callId, output: data.content ?? null,
      parts: sourceParts(data.content), isError: data.name === 'ERROR_MESSAGE' })
  }
  return values
}

/** Normalize source facts without adding a native execution or native turn id. */
export function parseObservedMessage(row: HapiMessage, scopes?: ObservedScopeIndex): ObservedItem[] {
  if (!scopes) { scopes = new ObservedScopeIndex(); scopes.update([row]) }
  const values = parseObservedBody(row, scopes)
  const envelope = envelopeFor(row.content), content = record(envelope?.content)
  const outer = record(content?.data), data = outer?.type === 'agent-run-trace' ? record(outer.message) : outer
  const nativeExecution = nativeExecutionFor(outer?.type === 'agent-run-trace'
    ? data?.nativeExecution : record(envelope?.meta)?.nativeExecution ?? data?.nativeExecution)
  if (nativeExecution?.turn?.ended && nativeExecution.turn.status !== 'inProgress') {
    const { scopeId, parentToolCallId } = scopes.forRow(row)
    // Every indexed item may repeat these source lifecycle facts. One stable
    // terminal identity is shared by the explicit event and the metadata.
    values.push(fingerprint({ key: `${scopeId ?? 'root'}:native-end:${nativeExecution.threadId}:${nativeExecution.turnId}`,
      rowId: row.id, localId: row.localId, seq: row.seq, createdAt: row.createdAt, scopeId, parentToolCallId,
      model: null, fingerprint: '', kind: 'end', reason: nativeExecution.turn.status === 'completed' ? 'completed'
        : nativeExecution.turn.status === 'interrupted' ? 'aborted' : 'error', error: null,
      nativeExecution: { threadId: nativeExecution.threadId, turnId: nativeExecution.turnId, turn: nativeExecution.turn } }))
  }
  for (const completion of scopes.completionsForRow(row)) values.push(fingerprint({
    ...completion, rowId: row.id, localId: row.localId, seq: row.seq, createdAt: row.createdAt,
    kind: 'end', model: null, fingerprint: '',
  }))
  return values
}

/** Snapshot coalescing retains the first ordering position and newest cumulative payload. */
export function parseObservedHistory(rows: readonly HapiMessage[], scopes?: ObservedScopeIndex): ObservedItem[] {
  if (!scopes) { scopes = new ObservedScopeIndex(); scopes.update(rows, true) }
  const items: ObservedItem[] = []
  const streams = new Map<string, number>()
  for (const row of rows) for (const item of parseObservedMessage(row, scopes)) {
    if (item.kind === 'assistant' && item.cumulative || item.kind === 'tool-call') {
      const identity = `${item.scopeId ?? 'root'}:${item.key}`
      const previous = streams.get(identity)
      if (previous !== undefined) { items[previous] = item; continue }
      streams.set(identity, items.length)
    }
    items.push(item)
  }
  // A native history snapshot can put final lifecycle metadata on its first
  // item (or a native-turn row before the items). Settle only after all known
  // items in that source turn, never before the actual answer is projected.
  const endings = new Map<string, ObservedItem & { kind: 'end' }>()
  const positions = new Map<string, number>()
  const ordered: ObservedItem[] = []
  const turnKey = (item: ObservedItem): string | undefined => item.nativeExecution
    ? JSON.stringify([item.scopeId, item.nativeExecution.threadId, item.nativeExecution.turnId]) : undefined
  for (const item of items) {
    const key = turnKey(item)
    if (key && item.kind === 'end') { endings.set(key, item); if (!positions.has(key)) positions.set(key, ordered.length - 1); continue }
    ordered.push(item)
    if (key) positions.set(key, ordered.length - 1)
  }
  const after = new Map<number, ObservedItem[]>()
  for (const [key, ending] of endings) {
    const index = positions.get(key) ?? -1
    after.set(index, [...after.get(index) ?? [], ending])
  }
  return [...after.get(-1) ?? [], ...ordered.flatMap((item, index) => [item, ...after.get(index) ?? []])]
}
