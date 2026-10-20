/** Opt-in integration: unchanged npm DSH 0.2.1-rc.2, official profile CLI, and the real Runner plugin. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import WebSocket from 'ws';
import { DSH_VERSION } from '../src/cli/config.ts';
import { installProfile, resolveDshCommand } from '../src/cli/runtime.ts';
import { FederationHub, type FederationMount } from '../src/hub/federation.ts';
import { addPairing } from '../src/hub/federation-credentials.ts';
import { createRunnerConfig, writeRunnerConfig } from '../src/runner/config.ts';

test('official DSH Web profile boots as a paired Runner and serves its real graph, plugin assets, RPC and event stream', {
    skip: process.env.HAPI_DSH_OFFICIAL_TESTS !== '1', timeout: 150_000,
}, async (t) => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-official-'));
    const bundle = join(directory, 'runner-bundle');
    await mkdir(bundle);
    await build({ entryPoints: [join(root, 'src/runner/index.ts')], outfile: join(bundle, 'index.js'), bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm' });
    await symlink(join(root, 'node_modules'), join(bundle, 'node_modules'), 'junction');
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'hapi-dsh-runner', version: '0.1.0', type: 'module', main: './index.js',
        exports: { '.': './index.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' }, engines: { dsh: DSH_VERSION },
        dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(join(bundle, 'cordis.patch.yml'), await readFile(join(root, 'config/runner.patch.yml')));
    const routes: Array<Parameters<FederationMount['webServer']['register']>[0]> = [];
    const upgrades = new Map<string, (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>>();
    const server = createServer((request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
        const route = routes.find((entry) => entry.kind === 'exact' ? entry.path === pathname : pathname === entry.path || pathname.startsWith(`${entry.path}/`));
        if (!route) { response.writeHead(404); response.end(); return; }
        Promise.resolve(route.handler(request, response)).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    server.on('upgrade', (request, socket, head) => {
        const handler = upgrades.get(new URL(request.url ?? '/', 'http://fixture').pathname);
        if (handler) void Promise.resolve(handler(request, socket, head)).catch(() => socket.destroy());
        else socket.destroy();
    });
    const credentialsFile = join(directory, 'pairings.json');
    const id = 'official-dsh-machine';
    const token = await addPairing(credentialsFile, id, 'Official DSH smoke');
    const hub = new FederationHub({ credentialsFile });
    await hub.mount({ authorize: (request) => request.headers.cookie === 'fixture-authorized=1' ? undefined : 401,
        webServer: { register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; },
            registerUpgrade: (route) => { upgrades.set(route.path, route.handler); return () => { upgrades.delete(route.path); }; } } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const config = createRunnerConfig(base, { id, token, dshHome: join(directory, 'dsh-home') });
    const configFile = join(directory, 'runner.json');
    await writeRunnerConfig(configFile, config);
    let child: ChildProcess | undefined;
    let logs = '';
    t.after(async () => {
        if (child && child.exitCode === null) {
            child.kill('SIGTERM');
            const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
            await once(child, 'close').catch(() => {});
            clearTimeout(force);
        }
        await hub.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    });
    await installProfile(config, configFile, bundle, { bundleName: 'hapi-dsh-runner' });
    const command = await resolveDshCommand(config);
    child = spawn(command.executable, [...command.args, '--profile', config.dsh.profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        env: { ...process.env, DSH_HOME: config.dsh.home, HAPI_DSH_RUNNER_CONFIG_FILE: configFile }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk: Buffer): void => { if (logs.length < 100_000) logs += chunk.toString('utf8').replaceAll(token, '[redacted]').replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'); };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    const deadline = Date.now() + 60_000;
    while (!hub.listMachines().some((machine) => machine.online)) {
        if (child.exitCode !== null || Date.now() > deadline) assert.fail(`Official Runner did not become ready. ${logs}`);
        await delay(100);
    }
    const headers = { cookie: 'fixture-authorized=1' };
    const machineBase = `${base}/hapi-dsh/machine/${id}/`;
    const response = await fetch(`${machineBase}hapi-dsh/bootstrap`, { headers });
    assert.equal(response.status, 200);
    const bootstrap = await response.json() as { dshVersion: string; graph: { release: { version: string }; entries: Array<{ id: string; url: string }> }; globals: Record<string, unknown> };
    assert.equal(bootstrap.dshVersion, DSH_VERSION);
    assert.equal(bootstrap.graph.release.version, DSH_VERSION);
    assert.ok(bootstrap.graph.entries.some((entry) => entry.id === '@deepseek-ai/dsh-client-ui-conversation'));
    assert.ok(!bootstrap.graph.entries.some((entry) => entry.id === 'hapi-dsh-runner' || entry.id === 'hapi-dsh'));
    const entry = bootstrap.graph.entries.find((row) => row.id === '@deepseek-ai/dsh-client-ui-conversation')!;
    const script = await fetch(new URL(entry.url, machineBase), { headers });
    assert.equal(script.status, 200);
    assert.match(await script.text(), /__ModuleLoader__\.load/);
    const rpc = await fetch(`${machineBase}api/session/list`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'official-fixture-list', method: 'session/list', payload: { args: { _request: {} } } }) });
    assert.equal(rpc.status, 200);
    const result = await rpc.json() as { result: { ok: boolean; value?: { items: unknown[] } } };
    assert.equal(result.result.ok, true, JSON.stringify(result));
    assert.ok(Array.isArray(result.result.value?.items));
    const wsUrl = new URL(`${base}/hapi-dsh/socket?machine=${id}&path=${encodeURIComponent('/api/remote.mux')}`);
    wsUrl.protocol = 'ws:';
    const socket = new WebSocket(wsUrl, { headers });
    socket.on('error', () => {});
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const item = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'open', streamId: 'official-events', endpoint: '$events', payload: { args: {} } }));
    const [wire] = await item;
    const frame = JSON.parse(String(wire)) as { type: string; value?: { type: string } };
    assert.equal(frame.type, 'item');
    assert.equal(frame.value?.type, 'ready');
});
