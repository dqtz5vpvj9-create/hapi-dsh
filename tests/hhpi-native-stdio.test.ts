/** Exercise the deployable Node bundle against a real private socket, without a daemon restart. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexRpc } from '../src/remote/codex-rpc.ts';

let directory: string, entry: string;
before(async () => {
    directory = await mkdtemp('/mnt/cache/data-cache/hhpi-native-stdio-test-');
    entry = join(directory, 'native-stdio.cjs');
    await build({ entryPoints: [resolve('src/remote/native-stdio.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function native(onConnection: (socket: WebSocket) => void) {
    const path = join(directory, `native-${Math.random().toString(36).slice(2)}.sock`);
    const server = createServer(), sockets = new WebSocketServer({ server });
    sockets.on('connection', onConnection);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
    return { path, server, sockets, async close() {
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

test('bundled stdio bridge supports native RPC, notifications and server requests without owning the engine', { timeout: 10_000 }, async () => {
    const calls: string[] = [], responses: unknown[] = [];
    const fixture = await native(socket => socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (!message.method) { responses.push(message); return; }
        calls.push(message.method);
        if (!message.id) return;
        socket.send(JSON.stringify({ id: message.id, result: message.method === 'initialize'
            ? { userAgent: 'fixture', codexHome: directory, platformFamily: 'unix', platformOs: 'linux' }
            : { data: ['already-loaded'], nextCursor: null } }, null, 2));
        if (message.method === 'thread/loaded/list') {
            socket.send(JSON.stringify({ method: 'fixture/notification', params: { text: '原生会话' } }));
            socket.send(JSON.stringify({ id: 'native-request', method: 'fixture/request', params: {} }));
        }
    }));
    try {
        for (let connection = 0; connection < 2; connection++) {
            const rpc = new CodexRpc({ id: 'bridge', machineId: 'machine', engine: 'codex', ownership: 'shared', command: process.execPath, args: [entry, '--socket', fixture.path] });
            const notification = new Promise<unknown>(resolve => rpc.onNotification(resolve));
            const request = new Promise<void>(resolve => rpc.onRequest(value => { void rpc.respond(value, { accepted: false }).then(resolve); }));
            try {
                assert.deepEqual(await rpc.request('thread/loaded/list', {}), { data: ['already-loaded'], nextCursor: null });
                assert.deepEqual(await notification, { method: 'fixture/notification', params: { text: '原生会话' } });
                await request;
            } finally { await rpc.dispose(); }
            assert.equal(fixture.server.listening, true);
        }
        assert.equal(responses.length, 2);
        assert.ok(calls.every(method => ['initialize', 'initialized', 'thread/loaded/list'].includes(method)));
    } finally { await fixture.close(); }
});

test('fragmented UTF-8 and final lines cross the bridge unchanged; EOF closes only this connection', { timeout: 10_000 }, async () => {
    const messages: unknown[] = [];
    const fixture = await native(socket => socket.on('message', bytes => messages.push(JSON.parse(bytes.toString()))));
    try {
        const child = spawn(process.execPath, [entry, '--socket', fixture.path, '--path', '/rpc'], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.resume(); child.stderr.resume();
        const closed = once(child, 'close');
        const input = Buffer.from(JSON.stringify({ id: 1, method: 'read', params: { text: '中文' } }) + '\n' + JSON.stringify({ id: 2, method: 'read', params: {} }));
        const middle = input.indexOf(Buffer.from('中')) + 1;
        child.stdin.write(input.subarray(0, middle)); child.stdin.end(input.subarray(middle));
        assert.equal((await closed)[0], 0);
        assert.deepEqual(messages, [{ id: 1, method: 'read', params: { text: '中文' } }, { id: 2, method: 'read', params: {} }]);
        assert.equal(fixture.server.listening, true);
    } finally { await fixture.close(); }
});

test('native disconnect exits the bridge even while its stdio writer remains open', { timeout: 10_000 }, async () => {
    const fixture = await native(socket => socket.on('message', () => socket.terminate()));
    try {
        const child = spawn(process.execPath, [entry, '--socket', fixture.path], { stdio: ['pipe', 'pipe', 'pipe'] });
        const output: Buffer[] = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.resume();
        const closed = once(child, 'close');
        child.stdin.write('{"id":1,"method":"read"}\n');
        assert.equal((await closed)[0], 1);
        assert.equal(Buffer.concat(output).length, 0);
        assert.equal(fixture.server.listening, true);
    } finally { await fixture.close(); }
});

test('bridge rejects public Unix sockets before connecting and keeps diagnostics off stdout', { timeout: 10_000 }, async () => {
    let connections = 0;
    const fixture = await native(() => { connections++; });
    try {
        await chmod(fixture.path, 0o666);
        const child = spawn(process.execPath, [entry, '--socket', fixture.path], { stdio: ['pipe', 'pipe', 'pipe'] });
        const output: Buffer[] = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.resume();
        const closed = once(child, 'close'); child.stdin.end();
        assert.equal((await closed)[0], 1);
        assert.equal(connections, 0);
        assert.equal(Buffer.concat(output).length, 0);
    } finally { await fixture.close(); }
});
