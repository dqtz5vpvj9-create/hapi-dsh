/** Browser-safe workbench requests and source-workspace resource identities. */
import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';

export const MAX_EDITABLE_BYTES = 4 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const id = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid identity');
const path = z.string().min(1).max(8192).refine(value => !value.includes('\0'), 'Invalid path');
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** The selected binding, never the focused pane or a caller-selected execution provider. */
export const workspaceTargetSchema = z.strictObject({ hostId: id, sessionId: z.string().min(1).max(8192)
    .refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid session identity') });
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;
/** Provider-issued freshness tokens are opaque; they need not be content hashes. */
export const workspaceVersionSchema = z.string().min(1).max(4096);
export const workspaceFileBaselineSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('absent') }),
    z.strictObject({ kind: z.literal('version'), version: workspaceVersionSchema }),
]);
export type WorkspaceFileBaseline = z.infer<typeof workspaceFileBaselineSchema>;
export const workspaceDocumentRefSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('file'), path }),
    z.strictObject({ kind: z.literal('artifact'), id: path }),
    z.strictObject({ kind: z.literal('generated-media'), id: path }),
]);
export type WorkspaceDocumentRef = z.infer<typeof workspaceDocumentRefSchema>;
export const workspaceResourceSchema = z.strictObject({ target: workspaceTargetSchema, document: workspaceDocumentRefSchema });
export type WorkspaceResource = z.infer<typeof workspaceResourceSchema>;
export const workspaceFileSaveRequestSchema = z.strictObject({ target: workspaceTargetSchema, operationId: id,
    path, baseline: workspaceFileBaselineSchema, text: z.string().max(MAX_EDITABLE_BYTES),
    format: z.strictObject({ bom: z.boolean(), eol: z.enum(['\n', '\r\n']) }).optional() });
export type WorkspaceFileSaveRequest = z.infer<typeof workspaceFileSaveRequestSchema>;
export const workspaceFileOperationSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create-file'), path }),
    z.strictObject({ action: z.literal('create-directory'), path }),
    z.strictObject({ action: z.literal('rename'), path, destination: path, expectedVersion: workspaceVersionSchema }),
    z.strictObject({ action: z.literal('move'), path, destination: path, expectedVersion: workspaceVersionSchema }),
    z.strictObject({ action: z.literal('copy'), path, destination: path, expectedVersion: workspaceVersionSchema }),
    z.strictObject({ action: z.literal('delete'), path, expectedVersion: workspaceVersionSchema, recursive: z.boolean() }),
]);
export type WorkspaceFileOperation = z.infer<typeof workspaceFileOperationSchema>;
export const workspaceFileManageRequestSchema = z.strictObject({ target: workspaceTargetSchema, operationId: id,
    operation: workspaceFileOperationSchema });
export type WorkspaceFileManageRequest = z.infer<typeof workspaceFileManageRequestSchema>;
export const workspaceUploadDestinationSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('file'), path, baseline: workspaceFileBaselineSchema }),
    z.strictObject({ kind: z.literal('attachment'), name: z.string().min(1).max(1024) }),
]);
export type WorkspaceUploadDestination = z.infer<typeof workspaceUploadDestinationSchema>;
/** Size is the binary byte count; source limits are returned before any body is transferred. */
export const workspaceUploadStartSchema = z.strictObject({ target: workspaceTargetSchema, operationId: id,
    destination: workspaceUploadDestinationSchema, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mimeType: z.string().min(1).max(256) });
export type WorkspaceUploadStart = z.infer<typeof workspaceUploadStartSchema>;
export const workspaceUploadRequestSchema = z.strictObject({ target: workspaceTargetSchema, uploadId: id });
export type WorkspaceUploadRequest = z.infer<typeof workspaceUploadRequestSchema>;
export const workspaceUploadChunkSchema = workspaceUploadRequestSchema.extend({
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), data: z.instanceof(Uint8Array),
});
export type WorkspaceUploadChunk = z.infer<typeof workspaceUploadChunkSchema>;

