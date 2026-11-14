import type { SourceUploadRequest } from './protocol.ts';
/** Source registry and exact-scope router. Authentication remains with the official DSH carrier. */
import { SourceAccessDenied, SourceError, waitFor } from './errors.ts';
import { SourceRegistry } from './source-registry.ts';
import { sourceOffline } from '../shared/source-connectivity.ts';
import { SourceWorkspaceRegistry, type SourceWorkspaceRegistration } from '../workspace/source-services.ts';
import type { WorkspaceAccess, WorkspaceAction, WorkspaceServices } from '../workspace/service-types.ts';
import type { WorkspaceTarget } from '../workbench-types.ts';
import type { SourceUploadInput, SourceUploadInputsProvider } from '../workspace/source-api.ts';
import type { SourceDirectoryRequest, SourceDirectoryListing } from '../workspace/source-api.ts';
import type { NotificationCursor, SourceAttentionBatch, SourceAttentionFeed, SourceAttentionSourceBatch, SourceAttentionSourceFeed } from '../workspace/notification-events.ts';
import { sourcePositionRequest, sourcePositionResult, sourceResumeRequest, sourceResumeContext, type SourceResumeRequest, type SourceResumeContext, type SourcePositionRequest, type SourcePositionResult } from '../workspace/source-navigation-api.ts';
import { parseSourceSessionId, sourceSessionId, type SourceAdapter, type SourceCatalog, type SourceChanges, type SourceChangesRequest,
    type SourceCreateRequest, type SourceCreationReceipt, type SourceOperation, type SourcePage, type SourceReadRequest,
    type SourceReceipt, type SourceResource, type SourceResourceRequest, type SourceSession } from './protocol.ts';

