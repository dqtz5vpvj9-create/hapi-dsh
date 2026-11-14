/** Independent source workspace carrier; official Files codecs and native binary results are reused. */
import { z } from 'zod';
import { TYPERT_REMOTE as FILES_REMOTE } from '@deepseek-ai/dsh-api-workspace-files/remote';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { RemoteError, type InvocationDescriptor, type RemoteResult, type TypertRemoteContribution, type TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceFileBytes, WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types';
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types';
import { workspaceDocumentRefSchema, workspaceFileManageRequestSchema, workspaceFileSaveRequestSchema, workspaceResourceSchema, workspaceTargetSchema, workspaceUploadStartSchema, workspaceUploadRequestSchema, workspaceUploadDestinationSchema } from '../workbench-types.ts';
import type { WorkspaceAccess, WorkspaceAction, WorkspaceBinding, WorkspaceDocument, WorkspaceEntry, WorkspaceMutationResult, WorkspaceServices, WorkspaceUploadReceipt, WorkspaceUploadService, WorkspaceUploadStatus, WorkspaceUploadTransfer } from './service-types.ts';

const id = z.string().min(1).max(8192).refine(value => !value.includes('\0'));
const path = z.string().max(8192).refine(value => !value.includes('\0'));
export const sourceDirectoryIdentity = z.strictObject({ machineId: id, sourceId: id, engine: id });
export type SourceDirectoryIdentity = z.infer<typeof sourceDirectoryIdentity>;
export const sourceDirectoryRequest = sourceDirectoryIdentity.extend({ path: path.optional() });
export type SourceDirectoryRequest = z.infer<typeof sourceDirectoryRequest>;
export interface SourceDirectoryListing { source: SourceDirectoryIdentity; roots: DirectoryEntry[]; listing: DirectoryListing }
const directoryEntry = z.strictObject({ name: z.string(), path: id, hidden: z.boolean() });
const sourceDirectoryListing = z.strictObject({ source: sourceDirectoryIdentity, roots: z.array(directoryEntry).max(27), listing: z.strictObject({ path: id, home: id,
    crumbs: z.array(directoryEntry), entries: z.array(directoryEntry), truncated: z.boolean() }) });
export const workspaceBindingSchema = z.strictObject({ target: workspaceTargetSchema, machineId: id, workspaceId: id, root: id, pathStyle: z.enum(['posix', 'win32']) });
export interface SourceWorkspaceDescription {
    binding: WorkspaceBinding;
    /** Actual provider registration; client integration is a separate fact. */
    registered: { files: true; documents: true; mutations: boolean; uploads: boolean; terminals: boolean };
}
const description = z.strictObject({ binding: workspaceBindingSchema, registered: z.strictObject({ files: z.literal(true), documents: z.literal(true),
    mutations: z.boolean(), uploads: z.boolean(), terminals: z.boolean() }) });
export const workspaceEntrySchema = z.strictObject({ absolutePath: id, name: z.string(), type: z.enum(['file', 'directory', 'symlink']), version: id,
    bytes: z.number().nonnegative(), modified: z.number().optional(), entryCount: z.number().int().nonnegative().optional() })
    .transform(({ modified, entryCount, ...value }): WorkspaceEntry => ({ ...value,
        ...(modified === undefined ? {} : { modified }), ...(entryCount === undefined ? {} : { entryCount }) }));
const entry = workspaceEntrySchema;
export const workspaceDocumentSchema = z.strictObject({ resource: workspaceResourceSchema, fileName: z.string(), mimeType: z.string(), bytes: z.number().nonnegative(),
    version: id, modified: z.number().optional(), writable: z.boolean(), text: z.string().nullable(),
    format: z.strictObject({ bom: z.boolean(), eol: z.enum(['\n', '\r\n']) }).optional() })
    .transform(({ modified, format, ...value }): WorkspaceDocument => ({ ...value,
        ...(modified === undefined ? {} : { modified }), ...(format === undefined ? {} : { format }) }));
const document = workspaceDocumentSchema;
const byteOptions = z.strictObject({ range: z.strictObject({ offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().optional() }).optional(), baseFile: path.optional() });
export const sourceWorkspaceInputs = {
    directories: sourceDirectoryRequest,
    resolve: z.strictObject({ sessionId: id }),
    openDocument: z.strictObject({ sessionId: id, document: workspaceDocumentRefSchema }),
    readDocumentBytes: z.strictObject({ sessionId: id, document: workspaceDocumentRefSchema, options: byteOptions }),
    inspect: z.strictObject({ sessionId: id, path }),
    search: z.strictObject({ sessionId: id, query: z.string().max(4096), limit: z.number().int().min(1).max(1000) }),
    git: z.strictObject({ sessionId: id, kind: z.enum(['status', 'numstat', 'diff']), path: path.optional(), staged: z.boolean().optional() }),
    uploadInputs: z.strictObject({ sessionId: id, receiptIds: z.array(z.uuid()).max(100), clientUserMessageId: id.optional() }),
    beginUpload: workspaceUploadStartSchema,
    uploadStatus: workspaceUploadRequestSchema,
    finishUpload: workspaceUploadRequestSchema,
    cancelUpload: workspaceUploadRequestSchema,
    save: workspaceFileSaveRequestSchema,
    manage: workspaceFileManageRequestSchema,
    receipt: z.strictObject({ sessionId: id, operationId: id }),
} as const;
type Request<K extends keyof typeof sourceWorkspaceInputs> = z.input<(typeof sourceWorkspaceInputs)[K]>;
export type SourceUploadInput = { type: 'text'; text: string; text_elements: never[] } | { type: 'localImage'; path: string };
/** Optional adapter capability for existing source-owned receipts, outside the HHPI v1 interface. */
export interface SourceUploadInputsProvider {
    uploadInputs(sessionId: string, receiptIds: readonly string[], signal?: AbortSignal, clientUserMessageId?: string): Promise<SourceUploadInput[]>;
}
type OfficialWorkspaceFilesApi = TypertRemoteNamespaceMap['workspaceFiles'];
export interface SourceWorkspaceApi extends OfficialWorkspaceFilesApi {
    /** Source-level, read-only selection before a conversation exists; never a serving-Host filesystem fallback. */
    directories(request: SourceDirectoryRequest, signal?: AbortSignal): Promise<RemoteResult<SourceDirectoryListing>>;
    resolve(request: Request<'resolve'>, signal?: AbortSignal): Promise<RemoteResult<SourceWorkspaceDescription>>;
    openDocument(request: Request<'openDocument'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceDocument>>;
    readDocumentBytes(request: Request<'readDocumentBytes'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileBytes>>;
    inspect(request: Request<'inspect'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceEntry | null>>;
    search(request: Request<'search'>, signal?: AbortSignal): Promise<RemoteResult<readonly WorkspaceEntry[]>>;
    git(request: Request<'git'>, signal?: AbortSignal): Promise<RemoteResult<{ stdout: string; stderr: string; exitCode: number }>>;
    uploadInputs?(request: Request<'uploadInputs'>, signal?: AbortSignal): Promise<RemoteResult<{ input: SourceUploadInput[] }>>;
    beginUpload(request: Request<'beginUpload'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceUploadTransfer>>;
    uploadStatus(request: Request<'uploadStatus'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceUploadStatus>>;
    finishUpload(request: Request<'finishUpload'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceMutationResult<WorkspaceUploadReceipt>>>;
    cancelUpload(request: Request<'cancelUpload'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceUploadStatus>>;
    save(request: Request<'save'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceMutationResult<WorkspaceFileStat>>>;
    manage(request: Request<'manage'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceMutationResult<WorkspaceEntry | null>>>;
    receipt(request: Request<'receipt'>, signal?: AbortSignal): Promise<RemoteResult<WorkspaceMutationResult<WorkspaceFileStat | WorkspaceEntry | null> | null>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { sourceWorkspace: SourceWorkspaceApi }
    interface TypertRemoteMap {
        'sourceWorkspace/directories': SourceWorkspaceApi['directories'];
        'sourceWorkspace/resolve': SourceWorkspaceApi['resolve'];
        'sourceWorkspace/read': SourceWorkspaceApi['read'];
        'sourceWorkspace/readBytes': SourceWorkspaceApi['readBytes'];
        'sourceWorkspace/stat': SourceWorkspaceApi['stat'];
        'sourceWorkspace/list': SourceWorkspaceApi['list'];
        'sourceWorkspace/changes': SourceWorkspaceApi['changes'];
        'sourceWorkspace/openDocument': SourceWorkspaceApi['openDocument'];
        'sourceWorkspace/readDocumentBytes': SourceWorkspaceApi['readDocumentBytes'];
        'sourceWorkspace/inspect': SourceWorkspaceApi['inspect'];
        'sourceWorkspace/search': SourceWorkspaceApi['search'];
        'sourceWorkspace/git': SourceWorkspaceApi['git'];
        'sourceWorkspace/uploadInputs': NonNullable<SourceWorkspaceApi['uploadInputs']>;
        'sourceWorkspace/beginUpload': SourceWorkspaceApi['beginUpload'];
        'sourceWorkspace/uploadStatus': SourceWorkspaceApi['uploadStatus'];
        'sourceWorkspace/finishUpload': SourceWorkspaceApi['finishUpload'];
        'sourceWorkspace/cancelUpload': SourceWorkspaceApi['cancelUpload'];
        'sourceWorkspace/save': SourceWorkspaceApi['save'];
        'sourceWorkspace/manage': SourceWorkspaceApi['manage'];
        'sourceWorkspace/receipt': SourceWorkspaceApi['receipt'];
    }
}
const codec = (name: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: `hapi-dsh#sourceWorkspace/${name}`, create: () => schema });
const bytes = FILES_REMOTE.descriptors.find(value => value.method === 'readBytes')!.result;
const statCodec = FILES_REMOTE.descriptors.find(value => value.method === 'stat')!.result;
if (statCodec.mode !== 'strict') throw new Error('The pinned official Files stat codec must be available.');
const officialFileStat = statCodec.create();
const fileStat = z.unknown().transform((value, ctx): WorkspaceFileStat | typeof z.NEVER => {
    try { return officialFileStat.parse(value) as WorkspaceFileStat; }
    catch { ctx.addIssue({ code: 'custom', message: 'Invalid official Files stat result.' }); return z.NEVER; }
});
/** Production result schema shared by Remote and contract tests. */
export const workspaceMutationResultSchema = <Schema extends z.ZodType>(value: Schema) => z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('applied'), operationId: id, value }),
    z.strictObject({ status: z.literal('conflict'), operationId: id, currentVersion: z.string().nullable() }),
    z.strictObject({ status: z.literal('rejected'), operationId: id, code: z.enum(['denied', 'not-found', 'invalid', 'too-large', 'unsupported']), message: z.string().max(4096) }),
    z.strictObject({ status: z.literal('indeterminate'), operationId: id }),
]);
const nonnegative = z.number().int().nonnegative();
const imageRef = z.strictObject({ attachmentId: id, mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: nonnegative, width: z.number().positive(), height: z.number().positive(), name: z.string().optional(),
    originalDimensions: z.strictObject({ width: z.number().positive(), height: z.number().positive() }).optional() });
const fileRef = z.strictObject({ attachmentId: id, name: z.string(), bytes: nonnegative });
const uploadValue = z.union([z.strictObject({ receiptId: z.uuid(), image: imageRef }), z.strictObject({ receiptId: z.uuid(), file: fileRef })]);
const uploadReceipt = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('file'), resource: workspaceResourceSchema, file: fileStat }),
    z.strictObject({ kind: z.literal('attachment'), resource: workspaceResourceSchema, value: uploadValue }),
]);
const uploadTransfer = z.strictObject({ uploadId: id, target: workspaceTargetSchema, operationId: id, destination: workspaceUploadDestinationSchema,
    bytes: nonnegative, receivedBytes: nonnegative, chunkBytes: z.number().int().positive(), maxBytes: z.number().int().positive() });
const uploadResult = workspaceMutationResultSchema(uploadReceipt);
const uploadStatus = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('uploading'), transfer: uploadTransfer }),
    z.strictObject({ state: z.literal('finished'), result: uploadResult }), z.strictObject({ state: z.literal('cancelled') })]);
