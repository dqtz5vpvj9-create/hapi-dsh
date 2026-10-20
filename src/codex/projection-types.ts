import { z } from 'zod'

export const deliveryStateSchema = z.enum([
  'dispatching', 'accepted', 'queued', 'invoked', 'indeterminate', 'rejected', 'cancelled',
])

export const deliveryViewSchema = z.object({
  localId: z.string(),
  messageId: z.string(),
  text: z.string(),
  mode: z.enum(['queue', 'steer']),
  state: deliveryStateSchema,
  createdAt: z.number(),
  error: z.string().nullable(),
})
export type DeliveryState = z.infer<typeof deliveryStateSchema>
export type DeliveryView = z.infer<typeof deliveryViewSchema>

export const approvalViewSchema = z.object({
  requestId: z.string(),
  tool: z.string(),
  toolCallId: z.string().nullable(),
  arguments: z.unknown(),
  blocking: z.boolean(),
  createdAt: z.number().nullable(),
  stage: z.enum(['pending', 'submitted', 'indeterminate']),
  error: z.string().nullable(),
})
export type ApprovalView = z.infer<typeof approvalViewSchema>

export const resolvedApprovalSchema = z.object({
  requestId: z.string(),
  status: z.enum(['canceled', 'denied', 'approved', 'resolved']),
  completedAt: z.number().nullable(),
})

export const hapiProjectionSchema = z.object({
  engine: z.literal('codex'),
  hubId: z.string(),
  hapiSessionId: z.string(),
  logicalSessionId: z.string(),
  displayRevision: z.number().int().nonnegative(),
  machineId: z.string().nullable(),
  machineName: z.string().nullable(),
  nativeId: z.string(),
  nativeHome: z.string().nullable(),
  nativeConnection: z.enum(['attached', 'history', 'disconnected']),
  readOnly: z.boolean(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  /** The source's currently actionable native plan, independent of tool approvals. */
  planId: z.string().nullable().default(null),
  execution: z.object({
    owner: z.string(),
    generation: z.string(),
    sequence: z.number(),
    status: z.enum(['active', 'idle', 'notLoaded', 'systemError', 'disconnected']),
    waitingOn: z.array(z.enum(['approval', 'input'])),
    compacting: z.boolean().optional(),
    turnId: z.string().nullable(),
    startedAt: z.number().nullable(),
    completedAt: z.number().nullable(),
  }).nullable(),
  pendingRequests: z.array(approvalViewSchema),
  resolvedRequests: z.array(resolvedApprovalSchema),
  delivery: z.array(deliveryViewSchema),
  error: z.string().nullable(),
}).nullable()

/** Client-safe whole-value snapshot carried through DSH's standard projections. */
export type HapiProjection = z.infer<typeof hapiProjectionSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { hapi: HapiProjection }
  interface SessionProjectionMap { hapi: HapiProjection }
}
