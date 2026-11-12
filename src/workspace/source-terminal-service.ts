/** Resource-owned PTYs and an authenticated source carrier; no execution Agent is constructed. */
import type { Context, Fiber } from '@deepseek-ai/cordis';
import { createTerminalOwner, type Config, type TerminalOwnerController } from '@deepseek-ai/dsh-api-terminal-controller';
import type { TerminalCreateRequest, TerminalFrame, TerminalInput, TerminalRetentionFrame, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { Remote, RemoteError, TypertRemoteService, principalOf, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access';
import { SourceAccessDenied, SourceError } from '../remote/errors.ts';
import type { SourceGateway } from '../remote/gateway.ts';
import { sourceStorageScope } from '../remote/service.ts';
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceTerminalOwner, WorkspaceTerminalService } from './service-types.ts';
import type { SourceWorkspaceOwner } from './source-services.ts';
import { SOURCE_TERMINAL_HOST_CONTRACT } from './terminal-api.ts';

export interface SourceTerminalResources {
    /** The provider belongs to the source OS/container, never the receiving display Host. */
    readonly subprocess: SubprocessRuntime;
    /** Validate this exact source directory using the source's filesystem service. */
    ensureDirectory(root: string, signal: AbortSignal): Promise<void>;
}
async function allowed(owner: WorkspaceTerminalOwner, access: WorkspaceAccess): Promise<void> {
    owner.signal.throwIfAborted(); access.signal.throwIfAborted();
    await access.assertAllowed(owner.binding.target, 'terminal');
}
function terminalService(controller: TerminalOwnerController, owner: WorkspaceTerminalOwner): WorkspaceTerminalService {
    const execute = async <T>(access: WorkspaceAccess, call: () => T | Promise<T>): Promise<T> => {
        await allowed(owner, access); const value = await call(); await allowed(owner, access); return value;
    };
    const signal = (access: WorkspaceAccess): AbortSignal => AbortSignal.any([owner.signal, access.signal]);
    const follow = async function* <T>(access: WorkspaceAccess, call: (signal: AbortSignal) => AsyncIterable<T>): AsyncIterable<T> {
        await allowed(owner, access);
        for await (const frame of call(signal(access))) { await allowed(owner, access); yield frame; }
    };
    return { owner,
        environment: access => execute(access, () => controller.environment(signal(access))),
        shells: access => execute(access, () => controller.shells(signal(access))),
        list: access => execute(access, () => controller.list()),
        create: (request, access) => execute(access, () => controller.create(request, signal(access))),
        retain: (id, access) => follow(access, lifetime => controller.retain(id, lifetime)),
        attach(id, input, access, inputWindow) {
            const authorizedInput: AsyncIterable<TerminalInput> = {
                [Symbol.asyncIterator]() {
                    const iterator = input[Symbol.asyncIterator]();
                    return {
                        async next() { await allowed(owner, access); const item = await iterator.next(); if (!item.done) await allowed(owner, access); return item; },
                        async return() { return iterator.return ? iterator.return() : { done: true, value: undefined }; },
                    };
                },
            };
            return follow(access, lifetime => controller.attach(id, authorizedInput, lifetime, inputWindow));
        },
        rename: (id, title, access) => execute(access, () => controller.rename(id, title)),
        close: (id, access) => execute(access, () => controller.close(id)),
    };
}

/** Cache one real plugin resource per source workspace generation, independently of requests and views. */
export class SourceTerminalOwners {
    private readonly owners = new Map<string, { fiber: Fiber; service: Promise<WorkspaceTerminalService> }>();
    constructor(private readonly scope: Context, private readonly resources: SourceTerminalResources, private readonly config: Config) {
        scope.effect(() => async () => { await this.dispose(); }, 'hhpi: source terminal owners');
    }
    forWorkspace(binding: WorkspaceBinding, sourceOwner: SourceWorkspaceOwner): Promise<WorkspaceTerminalService> {
        sourceOwner.signal.throwIfAborted();
        const key = JSON.stringify([sourceOwner.lifetimeId, binding.target, binding.machineId, binding.workspaceId, binding.root, binding.pathStyle]);
        const existing = this.owners.get(key); if (existing) return existing.service;
        let service: WorkspaceTerminalService | undefined;
        const owner: WorkspaceTerminalOwner = { binding, ...sourceOwner };
        const fiber = this.scope.plugin({ name: 'source-workspace-terminals', apply: (ctx: Context) => {
            const controller = createTerminalOwner(ctx, { id: binding.target.sessionId as SessionId, subprocess: this.resources.subprocess,
                cwd: { get: () => binding.root, ensure: async signal => { await this.resources.ensureDirectory(binding.root, signal); return binding.root; } } }, this.config);
            service = terminalService(controller, owner);
            const abort = (): void => { queueMicrotask(() => { void Promise.resolve(fiber.dispose()).then(() => { this.owners.delete(key); })
                .catch(error => { ctx.logger.error('Source terminal owner cleanup failed', error); }); }); };
            sourceOwner.signal.addEventListener('abort', abort, { once: true });
            if (sourceOwner.signal.aborted) abort();
            ctx.effect(() => () => { sourceOwner.signal.removeEventListener('abort', abort); }, 'hhpi: terminal owner cancellation');
        } });
        const ready = Promise.resolve(fiber).then(() => {
            sourceOwner.signal.throwIfAborted();
            if (!service) throw new Error('The source terminal owner did not mount');
            return service;
        });
        this.owners.set(key, { fiber, service: ready });
        return ready;
    }
    async dispose(): Promise<void> {
        const results = await Promise.allSettled([...this.owners.values()].map(async ({ fiber }) => { await fiber.dispose(); }));
        const failures = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(value => value.reason), 'Source terminal owners could not close');
        this.owners.clear();
    }
}

