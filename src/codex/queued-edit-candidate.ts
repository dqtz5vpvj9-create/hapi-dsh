import type { HapiMessage } from './contracts.js'
import { envelopeFor, record } from './native.js'
import { sourceQueuedEditCandidateSchema, type SourceQueuedEditCandidate } from './queued-edit-types.js'

/** Read original row payloads, not a shortened display preview or local echo. */
export function queuedEditCandidate(row: HapiMessage, parsedText: string): SourceQueuedEditCandidate | undefined {
  if (!row.localId || row.invokedAt != null || row.deliveryState === 'dispatching') return undefined
  const envelope = envelopeFor(row.content)
  const content = record(envelope?.content)
  if (envelope?.role !== 'user') return undefined
  const attachments = Array.isArray(content?.attachments) ? content.attachments.map(record) : []
  const names = attachments.flatMap(value => typeof value?.filename === 'string' ? [value.filename] : [])
  const text = typeof content?.text === 'string' ? content.text : parsedText
  const candidate = sourceQueuedEditCandidateSchema.safeParse({ localId: row.localId, messageId: row.id, text,
    attachmentNames: names, scheduledAt: row.scheduledAt ?? null, createdAt: row.createdAt,
    delivery: row.deliveryState === 'indeterminate' ? 'indeterminate' : 'queued' })
  return candidate.success ? candidate.data : undefined
}
