/** Real private-socket carrier; only the native JSON-RPC engine is synthetic. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexRpc } from '../src/remote/codex-rpc.ts';
import { parseSources } from '../src/remote/config.ts';

test('HHPI reads the existing private native socket and disconnects without stopping its engine', { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-socket-'));
    const path = join(directory, 'native.sock'), server = createServer(), sockets = new WebSocketServer({ server });
    const calls: string[] = [];
    sockets.on('connection', socket => socket.on('message', data => {
        const request = JSON.parse(data.toString());
        calls.push(request.method);
        if (!request.id) return;
        socket.send(JSON.stringify({ id: request.id, result: request.method === 'initialize'
            ? { userAgent: 'native-fixture', codexHome: directory, platformFamily: 'unix', platformOs: 'linux' }
            : { data: ['existing-thread'], nextCursor: null } }));
    }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
    const [config] = parseSources([{ id: 'native', machineId: 'same-machine', engine: 'codex', endpoint: `unix://${path}`, ownership: 'shared' }]);
    try {
        for (let reader = 0; reader < 2; reader++) {
            const rpc = new CodexRpc(config!);
            try { assert.deepEqual(await rpc.request('thread/loaded/list', {}), { data: ['existing-thread'], nextCursor: null }); }
            finally { await rpc.dispose(); }
        }
        assert.equal(server.listening, true);
        assert.equal(calls.filter(method => method === 'thread/loaded/list').length, 2);
        assert.ok(calls.every(method => ['initialize', 'initialized', 'thread/loaded/list'].includes(method)), 'reading never resumes, sends or cancels a native thread');
        await chmod(path, 0o666);
        const rejected = new CodexRpc(config!);
        try { await assert.rejects(rejected.connect(), /private socket/); }
        finally { await rejected.dispose(); }
    } finally {
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});

test('native endpoint configuration keeps remote hosts, URI credentials and relative sockets out', () => {
    for (const endpoint of ['unix://relative/socket', 'unix:///private/socket?token=secret', 'ws://remote.example.invalid:3000', 'ws://user:secret@127.0.0.1:3000']) {
        assert.throws(() => parseSources([{ id: 'native', machineId: 'machine', engine: 'codex', endpoint }]));
    }
});
