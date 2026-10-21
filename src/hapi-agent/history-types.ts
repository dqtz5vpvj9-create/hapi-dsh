/** HAPI-owned Pi import and native migrations. Safe for the official DSH client. */
import { z } from 'zod'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

const id = z.string().min(1).max(512)
const operationId = z.string().uuid()
export const piImportStateSchema = z.object({
  state: z.enum(['importing', 'complete', 'failed', 'diverged']), machineId: z.string(), piSessionId: z.string(),
  sourceFile: z.string(), startedAt: z.number().finite(), updatedAt: z.number().finite(),
  leafEntryId: z.string().nullable().optional(), error: z.string().optional(),
})
export const piHistoryEntrySchema = z.object({
  id, title: z.string(), lastUserMessage: z.string().nullable().optional(), cwd: z.string().nullable().optional(),
  file: z.string().min(1), modifiedAt: z.number().finite(), model: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(), leafEntryId: z.string().nullable().optional(),
  messageCount: z.number().int().nonnegative(), hapiSessionId: z.string().optional(),
  /** Current official DSH display, resolved locally from the exact imported Pi identity. */
  displaySessionId: id.nullable().optional(),
  importState: z.enum(['importing', 'complete', 'failed', 'diverged']).optional(),
})
export type PiHistoryEntry = z.infer<typeof piHistoryEntrySchema>
export const sourceHistoryPiSchema = z.strictObject({ machineId: id, cwd: z.string().max(8192).optional() })
export type SourceHistoryPi = z.infer<typeof sourceHistoryPiSchema>

export const sourceHistoryActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pi-import'), machineId: id, piSessionIds: z.array(id).min(1).max(200),
    cwd: z.string().max(8192).optional(), connect: z.boolean().default(false),
  }).refine(value => !value.connect || value.piSessionIds.length === 1, 'Continue selects exactly one existing Pi history'),
  z.strictObject({ kind: z.literal('codex-home'), sessionId: id, targetHomeId: z.string().min(1).max(128),
    targetProvider: z.string().min(1).max(128).optional(), targetModel: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({ kind: z.literal('cursor-acp'), sessionId: id, keepSource: z.boolean().default(true),
    forceArchiveRunning: z.boolean().default(false), skipVerify: z.boolean().default(false),
  }),
])
export type SourceHistoryAction = z.infer<typeof sourceHistoryActionSchema>
export const sourceHistoryOperationSchema = z.strictObject({ operationId, action: sourceHistoryActionSchema })
export type SourceHistoryOperation = z.infer<typeof sourceHistoryOperationSchema>
export const sourceHistoryReadSchema = z.strictObject({ operationId })
export type SourceHistoryRead = z.infer<typeof sourceHistoryReadSchema>
export const sourceHistoryToolsRequestSchema = z.strictObject({ sessionId: id })

export const cursorMigrationRefusalSchema = z.enum(['not_cursor_session', 'already_acp', 'running_refused', 'no_cursor_session_id',
  'no_legacy_store_on_disk', 'target_already_exists', 'verify_load_failed', 'verify_prompt_failed', 'metadata_write_failed',
  'archive_failed', 'lock_release_timeout', 'acp_transport_active', 'session_resumed_during_migrate',
  'legacy_store_modified_during_migrate', 'cross_host_session', 'ambiguous_legacy_store', 'size_mismatch', 'internal_error'])
export const cursorMigrationOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sessionId: z.string(), acpSessionId: z.string(), replayNotifications: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(), lastUsedModelPreserved: z.string().nullable(), sourceRemoved: z.boolean() }),
  z.object({ ok: z.literal(false), sessionId: z.string(), reason: cursorMigrationRefusalSchema, message: z.string(), durationMs: z.number().nonnegative() }),
])
export const codexMigrationOutcomeSchema = z.object({ success: z.boolean(), threadId: z.string().optional(), journalPath: z.string().optional(),
  warnings: z.array(z.string()).optional(), error: z.string().optional() })
export const sourceMigrationProgressSchema = z.object({ id: z.string(), sourceHome: z.string(), targetHome: z.string(), startedAt: z.number().finite() })
export const sourceHistoryHomeSchema = z.object({ id: z.string().min(1).max(128), label: z.string(), path: z.string(), official: z.boolean().optional() })

