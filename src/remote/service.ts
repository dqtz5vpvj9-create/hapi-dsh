/** HHPI methods use the official authenticated Typert carrier and its resource policies. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService, type RemoteStream, type TypertResource } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-api-remote-access';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { HHPI_REMOTE } from '../hhpi-api.ts';
import { SourceGateway, type SourceAccess } from './gateway.ts';
import { DirectCodexAdapter } from './codex-adapter.ts';
import { DirectDshAdapter } from './dsh-adapter.ts';
import { SourceError } from './errors.ts';
import type { DirectSourceConfig, SourceCatalog, SourceChanges, SourceChangesRequest, SourceCreateRequest, SourceCreationReceipt,
    SourceOperation, SourcePage, SourceReadRequest, SourceReceipt, SourceResource, SourceResourceRequest } from './protocol.ts';

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
/** Runner-only composition; display Hosts publish the combined workspace face. */
export function registerSourceContract(ctx: Context): void {
    ctx.effect(() => ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: HHPI_HOST_CONTRACT.invocations,
        model: { services: HHPI_HOST_CONTRACT.services, events: [], objects: [] } }), 'hhpi: source Remote contract');
}

export class HhpiSourceService extends TypertRemoteService {
    constructor(ctx: Context, private readonly gateway: SourceGateway) {
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
    async catalog(signal?: AbortSignal): Promise<SourceCatalog> { try { return await this.gateway.catalog(this.access, signal); } catch (error) { remoteError(error); } }
    @Remote({ name: 'read', resources: { session: addressedSession } })
    async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> { try { return await this.gateway.read(request, this.access, signal); } catch (error) { remoteError(error); } }
    @Remote({ name: 'changes', mode: 'stream', resources: { session: addressedSession } })
    async *changes(request: SourceChangesRequest, signal?: AbortSignal): RemoteStream<SourceChanges> {
        try { yield* this.gateway.changes(request, this.access, signal); } catch (error) { remoteError(error); }
    }
    @Remote({ name: 'operate', resources: { session: addressedSession } })
    async operate(request: SourceOperation): Promise<SourceReceipt> { try { return await this.gateway.operate(request, this.access); } catch (error) { remoteError(error); } }
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
    new HhpiSourceService(ctx, gateway);
    ctx.effect(() => () => gateway.dispose(), 'hhpi: native source ownership');
    return gateway;
}
