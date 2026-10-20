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
import type { SessionRenameValue } from '@deepseek-ai/dsh-api-session-controller/types';
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
import { HapiRequestError, type HapiCancelResult, type HapiSteerResult, type HapiRetryResult } from './codex/contracts.ts';
import { CodexService, type NativeCodexAgent } from './codex/index.ts';
import { attachmentResolver, artifactImporter } from './hapi/attachments.ts';
import { NativeModelMetadata, NATIVE_CODEX_PROVIDER } from './hapi/model-adapter.ts';
import { NativeControl } from './hapi/native-control.ts';
import { NativeCreation } from './hapi/native-creation.ts';
import { NativePlan } from './hapi/native-plan.ts';
import { WorkspaceRepository } from './hub/workspaces.ts';
import { FederationHub } from './hub/federation.ts';

export const name = 'hapi-dsh';
export const inject = ['agents', 'sessions', 'sessionProjections', 'attachments', 'llm', 'typert', 'webServer', 'connection'];
export interface Config { configFile: string }
export const Config: S<Config> = S.object({ configFile: S.string().required() });

declare module '@deepseek-ai/cordis' { interface Context { hapi: HapiController } }

interface ControllerOptions {
    config: RuntimeConfig;
    client: HapiClient;
    codex: CodexService;
    workspace: WorkspaceRepository;
    federation: FederationHub;
    nativeControl: NativeControl;
    nativeCreation: NativeCreation;
    nativePlan: NativePlan;
}

/** The native control surface uses DSH's existing Remote registration and access policy. */
export class HapiController extends TypertRemoteService {
    private machineCache: Awaited<ReturnType<HapiClient['listMachines']>> = [];
    private machineCacheAt = 0;
    private machineRead: Promise<void> | undefined;

    constructor(ctx: Context, private readonly options: ControllerOptions) {
        super(ctx, 'hapi');
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
        await this.refreshMachines();
        const client = this.options.client;
        return {
            hubId: client.hubId, connected: client.isConnected,
            machines: this.machineCache.map(machine => ({
                id: machine.id, label: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id,
                online: client.isConnected && machine.active,
            })),
            sessions: this.options.codex.list().map(agent => ({
                id: agent.id, logicalSessionId: agent.logicalSessionId, displayRevision: agent.displayRevision,
                hapiSessionId: agent.binding.hapiSessionId, machineId: agent.binding.machineId,
                engine: 'codex', title: agent.sourceSession.metadata?.name ?? agent.sourceSession.metadata?.summary?.text ?? agent.binding.threadId,
                cwd: agent.sourceSession.metadata?.path ?? '',
            })),
            hosts: this.options.federation.listMachines().map(machine => ({ id: machine.id, label: machine.name, online: machine.online, basePath: machine.baseUrl })),
        };
    }

