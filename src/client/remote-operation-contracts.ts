/** Persistent native user actions share ownership, not the message/PTY retry policy. */
import type { CodexCall, CodexCallResult } from '../remote/codex-access.ts'
import { parseSourceSessionId } from '../remote/protocol.ts'

export type NativeActionKind = 'settings' | 'rename' | 'archive' | 'fork' | 'compact' | 'review' | 'plan' | 'queue' | 'goal'
export type NativeActionPhase = 'prepared' | 'dispatching' | 'confirming' | 'accepted' | 'rejected'
export interface NativeActionOutcome {
  status: CodexCallResult['status']
  message: string
  /** A confirmed source response, never inferred by matching title or configuration. */
  targetNativeId?: string
  resultUnavailable?: true
  /** Native delete replies can succeed without deleting an item that already left. */
  queueDeleted?: boolean
}
export interface NativeActionRecord {
  version: 1
  sessionId: string
  /** Stable UI intent (e.g. settings or the original plan ID), shared by its entry points. */
  intent: string
  kind: NativeActionKind
  request: CodexCall & { operationId: string }
  phase: NativeActionPhase
  createdAt: number
  updatedAt: number
  outcome?: NativeActionOutcome
  /** Last confirmed source state survives a pending or unknown opposite action. */
  previousAcceptedArchive?: { archived: boolean; operationId: string }
}

/** Only an accepted source receipt can advance this local archive projection. */
export function confirmedNativeArchive(record: NativeActionRecord | undefined): { archived: boolean; operationId: string } | undefined {
  if (!record || record.kind !== 'archive') return undefined
  if (record.phase === 'accepted' && (record.request.method === 'thread/archive' || record.request.method === 'thread/unarchive'))
    return { archived: record.request.method === 'thread/archive', operationId: record.request.operationId }
  return record.previousAcceptedArchive
}

/** The transaction ledger adds authenticated account/Host scope to this primary key. */
export function nativeActionKey(sessionId: string, intent: string): string {
  return JSON.stringify(['native-action', sessionId, intent])
}

export function assertNativeActionTarget(record: Pick<NativeActionRecord, 'sessionId' | 'request'>): void {
  const identity = parseSourceSessionId(record.sessionId)
  if (record.request.sourceId !== identity.sourceId || record.request.params?.threadId !== identity.nativeId) {
    throw new Error('The native action belongs to a different source conversation.')
  }
}

/** Claim prepared -> dispatching in one existing ledger transaction before any network write. */
export function claimNativeAction(record: NativeActionRecord, now: number): NativeActionRecord | undefined {
  assertNativeActionTarget(record)
  return record.phase === 'prepared' ? { ...record, phase: 'dispatching', updatedAt: now } : undefined
}

/** Persist only the user-visible outcome and exact new thread identity, not native response bodies. */
export function nativeActionOutcome(request: CodexCall, response: CodexCallResult): NativeActionOutcome {
  const result = response.result
  const thread = result && typeof result === 'object' && 'thread' in result ? result.thread : undefined
  const nativeId = thread && typeof thread === 'object' && 'id' in thread && typeof thread.id === 'string' ? thread.id : undefined
  return { status: response.status, message: response.message,
    ...(request.method === 'thread/fork' && response.status === 'accepted' && nativeId ? { targetNativeId: nativeId } : {}),
    ...(request.method === 'thread/queue/delete' && response.status === 'accepted' && result && typeof result === 'object'
      && 'deleted' in result && typeof result.deleted === 'boolean' ? { queueDeleted: result.deleted } : {}),
    ...(response.resultUnavailable ? { resultUnavailable: true as const } : {}) }
}

/** A missing/unknown receipt never changes a possibly-dispatched action back to prepared. */
export function settleNativeAction(record: NativeActionRecord, response: CodexCallResult, now: number): NativeActionRecord {
  return { ...record, phase: response.status === 'indeterminate' ? 'confirming' : response.status,
    outcome: nativeActionOutcome(record.request, response), updatedAt: now }
}
