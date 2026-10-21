/** Shared, browser-safe API contract. Every method is carried by the official DSH Typert gateway. */
import { z } from 'zod';
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { HapiApprovalAnswer, HapiCancelResult, HapiSteerResult, HapiRetryResult } from './codex/contracts.ts';
import { deliveryViewSchema, type DeliveryView } from './codex/projection-types.ts';
import { parseWorkspaceState, type WorkspaceState } from './client/model.ts';
import { legacyWorkspaceSnapshotSchema, type LegacyWorkspaceSnapshot } from './legacy-workspace-types.ts';
export type * from './legacy-workspace-types.ts';
import { nativeLibraryInputs, nativeLibraryOutputs, type NativeLibraryApi } from './native-library-types.ts';
import { workbenchInputs, workbenchOutputs, type NativeWorkbenchApi } from './workbench-types.ts';
import { sessionExtrasInputs, sessionExtrasOutputs, type SessionExtrasApi } from './session-extras-types.ts';
export type * from './native-library-types.ts';
export type * from './workbench-types.ts';
export type * from './session-extras-types.ts';
export type * from './source-collaboration-types.ts';
import {
    observedApplySettingSchema, observedSettingReadSchema, observedSettingReceiptSchema, observedSettingsSchema,
    type ObservedApplySetting, type ObservedSettingRead, type ObservedSettingReceipt, type ObservedSettings,
} from './hapi-agent/control-types.ts';
export type * from './hapi-agent/control-types.ts';
import { sourceDshChildReadSchema, sourceDshChildInterruptSchema, sourceDshChildStateSchema,
    type SourceDshChildRead, type SourceDshChildInterrupt, type SourceDshChildState } from './hapi-agent/dsh-child-types.ts';
export type * from './hapi-agent/dsh-child-types.ts';
import { sourceQueuedEditRequestSchema, sourceQueuedEditReadSchema, sourceQueuedEditReceiptSchema, sourceQueuedEditReceiptsSchema,
    type SourceQueuedEditRequest, type SourceQueuedEditRead, type SourceQueuedEditReceipt } from './codex/queued-edit-types.ts';
export type * from './codex/queued-edit-types.ts';
import {
    createSourceSessionSchema, sourceCreationStateSchema, sourceCreationOperationSchema,
    type CreateSourceSession, type SourceCreationState, type SourceCreationOperation,
} from './hapi-agent/creation-types.ts';
export type * from './hapi-agent/creation-types.ts';
import { sourceMachineOptionsRequestSchema, sourceMachineOptionsSchema, sourceMachineHealthSchema, type SourceMachineHealth, type SourceMachineOptionsRequest, type SourceMachineOptions } from './source-machine-types.ts';
export type * from './source-machine-types.ts';
import { sourceDirectoryRequestSchema, sourceDirectorySchema, sourcePathsRequestSchema, sourcePathsSchema, type SourceDirectoryRequest, type SourceDirectory, type SourcePathsRequest, type SourcePaths } from './source-directory-types.ts';
export type * from './source-directory-types.ts';
import { sourceInitialTaskInputs, sourceInitialTaskOutputs, type SourceInitialTaskApi } from './hapi-agent/initial-task-types.ts';
export type * from './hapi-agent/initial-task-types.ts';
import { sourceHistoryInputs, sourceHistoryOutputs, type SourceHistoryApi } from './hapi-agent/history-types.ts';
export type * from './hapi-agent/history-types.ts';
import { sourceAdminInputs, sourceAdminOutputs, type SourceAdminApi } from './source-admin-types.ts';
import { sourceCompanionInputs, sourceCompanionOutputs, type SourceCompanionApi } from './source-companion-types.ts';
import { legacyTerminalInputs, legacyTerminalOutputs, type LegacyTerminalApi } from './legacy-terminal-types.ts';
export type * from './legacy-terminal-types.ts';
import { legacyTerminalTextInputs, legacyTerminalTextOutputs, type LegacyTerminalTextApi } from './legacy-terminal-text-types.ts';
export type * from './legacy-terminal-text-types.ts';
export type * from './source-admin-types.ts';
import { voiceInputs, voiceOutputs, type SourceVoiceApi } from './voice-types.ts';
export type * from './voice-types.ts';
import { notificationInputs, notificationOutputs, type SourceNotificationsApi } from './notification-types.ts';
export type * from './notification-types.ts';
import { sourceSessionToolsSchema, sourceOperationSchema, sourceOperationReadSchema, sourceOperationReceiptSchema,
    type SourceSessionTools, type SourceOperation, type SourceOperationRead, type SourceOperationReceipt } from './hapi-agent/lifecycle-types.ts';
