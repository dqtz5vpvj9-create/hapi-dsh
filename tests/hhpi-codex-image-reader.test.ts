/** Real CodexRpc/WebSocket framing; only the remote native filesystem and thread are synthetic. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexImageReader, MAX_NATIVE_IMAGE_BYTES } from '../src/remote/codex-image-reader.ts';
import { CodexRpc, type NativeRequest } from '../src/remote/codex-rpc.ts';
import type { DirectCodexConfig } from '../src/remote/protocol.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6foAAAAASUVORK5CYII=';
const metadata = { isFile: true, isDirectory: false, isSymlink: false, createdAtMs: 1, modifiedAtMs: 1 };
interface Peer { socket: WebSocket; methods: string[]; responses: unknown[]; closed: Promise<void> }
interface Boundary {
    metadata?: (path: string, peer: Peer) => unknown;
    readFile?: (path: string, reply: (result: unknown) => void, peer: Peer) => void;
}

async function fixture(t: TestContext, boundary: Boundary = {}) {
    const server = createServer(), sockets = new WebSocketServer({ server }), peers: Peer[] = [];
    sockets.on('connection', socket => {
        const peer: Peer = { socket, methods: [], responses: [], closed: new Promise(resolve => socket.once('close', () => resolve())) };
        peers.push(peer);
        socket.on('error', () => {});
        socket.on('message', bytes => {
            const request = JSON.parse(bytes.toString()) as { id?: string; method: string; params: { path?: string } };
            if (typeof request.method !== 'string') { peer.responses.push(request); return; }
            peer.methods.push(request.method);
            if (!request.id) return;
            const reply = (result: unknown): void => { socket.send(JSON.stringify({ id: request.id, result }), () => {}); };
            if (request.method === 'initialize') reply({ userAgent: 'native-image-fixture', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux' });
            else if (request.method === 'fs/getMetadata') reply(boundary.metadata ? boundary.metadata(request.params.path!, peer) : metadata);
            else if (request.method === 'fs/readFile') {
                if (boundary.readFile) boundary.readFile(request.params.path!, reply, peer);
                else reply({ dataBase64: PNG });
            } else if (request.method === 'thread/read') reply({ text: 'Native text still available' });
            else socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Unexpected synthetic request' } }));
        });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a test TCP port');
    const config: DirectCodexConfig = { id: 'images', machineId: 'fixture', engine: 'codex', ownership: 'shared', endpoint: `ws://127.0.0.1:${address.port}` };
    const shared = new CodexRpc(config, 3000), reader = new CodexImageReader(config, 3000);
    t.after(async () => {
        await reader.dispose(); await shared.dispose();
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    await shared.connect();
    return { reader, shared, peers };
}

test('small native images use a disposable file connection and leave thread ownership untouched', { timeout: 10_000 }, async t => {
    const f = await fixture(t), generation = f.shared.currentGeneration;
    assert.deepEqual(await f.reader.read('/fixture/small.png'), { dataBase64: PNG });
    assert.equal(f.peers.length, 2);
    await f.peers[1]!.closed;
    assert.deepEqual(f.peers[1]!.methods, ['initialize', 'initialized', 'fs/getMetadata', 'fs/readFile']);
    assert.equal(f.shared.online, true);
    assert.equal(f.shared.currentGeneration, generation);
    assert.deepEqual(await f.shared.request('thread/read', { threadId: 'already-running' }), { text: 'Native text still available' });
    assert.ok(f.peers[0]!.methods.every(method => !method.startsWith('fs/')), 'image bytes never enter the thread/approval connection');
});

test('the image connection ignores broadcast server requests while the native owner still responds', { timeout: 10_000 }, async t => {
    const requested = Promise.withResolvers<{ reply: (result: unknown) => void; peer: Peer }>();
    const broadcast = { id: 'synthetic-server-request', method: 'fixture/global-request', params: { synthetic: true } };
    const f = await fixture(t, {
        metadata: (_path, peer) => { peer.socket.send(JSON.stringify(broadcast)); return metadata; },
        readFile: (_path, reply, peer) => { requested.resolve({ reply, peer }); },
    });
    const image = f.reader.read('/fixture/owner.png'); void image.catch(() => {});
    const { reply, peer } = await requested.promise;
    // fs/readFile is an ordered round-trip barrier: the image client has already
    // received the earlier server request and the following metadata response.
    assert.deepEqual(peer.responses, [], 'an image viewer cannot send unsupported/error replies to owner requests');
    const received = Promise.withResolvers<NativeRequest>();
    f.shared.onRequest(value => { received.resolve(value); });
    f.peers[0]!.socket.send(JSON.stringify(broadcast));
    const ownerRequest = await received.promise;
    assert.equal(ownerRequest.method, broadcast.method);
    await f.shared.respond(ownerRequest, { handledBy: 'native-owner' });
    await f.shared.request('thread/read', { threadId: 'already-running' });
    assert.deepEqual(f.peers[0]!.responses, [{ id: broadcast.id, result: { handledBy: 'native-owner' } }]);
    reply({ dataBase64: PNG });
    assert.deepEqual(await image, { dataBase64: PNG });
    await peer.closed;
    assert.deepEqual(peer.responses, []);
    assert.equal(f.shared.online, true);
});

test('a 13 MiB native file after a successful preflight exceeds real framing only on its image connection', { timeout: 10_000 }, async t => {
    const requested = Promise.withResolvers<(result: unknown) => void>();
    const f = await fixture(t, { readFile: (path, reply) => path.endsWith('grown.png') ? requested.resolve(reply) : reply({ dataBase64: PNG }) });
    const generation = f.shared.currentGeneration;
    let disconnects = 0;
    f.shared.onDisconnect(() => { disconnects++; });
    const rejected = assert.rejects(f.reader.read('/fixture/grown.png'), { code: 'TARGET_UNAVAILABLE' });
    const reply = await requested.promise;
    assert.deepEqual(f.peers[1]!.methods, ['initialize', 'initialized', 'fs/getMetadata', 'fs/readFile']);
    // The pinned metadata response supplies no size. Bytes can change after this
    // preflight, so the response must remain isolated even for an apparent image.
    const grown = Buffer.alloc(13 * 1024 * 1024); Buffer.from(PNG, 'base64').copy(grown);
    const response = { dataBase64: grown.toString('base64') };
    assert.ok(Buffer.byteLength(JSON.stringify(response)) > 16 * 1024 * 1024, 'exercise the real transport frame limit');
    reply(response);
    await rejected; await f.peers[1]!.closed;
    assert.equal(disconnects, 0);
    assert.equal(f.shared.online, true);
    assert.equal(f.shared.currentGeneration, generation, 'a hidden shared reconnect must not mask an image failure');
    const text = Promise.withResolvers<unknown>();
    const stop = f.shared.onNotification(value => { if (value.method === 'item/agentMessage/delta') text.resolve(value.params); });
    f.peers[0]!.socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'already-running', delta: 'Text continues after the image' } }));
    assert.deepEqual(await text.promise, { threadId: 'already-running', delta: 'Text continues after the image' });
    stop();
    assert.deepEqual(await f.shared.request('thread/read', { threadId: 'already-running' }), { text: 'Native text still available' });
    assert.deepEqual(await f.reader.read('/fixture/small.png'), { dataBase64: PNG }, 'one failed preview cannot poison later images');
    assert.ok(f.peers[0]!.methods.every(method => !method.startsWith('fs/')));
});

test('an image above the 8 MiB preview budget is rejected even when its base64 still fits an RPC frame', { timeout: 10_000 }, async t => {
    const f = await fixture(t, { readFile: (_path, reply) => reply({ dataBase64: Buffer.alloc(MAX_NATIVE_IMAGE_BYTES + 1).toString('base64') }) });
    await assert.rejects(f.reader.read('/fixture/too-large.png'), { code: 'CAPACITY_EXCEEDED' });
    assert.equal(f.shared.online, true);
});

test('invalid paths and non-file metadata never request native file bytes', { timeout: 10_000 }, async t => {
    const f = await fixture(t, { metadata: () => ({ ...metadata, isFile: false, isDirectory: true }) });
    for (const path of ['relative.png', '/fixture/bad\0.png']) await assert.rejects(f.reader.read(path), { code: 'INVALID_REQUEST' });
    assert.equal(f.peers.length, 1, 'invalid paths must be rejected before connecting');
    await assert.rejects(f.reader.read('/fixture/directory.png'), { code: 'INVALID_REQUEST' });
    assert.deepEqual(f.peers[1]!.methods, ['initialize', 'initialized', 'fs/getMetadata']);
    assert.equal(f.shared.online, true);
});

test('cancellation and retirement close only their active and queued image reads', { timeout: 10_000 }, async t => {
    const twoReads = Promise.withResolvers<void>(), thirdRead = Promise.withResolvers<void>();
    let reads = 0;
    let cancelledPeer: Peer | undefined;
    const f = await fixture(t, { readFile: (path, _reply, peer) => {
        if (path === '/fixture/cancelled.png') cancelledPeer = peer;
        if (++reads === 2) twoReads.resolve();
        if (reads === 3) thirdRead.resolve();
    } });
    const controller = new AbortController();
    const cancelled = assert.rejects(f.reader.read('/fixture/cancelled.png', controller.signal), { name: 'AbortError' });
    const outcomes = ['/fixture/two.png', '/fixture/next.png', '/fixture/queued.png'].map(path => assert.rejects(f.reader.read(path), { code: 'DISPOSED' }));
    await twoReads.promise;
    assert.equal(f.peers.length, 3, 'one shared connection and at most two independent file connections');
    controller.abort(); await cancelled; await cancelledPeer!.closed;
    await thirdRead.promise;
    assert.equal(f.shared.online, true);
    await f.reader.dispose(); await Promise.all(outcomes);
    await Promise.all(f.peers.slice(1).map(peer => peer.closed));
    assert.equal(reads, 3, 'queued work must not start after source retirement');
    assert.equal(f.shared.online, true);
    assert.deepEqual(await f.shared.request('thread/read', { threadId: 'already-running' }), { text: 'Native text still available' });
    await assert.rejects(f.reader.read('/fixture/after-dispose.png'), { code: 'DISPOSED' });
});
