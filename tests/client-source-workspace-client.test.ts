/** Real source proxy/client/transport; authenticated catalog generation and wire endpoints are explicit fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/types';
import type { SourceWorkspaceApi, SourceWorkspaceDescription } from '../src/workspace/source-api.ts';
import type { WorkspaceDocument, WorkspaceUploadTransfer } from '../src/workspace/service-types.ts';
import { createSourceFileClient, type CapturedWorkspaceAccess } from '../src/client/source-workspace-client.ts';
import { sourceFileAccess, sourceWorkspaceFilesRemote } from '../src/client/source-workspace-provider.ts';
import { deferred } from './source-file-mutation-fixture.ts';

const sessionId = 'hhpi:machine:source:codex:thread';
function fixture(hostId = 'host-one') {
    let scope = 'account-one', generation = 0, lifetime = new AbortController(), text = hostId;
    const requests: Array<{ kind: string; target?: { hostId: string; sessionId: string } }> = [], chunks: string[] = [];
    const description: SourceWorkspaceDescription = { binding: { target: { hostId: 'local', sessionId }, machineId: 'machine', workspaceId: 'workspace', root: '/same-path', pathStyle: 'posix' },
        registered: { files: true, documents: true, mutations: true, uploads: true, terminals: false } };
    let documentGate: Promise<void> | undefined, resolveGate: Promise<void> | undefined;
    const doc = (): WorkspaceDocument => ({ resource: { target: description.binding.target, document: { kind: 'file', path: '/same-path/file' } },
        fileName: 'file', mimeType: 'text/plain', bytes: text.length, version: `version:${text}`, writable: true, text });
    let transfer: WorkspaceUploadTransfer;
    const begin: SourceWorkspaceApi['beginUpload'] = async request => {
        requests.push({ kind: 'begin', target: request.target });
        const value = { uploadId: 'original-upload', target: request.target, operationId: request.operationId, destination: request.destination,
            bytes: request.bytes, receivedBytes: 0, chunkBytes: 1024, maxBytes: 4096 };
        transfer = value; return { ok: true, value };
    };
    const api = {
        async readDocumentBytes() { throw new Error('No document byte request belongs to this wire fixture'); },
        async inspect() { return { ok: true, value: null }; }, async search() { return { ok: true, value: [] }; },
        async git() { return { ok: true, value: { stdout: '', stderr: '', exitCode: 0 } }; },
        async receipt() { return { ok: true, value: null }; },
        async cancelUpload() { return { ok: true, value: { state: 'cancelled' } }; },
        changes() { throw new Error('Install an explicit watch boundary for this test'); },
        async resolve(request) { requests.push({ kind: 'resolve' }); assert.equal(request.sessionId, sessionId); await resolveGate; return { ok: true, value: description }; },
        async openDocument() { requests.push({ kind: 'open' }); const value = doc(); await documentGate; return { ok: true, value }; },
        async read() { return { ok: true, value: { absolutePath: '/same-path/file', version: 'read', offset: 1, text, lines: 1, eof: true } }; },
        async readBytes() { return { ok: true, value: { absolutePath: '/same-path/file', version: 'bytes', offset: 0, data: new Uint8Array([0, 255]), eof: true } }; },
        async stat() { return { ok: true, value: { absolutePath: '/same-path/file', version: text } }; },
        async list() { return { ok: true, value: { path: '/same-path', entries: [], truncated: false } }; },
        async save(request) { requests.push({ kind: 'save', target: request.target }); text = request.text; return { ok: true, value: { status: 'applied', operationId: request.operationId, value: { absolutePath: request.path, version: `version:${text}` } } }; },
        async manage(request) { requests.push({ kind: 'manage', target: request.target }); return { ok: true, value: { status: 'applied', operationId: request.operationId, value: null } }; },
        beginUpload: begin,
        async uploadStatus() { return { ok: true, value: { state: 'uploading', transfer } }; },
        async finishUpload(request) { requests.push({ kind: 'finish', target: request.target }); return { ok: true, value: { status: 'applied', operationId: 'upload-operation',
            value: { kind: 'attachment', resource: { target: request.target, document: { kind: 'artifact', id: 'source-owned' } }, value: { receiptId: crypto.randomUUID() as FileUploadValue['receiptId'], file: { attachmentId: 'source-owned' as FileUploadValue['file']['attachmentId'], name: 'file', bytes: 2 } } } } }; },
    } as SourceWorkspaceApi;
    const authority = { captureWorkspaceAccess(id: string): CapturedWorkspaceAccess {
        assert.equal(id, sessionId); const captured = generation, capturedScope = scope, signal = lifetime.signal;
        return { scope: capturedScope, signal, assertCurrent() { if (captured !== generation) throw new Error('Account generation changed'); signal.throwIfAborted(); } };
    } };
    const fetcher: typeof fetch = async input => { chunks.push(String(input)); return Response.json({ receivedBytes: 2 }); };
    const client = createSourceFileClient(api, authority, { hostId, fetch: fetcher });
    return { client, api, description, requests, chunks, capture: authority.captureWorkspaceAccess,
        swap() { scope = 'account-two'; generation++; lifetime.abort(); lifetime = new AbortController(); },
        documentGate(value: Promise<void>) { documentGate = value; }, resolveGate(value: Promise<void>) { resolveGate = value; } };
}
const signal = () => new AbortController().signal;

test('same-named paths on two Hosts retain actual Host addresses and save only through their original local wire binding', async () => {
    const first = fixture('host-one'), second = fixture('host-two'), a = await first.client.resolve(sessionId, signal()), b = await second.client.resolve(sessionId, signal());
    assert.equal(a.owner.binding.target.hostId, 'host-one'); assert.equal(b.owner.binding.target.hostId, 'host-two');
    assert.equal((await a.services.documents.open({ kind: 'file', path: '/same-path/file' }, sourceFileAccess(a.owner, signal()))).text, 'host-one');
    assert.equal((await b.services.documents.open({ kind: 'file', path: '/same-path/file' }, sourceFileAccess(b.owner, signal()))).resource.target.hostId, 'host-two');
    await a.services.mutations!.save({ target: a.owner.binding.target, operationId: crypto.randomUUID(), path: '/same-path/file', text: 'saved-on-first', baseline: { kind: 'version', version: 'initial' } }, sourceFileAccess(a.owner, signal()));
    assert.deepEqual(first.requests.find(value => value.kind === 'save')?.target, { hostId: 'local', sessionId });
    assert.equal((await a.services.documents.open({ kind: 'file', path: '/same-path/file' }, sourceFileAccess(a.owner, signal()))).text, 'saved-on-first');
    assert.equal((await b.services.documents.open({ kind: 'file', path: '/same-path/file' }, sourceFileAccess(b.owner, signal()))).text, 'host-two');
})

test('account replacement aborts pending resolution and discards late document results even when the wire ignores cancellation', async () => {
    const f = fixture(), gate = deferred<void>(); f.resolveGate(gate.promise);
    const resolving = f.client.resolve(sessionId, signal()); f.swap(); gate.resolve(); await assert.rejects(resolving);
    const next = await f.client.resolve(sessionId, signal()); assert.equal(next.owner.scope, 'account-two');
    const readGate = deferred<void>(); f.documentGate(readGate.promise);
    const opening = next.services.documents.open({ kind: 'file', path: '/same-path/file' }, sourceFileAccess(next.owner, signal()));
    await Promise.resolve(); f.swap(); readGate.resolve(); await assert.rejects(opening);
    const before = f.requests.length; await assert.rejects(next.services.files.stat('/same-path/file', sourceFileAccess(next.owner, signal()))); assert.equal(f.requests.length, before);
})

test('scope and forged Host targets are rejected before sending source writes', async () => {
    const f = fixture(), context = await f.client.resolve(sessionId, signal()), access = sourceFileAccess(context.owner, signal());
    await assert.rejects(context.services.files.stat('/same-path/file', { ...access, scope: 'another-account' }));
    await assert.rejects(context.services.mutations!.manage({ target: { hostId: 'forged', sessionId }, operationId: crypto.randomUUID(), operation: { action: 'create-file', path: '/same-path/new' } }, access));
    assert.equal(f.requests.filter(value => value.kind === 'manage').length, 0);
    assert.equal(Reflect.set(context.owner.binding.target, 'hostId', 'forged'), false);
})

test('uploads use the graph fetch and translate returned transfer and attachment resources to its exact Host', async () => {
    const f = fixture('runner-host'), context = await f.client.resolve(sessionId, signal()), access = sourceFileAccess(context.owner, signal());
    const transfer = await context.services.uploads!.begin({ target: context.owner.binding.target, operationId: 'upload-operation', destination: { kind: 'attachment', name: 'file' }, bytes: 2, mimeType: 'application/octet-stream' }, access);
    assert.equal(transfer.target.hostId, 'runner-host');
    await context.services.uploads!.append({ target: transfer.target, uploadId: transfer.uploadId, offset: 0, data: new Uint8Array([0, 255]) }, access);
    assert.equal(f.chunks.length, 1); assert.match(f.chunks[0]!, /original-upload/);
    const result = await context.services.uploads!.finish({ target: transfer.target, uploadId: transfer.uploadId }, access);
    assert.equal(result.status === 'applied' && result.value.resource.target.hostId, 'runner-host');
    assert.deepEqual(f.requests.find(value => value.kind === 'finish')?.target, { hostId: 'local', sessionId });
})

test('a late applied upload reply keeps the same owner but cannot cross an account replacement', async () => {
    for (const revoked of [false, true]) {
        const f = fixture(), context = await f.client.resolve(sessionId, signal()), access = sourceFileAccess(context.owner, signal())
        const entered = deferred<void>(), reply = deferred<void>(), finish = f.api.finishUpload
        f.api.finishUpload = async (...args) => { const result = await finish(...args); entered.resolve(); await reply.promise; return result }
        const completed = context.services.uploads!.finish({ target: context.owner.binding.target, uploadId: 'original-upload' }, access)
        await entered.promise
        if (revoked) f.swap()
        reply.resolve()
        if (revoked) await assert.rejects(completed)
        else assert.equal((await completed).status, 'applied', 'a delayed same-owner receipt is accepted without replacing its binding')
    }
})

test('resolver cancellation belongs to resolution and does not poison a retained service used by a fresh view', async () => {
    const f = fixture(), resolution = new AbortController(), context = await f.client.resolve(sessionId, resolution.signal); resolution.abort();
    assert.equal((await context.services.files.stat('/same-path/file', sourceFileAccess(context.owner, signal()))).version, 'host-one');
    const caller = new AbortController(); caller.abort(); await assert.rejects(context.services.files.stat('/same-path/file', sourceFileAccess(context.owner, caller.signal)));
})

test('the official Files boundary uses the same guarded source client while ordinary DSH stays on its own face', async () => {
    const f = fixture(), ordinaryCalls: string[] = [], ordinary = { async stat() { ordinaryCalls.push('stat'); return { ok: true, value: { absolutePath: 'native', version: 'native' } }; } };
    const adapter = sourceWorkspaceFilesRemote(ordinary as never, f.api, f.client);
    assert.equal((await adapter.stat(sessionId as SessionId, '/same-path/file')).ok, true);
    const native = await adapter.stat('ordinary' as SessionId, '/same-path/file'); assert.equal(native.ok && native.value.version, 'native'); assert.deepEqual(ordinaryCalls, ['stat']);
    const context = await f.client.resolve(sessionId, signal()); f.swap(); await assert.rejects(context.services.files.stat('/same-path/file', sourceFileAccess(context.owner, signal())));
})

test('file-watch frames arriving after source revocation are discarded and the wire watch is released', async () => {
    const f = fixture(), frame = deferred<void>(); let released = false;
    f.api.changes = () => ({ async *[Symbol.asyncIterator]() {
        try { yield { kind: 'ready' as const }; await frame.promise; yield { kind: 'ready' as const }; }
        finally { released = true; }
    }, send() {}, end() {}, dispose() {} });
    const adapter = sourceWorkspaceFilesRemote({} as never, f.api, f.client), watch = adapter.changes(sessionId as SessionId, '/same-path');
    const iterator = watch[Symbol.asyncIterator](); assert.deepEqual((await iterator.next()).value, { kind: 'ready' });
    const late = iterator.next(); f.swap(); frame.resolve(); await assert.rejects(late); assert.equal(released, true);
    watch.dispose();
})

test('source metadata from another machine or serving Host is rejected before UI ownership is created', async () => {
    const f = fixture(); f.description.binding = { ...f.description.binding, machineId: 'another-machine' };
    await assert.rejects(f.client.resolve(sessionId, signal()));
    f.description.binding = { ...f.description.binding, machineId: 'machine', target: { hostId: 'browser-chosen-host', sessionId } };
    await assert.rejects(f.client.resolve(sessionId, signal()));
})
