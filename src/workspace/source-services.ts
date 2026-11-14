/** Explicit source OS service registration; this module never opens a Host filesystem or creates an Agent. */
import { posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { SourceIdentity, SourceSession } from '../remote/protocol.ts';
import type { SourceAccess, SourceGateway } from '../remote/gateway.ts';
import type { WorkspaceTarget } from '../workbench-types.ts';
import type { WorkspaceAccess, WorkspaceAction, WorkspaceBinding, WorkspaceProviders, WorkspaceServices } from './service-types.ts';
import { waitFor } from '../remote/errors.ts';
import type { SourceDirectoryIdentity, SourceDirectoryListing } from './source-api.ts';

export interface SourceWorkspaceOwner {
    /** Stable during this registration; a replacement source owner receives a new identity. */
    readonly lifetimeId: string;
    /** Actual source OS/container user permissions; independent of Codex sandbox/approval settings. */
    readonly permissions: 'system-user';
    /** Source registration lifetime. A cancelled request or closed Pane cannot dispose this owner. */
    readonly signal: AbortSignal;
}
export interface SourceWorkspaceRegistration {
    readonly source: Pick<SourceIdentity, 'sourceId' | 'machineId' | 'engine'>;
    /** Stable source-owned configuration identity; changed roots are included in resolved workspaceId. */
    readonly workspaceId: string;
    readonly pathStyle: 'posix' | 'win32';
    readonly signal: AbortSignal;
    /** The closure supplies real source FS/subprocess resources, never a fabricated Agent context. */
    create(binding: WorkspaceBinding, owner: SourceWorkspaceOwner): WorkspaceServices | Promise<WorkspaceServices>;
    /** Explicit source OS browse capability; a conversation root cannot authorize this wider read. */
    directories?(path: string | undefined, signal: AbortSignal): Promise<Pick<SourceDirectoryListing, 'listing' | 'roots'>>;
    dispose?(): void | Promise<void>;
}
const unavailable = (reason: 'unconfigured' | 'source-mismatch', message: string): RemoteError =>
    new RemoteError('workspace-service/unavailable', message, { reason });
interface Registration { value: SourceWorkspaceRegistration; controller: AbortController; owner: SourceWorkspaceOwner }

export class SourceWorkspaceRegistry {
    private readonly registrations = new Map<string, Registration>();
    constructor(private readonly signal: AbortSignal) {}
    register(value: SourceWorkspaceRegistration): () => Promise<void> {
        this.signal.throwIfAborted(); value.signal.throwIfAborted();
        if (this.registrations.has(value.source.sourceId)) throw new Error('A workspace owner is already registered for this source');
        const controller = new AbortController();
        const registration = { value, controller, owner: { lifetimeId: randomUUID(), permissions: 'system-user' as const,
            signal: AbortSignal.any([this.signal, value.signal, controller.signal]) } };
        this.registrations.set(value.source.sourceId, registration);
        return async () => {
            if (this.registrations.get(value.source.sourceId) !== registration) return;
            this.registrations.delete(value.source.sourceId); registration.controller.abort();
            await value.dispose?.();
        };
    }
    async directories(source: SourceDirectoryIdentity, path: string | undefined, signal: AbortSignal): Promise<Pick<SourceDirectoryListing, 'listing' | 'roots'>> {
        this.signal.throwIfAborted(); signal.throwIfAborted();
        const registration = this.registrations.get(source.sourceId);
        if (!registration?.value.directories) throw unavailable('unconfigured', 'Folder browsing is not enabled on this source machine. No central Host path was opened.');
        if (registration.value.source.machineId !== source.machineId || registration.value.source.engine !== source.engine) {
            throw unavailable('source-mismatch', 'The folder browser does not belong to the selected source machine.');
        }
        const current = AbortSignal.any([this.signal, signal, registration.owner.signal]);
        const listing = await waitFor(registration.value.directories(path, current), current);
        current.throwIfAborted();
        if (this.registrations.get(source.sourceId) !== registration) throw unavailable('source-mismatch', 'The original folder browser was replaced. Select the folder again.');
        return listing;
    }
    async resolve(session: SourceSession, target: WorkspaceTarget, access: WorkspaceAccess): Promise<WorkspaceServices> {
        this.signal.throwIfAborted(); access.signal.throwIfAborted();
        const registration = this.registrations.get(session.sourceId);
        if (!registration) throw unavailable('unconfigured', 'The workspace service is not registered on this source. No central Host path was opened.');
        const source = registration.value.source;
        if (source.machineId !== session.machineId || source.engine !== session.engine || target.sessionId !== session.id) {
            throw unavailable('source-mismatch', 'The workspace owner does not match the original source identity.');
        }
        const owner = registration.owner;
        owner.signal.throwIfAborted();
        const paths = registration.value.pathStyle === 'win32' ? win32 : posix;
        if (!paths.isAbsolute(session.cwd)) throw unavailable('unconfigured', 'The original source did not provide an absolute workspace root.');
        const root = paths.normalize(session.cwd);
        const binding: WorkspaceBinding = { target: { hostId: target.hostId, sessionId: target.sessionId }, machineId: session.machineId,
            workspaceId: JSON.stringify([registration.value.workspaceId, root]), root, pathStyle: registration.value.pathStyle };
        const services = await waitFor(Promise.resolve(registration.value.create(binding, owner)), AbortSignal.any([access.signal, owner.signal]));
        if (!services.files || !services.documents) throw unavailable('unconfigured', 'The source workspace has not installed its file and document services.');
        const actual = services.binding;
        if (this.registrations.get(session.sourceId) !== registration || actual.target.hostId !== target.hostId
            || actual.target.sessionId !== target.sessionId || actual.machineId !== binding.machineId
            || actual.workspaceId !== binding.workspaceId || actual.root !== binding.root || actual.pathStyle !== binding.pathStyle) {
            throw unavailable('source-mismatch', 'The workspace provider returned a different source or configuration.');
        }
        owner.signal.throwIfAborted(); access.signal.throwIfAborted();
        return services;
    }
    async dispose(): Promise<void> {
        const values = [...this.registrations.values()]; this.registrations.clear();
        for (const value of values) value.controller.abort();
        const results = await Promise.allSettled(values.map(async ({ value }) => { await value.dispose?.(); }));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Some source workspace owners could not close');
    }
}

export interface SourceWorkspaceProviderOptions {
    localHostId: string;
    gateway: Pick<SourceGateway, 'workspace'>;
    sourceAccess: SourceAccess;
    action: WorkspaceAction;
    /** These are existing official DSH providers; no HHPI identity is passed to them. */
    localDsh?: WorkspaceProviders['local-dsh'];
    federatedDsh?: WorkspaceProviders['federated-dsh'];
    /** Use the selected Host's authenticated sourceWorkspace carrier, without a local fallback. */
    remoteHhpi?: WorkspaceProviders['hhpi'];
}
export function createSourceWorkspaceProviders(options: SourceWorkspaceProviderOptions): WorkspaceProviders {
    return {
        localHostId: options.localHostId,
        ...(options.localDsh ? { 'local-dsh': options.localDsh } : {}),
        ...(options.federatedDsh ? { 'federated-dsh': options.federatedDsh } : {}),
        async hhpi(route, access) {
            if (route.hostId === options.localHostId) return options.gateway.workspace(route, options.sourceAccess, access, options.action);
            if (!options.remoteHhpi) throw unavailable('unconfigured', 'The selected source Host has no workspace connection.');
            return options.remoteHhpi(route, access);
        },
    };
}
