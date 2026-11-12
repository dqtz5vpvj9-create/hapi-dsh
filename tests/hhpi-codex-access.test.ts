import { CodexUploads } from '../src/remote/codex-uploads.ts';
import { randomUUID, createHash } from 'node:crypto';
/** Production native carrier/ledger; only Codex RPC is synthetic. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAccessBridge } from '../src/remote/codex-access-bridge.ts';
import { CodexQueueSteer } from '../src/remote/codex-queue-steer.ts';
import { CodexRpcError, type CodexRpc, type NativeNotification, type NativeRequest } from '../src/remote/codex-rpc.ts';
import { SourceError } from '../src/remote/errors.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import type { SourceAdapter } from '../src/remote/protocol.ts';

async function fixture(t: test.TestContext) {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-native-access-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const notifications = new Set<(value: NativeNotification) => void>(), requests = new Set<(value: NativeRequest) => void>(), disconnects = new Set<() => void>();
    const calls: Array<{ method: string; params: unknown; write?: boolean }> = [];
    let behavior: (method: string, params: unknown) => unknown = () => ({ secret: 'fixture-only-token' });
    const rpc = { currentGeneration: 1, online: true,
        connect: async () => ({ userAgent: 'synthetic Codex 0.165.0' }),
        onNotification: (listener: (value: NativeNotification) => void) => { notifications.add(listener); return () => notifications.delete(listener); },
        onRequest: (listener: (value: NativeRequest) => void) => { requests.add(listener); return () => requests.delete(listener); },
        onDisconnect: (listener: () => void) => { disconnects.add(listener); return () => disconnects.delete(listener); },
        request: async (method: string, params: unknown, options: { write?: boolean }) => { calls.push({ method, params, ...options }); return behavior(method, params); },
        respond: async () => { calls.push({ method: '$reply', params: {} }); },
    };
    const make = (reconcile?: (method: string, params: Record<string, unknown> | null) => Promise<import('../src/remote/codex-access.ts').CodexCallResult | undefined>) => new CodexAccessBridge('source', rpc as unknown as CodexRpc, root, async () => {}, () => {}, async () => ({ status: 'accepted', message: 'owned thread reply' }), reconcile);
    const bridge = make(); t.after(() => bridge.dispose());
    return { root, bridge, make, calls, rpc, notifications, requests, disconnects, behave: (fn: (method: string, params: unknown) => unknown) => { behavior = fn; } };
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
    const gateway = new SourceGateway([adapter]);
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
    const gateway = new SourceGateway([adapter]); t.after(() => gateway.dispose());
    const request = { sessionId: 'hhpi:machine:source:codex:thread', operationId: randomUUID(), name: 'file', data: '' };
    await assert.rejects(gateway.upload(request, () => false), /not granted/);
    assert.equal(calls, 0);
    await assert.rejects(gateway.upload(request, resource => allowed && resource.kind === 'session' && resource.id === request.sessionId), /not granted/);
    assert.equal(calls, 1);
});


const queuedSteerRequest = {
    sourceId: 'source', method: 'hhpi/queue/steer', operationId: 'original-queue-transfer',
    params: { threadId: 'thread', expectedTurnId: 'exact-running-turn', queuedSubmissionId: 'original-native-item',
        clientUserMessageId: 'original-native-client', input: [{ type: 'text', text: 'original input', text_elements: [] }, { type: 'localImage', path: '/source/owned.png' }] },
};
const originalQueuedItem = () => ({ id: queuedSteerRequest.params.queuedSubmissionId, clientUserMessageId: queuedSteerRequest.params.clientUserMessageId, input: structuredClone(queuedSteerRequest.params.input) });

test('queued steering persists the full original input before taking the native item and keeps it visible until body confirmation', async t => {
    const f = await fixture(t);
    let body = false, rows: unknown[] = [originalQueuedItem()];
    const reconcile = async () => body ? { status: 'accepted' as const, message: 'Exact native client ID in history' } : undefined;
    const bridge = f.make(reconcile); t.after(() => bridge.dispose());
    f.behave(async (method, params) => {
        if (method === 'thread/queue/list') return { data: rows, nextCursor: null };
        if (method === 'thread/queue/delete') {
            const names = await readdir(join(f.root, 'queue-steer-inputs'));
            const saved = await readFile(join(f.root, 'queue-steer-inputs', names.find(name => name.endsWith('.json'))!), 'utf8');
            assert.ok(saved.includes('original input') && saved.includes('/source/owned.png'), 'full exact input is durable before removal');
            rows = []; return { deleted: true };
        }
        if (method === 'turn/steer') {
            assert.deepEqual(params, { threadId: 'thread', expectedTurnId: 'exact-running-turn', clientUserMessageId: 'original-native-client', input: queuedSteerRequest.params.input });
            return { turnId: 'exact-running-turn' };
        }
        throw new Error(`Unexpected native method ${method}`);
    });
    assert.equal((await bridge.capabilities()).methods['hhpi/queue/steer'], 'write');
    assert.equal((await bridge.call(queuedSteerRequest)).status, 'accepted');
    const list = () => bridge.call({ sourceId: 'source', method: 'hhpi/queue/list', params: { threadId: 'thread' } });
    assert.deepEqual((await list()).result, { data: [{ ...originalQueuedItem(), hhpiDelivery: 'sending' }], nextCursor: null });
    assert.deepEqual((await bridge.call({ sourceId: 'source', method: 'thread/queue/list', params: { threadId: 'thread' } })).result, { data: [], nextCursor: null }, 'the original native RPC does not contain adapter-held rows');
    const restarted = f.make(reconcile); t.after(() => restarted.dispose());
    assert.equal((await restarted.call(queuedSteerRequest, true)).status, 'accepted');
    assert.equal(f.calls.filter(call => call.method === 'turn/steer').length, 1, 'restart reads the original child receipt');
    body = true;
    assert.deepEqual((await list()).result, { data: [], nextCursor: null });
    assert.equal((await bridge.call(queuedSteerRequest)).status, 'accepted');
    assert.equal(f.calls.filter(call => call.write).length, 2);
});

test('native consumption between the exact read and deletion cannot send the queued input a second time', async t => {
    const f = await fixture(t);
    let body = false, unavailable = false, rows: unknown[] = [originalQueuedItem()];
    const bridge = f.make(async () => body ? { status: 'accepted', message: 'Consumed by native queue' } : undefined); t.after(() => bridge.dispose());
    f.behave(method => {
        if (method === 'thread/queue/list') return { data: rows, nextCursor: null };
        if (method === 'thread/queue/delete') { rows = []; return { deleted: false }; }
        throw new Error(`Unexpected native method ${method}`);
    });
    assert.equal((await bridge.call(queuedSteerRequest)).status, 'rejected');
    assert.equal(f.calls.filter(call => call.method === 'turn/steer').length, 0);
    const restarted = f.make(async () => { if (unavailable) throw new SourceError('TARGET_UNAVAILABLE', 'Superseded live body observation'); return body ? { status: 'accepted', message: 'Consumed by native queue' } : undefined }); t.after(() => restarted.dispose());
    assert.equal((await restarted.call(queuedSteerRequest, true)).status, 'rejected', 'deleted=false survives sanitized receipt persistence');
    unavailable = true;
    assert.equal((await restarted.call(queuedSteerRequest, true)).status, 'rejected', 'an unavailable body read never becomes accepted or a second send');
    const view = { sourceId: 'source', method: 'hhpi/queue/list', params: { threadId: 'thread' } };
    assert.deepEqual((await restarted.call(view)).result, { data: [{ ...originalQueuedItem(), hhpiDelivery: 'confirming' }], nextCursor: null }, 'the retained original remains visible while body confirmation is unavailable');
    unavailable = false; body = true;
    assert.deepEqual((await restarted.call(view)).result, { data: [], nextCursor: null }, 'exact body confirmation retires the retained occurrence');
    assert.equal((await restarted.call(queuedSteerRequest, true)).status, 'accepted');
    assert.equal(f.calls.filter(call => call.write).length, 1);
});

for (const missing of ['delete', 'steer'] as const) test(`unknown queued ${missing} remains visible and restart/recheck never retries a write`, async t => {
    const f = await fixture(t);
    let body = false, unavailable = false, rows: unknown[] = [originalQueuedItem()];
    const reconcile = async () => { if (unavailable) throw new SourceError('TARGET_UNAVAILABLE', 'Superseded live body observation'); return body ? { status: 'accepted' as const, message: 'Exact original input in history' } : undefined };
    const bridge = f.make(reconcile); t.after(() => bridge.dispose());
    f.behave(method => {
        if (method === 'thread/queue/list') return { data: rows, nextCursor: null };
        if (method === 'thread/queue/delete') { rows = []; if (missing === 'delete') throw new SourceError('OUTCOME_UNKNOWN', 'Lost deletion response'); return { deleted: true }; }
        if (method === 'turn/steer') throw new SourceError('OUTCOME_UNKNOWN', 'Lost steer response');
        throw new Error(`Unexpected native method ${method}`);
    });
    assert.equal((await bridge.call(queuedSteerRequest)).status, 'indeterminate');
    const writes = f.calls.filter(call => call.write).length;
    const restarted = f.make(reconcile); t.after(() => restarted.dispose());
    assert.equal((await restarted.call(queuedSteerRequest, true)).status, 'indeterminate');
    assert.equal((await restarted.call({ ...queuedSteerRequest, operationId: 'another-click' })).status, 'indeterminate');
    unavailable = true;
    assert.equal((await restarted.call(queuedSteerRequest, true)).status, 'indeterminate');
    const page = await restarted.call({ sourceId: 'source', method: 'hhpi/queue/list', params: { threadId: 'thread' } });
    assert.deepEqual(page.result, { data: [{ ...originalQueuedItem(), hhpiDelivery: 'confirming' }], nextCursor: null });
    assert.equal((await restarted.call({ sourceId: 'source', method: 'thread/queue/update', operationId: 'stale-edit', params: { threadId: 'thread', queuedSubmissionId: 'original-native-item', input: [{ type: 'text', text: 'unsafe replacement' }] } })).status, 'rejected');
    assert.equal(f.calls.filter(call => call.write).length, writes);
    unavailable = false; body = true;
    assert.equal((await restarted.call(queuedSteerRequest, true)).status, 'accepted');
    assert.equal(f.calls.filter(call => call.write).length, writes);
});

test('a definitely changed turn restores the original native parts and client alias once', async t => {
    const f = await fixture(t);
    let rows: unknown[] = [originalQueuedItem()], steerAttempts = 0;
    const bridge = f.make(async () => undefined); t.after(() => bridge.dispose());
    f.behave((method, params) => {
        if (method === 'thread/queue/list') return { data: rows, nextCursor: null };
        if (method === 'thread/queue/delete') { rows = []; return { deleted: true }; }
        if (method === 'turn/steer') { if (++steerAttempts === 1) throw new CodexRpcError(-32600, 'Expected turn changed'); return { turnId: 'new-running-turn' }; }
        if (method === 'thread/queue/update') { rows = [{ ...originalQueuedItem(), id: 'restored-native-item', input: (params as { input: unknown[] }).input }]; return { queuedSubmission: rows[0] }; }
        if (method === 'thread/queue/add') {
            assert.deepEqual(params, { threadId: 'thread', clientUserMessageId: 'original-native-client', input: queuedSteerRequest.params.input });
            rows = [{ ...originalQueuedItem(), id: 'restored-native-item' }];
            return { queuedSubmission: rows[0] };
        }
        throw new Error(`Unexpected native method ${method}`);
    });
    const response = await bridge.call(queuedSteerRequest);
    assert.equal(response.status, 'rejected');
    assert.deepEqual(response.result, { queueRestored: true });
    assert.equal((await bridge.call(queuedSteerRequest, true)).status, 'rejected');
    assert.deepEqual((await bridge.call({ sourceId: 'source', method: 'hhpi/queue/list', params: { threadId: 'thread' } })).result, { data: rows, nextCursor: null });
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
    const restarted = f.make(async () => undefined); t.after(() => restarted.dispose());
    const input = [{ type: 'text', text: 'edited after restoration', text_elements: [] }, queuedSteerRequest.params.input[1]!];
    assert.equal((await restarted.call({ sourceId: 'source', method: 'thread/queue/update', operationId: 'edit-restored', params: { threadId: 'thread', queuedSubmissionId: 'restored-native-item', input } })).status, 'accepted');
    // Reproduce the adverse journal iteration order, rather than relying on an
    // accidental filesystem/hash order that projects the successor first.
    const claimHash = (operationId: string) => createHash('sha256').update(JSON.stringify(['source', operationId])).digest('hex');
    let successor = 'steer-restored', suffix = 0;
    while (claimHash(successor) < claimHash(queuedSteerRequest.operationId)) successor = `steer-restored-${++suffix}`;
    assert.equal((await restarted.call({ ...queuedSteerRequest, operationId: successor, params: { ...queuedSteerRequest.params, queuedSubmissionId: 'restored-native-item', expectedTurnId: 'new-running-turn', input } })).status, 'accepted');
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1, 'restored original is not enqueued again when edited/steered after restart');
    assert.equal(steerAttempts, 2);
    const finalView = { data: [{ id: 'restored-native-item', clientUserMessageId: 'original-native-client', input, hhpiDelivery: 'sending' }], nextCursor: null };
    assert.deepEqual((await restarted.call({ sourceId: 'source', method: 'hhpi/queue/list', params: { threadId: 'thread' } })).result, finalView,
        'confirmed restoration hands off to its successor claim instead of resurrecting the old native ID');
    const afterSecondRestart = f.make(async () => undefined); t.after(() => afterSecondRestart.dispose());
    assert.deepEqual((await afterSecondRestart.call({ sourceId: 'source', method: 'hhpi/queue/list', params: { threadId: 'thread' } })).result, finalView);
});


for (const point of ['before-delete', 'before-steer'] as const) test(`queued transfer crash ${point} exposes an explicit continuation without replaying attempted steps`, async t => {
    const f = await fixture(t);
    let rows: unknown[] = [originalQueuedItem()];
    const bridge = f.make(async () => undefined); t.after(() => bridge.dispose());
    f.behave(method => {
        if (method === 'thread/queue/list') return { data: rows, nextCursor: null };
        if (method === 'thread/queue/delete') { rows = []; return { deleted: true }; }
        if (method === 'turn/steer') return { turnId: 'exact-running-turn' };
        throw new Error(`Unexpected native method ${method}`);
    });
    // Only the transport boundary simulates abrupt process loss, before it creates
    // a native attempt marker. The production claim and child ledgers stay real.
    const first = new CodexQueueSteer('source', f.root, async (request, lookup) => {
        if (!lookup && request.method === (point === 'before-delete' ? 'thread/queue/delete' : 'turn/steer')) throw new Error('fixture process crashed before native attempt');
        return bridge.call(request, lookup, undefined, true);
    }, async () => false);
    await assert.rejects(first.run(queuedSteerRequest, false), /process crashed/);
    const writes = f.calls.filter(call => call.write).length;
    assert.equal(writes, point === 'before-delete' ? 0 : 1);
    const restarted = f.make(async () => undefined); t.after(() => restarted.dispose());
    assert.equal((await restarted.call(queuedSteerRequest, true)).status, 'indeterminate');
    const page = await restarted.call({ sourceId: 'source', method: 'hhpi/queue/list', params: { threadId: 'thread' } });
    const held = (page.result as { data: Array<Record<string, unknown>> }).data[0]!;
    assert.equal(held.hhpiResumeOperationId, queuedSteerRequest.operationId);
    assert.equal(held.hhpiResumeTurnId, 'exact-running-turn');
    assert.equal(held.hhpiDelivery, undefined, 'never-attempted steps are actionable, not permanently confirming');
    assert.equal(f.calls.filter(call => call.write).length, writes, 'page restore and receipt lookup are read-only');
    const resumed = { ...queuedSteerRequest, operationId: 'explicit-continue', params: { ...queuedSteerRequest.params, resumeOperationId: queuedSteerRequest.operationId } };
    assert.equal((await restarted.call(resumed)).status, 'accepted');
    assert.equal((await restarted.call(resumed, true)).status, 'accepted');
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/delete').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'turn/steer').length, 1);
});
