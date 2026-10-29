import { logicalDisplayId, observedSessionId } from './hapi-agent/identity.ts'
import { join } from 'node:path';
import { installSources } from './remote/service.ts';
import { WorkspaceShell } from './hub/workspace-shell.ts';
import { DSH_VERSION } from './cli/config.ts';
import { runtimeIdentity } from './runner/identity.ts';
import type { Context } from '@deepseek-ai/cordis';
import S from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteStream } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-modules';
import type { SessionRenameValue, SessionHistoryRecord } from '@deepseek-ai/dsh-api-session-controller/types';
import { DisplayHistoryWindows, isSourceTurnStart, SourceHistoryWindow, sourcePosition, uniqueSourceRows, DISPLAY_SEQ_OFFSET } from './codex/source-window.ts';
import { SOURCE_HISTORY_FRAME_CHUNK_SIZE, type SourceHistoryWindowPageStreamItem } from './source-window-types.ts';
import type { SourceHistoryHeadRequest, SourceHistoryHeadValue, SourceHistoryWindowRequest, SourceHistoryWindowValue, SourceHistoryOutlineValue, SourceHistoryOutlinePageRequest, SourceHistoryOutlinePageValue } from './source-window-types.ts';
import type { SourceHistoryAttachmentRequest, SourceHistoryAttachmentValue } from './source-attachment-types.ts';
import { sourceAttachmentErrorOf, SourceWindowAttachments } from './source-window-attachments.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import { HapiObservedChild } from './hapi-agent/children.ts';
import { isHapiDshChildAgent, type HapiDshChildAgent } from './hapi-agent/dsh-children.ts';
import { chunkSourceFramesNearestFirst, type SourceFrameBatch } from './shared/source-frames.ts';
import { isSourceChildDisplayId, isSourceDisplayId } from './shared/source-display-id.ts';
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
import { HapiRequestError, type HapiCancelResult, type HapiMessage, type HapiMessagesQuery, type HapiSteerResult, type HapiRetryResult } from './codex/contracts.ts';
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
import type { DisplayLeaseView } from './codex/display-leases.ts';
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

/** Match the official Session pager: 50 messages, 2 turns, at most 500. */
const HISTORY_PAGE_MESSAGES = 50;
const HISTORY_PAGE_TURNS = 2;
const HISTORY_PAGE_MAX_MESSAGES = 500;
const HAPI_READ_PAGE_MESSAGES = 200;

interface SourceHistoryPosition { at: number; seq: number }
interface SourceHistoryReadPage {
    messages: HapiMessage[];
    hasMore: boolean;
    next: SourceHistoryPosition | null;
    epoch?: number;
    reset: boolean;
}

/** Read one HAPI-sized contiguous page for the source Session's committed feed. */
async function readSourceHistoryPage(client: HapiClient, sessionId: string, direction: 'before' | 'after',
    cursor: SourceHistoryPosition, epoch?: number, requestedLimit?: number, signal?: AbortSignal): Promise<SourceHistoryReadPage> {
    const maximum = requestedLimit ?? HISTORY_PAGE_MAX_MESSAGES;
    const target = requestedLimit === undefined ? HISTORY_PAGE_MESSAGES : requestedLimit;
    const pages = Math.ceil(maximum / HAPI_READ_PAGE_MESSAGES);
    let rows: HapiMessage[] = [];
    let next: SourceHistoryPosition | null = null;
    let hasMore = false, reset = false, requestEpoch = epoch, pageEpoch: number | undefined;
    let current = cursor;

    for (let index = 0; index < pages; index++) {
        signal?.throwIfAborted();
        const limit = Math.min(HAPI_READ_PAGE_MESSAGES, maximum - rows.length);
        const query: HapiMessagesQuery = { limit, bounded: true,
            ...(requestEpoch === undefined ? {} : { epoch: requestEpoch }),
            ...(direction === 'before'
                ? { beforeAt: current.at, beforeSeq: current.seq }
                : { afterAt: current.at, afterSeq: current.seq }) };
        const result = await client.readMessages(sessionId, query, signal);
        pageEpoch = result.page.epoch;
        reset ||= result.page.reset;
        if (result.page.reset || requestEpoch !== undefined && result.page.epoch !== requestEpoch) {
            reset = true;
            break;
        }
        requestEpoch ??= result.page.epoch;
        const batch = uniqueSourceRows(result.messages);
        if (!batch.length) { hasMore = false; break; }
        rows = direction === 'before' ? [...batch, ...rows] : [...rows, ...batch];
        const nextPosition = direction === 'before'
            ? result.page.nextBeforeAt !== null && result.page.nextBeforeSeq !== null && result.page.nextBeforeSeq > 0
                ? { at: result.page.nextBeforeAt, seq: result.page.nextBeforeSeq } : sourcePosition(batch[0]!)
            : result.page.nextAfterAt !== null && result.page.nextAfterSeq !== null && result.page.nextAfterSeq > 0
                ? { at: result.page.nextAfterAt, seq: result.page.nextAfterSeq } : sourcePosition(batch.at(-1)!);
        if (nextPosition.seq <= 0) { hasMore = false; break; }
        current = next = nextPosition;
        hasMore = result.page.hasMore;
        if (!hasMore || requestedLimit !== undefined || rows.length >= maximum) break;
        const turns = uniqueSourceRows(rows).filter(isSourceTurnStart).length;
        if (rows.length >= target && turns >= HISTORY_PAGE_TURNS) break;
    }
    return { messages: uniqueSourceRows(rows), hasMore, next, ...(pageEpoch === undefined ? {} : { epoch: pageEpoch }), reset };
}
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
import { stageWorkspaceBoot } from './shared/boot-graph.ts';
import { compressedStreamInjection, mountCompressedStream } from './shared/compressed-stream.ts';
import { mountVersionedAssets } from './shared/versioned-assets.ts';
import { mountPluginEvents } from './shared/plugin-events.ts';
import { officialProviderConfig } from './shared/official-provider.ts';

