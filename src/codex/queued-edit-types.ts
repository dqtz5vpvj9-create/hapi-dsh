import { z } from 'zod'

/** Source row facts captured before cancellation; no replacement message is sent. */
export const sourceQueuedEditCandidateSchema = z.object({
  localId: z.string().min(1).max(2048), messageId: z.string().min(1).max(2048),
  text: z.string().max(2_000_000), attachmentNames: z.array(z.string().max(4096)).max(256),
  scheduledAt: z.number().int().positive().nullable(), createdAt: z.number().finite(),
  delivery: z.enum(['queued', 'indeterminate']),
})
export type SourceQueuedEditCandidate = z.infer<typeof sourceQueuedEditCandidateSchema>
export const sourceQueuedEditRequestSchema = z.object({
  sessionId: z.string().min(1).max(512), operationId: z.string().uuid(), localId: z.string().min(1).max(2048),
})
export type SourceQueuedEditRequest = z.infer<typeof sourceQueuedEditRequestSchema>
export const sourceQueuedEditReadSchema = sourceQueuedEditRequestSchema.omit({ localId: true })
export type SourceQueuedEditRead = z.infer<typeof sourceQueuedEditReadSchema>
export const sourceQueuedEditReceiptSchema = z.object({
  operationId: z.string().uuid(), sessionId: z.string(), logicalSessionId: z.string(),
  hubId: z.string(), sourceSessionId: z.string(), candidate: sourceQueuedEditCandidateSchema,
  status: z.enum(['submitting', 'cancelled', 'busy', 'invoked', 'rejected', 'unknown']),
  proof: z.enum(['source-reply', 'source-event', 'source-invoked-read']).nullable(),
  createdAt: z.number(), updatedAt: z.number(), error: z.string().nullable(),
})
export type SourceQueuedEditReceipt = z.infer<typeof sourceQueuedEditReceiptSchema>
export const sourceQueuedEditReceiptsSchema = z.array(sourceQueuedEditReceiptSchema)

/** Match the original UI: retained attachment references precede the body. */
export function queuedEditRestoreText(candidate: Pick<SourceQueuedEditCandidate, 'text' | 'attachmentNames'>): string {
  return candidate.text || candidate.attachmentNames.join(', ')
}
export function queuedEditRestoreSchedule(candidate: Pick<SourceQueuedEditCandidate, 'scheduledAt'>, now: number): number | null {
  return candidate.scheduledAt !== null && candidate.scheduledAt > now ? candidate.scheduledAt : null
}