/** Existing HAPI consumers remain until their replacement is integrated and their owners retire. */
export const workbenchSourceSchema = z.strictObject({ sourceSessionId: id, sourceHubId: id.optional(), machineId: id.optional() });
export type WorkbenchSource = z.infer<typeof workbenchSourceSchema>;
export const nativeDocumentRefSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('file'), path, machineId: id.optional() }),
    z.strictObject({ kind: z.literal('artifact'), artifactId: path, fileName: z.string().max(1024), mimeType: z.string().max(256) }),
    z.strictObject({ kind: z.literal('generated-media'), imageId: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid media identity'),
        fileName: z.string().max(1024), mimeType: z.string().max(256) }),
]).transform(value => value.kind === 'file' ? { kind: value.kind, path: value.path, ...(value.machineId === undefined ? {} : { machineId: value.machineId }) } : value);
export type NativeDocumentRef = z.infer<typeof nativeDocumentRefSchema>;
const source = { source: workbenchSourceSchema };
const error = { success: z.boolean(), error: z.string().optional() };
export const nativeDirectorySchema = z.object({ ...error, path: z.string(), cwd: z.string(), machineId: id,
    entries: z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory', 'other']), isSymbolicLink: z.boolean().optional(), size: z.number().optional(), modified: z.number().optional() })),
});
export const nativeFileSearchSchema = z.object({ ...error, files: z.array(z.object({ fileName: z.string(), filePath: z.string(), fullPath: z.string(), fileType: z.enum(['file', 'folder']), size: z.number().optional(), modified: z.number().optional() })) });
export const nativeGitSchema = z.object({ ...error, stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().int().optional() });
export const nativeTextFormatSchema = z.strictObject({ bom: z.boolean(), eol: z.enum(['\n', '\r\n']), mixed: z.boolean().optional() });
export type NativeTextFormat = z.infer<typeof nativeTextFormatSchema>;
export const nativeDocumentSchema = z.object({
    document: nativeDocumentRefSchema, fileName: z.string(), mimeType: z.string(), size: z.number().int().nonnegative(),
    modified: z.number().optional(), hash: hash.optional(), writable: z.boolean(),
    text: z.string().nullable(), format: nativeTextFormatSchema.optional(), downloadUrl: z.string(), officePreview: z.boolean(),
});
export const nativeFileSaveSchema = z.object({ ...error, hash: hash.optional(), modified: z.number().optional(), code: z.enum(['conflict', 'denied', 'too-large']).optional() });
export const nativeFileEntrySchema = z.object({ path, name: z.string(), type: z.enum(['file', 'directory', 'symlink']), size: z.number().nonnegative(), modified: z.number(), revision: hash, entryCount: z.number().int().nonnegative() });
export const nativeFileManagementSchema = z.object({ ...error, entry: nativeFileEntrySchema.optional(), code: z.enum(['conflict', 'denied', 'not-found', 'invalid', 'too-large', 'unsupported']).optional(), deletedPaths: z.array(z.string()).optional(), commit: z.object({ action: z.enum(['rename', 'move']), path, destination: path }).optional() });
export const nativeFileOperationSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create-file'), path }),
    z.strictObject({ action: z.literal('create-directory'), path }),
    z.strictObject({ action: z.literal('rename'), path, destination: path, expectedRevision: hash }),
    z.strictObject({ action: z.literal('move'), path, destination: path, expectedRevision: hash }),
    z.strictObject({ action: z.literal('copy'), path, destination: path, expectedRevision: hash }),
    z.strictObject({ action: z.literal('delete'), path, expectedRevision: hash, recursive: z.boolean() }),
]);
export const nativePreviewSchema = z.object({ previewId: id, length: z.number().int().nonnegative().max(MAX_DOCUMENT_BYTES), version: z.string(), modified: z.number().optional(), size: z.number().optional(), url: z.string() });
export const workbenchInputs = {
    nativeDirectory: z.strictObject({ ...source, path: path.optional() }),
    nativeFileSearch: z.strictObject({ ...source, query: z.string().max(8192), limit: z.number().int().min(1).max(500).optional() }),
    nativeGit: z.strictObject({ ...source, kind: z.enum(['status', 'numstat', 'diff']), path: path.optional(), staged: z.boolean().optional() }),
    nativeDocument: z.strictObject({ ...source, document: nativeDocumentRefSchema }),
    nativeFileSave: z.strictObject({ ...source, path, text: z.string().max(MAX_EDITABLE_BYTES), expectedHash: hash.nullable(), format: nativeTextFormatSchema.optional() }),
    nativeFileInspect: z.strictObject({ ...source, path }),
    nativeFileManage: z.strictObject({ ...source, operation: nativeFileOperationSchema }),
    nativeFileUpload: z.strictObject({ ...source, path, content: z.string().max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) }),
    nativePreview: z.strictObject({ ...source, document: nativeDocumentRefSchema, version: z.string().min(1).max(512).optional() }),
};
export const workbenchOutputs = {
    nativeDirectory: nativeDirectorySchema, nativeFileSearch: nativeFileSearchSchema, nativeGit: nativeGitSchema,
    nativeDocument: nativeDocumentSchema, nativeFileSave: nativeFileSaveSchema, nativeFileInspect: nativeFileManagementSchema,
    nativeFileManage: nativeFileManagementSchema, nativeFileUpload: nativeFileManagementSchema, nativePreview: nativePreviewSchema,
};
export type WorkbenchMethod = keyof typeof workbenchInputs;
export type WorkbenchRequest<K extends WorkbenchMethod> = z.infer<(typeof workbenchInputs)[K]>;
export type WorkbenchResponse<K extends WorkbenchMethod> = z.infer<(typeof workbenchOutputs)[K]>;
export type NativeWorkbenchApi = { [K in WorkbenchMethod]: (request: WorkbenchRequest<K>) => Promise<RemoteResult<WorkbenchResponse<K>>> };

export const WORKBENCH_DOCUMENT_PATH = '/hapi-dsh/workbench/document';
export const WORKBENCH_PREVIEW_PATH = '/hapi-dsh/workbench/preview';
