/** Persistent workspace and machine directory when no legacy HAPI source is configured. */
import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { HAPI_REMOTE, type HapiCatalog, type WorkspaceDocument, type WorkspaceWrite, type WorkspaceWriteResult } from '../client-api.ts';
import type { LegacyWorkspaceSnapshot } from '../legacy-workspace-types.ts';
import type { FederationHub } from './federation.ts';
import type { WorkspaceRepository } from './workspaces.ts';
import { HHPI_HOST_CONTRACT } from '../remote/service.ts';

declare module '@deepseek-ai/cordis' { interface Context { hhpiWorkspaceShell: WorkspaceShell } }
/** Existing workspace wire names are retained; no HAPI client or credential is constructed. */
export class WorkspaceShell extends TypertRemoteService {
    private readonly identity: string;
    constructor(ctx: Context, private readonly federation: FederationHub, private readonly workspace: WorkspaceRepository, profileIdentity: string) {
        super(ctx, 'hhpiWorkspaceShell', { namespace: 'hapi' });
        this.identity = `hhpi-${createHash('sha256').update(profileIdentity).digest('hex').slice(0, 24)}`;
        const methods = new Set(['catalog', 'workspaceGet', 'workspacePut', 'workspaceLegacy']);
        ctx.effect(() => ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [],
            invocations: [...HAPI_REMOTE.descriptors.filter(descriptor => methods.has(descriptor.method)).map(descriptor => ({ ...descriptor, service: 'hhpiWorkspaceShell' })), ...HHPI_HOST_CONTRACT.invocations],
            model: { services: [{ key: 'hhpiWorkspaceShell', exportName: 'WorkspaceShell', tags: [], members: [], types: [], summary: 'HHPI workspace and machine directory.' }, ...HHPI_HOST_CONTRACT.services], events: [], objects: [] },
        }), 'hhpi: HAPI-independent workspace contract');
    }
    @Remote('catalog')
    async catalog(): Promise<HapiCatalog> {
        return { hubId: this.identity, connected: true, machines: [], sessions: [],
            hosts: this.federation.listMachines().map(machine => ({ id: machine.id, label: machine.name, online: machine.online, basePath: machine.baseUrl })) };
    }
    @Remote('workspaceGet')
    workspaceGet(): Promise<WorkspaceDocument> { return this.workspace.get(); }
    @Remote('workspacePut')
    workspacePut(request: WorkspaceWrite): Promise<WorkspaceWriteResult> { return this.workspace.put(request); }
    @Remote('workspaceLegacy')
    async workspaceLegacy(): Promise<LegacyWorkspaceSnapshot> { return { schemaVersion: 2, revision: 0, workspaces: [] }; }
}
