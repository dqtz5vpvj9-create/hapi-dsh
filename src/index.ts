import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import S from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-modules';
import type { SessionRenameValue } from '@deepseek-ai/dsh-api-session-controller/types';
import { TerminalController, type Config as TerminalConfig } from '@deepseek-ai/dsh-api-terminal-controller';
import {
    HAPI_REMOTE, type CreateNativeSession, type HapiCatalog, type MachineOptions,
    type NativeAnswerRequest, type NativeQueueRequest, type WorkspaceWrite, type WorkspaceWriteResult, type WorkspaceDocument,
    type NativeApplySetting, type NativeSettings, type NativeSettingReceipt, type NativeForkRequest, type NativeForkView,
    type NativeForkState, type NativeForkOperationRequest, type NativeForkCloseRequest, type NativeForkCloseResult,
    type NativeCreationState, type NativeCreationOperation,
    type NativeImplementPlan, type NativePlanState, type NativePlanReceipt,
} from './client-api.ts';
import { readConfig, resolveHapiToken, type RuntimeConfig } from './cli/config.ts';
import { HapiClient } from './hapi/client.ts';
import { catalogDisplayMetadata, catalogListFacts, catalogRowState } from './hapi/catalog-metadata.ts';
import { discoverSourceSession } from './hapi/source-discovery.ts';
import type { DeliveryRecoveryRequest } from './codex/delivery-recovery-types.ts';
import { startSourceCatalogs } from './hapi/catalog-startup.ts';
import { SourceSessionResolver, type OriginalSessionRequest } from './hapi/source-session-resolver.ts';
import { HapiRequestError, type HapiCancelResult, type HapiSteerResult, type HapiRetryResult } from './codex/contracts.ts';
import { CodexService, type NativeCodexAgent } from './codex/index.ts';
import { attachmentResolver, artifactImporter, sourceUploadImporter, sourceInlineImporter } from './hapi/attachments.ts';
import { NativeModelMetadata, NATIVE_CODEX_PROVIDER, HAPI_OBSERVED_PROVIDER } from './hapi/model-adapter.ts';
import { HapiAgentService, HapiObservedControl, type HapiObservedAgent } from './hapi-agent/index.ts';
import type { ObservedApplySetting, ObservedSettingRead } from './hapi-agent/control-types.ts';
import type { SourceDshChildRead, SourceDshChildInterrupt } from './hapi-agent/dsh-child-types.ts';
import type { DeliveryView } from './codex/projection-types.ts';
import { NativeControl } from './hapi/native-control.ts';
import { NativeCreation } from './hapi/native-creation.ts';
import { SourceCreation } from './hapi/source-creation.ts';
import { SourceLifecycle } from './hapi/source-lifecycle.ts';
import { SourceInitialTasks } from './hapi/source-initial-task.ts';
import { SourceHistory } from './hapi/source-history.ts';
import { SourceAdministrationService } from './hapi/source-admin.ts';
import { SourceCompanionService } from './hapi/source-companion.ts';
import type { SourceCompanionReveal } from './source-companion-types.ts';
import { mountSourceBackup } from './hapi/source-backup.ts';
import { SourceVoiceService } from './hapi/source-voice.ts';
import type { VoiceRequest } from './voice-types.ts';
import { SourceNotificationsService } from './hapi/source-notifications.ts';
import { mountShareTarget } from './hapi/share-target.ts';
import { SourceBulkActions } from './hapi/source-bulk.ts';
import type { SourceBulkOperation } from './source-bulk-types.ts';
import { SourceQueuedEdits } from './hapi/queued-edit.ts';
import type { SourceQueuedEditRequest, SourceQueuedEditRead } from './codex/queued-edit-types.ts';
import type { NotificationRequest } from './notification-types.ts';
import type { SourceAdminOperation, SourceUsageRequest } from './source-admin-types.ts';
import type { SourceHistoryPi, SourceHistoryOperation, SourceHistoryRead } from './hapi-agent/history-types.ts';
import type { SourceInitialTask, SourceInitialTaskRead, SourceInitialTasks as SourceInitialTasksQuery } from './hapi-agent/initial-task-types.ts';
import type { SourceOperation, SourceOperationRead } from './hapi-agent/lifecycle-types.ts';
import { sourceMachineOptions } from './hapi/source-machine-options.ts';
import { nativeLaunchOptions } from './hapi/native-launch-options.ts';
import { sourceDirectory, sourcePaths } from './hapi/source-directories.ts';
import type { SourceDirectoryRequest, SourcePathsRequest } from './source-directory-types.ts';
import type { SourceMachineOptionsRequest } from './source-machine-types.ts';
import { catalogSourceMachine } from './hapi/source-machines.ts';
import type { CreateSourceSession, SourceCreationOperation } from './hapi-agent/creation-types.ts';
import { NativePlan } from './hapi/native-plan.ts';
import { NativeLibrary } from './hapi/native-library.ts';
import type { NativeLibraryRequest } from './native-library-types.ts';
import { NativeWorkbench } from './hapi/workbench.ts';
import { NativeTerminalBridge } from './hapi/terminal.ts';
import { LegacySessionTerminals } from './hapi/legacy-terminals.ts';
import type { LegacyTerminalOpenRequest, LegacyTerminalReadRequest, LegacyTerminalListRequest } from './legacy-terminal-types.ts';
import type { WorkbenchRequest, WorkbenchSource } from './workbench-types.ts';
import { HapiSessionExtras } from './hapi/session-extras.ts';
import { sourceGeneratedMediaImporter } from './hapi/generated-media.ts';
import type { SessionExtrasRequest } from './session-extras-types.ts';
import { WorkspaceRepository } from './hub/workspaces.ts';
import { FederationHub } from './hub/federation.ts';
import { legacyWorkspaceSnapshotSchema, type LegacyWorkspaceSnapshot } from './legacy-workspace-types.ts';
import { mountBootstrapRoute } from './shared/bootstrap.ts';
import { deferWorkspaceEntry, workspaceBootInjections } from './shared/workspace-boot.ts';
import { mountPluginEvents } from './shared/plugin-events.ts';
import { officialProviderConfig } from './shared/official-provider.ts';

