/** Real private SQLite/files and Fetch streams; the final source commit is the explicit boundary fixture. */
import assert from 'node:assert/strict';
declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { reader: { kind: 'reader' } } }
import test from 'node:test';
import { mkdtemp, readFile, rm, access as fileExists } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { SOURCE_UPLOAD_CHUNK_PATH } from '../src/shared/source-upload.ts';
import { SourceUploads, type SourceUploadOptions } from '../src/workspace/source-uploads.ts';
import { appendSourceUpload } from '../src/workspace/source-upload-route.ts';
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceServices } from '../src/workspace/service-types.ts';

const binding: WorkspaceBinding = { target: { hostId: 'local', sessionId: 'hhpi:machine:source:codex:thread' }, machineId: 'machine',
    workspaceId: 'source', root: '/source', pathStyle: 'posix' };
const start = { target: binding.target, operationId: 'upload-intent', bytes: 6, mimeType: 'text/plain', destination: { kind: 'file' as const, path: 'file.txt', baseline: { kind: 'absent' as const } } };
async function fixture(t: test.TestContext, commit?: SourceUploadOptions['commit'], receipt?: SourceUploadOptions['receipt']) {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-source-upload-'), controller = new AbortController();
    const access: WorkspaceAccess = { scope: 'account', signal: controller.signal, assertAllowed(target) { assert.deepEqual(target, binding.target); } };
    const options: SourceUploadOptions = { directory, signal: controller.signal, chunkBytes: 4, ...(receipt ? { receipt } : {}), commit: commit ?? (async (_binding, request, path) => {
        assert.equal(await readFile(path, 'utf8'), 'abcdef');
        return { status: 'rejected', operationId: request.operationId, code: 'unsupported', message: 'Fixture stops before final publication.' };
    }) };
    let owner = new SourceUploads(options);
    t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
    return { access, directory, get service() { return owner.workspace(binding); }, async restart() { await owner.close(); owner = new SourceUploads(options); } };
}
test('lost begin and chunk replies resume the original durable upload after restart', async t => {
    const f = await fixture(t), transfer = await f.service.begin(start, f.access), request = { target: binding.target, uploadId: transfer.uploadId };
    assert.equal((await f.service.begin(start, f.access)).uploadId, transfer.uploadId);
    await f.service.append({ ...request, offset: 0, data: Buffer.from('abc') }, f.access);
    await f.restart();
    const status = await f.service.status(request, f.access);
    assert.equal(status.state === 'uploading' && status.transfer.receivedBytes, 3);
    await assert.rejects(f.service.append({ ...request, offset: 0, data: Buffer.from('abc') }, f.access), /status/);
    await f.service.append({ ...request, offset: 3, data: Buffer.from('def') }, f.access);
    assert.equal((await f.service.finish(request, f.access)).status, 'rejected');
});
test('upload identity cannot cross an account, source or changed intent', async t => {
    const f = await fixture(t), transfer = await f.service.begin(start, f.access), request = { target: binding.target, uploadId: transfer.uploadId };
    await assert.rejects(f.service.status(request, { ...f.access, scope: 'other' }), /unavailable/);
    await assert.rejects(f.service.status({ ...request, target: { ...binding.target, sessionId: 'another' } }, f.access), /another source/);
    await assert.rejects(f.service.begin({ ...start, bytes: 7 }, f.access), /another file/);
    const concurrent = await Promise.allSettled([f.service.append({ ...request, offset: 0, data: Buffer.from('abc') }, f.access),
        f.service.append({ ...request, offset: 0, data: Buffer.from('abc') }, f.access)]);
    assert.equal(concurrent.filter(value => value.status === 'fulfilled').length, 1);
    const status = await f.service.status(request, f.access); assert.equal(status.state === 'uploading' && status.transfer.receivedBytes, 3);
});
test('a failed reply after final publication never blindly commits the original upload again', async t => {
    let commits = 0;
    const f = await fixture(t, async () => { commits++; throw new Error('source result lost'); });
    const transfer = await f.service.begin({ ...start, bytes: 3 }, f.access), request = { target: binding.target, uploadId: transfer.uploadId };
    await f.service.append({ ...request, offset: 0, data: Buffer.from('abc') }, f.access);
    assert.equal((await f.service.finish(request, f.access)).status, 'indeterminate');
    await f.restart();
    assert.equal((await f.service.finish(request, f.access)).status, 'indeterminate');
    assert.equal((await f.service.status(request, f.access)).state, 'finished'); assert.equal(commits, 1);
});
test('cancel removes only uncommitted bytes and rejects late chunks', async t => {
    const f = await fixture(t), transfer = await f.service.begin(start, f.access), request = { target: binding.target, uploadId: transfer.uploadId };
    await f.service.append({ ...request, offset: 0, data: Buffer.from('abc') }, f.access);
    assert.deepEqual(await f.service.cancel(request, f.access), { state: 'cancelled' });
    await assert.rejects(fileExists(join(f.directory, `${transfer.uploadId}.bin`)));
    await assert.rejects(f.service.append({ ...request, offset: 3, data: Buffer.from('def') }, f.access), /status/);
    await assert.rejects(f.service.finish(request, f.access), /cancelled/);
});
test('raw HTTP chunks are bounded before storage and retain binary bytes', async t => {
    const f = await fixture(t), transfer = await f.service.begin(start, f.access);
    const resolve = async () => ({ services: { binding, uploads: f.service } as WorkspaceServices, access: f.access });
    const url = `http://source.test/api/hhpi/workspace/uploadChunk?sessionId=${encodeURIComponent(binding.target.sessionId)}&uploadId=${transfer.uploadId}&offset=0`;
    assert.equal((await appendSourceUpload(new Request(url, { method: 'POST', body: new Uint8Array(5) }), resolve)).status, 413);
    const bytes = Uint8Array.of(0, 128, 255);
    const response = await appendSourceUpload(new Request(url, { method: 'POST', body: bytes }), resolve);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { receivedBytes: 3 });
    assert.deepEqual(await readFile(join(f.directory, `${transfer.uploadId}.bin`)), Buffer.from(bytes));
});

