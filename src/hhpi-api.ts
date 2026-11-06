import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/types';
import type { SourceUploadRequest } from './remote/protocol.ts';
/** Browser-safe schemas for authenticated official Typert transport. */
import type { CodexCall, CodexCallResult, CodexCapabilities, CodexEvents, CodexEventsRequest, CodexReply } from './remote/codex-access.ts';
import { z } from 'zod';
import { SOURCE_IMAGE_BASE64_LIMIT, SOURCE_IMAGE_COUNT_LIMIT } from './shared/source-image-limits.ts';
import { sourceImageAttachmentRefSchema } from './source-attachment-types.ts';
import type { InvocationDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { SourceCatalog, SourceChanges, SourceChangesRequest, SourceCreateRequest, SourceCreationReceipt, SourceEntry, SourceOperation, SourcePage, SourceReadRequest, SourceReceipt, SourceResource, SourceResourceRequest, SourceSession } from './remote/protocol.ts';

export interface HhpiRemoteApi {
    upload?(request: SourceUploadRequest, signal?: AbortSignal): Promise<RemoteResult<FileUploadValue>>;
    nativeCapabilities?(request: { sourceId: string }, signal?: AbortSignal): Promise<RemoteResult<CodexCapabilities>>;
    nativeCall?(request: CodexCall, signal?: AbortSignal): Promise<RemoteResult<CodexCallResult>>;
    nativeReceipt?(request: CodexCall, signal?: AbortSignal): Promise<RemoteResult<CodexCallResult>>;
    nativeReply?(request: CodexReply): Promise<RemoteResult<CodexCallResult>>;
    nativeEvents?(request: CodexEventsRequest, signal?: AbortSignal): Promise<RemoteResult<CodexEvents>>;
    catalog(signal?: AbortSignal): Promise<RemoteResult<SourceCatalog>>;
    resolve?(request: { sessionId: string }, signal?: AbortSignal): Promise<RemoteResult<SourceSession>>;
    read(request: SourceReadRequest, signal?: AbortSignal): Promise<RemoteResult<SourcePage>>;
    changes(request: SourceChangesRequest, signal?: AbortSignal): RemoteStreamHandle<SourceChanges, never>;
    operate(request: SourceOperation): Promise<RemoteResult<SourceReceipt>>;
    receipt?(request: SourceOperation, signal?: AbortSignal): Promise<RemoteResult<SourceReceipt | null>>;
    create(request: SourceCreateRequest): Promise<RemoteResult<SourceCreationReceipt>>;
    resource(request: SourceResourceRequest, signal?: AbortSignal): Promise<RemoteResult<SourceResource>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { hhpi: HhpiRemoteApi }
    interface TypertRemoteMap {
        'hhpi/upload': NonNullable<HhpiRemoteApi['upload']>;
        'hhpi/nativeCapabilities': NonNullable<HhpiRemoteApi['nativeCapabilities']>;
        'hhpi/nativeCall': NonNullable<HhpiRemoteApi['nativeCall']>;
        'hhpi/nativeReceipt': NonNullable<HhpiRemoteApi['nativeReceipt']>;
        'hhpi/nativeReply': NonNullable<HhpiRemoteApi['nativeReply']>;
        'hhpi/nativeEvents': NonNullable<HhpiRemoteApi['nativeEvents']>;
        'hhpi/catalog': HhpiRemoteApi['catalog']; 'hhpi/read': HhpiRemoteApi['read']; 'hhpi/changes': HhpiRemoteApi['changes'];
        'hhpi/resolve': NonNullable<HhpiRemoteApi['resolve']>;
        'hhpi/operate': HhpiRemoteApi['operate']; 'hhpi/receipt': NonNullable<HhpiRemoteApi['receipt']>; 'hhpi/create': HhpiRemoteApi['create']; 'hhpi/resource': HhpiRemoteApi['resource'];
    }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface RemoteErrorDetailsMap { 'hhpi/source': { outcome: 'rejected' | 'indeterminate'; sourceCode: string } }
}
const id = z.string().min(1).max(2048).refine(value => !value.includes('\0'));
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const approval = z.strictObject({ id, method: z.string(), turnId: id.nullable(), itemId: id.nullable(), params: z.record(z.string(), z.unknown()) });
const session: z.ZodType<SourceSession> = z.strictObject({ id, sourceId: id, machineId: id, engine: z.string(), nativeId: id,
    title: z.string(), cwd: z.string(), updatedAt: z.number().finite(), status: z.enum(['idle', 'running', 'waiting', 'offline']), activeTurnId: id.nullable(),
    connection: z.strictObject({ state: z.enum(['online', 'offline']), observedAt: z.number().finite() }).optional(),
    capabilities: z.strictObject({ send: z.boolean(), steer: z.boolean(), cancel: z.boolean(), approve: z.boolean(), files: z.boolean(), images: z.boolean().optional() }), pendingRequests: z.array(approval),
    codex: z.strictObject({ model: z.string().nullable(), reasoningEffort: z.string().nullable(), parentThreadId: z.string().nullable(), agentNickname: z.string().nullable(), settings: z.record(z.string(), z.unknown()).optional() }).optional(),
    legacyOrigin: z.strictObject({ hubId: id, sessionId: id }).optional() });
/** The same boundary contract validates optional authenticated browser history snapshots. */
export const sourceSessionSchema = session;
// The source normalizer uses the pinned DSH event validator. The wire additionally
// bounds structural identity; browser code cannot submit event payloads to Host.
const entry = z.strictObject({ type: z.literal('event'), event: z.object({ seq, type: z.string().min(1), time: z.number().finite(), data: z.unknown() }).passthrough() }) as unknown as z.ZodType<SourceEntry>;
export const readSchema: z.ZodType<SourceReadRequest> = z.strictObject({ sessionId: id, before: seq.optional(), after: seq.optional(), around: seq.optional(), limit: z.number().int().min(1).max(500).optional(), epoch: id.optional() })
    .refine(value => [value.before, value.after, value.around].filter(value => value !== undefined).length <= 1, 'One source navigation target is allowed') as z.ZodType<SourceReadRequest>;
export const operationSchema: z.ZodType<SourceOperation> = z.strictObject({ sessionId: id, operationId: z.string().min(1).max(256), kind: z.enum(['send', 'steer', 'cancel', 'approve']),
    files: z.array(z.uuid()).max(10).optional(),
    images: z.array(z.strictObject({ mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().max(SOURCE_IMAGE_BASE64_LIMIT) })).max(SOURCE_IMAGE_COUNT_LIMIT).refine(images => images.reduce((bytes, image) => bytes + image.data.length, 0) <= SOURCE_IMAGE_BASE64_LIMIT, 'Image payload exceeds the native frame budget').optional(), response: z.record(z.string(), z.unknown()).optional(), text: z.string().max(1024 * 1024).optional(), turnId: id.optional(), requestId: id.optional(), decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']).optional() }) as z.ZodType<SourceOperation>;
const page = z.strictObject({ session, epoch: id, version: seq, entries: z.array(entry), before: seq.nullable(), after: seq.nullable(), hasBefore: z.boolean(), hasAfter: z.boolean(), context: z.array(seq) });
const changes = z.strictObject({ session, epoch: id, base: seq, version: seq, reset: z.boolean(), upserts: z.array(entry), removed: z.array(seq) });
const receipt = z.strictObject({ operationId: id, sessionId: id, status: z.enum(['accepted', 'rejected', 'indeterminate']), message: z.string(), turnId: id.optional(),
    retryable: z.literal(true).optional(), observed: z.strictObject({ epoch: id, seq }).optional(),
    ownerAdmission: z.strictObject({ localId: id, state: z.enum(['queued', 'dispatching', 'indeterminate', 'consumed']) }).optional() });
const nativeCall = z.strictObject({ sourceId: id, method: z.string().min(1).max(256), params: z.record(z.string(), z.unknown()).nullable(), operationId: z.string().min(1).max(256).optional() });
const nativeResult = z.strictObject({ status: z.enum(['accepted', 'rejected', 'indeterminate']), message: z.string(), result: z.unknown().optional(), error: z.strictObject({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(), resultUnavailable: z.literal(true).optional() });
const inputs = {
    upload: z.strictObject({ sessionId: id, operationId: z.uuid(), name: z.string().max(512), data: z.string().max(8 * 1024 * 1024) }),
    nativeCapabilities: z.strictObject({ sourceId: id }), nativeCall, nativeReceipt: nativeCall,
    nativeReply: z.strictObject({ sourceId: id, operationId: z.string().min(1).max(256), requestId: id, result: z.unknown() }),
    nativeEvents: z.strictObject({ sourceId: id, generation: seq.optional(), after: seq.optional() }),
    resolve: z.strictObject({ sessionId: id }), read: readSchema, changes: z.strictObject({ sessionId: id, epoch: id, version: seq }), operate: operationSchema, receipt: operationSchema,
    create: z.strictObject({ sourceId: id, operationId: z.string().min(1).max(256), cwd: z.string().min(1).max(8192).optional() }), resource: z.strictObject({ sessionId: id, path: z.string().min(1).max(8192) }) };
const outputs = {
    upload: z.strictObject({ receiptId: z.uuid(), file: z.strictObject({ attachmentId: z.uuid(), name: z.string(), bytes: z.number().int().nonnegative() }) }),
    nativeCapabilities: z.strictObject({ protocolVersion: z.literal('0.165.0'), runtime: z.string(), methods: z.record(z.string(), z.enum(['read', 'write'])), unavailable: z.record(z.string(), z.string()) }),
    nativeCall: nativeResult, nativeReceipt: nativeResult, nativeReply: nativeResult,
    nativeEvents: z.strictObject({ generation: seq, cursor: seq, reset: z.boolean(), events: z.array(z.strictObject({ sequence: seq, generation: seq, method: z.string(), params: z.record(z.string(), z.unknown()) })), pending: z.array(z.strictObject({ id, generation: seq, method: z.string(), params: z.record(z.string(), z.unknown()) })) }),
    catalog: z.strictObject({ protocol: z.literal(1), legacyHapi: z.boolean(), storageScope: id.optional(), sessions: z.array(session), sources: z.array(z.strictObject({ id, machineId: id, engine: z.string(), online: z.boolean(), create: z.boolean() })) }),
    resolve: session, read: page, changes, operate: receipt, receipt: receipt.nullable(),
    create: z.strictObject({ sourceId: id, operationId: id, status: z.enum(['accepted', 'rejected', 'indeterminate']), message: z.string(), session: session.optional() }), resource: z.strictObject({ encoding: z.literal('base64'), content: z.string(), mimeType: z.string(), attachment: sourceImageAttachmentRefSchema.optional() }) };
const codec = (name: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: `hapi-dsh#hhpi/${name}`, create: () => schema });
export const HHPI_REMOTE: TypertRemoteContribution = {
    package: 'hapi-dsh', descriptors: (Object.keys(outputs) as Array<keyof HhpiRemoteApi>).map((method): InvocationDescriptor => ({
        id: `hapi-dsh#hhpi/${method}`, service: 'hhpi', namespace: 'hhpi', method, invocation: { kind: 'direct' },
        ...(method === 'changes' ? { mode: 'stream' as const } : {}),
        ...(method !== 'operate' && method !== 'create' && method !== 'nativeReply' ? { cancellation: { parameter: 'signal' as const } } : {}),
        parameters: method === 'catalog' ? [] : [{ name: 'request', wire: 'request', source: 'json', codec: codec(`${method}Input`, inputs[method]) }],
        result: codec(`${method}Output`, outputs[method]),
    })),
};
