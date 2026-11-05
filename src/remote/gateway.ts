/** Source registry and exact-scope router. Authentication remains with the official DSH carrier. */
import { SourceError, waitFor } from './errors.ts';
import { sourceOffline } from '../shared/source-connectivity.ts';
import { parseSourceSessionId, sourceSessionId, type SourceAdapter, type SourceCatalog, type SourceChanges, type SourceChangesRequest,
    type SourceCreateRequest, type SourceCreationReceipt, type SourceOperation, type SourcePage, type SourceReadRequest,
    type SourceReceipt, type SourceResource, type SourceResourceRequest, type SourceSession } from './protocol.ts';

export type SourcePermission = { kind: 'source'; id: string } | { kind: 'session'; id: string };
export type SourceAccess = (resource: SourcePermission) => boolean;
interface CatalogOptions { initialWaitMs?: number; sourceTimeoutMs?: number }
export class SourceGateway {
    private readonly adapters = new Map<string, SourceAdapter>();
    private readonly catalogs = new Map<string, SourceSession[]>();
    private readonly catalogReads = new Map<string, Promise<void>>();
    private readonly catalogOnline = new Map<string, boolean>();
    private readonly catalogErrors = new Map<string, SourceError>();
    private readonly lifetime = new AbortController();
    private disposed = false;
    constructor(adapters: readonly SourceAdapter[], private readonly legacyHapi: boolean, private readonly catalogOptions: CatalogOptions = {}) {
        for (const adapter of adapters) {
            if (this.adapters.has(adapter.id)) throw new Error('HHPI source IDs must be unique on one Host');
            this.adapters.set(adapter.id, adapter);
        }
    }
    private assertLive(): void { if (this.disposed) throw new SourceError('DISPOSED', 'The source gateway is closed.'); }
    private assertAllowed(access: SourceAccess, resource: SourcePermission): void {
        if (!access(resource)) throw new SourceError('UNSUPPORTED', 'Access to this source resource was not granted.');
    }
    private adapterFor(sessionId: string, access: SourceAccess): SourceAdapter {
        this.assertLive();
        let identity;
        try { identity = parseSourceSessionId(sessionId); } catch { throw new SourceError('INVALID_REQUEST', 'The source session identity is invalid.'); }
        this.assertAllowed(access, { kind: 'session', id: sessionId });
        const adapter = this.adapters.get(identity.sourceId);
        if (!adapter || adapter.machineId !== identity.machineId || adapter.engine !== identity.engine) throw new SourceError('TARGET_UNAVAILABLE', 'No registered source owns this session identity.');
        return adapter;
    }
    private checkSession(adapter: SourceAdapter, session: SourceSession, expected?: string): void {
        if (session.id !== sourceSessionId(session) || expected !== undefined && session.id !== expected
            || session.sourceId !== adapter.id || session.machineId !== adapter.machineId || session.engine !== adapter.engine) {
            throw new SourceError('INVALID_REQUEST', 'A source response crossed its registered session scope.');
        }
    }
    private refreshCatalog(adapter: SourceAdapter): Promise<void> {
        const pending = this.catalogReads.get(adapter.id);
        if (pending) return pending;
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new SourceError('TARGET_UNAVAILABLE', 'The source catalog is still unavailable.')), this.catalogOptions.sourceTimeoutMs ?? 30_000);
        timer.unref();
        const signal = AbortSignal.any([this.lifetime.signal, deadline.signal]);
        const work = Promise.resolve().then(() => {
            signal.throwIfAborted();
            return waitFor(adapter.list(signal), signal);
        }).then(sessions => {
            signal.throwIfAborted();
            for (const session of sessions) this.checkSession(adapter, session);
            this.catalogs.set(adapter.id, sessions);
            this.catalogOnline.set(adapter.id, true);
            this.catalogErrors.delete(adapter.id);
        }).catch((error: unknown) => {
            if (this.disposed) return;
            this.catalogOnline.set(adapter.id, false);
            if (error instanceof SourceError && error.code === 'UNSUPPORTED') this.catalogs.delete(adapter.id);
            if (error instanceof SourceError && error.code === 'INVALID_REQUEST') {
                this.catalogs.delete(adapter.id);
                this.catalogErrors.set(adapter.id, error);
            }
            const known = this.catalogs.get(adapter.id);
            if (known) this.catalogs.set(adapter.id, known.map(session => sourceOffline(session)));
        }).finally(() => {
            clearTimeout(timer);
            if (this.catalogReads.get(adapter.id) === work) this.catalogReads.delete(adapter.id);
        });
        this.catalogReads.set(adapter.id, work);
        return work;
    }
    async catalog(access: SourceAccess, signal?: AbortSignal): Promise<SourceCatalog> {
        this.assertLive(); signal?.throwIfAborted();
        const initial = this.catalogOnline.size === 0;
        const refreshing = Promise.all([...this.adapters.values()].map(adapter => this.refreshCatalog(adapter)));
        // Cached sources remain available while each adapter refreshes independently.
        // The first catalog gives quick sources a small admission budget; a slow
        // native connection can never hold every other source behind its timeout.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await waitFor(Promise.race([refreshing, new Promise<void>(resolve => {
                timer = setTimeout(resolve, initial ? this.catalogOptions.initialWaitMs ?? 100 : 0);
            })]), signal);
        } finally { clearTimeout(timer); }
        this.assertLive(); signal?.throwIfAborted();
        const result: SourceCatalog = { protocol: 1, legacyHapi: this.legacyHapi, sessions: [], sources: [] };
        for (const adapter of this.adapters.values()) {
            const online = this.catalogOnline.get(adapter.id) ?? false;
            const sessions: SourceSession[] = online ? this.catalogs.get(adapter.id) ?? []
                : (this.catalogs.get(adapter.id) ?? []).map(session => sourceOffline(session));
            result.sessions.push(...sessions.filter(session => access({ kind: 'session', id: session.id })));
            if (access({ kind: 'source', id: adapter.id })) result.sources.push({ id: adapter.id, machineId: adapter.machineId, engine: adapter.engine, online, create: typeof adapter.create === 'function' });
        }
        result.sources.sort((a, b) => a.id.localeCompare(b.id)); result.sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        return result;
    }
    async read(request: SourceReadRequest, access: SourceAccess, signal?: AbortSignal): Promise<SourcePage> {
        const adapter = this.adapterFor(request.sessionId, access), page = await adapter.read(request, signal);
        signal?.throwIfAborted(); this.assertLive(); this.assertAllowed(access, { kind: 'session', id: request.sessionId }); this.checkSession(adapter, page.session, request.sessionId); return page;
    }
    async resolve(sessionId: string, access: SourceAccess, signal?: AbortSignal): Promise<SourceSession> {
        const adapter = this.adapterFor(sessionId, access);
        const session = adapter.resolve ? await adapter.resolve(sessionId, signal)
            : (await adapter.list(signal)).find(value => value.id === sessionId);
        signal?.throwIfAborted(); this.assertLive();
        this.assertAllowed(access, { kind: 'session', id: sessionId });
        if (!session) throw new SourceError('TARGET_UNAVAILABLE', 'The original source cannot resolve this session.');
        this.checkSession(adapter, session, sessionId);
        return session;
    }
    async *changes(request: SourceChangesRequest, access: SourceAccess, signal?: AbortSignal): AsyncIterable<SourceChanges> {
        const adapter = this.adapterFor(request.sessionId, access);
        for await (const change of adapter.changes(request, signal)) {
            signal?.throwIfAborted(); this.assertLive(); this.assertAllowed(access, { kind: 'session', id: request.sessionId });
            this.checkSession(adapter, change.session, request.sessionId); yield change;
        }
    }
    async operate(request: SourceOperation, access: SourceAccess): Promise<SourceReceipt> {
        const adapter = this.adapterFor(request.sessionId, access), receipt = await adapter.operate(request);
        this.assertLive(); this.assertAllowed(access, { kind: 'session', id: request.sessionId });
        if (receipt.sessionId !== request.sessionId || receipt.operationId !== request.operationId) throw new SourceError('OUTCOME_UNKNOWN', 'The source acknowledgement belongs to another operation.');
        return receipt;
    }
    async receipt(request: SourceOperation, access: SourceAccess, signal?: AbortSignal): Promise<SourceReceipt | null> {
        const adapter = this.adapterFor(request.sessionId, access);
        if (!adapter.receipt) throw new SourceError('UNSUPPORTED', 'This source does not expose operation receipt lookup.');
        const receipt = await adapter.receipt(request, signal);
        signal?.throwIfAborted(); this.assertLive(); this.assertAllowed(access, { kind: 'session', id: request.sessionId });
        if (receipt && (receipt.sessionId !== request.sessionId || receipt.operationId !== request.operationId)) throw new SourceError('OUTCOME_UNKNOWN', 'The receipt belongs to another operation.');
        return receipt;
    }
    async create(request: SourceCreateRequest, access: SourceAccess): Promise<SourceCreationReceipt> {
        this.assertLive(); this.assertAllowed(access, { kind: 'source', id: request.sourceId });
        const adapter = this.adapters.get(request.sourceId);
        if (!adapter?.create) throw new SourceError('UNSUPPORTED', 'This source does not expose native thread creation.');
        const receipt = await adapter.create(request);
        this.assertLive(); this.assertAllowed(access, { kind: 'source', id: request.sourceId });
        if (receipt.operationId !== request.operationId || receipt.sourceId !== request.sourceId) throw new SourceError('OUTCOME_UNKNOWN', 'The source creation acknowledgement belongs to another operation.');
        if (receipt.session) this.checkSession(adapter, receipt.session);
        return receipt;
    }
    async resource(request: SourceResourceRequest, access: SourceAccess, signal?: AbortSignal): Promise<SourceResource> {
        const adapter = this.adapterFor(request.sessionId, access);
        if (!adapter.readResource) throw new SourceError('UNSUPPORTED', 'This source has not declared resource access. No central Host path was opened.');
        const value = await adapter.readResource(request, signal);
        signal?.throwIfAborted(); this.assertLive(); this.assertAllowed(access, { kind: 'session', id: request.sessionId }); return value;
    }
    async dispose(): Promise<void> {
        if (this.disposed) return; this.disposed = true;
        this.lifetime.abort(new SourceError('DISPOSED', 'The source gateway is closed.'));
        const outcomes = await Promise.allSettled([...this.adapters.values()].map(async adapter => { await adapter.dispose(); }));
        this.adapters.clear(); this.catalogs.clear(); this.catalogOnline.clear(); this.catalogErrors.clear(); this.catalogReads.clear();
        const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), 'Some HHPI source connections could not close.');
    }
}
