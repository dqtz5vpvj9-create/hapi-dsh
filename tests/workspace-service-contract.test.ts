/** Source routing and authorization checks with fixture providers; no actual filesystem or PTY is mounted. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { sourceSessionId } from '../src/remote/protocol.ts';
import { withWorkspaceService, workspaceFileKey } from '../src/shared/source-access.ts';
import { workspaceFileSaveRequestSchema, workspaceResourceSchema, workspaceTargetSchema,
    workspaceUploadChunkSchema, workspaceUploadStartSchema, type WorkspaceTarget } from '../src/workbench-types.ts';
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceProviders, WorkspaceServices } from '../src/workspace/service-types.ts';

const identity = { machineId: 'source-machine', sourceId: 'codex-source', engine: 'codex', nativeId: 'native-thread' };
const native: WorkspaceTarget = { hostId: 'display-host', sessionId: sourceSessionId(identity) };
const ordinary: WorkspaceTarget = { hostId: 'display-host', sessionId: 'ordinary-session' };
const remote: WorkspaceTarget = { hostId: 'remote-host', sessionId: 'ordinary-session' };

function fixture() {
    const calls: string[] = [];
    let allowed = true;
    const controller = new AbortController();
    const access: WorkspaceAccess = {
        scope: 'account-one', signal: controller.signal,
        assertAllowed(target, action) {
            calls.push(`authorize:${target.sessionId}:${action}`);
            if (!allowed) throw new Error('Source access was revoked');
        },
    };
    function service(target: WorkspaceTarget, machineId = 'ordinary-machine'): WorkspaceServices {
        const file = { absolutePath: '/workspace/note.md', version: 'source-revision:7', bytes: 4 };
        const binding: WorkspaceBinding = { target: { hostId: target.hostId, sessionId: target.sessionId }, machineId,
            workspaceId: 'source-workspace', root: '/workspace', pathStyle: 'posix' };
        const inspect = async () => ({ ...file, name: 'note.md', type: 'file' as const });
        return {
            binding,
            files: {
                async read() { calls.push(`read:${machineId}`); return { ...file, offset: 1, text: 'note', lines: 1, eof: true }; },
                async readBytes() { return { ...file, offset: 0, data: new Uint8Array([0, 1, 2, 3]), eof: true }; },
                async stat() { return file; },
                async list() { return { path: '', entries: [{ name: 'note.md', type: 'file', size: 4 }], truncated: false }; },
                async *changes() { yield { kind: 'ready' }; },
            },
            documents: {
                async open(document) { return { resource: { target, document }, fileName: 'note.md', mimeType: 'text/plain',
                    bytes: 4, version: file.version, writable: false, text: 'note' }; },
                async bytes() { return { ...file, offset: 0, data: new Uint8Array([0, 1, 2, 3]), eof: true }; },
                inspect, async search() { return [await inspect()]; },
                async git() { return { stdout: '', stderr: '', exitCode: 0 }; },
            },
        };
    }
    const providers: WorkspaceProviders = {
        localHostId: 'display-host',
        async 'local-dsh'(route) { calls.push('provider:local-dsh'); return service(route); },
        async 'federated-dsh'(route) { calls.push('provider:federated-dsh'); return service(route, 'federated-machine'); },
        async hhpi(route) { calls.push('provider:hhpi'); return service(route, route.identity.machineId); },
    };
    const read = (target: WorkspaceTarget, sourceProviders = providers) => withWorkspaceService(target, 'read', access,
        sourceProviders, (services, current) => services.files.read('note.md', {}, current));
    return { calls, access, controller, service, providers, read, revoke() { allowed = false; } };
}

test('workspace calls select local DSH, federation and HHPI using the binding Host and canonical session address', async () => {
    const f = fixture();
    assert.equal((await f.read(ordinary)).text, 'note');
    assert.equal((await f.read(remote)).text, 'note');
    assert.equal((await f.read(native)).text, 'note');
    assert.deepEqual(f.calls.filter(value => value.startsWith('provider:')), ['provider:local-dsh', 'provider:federated-dsh', 'provider:hhpi']);
    assert.deepEqual(f.calls.filter(value => value.startsWith('read:')), ['read:ordinary-machine', 'read:federated-machine', 'read:source-machine']);
});

test('canonical and malformed HHPI addresses cannot execute the local workspace provider', async () => {
    const f = fixture();
    const providers: WorkspaceProviders = { localHostId: f.providers.localHostId, 'local-dsh': f.providers['local-dsh']! };
    await assert.rejects(f.read(native, providers), /Set up the workspace service/);
    for (const sessionId of ['hhpi:', 'hhpi:bad', 'hhpi:%ZZ:s:codex:t', 'hhpi:m:s:codex:%74']) {
        await assert.rejects(f.read({ ...ordinary, sessionId }, providers), /source session identity/);
    }
    await assert.rejects(f.read({ ...ordinary, sessionId: `hapi-codex-${'a'.repeat(32)}` }, providers), /saved source identity/);
    assert.deepEqual(f.calls.filter(value => value.startsWith('provider:') || value.startsWith('read:')), []);
});

test('missing federation and failed source providers never fall through to local Host files', async () => {
    const f = fixture();
    await assert.rejects(f.read(remote, { localHostId: f.providers.localHostId, 'local-dsh': f.providers['local-dsh']! }), /Set up/);
    await assert.rejects(f.read(native, { ...f.providers, async hhpi() { throw new Error('Source is offline'); } }), /Source is offline/);
    assert.equal(f.calls.some(value => value === 'provider:local-dsh' || value.startsWith('read:')), false);
});

test('server denial is checked before provider resolution, independently of a registered capability', async () => {
    const f = fixture();
    f.revoke();
    await assert.rejects(f.read(native), /revoked/);
    assert.deepEqual(f.calls, [`authorize:${native.sessionId}:read`]);
});

test('revocation during source resolution prevents file execution and revocation during reading withholds returned bytes', async () => {
    const f = fixture();
    await assert.rejects(f.read(native, { ...f.providers, async hhpi() {
        f.revoke(); return f.service(native, identity.machineId);
    } }), /revoked/);
    assert.equal(f.calls.some(value => value.startsWith('read:')), false);

    const later = fixture();
    await assert.rejects(withWorkspaceService(native, 'read', later.access, later.providers, async (services, access) => {
        const value = await services.files.readBytes('note.md', {}, access);
        later.revoke();
        return value;
    }), /revoked/);
});

test('a response for another machine or session cannot operate on the selected resource', async () => {
    for (const mismatch of [fixture().service(native, 'other-machine'), fixture().service(ordinary, identity.machineId)]) {
        const f = fixture();
        await assert.rejects(f.read(native, { ...f.providers, async hhpi() { return mismatch; } }), /different source/);
        assert.equal(f.calls.some(value => value.startsWith('read:')), false);
    }
});

test('access loss after a source mutation is reported as indeterminate and never repeats the operation', async () => {
    const f = fixture();
    let writes = 0;
    await assert.rejects(withWorkspaceService(native, 'save', f.access, f.providers, async () => {
        writes++;
        f.revoke();
        return { status: 'applied', operationId: 'save-one' };
    }), { code: 'workspace-service/result-unavailable', details: { outcome: 'indeterminate' } });
    assert.equal(writes, 1);
    assert.equal(f.calls.includes('provider:local-dsh'), false);
});

test('cancellation while resolving a source prevents its operation without trying another provider', async () => {
    const f = fixture();
    await assert.rejects(f.read(native, { ...f.providers, async hhpi() {
        f.controller.abort(new Error('View request cancelled')); return f.service(native, identity.machineId);
    } }), /View request cancelled/);
    assert.equal(f.calls.some(value => value.startsWith('read:') || value === 'provider:local-dsh'), false);
});

test('file and draft keys distinguish accounts, Hosts, source sessions, machines and workspace registrations', () => {
    const f = fixture(), base = f.service(native, identity.machineId).binding;
    const bindings = [base, { ...base, target: { ...native, hostId: 'other-host' } },
        { ...base, target: { ...native, sessionId: sourceSessionId({ ...identity, nativeId: 'other-thread' }) } },
        { ...base, machineId: 'other-machine' }, { ...base, workspaceId: 'new-workspace' }];
    const keys = bindings.map(binding => workspaceFileKey('account-one', binding, '/workspace/note.md'));
    keys.push(workspaceFileKey('account-two', base, '/workspace/note.md'));
    assert.equal(new Set(keys).size, keys.length);
});

test('workspace request parsing preserves opaque source versions and excludes caller-selected authority or execution roots', () => {
    const request = { target: native, operationId: 'save-one', path: 'note.md', baseline: { kind: 'version', version: 'inode:9/revision:4' }, text: 'new' };
    assert.deepEqual(workspaceFileSaveRequestSchema.parse(request), request);
    assert.equal(workspaceFileSaveRequestSchema.safeParse({ ...request, baseline: { kind: 'version', version: '' } }).success, false);
    assert.equal(workspaceFileSaveRequestSchema.safeParse({ ...request, expectedHash: 'a'.repeat(64) }).success, false);
    assert.equal(workspaceTargetSchema.safeParse({ ...native, kind: 'local-dsh' }).success, false);
    assert.equal(workspaceTargetSchema.safeParse({ ...native, authorized: true, root: '/host' }).success, false);
    assert.equal(workspaceResourceSchema.safeParse({ target: native, document: { kind: 'file', path: 'note.md', machineId: 'other-machine' } }).success, false);
});

test('binary upload requests retain source identity and bytes without a base64 body or fixed whole-document cap', () => {
    const data = new Uint8Array([0, 255, 128, 13, 10]);
    const request = { target: native, uploadId: 'transfer-one', offset: 8, data };
    assert.deepEqual(workspaceUploadChunkSchema.parse(request), request);
    assert.equal(workspaceUploadChunkSchema.safeParse({ ...request, data: 'AP+ADQo=' }).success, false);
    assert.equal(workspaceUploadChunkSchema.safeParse({ ...request, offset: -1 }).success, false);
    const start = { target: native, operationId: 'upload-one', destination: { kind: 'file', path: 'large.bin', baseline: { kind: 'absent' } },
        bytes: 128 * 1024 * 1024, mimeType: 'application/octet-stream' };
    assert.deepEqual(workspaceUploadStartSchema.parse(start), start);
});

test('the pinned official WorkspaceFiles Remote still exposes reads and observations only', async () => {
    const ctx = new Context();
    try {
        const files = new WorkspaceFiles(ctx, WorkspaceFiles.Config());
        assert.deepEqual(remoteMethods(files).map(marker => marker.method).sort(), ['changes', 'list', 'read', 'readBytes', 'stat']);
        assert.equal(Object.hasOwn(files, 'save'), false);
    } finally { await ctx.fiber.dispose(); }
});
