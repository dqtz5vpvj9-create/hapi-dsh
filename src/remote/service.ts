import type { SourceUploadRequest } from './protocol.ts';
/** HHPI methods use the official authenticated Typert carrier and its resource policies. */
import type { CodexCall, CodexReply, CodexEventsRequest } from './codex-access.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService, principalOf, type RemoteStream, type TypertResource } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { HHPI_REMOTE } from '../hhpi-api.ts';
import { SourceGateway, type SourceAccess } from './gateway.ts';
import { DirectCodexAdapter } from './codex-adapter.ts';
import { SourceAccessDenied, SourceError } from './errors.ts';
import { withWorkspaceService } from '../shared/source-access.ts';
import { createSourceWorkspaceProviders } from '../workspace/source-services.ts';
import { SOURCE_WORKSPACE_HOST_CONTRACT, type SourceDirectoryRequest, type SourceDirectoryListing, type SourceWorkspaceDescription } from '../workspace/source-api.ts';
import { SOURCE_TERMINAL_HOST_CONTRACT } from '../workspace/terminal-api.ts';
import { SOURCE_NAVIGATION_HOST_CONTRACT } from '../workspace/source-navigation-api.ts';
import { SourceNavigationService } from '../workspace/source-navigation-service.ts';
import { SourceTerminalService } from '../workspace/source-terminal-service.ts';
import { installSourceUploadRoute } from '../workspace/source-upload-route.ts';
import { installLocalSourceWorkspaces } from '../workspace/local-source.ts';
import type { SourceWorkspaceConfig } from './config.ts';
import type { WorkspaceAccess, WorkspaceAction, WorkspaceServices } from '../workspace/service-types.ts';
import type { WorkspaceDocumentRef, WorkspaceFileManageRequest, WorkspaceFileSaveRequest, WorkspaceUploadStart, WorkspaceUploadRequest } from '../workbench-types.ts';
import type { WorkspaceByteReadOptions, WorkspaceFileRange, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types';
import type { DirectSourceConfig, SourceCatalog, SourceChanges, SourceChangesRequest, SourceCreateRequest, SourceCreationReceipt,
    SourceOperation, SourcePage, SourceReadRequest, SourceReceipt, SourceResource, SourceResourceRequest, SourceSession } from './protocol.ts';

declare module '@deepseek-ai/cordis' { interface Context { hhpi: HhpiSourceService; sourceWorkspace: SourceWorkspaceService } }
declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertResourceMap { hhpiSource: TypertResource<string> } }
function remoteError(error: unknown, reading = false): never {
    if (error instanceof RemoteError || error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof SourceAccessDenied) throw new RemoteError('remote-access/denied', error.message, { action: 'hhpi/source', reason: 'no-allow' });
    const source = error instanceof SourceError ? error : new SourceError('HISTORY_UNAVAILABLE', 'The source returned data that could not be accepted.');
    throw new RemoteError('hhpi/source', source.message, { sourceCode: reading && source.code === 'UNSUPPORTED' ? 'HISTORY_UNAVAILABLE' : source.code, outcome: source.code === 'OUTCOME_UNKNOWN' ? 'indeterminate' : 'rejected' });
}
const addressedSession = (request: { sessionId: string }): readonly SessionId[] => [request.sessionId as SessionId];
const addressedSource = (request: { sourceId: string }): readonly string[] => [request.sourceId];
// Host and Client augment the same Cordis key with different service types.
// Keep the invocation-derived accessor while naming this Host-only dependency.
const hostRemoteAccess = (ctx: Context): RemoteAccessService => ctx.remoteAccess as unknown as RemoteAccessService;
export const HHPI_HOST_CONTRACT = {
    invocations: HHPI_REMOTE.descriptors,
    services: [{ key: 'hhpi', exportName: 'HhpiSourceService', tags: [], members: [], types: [], summary: 'Scoped native source access.' }],
};
/** One package face registration; independent namespaces do not change HHPI v1. */
export const SOURCE_HOST_CONTRACT = {
    invocations: [...HHPI_HOST_CONTRACT.invocations, ...SOURCE_WORKSPACE_HOST_CONTRACT.invocations, ...SOURCE_TERMINAL_HOST_CONTRACT.invocations, ...SOURCE_NAVIGATION_HOST_CONTRACT.invocations],
    services: [...HHPI_HOST_CONTRACT.services, ...SOURCE_WORKSPACE_HOST_CONTRACT.services, ...SOURCE_TERMINAL_HOST_CONTRACT.services, ...SOURCE_NAVIGATION_HOST_CONTRACT.services],
};
/** Principal fields are JSON identity, never credentials. Canonical ordering keeps one account scope across restarts. */
export function sourceStorageScope(directory: string, principal: unknown = { kind: 'owner' }): string {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    return createHash('sha256').update(JSON.stringify([directory, canonical(principal)])).digest('hex');
}
/** Runner-only composition; display Hosts publish the combined workspace face. */
export function registerSourceContract(ctx: Context): void {
    ctx.effect(() => ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: SOURCE_HOST_CONTRACT.invocations,
        model: { services: SOURCE_HOST_CONTRACT.services, events: [], objects: [] } }), 'hhpi: source Remote contract');
}

