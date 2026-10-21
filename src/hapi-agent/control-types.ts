import { z } from 'zod'

export const observedModelValueSchema = z.union([z.string().trim().min(1), z.object({ provider: z.string().trim().min(1), modelId: z.string().trim().min(1) })]).nullable()
export type ObservedModelValue = z.infer<typeof observedModelValueSchema>
export const observedSettingChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), value: observedModelValueSchema }),
  z.object({ kind: z.literal('effort'), value: z.string().trim().min(1).nullable() }),
  z.object({ kind: z.literal('permission'), value: z.string().min(1) }),
  z.object({ kind: z.literal('collaboration'), value: z.enum(['default', 'plan']) }),
  z.object({ kind: z.literal('serviceTier'), value: z.enum(['fast', 'standard']) }),
  z.object({ kind: z.literal('copilotMode'), value: z.enum(['interactive', 'plan', 'autopilot']) }),
  z.object({ kind: z.literal('control'), value: z.literal('remote') }),
])
export type ObservedSettingChange = z.infer<typeof observedSettingChangeSchema>
export const observedApplySettingSchema = z.object({ sessionId: z.string().min(1), operationId: z.string().uuid(), change: observedSettingChangeSchema })
export type ObservedApplySetting = z.infer<typeof observedApplySettingSchema>
export const observedSettingReadSchema = z.object({ sessionId: z.string().min(1), operationId: z.string().uuid() })
export type ObservedSettingRead = z.infer<typeof observedSettingReadSchema>
export const observedSettingReceiptSchema = z.object({
  operationId: z.string().uuid(), sourceSessionId: z.string(), logicalSessionId: z.string(),
  change: observedSettingChangeSchema,
  status: z.enum(['submitting', 'submitted', 'applied', 'rejected', 'indeterminate']),
  createdAt: z.number(), updatedAt: z.number(), message: z.string().nullable(),
})
export type ObservedSettingReceipt = z.infer<typeof observedSettingReceiptSchema>
export const observedSettingsSchema = z.object({
  sessionId: z.string(), sourceSessionId: z.string(), flavor: z.string(), nativeId: z.string().nullable(), readOnly: z.boolean(),
  values: z.object({ model: observedModelValueSchema, effort: z.string().nullable(), permission: z.string().nullable(),
    collaboration: z.enum(['default', 'plan']).nullable(), serviceTier: z.string().nullable(), copilotMode: z.string().nullable(), control: z.enum(['local', 'remote']) }),
  editable: z.object({ model: z.boolean(), effort: z.boolean(), permission: z.boolean(), collaboration: z.boolean(), serviceTier: z.boolean(), copilotMode: z.boolean(), control: z.boolean() }),
  models: z.array(z.object({ value: observedModelValueSchema, label: z.string(), provider: z.string().nullable() })),
  efforts: z.array(z.object({ value: z.string().nullable(), label: z.string() })),
  permissions: z.array(z.string()), serviceTiers: z.array(z.enum(['standard', 'fast'])),
  warnings: z.array(z.string()), receipts: z.array(observedSettingReceiptSchema),
})
export type ObservedSettings = z.infer<typeof observedSettingsSchema>