test('status reconciles an unknown commit using the original source receipt without replay', async t => {
    let commits = 0, receiptReady = false;
    const committed = { status: 'rejected' as const, operationId: start.operationId, code: 'invalid' as const, message: 'Original source decision' };
    const f = await fixture(t, async () => { commits++; throw new Error('receipt reply lost'); }, async () => receiptReady ? committed : null);
    const transfer = await f.service.begin({ ...start, bytes: 0 }, f.access), request = { target: binding.target, uploadId: transfer.uploadId };
    assert.equal((await f.service.finish(request, f.access)).status, 'indeterminate');
    await f.restart(); receiptReady = true;
    assert.deepEqual(await f.service.status(request, f.access), { state: 'finished', result: committed });
    assert.deepEqual(await f.service.finish(request, f.access), committed); assert.equal(commits, 1);
});

test('the installed Connection route rejects non-owner peers before reading source bytes', async t => {
    const f = await fixture(t), transfer = await f.service.begin(start, f.access), ctx = new Context();
    // Credential admission is outside this fixture. Exercise the actual registry's
    // post-admission boundary, not a hand-written owner check in our handler.
    const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
    let reads = 0;
    const dispose = connection.fetch.register({ path: SOURCE_UPLOAD_CHUNK_PATH, methods: ['POST'], requestBody: 'streaming',
        fetch: request => appendSourceUpload(request, async () => { reads++;
            return { services: { binding, uploads: f.service } as WorkspaceServices, access: f.access }; }) });
    const handler = connection.createSharedFetchHandler('/api');
    const url = `http://source.test${SOURCE_UPLOAD_CHUNK_PATH}?sessionId=${encodeURIComponent(binding.target.sessionId)}&uploadId=${transfer.uploadId}&offset=0`;
    try {
        const denied = connection.createPeer({ principal: { kind: 'reader' } });
        assert.equal((await handler.fetch(new Request(url, { method: 'POST', body: Uint8Array.of(1) }), denied)).status, 403);
        assert.equal(reads, 0);
        assert.equal((await handler.fetch(new Request(url, { method: 'POST', body: Uint8Array.of(1) }), connection.browserPeer)).status, 200);
        assert.equal(reads, 1);
    } finally { await dispose(); await ctx.fiber.dispose(); }
});