export const name = 'hapi-dsh';
export const inject = ['loader', 'agents', 'sessions', 'sessionProjections', 'attachments', 'fileUploads', 'llm', 'typert', 'webServer', 'connection', 'clientModules', 'appReady'];
export interface Config { configFile: string }
export const Config: S<Config> = S.object({ configFile: S.string().required() });

declare module '@deepseek-ai/cordis' { interface Context { hapi: HapiController } }

interface ControllerOptions {
    config: RuntimeConfig;
    client: HapiClient;
    codex: CodexService;
    observed: HapiAgentService;
    observedControl: HapiObservedControl;
    workspace: WorkspaceRepository;
    federation: FederationHub;
    nativeControl: NativeControl;
    nativeCreation: NativeCreation;
    sourceCreation: SourceCreation;
    sourceLifecycle: SourceLifecycle;
    initialTasks: SourceInitialTasks;
    sourceHistory: SourceHistory;
    administration: SourceAdministrationService;
    companion: SourceCompanionService;
    voice: SourceVoiceService;
    notifications: SourceNotificationsService;
    bulk: SourceBulkActions;
    queuedEdits: SourceQueuedEdits;
    nativePlan: NativePlan;
    nativeLibrary: NativeLibrary;
    workbench: NativeWorkbench;
    legacyTerminals: LegacySessionTerminals;
    extras: HapiSessionExtras;
}

/** The native control surface uses DSH's existing Remote registration and access policy. */
export class HapiController extends TypertRemoteService {
    private machineCache: Awaited<ReturnType<HapiClient['listMachines']>> = [];
    private machineCacheAt = 0;
    private machineRead: Promise<void> | undefined;
    private sourceSummaries = new Map<string, Awaited<ReturnType<HapiClient['listSessions']>>[number]>();
    private summaryCacheAt = 0;
    private summaryRead: Promise<void> | undefined;
    private summaryObservedAt: number | null = null;
    private summaryError: string | null = null;
    private readonly sourceResolver: SourceSessionResolver;

    /** Source capabilities for ordinary DSH Host provider composition; not a browser Remote method. */
    get nativeWorkbench(): NativeWorkbench { return this.options.workbench; }
    get legacyTerminals(): LegacySessionTerminals { return this.options.legacyTerminals; }

    nativeTerminalAuthentication(): ReturnType<HapiClient['socketAuthentication']> { return this.options.client.socketAuthentication(); }
    get nativeTerminalStateFile(): string {
        return join(this.options.config.dsh.home, 'profiles', this.options.config.dsh.profile, 'data', 'hapi-dsh', 'native-terminals.json');
    }

    workbenchSource(displaySessionId: string): WorkbenchSource | undefined {
        const sourceOwned = displaySessionId.startsWith('hapi-codex-') || displaySessionId.startsWith('hapi-observed-');
        if (!sourceOwned) return undefined;
        // A retired or unavailable source display must never fall through to
        // the Hub's filesystem, even when its old Session header still exists.
        const agent = this.sourceAgent(displaySessionId);
        if (!agent.binding.machineId) throw new RemoteError('hapi/request', 'The source session has no verified machine.', {
            outcome: 'rejected', status: 409, sourceCode: 'source_unavailable',
        });
        return { sourceSessionId: agent.binding.hapiSessionId, sourceHubId: agent.binding.hubId, machineId: agent.binding.machineId };
    }

    constructor(ctx: Context, private readonly options: ControllerOptions) {
        super(ctx, 'hapi');
        this.sourceResolver = new SourceSessionResolver(options.client, options.codex, options.observed);
        ctx.effect(() => options.client.subscribeCatalog(() => { this.machineCacheAt = 0; this.summaryCacheAt = 0; }), 'hapi-dsh: source catalog invalidation');
        ctx.effect(() => ctx.typert.register({
            package: 'hapi-dsh', face: 'host', schemas: [],
            invocations: HAPI_REMOTE.descriptors,
            model: {
                services: [{ key: 'hapi', exportName: 'HapiController', tags: [], members: [], types: [], summary: 'Native Codex and distributed workspaces.' }],
                events: [], objects: [],
            },
        }), 'hapi-dsh: native Remote methods');
    }

    private async refreshMachines(): Promise<void> {
        if (Date.now() - this.machineCacheAt < 3000) return;
        if (this.machineRead) return this.machineRead;
        this.machineRead = (async () => {
            try { this.machineCache = await this.options.client.listMachines(); }
            catch { /* Retain machine identities during an outage; online state comes from the connection. */ }
            finally { this.machineCacheAt = Date.now(); }
        })();
        try { await this.machineRead; } finally { this.machineRead = undefined; }
    }

