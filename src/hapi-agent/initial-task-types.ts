/** Browser-safe initial task delivery, after the original HAPI launch is ready. */
import { z } from 'zod'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { deliveryStateSchema, deliveryViewSchema } from '../codex/projection-types.js'

const id = z.string().min(1).max(512)
const creationRequestId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
const operationId = z.string().uuid()
export const sourceInitialTaskAttachmentSchema = z.discriminatedUnion('type', [
  // A public DSH upload receipt, scoped to the exact receiving Session.
  z.strictObject({ type: z.literal('file'), receiptId: z.string().min(1).max(512) }),
  z.strictObject({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().max(44_739_244), name: z.string().max(1024).optional() }),
])
export const sourceInitialTaskSchema = z.strictObject({
  sessionId: id, operationId, creationRequestId,
  text: z.string(), attachments: z.array(sourceInitialTaskAttachmentSchema).default([]),
}).superRefine((value, ctx) => {
  if (!value.text.trim() && !value.attachments.length) ctx.addIssue({ code: 'custom', path: ['text'], message: 'The first task needs text or an attachment' })
})
export type SourceInitialTask = z.infer<typeof sourceInitialTaskSchema>
export const sourceInitialTaskReadSchema = z.strictObject({ operationId })
export type SourceInitialTaskRead = z.infer<typeof sourceInitialTaskReadSchema>
export const sourceInitialTasksSchema = z.strictObject({ creationRequestId: creationRequestId.optional() })
export type SourceInitialTasks = z.infer<typeof sourceInitialTasksSchema>

export const sourceInitialTaskReceiptSchema = z.object({
  operationId, creationRequestId, sourceSessionId: id, logicalSessionId: id, sessionId: id.nullable(),
  flavor: z.string(), nativeId: z.string().nullable(),
  localId: id, messageId: id,
  status: z.union([z.literal('prepared'), deliveryStateSchema]),
  text: z.string(), attachments: z.array(z.object({
    type: z.enum(['file', 'image']), name: z.string(), bytes: z.number().int().nonnegative(), mediaType: z.string().optional(),
  })),
  delivery: deliveryViewSchema.nullable(), sourceConfirmed: z.boolean(), sourceAvailable: z.boolean(), canRetry: z.boolean(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), message: z.string().nullable(),
})
export type SourceInitialTaskReceipt = z.infer<typeof sourceInitialTaskReceiptSchema>

export interface SourceInitialTaskApi {
  sourceInitialTask(request: SourceInitialTask): Promise<RemoteResult<SourceInitialTaskReceipt>>
  sourceInitialTaskRead(request: SourceInitialTaskRead): Promise<RemoteResult<SourceInitialTaskReceipt | null>>
  /** Only an explicitly unsubmitted or source-rejected delivery can retry, with the same original bytes and IDs. */
  sourceInitialTaskRetry(request: SourceInitialTaskRead): Promise<RemoteResult<SourceInitialTaskReceipt>>
  sourceInitialTasks(request: SourceInitialTasks): Promise<RemoteResult<SourceInitialTaskReceipt[]>>
}
export const sourceInitialTaskInputs = {
  sourceInitialTask: sourceInitialTaskSchema, sourceInitialTaskRead: sourceInitialTaskReadSchema,
  sourceInitialTaskRetry: sourceInitialTaskReadSchema, sourceInitialTasks: sourceInitialTasksSchema,
}
export const sourceInitialTaskOutputs = {
  sourceInitialTask: sourceInitialTaskReceiptSchema, sourceInitialTaskRead: sourceInitialTaskReceiptSchema.nullable(),
  sourceInitialTaskRetry: sourceInitialTaskReceiptSchema, sourceInitialTasks: z.array(sourceInitialTaskReceiptSchema),
}