export type * from './hapi-agent/lifecycle-types.ts';
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

export interface CatalogMachine {
    id: string; label: string; online: boolean; homeDir?: string; workspaceRoots?: string[];
    host?: string; platform?: string; version?: string; lastSeenAt?: number; health?: SourceMachineHealth | null;
}
export interface CatalogSession {
    id: string; logicalSessionId: string; displayRevision: number; hapiSessionId: string; machineId: string | null; engine: string; title: string; cwd: string;
    updatedAt?: number; active?: boolean; lifecycleState?: string | null; pinMode?: 'none' | 'project' | 'global';
    sourceCreatedAt?: number | null;
    sourceLastActiveAt?: number | null;
    sourceSummary?: string | null;
    sourceWorktree?: { name: string; basePath: string; worktreePath?: string; branch?: string } | null;
    sourceSubagentSearch?: string[];
    sourceListFacts?: {
        metadataPresent: boolean; flavor: string | null; agentSessionId: string | null; codexStoreId: string | null;
        hasTitleSignal: boolean; hasConversationContent: boolean | null;
    };
    sourceRowState?: {
        todoProgress: { completed: number; total: number } | null;
        futureScheduledMessageCount: number | null; nextScheduledAt: number | null;
        serviceTier: string | null; backgroundTaskCount: number | null; pendingRequestsCount: number | null;
    };
}
export interface FederationHost { id: string; label: string; online: boolean; basePath: string }
export interface HapiCatalog { hubId: string; connected: boolean; machines: CatalogMachine[]; sessions: CatalogSession[]; hosts: FederationHost[] }
export interface MachineOptions {
    homes: Array<{ id: string; name: string; path: string; official?: boolean }>;
    models: Array<{ id: string; name: string; reasoningEfforts: string[] }>;
    accounts?: Array<{ id: string; label: string; email: string | null; enabled: boolean }>;
    keyProfiles?: Array<{ id: string; label: string; homeId?: string }>;
    warnings: string[];
}
export interface WorkspaceDocument { revision: number; state: WorkspaceState | null }
export interface WorkspaceWrite { expectedRevision: number; state: WorkspaceState; operationId: string }
export interface WorkspaceWriteResult extends WorkspaceDocument { status: 'applied' | 'conflict' }
export interface NativeQueueRequest { sessionId: string; localId: string }
export interface NativeAnswerRequest { sessionId: string; requestId: string; answer: HapiApprovalAnswer; deny?: boolean }
export interface HapiRemoteApi extends NativeLibraryApi, NativeWorkbenchApi, SessionExtrasApi, SourceInitialTaskApi, SourceHistoryApi, SourceAdminApi, SourceCompanionApi, LegacyTerminalApi, LegacyTerminalTextApi, SourceVoiceApi, SourceNotificationsApi {
    catalog(): Promise<RemoteResult<HapiCatalog>>;
    sourceSessionResolve(request: { hubId: string; sourceSessionId: string }): Promise<RemoteResult<{ hubId: string; sourceSessionId: string; sessionId: string }>>;
    machineOptions(request: { machineId: string }): Promise<RemoteResult<MachineOptions>>;
    sourceMachineOptions(request: SourceMachineOptionsRequest): Promise<RemoteResult<SourceMachineOptions>>;
    sourceMachineDirectory(request: SourceDirectoryRequest): Promise<RemoteResult<SourceDirectory>>;
    sourceMachinePaths(request: SourcePathsRequest): Promise<RemoteResult<SourcePaths>>;
    sourceSessionTools(request: { sessionId: string }): Promise<RemoteResult<SourceSessionTools>>;
    sourceOperation(request: SourceOperation): Promise<RemoteResult<SourceOperationReceipt>>;
    sourceOperationRead(request: SourceOperationRead): Promise<RemoteResult<SourceOperationReceipt>>;
    sourceDshChild(request: SourceDshChildRead): Promise<RemoteResult<SourceDshChildState>>;
    sourceDshChildRefresh(request: SourceDshChildRead): Promise<RemoteResult<SourceDshChildState>>;
    sourceDshChildInterrupt(request: SourceDshChildInterrupt): Promise<RemoteResult<SourceDshChildState>>;
    sourceQueuedEdit(request: SourceQueuedEditRequest): Promise<RemoteResult<SourceQueuedEditReceipt>>;
    sourceQueuedEditRead(request: SourceQueuedEditRead): Promise<RemoteResult<SourceQueuedEditReceipt | null>>;
    sourceQueuedEdits(request: { sessionId: string }): Promise<RemoteResult<SourceQueuedEditReceipt[]>>;
    createSession(request: CreateNativeSession): Promise<RemoteResult<{ sessionId: string }>>;
    nativeCreations(): Promise<RemoteResult<NativeCreationState[]>>;
    nativeCreationOperation(request: NativeCreationOperation): Promise<RemoteResult<NativeCreationState>>;
    createSourceSession(request: CreateSourceSession): Promise<RemoteResult<SourceCreationState>>;
    sourceCreations(): Promise<RemoteResult<SourceCreationState[]>>;
    sourceCreationOperation(request: SourceCreationOperation): Promise<RemoteResult<SourceCreationState>>;
    nativePlan(request: { sessionId: string }): Promise<RemoteResult<NativePlanState>>;
    nativeImplementPlan(request: NativeImplementPlan): Promise<RemoteResult<NativePlanReceipt>>;
    resumeSession(request: { sessionId: string }): Promise<RemoteResult<{ sessionId: string }>>;
    nativeCancel(request: NativeQueueRequest): Promise<RemoteResult<HapiCancelResult>>;
    nativeSteer(request: NativeQueueRequest): Promise<RemoteResult<HapiSteerResult>>;
    nativeRetry(request: NativeQueueRequest): Promise<RemoteResult<HapiRetryResult>>;
    nativeAnswer(request: NativeAnswerRequest): Promise<RemoteResult<{ submitted: true }>>;
    nativeSchedule(request: { sessionId: string; operationId: string; text: string; scheduledAt: number }): Promise<RemoteResult<DeliveryView>>;
    nativeScheduleRead(request: { sessionId: string; operationId: string }): Promise<RemoteResult<DeliveryView | null>>;
    sourceLocateMessage(request: { sessionId: string; sourceMessageId: string }): Promise<RemoteResult<{ sessionId: string; seq: number | null }>>;
    nativeSettings(request: { sessionId: string }): Promise<RemoteResult<NativeSettings>>;
    nativeApplySetting(request: NativeApplySetting): Promise<RemoteResult<NativeSettingReceipt>>;
    observedSettings(request: { sessionId: string }): Promise<RemoteResult<ObservedSettings>>;
    observedApplySetting(request: ObservedApplySetting): Promise<RemoteResult<ObservedSettingReceipt>>;
    observedSetting(request: ObservedSettingRead): Promise<RemoteResult<ObservedSettingReceipt>>;
    nativeForkState(request: { sessionId: string }): Promise<RemoteResult<NativeForkState>>;
    nativeFork(request: NativeForkRequest): Promise<RemoteResult<NativeForkView>>;
    nativeForkOperation(request: NativeForkOperationRequest): Promise<RemoteResult<NativeForkView>>;
    nativeForkClose(request: NativeForkCloseRequest): Promise<RemoteResult<NativeForkCloseResult>>;
    workspaceGet(): Promise<RemoteResult<WorkspaceDocument>>;
    workspaceLegacy(): Promise<RemoteResult<LegacyWorkspaceSnapshot>>;
    workspacePut(request: WorkspaceWrite): Promise<RemoteResult<WorkspaceWriteResult>>;
}

declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { hapi: HapiRemoteApi }
    interface TypertRemoteMap {
        'hapi/catalog': HapiRemoteApi['catalog'];
        'hapi/sourceSessionResolve': HapiRemoteApi['sourceSessionResolve'];
        'hapi/machineOptions': HapiRemoteApi['machineOptions'];
        'hapi/sourceMachineOptions': HapiRemoteApi['sourceMachineOptions'];
        'hapi/sourceMachineDirectory': HapiRemoteApi['sourceMachineDirectory'];
        'hapi/sourceMachinePaths': HapiRemoteApi['sourceMachinePaths'];
        'hapi/sourceInitialTask': HapiRemoteApi['sourceInitialTask'];
        'hapi/sourceInitialTaskRead': HapiRemoteApi['sourceInitialTaskRead'];
        'hapi/sourceInitialTaskRetry': HapiRemoteApi['sourceInitialTaskRetry'];
        'hapi/sourceInitialTasks': HapiRemoteApi['sourceInitialTasks'];
        'hapi/sourceHistoryPi': HapiRemoteApi['sourceHistoryPi'];
        'hapi/sourceHistoryTools': HapiRemoteApi['sourceHistoryTools'];
        'hapi/sourceHistoryOperation': HapiRemoteApi['sourceHistoryOperation'];
        'hapi/sourceHistoryOperationRead': HapiRemoteApi['sourceHistoryOperationRead'];
        'hapi/sourceHistoryContinue': HapiRemoteApi['sourceHistoryContinue'];
        'hapi/sourceAdministration': HapiRemoteApi['sourceAdministration'];
        'hapi/sourceCompanionInfo': HapiRemoteApi['sourceCompanionInfo'];
        'hapi/sourceCompanionReveal': HapiRemoteApi['sourceCompanionReveal'];
        'hapi/sourceLegacyTerminalOpen': HapiRemoteApi['sourceLegacyTerminalOpen'];
        'hapi/sourceLegacyTerminalRead': HapiRemoteApi['sourceLegacyTerminalRead'];
        'hapi/sourceLegacyTerminals': HapiRemoteApi['sourceLegacyTerminals'];
        'hapi/sourceLegacyTerminalText': HapiRemoteApi['sourceLegacyTerminalText'];
        'hapi/sourceSessionBulk': HapiRemoteApi['sourceSessionBulk'];
        'hapi/sourceSessionBulkRead': HapiRemoteApi['sourceSessionBulkRead'];
        'hapi/sourceSummarySettings': HapiRemoteApi['sourceSummarySettings'];
        'hapi/sourceVoiceCapabilities': HapiRemoteApi['sourceVoiceCapabilities'];
        'hapi/sourceVoiceCredentials': HapiRemoteApi['sourceVoiceCredentials'];
        'hapi/sourceVoiceUpdateCredentials': HapiRemoteApi['sourceVoiceUpdateCredentials'];
        'hapi/sourceVoiceVoices': HapiRemoteApi['sourceVoiceVoices'];
        'hapi/sourceVoiceToken': HapiRemoteApi['sourceVoiceToken'];
        'hapi/sourceVoiceRealtimeToken': HapiRemoteApi['sourceVoiceRealtimeToken'];
        'hapi/sourceVoiceContext': HapiRemoteApi['sourceVoiceContext'];
        'hapi/sourceNotificationSettings': HapiRemoteApi['sourceNotificationSettings'];
        'hapi/sourcePushSubscribe': HapiRemoteApi['sourcePushSubscribe'];
        'hapi/sourcePushUnsubscribe': HapiRemoteApi['sourcePushUnsubscribe'];
        'hapi/sourceAdminStorage': HapiRemoteApi['sourceAdminStorage'];
        'hapi/sourceAdminUsage': HapiRemoteApi['sourceAdminUsage'];
        'hapi/sourceAdminBundles': HapiRemoteApi['sourceAdminBundles'];
        'hapi/sourceAdminOperation': HapiRemoteApi['sourceAdminOperation'];
        'hapi/sourceAdminOperationRead': HapiRemoteApi['sourceAdminOperationRead'];
        'hapi/sourceSessionTools': HapiRemoteApi['sourceSessionTools'];
        'hapi/sourceOperation': HapiRemoteApi['sourceOperation'];
        'hapi/sourceOperationRead': HapiRemoteApi['sourceOperationRead'];
        'hapi/sourceDshChild': HapiRemoteApi['sourceDshChild'];
        'hapi/sourceDshChildRefresh': HapiRemoteApi['sourceDshChildRefresh'];
        'hapi/sourceDshChildInterrupt': HapiRemoteApi['sourceDshChildInterrupt'];
        'hapi/sourceQueuedEdit': HapiRemoteApi['sourceQueuedEdit'];
        'hapi/sourceQueuedEditRead': HapiRemoteApi['sourceQueuedEditRead'];
        'hapi/sourceQueuedEdits': HapiRemoteApi['sourceQueuedEdits'];
        'hapi/createSession': HapiRemoteApi['createSession'];
        'hapi/nativeCreations': HapiRemoteApi['nativeCreations'];
        'hapi/nativeCreationOperation': HapiRemoteApi['nativeCreationOperation'];
        'hapi/createSourceSession': HapiRemoteApi['createSourceSession'];
        'hapi/sourceCreations': HapiRemoteApi['sourceCreations'];
        'hapi/sourceCreationOperation': HapiRemoteApi['sourceCreationOperation'];
        'hapi/nativePlan': HapiRemoteApi['nativePlan'];
        'hapi/nativeImplementPlan': HapiRemoteApi['nativeImplementPlan'];
        'hapi/resumeSession': HapiRemoteApi['resumeSession'];
        'hapi/nativeCancel': HapiRemoteApi['nativeCancel'];
        'hapi/nativeSteer': HapiRemoteApi['nativeSteer'];
        'hapi/nativeRetry': HapiRemoteApi['nativeRetry'];
        'hapi/nativeAnswer': HapiRemoteApi['nativeAnswer'];
        'hapi/nativeSchedule': HapiRemoteApi['nativeSchedule'];
        'hapi/nativeScheduleRead': HapiRemoteApi['nativeScheduleRead'];
        'hapi/sourceLocateMessage': HapiRemoteApi['sourceLocateMessage'];
        'hapi/nativeSettings': HapiRemoteApi['nativeSettings'];
        'hapi/nativeApplySetting': HapiRemoteApi['nativeApplySetting'];
        'hapi/observedSettings': HapiRemoteApi['observedSettings'];
        'hapi/observedApplySetting': HapiRemoteApi['observedApplySetting'];
        'hapi/observedSetting': HapiRemoteApi['observedSetting'];
        'hapi/nativeForkState': HapiRemoteApi['nativeForkState'];
        'hapi/nativeFork': HapiRemoteApi['nativeFork'];
        'hapi/nativeForkOperation': HapiRemoteApi['nativeForkOperation'];
        'hapi/nativeForkClose': HapiRemoteApi['nativeForkClose'];
        'hapi/workspaceGet': HapiRemoteApi['workspaceGet'];
        'hapi/workspaceLegacy': HapiRemoteApi['workspaceLegacy'];
        'hapi/workspacePut': HapiRemoteApi['workspacePut'];
        'hapi/nativeLibrary': HapiRemoteApi['nativeLibrary'];
        'hapi/nativeConnect': HapiRemoteApi['nativeConnect'];
        'hapi/nativeImport': HapiRemoteApi['nativeImport'];
        'hapi/nativeSessionTools': HapiRemoteApi['nativeSessionTools'];
        'hapi/nativeSourceOperation': HapiRemoteApi['nativeSourceOperation'];
        'hapi/nativeOperation': HapiRemoteApi['nativeOperation'];
        'hapi/nativeMachineState': HapiRemoteApi['nativeMachineState'];
        'hapi/nativeMachineOperation': HapiRemoteApi['nativeMachineOperation'];
        'hapi/nativeDeviceLogin': HapiRemoteApi['nativeDeviceLogin'];
        'hapi/sourceReadStates': HapiRemoteApi['sourceReadStates'];
        'hapi/sourceReadStateWrite': HapiRemoteApi['sourceReadStateWrite'];
        'hapi/nativeDirectory': HapiRemoteApi['nativeDirectory'];
        'hapi/nativeFileSearch': HapiRemoteApi['nativeFileSearch'];
        'hapi/nativeGit': HapiRemoteApi['nativeGit'];
        'hapi/nativeDocument': HapiRemoteApi['nativeDocument'];
        'hapi/nativeTerminalText': HapiRemoteApi['nativeTerminalText'];
        'hapi/nativeFileSave': HapiRemoteApi['nativeFileSave'];
        'hapi/nativeFileInspect': HapiRemoteApi['nativeFileInspect'];
        'hapi/nativeFileManage': HapiRemoteApi['nativeFileManage'];
        'hapi/nativeFileUpload': HapiRemoteApi['nativeFileUpload'];
        'hapi/nativePreview': HapiRemoteApi['nativePreview'];
        'hapi/sourceNotes': HapiRemoteApi['sourceNotes'];
        'hapi/sourceNoteWrite': HapiRemoteApi['sourceNoteWrite'];
        'hapi/sourceNoteUpload': HapiRemoteApi['sourceNoteUpload'];
        'hapi/sourceOutline': HapiRemoteApi['sourceOutline'];
        'hapi/sourceMessageContext': HapiRemoteApi['sourceMessageContext'];
        'hapi/sourceExport': HapiRemoteApi['sourceExport'];
        'hapi/sourceSkills': HapiRemoteApi['sourceSkills'];
        'hapi/sourceTitleTools': HapiRemoteApi['sourceTitleTools'];
        'hapi/sourceTitleSuggestion': HapiRemoteApi['sourceTitleSuggestion'];
        'hapi/sourceWorkGraph': HapiRemoteApi['sourceWorkGraph'];
        'hapi/sourceWorkGraphLinks': HapiRemoteApi['sourceWorkGraphLinks'];
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
    ...nativeLibraryInputs, ...workbenchInputs, ...sessionExtrasInputs, ...sourceInitialTaskInputs, ...sourceHistoryInputs, ...sourceAdminInputs, ...sourceCompanionInputs, ...legacyTerminalInputs, ...legacyTerminalTextInputs, ...voiceInputs, ...notificationInputs,
    machineOptions: z.strictObject({ machineId: id }),
    sourceSessionResolve: z.strictObject({ hubId: id, sourceSessionId: id }),
    sourceMachineOptions: sourceMachineOptionsRequestSchema,
    sourceMachineDirectory: sourceDirectoryRequestSchema, sourceMachinePaths: sourcePathsRequestSchema,
    sourceSessionTools: sessionRequest, sourceOperation: sourceOperationSchema, sourceOperationRead: sourceOperationReadSchema,
    sourceDshChild: sourceDshChildReadSchema, sourceDshChildRefresh: sourceDshChildReadSchema, sourceDshChildInterrupt: sourceDshChildInterruptSchema,
    sourceQueuedEdit: sourceQueuedEditRequestSchema, sourceQueuedEditRead: sourceQueuedEditReadSchema, sourceQueuedEdits: sessionRequest,
    createSession: createNativeSessionSchema,
    nativeCreationOperation: nativeCreationOperationSchema,
    createSourceSession: createSourceSessionSchema, sourceCreationOperation: sourceCreationOperationSchema,
    nativePlan: sessionRequest, nativeImplementPlan: nativeImplementPlanSchema,
    resumeSession: sessionRequest,
    nativeCancel: queueRequest, nativeSteer: queueRequest, nativeRetry: queueRequest,
    nativeSchedule: z.strictObject({ sessionId: id, operationId: z.string().uuid(), text: z.string().trim().min(1).max(1_000_000), scheduledAt: z.number().int().positive() }),
    nativeScheduleRead: z.strictObject({ sessionId: id, operationId: z.string().uuid() }),
    sourceLocateMessage: z.strictObject({ sessionId: id, sourceMessageId: id }),
    nativeSettings: sessionRequest, nativeApplySetting: nativeApplySettingSchema,
    observedSettings: sessionRequest, observedApplySetting: observedApplySettingSchema, observedSetting: observedSettingReadSchema,
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
    ...nativeLibraryOutputs, ...workbenchOutputs, ...sessionExtrasOutputs, ...sourceInitialTaskOutputs, ...sourceHistoryOutputs, ...sourceAdminOutputs, ...sourceCompanionOutputs, ...legacyTerminalOutputs, ...legacyTerminalTextOutputs, ...voiceOutputs, ...notificationOutputs,
    catalog: z.object({
        hubId: id, connected: z.boolean(),
        machines: z.array(z.object({ id, label: z.string(), online: z.boolean(), homeDir: z.string().optional(), workspaceRoots: z.array(z.string()).optional(),
            host: z.string().optional(), platform: z.string().optional(), version: z.string().optional(), lastSeenAt: z.number().finite().optional(), health: sourceMachineHealthSchema.nullable().optional() })),
        sessions: z.array(z.object({ id, logicalSessionId: id, displayRevision: z.number().int().nonnegative(), hapiSessionId: id, machineId: id.nullable(), engine: z.string(), title: z.string(), cwd: z.string(), updatedAt: z.number().finite().optional(), active: z.boolean().optional(), lifecycleState: z.string().nullable().optional(), pinMode: z.enum(['none', 'project', 'global']).default('none'),
            sourceCreatedAt: z.number().finite().nullable().optional(), sourceLastActiveAt: z.number().finite().nullable().optional(), sourceSummary: z.string().nullable().optional(), sourceWorktree: z.object({ name: z.string(), basePath: z.string(), worktreePath: z.string().optional(), branch: z.string().optional() }).nullable().optional(), sourceSubagentSearch: z.array(z.string()).optional(),
            sourceListFacts: z.strictObject({ metadataPresent: z.boolean(), flavor: z.string().nullable(), agentSessionId: z.string().nullable(), codexStoreId: z.string().nullable(), hasTitleSignal: z.boolean(), hasConversationContent: z.boolean().nullable() }).optional(),
            sourceRowState: z.object({ todoProgress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).nullable(),
                futureScheduledMessageCount: z.number().int().nonnegative().nullable(), nextScheduledAt: z.number().finite().nullable(), serviceTier: z.string().nullable(),
                backgroundTaskCount: z.number().int().nonnegative().nullable(), pendingRequestsCount: z.number().int().nonnegative().nullable() }).optional() })),
        hosts: z.array(z.object({ id, label: z.string(), online: z.boolean(), basePath: z.string() })),
    }),
    machineOptions: z.object({
        homes: z.array(z.object({ id, name: z.string(), path: z.string(), official: z.boolean().optional() })),
        accounts: z.array(z.object({ id, label: z.string(), email: z.string().nullable(), enabled: z.boolean() })).optional(),
        keyProfiles: z.array(z.object({ id, label: z.string(), homeId: z.string().optional() })).optional(),
        models: z.array(z.object({ id, name: z.string(), reasoningEfforts: z.array(z.string()) })), warnings: z.array(z.string()),
    }),
    sourceSessionResolve: z.strictObject({ hubId: id, sourceSessionId: id, sessionId: id }),
    createSession: sessionRequest, resumeSession: sessionRequest,
    sourceMachineOptions: sourceMachineOptionsSchema,
    sourceMachineDirectory: sourceDirectorySchema, sourceMachinePaths: sourcePathsSchema,
    sourceSessionTools: sourceSessionToolsSchema, sourceOperation: sourceOperationReceiptSchema, sourceOperationRead: sourceOperationReceiptSchema,
    sourceDshChild: sourceDshChildStateSchema, sourceDshChildRefresh: sourceDshChildStateSchema, sourceDshChildInterrupt: sourceDshChildStateSchema,
    sourceQueuedEdit: sourceQueuedEditReceiptSchema, sourceQueuedEditRead: sourceQueuedEditReceiptSchema.nullable(), sourceQueuedEdits: sourceQueuedEditReceiptsSchema,
    nativeCreations: z.array(nativeCreationStateSchema), nativeCreationOperation: nativeCreationStateSchema,
    createSourceSession: sourceCreationStateSchema, sourceCreations: z.array(sourceCreationStateSchema), sourceCreationOperation: sourceCreationStateSchema,
    nativePlan: nativePlanStateSchema, nativeImplementPlan: nativePlanReceiptSchema,
    nativeCancel: looseJson, nativeSteer: looseJson, nativeRetry: looseJson,
    nativeAnswer: z.object({ submitted: z.literal(true) }),
    nativeSchedule: deliveryViewSchema,
    nativeScheduleRead: deliveryViewSchema.nullable(),
    sourceLocateMessage: z.object({ sessionId: id, seq: z.number().int().nonnegative().nullable() }),
    nativeSettings: nativeSettingsSchema, nativeApplySetting: nativeSettingReceiptSchema,
    observedSettings: observedSettingsSchema, observedApplySetting: observedSettingReceiptSchema, observedSetting: observedSettingReceiptSchema,
    nativeForkState: nativeForkStateSchema, nativeFork: nativeForkViewSchema,
    nativeForkOperation: nativeForkViewSchema, nativeForkClose: nativeForkCloseResultSchema,
    workspaceGet: workspaceDocument,
    workspaceLegacy: legacyWorkspaceSnapshotSchema,
    workspacePut: workspaceDocument.extend({ status: z.enum(['applied', 'conflict']) }),
};
const codec = (name: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: `hapi-dsh#${name}`, create: () => schema });
export const HAPI_REMOTE: TypertRemoteContribution = {
    package: 'hapi-dsh',
    descriptors: (Object.keys(outputs) as Array<keyof HapiRemoteApi>).map((method): InvocationDescriptor => ({
        id: `hapi-dsh#hapi/${method}`, service: 'hapi', namespace: 'hapi', method,
        invocation: { kind: 'direct' },
        ...(method === 'nativeTerminalText' || method === 'sourceLegacyTerminalOpen' || method === 'sourceLegacyTerminalText' || method in voiceInputs || method in notificationInputs ? { cancellation: { parameter: 'signal' as const } } : {}),
        parameters: inputs[method] === undefined ? [] : [{ name: 'request', wire: 'request', source: 'json', codec: codec(`${method}Input`, inputs[method]!) }],
        result: codec(`${method}Output`, outputs[method]),
    })),
};

export function remoteValue<T>(result: RemoteResult<T>): T {
    if (!result.ok) throw result.error;
    return result.value;
}
