import { z } from 'zod'

/** HAPI 0f8ef697 shared/schemas.ts DshSubagent, not a fabricated native thread. */
export const sourceDshChildDescriptorSchema = z.object({
  sessionId: z.string().min(1), label: z.string().optional(), name: z.string().optional(),
  mode: z.enum(['one-shot', 'continuable', 'external', 'unknown']),
  activity: z.enum(['running', 'inactive']), createdAt: z.number().finite(),
  settledMs: z.number().nonnegative().optional(), openSince: z.number().nonnegative().optional(),
  lastTurnCompleted: z.boolean().optional(), provider: z.string().optional(),
  teamStatus: z.enum(['running', 'inactive', 'provisioning', 'failed']).optional(),
})
export type SourceDshChildDescriptor = z.infer<typeof sourceDshChildDescriptorSchema>

/** Pinned shared/apiTypes.ts neutral transcript. Attachments are not in this protocol. */
export const sourceDshChildMessageSchema = z.object({
  id: z.string().min(1), role: z.enum(['user', 'assistant', 'tool']), text: z.string(), createdAt: z.number().finite(),
  kind: z.enum(['message', 'reasoning', 'tool-call', 'tool-result']).optional(),
  callId: z.string().optional(), toolName: z.string().optional(),
  input: z.json().optional(), output: z.json().optional(), isError: z.boolean().optional(), truncated: z.boolean().optional(),
})
export type SourceDshChildMessage = z.infer<typeof sourceDshChildMessageSchema>
export const sourceDshChildPageSchema = z.object({
  sessionId: z.string(), messages: z.array(sourceDshChildMessageSchema),
  before: z.number().int().nonnegative().nullable(), hasMore: z.boolean(),
  after: z.number().int().nonnegative().optional(), epoch: z.string().optional(),
  hasLater: z.boolean().optional(), reset: z.boolean().optional(), truncated: z.boolean().optional(),
})
export type SourceDshChildPage = z.infer<typeof sourceDshChildPageSchema>

/** Explicit browser command identity, distinct from the official default sink. */
export const sourceDshChildCommandIdSchema = z.string().regex(/^hapi-source-child:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

export const sourceDshChildReceiptSchema = z.object({
  operationId: z.string().min(1).max(128), kind: z.enum(['prompt', 'interrupt']),
  requestId: z.string().nullable(), displayMessageId: z.string().nullable(),
  /** Local command correlation only; the original source history does not carry it. */
  clientRequestId: sourceDshChildCommandIdSchema.optional(),
  text: z.string().nullable(), delivery: z.enum(['queue', 'steer']).nullable(),
  status: z.enum(['prepared', 'dispatching', 'accepted', 'rejected', 'unknown']),
  sourceMessageId: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(), error: z.string().nullable(),
})
export type SourceDshChildReceipt = z.infer<typeof sourceDshChildReceiptSchema>

export const sourceDshChildStateSchema = z.object({
  sessionId: z.string(), logicalSessionId: z.string(), parentSessionId: z.string(),
  hubId: z.string(), sourceSessionId: z.string(), parentDshSessionId: z.string(), childDshSessionId: z.string(), machineId: z.string(),
  descriptor: sourceDshChildDescriptorSchema, readOnly: z.boolean(), unavailableReason: z.string().nullable(),
  history: z.object({ epoch: z.string().nullable(), after: z.number().int().nonnegative(), loaded: z.number().int().nonnegative(),
    complete: z.boolean(), truncated: z.boolean(), lastReadAt: z.number().nullable(), error: z.string().nullable() }),
  receipts: z.array(sourceDshChildReceiptSchema),
})
export type SourceDshChildState = z.infer<typeof sourceDshChildStateSchema>

export const sourceDshChildReadSchema = z.object({ sessionId: z.string().min(1).max(512) })
export type SourceDshChildRead = z.infer<typeof sourceDshChildReadSchema>
export const sourceDshChildInterruptSchema = sourceDshChildReadSchema.extend({ operationId: z.string().min(1).max(128) })
export type SourceDshChildInterrupt = z.infer<typeof sourceDshChildInterruptSchema>

/** Host-only binding schemas live here because they contain no services or credentials. */
export const sourceDshChildBindingSchema = z.object({
  hubId: z.string(), namespace: z.string(), sourceSessionId: z.string(), parentDshSessionId: z.string(),
  childDshSessionId: z.string(), childCreatedAt: z.number(), machineId: z.string(),
})
export type SourceDshChildBinding = z.infer<typeof sourceDshChildBindingSchema>
