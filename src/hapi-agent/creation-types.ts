import { z } from 'zod'

/** Pinned HAPI creatable flavors; native Codex keeps its stricter creation path. */
export const SOURCE_CREATION_FLAVORS = ['agy', 'claude', 'dsh', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'pi', 'qoder'] as const
export type SourceCreationFlavor = typeof SOURCE_CREATION_FLAVORS[number]

export const SOURCE_LAUNCH_PERMISSION_MODES: Record<SourceCreationFlavor, readonly string[]> = {
  agy: ['request-review', 'always-proceed'],
  claude: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
  dsh: ['default', 'read-only', 'yolo'],
  copilot: ['default', 'read-only', 'safe-yolo', 'yolo'],
  cursor: ['default', 'plan', 'ask', 'debug', 'autoReview', 'yolo'],
  grok: ['default', 'auto', 'plan', 'bypassPermissions'],
  kimi: ['default', 'read-only', 'safe-yolo', 'yolo'],
  opencode: ['default', 'plan', 'yolo'],
  pi: [],
  qoder: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
}

const requestId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
const id = z.string().min(1).max(512)

/** The exact immutable Runner request. Models are source IDs, never aliases to another engine. */
export const createSourceSessionSchema = z.strictObject({
  requestId, machineId: id, directory: z.string().trim().min(1).max(4096),
  agent: z.enum(SOURCE_CREATION_FLAVORS),
  model: z.string().min(1).max(1024).optional(), effort: z.string().min(1).max(128).optional(),
  modelReasoningEffort: z.string().min(1).max(128).optional(),
  yolo: z.boolean().optional(), permissionMode: z.string().min(1).max(64).optional(),
  copilotAgentMode: z.enum(['interactive', 'plan', 'autopilot']).optional(),
  startingMode: z.enum(['remote', 'pty']).optional(),
  sessionType: z.enum(['simple', 'worktree']).optional(), worktreeName: z.string().max(200).optional(),
}).superRefine((value, ctx) => {
  const invalid = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
  if (value.startingMode === 'pty' && ['agy', 'dsh', 'qoder'].includes(value.agent)) invalid('startingMode', 'This source engine only supports remote mode')
  if (value.permissionMode && !SOURCE_LAUNCH_PERMISSION_MODES[value.agent].includes(value.permissionMode)) invalid('permissionMode', 'This source engine does not support the requested permission mode')
  if (value.agent === 'pi' && value.yolo) invalid('yolo', 'Pi owns approval policy and does not accept a Yolo launch setting')
  if (value.effort && !['claude', 'grok', 'pi', 'agy', 'dsh', 'qoder'].includes(value.agent)) invalid('effort', 'This source launcher does not accept effort')
  if (value.modelReasoningEffort && !['opencode', 'dsh'].includes(value.agent)) invalid('modelReasoningEffort', 'This source launcher does not accept model reasoning effort')
  if (value.copilotAgentMode && value.agent !== 'copilot') invalid('copilotAgentMode', 'Copilot mode belongs to Copilot sessions')
  if (value.worktreeName && value.sessionType !== 'worktree') invalid('worktreeName', 'A worktree name requires a worktree session')
})
export type CreateSourceSession = z.infer<typeof createSourceSessionSchema>

export const sourceCreationStateSchema = z.object({
  requestId, request: createSourceSessionSchema,
  status: z.enum(['submitting', 'accepted', 'indeterminate', 'ready', 'rejected']),
  sourceSessionId: id.nullable(), nativeId: id.nullable(), sessionId: id.nullable(),
  /** First observation of actual Runner registration, not a Hub preallocated stub. */
  registrationObservedAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  message: z.string().nullable(), sourceCode: z.string().nullable(),
})
export type SourceCreationState = z.infer<typeof sourceCreationStateSchema>

/** Read never dispatches. Explicit reconcile can recover the identical source durable claim. */
export const sourceCreationOperationSchema = z.strictObject({ requestId, action: z.enum(['read', 'reconcile']) })
export type SourceCreationOperation = z.infer<typeof sourceCreationOperationSchema>
