import { z } from 'zod'

const requestId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
const id = z.string().min(1).max(512)

/** One immutable, user-created native launch intent. */
export const createNativeSessionSchema = z.strictObject({
  machineId: id, directory: z.string().trim().min(1).max(4096), requestId,
  model: z.string().min(1).max(256).optional(), modelReasoningEffort: z.string().min(1).max(64).optional(),
  codexHome: z.string().min(1).max(4096).optional(),
  /** Runner-local selectors only. Authentication secrets never cross this contract. */
  codexAccountId: z.string().min(1).max(128).optional(), codexKeyProfileId: z.string().min(1).max(128).optional(),
  permissionMode: z.enum(['default', 'read-only', 'yolo']).optional(),
  collaborationMode: z.enum(['default', 'plan']).optional(), serviceTier: z.enum(['fast', 'standard']).optional(),
  sessionType: z.enum(['simple', 'worktree']).optional(), worktreeName: z.string().max(200).optional(),
})
export type CreateNativeSession = z.infer<typeof createNativeSessionSchema>

export const nativeCreationStateSchema = z.object({
  requestId, request: createNativeSessionSchema,
  status: z.enum(['submitting', 'accepted', 'indeterminate', 'ready', 'rejected']),
  sourceSessionId: id.nullable(), nativeThreadId: id.nullable(), sessionId: id.nullable(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  message: z.string().nullable(), sourceCode: z.string().nullable(),
})
export type NativeCreationState = z.infer<typeof nativeCreationStateSchema>

/** Read never dispatches. Reconcile may recover a lost reply through HAPI's durable claim using the same exact request. */
export const nativeCreationOperationSchema = z.strictObject({ requestId, action: z.enum(['read', 'reconcile']) })
export type NativeCreationOperation = z.infer<typeof nativeCreationOperationSchema>