    async catalog(): Promise<HapiCatalog> {
        await Promise.all([this.refreshMachines(), this.refreshSourceSummaries()]);
        const client = this.options.client;
        return {
            hubId: client.hubId, connected: client.isConnected,
            sourceDiscovery: {
                phase: this.summaryError || !client.isConnected ? this.summaryObservedAt === null ? 'unavailable' : 'stale' : this.summaryObservedAt === null ? 'pending' : 'ready',
                observedAt: this.summaryObservedAt, error: this.summaryError,
                sessions: [...this.sourceSummaries.values()].map(source => {
                    const row = discoverSourceSession(client.hubId, source,
                        [...this.options.codex.list(), ...this.options.observed.list()].some(agent => agent.binding.hapiSessionId === source.id));
                    const error = this.options.codex.failures().get(source.id) ?? this.options.observed.failures().get(source.id);
                    return !error || row.binding === 'attached' ? row : { ...row, binding: 'failed' as const, error };
                }),
            },
            machines: this.machineCache.map(machine => catalogSourceMachine(machine, client.isConnected)),
            sessions: [...this.options.codex.list(), ...this.options.observed.list()].map(agent => ({
                id: agent.id, logicalSessionId: agent.logicalSessionId, displayRevision: agent.displayRevision,
                hapiSessionId: agent.binding.hapiSessionId, machineId: agent.binding.machineId,
                engine: agent.sourceSession.metadata?.flavor ?? 'claude', title: agent.sourceSession.metadata?.name ?? agent.sourceSession.metadata?.summary?.text ?? agent.binding.hapiSessionId,
                cwd: agent.sourceSession.metadata?.path ?? '', updatedAt: agent.sourceSession.updatedAt,
                sourceCreatedAt: typeof agent.sourceSession.createdAt === 'number' && Number.isFinite(agent.sourceSession.createdAt) ? agent.sourceSession.createdAt : null,
                sourceLastActiveAt: (() => {
                    const source = agent.sourceSession
                    const codex = source.metadata?.flavor === 'codex' ? source.metadata.codexUpdatedAt : undefined
                    const value = (typeof codex === 'number' && Number.isFinite(codex) ? codex : undefined) ?? source.updatedAt ?? source.createdAt
                    return typeof value === 'number' && Number.isFinite(value) ? value : null
                })(),
                active: agent.sourceSession.active,
                lifecycleState: typeof agent.sourceSession.metadata?.lifecycleState === 'string' ? agent.sourceSession.metadata.lifecycleState : null,
                pinMode: agent.sourceSession.globalPinned ? 'global' : agent.sourceSession.pinned ? 'project' : 'none',
                ...catalogDisplayMetadata(agent.sourceSession.metadata),
                sourceRowState: catalogRowState(agent.sourceSession, this.sourceSummaries.get(agent.binding.hapiSessionId)),
                sourceListFacts: catalogListFacts(agent.sourceSession, this.sourceSummaries.get(agent.binding.hapiSessionId)),
            })),
            hosts: this.options.federation.listMachines().map(machine => ({ id: machine.id, label: machine.name, online: machine.online, basePath: machine.baseUrl })),
        };
    }

    private async refreshSourceSummaries(): Promise<void> {
        if (Date.now() - this.summaryCacheAt < 3000) return;
        if (this.summaryRead) return this.summaryRead;
        const work = (async () => {
            try {
                this.sourceSummaries = new Map((await this.options.client.listSessions()).map(session => [session.id, session]));
                this.summaryObservedAt = Date.now(); this.summaryError = null;
            }
            catch (error) { this.summaryError = error instanceof Error ? error.message : 'The source catalog could not be read'; }
            finally { this.summaryCacheAt = Date.now(); }
        })();
        this.summaryRead = work;
        try { await work; } finally { if (this.summaryRead === work) this.summaryRead = undefined; }
    }

    async machineOptions(request: { machineId: string }): Promise<MachineOptions> {
        return nativeLaunchOptions(this.options.client, request.machineId);
    }

    sourceSessionResolve(request: OriginalSessionRequest) { return this.sourceCall(() => this.sourceResolver.resolve(request)); }

