/** Browser-safe observations from HAPI's native Codex source, never inferred execution. */
import { z } from 'zod'

/** HAPI shared/src/schemas.ts ThreadGoalSchema at 0f8ef697. */
export const nativeThreadGoalSchema = z.object({
  threadId: z.string(), objective: z.string(),
  status: z.enum(['active', 'paused', 'budgetLimited', 'complete', 'blocked', 'usageLimited']),
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number().default(0), timeUsedSeconds: z.number().default(0),
  createdAt: z.number().default(0), updatedAt: z.number().default(0),
})
export type NativeThreadGoal = z.infer<typeof nativeThreadGoalSchema>

export const nativeNoticeSchema = z.object({
  id: z.string().min(1), createdAt: z.number().finite(),
  kind: z.enum(['message', 'error', 'context-compacted', 'compact-summary']),
  text: z.string(), details: z.string().optional(), turnId: z.string().nullable(),
})
export type NativeNotice = z.infer<typeof nativeNoticeSchema>

export const nativeTokenCountSchema = z.object({
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
})
export const nativeUsageSchema = nativeTokenCountSchema.extend({
  id: z.string().min(1), createdAt: z.number().finite(),
  threadId: z.string(), turnId: z.string().nullable(), model: z.string().nullable(),
  // Codex inputTokens already includes cachedInputTokens. These are not added together.
  contextTokens: z.number().int().nonnegative(), contextWindow: z.number().int().positive().nullable(),
  total: nativeTokenCountSchema.nullable(),
})
export type NativeUsage = z.infer<typeof nativeUsageSchema>

/** Original Runner owns retry scheduling; this is observation only. */
export const capacityRecoverySchema = z.object({
  turnId: z.string(), phase: z.enum(['retrying', 'failed', 'waiting', 'continuing']),
  retryAt: z.number().finite().optional(), attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(), reason: z.enum(['exhausted', 'unverified', 'unconfirmed']).optional(),
})
export type CapacityRecovery = z.infer<typeof capacityRecoverySchema>
