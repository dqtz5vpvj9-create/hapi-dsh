/** Browser-safe schemas for authenticated official Typert transport. */
import { z } from 'zod';
import type { InvocationDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { SourceCatalog, SourceChanges, SourceChangesRequest, SourceCreateRequest, SourceEntry, SourceOperation, SourcePage, SourceReadRequest, SourceReceipt, SourceResource, SourceResourceRequest, SourceSession } from './remote/protocol.ts';

export interface HhpiRemoteApi {
    catalog(signal?: AbortSignal): Promise<RemoteResult<SourceCatalog>>;
    read(request: SourceReadRequest, signal?: AbortSignal): Promise<RemoteResult<SourcePage>>;
    changes(request: SourceChangesRequest, signal?: AbortSignal): RemoteStreamHandle<SourceChanges, never>;
    operate(request: SourceOperation): Promise<RemoteResult<SourceReceipt>>;
    create(request: SourceCreateRequest, signal?: AbortSignal): Promise<RemoteResult<SourceSession>>;
    resource(request: SourceResourceRequest, signal?: AbortSignal): Promise<RemoteResult<SourceResource>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { hhpi: HhpiRemoteApi }
    interface TypertRemoteMap {
        'hhpi/catalog': HhpiRemoteApi['catalog']; 'hhpi/read': HhpiRemoteApi['read']; 'hhpi/changes': HhpiRemoteApi['changes'];
        'hhpi/operate': HhpiRemoteApi['operate']; 'hhpi/create': HhpiRemoteApi['create']; 'hhpi/resource': HhpiRemoteApi['resource'];
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
    capabilities: z.strictObject({ send: z.boolean(), steer: z.boolean(), cancel: z.boolean(), approve: z.boolean(), files: z.boolean() }), pendingRequests: z.array(approval) });
// The source normalizer uses the pinned DSH event validator. The wire additionally
// bounds structural identity; browser code cannot submit event payloads to Host.
const entry = z.strictObject({ type: z.literal('event'), event: z.object({ seq, type: z.string().min(1), time: z.number().finite(), data: z.unknown() }).passthrough() }) as unknown as z.ZodType<SourceEntry>;
export const readSchema: z.ZodType<SourceReadRequest> = z.strictObject({ sessionId: id, before: seq.optional(), after: seq.optional(), around: seq.optional(), limit: z.number().int().min(1).max(500).optional(), epoch: id.optional() })
    .refine(value => [value.before, value.after, value.around].filter(value => value !== undefined).length <= 1, 'One source navigation target is allowed') as z.ZodType<SourceReadRequest>;
export const operationSchema: z.ZodType<SourceOperation> = z.strictObject({ sessionId: id, operationId: z.string().min(1).max(256), kind: z.enum(['send', 'steer', 'cancel', 'approve']),
    text: z.string().max(1024 * 1024).optional(), turnId: id.optional(), requestId: id.optional(), decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']).optional() }) as z.ZodType<SourceOperation>;
const page = z.strictObject({ session, epoch: id, version: seq, entries: z.array(entry), before: seq.nullable(), after: seq.nullable(), hasBefore: z.boolean(), hasAfter: z.boolean(), context: z.array(seq) });
const changes = z.strictObject({ session, epoch: id, base: seq, version: seq, reset: z.boolean(), upserts: z.array(entry), removed: z.array(seq) });
const inputs = { read: readSchema, changes: z.strictObject({ sessionId: id, epoch: id, version: seq }), operate: operationSchema,
    create: z.strictObject({ sourceId: id, cwd: z.string().min(1).max(8192).optional() }), resource: z.strictObject({ sessionId: id, path: z.string().min(1).max(8192) }) };
const outputs = { catalog: z.strictObject({ protocol: z.literal(1), legacyHapi: z.boolean(), sessions: z.array(session), sources: z.array(z.strictObject({ id, machineId: id, engine: z.string(), online: z.boolean(), create: z.boolean() })) }),
    read: page, changes, operate: z.strictObject({ operationId: id, sessionId: id, status: z.enum(['accepted', 'rejected', 'indeterminate']), message: z.string(), turnId: id.optional() }),
    create: session, resource: z.strictObject({ encoding: z.literal('base64'), content: z.string(), mimeType: z.string() }) };
const codec = (name: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: `hapi-dsh#hhpi/${name}`, create: () => schema });
export const HHPI_REMOTE: TypertRemoteContribution = {
    package: 'hapi-dsh', descriptors: (Object.keys(outputs) as Array<keyof HhpiRemoteApi>).map((method): InvocationDescriptor => ({
        id: `hapi-dsh#hhpi/${method}`, service: 'hhpi', namespace: 'hhpi', method, invocation: { kind: 'direct' },
        ...(method === 'changes' ? { mode: 'stream' as const } : {}),
        ...(method !== 'operate' ? { cancellation: { parameter: 'signal' as const } } : {}),
        parameters: method === 'catalog' ? [] : [{ name: 'request', wire: 'request', source: 'json', codec: codec(`${method}Input`, inputs[method]) }],
        result: codec(`${method}Output`, outputs[method]),
    })),
};