/** Register beside the source contract through the existing authenticated Gateway. */
export function registerSourceWorkspaceContract(ctx: Context): void {
    ctx.effect(() => ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: SOURCE_WORKSPACE_HOST_CONTRACT.invocations,
        model: { services: SOURCE_WORKSPACE_HOST_CONTRACT.services, events: [], objects: [] } }), 'hhpi: source workspace Remote contract');
}

/** Source OS services have their own namespace; no Agent workspaceFileScope lookup is performed. */
export class SourceWorkspaceService extends TypertRemoteService {
    constructor(ctx: Context, private readonly gateway: SourceGateway, private readonly options: { localHostId: string; scopeId: string }) {
        super(ctx, 'sourceWorkspace');
    }
    @Remote({ name: 'directories', resources: { hhpiSource: addressedSource } })
    async directories(request: SourceDirectoryRequest, signal?: AbortSignal): Promise<SourceDirectoryListing> {
        try {
            const { sourceAccess, access } = this.callAccess(signal);
            return await this.gateway.directories(request, sourceAccess, access.signal);
        } catch (error) { remoteError(error); }
    }
    private callAccess(signal?: AbortSignal): { access: WorkspaceAccess; sourceAccess: SourceAccess } {
        const ctx = this.ctx, invocation = ctx.invocation;
        if (!invocation) throw new SourceAccessDenied();
        const access: WorkspaceAccess = {
            scope: sourceStorageScope(this.options.scopeId, principalOf(invocation)),
            signal: AbortSignal.any([invocation.signal, invocation.peer.signal, ...(signal ? [signal] : [])]),
            assertAllowed: (target, action) => {
                if (target.hostId !== this.options.localHostId || !hostRemoteAccess(ctx).allows({ kind: 'session', id: target.sessionId as SessionId })) throw new SourceAccessDenied();
                // A document read also asks whether Save should be offered. `allows`
                // checks the current endpoint, so its read grant cannot answer that question.
                if ((action === 'save' || action === 'manage') && invocation.request.method !== action) {
                    const snapshot = hostRemoteAccess(ctx).snapshotFor(invocation.peer.principal);
                    if (!snapshot.owner && !snapshot.grants.some(grant => grant.resource.kind === 'session'
                        && grant.resource.id === target.sessionId && grant.actions.includes(`sourceWorkspace/${action}`))) throw new SourceAccessDenied();
                }
            },
        };
        const sourceAccess: SourceAccess = resource => hostRemoteAccess(ctx).allows(resource.kind === 'source'
            ? { kind: 'hhpiSource', id: resource.id } : { kind: 'session', id: resource.id as SessionId });
        return { access, sourceAccess };
    }
    private async execute<T>(sessionId: string, action: WorkspaceAction, signal: AbortSignal | undefined,
        invoke: (services: WorkspaceServices, access: WorkspaceAccess) => Promise<T>): Promise<T> {
        try {
            const { access, sourceAccess } = this.callAccess(signal);
            return await withWorkspaceService({ hostId: this.options.localHostId, sessionId }, action, access,
                createSourceWorkspaceProviders({ localHostId: this.options.localHostId, gateway: this.gateway, sourceAccess, action }), invoke);
        } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'resolve', resources: { session: addressedSession } })
    resolve(request: { sessionId: string }, signal?: AbortSignal): Promise<SourceWorkspaceDescription> {
        return this.execute(request.sessionId, 'read', signal, async services => ({ binding: services.binding,
            registered: { files: true, documents: true, mutations: !!services.mutations, uploads: !!services.uploads && this.ctx.invocation?.peer.principal.kind === 'owner', terminals: !!services.terminals } }));
    }
    @Remote({ name: 'read', resources: { session: (sessionId: string) => [sessionId as SessionId] } })
    read(sessionId: string, path: string, range: WorkspaceFileRange, signal?: AbortSignal) {
        return this.execute(sessionId, 'read', signal, (services, access) => services.files.read(path, range, access));
    }
    @Remote({ name: 'readBytes', resources: { session: (sessionId: string) => [sessionId as SessionId] } })
    readBytes(sessionId: string, path: string, options: WorkspaceByteReadOptions, signal?: AbortSignal) {
        return this.execute(sessionId, 'read', signal, (services, access) => services.files.readBytes(path, options, access));
    }
    @Remote({ name: 'stat', resources: { session: (sessionId: string) => [sessionId as SessionId] } })
    stat(sessionId: string, path: string, signal?: AbortSignal) {
        return this.execute(sessionId, 'read', signal, (services, access) => services.files.stat(path, access));
    }
    @Remote({ name: 'list', resources: { session: (sessionId: string) => [sessionId as SessionId] } })
    list(sessionId: string, path: string, signal?: AbortSignal) {
        return this.execute(sessionId, 'list', signal, (services, access) => services.files.list(path, access));
    }
    @Remote({ name: 'changes', mode: 'stream', resources: { session: (sessionId: string) => [sessionId as SessionId] } })
    async *changes(sessionId: string, path: string, signal?: AbortSignal): RemoteStream<WorkspaceFileWatchFrame> {
        const { services, access } = await this.execute(sessionId, 'watch', signal, async (services, access) => ({ services, access }));
        try {
            for await (const frame of services.files.changes(path, access)) {
                access.signal.throwIfAborted(); await access.assertAllowed(services.binding.target, 'watch'); yield frame;
            }
        } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'openDocument', resources: { session: addressedSession } })
    openDocument(request: { sessionId: string; document: WorkspaceDocumentRef }, signal?: AbortSignal) {
        return this.execute(request.sessionId, 'read', signal, (services, access) => services.documents.open(request.document, access));
    }
    @Remote({ name: 'readDocumentBytes', resources: { session: addressedSession } })
    readDocumentBytes(request: { sessionId: string; document: WorkspaceDocumentRef; options: WorkspaceByteReadOptions }, signal?: AbortSignal) {
        return this.execute(request.sessionId, 'read', signal, (services, access) => services.documents.bytes(request.document, request.options, access));
    }
    @Remote({ name: 'inspect', resources: { session: addressedSession } })
    inspect(request: { sessionId: string; path: string }, signal?: AbortSignal) {
        return this.execute(request.sessionId, 'read', signal, (services, access) => services.documents.inspect(request.path, access));
    }
    @Remote({ name: 'search', resources: { session: addressedSession } })
    search(request: { sessionId: string; query: string; limit: number }, signal?: AbortSignal) {
        return this.execute(request.sessionId, 'read', signal, (services, access) => services.documents.search(request.query, request.limit, access));
    }
    @Remote({ name: 'git', resources: { session: addressedSession } })
    git(request: { sessionId: string; kind: 'status' | 'numstat' | 'diff'; path?: string; staged?: boolean }, signal?: AbortSignal) {
        const { sessionId, ...query } = request;
        return this.execute(sessionId, 'read', signal, (services, access) => services.documents.git(query, access));
    }
    @Remote({ name: 'uploadInputs', resources: { session: addressedSession } })
    async uploadInputs(request: { sessionId: string; receiptIds: readonly string[]; clientUserMessageId?: string }, signal?: AbortSignal) {
        try {
            const { access, sourceAccess } = this.callAccess(signal), target = { hostId: this.options.localHostId, sessionId: request.sessionId };
            await access.assertAllowed(target, 'read');
            const input = await this.gateway.uploadInputs(request, sourceAccess, access.signal);
            access.signal.throwIfAborted(); await access.assertAllowed(target, 'read');
            return { input };
        } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'beginUpload', resources: { session: (request: WorkspaceUploadStart) => [request.target.sessionId as SessionId] } })
    beginUpload(request: WorkspaceUploadStart, signal?: AbortSignal) {
        if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new SourceAccessDenied();
        return this.execute(request.target.sessionId, 'upload', signal, (services, access) => {
            if (request.target.hostId !== services.binding.target.hostId) throw new SourceAccessDenied();
            if (!services.uploads) throw new RemoteError('workspace-service/unavailable', 'Source uploads are not registered.', { reason: 'unconfigured' });
            return services.uploads.begin(request, access);
        });
    }
    @Remote({ name: 'uploadStatus', resources: { session: (request: WorkspaceUploadRequest) => [request.target.sessionId as SessionId] } })
    uploadStatus(request: WorkspaceUploadRequest, signal?: AbortSignal) {
        if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new SourceAccessDenied();
        return this.execute(request.target.sessionId, 'upload', signal, (services, access) => {
            if (request.target.hostId !== services.binding.target.hostId) throw new SourceAccessDenied();
            if (!services.uploads) throw new RemoteError('workspace-service/unavailable', 'Source uploads are not registered.', { reason: 'unconfigured' });
            return services.uploads.status(request, access);
        });
    }
    @Remote({ name: 'finishUpload', resources: { session: (request: WorkspaceUploadRequest) => [request.target.sessionId as SessionId] } })
    finishUpload(request: WorkspaceUploadRequest, signal?: AbortSignal) {
        if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new SourceAccessDenied();
        return this.execute(request.target.sessionId, 'upload', signal, (services, access) => {
            if (request.target.hostId !== services.binding.target.hostId) throw new SourceAccessDenied();
            if (!services.uploads) throw new RemoteError('workspace-service/unavailable', 'Source uploads are not registered.', { reason: 'unconfigured' });
            return services.uploads.finish(request, access);
        });
    }
    @Remote({ name: 'cancelUpload', resources: { session: (request: WorkspaceUploadRequest) => [request.target.sessionId as SessionId] } })
    cancelUpload(request: WorkspaceUploadRequest, signal?: AbortSignal) {
        if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new SourceAccessDenied();
        return this.execute(request.target.sessionId, 'upload', signal, (services, access) => {
            if (request.target.hostId !== services.binding.target.hostId) throw new SourceAccessDenied();
            if (!services.uploads) throw new RemoteError('workspace-service/unavailable', 'Source uploads are not registered.', { reason: 'unconfigured' });
            return services.uploads.cancel(request, access);
        });
    }
    @Remote({ name: 'save', resources: { session: (request: WorkspaceFileSaveRequest) => [request.target.sessionId as SessionId] } })
    save(request: WorkspaceFileSaveRequest, signal?: AbortSignal) {
        return this.execute(request.target.sessionId, 'save', signal, (services, access) => {
            if (request.target.hostId !== services.binding.target.hostId) throw new SourceAccessDenied();
            if (!services.mutations) throw new RemoteError('workspace-service/unavailable', 'Source file mutations are not registered.', { reason: 'unconfigured' });
            return services.mutations.save(request, access);
        });
    }
    @Remote({ name: 'manage', resources: { session: (request: WorkspaceFileManageRequest) => [request.target.sessionId as SessionId] } })
    manage(request: WorkspaceFileManageRequest, signal?: AbortSignal) {
        return this.execute(request.target.sessionId, 'manage', signal, (services, access) => {
            if (request.target.hostId !== services.binding.target.hostId) throw new SourceAccessDenied();
            if (!services.mutations) throw new RemoteError('workspace-service/unavailable', 'Source file mutations are not registered.', { reason: 'unconfigured' });
            return services.mutations.manage(request, access);
        });
    }
    @Remote({ name: 'receipt', resources: { session: addressedSession } })
    receipt(request: { sessionId: string; operationId: string }, signal?: AbortSignal) {
        return this.execute(request.sessionId, 'read', signal, (services, access) => {
            if (!services.mutations) throw new RemoteError('workspace-service/unavailable', 'Source file mutations are not registered.', { reason: 'unconfigured' });
            return services.mutations.receipt(request.operationId, access);
        });
    }
}

