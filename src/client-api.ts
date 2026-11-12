/** Workspace RPCs on the existing authenticated DSH carrier. HHPI v1 is separate. */
import { z } from 'zod';
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import { parseWorkspaceState, type WorkspaceState } from './client/model.ts';
import type { SourceMachineHealth } from './source-machine-types.ts';
export interface CatalogMachine {
    id: string; label: string; online: boolean; homeDir?: string; workspaceRoots?: string[];
    host?: string; platform?: string; version?: string; lastSeenAt?: number; health?: SourceMachineHealth | null;
}
export interface FederationHost { id: string; label: string; online: boolean; basePath: string }
export interface HapiCatalog { hubId: string; connected: boolean; machines: never[]; sessions: never[]; hosts: FederationHost[]; hostsComplete?: boolean }
export interface WorkspaceDocument { revision: number; state: WorkspaceState | null }
export interface WorkspaceWrite { expectedRevision: number; state: WorkspaceState; operationId: string }
export interface WorkspaceWriteResult extends WorkspaceDocument { status: 'applied' | 'conflict' }

export interface HapiRemoteApi {
    catalog(): Promise<RemoteResult<HapiCatalog>>;
    workspaceGet(): Promise<RemoteResult<WorkspaceDocument>>;
    workspacePut(request: WorkspaceWrite): Promise<RemoteResult<WorkspaceWriteResult>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { hapi: HapiRemoteApi }
    interface TypertRemoteMap {
        'hapi/catalog': HapiRemoteApi['catalog'];
        'hapi/workspaceGet': HapiRemoteApi['workspaceGet'];
        'hapi/workspacePut': HapiRemoteApi['workspacePut'];
    }
}
const id = z.string().min(1).max(4096);
const workspaceState = z.unknown().transform((value, ctx) => {
    const parsed = parseWorkspaceState(value);
    if (!parsed) { ctx.addIssue({ code: 'custom', message: 'Invalid workspace state' }); return z.NEVER; }
    return parsed;
});
const workspaceDocument = z.strictObject({ revision: z.number().int().nonnegative(), state: workspaceState.nullable() });
const inputs: Partial<Record<keyof HapiRemoteApi, z.ZodType>> = {
    workspacePut: z.strictObject({ expectedRevision: z.number().int().nonnegative(), state: workspaceState, operationId: id }),
};
const outputs: Record<keyof HapiRemoteApi, z.ZodType> = {
    catalog: z.strictObject({ hubId: id, connected: z.boolean(), machines: z.array(z.never()), sessions: z.array(z.never()),
        hosts: z.array(z.strictObject({ id, label: z.string(), online: z.boolean(), basePath: z.string() })), hostsComplete: z.boolean().optional() }),
    workspaceGet: workspaceDocument,
    workspacePut: workspaceDocument.extend({ status: z.enum(['applied', 'conflict']) }),
};
const codec = (name: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: `hapi-dsh#${name}`, create: () => schema });
export const HAPI_REMOTE: TypertRemoteContribution = {
    package: 'hapi-dsh',
    descriptors: (Object.keys(outputs) as Array<keyof HapiRemoteApi>).map((method): InvocationDescriptor => ({
        id: `hapi-dsh#hapi/${method}`, service: 'hapi', namespace: 'hapi', method, invocation: { kind: 'direct' },
        parameters: inputs[method] === undefined ? [] : [{ name: 'request', wire: 'request', source: 'json', codec: codec(`${method}Input`, inputs[method]!) }],
        result: codec(`${method}Output`, outputs[method]),
    })),
};

/** Errors from tagged Remote calls carry the operation that produced them. */
export interface HapiOperationError { hapiOperation?: string }

/**
 * Tag every Remote rejection with the operation name so notice policy and
 * diagnostics can classify by operation instead of parsing endpoint strings.
 * @param api - the generated Remote API object.
 * @returns a proxy that annotates rejected calls.
 */
export function taggedRemote<T extends object>(api: T): T {
    return new Proxy(api, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver)
            if (typeof value !== 'function' || typeof prop !== 'string') return value
            return (...args: unknown[]) => {
                const result = (value as (...values: unknown[]) => unknown).apply(target, args)
                if (typeof (result as PromiseLike<unknown> | undefined)?.then !== 'function') return result
                return (result as Promise<unknown>).catch((error: unknown) => {
                    if (error !== null && typeof error === 'object') Object.assign(error, { hapiOperation: `hapi/${prop}` })
                    throw error
                })
            }
        },
    })
}

export function remoteValue<T>(result: RemoteResult<T>): T {
    if (!result.ok) throw result.error;
    return result.value;
}