const results = { directories: codec('sourceDirectories', sourceDirectoryListing), resolve: codec('description', description), openDocument: codec('document', document), readDocumentBytes: bytes,
    inspect: codec('entry', entry.nullable()), search: codec('entries', z.array(entry)),
    git: codec('git', z.strictObject({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() })),
    uploadInputs: codec('uploadInputs', z.strictObject({ input: z.array(z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('text'), text: z.string().max(32_768), text_elements: z.array(z.never()).max(0) }),
        z.strictObject({ type: z.literal('localImage'), path: id }),
    ])).max(100) })),
    beginUpload: codec('beginUpload', uploadTransfer), uploadStatus: codec('uploadStatus', uploadStatus),
    finishUpload: codec('finishUpload', uploadResult), cancelUpload: codec('cancelUpload', uploadStatus),
    save: codec('save', workspaceMutationResultSchema(fileStat)),
    manage: codec('manage', workspaceMutationResultSchema(entry.nullable())),
    receipt: codec('receipt', workspaceMutationResultSchema(z.union([entry, fileStat, z.null()])).nullable()),
};
export const SOURCE_WORKSPACE_REMOTE: TypertRemoteContribution = {
    package: 'hapi-dsh', descriptors: [
        ...FILES_REMOTE.descriptors.map((value): InvocationDescriptor => ({ ...value, id: `hapi-dsh#sourceWorkspace/${value.method}`,
            service: 'sourceWorkspace', namespace: 'sourceWorkspace', parameters: value.parameters.map((parameter, index) => index === 0
                ? { name: 'sessionId', wire: parameter.wire, source: 'json', codec: parameter.codec } : parameter) })),
        ...(Object.keys(sourceWorkspaceInputs) as Array<keyof typeof sourceWorkspaceInputs>).map((method): InvocationDescriptor => ({
            id: `hapi-dsh#sourceWorkspace/${method}`, service: 'sourceWorkspace', namespace: 'sourceWorkspace', method,
            invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
            parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec(`${method}Input`, sourceWorkspaceInputs[method]) }], result: results[method],
        })),
    ],
};
export const SOURCE_WORKSPACE_HOST_CONTRACT = {
    invocations: SOURCE_WORKSPACE_REMOTE.descriptors,
    services: [{ key: 'sourceWorkspace', exportName: 'SourceWorkspaceService', tags: [], members: [], types: [], summary: 'Authorized source OS workspace services.' }],
};

