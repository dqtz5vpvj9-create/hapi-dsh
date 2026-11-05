/** HHPI methods use the official authenticated Typert carrier and its resource policies. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService, principalOf, type RemoteStream, type TypertResource } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-api-remote-access';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { HHPI_REMOTE } from '../hhpi-api.ts';
import { SourceGateway, type SourceAccess } from './gateway.ts';
import { DirectCodexAdapter } from './codex-adapter.ts';
import { DirectDshAdapter } from './dsh-adapter.ts';
import { SourceError } from './errors.ts';
import type { DirectSourceConfig, SourceCatalog, SourceChanges, SourceChangesRequest, SourceCreateRequest, SourceCreationReceipt,
    SourceOperation, SourcePage, SourceReadRequest, SourceReceipt, SourceResource, SourceResourceRequest, SourceSession } from './protocol.ts';

declare module '@deepseek-ai/cordis' { interface Context { hhpi: HhpiSourceService } }
declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertResourceMap { hhpiSource: TypertResource<string> } }
function remoteError(error: unknown): never {
    if (error instanceof RemoteError || error instanceof DOMException && error.name === 'AbortError') throw error;
    const source = error instanceof SourceError ? error : new SourceError('TARGET_UNAVAILABLE', 'The source request could not be completed.');
    throw new RemoteError('hhpi/source', source.message, { sourceCode: source.code, outcome: source.code === 'OUTCOME_UNKNOWN' ? 'indeterminate' : 'rejected' });
}
const addressedSession = (request: { sessionId: string }): readonly SessionId[] => [request.sessionId as SessionId];
const addressedSource = (request: { sourceId: string }): readonly string[] => [request.sourceId];
export const HHPI_HOST_CONTRACT = {
    invocations: HHPI_REMOTE.descriptors,
    services: [{ key: 'hhpi', exportName: 'HhpiSourceService', tags: [], members: [], types: [], summary: 'Scoped native source access.' }],
};
/** Principal fields are JSON identity, never credentials. Canonical ordering keeps one account scope across restarts. */
export function sourceStorageScope(directory: string, principal: unknown = { kind: 'owner' }): string {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    return createHash('sha256').update(JSON.stringify([directory, canonical(principal)])).digest('hex');
}
/** Runner-only composition; display Hosts publish the combined workspace face. */
export function registerSourceContract(ctx: Context): void {
    ctx.effect(() => ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: HHPI_HOST_CONTRACT.invocations,
        model: { services: HHPI_HOST_CONTRACT.services, events: [], objects: [] } }), 'hhpi: source Remote contract');
}

export class HhpiSourceService extends TypertRemoteService {
    constructor(ctx: Context, private readonly gateway: SourceGateway, private readonly directory?: string) {
        super(ctx, 'hhpi');
        ctx.typert.resources.register('hhpiSource', { field: 'sourceId' });
    }
    private get access(): SourceAccess {
        // Capture this invocation-derived Context, never an owner Context retained at startup.
        const ctx = this.ctx;
        return resource => resource.kind === 'source' ? ctx.remoteAccess.allows({ kind: 'hhpiSource', id: resource.id })
            : ctx.remoteAccess.allows({ kind: 'session', id: resource.id as SessionId });
    }
    @Remote('catalog')
    async catalog(signal?: AbortSignal): Promise<SourceCatalog> {
        try {
            const catalog = await this.gateway.catalog(this.access, signal);
            return { ...catalog, ...(this.directory ? { storageScope: sourceStorageScope(this.directory, principalOf(this.ctx.invocation)) } : {}) };
        } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'read', resources: { session: addressedSession } })
    async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> { try { return await this.gateway.read(request, this.access, signal); } catch (error) { remoteError(error); } }
    @Remote({ name: 'resolve', resources: { session: addressedSession } })
    async resolve(request: { sessionId: string }, signal?: AbortSignal): Promise<SourceSession> {
        try { return await this.gateway.resolve(request.sessionId, this.access, signal); } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'changes', mode: 'stream', resources: { session: addressedSession } })
    async *changes(request: SourceChangesRequest, signal?: AbortSignal): RemoteStream<SourceChanges> {
        try { yield* this.gateway.changes(request, this.access, signal); } catch (error) { remoteError(error); }
    }
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
export function installSources(ctx: Context, sources: readonly DirectSourceConfig[], directory: string, legacyHapi: boolean): SourceGateway {
    const adapters = sources.map(source => {
        const cache = join(directory, createHash('sha256').update(JSON.stringify([source.machineId, source.id, source.engine])).digest('hex'));
        return source.engine === 'dsh' ? new DirectDshAdapter(source, cache) : new DirectCodexAdapter(source, cache);
    });
    const gateway = new SourceGateway(adapters, legacyHapi);
    new HhpiSourceService(ctx, gateway, directory);
    // The official index belongs to the owner. Non-owner clients adopt their
    // invocation-derived scope from catalog before any retained write can run.
    ctx.inject(['webServer'], webCtx => {
        webCtx.on('webserver/index-inject', table => { table.push({ kind: 'global', name: '__HHPI_STORAGE_SCOPE__', value: sourceStorageScope(directory) }); });
    });
    ctx.effect(() => () => gateway.dispose(), 'hhpi: native source ownership');
    return gateway;
}