export const name = 'hapi-dsh';
export const inject = ['loader', 'agents', 'sessions', 'sessionProjections', 'attachments', 'fileUploads', 'llm', 'typert', 'webServer', 'connection', 'clientModules', 'appReady', 'remoteAccess'];
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
    historyWindows: DisplayHistoryWindows;
}

type SourceBodyAgent = NativeCodexAgent | HapiObservedAgent | HapiObservedChild | HapiDshChildAgent;

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
    private readonly childAttachments = new Map<string, { agent: SourceBodyAgent; grants: SourceWindowAttachments }>();

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
        ctx.effect(() => () => options.historyWindows.clear(), 'hapi-dsh: source history windows');
    }

    /** One virtual source window per live display; normal paging never replaces it. */
    sourceHistoryWindow(sessionId: string): SourceHistoryWindow | undefined {
        if (!isSourceDisplayId(sessionId) || isSourceChildDisplayId(sessionId)) return undefined;
        const agent = (this.options.codex.get(sessionId) ?? this.options.observed.get(sessionId) ?? this.options.codex.get(logicalDisplayId(sessionId)) ?? this.options.observed.get(logicalDisplayId(sessionId)));
        if (!agent) return undefined;
        return this.options.historyWindows.window(sessionId, agent, this.options.client, async query => {
      const source = this.workbenchSource(sessionId)!;
      return this.options.extras.sourceOutline({ source, query });
    }, async (messageId, radius) => {
      const source = this.workbenchSource(sessionId)!;
      const value = await this.options.extras.sourceMessageContext({ source, messageId, radius });
      return { messages: value.messages as unknown as readonly HapiMessage[], page: value.page };
    });
    }

    historyWindowBound(sessionId: string): boolean {
        if (!isSourceDisplayId(sessionId) || isSourceChildDisplayId(sessionId)) return false;
        const agent = (this.options.codex.get(sessionId) ?? this.options.observed.get(sessionId) ?? this.options.codex.get(logicalDisplayId(sessionId)) ?? this.options.observed.get(logicalDisplayId(sessionId)));
        return Boolean(agent);
    }

    /** Virtual display seq -> source row id, including paged older history. */
    sourceMessageAtDisplaySeq(sessionId: string, seq: number): string | undefined {
        const agent = (this.options.codex.get(sessionId) ?? this.options.observed.get(sessionId) ?? this.options.codex.get(logicalDisplayId(sessionId)) ?? this.options.observed.get(logicalDisplayId(sessionId)));
        if (seq >= DISPLAY_SEQ_OFFSET / 2) {
            return agent?.sourceMessageAtDisplaySeq(seq - DISPLAY_SEQ_OFFSET);
        }
        return agent?.sourceMessageAtDisplaySeq(seq);
    }

    displaySeqForSourceMessage(sessionId: string, sourceMessageId: string): number | null {
        const agent = (this.options.codex.get(sessionId) ?? this.options.observed.get(sessionId) ?? this.options.codex.get(logicalDisplayId(sessionId)) ?? this.options.observed.get(logicalDisplayId(sessionId)));
        const real = agent?.resolveSourceMessageDisplaySeq(sourceMessageId);
        return real === undefined ? null : real + DISPLAY_SEQ_OFFSET;
    }

    resolveHistoryRewind(sessionId: string, seq: number): string | undefined {
        const agent = (this.options.codex.get(sessionId) ?? this.options.observed.get(sessionId) ?? this.options.codex.get(logicalDisplayId(sessionId)) ?? this.options.observed.get(logicalDisplayId(sessionId)));
        if (!agent || seq < DISPLAY_SEQ_OFFSET) return undefined;
        return agent.resolveRewindLocalIdAtSeq(seq - DISPLAY_SEQ_OFFSET);
    }

    resolveHistoryRewindMessage(sessionId: string, messageId: string): string | undefined {
        return this.options.historyWindows.peek(sessionId)?.resolveRewindMessage(messageId);
    }

    resolveHistoryFork(sessionId: string, messageId: string) {
        const live = (this.options.codex.get(sessionId) ?? this.options.observed.get(sessionId) ?? this.options.codex.get(logicalDisplayId(sessionId)) ?? this.options.observed.get(logicalDisplayId(sessionId)));
        return this.options.historyWindows.peek(sessionId)?.resolveFork(messageId)
            ?? (live && 'resolveForkBoundary' in live ? live.resolveForkBoundary(messageId) : undefined);
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
        const agents = [...this.options.codex.list(), ...this.options.observed.list()];
        const attached = new Set(agents.map(agent => agent.binding.hapiSessionId));
        const codexErrors = this.options.codex.failures(), observedErrors = this.options.observed.failures();
        return {
            hubId: client.hubId, connected: client.isConnected,
            sourceDiscovery: {
                phase: this.summaryError || !client.isConnected ? this.summaryObservedAt === null ? 'unavailable' : 'stale' : this.summaryObservedAt === null ? 'pending' : 'ready',
                observedAt: this.summaryObservedAt, error: this.summaryError,
                sessions: [...this.sourceSummaries.values()].map(source => {
                    const row = discoverSourceSession(client.hubId, source, attached.has(source.id));
                    const error = codexErrors.get(source.id) ?? observedErrors.get(source.id);
                    return !error || row.binding === 'attached' ? row : { ...row, binding: 'failed' as const, error };
                }),
            },
            machines: this.machineCache.map(machine => catalogSourceMachine(machine, client.isConnected)),
            sessions: agents.map(agent => ({
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

    sourceSessionResolve(request: OriginalSessionRequest, signal?: AbortSignal) {
        return this.sourceCall(() => { signal?.throwIfAborted(); return this.sourceResolver.resolve(request) })
    }
    /**
     * Browser-owned reference leases are the only signal that retires an
     * unviewed Host display. They never attach a source or start execution.
     */
    sourceDisplayLease(request: DisplayLeaseView, signal?: AbortSignal) {
        return this.sourceCall(async () => {
            signal?.throwIfAborted()
            if (request.hubId !== this.options.client.hubId) {
                throw new HapiRequestError('This Host is connected to a different original HAPI Hub.', 'rejected', 409, 'source_hub_mismatch')
            }
            const services = [this.options.codex, this.options.observed]
            let leaseActive = request.action === 'acquire'
            for (const service of services) {
                if (request.action === 'acquire') await service.acquireDisplayLease(request.sourceSessionId, request.leaseId, request.ttlMs)
                else if (request.action === 'renew') leaseActive = await service.renewDisplayLease(request.sourceSessionId, request.leaseId, request.ttlMs) || leaseActive
                else await service.releaseDisplayLease(request.sourceSessionId, request.leaseId)
            }
            signal?.throwIfAborted()
            const attached = Boolean(this.options.codex.byHapiSession(request.sourceSessionId)
                || this.options.observed.byHapiSession(request.sourceSessionId))
            if (request.action === 'release' && !attached) this.options.historyWindows.retireSource(request.sourceSessionId)
            return { released: !attached && request.action === 'release', leaseActive: request.action === 'acquire' ? true : leaseActive, attached }
        })
    }

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
    sourceHistoryOutline(request: { sessionId: string }): Promise<SourceHistoryOutlineValue> {
        return this.sourceCall(async () => {
            await this.ensureDisplayAgent(request.sessionId);
            const window = this.requireHistoryWindow(request.sessionId);
            const agent = this.sourceAgent(request.sessionId);
            let head: SourceHistoryOutlineValue['head'];
            try {
                const latest = await this.options.client.readMessages(agent.binding.hapiSessionId, { limit: 1, bounded: true });
                if (latest.page.reset) window.invalidateSnapshot(latest.page.epoch);
                window.observeSnapshotEpoch(latest.page.epoch);
                const row = latest.messages.filter(message => message.invokedAt != null).at(-1) ?? latest.messages.at(-1);
                if (row) head = { messageId: row.id, at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0 };
            } catch { /* The outline remains usable; latest falls back to its user entry. */ }
            // Head and outline identify messages independently. Their snapshot
            // revisions need not equal the display's opening seed revision.
            const value = await window.canonicalOutline();
            if (!value) throw new RemoteError('hapi/request', 'The source outline is not available for this display yet', {
                outcome: 'rejected', status: 409, sourceCode: 'source_outline_unavailable' });
            return { entries: [...value.entries], seedIndex: value.seedIndex, firstTurn: value.firstTurn,
                epoch: value.epoch, complete: value.complete, indexing: value.indexing,
                unreadable: value.unreadable, scannedThrough: value.scannedThrough, headSeq: value.headSeq,
                ...(head ? { head } : {}) };
        });
    }
    /** One bounded outline page. The preview covers every page read so far. */
    sourceHistoryOutlinePage(request: SourceHistoryOutlinePageRequest): Promise<SourceHistoryOutlinePageValue> {
        return this.sourceCall(async () => {
            await this.ensureDisplayAgent(request.sessionId);
            const window = this.requireHistoryWindow(request.sessionId);
            // Directory metadata owns its cursor and epoch. Latest-message
            // identity has a separate sourceHistoryHead route; rereading the
            // transcript here serializes every directory page behind it.
            const page = await window.outlinePage({
                ...(request.limit === undefined ? {} : { limit: request.limit }),
                ...(request.beforeAt === undefined ? {} : { beforeAt: request.beforeAt }),
                ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
                ...(request.epoch === undefined ? {} : { epoch: request.epoch }),
            });
            if (!page) throw new RemoteError('hapi/request', 'The source outline is not available for this display yet', {
                outcome: 'rejected', status: 409, sourceCode: 'source_outline_unavailable' });
            return { entries: [...page.entries], seedIndex: page.seedIndex, firstTurn: page.firstTurn,
                epoch: page.epoch, complete: page.complete, indexing: page.indexing,
                unreadable: page.unreadable, scannedThrough: page.scannedThrough, headSeq: page.headSeq,
                cursor: page.cursor, hasMore: page.hasMore, pageSize: page.pageSize };
        });
    }
    /** Minimal newest-message identity for the open path; no directory page. */
    sourceHistoryHead(request: SourceHistoryHeadRequest): Promise<SourceHistoryHeadValue> {
        return this.sourceCall(async () => {
            await this.ensureDisplayAgent(request.sessionId);
            const window = this.requireHistoryWindow(request.sessionId);
            const agent = this.sourceAgent(request.sessionId);
            const latest = await this.options.client.readMessages(agent.binding.hapiSessionId, { limit: 1, bounded: true });
            if (latest.page.reset) window.invalidateSnapshot(latest.page.epoch);
            window.observeSnapshotEpoch(latest.page.epoch);
            const row = latest.messages.filter(message => message.invokedAt != null).at(-1) ?? latest.messages.at(-1);
            if (!row) throw new RemoteError('hapi/request', 'The source head is not available for this display yet', {
                outcome: 'rejected', status: 409, sourceCode: 'source_head_unavailable' });
            return { messageId: row.id, at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0,
                ...(latest.page.epoch === undefined ? {} : { epoch: latest.page.epoch }) };
        });
    }

    /** Source body follows its own bounded stream; the operation Session never stores it. */
    @Remote({ mode: 'stream', resources: { session: (request: { sessionId: string }) => SessionId(request.sessionId) } })
    async *sourceWindowFollow(request: { sessionId: string }, signal: AbortSignal): AsyncIterable<SourceFrameBatch> {
        await this.ensureDisplayAgent(request.sessionId);
        signal.throwIfAborted();
        const agent = this.bodyAgent(request.sessionId);
        if (!agent) throw new RemoteError('hapi/request', 'This source display is unavailable or was replaced.', {
            outcome: 'rejected', status: 404, sourceCode: 'source_window_unavailable' });
        const window = this.sourceHistoryWindow(request.sessionId);
        const child = window ? undefined : this.childAttachmentGrants(agent);
        for await (const batch of agent.sourceFrames(signal)) {
            if (signal.aborted) return;
            if (window) window.grantSourceFrames(batch.frames, batch.historyVersion);
            else child!.grant(batch.frames.map((frame, seq) => ({ type: 'event' as const, seq,
                event: frame.event as SessionHistoryRecord['event'] })), batch.historyVersion);
            yield batch;
        }
    }

    /** List metadata must reflect source content, rather than an operation-only log. */
    sourceSessionBlank(sessionId: string): boolean | undefined {
        const agent = this.bodyAgent(sessionId);
        return agent ? !agent.currentSourceFrames().some(frame => frame.event.type === 'user/message'
            || frame.event.type === 'assistant/message' || frame.event.type === 'tool/result') : undefined;
    }

    private bodyAgent(sessionId: string): SourceBodyAgent | undefined {
        if (!isSourceDisplayId(sessionId)) return undefined;
        if (isSourceChildDisplayId(sessionId)) {
            const child = this.ctx.agents.get(SessionId(sessionId));
            return child instanceof HapiObservedChild || isHapiDshChildAgent(child) ? child : undefined;
        }
        const agent = this.options.codex.get(sessionId) ?? this.options.observed.get(sessionId);
        return agent?.id === sessionId ? agent : undefined;
    }

    private childAttachmentGrants(agent: SourceBodyAgent): SourceWindowAttachments {
        const existing = this.childAttachments.get(agent.id);
        if (existing?.agent === agent) return existing.grants;
        existing?.grants.dispose();
        const grants = new SourceWindowAttachments(agent.id, agent.id);
        this.childAttachments.set(agent.id, { agent, grants });
        agent.ctx.effect(() => () => {
            grants.dispose();
            if (this.childAttachments.get(agent.id)?.grants === grants) this.childAttachments.delete(agent.id);
        }, 'hapi-dsh: source child image grants');
        return grants;
    }

    sourceHistoryWindowPage(request: SourceHistoryWindowRequest): Promise<SourceHistoryWindowValue> {
        return this.readSourceHistoryWindowPage(request);
    }

    private readSourceHistoryWindowPage(request: SourceHistoryWindowRequest, signal?: AbortSignal): Promise<SourceHistoryWindowValue> {
        return this.sourceCall(async () => {
            signal?.throwIfAborted();
            await this.ensureDisplayAgent(request.sessionId);
            signal?.throwIfAborted();
            const window = this.requireHistoryWindow(request.sessionId);
            const agent = this.sourceAgent(request.sessionId);
            const source = this.workbenchSource(request.sessionId);
            if (!source) throw new RemoteError('hapi/request', 'The source window has no verified machine identity', {
                outcome: 'rejected', status: 409, sourceCode: 'source_unavailable' });
            const respond = (page: Awaited<ReturnType<typeof window.windowAt>>): SourceHistoryWindowValue => {
                const { resourceEnrichment, ...value } = page;
                if (resourceEnrichment) {
                    void resourceEnrichment.then(frames => agent.publishHistoryPageEnrichment?.(frames)).catch(() => {
                        // The transcript page is already committed; optional attachment conversion may fail independently.
                        console.warn('[hapi-dsh] source history resource enrichment failed');
                    });
                }
                return { ...value, records: [...value.records], frames: [...value.frames] };
            };
            if (request.messageId !== undefined) {
                const page = await window.windowAt(request.messageId, request.radius ?? 50, request.startSeq ?? 3_000_000_000, async (messageId, radius) => {
                    const value = await this.options.extras.sourceMessageContext({ source, messageId, radius });
                    return { messages: value.messages as unknown as readonly HapiMessage[], page: {
                        beforeCursor: value.page.beforeCursor, afterCursor: value.page.afterCursor,
                        hasMoreBefore: value.page.hasMoreBefore, hasMoreAfter: value.page.hasMoreAfter,
                        epoch: value.page.epoch, reset: value.page.reset } };
                });
                return respond(page);
            }
            if (request.fromOldest) {
                const page = await window.windowOldest(request.endSeq ?? 3_000_000_000,
                    (cursor, epoch) => readSourceHistoryPage(this.options.client, agent.binding.hapiSessionId,
                        'before', cursor, epoch, request.limit, signal), signal, request.limit);
                return respond(page);
            }
            if (request.beforeAt !== undefined && request.beforeSeq !== undefined) {
                const before = { at: request.beforeAt, seq: request.beforeSeq };
                const page = await window.windowBefore(before, request.endSeq ?? 3_000_000_000,
                    (cursor, epoch) => readSourceHistoryPage(this.options.client, agent.binding.hapiSessionId,
                        'before', cursor, epoch, request.limit, signal), request.epoch, request.cursorMessageId, signal, request.limit);
                return respond(page);
            }
            if (request.afterAt !== undefined && request.afterSeq !== undefined) {
                const after = { at: request.afterAt, seq: request.afterSeq };
                const page = await window.windowAfter(after, request.startSeq ?? 3_000_000_000,
                    (cursor, epoch) => readSourceHistoryPage(this.options.client, agent.binding.hapiSessionId,
                        'after', cursor, epoch, request.limit, signal), request.epoch, request.cursorMessageId, signal, request.limit);
                return respond(page);
            }
            throw new RemoteError('hapi/request', 'The source window request has no route', { outcome: 'rejected', status: 400 });
        });
    }

    /** Stream a bounded page as small WebSocket messages; the client commits only after the cursor record. */
    @Remote({ mode: 'stream', resources: { session: (request: SourceHistoryWindowRequest) => SessionId(request.sessionId) } })
    async *sourceHistoryWindowPageStream(request: SourceHistoryWindowRequest, signal: AbortSignal): RemoteStream<SourceHistoryWindowPageStreamItem, never> {
        signal.throwIfAborted();
        const page = await this.readSourceHistoryWindowPage(request, signal);
        const frames = page.frames ?? [];
        for (const batch of chunkSourceFramesNearestFirst(frames, SOURCE_HISTORY_FRAME_CHUNK_SIZE)) {
            signal.throwIfAborted();
            yield { kind: 'frames', frames: batch };
        }
        signal.throwIfAborted();
        const { records: _records, frames: _frames, ...value } = page;
        yield { kind: 'complete', value };
    }

    /**
     * Read an image that this display's bounded source history page actually
     * served. The official `session/attachment` route remains the only reader
     * for refs in the original Session log and for every ordinary Session.
     */
    @Remote({ resources: { session: (request: SourceHistoryAttachmentRequest) => SessionId(request.sessionId) } })
    sourceHistoryAttachment(request: SourceHistoryAttachmentRequest): Promise<SourceHistoryAttachmentValue> {
        return this.sourceCall(async () => {
            if (!isSourceDisplayId(request.sessionId)) {
                throw new RemoteError('hapi/request', 'This source display has no active history window', {
                    outcome: 'rejected', status: 404, sourceCode: 'source_window_unavailable',
                })
            }
            const window = this.options.historyWindows.peek(request.sessionId)
            const child = isSourceChildDisplayId(request.sessionId) ? this.childAttachments?.get(request.sessionId) : undefined
            const activeChild = child && this.bodyAgent(request.sessionId) === child.agent ? child : undefined
            const grants = window?.attachments ?? activeChild?.grants
            const epoch = window?.epoch ?? activeChild?.agent.sourceHistoryVersion()
            if (!grants) throw new RemoteError('hapi/request', 'This source display has no active history window', {
                outcome: 'rejected', status: 404, sourceCode: 'source_window_unavailable',
            })
            try {
                const stored = await grants.read(this.ctx.attachments, request.attachmentId, epoch,
                    this.ctx.invocation?.signal)
                if (window && window.attachments !== grants) {
                    throw new HapiRequestError('The source history changed while reading its image.', 'rejected', 404, 'attachment_not_referenced')
                }
                if (activeChild && (this.bodyAgent(request.sessionId) !== activeChild.agent
                    || activeChild.agent.sourceHistoryVersion() !== epoch)) {
                    throw new HapiRequestError('The source child changed while reading its image.', 'rejected', 404, 'attachment_not_referenced')
                }
                return { attachment: stored.ref, data: Buffer.from(stored.data).toString('base64') }
            } catch (error) {
                const denial = sourceAttachmentErrorOf(error)
                if (denial) {
                    throw new HapiRequestError(denial.message, 'rejected',
                        denial.reason === 'ATTACHMENT_TOO_LARGE' ? 413 : denial.reason === 'ATTACHMENT_WINDOW_CLOSED' ? 410 : 404,
                        denial.reason.toLowerCase())
                }
                throw error
            }
        })
    }
    sourceReadingAnchor(request: { sessionId: string; seq: number }): Promise<{ sourceMessageId: string | null }> {
        return this.sourceCall(async () => ({ sourceMessageId: this.sourceMessageAtDisplaySeq(request.sessionId, request.seq) ?? null }));
    }
    sourceLocateMessage(request: { sessionId: string; sourceMessageId: string }): Promise<{ sessionId: string; seq: number | null }> {
        return this.sourceCall(async () => {
            const agent = this.sourceAgent(request.sessionId);
            const sourceId = agent.binding.hapiSessionId;
            await agent.refresh(true);
            const current = this.options.codex.byHapiSession(sourceId) ?? this.options.observed.byHapiSession(sourceId);
            const sessionId = current?.id ?? agent.id;
            const known = this.displaySeqForSourceMessage(sessionId, request.sourceMessageId);
            if (known !== null) return { sessionId, seq: known };
            // Do not walk or materialize intervening archive pages. A target
            // is navigable only when its display mapping is already retained;
            // an unvisited source cursor has no public exact display seq yet.
            return { sessionId, seq: null };
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
    /**
     * A restored display id can outlive the Host process that materialized its
     * observed agent. Reattach it from the current Hub catalog before a window
     * read, so a saved layout never sees "no active history window".
     */
    private async ensureDisplayAgent(displayId: string): Promise<void> {
        if (!isSourceDisplayId(displayId) || isSourceChildDisplayId(displayId)) return;
        // Window-only Host fixtures may not compose the native/observed engines;
        // no display can be reattached there, and reads must still work.
        const codex = this.options.codex, observed = this.options.observed;
        if (!codex || !observed) return;
        const logical = logicalDisplayId(displayId);
        if (codex.get(displayId) ?? observed.get(displayId)
            ?? codex.get(logical) ?? observed.get(logical)) return;
        try {
            const catalog = await this.catalog();
            // `sessions` lists attached agents; the Hub catalog is sourceDiscovery.
            const discovered = catalog.sourceDiscovery?.sessions ?? [];
            const source = discovered.find(session => observedSessionId(this.options.client.hubId, session.sourceSessionId) === logical);
            const attached = source ? await this.options.observed.attach(source.sourceSessionId, undefined, { deferChildren: true }) : undefined;
            console.warn(`[hapi-dsh] ensure display logical=${logical.slice(-10)} discovered=${discovered.length} matched=${Boolean(source)} attached=${Boolean(attached)}`);
        } catch (error) { console.warn(`[hapi-dsh] ensure display failed logical=${logical.slice(-10)} error=${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`) }
    }

    private requireHistoryWindow(sessionId: string): SourceHistoryWindow {
        const window = this.sourceHistoryWindow(sessionId);
        if (!window) {
            // Bounded, sanitized diagnosis: display kind and owner lookup only.
            const prefix = sessionId.split('-').slice(0, 2).join('-');
            console.warn(`[hapi-dsh] outline window missing prefix=${prefix} source=${isSourceDisplayId(sessionId)} child=${isSourceChildDisplayId(sessionId)} native=${Boolean(this.options.codex.get(sessionId))} observed=${Boolean(this.options.observed.get(sessionId))}`);
            throw new RemoteError('hapi/request', 'This source display has no active history window', {
                outcome: 'rejected', status: 404, sourceCode: 'source_window_unavailable' });
        }
        return window;
    }
    private sourceAgent(id: string): NativeCodexAgent | HapiObservedAgent {
        const agent = this.options.codex.get(id) ?? this.options.observed.get(id)
            ?? this.options.codex.get(logicalDisplayId(id)) ?? this.options.observed.get(logicalDisplayId(id));
        if (!agent) throw new RemoteError('hapi/request', 'This source display is unavailable or was replaced; refresh the workspace.', { outcome: 'rejected', status: 404 });
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

/** Host composition. Optional source-built DSH reading extensions are pinned by the distribution. */
export async function apply(ctx: Context, input: Config): Promise<void> {
    const config = await readConfig(input.configFile);
    const dataDirectory = join(config.dsh.home, 'profiles', config.dsh.profile, 'data', 'hapi-dsh');
    const federation = new FederationHub({ credentialsFile: config.federation?.credentialsFile ?? join(dataDirectory, 'machines.json'),
        identity: runtimeIdentity({ dshVersion: DSH_VERSION, dshHome: config.dsh.home, profile: config.dsh.profile }) });
    ctx.effect(() => () => federation.close(), 'hapi-dsh: Runner connections');
    ctx.effect(() => mountBootstrapRoute({
        webServer: ctx.webServer, clientModules: ctx.clientModules, connection: ctx.connection,
        appReady: ctx.get('appReady') as { onReady(callback: () => void): () => void },
    }), 'hapi-dsh: local pane plugin bootstrap');
    ctx.on('webserver/index-inject', table => {
        stageWorkspaceBoot(table, ctx.clientModules.graph());
        table.push(compressedStreamInjection);
        table.push(...workspaceBootInjections());
    });
    ctx.effect(() => ctx.webServer.tapIndex(deferWorkspaceEntry), 'hapi-dsh: first-paint workspace layout');
    ctx.effect(() => mountCompressedStream({ webServer: ctx.webServer, connection: ctx.connection }), 'hapi-dsh: compressed official streams');
    ctx.effect(() => mountVersionedAssets(ctx.webServer), 'hapi-dsh: versioned Web shell assets');
    await federation.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    ctx.effect(() => mountPluginEvents({ webServer: ctx.webServer, connection: ctx.connection,
        hasHost: id => federation.listMachines().some(host => host.id === id && host.online),
    }), 'hapi-dsh: multiplexed official plugin events');
    installSources(ctx, config.sources ?? [], join(dataDirectory, 'sources'), config.hapi !== undefined);
    if (!config.hapi) {
        new WorkspaceShell(ctx, federation, new WorkspaceRepository(join(dataDirectory, 'workspace.json')), JSON.stringify([config.dsh.home, config.dsh.profile]));
        return;
    }
    const hapiToken = resolveHapiToken(config);
    const client = new HapiClient({ hubId: config.hapi.id, url: config.hapi.url, token: hapiToken })
    const historyWindows = new DisplayHistoryWindows();
    let hapiController: HapiController;
    const companion = new SourceCompanionService({ hubId: config.hapi.id, sourceUrl: config.hapi.url,
        ...(config.hapi.companionUrl ? { companionUrl: config.hapi.companionUrl } : {}), readCredential: () => hapiToken });
    // One HAPI resume callback for the durable delivery path. A delivery only
    // uses it after an explicit `session_inactive` (409) rejection, once.
    const resumeSession = (hapiSessionId: string): Promise<string> => client.resumeSession(hapiSessionId);
    const codex = new CodexService(ctx, client, {
        stateDirectory: join(dataDirectory, 'native'), fastHistorySeed: true, discovery: 'on-demand', resolveAttachments: attachmentResolver(ctx.attachments, client),
        importArtifact: artifactImporter(ctx.attachments, client),
        onError: (error) => { ctx.logger.warn(`Native Codex synchronization: ${error.message}`); },
        onDisplayRetired: displayId => historyWindows.retire(displayId),
        resumeSession,
    });
    const observed = new HapiAgentService(ctx, client, {
        stateDirectory: join(dataDirectory, 'observed'), fastHistorySeed: true, discovery: 'on-demand', resolveAttachments: attachmentResolver(ctx.attachments, client),
        importArtifact: artifactImporter(ctx.attachments, client), importAttachment: sourceUploadImporter(ctx.attachments, client),
        importGeneratedMedia: sourceGeneratedMediaImporter(ctx.attachments, client),
        importInline: sourceInlineImporter(ctx.attachments),
        onError: error => { ctx.logger.warn(`HAPI session synchronization: ${error.message}`); },
        onDisplayRetired: displayId => historyWindows.retire(displayId),
        resumeSession,
    });
    const nativeControl = new NativeControl(client, {
        get: id => codex.get(id),
        attach: id => codex.attach(id, undefined, { deferChildren: true }),
        resolveForkBoundary: (sessionId, messageId) => hapiController.resolveHistoryFork(sessionId, messageId),
    }, join(dataDirectory, 'native'));
    const observedControl = new HapiObservedControl(client, observed, join(dataDirectory, 'observed'));
    const nativeCreation = new NativeCreation(client, codex, join(dataDirectory, 'native'));
    const sourceCreation = new SourceCreation(client, observed, join(dataDirectory, 'observed'));
    const sourceLifecycle = new SourceLifecycle(client, {
        get: id => observed.get(id),
        reconcileSource: id => observed.reconcileSource(id),
        detachSource: id => observed.detachSource(id),
        resolveRewind: (sessionId, seq) => hapiController.resolveHistoryRewind(sessionId, seq),
        resolveRewindMessage: (sessionId, messageId) => hapiController.resolveHistoryRewindMessage(sessionId, messageId),
    }, join(dataDirectory, 'observed'));
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
        resolveRewind: (sessionId, seq) => hapiController.resolveHistoryRewind(sessionId, seq),
        resolveRewindMessage: (sessionId, messageId) => hapiController.resolveHistoryRewindMessage(sessionId, messageId),
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
    ctx.effect(() => ctx.llm.registerAdapter([NATIVE_CODEX_PROVIDER, HAPI_OBSERVED_PROVIDER], new NativeModelMetadata()), 'hapi-dsh: source model metadata');
    workbench.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    terminal.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    extras.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    voice.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    notifications.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    ctx.effect(() => mountShareTarget({ webServer: ctx.webServer }), 'hapi-dsh: browser share target');
    hapiController = new HapiController(ctx, { config, client, codex, observed, observedControl, federation, nativeControl, nativeCreation, sourceCreation, sourceLifecycle, initialTasks, sourceHistory, administration, companion, voice, notifications, bulk, queuedEdits, nativePlan, nativeLibrary, workbench, legacyTerminals, extras, historyWindows, workspace: new WorkspaceRepository(join(dataDirectory, 'workspace.json')) });
    const startup = await startSourceCatalogs([{ name: 'Native Codex', start: () => codex.start() }, { name: 'HAPI', start: () => observed.start() }],
        (source, error) => { ctx.logger.warn(`${source} catalog synchronization failed; source sessions will reconnect: ${error instanceof Error ? error.message : 'connection failed'}`); });
    if (startup === 'background') ctx.logger.info('The initial HAPI catalog is still loading. The Host is ready; all source sessions continue synchronizing in the background.');
}
