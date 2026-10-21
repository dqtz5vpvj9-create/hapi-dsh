import { z } from 'zod'
import { approvalViewSchema, deliveryViewSchema, resolvedApprovalSchema } from '../codex/projection-types.js'
import { observedSidechainSchema, observedSidechainSummarySchema } from './sidechain-types.js'
import { sourceTeamSchema } from '../source-collaboration-types.js'
import { sourceDshChildStateSchema } from './dsh-child-types.js'
export { observedSidechainSchema, observedSidechainSummarySchema } from './sidechain-types.js'
export type { ObservedSidechain, ObservedSidechainSummary } from './sidechain-types.js'

export const observedNoticeSchema = z.object({
  id: z.string(), createdAt: z.number(), kind: z.enum(['message', 'error', 'compact', 'summary', 'source-event']),
  text: z.string(), details: z.string().optional(), scopeId: z.string().nullable(),
})
export type ObservedNotice = z.infer<typeof observedNoticeSchema>

export const observedUsageSchema = z.object({
  id: z.string(), createdAt: z.number(), model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
  contextTokens: z.number().int().nonnegative(), contextWindow: z.number().positive().nullable(),
})
export type ObservedUsage = z.infer<typeof observedUsageSchema>

export const hapiObservedProjectionSchema = z.object({
  engine: z.literal('hapi'), ownership: z.literal('hapi-runner'), flavor: z.string(),
  hubId: z.string(), hapiSessionId: z.string(), logicalSessionId: z.string(),
  displayRevision: z.number().int().nonnegative(), machineId: z.string().nullable(), machineName: z.string().nullable(),
  nativeId: z.string().nullable(), path: z.string(), active: z.boolean(), thinking: z.boolean(),
  controlledByUser: z.boolean(), connection: z.enum(['connected', 'disconnected']), readOnly: z.boolean(),
  /** Why `readOnly` is set; only `engine-owned` also locks message input. */
  readOnlyReason: z.enum(['engine-owned', 'unavailable', 'fault']).nullable().optional(),
  model: z.string().nullable(), effort: z.string().nullable(), permissionMode: z.string().nullable(),
  capabilities: z.object({
    steer: z.boolean(), switchToRemote: z.boolean(), images: z.boolean(),
    forkCurrent: z.boolean(), forkAtMessage: z.boolean(), rewindToMessage: z.boolean(),
    model: z.boolean(), effort: z.boolean(), permissions: z.boolean(),
  }),
  pendingRequests: z.array(approvalViewSchema), resolvedRequests: z.array(resolvedApprovalSchema),
  delivery: z.array(deliveryViewSchema), notices: z.array(observedNoticeSchema), usage: observedUsageSchema.nullable(),
  sidechain: observedSidechainSchema.optional(), sidechains: z.array(observedSidechainSummarySchema).optional(),
  dshChild: sourceDshChildStateSchema.optional(),
  team: sourceTeamSchema.nullable().optional(), teamRevision: z.number().nullable().optional(), teamError: z.string().nullable().optional(),
  error: z.string().nullable(),
}).nullable()

/** A source-owned HAPI session, distinct from the native Codex projection. */
export type HapiObservedProjection = z.infer<typeof hapiObservedProjectionSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { hapiObserved: HapiObservedProjection }
  interface SessionProjectionMap { hapiObserved: HapiObservedProjection }
}
