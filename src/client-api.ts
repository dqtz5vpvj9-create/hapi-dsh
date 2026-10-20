/** Shared, browser-safe API contract. Every method is carried by the official DSH Typert gateway. */
import { z } from 'zod';
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { HapiApprovalAnswer, HapiCancelResult, HapiSteerResult, HapiRetryResult } from './codex/contracts.ts';
import { parseWorkspaceState, type WorkspaceState } from './client/model.ts';
import {
    nativeApplySettingSchema, nativeSettingsSchema, nativeSettingReceiptSchema, nativeForkRequestSchema,
    nativeForkOperationRequestSchema, nativeForkCloseRequestSchema, nativeForkViewSchema, nativeForkStateSchema, nativeForkCloseResultSchema,
    type NativeApplySetting, type NativeSettings, type NativeSettingReceipt, type NativeForkRequest,
    type NativeForkOperationRequest, type NativeForkCloseRequest, type NativeForkView, type NativeForkState, type NativeForkCloseResult,
    nativeImplementPlanSchema, nativePlanReceiptSchema, nativePlanStateSchema,
    type NativeImplementPlan, type NativePlanReceipt, type NativePlanState,
} from './codex/control-types.ts';
export type * from './codex/control-types.ts';
import {
    createNativeSessionSchema, nativeCreationStateSchema, nativeCreationOperationSchema,
    type CreateNativeSession, type NativeCreationState, type NativeCreationOperation,
} from './codex/creation-types.ts';
export type * from './codex/creation-types.ts';

export interface CatalogMachine { id: string; label: string; online: boolean }
export interface CatalogSession { id: string; logicalSessionId: string; displayRevision: number; hapiSessionId: string; machineId: string | null; engine: 'codex'; title: string; cwd: string }
export interface FederationHost { id: string; label: string; online: boolean; basePath: string }
export interface HapiCatalog { hubId: string; connected: boolean; machines: CatalogMachine[]; sessions: CatalogSession[]; hosts: FederationHost[] }
export interface MachineOptions {
    homes: Array<{ id: string; name: string; path: string }>;
    models: Array<{ id: string; name: string; reasoningEfforts: string[] }>;
    warnings: string[];
}
export interface WorkspaceDocument { revision: number; state: WorkspaceState | null }
export interface WorkspaceWrite { expectedRevision: number; state: WorkspaceState; operationId: string }
export interface WorkspaceWriteResult extends WorkspaceDocument { status: 'applied' | 'conflict' }
export interface NativeQueueRequest { sessionId: string; localId: string }
export interface NativeAnswerRequest { sessionId: string; requestId: string; answer: HapiApprovalAnswer; deny?: boolean }
export interface HapiRemoteApi {
    catalog(): Promise<RemoteResult<HapiCatalog>>;
    machineOptions(request: { machineId: string }): Promise<RemoteResult<MachineOptions>>;
    createSession(request: CreateNativeSession): Promise<RemoteResult<{ sessionId: string }>>;
    nativeCreations(): Promise<RemoteResult<NativeCreationState[]>>;
    nativeCreationOperation(request: NativeCreationOperation): Promise<RemoteResult<NativeCreationState>>;
    nativePlan(request: { sessionId: string }): Promise<RemoteResult<NativePlanState>>;
    nativeImplementPlan(request: NativeImplementPlan): Promise<RemoteResult<NativePlanReceipt>>;
    resumeSession(request: { sessionId: string }): Promise<RemoteResult<{ sessionId: string }>>;
    nativeCancel(request: NativeQueueRequest): Promise<RemoteResult<HapiCancelResult>>;
    nativeSteer(request: NativeQueueRequest): Promise<RemoteResult<HapiSteerResult>>;
    nativeRetry(request: NativeQueueRequest): Promise<RemoteResult<HapiRetryResult>>;
    nativeAnswer(request: NativeAnswerRequest): Promise<RemoteResult<{ submitted: true }>>;
    nativeSettings(request: { sessionId: string }): Promise<RemoteResult<NativeSettings>>;
    nativeApplySetting(request: NativeApplySetting): Promise<RemoteResult<NativeSettingReceipt>>;
    nativeForkState(request: { sessionId: string }): Promise<RemoteResult<NativeForkState>>;
    nativeFork(request: NativeForkRequest): Promise<RemoteResult<NativeForkView>>;
    nativeForkOperation(request: NativeForkOperationRequest): Promise<RemoteResult<NativeForkView>>;
    nativeForkClose(request: NativeForkCloseRequest): Promise<RemoteResult<NativeForkCloseResult>>;
    workspaceGet(): Promise<RemoteResult<WorkspaceDocument>>;
    workspacePut(request: WorkspaceWrite): Promise<RemoteResult<WorkspaceWriteResult>>;
}

declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { hapi: HapiRemoteApi }
    interface TypertRemoteMap {
        'hapi/catalog': HapiRemoteApi['catalog'];
        'hapi/machineOptions': HapiRemoteApi['machineOptions'];
        'hapi/createSession': HapiRemoteApi['createSession'];
        'hapi/nativeCreations': HapiRemoteApi['nativeCreations'];
        'hapi/nativeCreationOperation': HapiRemoteApi['nativeCreationOperation'];
        'hapi/nativePlan': HapiRemoteApi['nativePlan'];
        'hapi/nativeImplementPlan': HapiRemoteApi['nativeImplementPlan'];
        'hapi/resumeSession': HapiRemoteApi['resumeSession'];
        'hapi/nativeCancel': HapiRemoteApi['nativeCancel'];
        'hapi/nativeSteer': HapiRemoteApi['nativeSteer'];
        'hapi/nativeRetry': HapiRemoteApi['nativeRetry'];
        'hapi/nativeAnswer': HapiRemoteApi['nativeAnswer'];
        'hapi/nativeSettings': HapiRemoteApi['nativeSettings'];
        'hapi/nativeApplySetting': HapiRemoteApi['nativeApplySetting'];
        'hapi/nativeForkState': HapiRemoteApi['nativeForkState'];
        'hapi/nativeFork': HapiRemoteApi['nativeFork'];
        'hapi/nativeForkOperation': HapiRemoteApi['nativeForkOperation'];
        'hapi/nativeForkClose': HapiRemoteApi['nativeForkClose'];
        'hapi/workspaceGet': HapiRemoteApi['workspaceGet'];
        'hapi/workspacePut': HapiRemoteApi['workspacePut'];
    }
    interface RemoteErrorDetailsMap {
        'hapi/request': { outcome: 'rejected' | 'indeterminate'; status?: number; sourceCode?: string };
    }
}

const id = z.string().min(1).max(512);
const queueRequest = z.strictObject({ sessionId: id, localId: id });
const sessionRequest = z.strictObject({ sessionId: id });
const workspaceState = z.unknown().transform((value, context) => {
    try { return parseWorkspaceState(value); }
    catch { context.addIssue({ code: 'custom', message: 'Invalid workspace document' }); return z.NEVER; }
});
const workspaceDocument = z.object({ revision: z.number().int().nonnegative(), state: workspaceState.nullable() });
const looseJson = z.json();
const inputs: Partial<Record<keyof HapiRemoteApi, z.ZodType>> = {
    machineOptions: z.strictObject({ machineId: id }),
    createSession: createNativeSessionSchema,
    nativeCreationOperation: nativeCreationOperationSchema,
    nativePlan: sessionRequest, nativeImplementPlan: nativeImplementPlanSchema,
    resumeSession: sessionRequest,
    nativeCancel: queueRequest, nativeSteer: queueRequest, nativeRetry: queueRequest,
    nativeSettings: sessionRequest, nativeApplySetting: nativeApplySettingSchema,
    nativeForkState: sessionRequest, nativeFork: nativeForkRequestSchema,
    nativeForkOperation: nativeForkOperationRequestSchema, nativeForkClose: nativeForkCloseRequestSchema,
    nativeAnswer: z.strictObject({
        sessionId: id, requestId: id, deny: z.boolean().optional(),
        answer: z.strictObject({
            decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
            mode: z.string().max(100).optional(), allowTools: z.array(z.string().max(1024)).max(128).optional(),
            answers: z.union([z.record(z.string(), z.array(z.string())), z.record(z.string(), z.object({ answers: z.array(z.string()) }))]).optional(),
        }),
    }),
    workspacePut: z.strictObject({ expectedRevision: z.number().int().nonnegative(), state: workspaceState, operationId: id }),
};
const outputs: Record<keyof HapiRemoteApi, z.ZodType> = {
    catalog: z.object({
        hubId: id, connected: z.boolean(),
        machines: z.array(z.object({ id, label: z.string(), online: z.boolean() })),
        sessions: z.array(z.object({ id, logicalSessionId: id, displayRevision: z.number().int().nonnegative(), hapiSessionId: id, machineId: id.nullable(), engine: z.literal('codex'), title: z.string(), cwd: z.string() })),
        hosts: z.array(z.object({ id, label: z.string(), online: z.boolean(), basePath: z.string() })),
    }),
    machineOptions: z.object({
        homes: z.array(z.object({ id, name: z.string(), path: z.string() })),
        models: z.array(z.object({ id, name: z.string(), reasoningEfforts: z.array(z.string()) })), warnings: z.array(z.string()),
    }),
    createSession: sessionRequest, resumeSession: sessionRequest,
    nativeCreations: z.array(nativeCreationStateSchema), nativeCreationOperation: nativeCreationStateSchema,
    nativePlan: nativePlanStateSchema, nativeImplementPlan: nativePlanReceiptSchema,
    nativeCancel: looseJson, nativeSteer: looseJson, nativeRetry: looseJson,
    nativeAnswer: z.object({ submitted: z.literal(true) }),
    nativeSettings: nativeSettingsSchema, nativeApplySetting: nativeSettingReceiptSchema,
    nativeForkState: nativeForkStateSchema, nativeFork: nativeForkViewSchema,
    nativeForkOperation: nativeForkViewSchema, nativeForkClose: nativeForkCloseResultSchema,
    workspaceGet: workspaceDocument,
    workspacePut: workspaceDocument.extend({ status: z.enum(['applied', 'conflict']) }),
};
const codec = (name: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: `hapi-dsh#${name}`, create: () => schema });
export const HAPI_REMOTE: TypertRemoteContribution = {
    package: 'hapi-dsh',
    descriptors: (Object.keys(outputs) as Array<keyof HapiRemoteApi>).map((method): InvocationDescriptor => ({
        id: `hapi-dsh#hapi/${method}`, service: 'hapi', namespace: 'hapi', method,
        invocation: { kind: 'direct' },
        parameters: inputs[method] === undefined ? [] : [{ name: 'request', wire: 'request', source: 'json', codec: codec(`${method}Input`, inputs[method]!) }],
        result: codec(`${method}Output`, outputs[method]),
    })),
};

export function remoteValue<T>(result: RemoteResult<T>): T {
    if (!result.ok) throw result.error;
    return result.value;
}
