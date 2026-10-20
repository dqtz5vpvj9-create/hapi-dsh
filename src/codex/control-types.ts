/** Browser-safe native control contracts, matching pinned HAPI public routes. */
import { z } from 'zod'

const id = z.string().min(1).max(512)
const operationId = z.string().uuid()
const sessionRequest = z.strictObject({ sessionId: id })

export const nativeSettingChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('model'), value: z.string().trim().min(1).max(256) }),
  z.strictObject({ kind: z.literal('reasoningEffort'), value: z.string().trim().min(1).max(64).nullable() }),
  // HAPI's shared Codex runtime explicitly rejects legacy safe-yolo.
  z.strictObject({ kind: z.literal('permissionMode'), value: z.enum(['default', 'read-only', 'yolo']) }),
  z.strictObject({ kind: z.literal('collaborationMode'), value: z.enum(['default', 'plan']) }),
  z.strictObject({ kind: z.literal('serviceTier'), value: z.enum(['fast', 'standard']) }),
])
export type NativeSettingChange = z.infer<typeof nativeSettingChangeSchema>
export const nativeSettingsValuesSchema = z.object({
  model: z.string().nullable(), reasoningEffort: z.string().nullable(),
  permissionMode: z.string().nullable(), collaborationMode: z.enum(['default', 'plan']).nullable(),
  serviceTier: z.string().nullable(),
})
export type NativeSettingsValues = z.infer<typeof nativeSettingsValuesSchema>
export const nativeSettingReceiptSchema = z.object({
  operationId, change: nativeSettingChangeSchema, createdAt: z.number().int().nonnegative(),
  status: z.enum(['submitting', 'confirmed', 'observed', 'indeterminate', 'rejected']),
  message: z.string().nullable(), observed: nativeSettingsValuesSchema.nullable(),
})
export type NativeSettingReceipt = z.infer<typeof nativeSettingReceiptSchema>
export const nativeSettingsSchema = z.object({
  values: nativeSettingsValuesSchema,
  models: z.array(z.object({
    id: id, name: z.string(), isDefault: z.boolean(), reasoningEfforts: z.array(z.string()),
    defaultReasoningEffort: z.string().nullable(), serviceTiers: z.array(z.string()),
  })),
  readOnly: z.boolean(), warnings: z.array(z.string()), operations: z.array(nativeSettingReceiptSchema),
})
export type NativeSettings = z.infer<typeof nativeSettingsSchema>
export const nativeApplySettingSchema = sessionRequest.extend({ operationId, change: nativeSettingChangeSchema })
export type NativeApplySetting = z.infer<typeof nativeApplySettingSchema>

export const nativeForkBoundarySchema = z.strictObject({ threadId: id, turnId: id, itemId: id })
export type NativeForkBoundary = z.infer<typeof nativeForkBoundarySchema>
const forkBase = z.object({
  operationId, duplicateRiskOf: operationId.optional(), sourceSessionId: id, childSessionId: id,
  sourceRevision: z.number().int().positive(), code: z.string().min(1).optional(), message: z.string(),
  updatedAt: z.number().int().nonnegative(),
})
export const nativeForkReceiptSchema = z.discriminatedUnion('status', [
  forkBase.extend({ status: z.literal('running') }),
  forkBase.extend({ status: z.literal('indeterminate') }),
  forkBase.extend({ status: z.literal('rejected'), rejectionProof: z.literal('not_dispatched') }),
  forkBase.extend({ status: z.literal('created'), nativeThreadId: id, binding: z.enum(['pending', 'ready', 'blocked']) }),
])
export type NativeForkReceipt = z.infer<typeof nativeForkReceiptSchema>
export const nativeForkSourceSchema = z.object({
  revision: z.number().int().nonnegative(), operation: nativeForkReceiptSchema.optional(),
  blockingSourceSessionId: id.optional(), message: z.string().optional(),
})
export type NativeForkSource = z.infer<typeof nativeForkSourceSchema>
export const nativeForkSourceResponseSchema = z.object({ operation: nativeForkReceiptSchema, sessionId: id.optional() })

export const nativeForkRequestSchema = sessionRequest.extend({
  operationId, expectedForkRevision: z.number().int().nonnegative(), duplicateRiskOf: operationId.optional(),
  messageLocalId: id.optional(), nativeBoundary: nativeForkBoundarySchema.optional(), displayMessageId: id.optional(),
}).refine(value => [value.messageLocalId, value.nativeBoundary, value.displayMessageId].filter(part => part !== undefined).length <= 1,
  'Choose one native fork boundary')
  .refine(value => value.duplicateRiskOf === undefined || value.duplicateRiskOf !== value.operationId, 'A duplicate-risk request needs a different operation ID')
  .refine(value => value.duplicateRiskOf === undefined || value.messageLocalId === undefined && value.nativeBoundary === undefined && value.displayMessageId === undefined,
    'A duplicate-risk request inherits the original boundary from HAPI')
export type NativeForkRequest = z.infer<typeof nativeForkRequestSchema>
export const nativeForkOperationRequestSchema = sessionRequest.extend({ operationId, action: z.enum(['read', 'reconcile']) })
export type NativeForkOperationRequest = z.infer<typeof nativeForkOperationRequestSchema>
export const nativeForkCloseRequestSchema = sessionRequest.extend({ operationId, expectedForkRevision: z.number().int().nonnegative() })
export type NativeForkCloseRequest = z.infer<typeof nativeForkCloseRequestSchema>

export const nativeForkViewSchema = z.object({
  operationId, submission: z.enum(['submitting', 'acknowledged', 'indeterminate', 'rejected']),
  operation: nativeForkReceiptSchema.nullable(), sessionId: id.nullable(), message: z.string().nullable(),
})
export type NativeForkView = z.infer<typeof nativeForkViewSchema>
export const nativeForkStateSchema = z.object({
  revision: z.number().int().nonnegative(), blockingSourceSessionId: id.nullable(),
  message: z.string().nullable(), operations: z.array(nativeForkViewSchema),
})
export type NativeForkState = z.infer<typeof nativeForkStateSchema>
export const nativeForkCloseResultSchema = z.object({
  view: nativeForkViewSchema, source: nativeForkStateSchema,
  closure: z.enum(['closed', 'already_admitted', 'already_resolved', 'unavailable']), message: z.string().nullable(),
})
export type NativeForkCloseResult = z.infer<typeof nativeForkCloseResultSchema>

export const nativeImplementPlanSchema = sessionRequest.extend({ operationId, planId: id })
export type NativeImplementPlan = z.infer<typeof nativeImplementPlanSchema>
export const nativePlanReceiptSchema = z.object({
  operationId, planId: id, localId: z.string().min(1).max(1024),
  status: z.enum(['submitting', 'submitted', 'queued', 'invoked', 'indeterminate', 'rejected']),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  message: z.string().nullable(), sourceCode: z.string().nullable(),
})
export type NativePlanReceipt = z.infer<typeof nativePlanReceiptSchema>
export const nativePlanStateSchema = z.object({ planId: id.nullable(), readOnly: z.boolean(), operations: z.array(nativePlanReceiptSchema) })
export type NativePlanState = z.infer<typeof nativePlanStateSchema>
