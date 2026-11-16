/** Real HTTP admission; the Remote credential issuer is the explicit fixture boundary. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { mountRemoteCarrier, type RemoteCarrierConfig } from '../src/shared/remote-carrier.ts';
import { createConfig, parseConfig } from '../src/cli/config.ts';

const config: RemoteCarrierConfig = { serverUrl: 'https://remote.example.test', hosts: [
    { hostId: 'local', deviceId: '01900000-0000-7000-8000-000000000001', identityKey: 'A'.repeat(43) },
] };
async function fixture(t: TestContext, enabled = true) {
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
    const calls: unknown[] = []; let failure: unknown;
    const dispose = mountRemoteCarrier({ webServer: { register(route) { routes.set(route.path, route.handler); return () => { routes.delete(route.path); }; } },
        connection: { requestRejection: req => req.headers.cookie === 'owner=yes' ? undefined : 401 },
        runtime: () => ({ async registerOwnedClient(descriptor) {
            calls.push(descriptor); if (failure) throw failure;
            return { serverUrl: config.serverUrl, deviceId: 'client-id', identityKey: 'client-key', account: 'owner', tokens: { accessToken: 'client-only' } };
        } }),
    }, enabled ? config : undefined);
    const server = createServer((req, res) => { const route = routes.get(req.url!); if (route) route(req, res); else { res.writeHead(404); res.end(); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    return { calls, fail(value: unknown) { failure = value; },
        post: (action: string, body = '{}', headers: Record<string, string> = {}) => fetch(`${origin}/hapi-dsh/remote/${action}`, {
            method: 'POST', body, headers: { cookie: 'owner=yes', 'content-type': 'application/json', ...headers },
        }),
    };
}

test('existing owner admission protects public bindings and enrollment, including CSRF', async t => {
    const env = await fixture(t);
    for (const action of ['describe', 'enroll']) {
        assert.equal((await env.post(action, '{}', { cookie: '' })).status, 401);
        assert.equal((await env.post(action, '{}', { origin: 'https://other.example.test' })).status, 403);
        assert.equal((await env.post(action, '{}', { 'sec-fetch-site': 'cross-site' })).status, 403);
        assert.equal((await env.post(action, '{}', { 'content-type': 'text/plain' })).status, 403);
    }
    assert.equal(env.calls.length, 0);
    const describe = await env.post('describe'); assert.equal(describe.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await describe.json(), { v: 1, ...config });
    const enrolled = await env.post('enroll', JSON.stringify({ name: '手机', role: 'client' }));
    assert.equal(enrolled.status, 200); assert.equal(enrolled.headers.get('cache-control'), 'no-store');
    assert.deepEqual(env.calls, [{ name: '手机', role: 'client' }]);
    assert.equal((await enrolled.json()).tokens.accessToken, 'client-only');
});

test('disabled carrier exposes no cutover and cannot enroll', async t => {
    const env = await fixture(t, false);
    assert.deepEqual(await (await env.post('describe')).json(), { v: 1, hosts: [] });
    assert.equal((await env.post('enroll')).status, 503); assert.equal(env.calls.length, 0);
});

test('malformed or oversized enrollment never reaches issuer; failed issuance is not replayed or reflected', async t => {
    const env = await fixture(t);
    assert.equal((await env.post('enroll', '{')).status, 400);
    assert.equal((await env.post('enroll', JSON.stringify({ name: 'a'.repeat(8192) }))).status, 413);
    assert.equal(env.calls.length, 0);
    env.fail(Object.assign(new Error('private-issuer-secret'), { code: 'CONNECTION_FAILED' }));
    const failed = await env.post('enroll'); assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { code: 'CONNECTION_FAILED' }); assert.equal(env.calls.length, 1);
});

test('cutover config requires unique old Host and Remote identities', () => {
    const base = createConfig(); assert.deepEqual(parseConfig({ ...base, remote: config }).remote, config);
    assert.throws(() => parseConfig({ ...base, remote: { ...config, hosts: [...config.hosts, ...config.hosts] } }));
    assert.throws(() => parseConfig({ ...base, remote: { ...config, serverUrl: 'https://remote.example.test/path' } }));
    assert.throws(() => parseConfig({ ...base, remote: { ...config, hosts: [{ ...config.hosts[0], identityKey: '' }] } }));
});
