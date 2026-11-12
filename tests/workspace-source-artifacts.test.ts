/** Real official source attachment storage/receipts; source grant checks and generated reader are explicit boundaries. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceAttachments } from '../src/workspace/source-attachments.ts';
import { CodexUploads } from '../src/remote/codex-uploads.ts';
import type { CodexAccessBridge } from '../src/remote/codex-access-bridge.ts';
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceDocumentService } from '../src/workspace/service-types.ts';
import { sourceWorkspaceInputs, SOURCE_WORKSPACE_REMOTE } from '../src/workspace/source-api.ts';

const binding: WorkspaceBinding = { target: { hostId: 'local', sessionId: 'hhpi:machine:source:codex:thread' }, machineId: 'machine', workspaceId: 'source', root: '/source', pathStyle: 'posix' };
async function fixture(t: test.TestContext) {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-source-artifacts-'), ctx = new Context(), signal = new AbortController();
    t.after(async () => { signal.abort(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
    let allowed = true;
    const access: WorkspaceAccess = { scope: 'account', signal: signal.signal, assertAllowed(target) { assert.deepEqual(target, binding.target); if (!allowed) throw new Error('Source grant revoked'); } };
    const owner = new SourceAttachments(ctx, { directory: join(directory, 'attachments'), receipts: join(directory, 'receipts'), async generated(_binding, id) {
        if (id !== 'accepted-image') throw new Error('This media was never admitted by the native transcript');
        return { data: new Uint8Array([0,255,1]), name: '生成 图片', mimeType: 'image/png', version: 'accepted-version' };
    } });
    const fallback = { open() { throw new Error('No display filesystem fallback'); }, bytes() { throw new Error('No display filesystem fallback'); } } as unknown as WorkspaceDocumentService;
    const documents = owner.documents(binding, fallback);
    const upload = async (name: string, data: Uint8Array, mimeType = 'application/octet-stream') => {
        const operationId = crypto.randomUUID(), staging = join(directory, `${operationId}.bin`); await writeFile(staging, data);
        const result = await owner.commit(binding, { target: binding.target, operationId, destination: { kind: 'attachment', name }, bytes: data.length, mimeType }, staging, access);
        assert.equal(result.status, 'applied'); if (result.status !== 'applied' || result.value.kind !== 'attachment') throw new Error('Expected exact source attachment');
        return { operationId, resource: result.value.resource, value: result.value.value };
    };
    return { directory, owner, documents, access, upload, revoke() { allowed = false; } };
}

test('extensionless PDF and Unicode attachment names resolve from immutable source receipts', async t => {
    const f = await fixture(t), bytes = Buffer.from('%PDF-1.7\nexact source\n'), uploaded = await f.upload('报告 空格', bytes);
    const metadata = await f.documents.open(uploaded.resource.document, f.access);
    assert.equal(metadata.mimeType, 'application/pdf'); assert.equal(metadata.fileName, '报告 空格'); assert.equal(metadata.text, null); assert.equal(metadata.writable, false);
    const body = await f.documents.bytes(uploaded.resource.document, {}, f.access);
    assert.deepEqual(Buffer.from(body.data), bytes); assert.equal(body.absolutePath, '');
    const codec = SOURCE_WORKSPACE_REMOTE.descriptors.find(value => value.method === 'readDocumentBytes')!.result;
    assert.equal(codec.mode, 'strict'); if (codec.mode === 'strict') assert.doesNotThrow(() => codec.create().parse(body));
    if (!('file' in uploaded.value)) throw new Error('Expected file reference');
    const id = `attachment:${encodeURIComponent(uploaded.value.file.attachmentId)}/${encodeURIComponent(uploaded.value.file.name)}`;
    assert.equal((await f.documents.open({ kind: 'artifact', id }, f.access)).fileName, metadata.fileName);
    assert.deepEqual(Buffer.from((await f.documents.bytes({ kind: 'artifact', id }, { range: { offset: 2, length: 5 } }, f.access)).data), bytes.subarray(2, 7));
})

test('binary formats remain downloadable and receipt/grant failures never fall back to source or display paths', async t => {
    const f = await fixture(t), original = new Uint8Array([0,255,128,13,10]), uploaded = await f.upload('归档 无扩展名', original);
    const metadata = await f.documents.open(uploaded.resource.document, f.access); assert.equal(metadata.text, null);
    assert.deepEqual((await f.documents.bytes(uploaded.resource.document, {}, f.access)).data, original);
    const another = f.owner.documents({ ...binding, target: { ...binding.target, sessionId: 'hhpi:machine:source:codex:another' } }, {} as WorkspaceDocumentService);
    await assert.rejects(another.open(uploaded.resource.document, { ...f.access, assertAllowed() {} }), /another source session/);
    await assert.rejects(f.documents.open({ kind: 'artifact', id: '/source/guess' }, f.access), /unavailable/);
    f.revoke(); await assert.rejects(f.documents.open(uploaded.resource.document, f.access), /revoked/); await assert.rejects(f.documents.bytes(uploaded.resource.document, {}, f.access), /revoked/);
})

test('generated media uses its admitted source reader and refuses unregistered references and cancellation', async t => {
    const f = await fixture(t), document = { kind: 'generated-media' as const, id: 'accepted-image' };
    assert.equal((await f.documents.open(document, f.access)).fileName, '生成 图片');
    assert.deepEqual((await f.documents.bytes(document, {}, f.access)).data, new Uint8Array([0,255,1]));
    await assert.rejects(f.documents.open({ ...document, id: '/not/admitted/image.png' }, f.access), /never admitted/);
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(f.documents.open(document, { ...f.access, signal: cancelled.signal }));
})

test('only an original native operation plus exact admitted receipt input can project an uploaded file', async t => {
    const f = await fixture(t), uploaded = await f.upload('原文件.txt', Buffer.from('exact file'));
    const native = { call() { throw new Error('Association and preview must never dispatch an Agent command'); } } as unknown as CodexAccessBridge;
    const uploads = new CodexUploads(join(f.directory, 'receipts'), native), operationId = crypto.randomUUID();
    await uploads.associate(binding.target.sessionId, operationId, [uploaded.operationId]);
    const [input] = await uploads.inputs(binding.target.sessionId, [uploaded.operationId]);
    const item = { id: 'native-item', type: 'userMessage', clientId: operationId, content: [input, { type: 'text', text: 'my task' }] };
    const restored = new CodexUploads(join(f.directory, 'receipts'), native), content = restored.content(binding.target.sessionId, item);
    assert.equal(content?.[0]?.type, 'file'); assert.deepEqual(content?.[0]?.type === 'file' && content[0].attachment, 'file' in uploaded.value && uploaded.value.file);
    assert.equal(restored.content('another-session', item), undefined);
    assert.equal(restored.content(binding.target.sessionId, { ...item, clientId: 'not-original' }), undefined);
    assert.equal(restored.content(binding.target.sessionId, { ...item, content: [{ type: 'text', text: 'Attached file "other": "/secret"' }] }), undefined);
    await assert.rejects(uploads.associate(binding.target.sessionId, operationId, []), /different uploaded attachments/);
    assert.equal(sourceWorkspaceInputs.uploadInputs.safeParse({ sessionId: binding.target.sessionId, receiptIds: [uploaded.operationId], clientUserMessageId: operationId }).success, true);
})