declare module '@deepseek-ai/cordis' { interface Context { sourceTerminal: SourceTerminalService } }
const addressedSession = (sessionId: string): readonly SessionId[] => [sessionId as SessionId];
// Host and Client declare different services under this Cordis key. Preserve the invocation Context while selecting the Host contract.
const hostRemoteAccess = (ctx: Context): RemoteAccessService => ctx.remoteAccess as unknown as RemoteAccessService;
const denial = (): RemoteError => new RemoteError('remote-access/denied', 'Access to this source terminal was not granted.', { action: 'sourceTerminal/attach', reason: 'no-allow' });
function sourceError(error: unknown): never {
    if (error instanceof RemoteError || error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof SourceAccessDenied) throw denial();
    if (error instanceof SourceError) throw new RemoteError('terminal/unavailable', error.message, {});
    throw error;
}
export function registerSourceTerminalContract(ctx: Context): void {
    ctx.effect(() => ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: SOURCE_TERMINAL_HOST_CONTRACT.invocations,
        model: { services: SOURCE_TERMINAL_HOST_CONTRACT.services, events: [], objects: [] } }), 'hhpi: source terminal Remote contract');
}
export class SourceTerminalService extends TypertRemoteService {
    constructor(ctx: Context, private readonly gateway: SourceGateway, private readonly options: { localHostId: string; scopeId: string }) {
        super(ctx, 'sourceTerminal');
    }
    private async resolve(sessionId: string, signal?: AbortSignal): Promise<{ service: WorkspaceTerminalService; access: WorkspaceAccess; ctx: Context }> {
        const ctx = this.ctx, invocation = ctx.invocation;
        if (!invocation) throw denial();
        const target = { hostId: this.options.localHostId, sessionId };
        const access: WorkspaceAccess = {
            scope: sourceStorageScope(this.options.scopeId, principalOf(invocation)),
            signal: AbortSignal.any([invocation.signal, invocation.peer.signal, ...(signal ? [signal] : [])]),
            assertAllowed: addressed => {
                if (addressed.hostId !== target.hostId || addressed.sessionId !== target.sessionId
                    || !hostRemoteAccess(ctx).allows({ kind: 'session', id: sessionId as SessionId })) throw denial();
            },
        };
        access.signal.throwIfAborted(); await access.assertAllowed(target, 'terminal');
        const services = await this.gateway.workspace(target, resource => hostRemoteAccess(ctx).allows(resource.kind === 'source'
            ? { kind: 'hhpiSource', id: resource.id } : { kind: 'session', id: resource.id as SessionId }), access, 'terminal');
        if (!services.terminals) throw new RemoteError('workspace-service/unavailable', 'Set up the terminal service on the selected source.', { reason: 'unconfigured' });
        await allowed(services.terminals.owner, access);
        return { service: services.terminals, access, ctx };
    }
    private async execute<T>(sessionId: string, signal: AbortSignal | undefined,
        call: (service: WorkspaceTerminalService, access: WorkspaceAccess) => Promise<T>): Promise<T> {
        try { const { service, access } = await this.resolve(sessionId, signal); return await call(service, access); }
        catch (error) { sourceError(error); }
    }
    private async *stream<T>(sessionId: string, signal: AbortSignal,
        call: (service: WorkspaceTerminalService, access: WorkspaceAccess) => AsyncIterable<T>): AsyncIterable<T> {
        const lifetime = new AbortController();
        try {
            const { service, access: original, ctx } = await this.resolve(sessionId, signal);
            const access: WorkspaceAccess = { ...original, signal: AbortSignal.any([original.signal, lifetime.signal]) };
            const watching = (async () => {
                try { for await (const _frame of hostRemoteAccess(ctx).follow(access.signal)) await allowed(service.owner, access); }
                catch (error) { if (!access.signal.aborted) lifetime.abort(error); }
            })();
            try { yield* call(service, access); await allowed(service.owner, access); }
            finally { lifetime.abort(); await watching; }
        } catch (error) { sourceError(error); }
        finally { lifetime.abort(); }
    }
    @Remote({ resources: { session: addressedSession } })
    environment(sessionId: string, signal: AbortSignal) { return this.execute(sessionId, signal, (service, access) => service.environment(access)); }
    @Remote({ resources: { session: addressedSession } })
    shells(sessionId: string, signal: AbortSignal) { return this.execute(sessionId, signal, (service, access) => service.shells(access)); }
    @Remote({ resources: { session: addressedSession } })
    list(sessionId: string) { return this.execute(sessionId, undefined, (service, access) => service.list(access)); }
    @Remote({ resources: { session: addressedSession } })
    create(sessionId: string, request: TerminalCreateRequest, signal: AbortSignal) { return this.execute(sessionId, signal, (service, access) => service.create(request, access)); }
    @Remote({ mode: 'stream', resources: { session: addressedSession } })
    retain(sessionId: string, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalRetentionFrame> {
        return this.stream(sessionId, signal, (service, access) => service.retain(id, access));
    }
    @Remote({ mode: 'stream', resources: { session: addressedSession } })
    attach(sessionId: string, id: WebTerminalId, signal: AbortSignal): RemoteStream<TerminalFrame, TerminalInput> {
        const invocation = this.ctx.invocation;
        if (!invocation) throw denial();
        const input = invocation.uplink<TerminalInput>(), window = invocation.uplinkWindow;
        return this.stream(sessionId, signal, (service, access) => service.attach(id, input, access, window));
    }
    @Remote({ resources: { session: addressedSession } })
    rename(sessionId: string, id: WebTerminalId, title: string) { return this.execute(sessionId, undefined, (service, access) => service.rename(id, title, access)); }
    @Remote({ resources: { session: addressedSession } })
    close(sessionId: string, id: WebTerminalId) { return this.execute(sessionId, undefined, (service, access) => service.close(id, access)); }
}
