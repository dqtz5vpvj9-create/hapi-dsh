/** Browser dispatch policy. The native execution owner still makes the final decision. */
import type { SourceOperation, SourceSession } from '../remote/protocol.ts'
import { sourceIsOffline } from './source-connectivity.ts'
export function operationRefusal(session: SourceSession | undefined, operation: SourceOperation): string | undefined {
  if (!session || sourceIsOffline(session)) return 'Reconnect before controlling the original native operation.'
  if (!session.capabilities[operation.kind]) return `The source does not support ${operation.kind}.`
  if ((operation.kind === 'steer' || operation.kind === 'cancel') && (!operation.turnId || session.activeTurnId !== operation.turnId))
    return 'The original native turn is no longer active. No replacement turn was controlled.'
  if (operation.kind === 'approve' && (!operation.requestId || !session.pendingRequests.some(request => request.id === operation.requestId)))
    return 'The original native approval is no longer available.'
  return undefined
}

/** Native target IDs are only session-local. Derive a bounded primary key from
 * the complete tuple: concatenated native IDs can exceed the unchanged 256-char
 * operationId limit. This is identity derivation, not payload verification. */
export async function sourceControlOperationId(sessionId: string, kind: 'cancel' | 'approve', target: string): Promise<string> {
  const identity = new TextEncoder().encode(JSON.stringify([sessionId, kind, target]))
  const digest = await crypto.subtle.digest('SHA-256', identity)
  return `hhpi-control:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`
}
