import { z } from 'zod'

/** A child owned by a source task, never a second HAPI root session. */
export const observedSidechainSchema = z.object({
  scopeId: z.string(), kind: z.enum(['sdk', 'agent-run', 'dsh-child']),
  parentToolCallId: z.string().nullable(), sourceAgentId: z.string().nullable(),
  parentSessionId: z.string(), rootSessionId: z.string(),
  label: z.string(), status: z.enum(['observed', 'running', 'completed', 'error', 'aborted']),
  createdAt: z.number(), updatedAt: z.number(),
})
export const observedSidechainSummarySchema = observedSidechainSchema.extend({
  sessionId: z.string(), logicalSessionId: z.string(),
})
export type ObservedSidechain = z.infer<typeof observedSidechainSchema>
export type ObservedSidechainSummary = z.infer<typeof observedSidechainSummarySchema>
