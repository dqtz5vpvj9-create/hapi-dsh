import { CodexUploads } from '../src/remote/codex-uploads.ts';
import { randomUUID } from 'node:crypto';
/** Production native carrier/ledger; only Codex RPC is synthetic. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAccessBridge } from '../src/remote/codex-access-bridge.ts';
import { CodexRpcError, type CodexRpc, type NativeNotification, type NativeRequest } from '../src/remote/codex-rpc.ts';
import { SourceError } from '../src/remote/errors.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import type { SourceAdapter } from '../src/remote/protocol.ts';

async function fixture(t: test.TestContext) {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-native-access-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const notifications = new Set<(value: NativeNotification) => void>(), requests = new Set<(value: NativeRequest) => void>(), disconnects = new Set<() => void>();
    const calls: Array<{ method: string; params: unknown; write?: boolean }> = [];
    let behavior: () => unknown = () => ({ secret: 'fixture-only-token' });
    const rpc = { currentGeneration: 1, online: true,
        connect: async () => ({ userAgent: 'synthetic Codex 0.165.0' }),
        onNotification: (listener: (value: NativeNotification) => void) => { notifications.add(listener); return () => notifications.delete(listener); },
        onRequest: (listener: (value: NativeRequest) => void) => { requests.add(listener); return () => requests.delete(listener); },
        onDisconnect: (listener: () => void) => { disconnects.add(listener); return () => disconnects.delete(listener); },
        request: async (method: string, params: unknown, options: { write?: boolean }) => { calls.push({ method, params, ...options }); return behavior(); },
        respond: async () => { calls.push({ method: '$reply', params: {} }); },
    };
    const make = () => new CodexAccessBridge('source', rpc as unknown as CodexRpc, root, async () => {}, () => {}, async () => ({ status: 'accepted', message: 'owned thread reply' }));
    const bridge = make(); t.after(() => bridge.dispose());
    return { root, bridge, make, calls, rpc, notifications, requests, disconnects, behave: (fn: () => unknown) => { behavior = fn; } };
}

test('native writes are exactly identified, never retried after loss, and do not persist result credentials', async t => {
    const f = await fixture(t);
    const request = { sourceId: 'source', method: 'account/login/start', params: { type: 'fixture' }, operationId: 'same-intent' };
    const first = await f.bridge.call(request);
    assert.deepEqual(first.result, { secret: 'fixture-only-token' });
    assert.deepEqual(await f.bridge.call(request), first);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.bridge.call({ ...request, params: { type: 'different' } }), /reused/);
    const files = await readdir(join(f.root, 'native-operations'));
    for (const name of files.filter(name => name.endsWith('.json'))) assert.ok(!(await readFile(join(f.root, 'native-operations', name), 'utf8')).includes('fixture-only-token'));
    const restarted = f.make(); t.after(() => restarted.dispose());
    assert.equal((await restarted.call(request)).resultUnavailable, true);
    assert.equal(f.calls.length, 1);
    f.behave(() => { throw new SourceError('OUTCOME_UNKNOWN', 'lost acknowledgement'); });
    const uncertain = { ...request, operationId: 'lost' };
    assert.equal((await f.bridge.call(uncertain)).status, 'indeterminate');
    assert.equal((await f.bridge.call(uncertain)).status, 'indeterminate');
    assert.equal(f.calls.length, 2);
});

test('read dispatch is not promoted to write, unsupported methods fail closed, native error data survives', async t => {
    const f = await fixture(t);
    await f.bridge.call({ sourceId: 'source', method: 'model/list', params: {} });
    assert.equal(f.calls[0]?.write, false);
    await assert.rejects(f.bridge.call({ sourceId: 'other-source', method: 'model/list', params: {} }), /another source/);
    await assert.rejects(f.bridge.call({ sourceId: 'source', method: 'made/up', params: {} }), /not exposed/);
    await assert.rejects(f.bridge.call({ sourceId: 'source', method: 'turn/start', params: {} }), /stable operation/);
    f.behave(() => { throw new CodexRpcError(-32600, 'conflict', { reason: 'readStateConflict' }); });
    const result = await f.bridge.call({ sourceId: 'source', method: 'thread/readState/update', operationId: 'conflict', params: {} });
    assert.deepEqual(result.error, { code: -32600, message: 'conflict', data: { reason: 'readStateConflict' } });
});

test('native event overflow announces a reset and stale-generation replies cannot dispatch', async t => {
    const f = await fixture(t), emit = (value: NativeNotification) => { for (const callback of f.notifications) callback(value); };
    let baseline = f.bridge.readEvents({ sourceId: 'source' });
    for (let i = 0; i < 520; i++) emit({ method: 'fixture/update', params: { i } });
    const gap = f.bridge.readEvents({ sourceId: 'source', generation: baseline.generation, after: baseline.cursor });
    assert.equal(gap.reset, true);
    assert.deepEqual(gap.events, []);
    baseline = gap;
    emit({ method: 'fixture/update', params: { i: 521 } });
    assert.equal(f.bridge.readEvents({ sourceId: 'source', generation: baseline.generation, after: baseline.cursor }).events.length, 1);
    for (const callback of f.requests) callback({ id: 4, generation: 1, method: 'account/chatgptAuthTokens/refresh', params: {} });
    const pending = f.bridge.readEvents({ sourceId: 'source' }).pending[0]!;
    f.rpc.currentGeneration = 2; for (const callback of f.disconnects) callback();
    const result = await f.bridge.reply({ sourceId: 'source', requestId: pending.id, operationId: 'old-reply', result: {} });
    assert.equal(result.status, 'rejected'); assert.equal(f.calls.length, 0);
});

test('a session grant cannot invoke source-wide Codex APIs', async t => {
    const f = await fixture(t);
    const adapter = { id: 'source', machineId: 'machine', engine: 'codex', nativeAccess: f.bridge, dispose() {} } as SourceAdapter;
    const gateway = new SourceGateway([adapter], false);
    t.after(() => gateway.dispose());
    assert.throws(() => gateway.nativeAccess('source', grant => grant.kind === 'session'), /not granted/);
    assert.equal(gateway.nativeAccess('source', grant => grant.kind === 'source' && grant.id === 'source'), f.bridge);
});

test('pinned native Codex settings update reaches the original thread and readback confirms it', { skip: !process.env.HHPI_CODEX_TEST_COMMAND, timeout: 30_000 }, async t => {
    const { writeFile } = await import('node:fs/promises');
    const { DirectCodexAdapter } = await import('../src/remote/codex-adapter.ts');
    const { SyntheticResponsesModel } = await import('./fixtures/hhpi/model.ts');
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-native-settings-');
    const model = new SyntheticResponsesModel(); await model.start();
    await writeFile(join(root, 'config.toml'), `${model.config()}\n[features]\nplugins = false\n`);
    const adapter = new DirectCodexAdapter({ id: 'native-settings', machineId: 'fixture', engine: 'codex', command: process.env.HHPI_CODEX_TEST_COMMAND!, args: ['app-server'], codexHome: root, cwd: root, ownership: 'exclusive' }, join(root, 'index'));
    t.after(async () => { await adapter.dispose(); await model.close(); await rm(root, { recursive: true, force: true }); });
    const creation = await adapter.create({ sourceId: adapter.id, operationId: 'create', cwd: root });
    assert.equal(creation.status, 'accepted'); assert.ok(creation.session);
    const id = creation.session.nativeId;
    const update = await adapter.nativeAccess.call({ sourceId: adapter.id, method: 'thread/settings/update', operationId: 'choose-effort', params: { threadId: id, effort: 'high' } });
    assert.equal(update.status, 'accepted', update.message);
    const read = await adapter.nativeAccess.call({ sourceId: adapter.id, method: 'thread/read', params: { threadId: id, includeTurns: false } });
    assert.equal(read.status, 'accepted', read.message);
    const thread = (read.result as { thread: { id: string; reasoningEffort: string } }).thread;
    assert.equal(thread.id, id); assert.equal(thread.reasoningEffort, 'high');
    assert.equal((await adapter.resolve(creation.session.id)).codex?.reasoningEffort, 'high');
    assert.equal(model.calls, 0, 'changing settings must not send a prompt');
    const uploadId = randomUUID();
    const uploaded = await adapter.upload({ sessionId: creation.session.id, operationId: uploadId, name: 'fixture.txt', data: Buffer.from('native file bytes').toString('base64') });
    assert.equal(uploaded.receiptId, uploadId);
    assert.equal(await readFile(join(root, '.hhpi', 'uploads', uploadId, 'attachment-fixture.txt'), 'utf8'), 'native file bytes');
    assert.equal(model.calls, 0, 'uploading must not send a prompt');
    const image = await adapter.operate({ sessionId: creation.session.id, operationId: 'native-image', kind: 'send', files: [uploadId], text: 'Describe this synthetic pixel.', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC' }] });
    assert.equal(image.status, 'accepted', image.message);
});


test('uploaded file receipts survive restart, reject cross-session use, and never resend an uncertain write', async t => {
    const f = await fixture(t);
    const session = { id: 'hhpi:m:source:codex:original', sourceId: 'source', cwd: '/source/work' } as import('../src/remote/protocol.ts').SourceSession;
    const uploads = new CodexUploads(join(f.root, 'uploads'), f.bridge);
    const request = { sessionId: session.id, operationId: randomUUID(), name: '../file.txt', data: Buffer.from('bytes').toString('base64') };
    const result = await uploads.upload(session, request);
    assert.equal(result.file.name, '.._file.txt');
    assert.equal(f.calls.length, 2);
    await uploads.upload(session, request);
    assert.equal(f.calls.length, 2, 'the original native writes must not replay');
    const restarted = new CodexUploads(join(f.root, 'uploads'), f.bridge);
    const input = await restarted.inputs(session.id, [result.receiptId]);
    assert.ok(input[0]?.type === 'text' && input[0].text.includes('/source/work/.hhpi/uploads/'));
    const imageRequest = { ...request, operationId: randomUUID(), name: 'shot.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC' };
    const imageReceipt = await uploads.upload(session, imageRequest);
    const imageInput = await restarted.inputs(session.id, [imageReceipt.receiptId]);
    assert.equal(imageInput[0]?.type, 'localImage', 'staged images retain native vision input rather than a text-only filename');
    await assert.rejects(restarted.inputs('another-session', [result.receiptId]), /another source session/);
    await assert.rejects(uploads.upload({ ...session, id: 'another-session' }, request), /another source session/);
    await assert.rejects(uploads.upload(session, { ...request, data: Buffer.from('different').toString('base64') }), /different arguments/);
    f.behave(() => { throw new Error('connection lost') });
    const uncertain = { ...request, operationId: randomUUID() };
    await assert.rejects(uploads.upload(session, uncertain));
    const count = f.calls.length;
    await assert.rejects(uploads.upload(session, uncertain));
    assert.equal(f.calls.length, count);
    await assert.rejects(uploads.inputs(session.id, [uncertain.operationId]), /unavailable/);
});


test('upload routing checks the addressed session before dispatch and again after completion', async t => {
    const f = await fixture(t);
    let calls = 0, allowed = true;
    const adapter = { id: 'source', machineId: 'machine', engine: 'codex', dispose() {}, async upload() { calls++; allowed = false; return { receiptId: randomUUID(), file: { attachmentId: randomUUID(), name: 'file', bytes: 0 } }; } } as unknown as SourceAdapter;
    const gateway = new SourceGateway([adapter], false); t.after(() => gateway.dispose());
    const request = { sessionId: 'hhpi:machine:source:codex:thread', operationId: randomUUID(), name: 'file', data: '' };
    await assert.rejects(gateway.upload(request, () => false), /not granted/);
    assert.equal(calls, 0);
    await assert.rejects(gateway.upload(request, resource => allowed && resource.kind === 'session' && resource.id === request.sessionId), /not granted/);
    assert.equal(calls, 1);
});
