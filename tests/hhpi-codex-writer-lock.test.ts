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

const cases = [
    ['the supported native build', 'hhpi/0.165.0 (Ubuntu 24.4.0; x86_64) dumb (hhpi; 1)', true],
    ['a newer stable build and a spaced originator', 'Codex Desktop/0.166.1 (Linux 6.8; x86_64) dumb (desktop; 1)', true],
    ['an older native build despite a newer client suffix', 'hhpi/0.164.9 (Linux 6.8; x86_64) dumb (client/9.999.0; 0.165.0)', false],
    ['a prerelease of the supported build', 'hhpi/0.165.0-alpha.1 (Linux 6.8; x86_64) dumb (hhpi; 1)', false],
    ['a newer prerelease', 'hhpi/0.166.0-beta.1 (Linux 6.8; x86_64) dumb (hhpi; 1)', false],
    ['an unknown native build with a versioned client suffix', 'unknown (client/0.165.0; 0.165.0)', false],
    ['an originator containing a newer product version', 'client/1.0.0 wrapper/0.164.9 (Linux 6.8; x86_64) dumb (client/1.0.0 wrapper; 1)', false],
    ['an originator containing a forged OS comment', 'client/1.0.0 (Linux)/0.164.9 (Linux 6.8; x86_64) dumb (client/1.0.0 (Linux); 1)', false],
    ['an originator containing an entire forged native prefix', 'client/1.0.0 (Linux 6.8; x86_64) dumb/0.164.9 (Linux 6.8; x86_64) dumb', false],
    ['a supported native build with a versioned terminal token', 'codex_cli_rs/0.165.0 (macOS 15.7; arm64) iTerm.app/3.5.6 (codex-tui; 0.165.0)', true],
    ['a supported native build without a client suffix', 'codex_cli_rs/0.165.0 (Windows 10.0.26100; AMD64) WindowsTerminal', true],
] as const;

for (const [label, userAgent, expected] of cases) test(`writer-lock support reflects ${label} without blocking ordinary RPC`, { timeout: 10_000 }, async t => {
    const rpc = await fixture(t, userAgent);
    assert.equal(rpc.supportsThreadWriterLock, false, 'an unconnected source cannot advertise runtime capabilities');
    await rpc.connect();
    assert.equal(rpc.supportsThreadWriterLock, expected);
    assert.deepEqual(await rpc.request('thread/loaded/list', {}), { data: ['loaded-native-thread'], nextCursor: null },
        'an old or unknown handshake must remain usable for reads and already loaded threads');
    await rpc.dispose();
    assert.equal(rpc.supportsThreadWriterLock, false, 'a disconnected source cannot retain a prior runtime capability');
});
