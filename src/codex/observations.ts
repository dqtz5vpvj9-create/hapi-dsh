import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { HapiMessage } from './contracts.js'
import { envelopeFor, record, type NativeBinding } from './native.js'
import { writeDurableJson } from './durable-file.js'
import {
  nativeNoticeSchema, nativeUsageSchema, type NativeNotice, type NativeUsage,
} from './observation-types.js'

const cacheSchema = z.object({
  version: z.literal(1), notices: z.array(nativeNoticeSchema), usage: nativeUsageSchema.nullable(),
})
type Observation = { kind: 'notice'; value: NativeNotice } | { kind: 'usage'; value: NativeUsage }

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function tokenCount(raw: unknown) {
  const value = record(raw)
  if (!value) return null
  const inputTokens = count(value.inputTokens ?? value.input_tokens)
  const outputTokens = count(value.outputTokens ?? value.output_tokens)
  if (inputTokens === null || outputTokens === null) return null
  return { inputTokens, outputTokens, cachedInputTokens: count(value.cachedInputTokens ?? value.cached_input_tokens
    ?? value.cacheReadInputTokens ?? value.cache_read_input_tokens) }
}

/** Matches HAPI's source event vocabulary, including events without a model turn. */
export function parseNativeObservation(row: HapiMessage, binding: NativeBinding): Observation | undefined {
  const envelope = envelopeFor(row.content)
  const content = record(envelope?.content)
  const data = record(content?.data)
  if (envelope?.role !== 'agent' || !content || !data || !['event', 'codex'].includes(String(content.type))) return
  if (typeof data.type !== 'string' || data.type.startsWith('agent-run-')) return
  const scope = record(data.scope)
  if (data.scope_role === 'child' || scope?.role === 'child') return
  const execution = record(record(envelope.meta)?.nativeExecution ?? data.nativeExecution)
  const threadId = execution?.threadId ?? data.threadId ?? data.thread_id ?? scope?.threadId ?? scope?.thread_id
  if (typeof threadId === 'string' && threadId !== binding.threadId) return
  const turn = execution?.turnId ?? data.turnId ?? data.turn_id
  const turnId = typeof turn === 'string' ? turn : null
  const sourceId = data.id ?? content.id ?? row.localId ?? row.id
  if (typeof sourceId !== 'string' || !sourceId) return
  const identity = { id: sourceId, createdAt: row.createdAt, turnId }
  if ((content.type === 'event' && data.type === 'message' || data.type === 'error') && typeof data.message === 'string') {
    return { kind: 'notice', value: { ...identity, kind: data.type === 'error' ? 'error' : 'message', text: data.message } }
  }
  if (data.type === 'context_compacted' || content.type === 'event' && data.type === 'compact') {
    return { kind: 'notice', value: { ...identity, kind: 'context-compacted', text: 'Native Codex context was compacted.' } }
  }
  if (data.type === 'compact-summary' && typeof data.summary === 'string') {
    return { kind: 'notice', value: { ...identity, kind: 'compact-summary', text: data.summary } }
  }
  if (data.type !== 'token_count') return
  const info = record(data.info)
  if (!info) return
  // The live context is the last native request; the thread total is a separate counter.
  const last = info.last ?? info.lastTokenUsage ?? info.last_token_usage
  const total = tokenCount(info.total ?? info.totalTokenUsage ?? info.total_token_usage)
  const currentSource = last ?? info.total ?? info.totalTokenUsage ?? info.total_token_usage ?? info
  const current = tokenCount(currentSource)
  if (!current) return
  const currentRecord = record(currentSource)
  const contextWindow = count(info.modelContextWindow ?? info.model_context_window)
  return { kind: 'usage', value: {
    ...identity, ...current, threadId: binding.threadId, model: typeof data.model === 'string' ? data.model : null,
    contextTokens: count(info.contextTokens ?? info.context_tokens ?? currentRecord?.contextTokens ?? currentRecord?.context_tokens) ?? current.inputTokens,
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : null, total,
  } }
}

/**
 * Hub status events are not part of native thread/read history. Keep only
 * actually observed source notifications in a bounded durable view cache, so
 * a REST refresh, native rewind, or display-generation replacement cannot
 * erase a /status response or an explicit native failure. This cache never
 * decides whether a command, queue message, or approval executed.
 */
export class NativeObservations {
  private readonly filename: string
  private readonly noticesById = new Map<string, NativeNotice>()
  private currentUsage: NativeUsage | null = null
  static readonly noticeLimit = 200

  constructor(directory: string, logicalSessionId: string, private readonly binding: NativeBinding) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${logicalSessionId}.observations.json`)
    try {
      const cached = cacheSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const notice of cached.notices.slice(-NativeObservations.noticeLimit)) this.noticesById.set(notice.id, notice)
      if (cached.usage?.threadId === binding.threadId) this.currentUsage = cached.usage
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }

  get notices(): NativeNotice[] { return [...this.noticesById.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) }
  get usage(): NativeUsage | null { return this.currentUsage }

  observe(rows: readonly HapiMessage[]): void {
    let changed = false
    for (const row of rows) {
      const observation = parseNativeObservation(row, this.binding)
      if (!observation) continue
      if (observation.kind === 'usage') {
        if (this.currentUsage && (observation.value.createdAt < this.currentUsage.createdAt
          || JSON.stringify(observation.value) === JSON.stringify(this.currentUsage))) continue
        this.currentUsage = observation.value
        changed = true
      } else {
        if (this.noticesById.has(observation.value.id)) continue
        this.noticesById.set(observation.value.id, observation.value)
        changed = true
      }
    }
    if (!changed) return
    const notices = this.notices.slice(-NativeObservations.noticeLimit)
    this.noticesById.clear()
    for (const notice of notices) this.noticesById.set(notice.id, notice)
    writeDurableJson(this.filename, { version: 1, notices, usage: this.currentUsage })
  }
}
