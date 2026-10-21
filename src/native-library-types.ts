/** Source-owned native library, lifecycle and account operations. Browser-safe schemas. */
import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { nativeThreadGoalSchema } from './codex/observation-types.ts';

const id = z.string().min(1).max(512);
const operationId = z.string().uuid();
export const nativeLibraryQuerySchema = z.object({ machineId: id.optional(), cwd: z.string().max(8192).optional(),
    search: z.string().max(4000).optional(), cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }).strict();
export type NativeLibraryQuery = z.infer<typeof nativeLibraryQuerySchema>;
export const nativeLibraryEntrySchema = z.object({ id, title: z.string(), lastUserMessage: z.string().nullish(),
    cwd: z.string().nullish(), file: z.string(), modifiedAt: z.number().finite(), originator: z.string().nullish(), cliVersion: z.string().nullish(),
    source: z.string().nullish(), threadSource: z.string().nullish(), forkedFromId: z.string().nullish(),
    connectionState: z.enum(['attached', 'history', 'unavailable']).optional(), connectionError: z.string().optional() });
export const nativeLibrarySchema = z.object({ sessions: z.array(nativeLibraryEntrySchema), machineId: id.nullable(), nextCursor: z.number().int().nonnegative().nullable() });
export type NativeLibrary = z.infer<typeof nativeLibrarySchema>;
export const nativeConnectSchema = z.object({ operationId, threadId: id, machineId: id.optional() }).strict();
export type NativeConnect = z.infer<typeof nativeConnectSchema>;
export const nativeImportSchema = z.object({ operationId, machineId: id.optional(), threadIds: z.array(id).min(1).max(200),
    cwd: z.string().max(8192).optional() }).strict();
export type NativeImport = z.infer<typeof nativeImportSchema>;

export const nativeSourceActionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('goal'), command: z.discriminatedUnion('action', [
        z.object({ action: z.literal('set'), objective: z.string().trim().min(1).refine(value => [...value].length <= 4000) }).strict(),
        z.object({ action: z.enum(['pause', 'resume', 'clear']) }).strict(),
    ]) }).strict(),
    z.object({ kind: z.literal('rewind'), displayMessageId: id.optional(), displayMessageSeq: z.number().int().nonnegative().optional() }).strict()
        .refine(value => (value.displayMessageId === undefined) !== (value.displayMessageSeq === undefined), 'Choose one exact display event identity'),
    z.object({ kind: z.enum(['clear', 'archive', 'reopen', 'restart', 'resume', 'delete']) }).strict(),
    z.object({ kind: z.literal('pin'), mode: z.enum(['none', 'project', 'global']) }).strict(),
    z.object({ kind: z.literal('summary'), text: z.string().trim().min(1).max(255) }).strict(),
    z.object({ kind: z.literal('switch-account'), accountId: id }).strict(),
]);
export type NativeSourceAction = z.infer<typeof nativeSourceActionSchema>;
export const nativeSourceOperationSchema = z.object({ operationId, sessionId: id, action: nativeSourceActionSchema }).strict();
export type NativeSourceOperation = z.infer<typeof nativeSourceOperationSchema>;
export const nativeOperationReceiptSchema = z.object({ operationId, scope: z.string(), action: z.string(),
    status: z.enum(['submitting', 'confirmed', 'rejected', 'indeterminate']), createdAt: z.number(), updatedAt: z.number(),
    message: z.string().nullable(), result: z.json().nullable() });
export type NativeOperationReceipt = z.infer<typeof nativeOperationReceiptSchema>;
export const nativeSessionToolsSchema = z.object({ sessionId: id, sourceSessionId: id, active: z.boolean(), readOnly: z.boolean(),
    canRewind: z.boolean(), canClear: z.boolean(), goal: nativeThreadGoalSchema.nullable(),
    summary: z.string(), pinMode: z.enum(['none', 'project', 'global']), operations: z.array(nativeOperationReceiptSchema) });
export type NativeSessionTools = z.infer<typeof nativeSessionToolsSchema>;

export const nativeHomeSchema = z.object({ id, label: z.string(), path: z.string(), official: z.boolean().optional() });
export const nativeAccountSchema = z.object({ id, label: z.string(), email: z.string().nullable(), chatgptAccountId: z.string(),
    enabled: z.boolean(), updatedAt: z.number(), lastRefreshAt: z.number().nullable() });
export const nativeDeviceLoginSchema = z.object({ id, userCode: z.string(), verificationUrl: z.string().url()
    .refine(value => new URL(value).protocol === 'https:', 'Device login requires HTTPS'),
    expiresAt: z.number(), status: z.enum(['pending', 'completed', 'cancelled', 'expired', 'error']),
    account: nativeAccountSchema.optional(), error: z.string().optional() });
