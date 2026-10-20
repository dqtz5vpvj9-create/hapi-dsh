import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { HapiMessage, HapiSession } from './contracts.js'

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** JSON object ordering is transport syntax, never native content identity. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) => {
    const object = record(candidate)
    return object ? Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]])) : candidate
  })
}

export function nativeSessionId(hubId: string, hapiSessionId: string): SessionId {
  return SessionId(`hapi-codex-${createHash('sha256').update(JSON.stringify([hubId, hapiSessionId])).digest('hex').slice(0, 32)}`)
}

export interface NativeBinding {
  hubId: string
  hapiSessionId: string
  threadId: string
  home: string | null
  homeId: string | null
  machineId: string | null
}

export function bindingFor(hubId: string, session: HapiSession): NativeBinding {
  const metadata = session.metadata
  if (metadata?.flavor !== 'codex' || metadata.codexNativeSession !== true || !metadata.codexSessionId) {
    throw new Error(`HAPI session ${session.id} is not an identified native Codex thread`)
  }
  return {
    hubId,
    hapiSessionId: session.id,
    threadId: metadata.codexSessionId,
    home: metadata.codexHome ?? null,
    homeId: metadata.codexHomeId ?? null,
    machineId: metadata.machineId ?? null,
  }
}

export function assertBinding(binding: NativeBinding, session: HapiSession): void {
  const current = bindingFor(binding.hubId, session)
  if (current.hapiSessionId !== binding.hapiSessionId || current.threadId !== binding.threadId
    || current.machineId !== binding.machineId || current.home !== binding.home || current.homeId !== binding.homeId) {
    throw new Error('Native Codex thread, machine, or home identity changed; reattach the source session before sending input')
  }
}

export interface NativeExecution {
  threadId: string
  turnId: string
  itemId?: string
  phase?: 'commentary' | 'final_answer'
  turn?: { status: 'inProgress' | 'completed' | 'failed' | 'interrupted'; started: boolean; ended: boolean }
}

function executionFor(value: unknown): NativeExecution | undefined {
  const data = record(value)
  if (!data || typeof data.threadId !== 'string' || typeof data.turnId !== 'string') return undefined
  const turn = record(data.turn)
  const status = turn?.status
  return {
    threadId: data.threadId,
    turnId: data.turnId,
    ...(typeof data.itemId === 'string' ? { itemId: data.itemId } : {}),
    ...(data.phase === 'commentary' || data.phase === 'final_answer' ? { phase: data.phase } : {}),
    ...(turn && (status === 'inProgress' || status === 'completed' || status === 'failed' || status === 'interrupted')
      && typeof turn.started === 'boolean' && typeof turn.ended === 'boolean'
      ? { turn: { status, started: turn.started, ended: turn.ended } }
      : {}),
  }
}

interface NativeBase {
  key: string
  rowId: string
  localId: string | null
  createdAt: number
  execution: NativeExecution | undefined
  fingerprint: string
}

export type NativeRow = NativeBase & (
  | { kind: 'user'; text: string; invoked: boolean; mode: 'queue' | 'steer'; parts: readonly unknown[] }
  | { kind: 'assistant'; text: string; reasoning: boolean; final: boolean }
  | { kind: 'tool-call'; callId: string; name: string; input: unknown }
  | { kind: 'tool-result'; callId: string; output: unknown; isError: boolean }
  | { kind: 'turn' }
  | { kind: 'notice'; text: string }
)

/** Flatten only HAPI's documented transport wrappers, without interpreting arbitrary JSON. */
function envelopeFor(value: unknown): Record<string, unknown> | undefined {
  const direct = record(value)
  if (!direct) return undefined
  if (typeof direct.role === 'string') return direct
  const candidate = record(direct.message) ?? record(record(direct.data)?.message) ?? record(record(direct.payload)?.message)
  return candidate && typeof candidate.role === 'string' ? candidate : undefined
}

export function parseNativeRow(row: HapiMessage, binding: NativeBinding): NativeRow | undefined {
  const envelope = envelopeFor(row.content)
  const content = record(envelope?.content)
  if (!envelope || !content) return undefined
  const data = record(content.data)
  // Child traces are separate native threads, never flatten them into the parent.
  if (data?.type === 'agent-run-trace' || data?.type === 'agent-run-update') return undefined
  const execution = executionFor(record(envelope.meta)?.nativeExecution ?? data?.nativeExecution)
  if (execution && execution.threadId !== binding.threadId) {
    throw new Error(`Native message ${row.id} belongs to a different Codex thread`)
  }
  const stable = typeof data?.id === 'string' ? data.id : row.localId ?? row.id
  const base: NativeBase = {
    key: stable,
    rowId: row.id,
    localId: row.localId,
    createdAt: row.createdAt,
    execution,
    fingerprint: '',
  }
  let result: NativeRow | undefined
  if (envelope.role === 'user' && content.type === 'text' && typeof content.text === 'string') {
    result = {
      ...base, kind: 'user', text: content.text,
      // Original TUI input carries nativeExecution even before a mirrored timestamp arrives.
      invoked: execution !== undefined || row.invokedAt != null,
      mode: record(envelope.meta)?.deliveryMode === 'steer' ? 'steer' : 'queue',
      parts: Array.isArray(content.parts) ? content.parts : [],
    }
  } else if (envelope.role === 'agent' && content.type === 'codex' && data) {
    if ((data.type === 'message' || data.type === 'reasoning') && typeof data.message === 'string') {
      result = {
        ...base, kind: 'assistant', text: data.message, reasoning: data.type === 'reasoning',
        // HAPI's cumulative provisional snapshots have no durable localId;
        // item/completed and native history carry the stable key as localId.
        final: row.localId !== null && row.localId === stable && data.live !== true,
      }
    } else if (data.type === 'tool-call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      result = { ...base, kind: 'tool-call', callId: data.callId, name: data.name, input: data.input ?? {} }
    } else if (data.type === 'tool-call-result' && typeof data.callId === 'string') {
      result = { ...base, kind: 'tool-result', callId: data.callId, output: data.output ?? null, isError: data.is_error === true }
    } else if (data.type === 'native-turn' && execution) {
      result = { ...base, kind: 'turn' }
    } else if (data.type === 'error' && typeof data.message === 'string') {
      result = { ...base, kind: 'notice', text: data.message }
    }
  }
  if (!result) return undefined
  // Transport row ids / seqs differ between SSE and native history; neither
  // participates in semantic identity or deduplication.
  result.fingerprint = createHash('sha256').update(canonicalJson({
    ...result, rowId: undefined, createdAt: undefined, localId: undefined, fingerprint: undefined,
    // Lifecycle changes do not change completed item content.
    execution: execution ? { ...execution, turn: undefined } : undefined,
  })).digest('hex')
  return result
}

/** Page-order comparison shared by snapshot loading and reconnect reconciliation. */
export function compareNativeMessages(left: HapiMessage, right: HapiMessage): number {
  return left.createdAt - right.createdAt || (left.seq ?? 0) - (right.seq ?? 0) || left.id.localeCompare(right.id)
}