export type SourcePermission = { kind: 'source'; id: string } | { kind: 'session'; id: string };
export type SourceAccess = (resource: SourcePermission) => boolean;
interface CatalogOptions { initialWaitMs?: number; sourceTimeoutMs?: number; refreshMs?: number }
export class SourceGateway {
    private readonly adapters = new Map<string, SourceAdapter>();
    private readonly registry = new SourceRegistry();
    private readonly lifetime = new AbortController();
    private readonly workspaces = new SourceWorkspaceRegistry(this.lifetime.signal);
    private disposed = false;
    constructor(adapters: readonly SourceAdapter[], private readonly catalogOptions: CatalogOptions = {}) {
        for (const adapter of adapters) {
            if (this.adapters.has(adapter.id)) throw new Error('HHPI source IDs must be unique on one Host');
            this.adapters.set(adapter.id, adapter);
        }
    }
    private assertLive(): void { if (this.disposed) throw new SourceError('DISPOSED', 'The source gateway is closed.'); }
    private assertAllowed(access: SourceAccess, resource: SourcePermission): void {
        if (!access(resource)) throw new SourceAccessDenied();
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
        const state = this.registry.entry(adapter.id);
        if (state.pending) return state.pending;
        if (state.nextRefresh > Date.now()) return Promise.resolve();
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
            state.sessions = sessions;
            state.online = true;
            delete state.error;
        }).catch((error: unknown) => {
            if (this.disposed) return;
            state.online = false;
            if (error instanceof SourceError && error.code === 'UNSUPPORTED') delete state.sessions;
            if (error instanceof SourceError && error.code === 'INVALID_REQUEST') {
                delete state.sessions;
                state.error = error;
            }
            const known = state.sessions;
            if (known) state.sessions = known.map(session => sourceOffline(session));
        }).finally(() => {
            clearTimeout(timer);
            if (state.pending === work) { delete state.pending; state.nextRefresh = Date.now() + (this.catalogOptions.refreshMs ?? 0); }
        });
        state.pending = work;
        return work;
    }
    async catalog(access: SourceAccess, signal?: AbortSignal): Promise<SourceCatalog> {
        this.assertLive(); signal?.throwIfAborted();
        const initial = !this.registry.observed;
        const observations = [...this.adapters.values()].map(adapter => this.refreshCatalog(adapter));
        const refreshing = Promise.all(observations);
        // Cached sources remain available while each adapter refreshes independently.
        // The first catalog gives quick sources a small admission budget; a slow
        // native connection can never hold every other source behind its timeout.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await waitFor(Promise.race([refreshing, new Promise<void>(resolve => {
                timer = setTimeout(resolve, initial ? this.catalogOptions.initialWaitMs ?? 100 : 0);
            })]), signal);
            // A cold directory has no accepted availability to publish. Keep
            // that same request pending until one source settles, including an
            // empty success or the existing per-source timeout/failure. Faster
            // sources remain independent of every other pending source.
            if (initial && !this.registry.observed && observations.length) {
                await waitFor(Promise.race(observations), signal);
            }
        } finally { clearTimeout(timer); }
        this.assertLive(); signal?.throwIfAborted();
        const result: SourceCatalog = { protocol: 1, legacyHapi: false, sessions: [], sources: [] };
        for (const adapter of this.adapters.values()) {
            const state = this.registry.entry(adapter.id);
            // Absence is not an offline claim. The original wire advertises
            // only settled observations, without inventing a pending variant.
            if (state.online === undefined) continue;
            const online = state.online;
            const sessions: SourceSession[] = online ? state.sessions ?? []
                : (state.sessions ?? []).map(session => sourceOffline(session));
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
    /** Application background transport, deliberately outside the HHPI v1 wire contract. */
    async *notificationEvents(sessionId: string, cursor: NotificationCursor | undefined, access: SourceAccess, signal: AbortSignal): AsyncIterable<SourceAttentionBatch> {
        const adapter = this.adapterFor(sessionId, access) as SourceAdapter & Partial<SourceAttentionFeed>;
        if (!adapter.notificationEvents) throw new SourceError('UNSUPPORTED', 'This source has not provided lightweight attention events.');
        for await (const batch of adapter.notificationEvents(sessionId, cursor, signal)) {
            signal.throwIfAborted(); this.adapterFor(sessionId, access);
            yield batch;
        }
    }
    /** One authenticated native source stream, independent of the current session catalog. */
    async *attentionEvents(sourceId: string, cursor: NotificationCursor | undefined, access: SourceAccess, signal: AbortSignal): AsyncIterable<SourceAttentionSourceBatch> {
        this.assertLive(); signal.throwIfAborted(); this.assertAllowed(access, { kind: 'source', id: sourceId });
        const adapter = this.adapters.get(sourceId) as SourceAdapter & Partial<SourceAttentionSourceFeed> | undefined;
        if (!adapter?.attentionEvents) throw new SourceError('UNSUPPORTED', 'This source has not provided source-level attention events.');
        for await (const batch of adapter.attentionEvents(cursor, signal)) {
            signal.throwIfAborted(); this.assertLive(); this.assertAllowed(access, { kind: 'source', id: sourceId });
            const events = batch.events.filter(item => {
                const identity = parseSourceSessionId(item.sessionId);
                if (identity.sourceId !== adapter.id || identity.machineId !== adapter.machineId || identity.engine !== adapter.engine) {
                    throw new SourceError('INVALID_REQUEST', 'The attention event does not belong to its original source.');
                }
                return access({ kind: 'session', id: item.sessionId });
            });
            yield { ...batch, events };
        }
    }
    nativeAccess(sourceId: string, access: SourceAccess) {
        this.assertLive(); this.assertAllowed(access, { kind: 'source', id: sourceId });
        const native = this.adapters.get(sourceId)?.nativeAccess;
        if (!native) throw new SourceError('UNSUPPORTED', 'This source has no native Codex interface.');
        return native;
    }
    async locatePosition(raw: SourcePositionRequest, access: SourceAccess, signal: AbortSignal): Promise<SourcePositionResult> {
        const request = sourcePositionRequest.parse(raw), adapter = this.adapterFor(request.sessionId, access) as SourceAdapter & {
            locatePosition?(sessionId: string, position: SourcePositionRequest['position'], signal: AbortSignal): Promise<SourcePositionResult>;
        };
        if (!adapter.locatePosition) throw new SourceError('UNSUPPORTED', 'This source cannot resolve native reading coordinates.');
        const result = sourcePositionResult.parse(await adapter.locatePosition(request.sessionId, request.position, signal));
        signal.throwIfAborted(); this.adapterFor(request.sessionId, access); return result;
    }
    async resumeContext(raw: SourceResumeRequest, access: SourceAccess, signal: AbortSignal): Promise<SourceResumeContext> {
        const request = sourceResumeRequest.parse(raw), adapter = this.adapterFor(request.sessionId, access) as SourceAdapter & {
            resumeContext?(sessionId: string, signal: AbortSignal): Promise<SourceResumeContext>;
        };
        this.assertAllowed(access, { kind: 'source', id: adapter.id }); signal.throwIfAborted();
        if (!adapter.resumeContext) throw new SourceError('UNSUPPORTED', 'This source does not report its original CLI store.');
        const result = sourceResumeContext.parse(await adapter.resumeContext(request.sessionId, signal));
        signal.throwIfAborted(); this.adapterFor(request.sessionId, access); this.assertAllowed(access, { kind: 'source', id: adapter.id });
        if (result.sessionId !== request.sessionId || sourceSessionId(result) !== request.sessionId) {
            throw new SourceError('INVALID_REQUEST', 'The original CLI store belongs to another source session.');
        }
        return result;
    }
    async upload(request: SourceUploadRequest, access: SourceAccess, signal?: AbortSignal) {
        const adapter = this.adapterFor(request.sessionId, access);
        if (!adapter.upload) throw new SourceError('UNSUPPORTED', 'This source does not support file uploads.');
        const result = await adapter.upload(request, signal);
        signal?.throwIfAborted(); this.assertLive(); this.assertAllowed(access, { kind: 'session', id: request.sessionId });
        return result;
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
        this.registry.entry(adapter.id).nextRefresh = 0;
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
    /** Registration is explicit source OS composition, independent of Agent capabilities. */
    registerWorkspace(registration: SourceWorkspaceRegistration): () => Promise<void> {
        this.assertLive();
        const adapter = this.adapters.get(registration.source.sourceId);
        if (!adapter || adapter.machineId !== registration.source.machineId || adapter.engine !== registration.source.engine) {
            throw new SourceError('INVALID_REQUEST', 'The workspace registration does not belong to a configured source.');
        }
        return this.workspaces.register(registration);
    }
    async directories(request: SourceDirectoryRequest, access: SourceAccess, signal?: AbortSignal): Promise<SourceDirectoryListing> {
        this.assertLive(); signal?.throwIfAborted();
        const source = { machineId: request.machineId, sourceId: request.sourceId, engine: request.engine };
        const adapter = this.adapters.get(source.sourceId);
        this.assertAllowed(access, { kind: 'source', id: source.sourceId });
        if (!adapter || adapter.machineId !== source.machineId || adapter.engine !== source.engine) throw new SourceError('TARGET_UNAVAILABLE', 'The selected source machine is unavailable.');
        const result = await this.workspaces.directories(source, request.path, AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]));
        this.assertLive(); signal?.throwIfAborted(); this.assertAllowed(access, { kind: 'source', id: source.sourceId });
        if (this.adapters.get(source.sourceId) !== adapter) throw new SourceError('TARGET_UNAVAILABLE', 'The selected source owner changed.');
        return { source, ...result };
    }
    async workspace(target: WorkspaceTarget, sourceAccess: SourceAccess, access: WorkspaceAccess, action: WorkspaceAction): Promise<WorkspaceServices> {
        await access.assertAllowed(target, action);
        const session = await this.resolve(target.sessionId, sourceAccess, access.signal);
        const services = await this.workspaces.resolve(session, target, access);
        this.assertLive(); this.adapterFor(target.sessionId, sourceAccess); access.signal.throwIfAborted();
        await access.assertAllowed(target, action);
        return services;
    }
    /** Read existing session-owned receipt metadata; this cannot upload files or dispatch a native turn. */
    async uploadInputs(request: { sessionId: string; receiptIds: readonly string[]; clientUserMessageId?: string }, access: SourceAccess, signal?: AbortSignal): Promise<SourceUploadInput[]> {
        const adapter = this.adapterFor(request.sessionId, access) as SourceAdapter & Partial<SourceUploadInputsProvider>;
        if (typeof adapter.uploadInputs !== 'function') throw new SourceError('UNSUPPORTED', 'This source does not expose uploaded-file receipt resolution.');
        const result = await waitFor(adapter.uploadInputs(request.sessionId, request.receiptIds, signal, request.clientUserMessageId), signal);
        signal?.throwIfAborted(); this.assertLive(); this.adapterFor(request.sessionId, access);
        return result;
    }
    async dispose(): Promise<void> {
        if (this.disposed) return; this.disposed = true;
        this.lifetime.abort(new SourceError('DISPOSED', 'The source gateway is closed.'));
        const outcomes = await Promise.allSettled([this.workspaces.dispose(), ...[...this.adapters.values()].map(async adapter => { await adapter.dispose(); })]);
        this.adapters.clear(); this.registry.clear();
        const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), 'Some HHPI source connections could not close.');
    }
}