export const sourceHistoryItemSchema = z.object({
  piSessionId: id, sourceSessionId: id.nullable(), sessionId: id.nullable(),
  action: z.enum(['created', 'updated', 'unchanged']).nullable(), appended: z.number().int().nonnegative().nullable(),
  importState: piImportStateSchema.nullable(), active: z.boolean(),
  confirmation: z.enum(['none', 'response', 'metadata']),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export const sourceHistoryObservationSchema = z.object({
  sourceSessionId: id, sessionId: id.nullable(), nativeId: id.nullable(), active: z.boolean(),
  codexHome: z.string().nullable(), cursorProtocol: z.enum(['acp', 'stream-json']).nullable(),
  migrationInProgress: sourceMigrationProgressSchema.nullable(), targetObserved: z.boolean(),
})
export const sourceHistoryReceiptSchema = z.object({
  operationId, action: sourceHistoryActionSchema, scope: z.string(),
  status: z.enum(['submitting', 'ready-to-connect', 'submitted', 'confirmed', 'rejected', 'failed', 'indeterminate']),
  phase: z.enum(['preflight', 'import', 'connect', 'migration', 'complete']),
  sourceSessionId: id.nullable(), sessionId: id.nullable(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), message: z.string().nullable(),
  canContinue: z.boolean(), items: z.array(sourceHistoryItemSchema),
  cursorResult: cursorMigrationOutcomeSchema.nullable(), codexResult: codexMigrationOutcomeSchema.nullable(),
  observation: sourceHistoryObservationSchema.nullable(),
})
export type SourceHistoryReceipt = z.infer<typeof sourceHistoryReceiptSchema>
export const sourceHistoryPiResultSchema = z.object({ machineId: id, sessions: z.array(piHistoryEntrySchema), operations: z.array(sourceHistoryReceiptSchema) })
export type SourceHistoryPiResult = z.infer<typeof sourceHistoryPiResultSchema>
export const sourceHistoryToolsSchema = z.object({
  sessionId: id, sourceSessionId: id, machineId: id.nullable(), flavor: z.string(), nativeId: id.nullable(), active: z.boolean(),
  pi: z.object({ canSync: z.boolean(), importState: piImportStateSchema.nullable() }).nullable(),
  codex: z.object({ canMigrate: z.boolean(), sourceHome: z.string().nullable(), homes: z.array(sourceHistoryHomeSchema),
    migrationInProgress: sourceMigrationProgressSchema.nullable() }).nullable(),
  cursor: z.object({ canMigrate: z.boolean(), protocol: z.enum(['acp', 'stream-json']).nullable(),
    state: z.enum(['in_progress', 'ambiguous']).nullable(), hubLocalOnly: z.literal(true) }).nullable(),
  operations: z.array(sourceHistoryReceiptSchema),
})
export type SourceHistoryTools = z.infer<typeof sourceHistoryToolsSchema>

export interface SourceHistoryApi {
  sourceHistoryPi(request: SourceHistoryPi): Promise<RemoteResult<SourceHistoryPiResult>>
  sourceHistoryTools(request: { sessionId: string }): Promise<RemoteResult<SourceHistoryTools>>
  sourceHistoryOperation(request: SourceHistoryOperation): Promise<RemoteResult<SourceHistoryReceipt>>
  sourceHistoryOperationRead(request: SourceHistoryRead): Promise<RemoteResult<SourceHistoryReceipt | null>>
  /** Continues an imported Pi history only when its original reopen has never been dispatched. */
  sourceHistoryContinue(request: SourceHistoryRead): Promise<RemoteResult<SourceHistoryReceipt>>
}
export const sourceHistoryInputs = {
  sourceHistoryPi: sourceHistoryPiSchema, sourceHistoryTools: sourceHistoryToolsRequestSchema,
  sourceHistoryOperation: sourceHistoryOperationSchema, sourceHistoryOperationRead: sourceHistoryReadSchema, sourceHistoryContinue: sourceHistoryReadSchema,
}
export const sourceHistoryOutputs = {
  sourceHistoryPi: sourceHistoryPiResultSchema, sourceHistoryTools: sourceHistoryToolsSchema,
  sourceHistoryOperation: sourceHistoryReceiptSchema, sourceHistoryOperationRead: sourceHistoryReceiptSchema.nullable(), sourceHistoryContinue: sourceHistoryReceiptSchema,
}