const unwrap = <T>(value: RemoteResult<T>): T => { if (!value.ok) throw value.error; return value.value; };
/** Adapter for official Files/DocumentPreview consumers; it does not implement another renderer. */
export function sourceWorkspaceProxy(api: SourceWorkspaceApi, description: SourceWorkspaceDescription, appendUpload?: WorkspaceUploadService['append']): WorkspaceServices {
    const { binding } = description, sessionId = binding.target.sessionId as SessionId;
    const exact = <T extends { target: WorkspaceBinding['target'] }>(request: T): T => {
        if (request.target.hostId !== binding.target.hostId || request.target.sessionId !== binding.target.sessionId) {
            throw new RemoteError('workspace-service/unavailable', 'The mutation names another source binding.', { reason: 'source-mismatch' });
        }
        return request;
    };
    const invoke = async <T>(action: WorkspaceAction, access: WorkspaceAccess, call: () => Promise<RemoteResult<T>>): Promise<T> => {
        access.signal.throwIfAborted(); await access.assertAllowed(binding.target, action);
        const value = unwrap(await call());
        access.signal.throwIfAborted(); await access.assertAllowed(binding.target, action); return value;
    };
    return { binding, files: {
        read: (path, range, access) => invoke('read', access, () => api.read(sessionId, path, range, access.signal)),
        readBytes: (path, options, access) => invoke('read', access, () => api.readBytes(sessionId, path, options, access.signal)),
        stat: (path, access) => invoke('read', access, () => api.stat(sessionId, path, access.signal)),
        list: (path, access) => invoke('list', access, () => api.list(sessionId, path, access.signal)),
        async *changes(path, access) {
            access.signal.throwIfAborted(); await access.assertAllowed(binding.target, 'watch');
            for await (const frame of api.changes(sessionId, path, access.signal)) {
                access.signal.throwIfAborted(); await access.assertAllowed(binding.target, 'watch'); yield frame;
            }
        },
    }, documents: {
        open: (document, access) => invoke('read', access, () => api.openDocument({ sessionId, document }, access.signal)),
        bytes: (document, options, access) => invoke('read', access, () => api.readDocumentBytes({ sessionId, document, options }, access.signal)),
        inspect: (path, access) => invoke('read', access, () => api.inspect({ sessionId, path }, access.signal)),
        search: (query, limit, access) => invoke('read', access, () => api.search({ sessionId, query, limit }, access.signal)),
        git: (request, access) => invoke('read', access, () => api.git({ sessionId, ...request }, access.signal)),
    }, ...(description.registered.uploads && appendUpload ? { uploads: {
        begin: (request, access) => invoke('upload', access, () => api.beginUpload(exact(request), access.signal)),
        status: (request, access) => invoke('upload', access, () => api.uploadStatus(exact(request), access.signal)),
        finish: (request, access) => invoke('upload', access, () => api.finishUpload(exact(request), access.signal)),
        cancel: (request, access) => invoke('upload', access, () => api.cancelUpload(exact(request), access.signal)),
        append: async (request, access) => { access.signal.throwIfAborted(); await access.assertAllowed(binding.target, 'upload');
            const result = await appendUpload(exact(request), access); access.signal.throwIfAborted();
            await access.assertAllowed(binding.target, 'upload'); return result; },
    } satisfies WorkspaceUploadService } : {}), ...(description.registered.mutations ? { mutations: {
        save: (request, access) => invoke('save', access, () => api.save(exact(request), access.signal)),
        manage: (request, access) => invoke('manage', access, () => api.manage(exact(request), access.signal)),
        receipt: (operationId, access) => invoke('read', access, () => api.receipt({ sessionId, operationId }, access.signal)),
    } satisfies NonNullable<WorkspaceServices['mutations']> } : {}) };
}