export type NativeDeviceLogin = z.infer<typeof nativeDeviceLoginSchema>;
export const nativeMachineStateSchema = z.object({ machineId: id, homes: z.array(nativeHomeSchema), accounts: z.array(nativeAccountSchema),
    currentAccountId: id.nullable(), warnings: z.array(z.string()), operations: z.array(nativeOperationReceiptSchema) });
export type NativeMachineState = z.infer<typeof nativeMachineStateSchema>;
export const nativeMachineActionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('save-home'), id: id.optional(), label: z.string().trim().min(1).max(120), path: z.string().min(1).max(4096) }).strict(),
    z.object({ kind: z.literal('delete-home'), id }).strict(),
    z.object({ kind: z.literal('import-account'), label: z.string().trim().min(1).max(80).optional() }).strict(),
    z.object({ kind: z.literal('rename-account'), id, label: z.string().trim().min(1).max(80) }).strict(),
    z.object({ kind: z.enum(['delete-account', 'switch-account']), id }).strict(),
    z.object({ kind: z.literal('device-login'), action: z.enum(['start', 'cancel']), id: id.optional(), label: z.string().trim().min(1).max(80).optional() })
        .strict().refine(value => value.action !== 'cancel' || !!value.id, 'Cancel requires the original device login identity'),
]);
export type NativeMachineAction = z.infer<typeof nativeMachineActionSchema>;
export const nativeMachineOperationSchema = z.object({ operationId, machineId: id, action: nativeMachineActionSchema }).strict();
export type NativeMachineOperation = z.infer<typeof nativeMachineOperationSchema>;

export const sourceReadStateSchema = z.object({ version: z.number().int().nonnegative(), seenAt: z.number().finite().nonnegative(), manualUnreadAt: z.number().finite().nonnegative().nullable() });
export type SourceReadState = z.infer<typeof sourceReadStateSchema>;
export const sourceReadStatesSchema = z.record(id, sourceReadStateSchema);
export const sourceReadStateWriteSchema = z.strictObject({ sourceSessionId: id, expectedVersion: z.number().int().nonnegative(), seenAt: z.number().finite().nonnegative(), manualUnreadAt: z.number().finite().nonnegative().nullable() });
export type SourceReadStateWrite = z.infer<typeof sourceReadStateWriteSchema>;

export const nativeLibraryInputs = {
    nativeLibrary: nativeLibraryQuerySchema,
    nativeConnect: nativeConnectSchema,
    nativeImport: nativeImportSchema,
    nativeSessionTools: z.object({ sessionId: id }).strict(),
    nativeSourceOperation: nativeSourceOperationSchema,
    nativeOperation: z.object({ operationId }).strict(),
    nativeMachineState: z.object({ machineId: id }).strict(),
    nativeMachineOperation: nativeMachineOperationSchema,
    nativeDeviceLogin: z.object({ machineId: id, loginId: id }).strict(),
    sourceReadStates: z.strictObject({}),
    sourceReadStateWrite: sourceReadStateWriteSchema,
};
export const nativeLibraryOutputs = {
    nativeLibrary: nativeLibrarySchema, nativeConnect: nativeOperationReceiptSchema, nativeImport: nativeOperationReceiptSchema,
    nativeSessionTools: nativeSessionToolsSchema, nativeSourceOperation: nativeOperationReceiptSchema, nativeOperation: nativeOperationReceiptSchema,
    nativeMachineState: nativeMachineStateSchema, nativeMachineOperation: nativeOperationReceiptSchema,
    nativeDeviceLogin: nativeDeviceLoginSchema,
    sourceReadStates: sourceReadStatesSchema,
    sourceReadStateWrite: z.object({ applied: z.boolean(), state: sourceReadStateSchema }),
};
export type NativeLibraryMethod = keyof typeof nativeLibraryInputs;
export type NativeLibraryRequest<K extends NativeLibraryMethod> = z.infer<(typeof nativeLibraryInputs)[K]>;
export type NativeLibraryResponse<K extends NativeLibraryMethod> = z.infer<(typeof nativeLibraryOutputs)[K]>;
export type NativeLibraryApi = { [K in NativeLibraryMethod]: (request: NativeLibraryRequest<K>) => Promise<RemoteResult<NativeLibraryResponse<K>>> };
/** Native result data deliberately excludes credentials and retains only each public source response. */
export const nativeLibraryWire = { inputs: nativeLibraryInputs, outputs: nativeLibraryOutputs };
