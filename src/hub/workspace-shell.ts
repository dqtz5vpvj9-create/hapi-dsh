import { APP_SERVICES_HOST_CONTRACT } from '../workspace/app-api.ts';
import { SOURCE_ALIAS_HOST_CONTRACT } from '../workspace/source-alias-api.ts';
/** Persistent workspace and machine directory when no legacy HAPI source is configured. */
import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { HAPI_REMOTE, type HapiCatalog, type WorkspaceDocument, type WorkspaceWrite, type WorkspaceWriteResult } from '../client-api.ts';
import type { FederationHub } from './federation.ts';
import type { WorkspaceRepository } from './workspaces.ts';
import { SOURCE_HOST_CONTRACT as HHPI_HOST_CONTRACT } from '../remote/service.ts';
import { uploadFailureLimit, uploadFailureSchema, type UploadFailure } from '../upload-diagnostics.ts';

const allowUploadFailure = uploadFailureLimit(30);

declare module '@deepseek-ai/cordis' { interface Context { hhpiWorkspaceShell: WorkspaceShell } }
/** Existing workspace wire names are retained; no HAPI client or credential is constructed. */
export class WorkspaceShell extends TypertRemoteService {
    private readonly identity: string;
    constructor(ctx: Context, private readonly federation: FederationHub, private readonly workspace: WorkspaceRepository, profileIdentity: string) {
        super(ctx, 'hhpiWorkspaceShell', { namespace: 'hapi' });
        this.identity = `hhpi-${createHash('sha256').update(profileIdentity).digest('hex').slice(0, 24)}`;
        const methods = new Set(['catalog', 'workspaceGet', 'workspacePut', 'uploadFailure']);
        ctx.effect(() => ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [],
            invocations: [...HAPI_REMOTE.descriptors.filter(descriptor => methods.has(descriptor.method)).map(descriptor => ({ ...descriptor, service: 'hhpiWorkspaceShell' })), ...HHPI_HOST_CONTRACT.invocations, ...APP_SERVICES_HOST_CONTRACT.invocations, ...SOURCE_ALIAS_HOST_CONTRACT.invocations],
            model: { services: [{ key: 'hhpiWorkspaceShell', exportName: 'WorkspaceShell', tags: [], members: [], types: [], summary: 'HHPI workspace and machine directory.' }, ...HHPI_HOST_CONTRACT.services, ...APP_SERVICES_HOST_CONTRACT.services, ...SOURCE_ALIAS_HOST_CONTRACT.services], events: [], objects: [] },
        }), 'hhpi: HAPI-independent workspace contract');
    }
    @Remote('catalog')
    async catalog(): Promise<HapiCatalog> {
        return { hubId: this.identity, connected: true, machines: [], sessions: [],
            hosts: this.federation.listMachines().map(machine => ({ id: machine.id, label: machine.name, online: machine.online, basePath: machine.baseUrl })),
            hostsComplete: this.federation.hostsComplete };
    }
    @Remote('workspaceGet')
    workspaceGet(): Promise<WorkspaceDocument> { return this.workspace.get(); }
    @Remote('workspacePut')
    workspacePut(request: WorkspaceWrite): Promise<WorkspaceWriteResult> { return this.workspace.put(request); }
    @Remote('uploadFailure')
    uploadFailure(request: UploadFailure): null {
        const report = uploadFailureSchema.parse(request);
        // Cordis' default exporter keeps an in-memory buffer. The carrier's
        // existing stderr is the durable Host log, including without a log UI.
        if (allowUploadFailure()) process.stderr.write(`Attachment upload failure ${JSON.stringify(report)}\n`);
        return null;
    }
}