    async machineOptions(request: { machineId: string }): Promise<MachineOptions> {
        const path = `/api/machines/${encodeURIComponent(request.machineId)}`;
        const [homes, models] = await Promise.allSettled([
            this.options.client.request(`${path}/codex-homes`), this.options.client.request(`${path}/codex-models`),
        ]);
        const result: MachineOptions = { homes: [], models: [], warnings: [] };
        const homeSchema = z.object({ success: z.boolean(), homes: z.array(z.object({ id: z.string(), label: z.string(), path: z.string() })).optional() });
        const modelSchema = z.object({ success: z.boolean(), models: z.array(z.object({
            id: z.string(), displayName: z.string(), supportedReasoningEfforts: z.array(z.string()).optional(),
        })).optional() });
        if (homes.status === 'fulfilled') {
            const parsed = homeSchema.safeParse(homes.value);
            if (parsed.success && parsed.data.success) result.homes = (parsed.data.homes ?? []).map(home => ({ id: home.id, name: home.label, path: home.path }));
            else result.warnings.push('Codex home discovery is unavailable on this Runner.');
        } else result.warnings.push('Codex home discovery is unavailable on this Runner.');
        if (models.status === 'fulfilled') {
            const parsed = modelSchema.safeParse(models.value);
            if (parsed.success && parsed.data.success) result.models = (parsed.data.models ?? []).map(model => ({ id: model.id, name: model.displayName, reasoningEfforts: model.supportedReasoningEfforts ?? [] }));
            else result.warnings.push('Codex model discovery is unavailable on this Runner.');
        } else result.warnings.push('Codex model discovery is unavailable on this Runner.');
        return result;
    }

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
    nativePlan(request: { sessionId: string }): Promise<NativePlanState> {
        return this.sourceCall(() => this.options.nativePlan.state(request.sessionId));
    }
    nativeImplementPlan(request: NativeImplementPlan): Promise<NativePlanReceipt> {
        return this.sourceCall(() => this.options.nativePlan.implement(request));
    }
    async resumeSession(request: { sessionId: string }): Promise<{ sessionId: string }> {
        return this.sourceCall(async () => {
            const agent = this.native(request.sessionId);
            const sourceId = await this.options.client.resumeSession(agent.binding.hapiSessionId);
            if (sourceId !== agent.binding.hapiSessionId) throw new HapiRequestError('HAPI returned a different native identity during resume', 'indeterminate');
            await agent.refresh(true);
            return { sessionId: this.options.codex.byHapiSession(sourceId)?.id ?? agent.id };
        });
    }
    nativeCancel(request: NativeQueueRequest): Promise<HapiCancelResult> {
        return this.sourceCall(() => this.native(request.sessionId).cancelQueued(request.localId));
    }
    nativeSteer(request: NativeQueueRequest): Promise<HapiSteerResult> {
        return this.sourceCall(() => this.native(request.sessionId).steerQueued(request.localId));
    }
    nativeRetry(request: NativeQueueRequest): Promise<HapiRetryResult> {
        return this.sourceCall(() => this.native(request.sessionId).retryIndeterminate(request.localId));
    }
    async nativeAnswer(request: NativeAnswerRequest): Promise<{ submitted: true }> {
        return this.sourceCall(async () => {
            await this.native(request.sessionId).answerApproval(request.requestId, request.answer, request.deny);
            return { submitted: true };
        });
    }
    nativeSettings(request: { sessionId: string }): Promise<NativeSettings> {
        return this.sourceCall(() => this.options.nativeControl.settings(request.sessionId));
    }
    nativeApplySetting(request: NativeApplySetting): Promise<NativeSettingReceipt> {
        return this.sourceCall(() => this.options.nativeControl.applySetting(request));
    }
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
    workspaceGet(): Promise<WorkspaceDocument> { return this.options.workspace.get(); }
    workspacePut(request: WorkspaceWrite): Promise<WorkspaceWriteResult> { return this.options.workspace.put(request); }

    private native(id: string): NativeCodexAgent {
        const agent = this.options.codex.get(id);
        if (!agent) throw new RemoteError('hapi/request', 'The native session is unavailable; refresh the workspace.', { outcome: 'rejected', status: 404 });
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
    const client = new HapiClient({ hubId: config.hapi.id, url: config.hapi.url, token: resolveHapiToken(config) });
    const codex = new CodexService(ctx, client, {
        stateDirectory: join(dataDirectory, 'native'), resolveAttachments: attachmentResolver(ctx.attachments, client),
        importArtifact: artifactImporter(ctx.attachments, client),
        onError: (error) => { ctx.logger.warn(`Native Codex synchronization: ${error.message}`); },
    });
    const federation = new FederationHub({ credentialsFile: config.federation?.credentialsFile ?? join(dataDirectory, 'machines.json') });
    const nativeControl = new NativeControl(client, codex, join(dataDirectory, 'native'));
    const nativeCreation = new NativeCreation(client, codex, join(dataDirectory, 'native'));
    const nativePlan = new NativePlan(client, codex, join(dataDirectory, 'native'));
    ctx.effect(() => () => nativeControl.settled(), 'hapi-dsh: native control submissions');
    ctx.effect(() => () => nativeCreation.settled(), 'hapi-dsh: native creation observations');
    ctx.effect(() => () => nativePlan.settled(), 'hapi-dsh: native plan submissions');
    ctx.effect(() => () => client.close(), 'hapi-dsh: HAPI connection');
    ctx.effect(() => () => codex.dispose(), 'hapi-dsh: native observation');
    ctx.effect(() => () => federation.close(), 'hapi-dsh: Runner connections');
    ctx.effect(() => ctx.llm.registerAdapter([NATIVE_CODEX_PROVIDER], new NativeModelMetadata()), 'hapi-dsh: native model metadata');
    await federation.mount({ webServer: ctx.webServer, authorize: request => ctx.connection.requestRejection(request) });
    new HapiController(ctx, { config, client, codex, federation, nativeControl, nativeCreation, nativePlan, workspace: new WorkspaceRepository(join(dataDirectory, 'workspace.json')) });
    try { await codex.start(); }
    catch (error) { ctx.logger.warn(`HAPI is currently unavailable; native sessions will reconnect: ${error instanceof Error ? error.message : 'connection failed'}`); }
}
