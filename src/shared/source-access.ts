/** Source identities must never fall through to a central Host execution or filesystem. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '../hhpi-api.ts';
import { isSourceSessionId } from '../remote/protocol.ts';
import { isSourceDisplayId } from './source-display-id.ts';
import { sourceRoute } from './source-capability.ts';
import type { SourceRoute } from './source-capability.ts';
import type { WorkspaceTarget } from '../workbench-types.ts';
import type { WorkspaceAccess, WorkspaceAction, WorkspaceBinding, WorkspaceProviders, WorkspaceServices } from '../workspace/service-types.ts';

export function assertOrdinarySourceTarget(sessionId: string): void {
    if (isSourceSessionId(sessionId)) throw new RemoteError('hhpi/source', 'This operation must use the exact native source capability. No central Host execution or path was used.', { outcome: 'rejected', sourceCode: 'UNSUPPORTED' });
    if (isSourceDisplayId(sessionId) || sessionId.startsWith('hapi-codex-') || sessionId.startsWith('hapi-observed-')) {
        throw new RemoteError('hhpi/source', 'This retired source requires an exact native alias or offline recovery. No central Host execution or path was used.', { outcome: 'rejected', sourceCode: 'UNSUPPORTED' });
    }
}

/** Full source/account identity for a file or draft; callers supply the source's canonical absolute path. */
export function workspaceFileKey(scope: string, binding: WorkspaceBinding, absolutePath: string): string {
    return JSON.stringify([scope, binding.target.hostId, binding.target.sessionId, binding.machineId, binding.workspaceId, absolutePath]);
}

async function workspaceServices(route: SourceRoute, access: WorkspaceAccess, providers: WorkspaceProviders): Promise<WorkspaceServices> {
    const unavailable = () => new RemoteError('workspace-service/unavailable', 'Set up the workspace service on the selected source.', { reason: 'unconfigured' });
    switch (route.kind) {
        case 'local-dsh': {
            const resolve = providers['local-dsh'];
            if (!resolve) throw unavailable();
            return resolve(route, access);
        }
        case 'federated-dsh': {
            const resolve = providers['federated-dsh'];
            if (!resolve) throw unavailable();
            return resolve(route, access);
        }
        case 'hhpi': {
            const resolve = providers.hhpi;
            if (!resolve) throw unavailable();
            return resolve(route, access);
        }
    }
}

/**
 * Execute one call through its exact provider and current server grants. No failure retries another owner.
 * Streams must continue using access.signal and recheck access in their executor before releasing each event.
 * Mutating executors also check access at the source commit point; this call does not make a filesystem CAS.
 */
export async function withWorkspaceService<Value>(target: WorkspaceTarget, action: WorkspaceAction, access: WorkspaceAccess,
    providers: WorkspaceProviders, execute: (services: WorkspaceServices, access: WorkspaceAccess) => Promise<Value>): Promise<Value> {
    access.signal.throwIfAborted();
    const route = sourceRoute(target.hostId, target.sessionId, providers.localHostId);
    await access.assertAllowed(target, action);
    const services = await workspaceServices(route, access, providers);
    const binding = services.binding;
    if (binding.target.hostId !== target.hostId || binding.target.sessionId !== target.sessionId
        || route.kind === 'hhpi' && binding.machineId !== route.identity.machineId) {
        throw new RemoteError('workspace-service/unavailable', 'The workspace service returned a different source.', { reason: 'source-mismatch' });
    }
    access.signal.throwIfAborted();
    await access.assertAllowed(target, action);
    const value = await execute(services, access);
    try {
        access.signal.throwIfAborted();
        await access.assertAllowed(target, action);
    } catch (error) {
        if (action === 'read' || action === 'list' || action === 'watch') throw error;
        throw new RemoteError('workspace-service/result-unavailable',
            'The source operation may have completed before access ended. Check its original result before continuing.', { outcome: 'indeterminate' });
    }
    return value;
}
import type {} from '../client-api.ts';