export class HhpiSourceService extends TypertRemoteService {
    constructor(ctx: Context, private readonly gateway: SourceGateway, private readonly directory?: string) {
        super(ctx, 'hhpi');
        ctx.typert.resources.register('hhpiSource', { field: 'sourceId' });
    }
    private get access(): SourceAccess {
        // Capture this invocation-derived Context, never an owner Context retained at startup.
        const ctx = this.ctx;
        return resource => resource.kind === 'source' ? hostRemoteAccess(ctx).allows({ kind: 'hhpiSource', id: resource.id })
            : hostRemoteAccess(ctx).allows({ kind: 'session', id: resource.id as SessionId });
    }
    private async nativeInvocation<T>(sourceId: string, invoke: (native: ReturnType<SourceGateway['nativeAccess']>) => Promise<T> | T): Promise<T> {
        const access = this.access;
        try {
            const value = await invoke(this.gateway.nativeAccess(sourceId, access));
            this.gateway.nativeAccess(sourceId, access); // Recheck revocation before releasing native data.
            return value;
        } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'nativeCapabilities', resources: { hhpiSource: addressedSource } })
    async nativeCapabilities(request: { sourceId: string }, signal?: AbortSignal) {
        return this.nativeInvocation(request.sourceId, native => native.capabilities(signal));
    }
    @Remote({ name: 'nativeCall', resources: { hhpiSource: addressedSource } })
    async nativeCall(request: CodexCall, signal?: AbortSignal) {
        return this.nativeInvocation(request.sourceId, native => native.call(request, false, signal));
    }
    @Remote({ name: 'nativeReceipt', resources: { hhpiSource: addressedSource } })
    async nativeReceipt(request: CodexCall, signal?: AbortSignal) {
        return this.nativeInvocation(request.sourceId, native => native.call(request, true, signal));
    }
    @Remote({ name: 'nativeReply', resources: { hhpiSource: addressedSource } })
    async nativeReply(request: CodexReply) {
        return this.nativeInvocation(request.sourceId, native => native.reply(request));
    }
    @Remote({ name: 'nativeEvents', resources: { hhpiSource: addressedSource } })
    async nativeEvents(request: CodexEventsRequest, signal?: AbortSignal) {
        return this.nativeInvocation(request.sourceId, native => { signal?.throwIfAborted(); return native.readEvents(request); });
    }
    @Remote('catalog')
    async catalog(signal?: AbortSignal): Promise<SourceCatalog> {
        try {
            const catalog = await this.gateway.catalog(this.access, signal);
            return { ...catalog, ...(this.directory ? { storageScope: sourceStorageScope(this.directory, principalOf(this.ctx.invocation)) } : {}) };
        } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'read', resources: { session: addressedSession } })
    async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> { try { return await this.gateway.read(request, this.access, signal); } catch (error) { remoteError(error, true); } }
    @Remote({ name: 'resolve', resources: { session: addressedSession } })
    async resolve(request: { sessionId: string }, signal?: AbortSignal): Promise<SourceSession> {
        try { return await this.gateway.resolve(request.sessionId, this.access, signal); } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'changes', mode: 'stream', resources: { session: addressedSession } })
    async *changes(request: SourceChangesRequest, signal?: AbortSignal): RemoteStream<SourceChanges> {
        try { yield* this.gateway.changes(request, this.access, signal); } catch (error) { remoteError(error, true); }
    }
    @Remote({ name: 'upload', resources: { session: addressedSession } })
    async upload(request: SourceUploadRequest, signal?: AbortSignal) { try { return await this.gateway.upload(request, this.access, signal); } catch (error) { remoteError(error); } }
    @Remote({ name: 'operate', resources: { session: addressedSession } })
    async operate(request: SourceOperation): Promise<SourceReceipt> { try { return await this.gateway.operate(request, this.access); } catch (error) { remoteError(error); } }
    @Remote({ name: 'receipt', resources: { session: addressedSession } })
    async receipt(request: SourceOperation, signal?: AbortSignal): Promise<SourceReceipt | null> {
        try { return await this.gateway.receipt(request, this.access, signal); } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'create', resources: { hhpiSource: addressedSource } })
    async create(request: SourceCreateRequest): Promise<SourceCreationReceipt> { try { return await this.gateway.create(request, this.access); } catch (error) { remoteError(error); } }
    @Remote({ name: 'resource', resources: { session: addressedSession } })
    async resource(request: SourceResourceRequest, signal?: AbortSignal): Promise<SourceResource> { try { return await this.gateway.resource(request, this.access, signal); } catch (error) { remoteError(error); } }
}
export function installSources(ctx: Context, sources: readonly DirectSourceConfig[], directory: string, workspaces: readonly SourceWorkspaceConfig[] = []): SourceGateway {
    const uploadReceipts = new Map<string, string>();
    const adapters = sources.map(source => {
        const cache = join(directory, createHash('sha256').update(JSON.stringify([source.machineId, source.id, source.engine])).digest('hex'));
        if (source.engine === 'codex') uploadReceipts.set(source.id, join(cache, 'uploads'));
        return new DirectCodexAdapter(source, cache, { localImageFiles: workspaces.some(entry => entry.sourceId === source.id && entry.provider === 'local-system') });
    });
    const gateway = new SourceGateway(adapters, { refreshMs: 15_000 });
    new HhpiSourceService(ctx, gateway, directory);
    new SourceWorkspaceService(ctx, gateway, { localHostId: 'local', scopeId: directory });
    new SourceTerminalService(ctx, gateway, { localHostId: 'local', scopeId: directory });
    new SourceNavigationService(ctx, gateway);
    installLocalSourceWorkspaces(ctx, gateway, sources, workspaces, directory, uploadReceipts);
    // The official exact Fetch registry admits only owner Peers. It supplies
    // the same account scope as owner RPC, and the same exact source resolver.
    installSourceUploadRoute(ctx, (sessionId, signal) => {
        const target = { hostId: 'local', sessionId };
        const access: WorkspaceAccess = { scope: sourceStorageScope(directory), signal,
            assertAllowed(value) { signal.throwIfAborted(); if (value.hostId !== target.hostId || value.sessionId !== target.sessionId) throw new SourceAccessDenied(); } };
        return withWorkspaceService(target, 'upload', access,
            createSourceWorkspaceProviders({ localHostId: 'local', gateway, sourceAccess: () => true, action: 'upload' }),
            async services => ({ services, access }));
    });
    // The official index belongs to the owner. Non-owner clients adopt their
    // invocation-derived scope from catalog before any retained write can run.
    ctx.inject(['webServer'], webCtx => {
        webCtx.on('webserver/index-inject', table => { table.push({ kind: 'global', name: '__HHPI_STORAGE_SCOPE__', value: sourceStorageScope(directory) }); });
    });
    ctx.effect(() => () => gateway.dispose(), 'hhpi: native source ownership');
    return gateway;
}
