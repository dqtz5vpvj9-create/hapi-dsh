/** Real source files/receipts/plans; only native execution is replaced. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { CodexUploads, registerStoredCodexUpload } from '../src/remote/codex-uploads.ts';
import { CodexAccessBridge } from '../src/remote/codex-access-bridge.ts';
import { CodexQueueSteer } from '../src/remote/codex-queue-steer.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';
import type { NativeUploadedPart } from '../src/remote/codex-presentation.ts';
import { nativeImageGroup, nativeUploadedContent } from '../src/remote/codex-presentation.ts';
import type { ImageUploadValue } from '@deepseek-ai/dsh-client-file-upload/types';
import { prepareNativeImage } from '../src/remote/codex-image-pages.ts';

async function fixture(t: test.TestContext) {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-image-pages-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sessionId = 'hhpi:machine:source:codex:owned', operationId = randomUUID();
    const uploads = new CodexUploads(directory, {} as CodexAccessBridge, true), receipts: string[] = [];
    for (let i = 0; i < 2; i++) {
        const data = await sharp({ create: { width: 40, height: 6100, channels: 3, background: i ? '#25a9ef' : '#f05821' } }).jpeg().toBuffer();
        const path = join(directory, `original-${i}.jpg`); await writeFile(path, data);
        const receiptId = randomUUID(), sha = createHash('sha256').update(data).digest('hex'); receipts.push(receiptId);
        await registerStoredCodexUpload(directory, receiptId, { sessionId, path, name: `image-${i}.jpg`, bytes: data.length, image: true,
            value: { receiptId, image: { attachmentId: `sha256:${sha}`, mediaType: 'image/jpeg', width: 40, height: 6100, bytes: data.length, name: `image-${i}.jpg` } } as ImageUploadValue });
    }
    const parts = (): NativeUploadedPart[] => {
        const db = new DatabaseSync(join(directory, 'attachment-associations.sqlite'));
        try { return JSON.parse((db.prepare('SELECT parts FROM native_upload_operation WHERE session_id=? AND operation_id=?').get(sessionId, operationId) as { parts: string }).parts); }
        finally { db.close(); }
    };
    return { directory, sessionId, operationId, uploads, receipts, parts };
}
async function nativeInput(parts: NativeUploadedPart[]): Promise<Record<string, unknown>[]> {
    return Promise.all(parts.flatMap(part => part.imagePlan!.pages).map(async page => ({ type: 'image', url: `data:image/webp;base64,${(await readFile(page.path)).toString('base64')}` })));
}

test('new image plans preserve width, overlap, original admission and exact retry bytes; legacy associations stay unchanged', async t => {
    const f = await fixture(t), input = await f.uploads.associate(f.sessionId, f.operationId, f.receipts), parts = f.parts();
    assert.equal(input.length, 2); assert(input.every(part => part.type === 'localImage' && !('detail' in part)));
    for (const part of parts) {
        assert.deepEqual(part.imagePlan!.pages.map(({ x,y,width,height }) => ({ x,y,width,height })), [{ x:0,y:0,width:40,height:6000 }, { x:0,y:5872,width:40,height:228 }]);
        const original = await sharp(part.input.type === 'localImage' ? part.input.path : '').metadata(); assert.equal(original.height, 6100);
    }
    const params = { clientUserMessageId: f.operationId, input }, admitted = JSON.stringify(params);
    const dispatch = await f.uploads.dispatch(f.sessionId, params);
    assert.equal(JSON.stringify(params), admitted); assert.equal((dispatch.input as unknown[]).length, 4);
    assert((dispatch.input as Record<string, unknown>[]).every(part => part.detail === 'original'));
    const restarted = new CodexUploads(f.directory, {} as CodexAccessBridge, true);
    assert.deepEqual(await restarted.associate(f.sessionId, f.operationId, f.receipts), input);
    assert.deepEqual(await restarted.dispatch(f.sessionId, params), dispatch);
    await assert.rejects(restarted.associate(f.sessionId, f.operationId, [...f.receipts].reverse()), /different uploaded attachments/);
    await assert.rejects(restarted.associate('other', f.operationId, f.receipts), /another source session/);
    const legacy = randomUUID(), old = new CodexUploads(f.directory, {} as CodexAccessBridge);
    assert.deepEqual(await old.associate(f.sessionId, legacy, f.receipts), input);
    assert.deepEqual(await restarted.associate(f.sessionId, legacy, f.receipts), input);
    assert.deepEqual(await restarted.dispatch(f.sessionId, { ...params, clientUserMessageId: legacy }), { ...params, clientUserMessageId: legacy });
    await writeFile(parts[0]!.imagePlan!.pages[0]!.path, 'modified');
    await assert.rejects(restarted.dispatch(f.sessionId, params), /retained model image page changed/);
});

test('only complete same-session ordered native bytes coalesce to originals and compact source references', async t => {
    const f = await fixture(t); await f.uploads.associate(f.sessionId, f.operationId, f.receipts);
    const parts = f.parts(), input = await nativeInput(parts), row = { id: 'native-queue', clientUserMessageId: f.operationId, input };
    const projected = f.uploads.queueRow(f.sessionId, row) as typeof row & { presentationContent: unknown[] };
    assert.equal(projected.presentationContent.length, 2); assert.equal(projected.input.length, 4);
    assert(projected.input.every(part => part.type === 'localImage' && part.detail === 'original'));
    assert(input.every(part => part.type === 'image')); assert(JSON.stringify(projected).length < 4000);
    const item = { id: 'body', type: 'userMessage', clientId: f.operationId, content: input };
    assert.deepEqual(f.uploads.content(f.sessionId, item), parts.map(part => ({ type: 'image', attachment: part.value && 'image' in part.value ? part.value.image : null })));
    assert.equal(f.uploads.content('other', item), undefined);
    const original = parts[0]!.value!;
    assert('image' in original);
    const resource = await f.uploads.imageResource(f.sessionId, `attachment:${original.image.attachmentId}`);
    assert.deepEqual(resource?.attachment, original.image);
    assert.equal(createHash('sha256').update(Buffer.from(resource!.content, 'base64')).digest('hex'), original.image.attachmentId.slice(7));
    assert.equal(await f.uploads.imageResource('other', `attachment:${original.image.attachmentId}`), undefined);
    assert.equal(await f.uploads.imageResource(f.sessionId, '/source/path'), undefined);
    assert.deepEqual(f.uploads.content(f.sessionId, { ...item, content: [...input.slice(0, 2), { type: 'text', text: 'between originals' }, ...input.slice(2), { type: 'text', text: 'after images' }] })?.map(block => block.type === 'text' ? block.text : block.type),
        ['image', 'between originals', 'image', 'after images']);
    assert.equal(nativeImageGroup([...input].reverse(), 0, parts[0]!), false);
    const replaced = structuredClone(input); replaced[0] = { ...input[0], url: input[2]!.url };
    assert.equal(nativeImageGroup(replaced, 0, parts[0]!), false);
    const reverted = await f.uploads.dispatch(f.sessionId, { clientUserMessageId: f.operationId, input: projected.input });
    assert.deepEqual(reverted.input, projected.input);
    let writes = 0;
    for (const altered of [[...input].reverse(), replaced]) {
        const steer = new CodexQueueSteer('source', join(f.directory, randomUUID()), async request => {
            if (request.method !== 'thread/queue/list') { writes++; throw new Error('Changed image input must not dispatch'); }
            return { status: 'accepted', message: 'queue', result: { data: [f.uploads.queueRow(f.sessionId, { ...row, input: altered })], nextCursor: null } };
        }, async () => false);
        const outcome = await steer.run({ sourceId: 'source', method: 'hhpi/queue/steer', operationId: randomUUID(), params: {
            threadId: 'owned', expectedTurnId: 'running', queuedSubmissionId: row.id, clientUserMessageId: f.operationId, input: projected.input } }, false);
        assert.equal(outcome.status, 'rejected');
    }
    assert.equal(writes, 0);
});

test('native dispatch derivatives do not mutate the receipt fingerprint, including a restarted lookup', async t => {
    const f = await fixture(t); const original = await f.uploads.associate(f.sessionId, f.operationId, f.receipts);
    const calls: unknown[] = [], rpc = { currentGeneration: 1, onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (_method: string, params: unknown) => { calls.push(params); return { queuedSubmission: { id: 'native', clientUserMessageId: f.operationId } }; } } as unknown as CodexRpc;
    const make = () => new CodexAccessBridge('source', rpc, f.directory, async (_method, params) => f.uploads.dispatch(f.sessionId, params!), () => {}, async () => ({ status: 'accepted', message: 'unused' }));
    const bridge = make(); t.after(() => bridge.dispose());
    const request = { sourceId: 'source', operationId: f.operationId, method: 'thread/queue/add', params: { threadId: 'owned', clientUserMessageId: f.operationId, input: original } };
    const saved = JSON.stringify(request);
    assert.equal((await bridge.call(request)).status, 'accepted'); assert.equal(JSON.stringify(request), saved);
    assert.equal((calls[0] as { input: unknown[] }).input.length, 4);
    const restarted = make(); t.after(() => restarted.dispose());
    assert.equal((await restarted.call(request, true)).status, 'accepted'); assert.equal((await restarted.call(request)).status, 'accepted');
    assert.equal(calls.length, 1);
});

test('derived pages use EXIF display coordinates while the original stays unchanged', async t => {
    const f = await fixture(t), path = join(f.directory, 'rotated.jpg');
    const data = await sharp({ create: { width: 20, height: 6100, channels: 3, background: '#f49325' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    await writeFile(path, data);
    const plan = await prepareNativeImage(f.directory, ['rotated'], path);
    assert.equal(plan.width, 6100); assert.equal(plan.height, 20);
    assert.deepEqual(plan.pages.map(({ x, y, width, height }) => ({ x, y, width, height })), [{ x:0,y:0,width:6000,height:20 }, { x:5872,y:0,width:228,height:20 }]);
    const page = await sharp(plan.pages[0]!.path).metadata(); assert.equal(page.width, 6000); assert.equal(page.height, 20);
    assert.deepEqual(await readFile(path), data);
});

test('a legacy file still maps when the existing reader prepares an unmanaged image', () => {
    const input = { type: 'text' as const, text: 'Attached file "notes": "/source/notes"', text_elements: [] as never[] };
    const file = { attachmentId: 'notes' as never, bytes: 5, name: 'notes' };
    const preview = { type: 'image' as const, attachment: { attachmentId: 'preview' as never, bytes: 1, width: 1, height: 1, mediaType: 'image/png' as const } };
    const item = { id: 'legacy-mixed', type: 'userMessage', content: [input, { type: 'image', url: 'unmanaged-native-image' }] };
    assert.equal(nativeUploadedContent(item, [{ input, value: { receiptId: 'old' as never, file } }]), undefined);
    assert.deepEqual(nativeUploadedContent(item, [{ input, value: { receiptId: 'old' as never, file } }], [{ type: 'text', text: input.text }, preview]), [{ type: 'file', attachment: file }, preview]);
});
