/** Real TCP/HTTP/WebSocket transport tests with a deliberately small fake DSH application. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { FederationHub, type FederationMount } from '../src/hub/federation.ts';
import { addPairing, readPairingStore, revokePairing } from '../src/hub/federation-credentials.ts';
import { RunnerClient } from '../src/runner/client.ts';
import { createRunnerConfig } from '../src/runner/config.ts';
import { bootstrapPayload } from '../src/runner/index.ts';
import { parseFrame, validateUpstreamPath } from '../src/runner/protocol.ts';

async function until(condition: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) { if (Date.now() >= deadline) throw new Error(message); await delay(10); }
}

async function transportFixture(t: TestContext, options: { httpIdleTimeoutMs?: number; compressed?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-federation-'));
    const credentialsFile = join(directory, 'pairings.json');
    const id = 'fixture-machine-a';
    const token = await addPairing(credentialsFile, id, 'Fixture workstation');
    const upstreamHeaders: IncomingMessage['headers'][] = [];
    let mutationCount = 0;
    let compressedChunks = 0, compressedStreamClosed = false;
    const upstreamSockets = new WebSocketServer({ noServer: true,
        handleProtocols: (offered) => offered.has('plugin-v2') ? 'plugin-v2' : offered.values().next().value ?? false });
    const upstream = createServer((request, response) => {
        if (request.url?.startsWith('/?token=fixture-launch')) {
            response.writeHead(303, { 'set-cookie': 'dsh-auth-fixture=private-runner-cookie; HttpOnly; Path=/', location: './' }); response.end(); return;
        }
        upstreamHeaders.push(request.headers);
        if (request.headers.cookie !== 'dsh-auth-fixture=private-runner-cookie') { response.writeHead(401); response.end(); return; }
        if (request.url === '/open-in-app/apps') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ apps: [{ id: 'fixture-editor', name: 'Fixture editor' }] })); return;
        }
        if (request.url === '/plugins/large-json') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ value: 'bounded-compressed-response\n'.repeat(100_000) })); return;
        }
        if (request.url === '/plugins/compressed-stream') {
            response.writeHead(200, { 'content-type': 'text/plain' });
            const chunk = randomBytes(64 * 1024).toString('hex');
            const timer = setInterval(() => {
                response.write(chunk); compressedChunks++;
                if (compressedChunks === 64) { clearInterval(timer); response.end(); }
            }, 10);
            response.once('close', () => { compressedStreamClosed = true; clearInterval(timer); });
            return;
        }
        if (request.url === '/api/mutate') {
            void (async () => { for await (const _part of request) { /* consume request before committing */ } mutationCount++; })();
            return;
        }
        if (request.url === '/api/long-stream') {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            let sequence = 0;
            const timer = setInterval(() => {
                response.write(`data: ${++sequence}\n\n`);
                if (sequence === 8) { clearInterval(timer); response.end(); }
            }, 60);
            response.once('close', () => clearInterval(timer));
            return;
        }
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const part of request) chunks.push(Buffer.from(part));
            response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-fixture-path': request.url ?? '/' });
            response.end(Buffer.concat(chunks));
        })();
    });
    upstream.on('upgrade', (request, socket, head) => {
        if (request.headers.cookie !== 'dsh-auth-fixture=private-runner-cookie') { socket.destroy(); return; }
        upstreamSockets.handleUpgrade(request, socket, head, (peer) => {
            peer.on('error', () => {});
            peer.on('message', (data, binary) => {
                if (!binary && data.toString() === 'fixture-close') peer.close(4004, 'plugin-specific-close');
                else peer.send(data, { binary });
            });
        });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
    const origin = `http://127.0.0.1:${upstreamAddress.port}`;
    const routes: Array<Parameters<FederationMount['webServer']['register']>[0]> = [];
    const upgrades = new Map<string, (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>>();
    const serve = (request: IncomingMessage, response: ServerResponse): void => {
        const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
        const route = routes.find((entry) => entry.kind === 'exact' ? entry.path === pathname : pathname === entry.path || pathname.startsWith(`${entry.path}/`));
        if (!route) { response.writeHead(404); response.end(); return; }
        Promise.resolve(route.handler(request, response)).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    };
    // This is the actual middleware installed by the pinned official Web server,
    // including its write() wrapper which intentionally ignores callbacks.
    const compression = options.compressed ? (createRequire(import.meta.url)('compression') as () =>
        (request: IncomingMessage, response: ServerResponse, next: () => void) => void)() : undefined;
    const server = createServer((request, response) => compression
        ? compression(request, response, () => serve(request, response)) : serve(request, response));
    server.on('upgrade', (request, socket, head) => {
        const handler = upgrades.get(new URL(request.url ?? '/', 'http://fixture').pathname);
        if (handler) void Promise.resolve(handler(request, socket, head)).catch(() => socket.destroy());
        else socket.destroy();
    });
    const hub = new FederationHub({ credentialsFile, ...(options.httpIdleTimeoutMs === undefined ? {} : { httpIdleTimeoutMs: options.httpIdleTimeoutMs }) });
    await hub.mount({
        authorize: (request) => request.headers.cookie === 'fixture-main-dsh=authorized' ? undefined : 401,
        webServer: {
            register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; },
            registerUpgrade: (route) => { upgrades.set(route.path, route.handler); return () => { upgrades.delete(route.path); }; },
        },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const runnerConfig = createRunnerConfig(base, { id, name: 'Fixture workstation', token });
    const runners: RunnerClient[] = [];
    const connectRunner = async (): Promise<RunnerClient> => {
        const runner = new RunnerClient({ config: runnerConfig, origin, authenticatedUrl: (local) => `${local}/?token=fixture-launch` });
        runners.push(runner);
        runner.start();
        await until(() => hub.listMachines().some((machine) => machine.id === id && machine.online), 'Runner did not become online');
        return runner;
    };
    t.after(async () => {
        await Promise.all(runners.map((runner) => runner.stop()));
        await hub.close();
        for (const peer of upstreamSockets.clients) peer.terminate();
        upstreamSockets.close();
        server.closeAllConnections(); upstream.closeAllConnections();
        await Promise.all([server, upstream].map((instance) => new Promise<void>((resolve) => instance.close(() => resolve()))));
        await rm(directory, { recursive: true, force: true });
    });
    const runner = await connectRunner();
    return { base, id, runner, hub, connectRunner, credentialsFile, upstreamHeaders, get mutationCount() { return mutationCount; },
        get compressedChunks() { return compressedChunks; }, get compressedStreamClosed() { return compressedStreamClosed; },
        get upstreamSocketCount() { return upstreamSockets.clients.size; },
        headers: { cookie: 'fixture-main-dsh=authorized' } };
}

test('reverse federation forwards streaming bytes, opaque plugin paths, and isolates transport credentials', async (t) => {
    const fixture = await transportFixture(t);
    const payload = Buffer.alloc(1024 * 1024 + 17, 0xab);
    const response = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/plugins/??example/client.js&rev=fixture`, {
        method: 'POST', headers: { ...fixture.headers, authorization: 'Bearer browser-value-must-not-propagate' }, body: payload,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    assert.equal(response.headers.get('x-fixture-path'), '/plugins/??example/client.js&rev=fixture');
    assert.ok(fixture.upstreamHeaders.every((headers) => headers.authorization === undefined));
    assert.ok(fixture.upstreamHeaders.every((headers) => headers.cookie === 'dsh-auth-fixture=private-runner-cookie'));
    const denied = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/api/read`);
    assert.equal(denied.status, 401);
    const machines = await fetch(`${fixture.base}/hapi-dsh/machines`, { headers: fixture.headers }).then((reply) => reply.json()) as { machines: Array<{ id: string; online: boolean }> };
    assert.equal(machines.machines[0]?.id, fixture.id);
    assert.equal(machines.machines[0]?.online, true);
    assert.ok(!JSON.stringify(machines).includes('tokenHash'));
});

test('official compression completes small JSON and drains large responses without waiting for dropped write callbacks', async (t) => {
    const fixture = await transportFixture(t, { compressed: true });
    const options = { headers: { ...fixture.headers, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(5000) };
    const small = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/open-in-app/apps`, options);
    assert.equal(small.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(await small.json(), { apps: [{ id: 'fixture-editor', name: 'Fixture editor' }] });
    const large = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/plugins/large-json`, options);
    assert.equal(large.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(await large.json(), { value: 'bounded-compressed-response\n'.repeat(100_000) });
    assert.equal(fixture.hub.listMachines()[0]?.online, true);
});

test('closing a compressed response releases the pending writer without dropping or replaying other Runner channels', async (t) => {
    const fixture = await transportFixture(t, { compressed: true });
    const abort = new AbortController();
    const response = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/plugins/compressed-stream`, {
        headers: { ...fixture.headers, 'accept-encoding': 'gzip' }, signal: abort.signal,
    });
    const reader = response.body!.getReader();
    await reader.read(); abort.abort();
    await reader.cancel().catch(() => {});
    await until(() => fixture.compressedStreamClosed, 'Aborted compressed stream retained its source request');
    assert.ok(fixture.compressedChunks > 0 && fixture.compressedChunks < 64);
    const recovered = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/open-in-app/apps`, {
        headers: { ...fixture.headers, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { apps: [{ id: 'fixture-editor', name: 'Fixture editor' }] });
    assert.equal(fixture.hub.listMachines()[0]?.online, true);
    assert.equal(fixture.mutationCount, 0);
});

test('full duplex official-style WebSocket messages survive the reverse transport', async (t) => {
    const fixture = await transportFixture(t);
    const url = new URL(`${fixture.base}/hapi-dsh/socket`);
    url.protocol = 'ws:';
    url.searchParams.set('machine', fixture.id);
    url.searchParams.set('path', '/api/remote.mux');
    const browser = new WebSocket(url, { headers: fixture.headers });
    browser.on('error', () => {});
    t.after(() => browser.terminate());
    await once(browser, 'open');
    const textReply = once(browser, 'message');
    browser.send(JSON.stringify({ type: 'open', endpoint: '$events', interactions: 'answer' }));
    const [text, binary] = await textReply;
    assert.equal(binary, false);
    assert.deepEqual(JSON.parse(String(text)), { type: 'open', endpoint: '$events', interactions: 'answer' });
    const binaryReply = once(browser, 'message');
    browser.send(Buffer.from([0, 255, 128, 10]));
    const [value, isBinary] = await binaryReply;
    assert.equal(isBinary, true);
    assert.deepEqual(Buffer.from(value), Buffer.from([0, 255, 128, 10]));
    const close = once(browser, 'close');
    browser.send('fixture-close');
    const [code, reason] = await close;
    assert.equal(code, 4004);
    assert.equal(reason.toString(), 'plugin-specific-close');
});

test('the browser receives the real upstream plugin WebSocket subprotocol', async (t) => {
    const fixture = await transportFixture(t);
    const url = new URL(`${fixture.base}/hapi-dsh/socket`);
    url.protocol = 'ws:';
    url.searchParams.set('machine', fixture.id);
    url.searchParams.set('path', '/plugin/socket');
    const browser = new WebSocket(url, ['plugin-v1', 'plugin-v2'], { headers: fixture.headers });
    browser.on('error', () => {});
    t.after(() => browser.terminate());
    await once(browser, 'open');
    assert.equal(browser.protocol, 'plugin-v2');
    const reply = once(browser, 'message');
    browser.send('using-the-negotiated-protocol');
    assert.equal(String((await reply)[0]), 'using-the-negotiated-protocol');
});

test('a rejected browser WebSocket handshake releases the already opened upstream channel', async (t) => {
    const fixture = await transportFixture(t);
    const url = new URL(`${fixture.base}/hapi-dsh/socket`);
    url.searchParams.set('machine', fixture.id);
    url.searchParams.set('path', '/plugin/socket');
    const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(url, { headers: { ...fixture.headers, connection: 'Upgrade', upgrade: 'websocket',
            'sec-websocket-version': '13', 'sec-websocket-key': 'invalid-browser-key' } }, response => {
            response.resume(); resolve(response.statusCode ?? 0);
        });
        request.on('error', reject);
        request.end();
    });
    assert.equal(status, 400);
    await until(() => fixture.upstreamSocketCount === 0, 'Rejected handshake leaked its upstream socket');
});

test('active HTTP event streams outlive the idle timeout without being truncated', async (t) => {
    const fixture = await transportFixture(t, { httpIdleTimeoutMs: 200 });
    const response = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/api/long-stream`, { headers: fixture.headers });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /data: 8/);
});

test('a committed mutation interrupted by Runner loss is never replayed after reconnect', async (t) => {
    const fixture = await transportFixture(t);
    const response = fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/api/mutate`, { method: 'POST', headers: fixture.headers, body: 'commit-once' });
    await until(() => fixture.mutationCount === 1, 'The upstream did not receive the mutation');
    await fixture.runner.stop();
    assert.equal((await response).status, 502);
    await until(() => !fixture.hub.listMachines()[0]?.online, 'The Hub did not mark its Runner offline');
    await fixture.connectRunner();
    await delay(100);
    assert.equal(fixture.mutationCount, 1);
});

test('pairing revocation closes the authenticated Runner and removes its catalog entry', async (t) => {
    const fixture = await transportFixture(t);
    const store = await readPairingStore(fixture.credentialsFile);
    assert.equal(store.machines.length, 1);
    assert.match(store.machines[0]!.tokenHash, /^[0-9a-f]{64}$/);
    await revokePairing(fixture.credentialsFile, fixture.id);
    await fixture.hub.refreshCredentials();
    assert.deepEqual(fixture.hub.listMachines(), []);
    const response = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/api/read`, { headers: fixture.headers });
    assert.equal(response.status, 404);
});

test('an unreadable pairing policy fails closed for active Runner connections', async (t) => {
    const fixture = await transportFixture(t);
    await writeFile(fixture.credentialsFile, '{invalid-json', { mode: 0o600 });
    await assert.rejects(fixture.hub.refreshCredentials());
    assert.deepEqual(fixture.hub.listMachines(), []);
    const response = await fetch(`${fixture.base}/hapi-dsh/machine/${fixture.id}/api/read`, { headers: fixture.headers });
    assert.equal(response.status, 404);
});

test('Runner bootstrap exports only official safe JSON globals and keeps the original module graph', () => {
    const graph = { rev: 'fixture-revision', entries: [], batches: [] };
    const payload = bootstrapPayload({ clientModules: { graph: () => graph }, webServer: {
        collectIndexInjections: () => [
            { kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: { backoffBaseMs: 200 } },
            { kind: 'global', name: 'private-token', value: 'fixture-private' },
            { kind: 'script', value: 'throw new Error("must not execute")' },
        ],
        getOrigin: () => 'http://127.0.0.1', register: () => () => {},
    } });
    assert.equal(payload.graph, graph);
    assert.deepEqual(payload.globals, { __DSH_CONNECTION_RECOVERY__: { backoffBaseMs: 200 } });
    assert.ok(!JSON.stringify(payload).includes('fixture-private'));
});

test('wire parser rejects non-local paths, unknown messages, and invalid headers', () => {
    for (const path of ['https://outside.example.test', '//outside.example.test', '/api\\other', '/api\r\nx: y']) assert.throws(() => validateUpstreamPath(path));
    assert.throws(() => parseFrame(JSON.stringify({ type: 'execute-shell', id: 'fixture' })));
    assert.throws(() => parseFrame(JSON.stringify({ type: 'http-open', id: 'fixture', method: 'GET', path: '/api', headers: [['x-value', 'a\r\nb']] })));
});
