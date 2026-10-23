import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { COMPRESSED_STREAM_PATH, mountCompressedStream, type StreamCarrierServices } from '../src/shared/compressed-stream.ts';

async function fixture(t: TestContext) {
    let origin = '', calls = 0;
    const audience = 'https://workspace.example';
    let upgrade: Parameters<StreamCarrierServices['webServer']['registerUpgrade']>[0]['handler'] | undefined;
    const server = createServer(), source = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
        if (request.url === COMPRESSED_STREAM_PATH && upgrade) { upgrade(request, socket, head); return; }
        if (request.url !== '/api/remote.mux' || request.headers.cookie !== 'fixture=allowed' || request.headers.origin !== audience || request.headers.host !== 'workspace.example') {
            socket.end('HTTP/1.1 401 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
        }
        calls++;
        source.handleUpgrade(request, socket, head, peer => source.emit('connection', peer, request));
    });
    const dispose = mountCompressedStream({ webServer: { getOrigin: () => origin,
        registerUpgrade(route) { upgrade = route.handler; return () => { upgrade = undefined; }; } },
        connection: { requestRejection: request => request.headers.cookie === 'fixture=allowed' && request.headers.origin === audience && request.headers.host === 'workspace.example' ? undefined : 403 } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
    t.after(async () => { dispose(); for (const peer of source.clients) peer.terminate(); source.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
    return { source, get calls() { return calls; }, open: (authorized = true, sameOrigin = true) => new WebSocket(`${origin.replace('http:', 'ws:')}${COMPRESSED_STREAM_PATH}`, {
        headers: { host: 'workspace.example', ...(authorized ? { cookie: 'fixture=allowed' } : {}), origin: sameOrigin ? audience : 'https://untrusted.invalid' } }) };
}

test('compressed carrier delivers every original byte in order, including initial frames and binary uplink', async t => {
    const env = await fixture(t), text = JSON.stringify({ type: 'baseline', value: Array(5000).fill({ title: '会话状态', pendingRequests: [], seq: 24 }) });
    let received: Buffer | undefined, client: WebSocket | undefined;
    env.source.on('connection', (peer: WebSocket) => {
        client = peer; peer.send(text); peer.send('tail');
        peer.on('message', (data, binary) => { assert.equal(binary, true); received = Buffer.from(data as Buffer); peer.send(data, { binary }); });
    });
    const peer = env.open(), messages: Array<{ bytes: Buffer; binary: boolean }> = [];
    peer.on('message', (bytes, binary) => messages.push({ bytes: Buffer.from(bytes as Buffer), binary }));
    await once(peer, 'open');
    assert.equal(peer.extensions, 'permessage-deflate');
    assert.equal(client?.extensions, '');
    const until = async (check: () => boolean): Promise<void> => {
        const deadline = Date.now() + 3000;
        while (!check()) { assert.ok(Date.now() < deadline, 'forwarding deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
    };
    await until(() => messages.length === 2);
    assert.equal(messages[0]!.bytes.toString(), text); assert.equal(messages[0]!.binary, false);
    assert.equal(messages[1]!.bytes.toString(), 'tail');
    const payload = Buffer.from([0, 1, 255, 5]); peer.send(payload);
    await until(() => messages.length === 3);
    assert.deepEqual(received, payload); assert.deepEqual(messages[2], { bytes: payload, binary: true });
    const pong = once(client!, 'pong'); client!.ping('heartbeat'); assert.equal((await pong)[0].toString(), 'heartbeat');
    const closed = once(client!, 'close'); peer.close(4000, 'reconnect requested');
    assert.equal((await closed)[0], 4000);
});

test('carrier rejects missing credentials and a foreign Origin before contacting the original gateway', async t => {
    const env = await fixture(t);
    for (const [authenticated, sameOrigin] of [[false, true], [true, false]] as const) {
        const peer = env.open(authenticated, sameOrigin); peer.on('error', () => {});
        const result = await new Promise<number | undefined>(resolve => peer.once('unexpected-response', (_request, response) => {
            response.resume(); resolve(response.statusCode); peer.terminate();
        }));
        assert.equal(result, 403);
    }
    assert.equal(env.calls, 0);
});
