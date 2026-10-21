/** Real HTTP/WebSocket transport, with explicit fixture plugin-event bytes. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { mountPluginEvents, PLUGIN_EVENTS_PATH, type PluginEventServices } from '../src/shared/plugin-events.ts';

async function fixture(t: TestContext) {
    const sources: ServerResponse[] = []; let sourceCloses = 0;
    let upgrade: Parameters<PluginEventServices['webServer']['registerUpgrade']>[0]['handler'] | undefined;
    let origin = '';
    const server = createServer((request, response) => {
        if (request.headers.cookie !== 'fixture=authorized') { response.writeHead(401); response.end(); return; }
        if (!['/plugins/events', '/hapi-dsh/machine/remote-one/plugins/events'].includes(request.url ?? '')) { response.writeHead(404); response.end(); return; }
        sources.push(response); response.once('close', () => { sourceCloses++; });
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'set-cookie': 'must-stay-server-side=fixture' });
        response.write(`event: graph\ndata: {"rev":"${sources.length}"}\n\n`);
    });
    server.on('upgrade', (request, socket, head) => {
        if (new URL(request.url ?? '/', 'http://fixture').pathname === PLUGIN_EVENTS_PATH && upgrade) upgrade(request, socket, head);
        else socket.destroy();
    });
    const dispose = mountPluginEvents({
        webServer: { getOrigin: () => origin, registerUpgrade(route) { upgrade = route.handler; return () => { upgrade = undefined; }; } },
        connection: { requestRejection: request => request.headers.cookie === 'fixture=authorized' ? undefined : 401 },
        hasHost: id => id === 'remote-one',
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
    t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const open = (host: string, authenticated = true) => new WebSocket(`${origin.replace('http:', 'ws:')}${PLUGIN_EVENTS_PATH}?host=${encodeURIComponent(host)}`,
        { ...(authenticated ? { headers: { cookie: 'fixture=authorized' } } : {}) });
    return { open, sources, get sourceCloses() { return sourceCloses; } };
}
async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('Fixture stream did not reach the expected state');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

test('official event bytes and EOF cross the WS carrier, with no credential response headers', async t => {
    const env = await fixture(t); const peer = env.open('remote-one');
    const frames: Array<{ binary: boolean; data: Buffer }> = [];
    peer.on('message', (data, binary) => frames.push({ binary, data: Buffer.from(data as Buffer) }));
    await once(peer, 'open'); await until(() => frames.length >= 2);
    const head = JSON.parse(frames[0]!.data.toString());
    assert.deepEqual(head, { type: 'head', status: 200, headers: [['cache-control', 'no-store'], ['content-type', 'text/event-stream']] });
    assert.equal(frames[1]!.binary, true);
    assert.equal(frames[1]!.data.toString(), 'event: graph\ndata: {"rev":"1"}\n\n');
    const payload = Buffer.from('event: rebuilt\ndata: {"name":"插件","rev":"2"}\n\n');
    env.sources[0]!.write(payload.subarray(0, 30)); env.sources[0]!.end(payload.subarray(30));
    await once(peer, 'close');
    assert.deepEqual(Buffer.concat(frames.slice(2).filter(row => row.binary).map(row => row.data)), payload);
    assert.deepEqual(JSON.parse(frames.at(-1)!.data.toString()), { type: 'end' });
});

test('many independent views do not consume browser HTTP connections and detach only their stream', async t => {
    const env = await fixture(t);
    const peers = Array.from({ length: 9 }, () => env.open('local'));
    const chunks = peers.map(() => [] as string[]);
    peers.forEach((peer, index) => peer.on('message', (data, binary) => { if (binary) chunks[index]!.push(data.toString()); }));
    await Promise.all(peers.map(peer => once(peer, 'open'))); await until(() => chunks.every(value => value.length === 1));
    peers[0]!.close(); await once(peers[0]!, 'close'); await until(() => env.sourceCloses === 1);
    for (const source of env.sources.slice(1)) source.write('event: rebuilt\ndata: unchanged-official-event\n\n');
    await until(() => chunks.slice(1).every(value => value.length === 2));
    assert.equal(chunks[0]!.length, 1);
    await Promise.all(peers.slice(1).map(async peer => { peer.close(); await once(peer, 'close'); }));
    await until(() => env.sourceCloses === peers.length);
});

test('carrier requires the original Host authorization and cannot select arbitrary routes or hosts', async t => {
    const env = await fixture(t);
    for (const [host, authenticated, status] of [['local', false, 401], ['unknown', true, 404], ['../api/mutate', true, 404]] as const) {
        const peer = env.open(host, authenticated);
        peer.on('error', () => {});
        const rejection = new Promise<number | undefined>(resolve => peer.once('unexpected-response', (_request, response) => {
            response.resume(); resolve(response.statusCode); peer.terminate();
        }));
        assert.equal(await rejection, status);
    }
    assert.equal(env.sources.length, 0);
});
