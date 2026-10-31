/** Actual bootstrap route and loopback HTTP; no service restart or production credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { mountBootstrapRoute, type BootstrapServices } from '../src/shared/bootstrap.ts';
import { HAPI_DSH_BUILD_ID } from '../src/build-info.ts';

const { DeploymentBuildMismatch, verifyDeploymentBuild } = await import(new URL('../scripts/deploy-verification.mjs', import.meta.url).href) as {
    DeploymentBuildMismatch: new (message: string) => Error;
    verifyDeploymentBuild(input: { launch: URL; headers: Record<string, string>; localClient: Buffer; expectedHostBuildId?: string }): Promise<{
        ready: boolean; hostIdentity?: { status: string; buildId?: string };
    }>;
};

const hostBuildId = HAPI_DSH_BUILD_ID;
const localClient = Buffer.from('window.__ModuleLoader__.load({id:"hapi-dsh",factory:function(){return {};}});\n');

async function fixture(t: TestContext) {
    let route: Parameters<BootstrapServices['webServer']['register']>[0] | undefined;
    let onReady: (() => void) | undefined;
    const graph = { rev: 'synthetic-graph', entries: [{ id: 'hapi-dsh', url: '/client.js?rev=current', rev: 'current' }] };
    const control = { client: localClient, trailer: '//# sourceMappingURL=/client.js.map?rev=current\n', legacyBootstrap: false };
    const headers = { cookie: 'admitted=synthetic-only' };
    const remove = mountBootstrapRoute({
        connection: { requestRejection: request => request.headers.cookie === headers.cookie ? undefined : 401 },
        webServer: { collectIndexInjections: () => [{ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: { backoffBaseMs: 200 } }],
            register: value => { route = value; return () => { route = undefined; }; } },
        clientModules: { graph: () => graph },
        appReady: { onReady: callback => { onReady = callback; return () => { onReady = undefined; }; } },
    });
    const requests: string[] = [];
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
        requests.push(path);
        if (path === route?.path && !control.legacyBootstrap) return route.handler(request, response);
        if (request.headers.cookie !== headers.cookie) { response.writeHead(401); response.end(); return; }
        if (path === '/hapi-dsh/bootstrap') {
            response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ graph, globals: {} }));
        } else if (path === '/client.js') {
            response.writeHead(200, { 'content-type': 'text/javascript' });
            response.end(Buffer.concat([control.client, Buffer.from(control.trailer)]));
        } else if (path === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<main>Synthetic Host</main>'); }
        else { response.writeHead(404); response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(async () => {
        remove(); server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const launch = new URL(`http://127.0.0.1:${address.port}/`);
    return { control, requests, launch, headers, graph, activate: () => onReady?.(),
        verify: (expectedHostBuildId?: string) => verifyDeploymentBuild({ launch, headers, localClient, expectedHostBuildId }) };
}

test('release verification admits the actual current client and running Host identity through the existing bootstrap', async t => {
    const value = await fixture(t); value.activate();
    const host = await value.verify(hostBuildId);
    assert.equal(host.ready, true);
    assert.deepEqual(host.hostIdentity, { status: 'verified', buildId: hostBuildId });
    const client = await value.verify();
    assert.equal(client.ready, true); assert.deepEqual(client.hostIdentity, { status: 'not-requested' });
    assert.deepEqual(value.requests, ['/', '/hapi-dsh/bootstrap', '/client.js', '/', '/hapi-dsh/bootstrap', '/client.js']);
});

test('a healthy old client fails both client-only and Host publication checks before smoke can run', async t => {
    const value = await fixture(t); value.activate();
    value.control.client = Buffer.from('window.oldWorkspace = true;\n');
    for (const expected of [undefined, hostBuildId]) {
        await assert.rejects(value.verify(expected), error => error instanceof DeploymentBuildMismatch && /stale client/.test(error.message));
    }
});

test('an unchanged client prefix cannot hide extra executable bytes behind its source-map trailer', async t => {
    const value = await fixture(t); value.activate();
    for (const trailer of ['\nwindow.extraCode = true;\n', '//# sourceMappingURL=/client.map\nwindow.extraCode = true;\n',
        '//# sourceMappingURL=/client.map\u2028window.extraCode=true;']) {
        value.control.trailer = trailer;
        await assert.rejects(value.verify(hostBuildId), error => error instanceof DeploymentBuildMismatch && /executable bytes/.test(error.message));
    }
    value.control.trailer = '';
    assert.equal((await value.verify(hostBuildId)).ready, true);
});

test('a current client cannot make an old or unidentified Host pass publication verification', async t => {
    const value = await fixture(t); value.activate();
    await assert.rejects(value.verify('b'.repeat(64)), error => error instanceof DeploymentBuildMismatch && /Host build identity/.test(error.message));
    value.control.legacyBootstrap = true;
    await assert.rejects(value.verify(hostBuildId), error => error instanceof DeploymentBuildMismatch && /Host build identity/.test(error.message));
});

test('the bootstrap build identity keeps authentication, readiness and no-store behavior for an HHPI-only Host', async t => {
    const value = await fixture(t);
    const route = new URL('/hapi-dsh/bootstrap', value.launch);
    const denied = await fetch(route);
    assert.equal(denied.status, 401); assert.equal(await denied.text(), '');
    assert.equal((await value.verify(hostBuildId)).ready, false, 'a Host before appReady cannot pass release verification');
    value.activate();
    const admitted = await fetch(route, { headers: value.headers });
    assert.equal(admitted.headers.get('cache-control'), 'no-store');
    const payload = await admitted.json() as { hostBuildId: string; graph: unknown; globals: unknown };
    assert.equal(payload.hostBuildId, hostBuildId);
    assert.deepEqual(payload.graph, value.graph);
    assert.deepEqual(payload.globals, { __DSH_CONNECTION_RECOVERY__: { backoffBaseMs: 200 } });
    const method = await fetch(route, { method: 'POST', headers: value.headers });
    assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
});
