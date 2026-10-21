import { z } from 'zod'
import { nativeForkReceiptSchema, nativeForkSourceSchema } from '../codex/control-types.js'

const id = z.string().min(1).max(512)
const operationId = z.string().uuid()
const boundary = { displayMessageId: id.optional(), displayMessageSeq: z.number().int().nonnegative().optional() }
export const sourceActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['archive', 'reopen', 'restart', 'delete', 'clear']) }),
  z.strictObject({ kind: z.literal('resume'), permissionMode: z.string().min(1).max(64).optional() }),
  z.strictObject({ kind: z.literal('summary'), text: z.string().trim().min(1).max(255) }),
  z.strictObject({ kind: z.literal('pin'), mode: z.enum(['none', 'project', 'global']) }),
  z.strictObject({ kind: z.literal('rewind'), ...boundary }).refine(value =>
    (value.displayMessageId === undefined) !== (value.displayMessageSeq === undefined), 'Choose one exact invoked user message boundary'),
  z.strictObject({ kind: z.literal('fork'), ...boundary, duplicateRiskOf: operationId.optional() }).refine(value =>
    value.displayMessageId === undefined || value.displayMessageSeq === undefined, 'Choose one exact invoked user message boundary'),
])
export type SourceAction = z.infer<typeof sourceActionSchema>
export const sourceOperationSchema = z.strictObject({ sessionId: id, operationId, action: sourceActionSchema }).refine(value =>
  value.action.kind !== 'fork' || value.action.duplicateRiskOf !== value.operationId, 'A duplicate-risk fork requires a new operation ID')
export type SourceOperation = z.infer<typeof sourceOperationSchema>
export const sourceOperationReadSchema = z.strictObject({ operationId, action: z.enum(['read', 'reconcile']).optional() })
export type SourceOperationRead = z.infer<typeof sourceOperationReadSchema>

export const sourceOperationReceiptSchema = z.object({
  operationId, sourceSessionId: id, logicalSessionId: id, flavor: z.string(), action: sourceActionSchema,
  status: z.enum(['submitting', 'submitted', 'confirmed', 'rejected', 'indeterminate']),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  message: z.string().nullable(), sourceCode: z.string().nullable(), result: z.json().nullable(),
  /** True only for the source's real shared-Codex fork receipt protocol. */
  canReconcile: z.boolean(), sourceFork: nativeForkReceiptSchema.nullable(),
})
export type SourceOperationReceipt = z.infer<typeof sourceOperationReceiptSchema>

export const sourceSessionToolsSchema = z.object({
  sessionId: id, sourceSessionId: id, nativeId: id.nullable(), flavor: z.string(),
  active: z.boolean(), readOnly: z.boolean(), lifecycleState: z.string().nullable(),
  summary: z.string(), pinMode: z.enum(['none', 'project', 'global']),
  capabilities: z.object({ archive: z.boolean(), reopen: z.boolean(), resume: z.boolean(), restart: z.boolean(),
    delete: z.boolean(), clear: z.boolean(), summary: z.boolean(), pin: z.boolean(),
    forkCurrent: z.boolean(), forkAtMessage: z.boolean(), rewind: z.boolean() }),
  forkSource: nativeForkSourceSchema.nullable(), warnings: z.array(z.string()), operations: z.array(sourceOperationReceiptSchema),
})
export type SourceSessionTools = z.infer<typeof sourceSessionToolsSchema>
