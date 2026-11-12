/** Actual installed Gateway, Connection route, official atomic FS and attachment storage; only native catalog/credentials are fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { SessionId } from '@deepseek-ai/dsh-session';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { sourceSessionId, type SourceSession, type DirectSourceConfig, type SourceAdapter } from '../src/remote/protocol.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import { SourceWorkspaceService, registerSourceContract, sourceStorageScope } from '../src/remote/service.ts';
import { installLocalSourceWorkspaces } from '../src/workspace/local-source.ts';
import { appendSourceUpload } from '../src/workspace/source-upload-route.ts';
import { CodexUploads } from '../src/remote/codex-uploads.ts';
import type { CodexAccessBridge } from '../src/remote/codex-access-bridge.ts';
import type { WorkspaceAccess, WorkspaceMutationResult, WorkspaceUploadReceipt, WorkspaceUploadTransfer } from '../src/workspace/service-types.ts';
import type { WorkspaceUploadStart } from '../src/workbench-types.ts';
import { SOURCE_UPLOAD_CHUNK_PATH } from '../src/shared/source-upload.ts';
declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { reader: { kind: 'reader' } } }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';

test('native upload entry publishes binary files and source image receipts without an Agent or base64 RPC', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-upload-composition-'), cwd = join(directory, 'workspace'), receipts = join(directory, 'receipts');
    await mkdir(cwd);
    const config: DirectSourceConfig = { id: 'source', machineId: 'machine', engine: 'codex' };
    const session: SourceSession = { id: sourceSessionId({ sourceId: config.id, machineId: config.machineId, engine: config.engine, nativeId: 'thread' }),
        sourceId: config.id, machineId: config.machineId, engine: config.engine, nativeId: 'thread', cwd, title: 'Synthetic', updatedAt: 1, status: 'idle', activeTurnId: null,
        capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] };
    const adapter: SourceAdapter = { id: config.id, machineId: config.machineId, engine: config.engine, async list() { return [session]; }, async resolve() { return session; },
        async read() { throw new Error('No transcript required'); }, async *changes() {}, async operate() { throw new Error('No execution allowed'); }, dispose() {} };
    const ctx = new Context(), sources = new SourceGateway([adapter]);
    try {
        await ctx.plugin(TypertRegistry); const remoteAccess = new RemoteAccess(ctx); registerSourceContract(ctx);
        new SourceWorkspaceService(ctx, sources, { localHostId: 'local', scopeId: directory });
        const gateway = new Gateway(ctx, Gateway.Config({}));
        const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
        installLocalSourceWorkspaces(ctx, sources, [config], [{ sourceId: config.id, provider: 'local-system' }], directory, new Map([[config.id, receipts]]));
        const target = { hostId: 'local', sessionId: session.id }, access: WorkspaceAccess = { scope: sourceStorageScope(directory), signal: connection.browserPeer.signal,
            assertAllowed(value) { assert.deepEqual(value, target); } };
        connection.fetch.register({ path: SOURCE_UPLOAD_CHUNK_PATH, methods: ['POST'], requestBody: 'streaming', fetch: request => appendSourceUpload(request, async id => {
            assert.equal(id, session.id); return { services: await sources.workspace(target, () => true, access, 'upload'), access };
        }) });
        const fetch = connection.createSharedFetchHandler('/api');
        const invoke = (method: string, request: unknown) => gateway.invoke({ peer: connection.browserPeer, namespace: 'sourceWorkspace', method, args: { request } });
        const upload = async (data: Uint8Array, destination: WorkspaceUploadStart['destination'], mimeType = 'application/octet-stream') => {
            const operationId = randomUUID();
            const transfer = await invoke('beginUpload', { target, operationId, destination, bytes: data.length, mimeType }) as WorkspaceUploadTransfer;
            const query = new URLSearchParams({ sessionId: session.id, uploadId: transfer.uploadId, offset: '0' });
            const response = await fetch.fetch(new Request(`http://source.test${SOURCE_UPLOAD_CHUNK_PATH}?${query}`, { method: 'POST', body: new Uint8Array(data) }), connection.browserPeer);
            assert.equal(response.status, 200);
            const result = await invoke('finishUpload', { target, uploadId: transfer.uploadId }) as WorkspaceMutationResult<WorkspaceUploadReceipt>;
            assert.deepEqual(await invoke('finishUpload', { target, uploadId: transfer.uploadId }), result, 'original finish is reconciled without replay');
            return { result, operationId };
        };
        remoteAccess.registerPolicy('reader', { bindings: () => [{ resource: { kind: 'session', id: SessionId(session.id) },
            role: { name: 'Reader', resource: 'session', actions: ['sourceWorkspace/resolve', 'sourceWorkspace/beginUpload'] } }] });
        const reader = connection.createPeer({ principal: { kind: 'reader' } });
        const description = await gateway.invoke({ peer: reader, namespace: 'sourceWorkspace', method: 'resolve', args: { request: { sessionId: session.id } } }) as { registered: { uploads: boolean } };
        assert.equal(description.registered.uploads, false, 'owner-only binary carrier must not be advertised to another principal');
        await assert.rejects(gateway.invoke({ peer: reader, namespace: 'sourceWorkspace', method: 'beginUpload', args: { request: { target,
            operationId: randomUUID(), destination: { kind: 'attachment', name: 'file.txt' }, bytes: 3, mimeType: 'text/plain' } } }));
        const bytes = Uint8Array.of(0, 127, 128, 255);
        assert.equal((await upload(bytes, { kind: 'file', path: 'binary.dat', baseline: { kind: 'absent' } })).result.status, 'applied');
        assert.deepEqual(await readFile(join(cwd, 'binary.dat')), Buffer.from(bytes));
        await writeFile(join(cwd, 'existing.dat'), 'keep');
        assert.equal((await upload(bytes, { kind: 'file', path: 'existing.dat', baseline: { kind: 'absent' } })).result.status, 'conflict');
        assert.equal(await readFile(join(cwd, 'existing.dat'), 'utf8'), 'keep');
        const image = await upload(Buffer.from(PNG, 'base64'), { kind: 'attachment', name: 'screenshot.png' }, 'image/png');
        assert.equal(image.result.status, 'applied');
        const native = new CodexUploads(receipts, { call() { throw new Error('Receipt lookup must not invoke Codex'); } } as unknown as CodexAccessBridge);
        const input = await native.inputs(session.id, [image.operationId]);
        assert.equal(input[0]?.type, 'localImage');
        if (input[0]?.type === 'localImage') assert.ok((await readFile(input[0].path)).length > 0);
        await assert.rejects(native.inputs('another-thread', [image.operationId]), /another source/);
        const invalid = await upload(Uint8Array.of(1, 2, 3), { kind: 'attachment', name: 'invalid.png' }, 'image/png');
        assert.equal(invalid.result.status, 'rejected');
        assert.equal(ctx.get('agent'), undefined); assert.equal(ctx.get('fs'), undefined);
    } finally { await sources.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