    sourceMachineOptions(request: SourceMachineOptionsRequest) { return sourceMachineOptions(this.options.client, request); }
    sourceMachineDirectory(request: SourceDirectoryRequest) { return this.sourceCall(() => sourceDirectory(this.options.client, request)); }
    sourceMachinePaths(request: SourcePathsRequest) { return this.sourceCall(() => sourcePaths(this.options.client, request)); }
    sourceInitialTask(request: SourceInitialTask) { return this.sourceCall(() => this.options.initialTasks.submit(request)); }
    sourceInitialTaskRead(request: SourceInitialTaskRead) { return this.sourceCall(() => this.options.initialTasks.read(request)); }
    sourceInitialTaskRetry(request: SourceInitialTaskRead) { return this.sourceCall(() => this.options.initialTasks.retry(request)); }
    sourceInitialTasks(request: SourceInitialTasksQuery) { return this.sourceCall(async () => this.options.initialTasks.list(request)); }
    sourceHistoryPi(request: SourceHistoryPi) { return this.sourceCall(() => this.options.sourceHistory.pi(request)); }
    sourceHistoryTools(request: { sessionId: string }) { return this.sourceCall(() => this.options.sourceHistory.tools(request.sessionId)); }
    sourceHistoryOperation(request: SourceHistoryOperation) { return this.sourceCall(() => this.options.sourceHistory.operation(request)); }
    sourceHistoryOperationRead(request: SourceHistoryRead) { return this.sourceCall(() => this.options.sourceHistory.read(request)); }
    sourceHistoryContinue(request: SourceHistoryRead) { return this.sourceCall(() => this.options.sourceHistory.continue(request)); }
    sourceAdministration() { return this.sourceCall(() => this.options.administration.overview()); }
    sourceCompanionInfo() { return this.sourceCall(async () => this.options.companion.info(this.ctx.invocation)); }
    sourceCompanionReveal(request: SourceCompanionReveal) { return this.sourceCall(async () => this.options.companion.reveal(this.ctx.invocation, request)); }
    sourceLegacyTerminalOpen(request: LegacyTerminalOpenRequest, signal?: AbortSignal) {
        return this.sourceCall(() => {
            const source = this.legacyTerminalSource(request.sessionId);
            const lifetime = signal ?? this.ctx.invocation?.signal;
            if (!lifetime) throw new RemoteError('hapi/request', 'Opening an original terminal requires an active Remote invocation.', {
                outcome: 'rejected', status: 409, sourceCode: 'source_terminal_call_unavailable',
            });
            return this.options.legacyTerminals.open(request, source, lifetime);
        });
    }
    sourceLegacyTerminalRead(request: LegacyTerminalReadRequest) {
        return this.sourceCall(async () => this.options.legacyTerminals.read(request, this.legacyTerminalSource(request.sessionId)));
    }
    sourceLegacyTerminals(request: LegacyTerminalListRequest) {
        return this.sourceCall(async () => this.options.legacyTerminals.list(request, this.legacyTerminalSource(request.sessionId)));
    }
    sourceLegacyTerminalText(request: LegacyTerminalReadRequest, signal?: AbortSignal) {
        return this.sourceCall(() => this.options.legacyTerminals.readText(request, this.legacyTerminalSource(request.sessionId), signal ?? this.ctx.invocation?.signal));
    }
    sourceSessionBulk(request: SourceBulkOperation) { return this.sourceCall(() => this.options.bulk.operation(request)); }
    sourceSessionBulkRead(request: { operationId: string }) { return this.sourceCall(async () => this.options.bulk.read(request.operationId)); }
    sourceQueuedEdit(request: SourceQueuedEditRequest) { return this.sourceCall(() => this.options.queuedEdits.execute(request)); }
    sourceQueuedEditRead(request: SourceQueuedEditRead) { return this.sourceCall(() => this.options.queuedEdits.read(request)); }
    sourceQueuedEdits(request: { sessionId: string }) { return this.sourceCall(async () => this.options.queuedEdits.list(request.sessionId)); }
    sourceSummarySettings() { return this.sourceCall(() => this.options.administration.summarySettings()); }
    sourceVoiceCapabilities(request: VoiceRequest<'sourceVoiceCapabilities'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.voice.sourceVoiceCapabilities(request, signal)); }
    sourceVoiceCredentials(request: VoiceRequest<'sourceVoiceCredentials'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.voice.sourceVoiceCredentials(request, signal)); }
    sourceVoiceUpdateCredentials(request: VoiceRequest<'sourceVoiceUpdateCredentials'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.voice.sourceVoiceUpdateCredentials(request, signal)); }
    sourceVoiceVoices(request: VoiceRequest<'sourceVoiceVoices'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.voice.sourceVoiceVoices(request, signal)); }
    sourceVoiceToken(request: VoiceRequest<'sourceVoiceToken'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.voice.sourceVoiceToken(request, signal)); }
    sourceVoiceRealtimeToken(request: VoiceRequest<'sourceVoiceRealtimeToken'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.voice.sourceVoiceRealtimeToken(request, signal)); }
    sourceVoiceContext(request: VoiceRequest<'sourceVoiceContext'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.voice.sourceVoiceContext(request, signal)); }
    sourceNotificationSettings(request: NotificationRequest<'sourceNotificationSettings'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.notifications.sourceNotificationSettings(request, signal)); }
    sourcePushSubscribe(request: NotificationRequest<'sourcePushSubscribe'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.notifications.sourcePushSubscribe(request, signal)); }
    sourcePushUnsubscribe(request: NotificationRequest<'sourcePushUnsubscribe'>, signal?: AbortSignal) { return this.sourceCall(() => this.options.notifications.sourcePushUnsubscribe(request, signal)); }
    sourceAdminStorage() { return this.sourceCall(() => this.options.administration.storage()); }
    sourceAdminUsage(request: SourceUsageRequest) { return this.sourceCall(() => this.options.administration.usage(request)); }
    sourceAdminBundles(request: { machineId: string }) { return this.sourceCall(() => this.options.administration.bundles(request.machineId)); }
    sourceAdminOperation(request: SourceAdminOperation) { return this.sourceCall(() => this.options.administration.operation(request)); }
    sourceAdminOperationRead(request: { operationId: string }) { return this.sourceCall(() => this.options.administration.read(request.operationId)); }

    sourceSessionTools(request: { sessionId: string }) { return this.sourceCall(() => this.options.sourceLifecycle.sessionTools(request.sessionId)); }
    sourceOperation(request: SourceOperation) { return this.sourceCall(() => this.options.sourceLifecycle.operate(request)); }
    sourceOperationRead(request: SourceOperationRead) { return this.sourceCall(() => this.options.sourceLifecycle.read(request)); }
    sourceDshChild(request: SourceDshChildRead) { return this.sourceCall(async () => this.dshChildAgent(request.sessionId).state); }
    sourceDshChildRefresh(request: SourceDshChildRead) { return this.sourceCall(async () => {
        const child = this.dshChildAgent(request.sessionId); await child.refresh(); return child.state;
    }); }
    sourceDshChildInterrupt(request: SourceDshChildInterrupt) { return this.sourceCall(async () => {
        const child = this.dshChildAgent(request.sessionId); await child.interrupt(request.operationId); return child.state;
    }); }

    async createSession(request: CreateNativeSession): Promise<{ sessionId: string }> {
        return this.sourceCall(async () => {
            const state = await this.options.nativeCreation.create(request);
            if (state.status === 'ready' && state.sessionId) return { sessionId: state.sessionId };
            throw new HapiRequestError(`${state.message ?? 'Native creation is not confirmed'} Request: ${state.requestId}${state.sourceSessionId ? `; source session: ${state.sourceSessionId}` : ''}`,
                state.status === 'rejected' ? 'rejected' : 'indeterminate', undefined, state.sourceCode ?? 'native_creation_pending');
        });
    }
    async nativeCreations(): Promise<NativeCreationState[]> { return this.options.nativeCreation.list(); }
    nativeCreationOperation(request: NativeCreationOperation): Promise<NativeCreationState> {
        return this.sourceCall(() => this.options.nativeCreation.operation(request));
    }
    createSourceSession(request: CreateSourceSession) { return this.sourceCall(() => this.options.sourceCreation.create(request)); }
    sourceCreations() { return Promise.resolve(this.options.sourceCreation.list()); }
    sourceCreationOperation(request: SourceCreationOperation) { return this.sourceCall(() => this.options.sourceCreation.operation(request)); }
    nativePlan(request: { sessionId: string }): Promise<NativePlanState> {
        return this.sourceCall(() => this.options.nativePlan.state(request.sessionId));
    }
    nativeImplementPlan(request: NativeImplementPlan): Promise<NativePlanReceipt> {
        return this.sourceCall(() => this.options.nativePlan.implement(request));
    }
    async resumeSession(request: { sessionId: string }): Promise<{ sessionId: string }> {
        return this.sourceCall(async () => {
            const agent = this.sourceAgent(request.sessionId);
            const sourceId = await this.options.client.resumeSession(agent.binding.hapiSessionId);
            const display = await this.options.codex.reconcileSource(sourceId) ?? await this.options.observed.reconcileSource(sourceId);
            if (!display) throw new HapiRequestError('The source resumed, but its display identity is not ready yet', 'indeterminate');
            return { sessionId: display.id };
        });
    }
    nativeCancel(request: NativeQueueRequest): Promise<HapiCancelResult> {
        return this.sourceCall(() => this.sourceAgent(request.sessionId).cancelQueued(request.localId));
    }
    nativeSteerInbox(sessionId: string, itemId: string): Promise<HapiSteerResult> {
        return this.sourceCall(() => this.sourceAgent(sessionId).steerInbox(itemId));
    }
    nativeSteer(request: NativeQueueRequest): Promise<HapiSteerResult> {
        return this.sourceCall(() => this.sourceAgent(request.sessionId).steerQueued(request.localId));
    }
    nativeRetry(request: NativeQueueRequest): Promise<HapiRetryResult> {
        return this.sourceCall(() => this.sourceAgent(request.sessionId).retryIndeterminate(request.localId));
    }
    nativeDeliveryRecover(request: DeliveryRecoveryRequest): Promise<DeliveryView> {
        return this.sourceCall(async () => this.sourceAgent(request.sessionId).recoverDelivery(request.localId, request.action, request.operationId));
    }
    nativeDeliveryCheck(request: NativeQueueRequest): Promise<DeliveryView | null> {
        return this.sourceCall(() => this.sourceAgent(request.sessionId).checkDelivery(request.localId));
    }
    async nativeAnswer(request: NativeAnswerRequest): Promise<{ submitted: true }> {
        return this.sourceCall(async () => {
            await this.sourceAgent(request.sessionId).answerApproval(request.requestId, request.answer, request.deny);
            return { submitted: true };
        });
    }
    nativeSchedule(request: { sessionId: string; operationId: string; text: string; scheduledAt: number }): Promise<DeliveryView> {
        return this.sourceCall(async () => this.sourceAgent(request.sessionId).scheduleText(request));
    }
    nativeScheduleRead(request: { sessionId: string; operationId: string }) {
        return this.sourceCall(async () => this.sourceAgent(request.sessionId).scheduleReceipt(request.operationId));
    }
    sourceReadingAnchor(request: { sessionId: string; seq: number }): Promise<{ sourceMessageId: string | null }> {
        return this.sourceCall(async () => ({ sourceMessageId: this.sourceAgent(request.sessionId).sourceMessageAtDisplaySeq(request.seq) ?? null }));
    }
    sourceLocateMessage(request: { sessionId: string; sourceMessageId: string }): Promise<{ sessionId: string; seq: number | null }> {
        return this.sourceCall(async () => {
            const agent = this.sourceAgent(request.sessionId);
            const sourceId = agent.binding.hapiSessionId;
            await agent.refresh(true);
            const current = this.options.codex.byHapiSession(sourceId) ?? this.options.observed.byHapiSession(sourceId);
            return { sessionId: current?.id ?? agent.id, seq: current?.resolveSourceMessageDisplaySeq(request.sourceMessageId) ?? null };
        });
    }
    nativeSettings(request: { sessionId: string }): Promise<NativeSettings> {
        return this.sourceCall(() => this.options.nativeControl.settings(request.sessionId));
    }
    nativeApplySetting(request: NativeApplySetting): Promise<NativeSettingReceipt> {
        return this.sourceCall(() => this.options.nativeControl.applySetting(request));
    }
    observedSettings(request: { sessionId: string }) { return this.sourceCall(() => this.options.observedControl.settings(request)); }
    observedApplySetting(request: ObservedApplySetting) { return this.sourceCall(() => this.options.observedControl.applySetting(request)); }
    observedSetting(request: ObservedSettingRead) { return this.sourceCall(() => this.options.observedControl.readSetting(request)); }
    nativeForkState(request: { sessionId: string }): Promise<NativeForkState> {
        return this.sourceCall(() => this.options.nativeControl.forkState(request.sessionId));
    }
    nativeFork(request: NativeForkRequest): Promise<NativeForkView> {
        return this.sourceCall(() => this.options.nativeControl.fork(request));
    }
    nativeForkOperation(request: NativeForkOperationRequest): Promise<NativeForkView> {
        return this.sourceCall(() => this.options.nativeControl.forkOperation(request));
    }
    nativeForkClose(request: NativeForkCloseRequest): Promise<NativeForkCloseResult> {
        return this.sourceCall(() => this.options.nativeControl.forkClose(request));
    }
    /** Called by the public SessionController provider; the original remote authorization remains in force. */
    renameNativeSession(request: { sessionId: string; title: string }): Promise<SessionRenameValue> {
        return this.sourceCall(async () => {
            const agent = this.native(request.sessionId);
            const title = request.title.trim();
            if (!title) throw new HapiRequestError('A native session title cannot be empty', 'rejected');
            await this.options.client.renameSession(agent.binding.hapiSessionId, title);
            await agent.refresh();
            if (!agent.titleEvent || agent.titleEvent.title !== title) throw new HapiRequestError('The native title update has not been observed', 'indeterminate');
            return agent.titleEvent;
        });
    }
    renameObservedSession(request: { sessionId: string; title: string }): Promise<SessionRenameValue> {
        return this.sourceCall(async () => {
            const agent = this.sourceAgent(request.sessionId); const title = request.title.trim();
            if (!title) throw new HapiRequestError('A source session title cannot be empty', 'rejected');
            await this.options.client.renameSession(agent.binding.hapiSessionId, title); await agent.refresh();
            if (!agent.titleEvent || agent.titleEvent.title !== title) throw new HapiRequestError('The source title update has not been observed', 'indeterminate');
            return agent.titleEvent;
        });
    }
    workspaceGet(): Promise<WorkspaceDocument> { return this.options.workspace.get(); }
    workspaceLegacy(): Promise<LegacyWorkspaceSnapshot> {
        return this.sourceCall(async () => legacyWorkspaceSnapshotSchema.parse(await this.options.client.request('/api/workspaces')));
    }
    workspacePut(request: WorkspaceWrite): Promise<WorkspaceWriteResult> { return this.options.workspace.put(request); }

    nativeLibrary(request: NativeLibraryRequest<'nativeLibrary'>) { return this.sourceCall(() => this.options.nativeLibrary.library(request)); }
    nativeConnect(request: NativeLibraryRequest<'nativeConnect'>) { return this.sourceCall(() => this.options.nativeLibrary.connect(request)); }
    nativeImport(request: NativeLibraryRequest<'nativeImport'>) { return this.sourceCall(() => this.options.nativeLibrary.import(request)); }
    nativeSessionTools(request: NativeLibraryRequest<'nativeSessionTools'>) { return this.sourceCall(() => this.options.nativeLibrary.sessionTools(request.sessionId)); }
    nativeSourceOperation(request: NativeLibraryRequest<'nativeSourceOperation'>) { return this.sourceCall(() => this.options.nativeLibrary.sourceOperation(request)); }
    nativeOperation(request: NativeLibraryRequest<'nativeOperation'>) { return this.sourceCall(async () => this.options.nativeLibrary.operation(request.operationId)); }
    nativeMachineState(request: NativeLibraryRequest<'nativeMachineState'>) { return this.sourceCall(() => this.options.nativeLibrary.machineState(request.machineId)); }
    nativeMachineOperation(request: NativeLibraryRequest<'nativeMachineOperation'>) { return this.sourceCall(() => this.options.nativeLibrary.machineOperation(request)); }
    nativeDeviceLogin(request: NativeLibraryRequest<'nativeDeviceLogin'>) { return this.sourceCall(() => this.options.nativeLibrary.deviceLogin(request.machineId, request.loginId)); }
    sourceReadStates(_request: NativeLibraryRequest<'sourceReadStates'>) { return this.sourceCall(() => this.options.nativeLibrary.readStates()); }
    sourceReadStateWrite(request: NativeLibraryRequest<'sourceReadStateWrite'>) { return this.sourceCall(() => this.options.nativeLibrary.writeReadState(request)); }
    nativeDirectory(request: WorkbenchRequest<'nativeDirectory'>) { return this.sourceCall(() => this.options.workbench.nativeDirectory(request)); }
    nativeFileSearch(request: WorkbenchRequest<'nativeFileSearch'>) { return this.sourceCall(() => this.options.workbench.nativeFileSearch(request)); }
    nativeGit(request: WorkbenchRequest<'nativeGit'>) { return this.sourceCall(() => this.options.workbench.nativeGit(request)); }
    nativeDocument(request: WorkbenchRequest<'nativeDocument'>) { return this.sourceCall(() => this.options.workbench.nativeDocument(request)); }
    nativeTerminalText(request: WorkbenchRequest<'nativeTerminalText'>, signal: AbortSignal) { return this.sourceCall(() => this.options.workbench.nativeTerminalText(request, signal)); }
    nativeFileSave(request: WorkbenchRequest<'nativeFileSave'>) { return this.sourceCall(() => this.options.workbench.nativeFileSave(request)); }
    nativeFileInspect(request: WorkbenchRequest<'nativeFileInspect'>) { return this.sourceCall(() => this.options.workbench.nativeFileInspect(request)); }
    nativeFileManage(request: WorkbenchRequest<'nativeFileManage'>) { return this.sourceCall(() => this.options.workbench.nativeFileManage(request)); }
    nativeFileUpload(request: WorkbenchRequest<'nativeFileUpload'>) { return this.sourceCall(() => this.options.workbench.nativeFileUpload(request)); }
    nativePreview(request: WorkbenchRequest<'nativePreview'>) { return this.sourceCall(() => this.options.workbench.nativePreview(request)); }
    sourceNotes(request: SessionExtrasRequest<'sourceNotes'>) { return this.sourceCall(() => this.options.extras.sourceNotes(request)); }
    sourceNoteWrite(request: SessionExtrasRequest<'sourceNoteWrite'>) { return this.sourceCall(() => this.options.extras.sourceNoteWrite(request)); }
    sourceNoteUpload(request: SessionExtrasRequest<'sourceNoteUpload'>) { return this.sourceCall(() => this.options.extras.sourceNoteUpload(request)); }
    sourceOutline(request: SessionExtrasRequest<'sourceOutline'>) { return this.sourceCall(() => this.options.extras.sourceOutline(request)); }
    sourceMessageContext(request: SessionExtrasRequest<'sourceMessageContext'>) { return this.sourceCall(() => this.options.extras.sourceMessageContext(request)); }
    sourceExport(request: SessionExtrasRequest<'sourceExport'>) { return this.sourceCall(() => this.options.extras.sourceExport(request)); }
    sourceSkills(request: SessionExtrasRequest<'sourceSkills'>) { return this.sourceCall(() => this.options.extras.sourceSkills(request)); }
    sourceTitleTools(request: SessionExtrasRequest<'sourceTitleTools'>) { return this.sourceCall(() => this.options.extras.sourceTitleTools(request)); }
    sourceTitleSuggestion(request: SessionExtrasRequest<'sourceTitleSuggestion'>) { return this.sourceCall(() => this.options.extras.sourceTitleSuggestion(request)); }
    sourceWorkGraph(request: SessionExtrasRequest<'sourceWorkGraph'>) { return this.sourceCall(() => this.options.extras.sourceWorkGraph(request)); }
    sourceWorkGraphLinks(request: SessionExtrasRequest<'sourceWorkGraphLinks'>) { return this.sourceCall(() => this.options.extras.sourceWorkGraphLinks(request)); }

    private legacyTerminalSource(sessionId: string): WorkbenchSource {
        const source = this.workbenchSource(sessionId);
        if (!source) throw new RemoteError('hapi/request', 'This view does not belong to an original HAPI terminal source.', {
            outcome: 'rejected', status: 409, sourceCode: 'source_terminal_binding_required',
        });
        return source;
    }
    private native(id: string): NativeCodexAgent {
        const agent = this.options.codex.get(id);
        if (!agent || agent.id !== id) throw new RemoteError('hapi/request', 'The native session is unavailable or was replaced; refresh the workspace.', { outcome: 'rejected', status: 404 });
        return agent;
    }
    private dshChildAgent(id: string) {
        const child = this.options.observed.dshChild(id);
        if (!child) throw new HapiRequestError('This source DSH child is no longer available in the current display generation', 'rejected', 404, 'source_child_unavailable');
        return child;
    }
    private sourceAgent(id: string): NativeCodexAgent | HapiObservedAgent {
        const agent = this.options.codex.get(id) ?? this.options.observed.get(id);
        if (!agent || agent.id !== id) throw new RemoteError('hapi/request', 'This source display is unavailable or was replaced; refresh the workspace.', { outcome: 'rejected', status: 404 });
        return agent;
    }
    private async sourceCall<T>(run: () => Promise<T>): Promise<T> {
        try { return await run(); }
        catch (error) {
            if (error instanceof HapiRequestError) throw new RemoteError('hapi/request', error.message, {
                outcome: error.outcome,
                ...(error.status === undefined ? {} : { status: error.status }),
                ...(error.code === undefined ? {} : { sourceCode: error.code }),
            });
            throw error;
        }
    }
}

