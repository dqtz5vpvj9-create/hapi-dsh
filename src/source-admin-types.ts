/** Browser-safe views of the original HAPI administration APIs. */
import { z } from 'zod';
import { sourceBulkOperationSchema, sourceBulkReadSchema, sourceBulkReceiptSchema, type SourceBulkOperation, type SourceBulkReceipt } from './source-bulk-types.ts';
export type { SourceBulkOperation, SourceBulkReceipt } from './source-bulk-types.ts';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { sourceMachineHealthSchema } from './source-machine-types.ts';

const id = z.string().min(1).max(512);
const count = z.number().finite().nonnegative();
export const SOURCE_BACKUP_PATH = '/hapi-dsh/admin/sqlite-backup';
export const sourceHubSettingsSchema = z.object({ sessionSummaryContract: z.boolean(), sessionSummaryInChat: z.boolean() });
export type SourceHubSettings = z.infer<typeof sourceHubSettingsSchema>;
export const sourceAdminMachineSchema = z.object({
    id, displayName: z.string(), host: z.string(), platform: z.string(), version: z.string(),
    online: z.boolean(), lastSeenAt: count, homeDir: z.string().nullable(), workspaceRoots: z.array(z.string()),
    capabilities: z.array(z.string()), restartRecommended: z.boolean(), supervisedRestart: z.boolean(),
    health: sourceMachineHealthSchema.nullable().optional(),
    runner: z.object({ status: z.string(), pid: count.nullable(), startedAt: count.nullable() }).nullable(),
});
export type SourceAdminMachine = z.infer<typeof sourceAdminMachineSchema>;
export const sourceDshBundlesSchema = z.object({
    profile: z.string(), dshHome: z.string(), bundles: z.array(z.string()),
    available: z.array(z.object({ name: z.string(), description: z.string(), enabled: z.boolean(), switchable: z.boolean().default(true) })),
    restartRequired: z.boolean().default(false),
});
export type SourceDshBundles = z.infer<typeof sourceDshBundlesSchema>;
export const sourceStorageSchema = z.object({ path: z.string(), databaseBytes: count, walBytes: count, shmBytes: count, totalBytes: count });
export type SourceStorage = z.infer<typeof sourceStorageSchema>;
const metrics = { inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheCreationTokens: count, totalTokens: count, uncachedTokens: count, requests: count };
export const sourceUsageBucketSchema = z.object({ key: z.string(), ...metrics });
export const sourceUsageSchema = z.object({
    range: z.object({ from: count.nullable(), to: count.nullable() }),
    totals: z.object({ ...metrics, sessions: count }), daily: z.array(sourceUsageBucketSchema),
    byAgent: z.array(sourceUsageBucketSchema), byModel: z.array(sourceUsageBucketSchema), updatedAt: count,
});
export type SourceUsage = z.infer<typeof sourceUsageSchema>;
export const sourceUsageRequestSchema = z.strictObject({ range: z.enum(['7d', '30d', 'all']), timeZone: z.string().min(1).max(100) });
export type SourceUsageRequest = z.infer<typeof sourceUsageRequestSchema>;
export const sourceAdminActionSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('settings'), values: z.strictObject({
        sessionSummaryContract: z.boolean().optional(), sessionSummaryInChat: z.boolean().optional(),
    }).refine(value => value.sessionSummaryContract !== undefined || value.sessionSummaryInChat !== undefined) }),
    z.strictObject({ kind: z.literal('machine-name'), machineId: id, displayName: z.string().trim().max(64) }),
    z.strictObject({ kind: z.literal('restart-runner'), machineId: id }),
    z.strictObject({ kind: z.literal('dsh-bundle'), machineId: id, name: z.string().min(1).max(512), enabled: z.boolean() }),
]);
export type SourceAdminAction = z.infer<typeof sourceAdminActionSchema>;
export const sourceAdminOperationSchema = z.strictObject({ operationId: z.string().uuid(), action: sourceAdminActionSchema });
export type SourceAdminOperation = z.infer<typeof sourceAdminOperationSchema>;
export const sourceAdminReceiptSchema = z.object({
    operationId: z.string().uuid(), hubId: id, action: sourceAdminActionSchema,
    status: z.enum(['submitting', 'confirmed', 'observed', 'rejected', 'indeterminate']),
    createdAt: count, updatedAt: count, message: z.string().nullable(),
    settings: sourceHubSettingsSchema.nullable(), bundles: sourceDshBundlesSchema.nullable(), machine: sourceAdminMachineSchema.nullable(),
});
export type SourceAdminReceipt = z.infer<typeof sourceAdminReceiptSchema>;
export const sourceAdministrationSchema = z.object({
    hubId: id, connected: z.boolean(), machines: z.array(sourceAdminMachineSchema),
    settings: sourceHubSettingsSchema.nullable(), settingsError: z.string().nullable(), operations: z.array(sourceAdminReceiptSchema),
});
export type SourceAdministration = z.infer<typeof sourceAdministrationSchema>;
export interface SourceAdminApi {
    sourceSessionBulk(request: SourceBulkOperation): Promise<RemoteResult<SourceBulkReceipt>>;
    sourceSessionBulkRead(request: { operationId: string }): Promise<RemoteResult<SourceBulkReceipt | null>>;
    sourceSummarySettings(): Promise<RemoteResult<{ hubId: string; sessionSummaryInChat: boolean }>>;
    sourceAdministration(): Promise<RemoteResult<SourceAdministration>>;
    sourceAdminStorage(): Promise<RemoteResult<SourceStorage>>;
    sourceAdminUsage(request: SourceUsageRequest): Promise<RemoteResult<SourceUsage>>;
    sourceAdminBundles(request: { machineId: string }): Promise<RemoteResult<SourceDshBundles>>;
    sourceAdminOperation(request: SourceAdminOperation): Promise<RemoteResult<SourceAdminReceipt>>;
    sourceAdminOperationRead(request: { operationId: string }): Promise<RemoteResult<SourceAdminReceipt | null>>;
}
export const sourceAdminInputs = {
    sourceSessionBulk: sourceBulkOperationSchema, sourceSessionBulkRead: sourceBulkReadSchema,
    sourceAdminUsage: sourceUsageRequestSchema, sourceAdminBundles: z.strictObject({ machineId: id }),
    sourceAdminOperation: sourceAdminOperationSchema, sourceAdminOperationRead: z.strictObject({ operationId: z.string().uuid() }),
};
export const sourceAdminOutputs = {
    sourceSessionBulk: sourceBulkReceiptSchema, sourceSessionBulkRead: sourceBulkReceiptSchema.nullable(),
    sourceSummarySettings: z.object({ hubId: id, sessionSummaryInChat: z.boolean() }),
    sourceAdministration: sourceAdministrationSchema, sourceAdminStorage: sourceStorageSchema, sourceAdminUsage: sourceUsageSchema,
    sourceAdminBundles: sourceDshBundlesSchema, sourceAdminOperation: sourceAdminReceiptSchema, sourceAdminOperationRead: sourceAdminReceiptSchema.nullable(),
};
