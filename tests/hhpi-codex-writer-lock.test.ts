/** Real CodexRpc and loopback WebSocket transport; only native handshake responses are synthetic. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CodexRpc } from '../src/remote/codex-rpc.ts';

async function fixture(t: TestContext, userAgent: string) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    server.on('connection', socket => {
        socket.on('message', bytes => {
            const message = JSON.parse(bytes.toString()) as { id?: number; method: string };
            if (message.method === 'initialized') return;
            const result = message.method === 'initialize'
                ? { userAgent, codexHome: '/synthetic/native-home', platformFamily: 'unix', platformOs: 'linux' }
                : { data: ['loaded-native-thread'], nextCursor: null };
            socket.send(JSON.stringify({ id: message.id, result }));
        });
    });
    const rpc = new CodexRpc({ id: 'handshake-source', machineId: 'fixture', engine: 'codex', ownership: 'shared',
        endpoint: `ws://127.0.0.1:${address.port}` }, 5000);
    t.after(async () => {
        await rpc.dispose();
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    });
    return rpc;
}

test('native transport preserves prerelease and unrecognized handshakes without version-based capability decisions', { timeout: 10_000 }, async t => {
    for (const userAgent of [
        'Codex Desktop/0.165.0-alpha.1.2 (Windows 10.0.26200; x86_64) unknown (hhpi; 1)',
        'a server without a recognizable version',
    ]) {
        const rpc = await fixture(t, userAgent);
        assert.equal((await rpc.connect()).userAgent, userAgent);
        assert.deepEqual(await rpc.request('thread/loaded/list', {}), { data: ['loaded-native-thread'], nextCursor: null });
        await rpc.dispose();
    }
});