/** Composition only: every upstream Host and Client service remains unmodified. */
export async function apply(ctx: Context, input: Config): Promise<void> {
    const config = await readConfig(input.configFile);
    const dataDirectory = join(config.dsh.home, 'profiles', config.dsh.profile, 'data', 'hapi-dsh');
    const hapiToken = resolveHapiToken(config);
    const client = new HapiClient({ hubId: config.hapi.id, url: config.hapi.url, token: hapiToken });
    const companion = new SourceCompanionService({ hubId: config.hapi.id, sourceUrl: config.hapi.url,
        ...(config.hapi.companionUrl ? { companionUrl: config.hapi.companionUrl } : {}), readCredential: () => hapiToken });
    // One HAPI resume callback for the durable delivery path. A delivery only
    // uses it after an explicit `session_inactive` (409) rejection, once.
    const resumeSession = (hapiSessionId: string): Promise<string> => client.resumeSession(hapiSessionId);
    const codex = new CodexService(ctx, client, {
        stateDirectory: join(dataDirectory, 'native'), fastHistorySeed: true, resolveAttachments: attachmentResolver(ctx.attachments, client),
        importArtifact: artifactImporter(ctx.attachments, client),
        onError: (error) => { ctx.logger.warn(`Native Codex synchronization: ${error.message}`); },
        resumeSession,
    });
    const observed = new HapiAgentService(ctx, client, {
        stateDirectory: join(dataDirectory, 'observed'), fastHistorySeed: true, resolveAttachments: attachmentResolver(ctx.attachments, client),
        importArtifact: artifactImporter(ctx.attachments, client), importAttachment: sourceUploadImporter(ctx.attachments, client),
        importGeneratedMedia: sourceGeneratedMediaImporter(ctx.attachments, client),
        importInline: sourceInlineImporter(ctx.attachments),
        onError: error => { ctx.logger.warn(`HAPI session synchronization: ${error.message}`); },
        resumeSession,
    });
    const federation = new FederationHub({ credentialsFile: config.federation?.credentialsFile ?? join(dataDirectory, 'machines.json') });
    const nativeControl = new NativeControl(client, codex, join(dataDirectory, 'native'));
    const observedControl = new HapiObservedControl(client, observed, join(dataDirectory, 'observed'));
    const nativeCreation = new NativeCreation(client, codex, join(dataDirectory, 'native'));
    const sourceCreation = new SourceCreation(client, observed, join(dataDirectory, 'observed'));
    const sourceLifecycle = new SourceLifecycle(client, observed, join(dataDirectory, 'observed'));
    const initialTasks = new SourceInitialTasks(ctx, {
        get: id => codex.get(id) ?? observed.get(id),
        byHapiSession: id => codex.byHapiSession(id) ?? observed.byHapiSession(id),
    }, async (kind, requestId) => {
        const owner = kind === 'native' ? nativeCreation : sourceCreation;
        if (!owner.list().some(row => row.requestId === requestId)) return undefined;
        return owner.operation({ requestId, action: 'read' });
    }, { stateDirectory: join(dataDirectory, 'initial-tasks'), hubId: client.hubId });
    const sourceHistory = new SourceHistory(client, {
        get: id => codex.get(id) ?? observed.get(id),
        byHapiSession: id => codex.byHapiSession(id) ?? observed.byHapiSession(id),
        reconcileSource: async id => {
            const source = await client.getSession(id);
            return source.metadata?.codexNativeSession === true ? codex.reconcileSource(id) : observed.reconcileSource(id);
        },
    }, join(dataDirectory, 'source-history'));
    const administration = new SourceAdministrationService(client, join(dataDirectory, 'administration'));
    const voice = new SourceVoiceService(client);
    const notifications = new SourceNotificationsService(client);
    const bulk = new SourceBulkActions(client, join(dataDirectory, 'bulk-actions'));
    const queuedEdits = new SourceQueuedEdits(client, { get: id => codex.get(id) ?? observed.get(id) }, join(dataDirectory, 'queued-edits'));
    const nativePlan = new NativePlan(client, codex, join(dataDirectory, 'native'));
    const nativeLibrary = new NativeLibrary(client, {
        get: id => codex.get(id), reconcileSource: id => codex.reconcileSource(id),
        refreshCatalog: async () => { await Promise.all([codex.refreshCatalog(), observed.refreshCatalog()]); },
    }, join(dataDirectory, 'native'));
    const workbench = new NativeWorkbench(client);
    const terminal = new NativeTerminalBridge(client, workbench);
    const legacyTerminals = new LegacySessionTerminals({
        authenticate: () => client.socketAuthentication(), workbench,
        getLimits: () => TerminalController.Config(officialProviderConfig(ctx, 'terminal-controller') as TerminalConfig),
    });
    const extras = new HapiSessionExtras(client);
    ctx.effect(() => () => nativeControl.settled(), 'hapi-dsh: native control submissions');
    ctx.effect(() => () => observedControl.settled(), 'hapi-dsh: source control submissions');
    ctx.effect(() => () => nativeCreation.settled(), 'hapi-dsh: native creation observations');
    ctx.effect(() => () => sourceCreation.settled(), 'hapi-dsh: source creation observations');
    ctx.effect(() => () => sourceLifecycle.settled(), 'hapi-dsh: source lifecycle operations');
    ctx.effect(() => () => initialTasks.settled(), 'hapi-dsh: initial task submissions');
    ctx.effect(() => () => sourceHistory.settled(), 'hapi-dsh: original history operations');
    ctx.effect(() => () => administration.settled(), 'hapi-dsh: original Hub administration');
    ctx.effect(() => mountSourceBackup(client, { webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) }), 'hapi-dsh: source database backup');
    ctx.effect(() => () => nativePlan.settled(), 'hapi-dsh: native plan submissions');
    ctx.effect(() => () => nativeLibrary.settled(), 'hapi-dsh: source lifecycle submissions');
    ctx.effect(() => () => workbench.close(), 'hapi-dsh: source workbench');
    ctx.effect(() => () => terminal.close(), 'hapi-dsh: source terminals');
    ctx.effect(() => () => legacyTerminals.dispose(), 'hapi-dsh: original SessionTerminal views');
    ctx.effect(() => () => extras.close(), 'hapi-dsh: source session resources');
    ctx.effect(() => () => voice.close(), 'hapi-dsh: original voice resources');
    ctx.effect(() => () => notifications.close(), 'hapi-dsh: original notifications');
    ctx.effect(() => () => bulk.settled(), 'hapi-dsh: original bulk operations');
    ctx.effect(() => () => queuedEdits.dispose(), 'hapi-dsh: original queued edits');
    ctx.effect(() => () => client.close(), 'hapi-dsh: HAPI connection');
    ctx.effect(() => () => codex.dispose(), 'hapi-dsh: native observation');
    ctx.effect(() => () => observed.dispose(), 'hapi-dsh: source engine observation');
    ctx.effect(() => () => federation.close(), 'hapi-dsh: Runner connections');
    ctx.effect(() => ctx.llm.registerAdapter([NATIVE_CODEX_PROVIDER, HAPI_OBSERVED_PROVIDER], new NativeModelMetadata()), 'hapi-dsh: source model metadata');
    ctx.effect(() => mountBootstrapRoute({
        webServer: ctx.webServer, clientModules: ctx.clientModules, connection: ctx.connection,
        appReady: ctx.get('appReady') as { onReady(callback: () => void): () => void },
    }), 'hapi-dsh: local pane plugin bootstrap');
    ctx.on('webserver/index-inject', table => { table.push(...workspaceBootInjections()); });
    ctx.effect(() => ctx.webServer.tapIndex(deferWorkspaceEntry), 'hapi-dsh: first-paint workspace layout');
    await federation.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    ctx.effect(() => mountPluginEvents({ webServer: ctx.webServer, connection: ctx.connection,
        hasHost: id => federation.listMachines().some(host => host.id === id && host.online),
    }), 'hapi-dsh: multiplexed official plugin events');
    workbench.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    terminal.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    extras.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    voice.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    notifications.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    ctx.effect(() => mountShareTarget({ webServer: ctx.webServer }), 'hapi-dsh: browser share target');
    new HapiController(ctx, { config, client, codex, observed, observedControl, federation, nativeControl, nativeCreation, sourceCreation, sourceLifecycle, initialTasks, sourceHistory, administration, companion, voice, notifications, bulk, queuedEdits, nativePlan, nativeLibrary, workbench, legacyTerminals, extras, workspace: new WorkspaceRepository(join(dataDirectory, 'workspace.json')) });
    const startup = await startSourceCatalogs([{ name: 'Native Codex', start: () => codex.start() }, { name: 'HAPI', start: () => observed.start() }],
        (source, error) => { ctx.logger.warn(`${source} catalog synchronization failed; source sessions will reconnect: ${error instanceof Error ? error.message : 'connection failed'}`); });
    if (startup === 'background') ctx.logger.info('The initial HAPI catalog is still loading. The Host is ready; all source sessions continue synchronizing in the background.');
}
