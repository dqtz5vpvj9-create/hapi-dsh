/** Real loopback WebSocket carrier and production CodexRpc; only the native JSON-RPC engine is synthetic. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexRpc } from '../src/remote/codex-rpc.ts';
import { SourceError } from '../src/remote/errors.ts';

interface NativeRequest { id?: string | number; method: string; params?: unknown }
async function native(t: TestContext, receive: (request: NativeRequest, socket: WebSocket) => void,
    options: { rejectUpgrade?: boolean; timeoutMs?: number } = {}) {
    const server = createServer(), sockets = new WebSocketServer({ noServer: true });
    const received: NativeRequest[] = [];
    let upgrades = 0;
    server.on('upgrade', (request, socket, head) => {
        upgrades++;
        if (options.rejectUpgrade) {
            socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            return;
        }
        sockets.handleUpgrade(request, socket, head, peer => { sockets.emit('connection', peer); });
    });
    sockets.on('connection', socket => {
        socket.on('error', () => {});
        socket.on('message', bytes => {
            const request = JSON.parse(bytes.toString()) as NativeRequest;
            if (request.method === 'initialize') {
                socket.send(JSON.stringify({ id: request.id, result: {
                    userAgent: 'codex/0.165.0 (Linux; x86_64) unknown', codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux',
                } }));
            } else if (request.id !== undefined) {
                received.push(request); receive(request, socket);
            }
        });
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1'); await listening;
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const rpc = new CodexRpc({ id: 'synthetic-native', machineId: 'synthetic-machine', engine: 'codex',
        endpoint: `ws://127.0.0.1:${address.port}` }, options.timeoutMs ?? 1200);
    t.after(async () => {
        await rpc.dispose();
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>(resolve => { sockets.close(() => resolve()); });
        server.closeAllConnections();
        await new Promise<void>(resolve => { server.close(() => resolve()); });
    });
    return { rpc, received, get upgrades() { return upgrades; } };
}

function delivery(code: SourceError['code'], expected: 'not-dispatched' | undefined): (error: unknown) => boolean {
    return error => {
        assert.ok(error instanceof SourceError);
        assert.equal(error.code, code);
        assert.equal(Reflect.get(error, 'delivery'), expected);
        return true;
    };
}

test('a failed native handshake proves the requested write was not dispatched', { timeout: 2000 }, async t => {
    const source = await native(t, () => {}, { rejectUpgrade: true });
    await assert.rejects(source.rpc.request('turn/start', { threadId: 'thread', input: [] }, { write: true }),
        delivery('TARGET_UNAVAILABLE', 'not-dispatched'));
    assert.equal(source.upgrades, 1);
    assert.deepEqual(source.received, [], 'no native request can arrive before the WebSocket handshake succeeds');
});

test('128 real pending reads reject the next write before it reaches the native socket', { timeout: 2000 }, async t => {
    const full = Promise.withResolvers<void>();
    let reads = 0;
    const source = await native(t, request => {
        if (request.method === 'thread/read' && ++reads === 128) full.resolve();
    });
    await source.rpc.connect();
    // Observe all read failures immediately. Disposal releases these waiters;
    // no reflection or artificial mutation of the private pending map is used.
    const pending = Array.from({ length: 128 }, (_, index) => source.rpc.request('thread/read', { threadId: `thread-${index}` })
        .then(() => 'resolved', () => 'rejected'));
    await full.promise;
    await assert.rejects(source.rpc.request('turn/start', { threadId: 'thread', input: [] }, { write: true }),
        delivery('CAPACITY_EXCEEDED', 'not-dispatched'));
    assert.equal(source.received.length, 128);
    assert.ok(source.received.every(request => request.method === 'thread/read'), 'the rejected write was never emitted');
    await source.rpc.dispose();
    assert.ok((await Promise.all(pending)).every(outcome => outcome === 'rejected'));
});

for (const loss of ['disconnect', 'timeout'] as const) {
    test(`a native write received before ACK ${loss} remains uncertain and has no not-dispatched proof`, { timeout: 2000 }, async t => {
        const arrived = Promise.withResolvers<NativeRequest>();
        const source = await native(t, (request, socket) => {
            arrived.resolve(request);
            if (loss === 'disconnect') socket.terminate();
        }, { timeoutMs: loss === 'timeout' ? 150 : 1200 });
        const rejected = assert.rejects(source.rpc.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'synthetic write' }] }, { write: true }),
            delivery('OUTCOME_UNKNOWN', undefined));
        assert.equal((await arrived.promise).method, 'turn/start', 'the real native server received the operation before losing its ACK');
        await rejected;
        assert.equal(source.received.length, 1, 'transport recovery never retries the native write');
        assert.equal(source.upgrades, 1);
    });
}
