import { createHash } from 'node:crypto'
import type { HapiAttachment, HapiMessage } from '../codex/contracts.js'
import { canonicalJson, envelopeFor, record } from '../codex/native.js'
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
    cachedInputTokens: cached, cacheCreationTokens: creation, contextTokens: context, contextWindow: window && window > 0 ? window : null }
}

function fingerprint(item: ObservedItem): ObservedItem {
  item.fingerprint = createHash('sha256').update(canonicalJson({
    ...item, rowId: undefined, localId: undefined, seq: undefined, createdAt: undefined, fingerprint: undefined,
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
  const base: ObservedBase = { key: `${namespace}${sourceKey}`, rowId: row.id, localId: row.localId, seq: row.seq, createdAt: row.createdAt,
    scopeId, parentToolCallId,
    fingerprint: '', model: str(record(data?.message)?.model) ?? str(data?.model) ?? null }
  const values: ObservedItem[] = []
  const push = (item: ObservedItem): void => { values.push(fingerprint(item)) }
  const notice = (kind: ObservedNotice['kind'], text: string, suffix = 'notice'): void => {
    const key = `${base.key}:${suffix}`
    push({ ...base, key, kind: 'notice', notice: { id: key, createdAt: base.createdAt, kind, text, scopeId } })
  }
  if (envelope.role === 'user') {
    const parts = inputParts(envelope.content)
    if (parts.length) push({ ...base, key: `user:${row.localId ?? row.id}`, kind: 'user', parts, text: textOf(parts),
      invoked: row.localId === null || row.invokedAt != null, mode: record(envelope.meta)?.deliveryMode === 'steer' || row.steered ? 'steer' : 'queue' })
    return values
  }
  if (envelope.role !== 'agent' || !content || !data) return []
  if (content.type === 'event' && !childTrace) {
    if (data.type === 'ready') push({ ...base, kind: 'end', reason: 'completed', error: null })
    else if (data.type === 'abort-restore') {
      push({ ...base, kind: 'end', reason: 'aborted', error: null })
      if (typeof data.text === 'string') notice('message', data.text, 'aborted-input')
    } else if (data.type === 'message' || data.type === 'error') notice(data.type, str(data.message) ?? canonicalJson(data))
    else if (data.type === 'compact-summary') notice('summary', str(data.summary) ?? '')
    else if (data.type === 'compact') notice('compact', str(data.message) ?? canonicalJson(data))
    else notice('source-event', canonicalJson(data))
    return values
  }
  if (content.type === 'codex' || childTrace) {
    const id = str(data.id)
    if ((data.type === 'message' || data.type === 'reasoning') && typeof data.message === 'string') {
      const reasoning = data.type === 'reasoning'
      const cumulative = reasoning && id !== undefined || data.streamSnapshot === true || childTrace && id !== undefined || Boolean(id?.match(/^pi-.+-turn-\d+-message-\d+-text-\d+$/))
      const live = data.live === true || !reasoning && cumulative && (!childTrace || row.localId !== id || data.streamSnapshot === true)
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
    } else if (data.type === 'error') notice('error', str(data.message) ?? canonicalJson(data))
    else if (data.type === 'context_compacted') notice('compact', canonicalJson(data))
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
    } else notice('source-event', canonicalJson(data))
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
      error: data.is_error === true ? str(data.result) ?? canonicalJson(data.errors ?? data) : null })
    const usage = usageOf(record(data.resultSummary)?.usage ?? data.usage, base, false)
    if (usage) push({ ...base, key: `${base.key}:usage`, kind: 'usage', usage })
  } else if (data.type === 'summary') notice('summary', str(data.summary) ?? '')
  else if (data.type === 'system' && data.subtype === 'api_error') notice('error', canonicalJson(data.error ?? data))
  else if (data.type === 'system' && ['compact_boundary', 'microcompact_boundary'].includes(String(data.subtype))) notice('compact', canonicalJson(data))
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
  return items
}
