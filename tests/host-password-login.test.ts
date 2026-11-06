import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { mountPasswordLogin } from '../src/shared/password-login.ts';

// HTTP contract fixture: Connection's signing and Host policy are a boundary double.
// Production acceptance separately exercises the installed official Connection.
async function fixture(t: TestContext) {
    const dir = await mkdtemp('/mnt/cache/data-cache/password-login-test-');
    const password = randomUUID(), routes = new Map<string, WebRoute['handler']>();
    await writeFile(join(dir, 'password'), password, { mode: 0o600 });
    await writeFile(join(dir, 'index.html'), '<html><head></head><body>official fixture</body></html>');
    let exchanges = 0;
    const dispose = await mountPasswordLogin({ webServer: {
        register(route) { assert.ok('handler' in route); routes.set(route.path, route.handler); return () => { routes.delete(route.path); }; },
        renderIndex(html) { return html.replace('</head>', '<script src="official.js"></script></head>'); },
    }, connection: {
        browserPeer: { principal: { kind: 'owner' } } as import('@deepseek-ai/dsh-typert-protocol').PeerScope,
        requestRejection(req) {
            const headers = req.headers as Record<string, string | undefined>;
            return headers.host?.startsWith('127.0.0.1:') ? headers.cookie === 'official=accepted' ? undefined : 401 : 403;
        },
        authenticatedUrl(base) { const url = new URL(base); url.searchParams.set('token', 'fixture-launch-secret'); return url.href; },
        authorizeIndex(req, res) {
            if (req.url?.includes('token=fixture-launch-secret')) {
                exchanges++; res.writeHead(303, { location: './', 'set-cookie': 'official=accepted; Max-Age=86400; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict' }); res.end(); return false;
            }
            if ((req.headers as Record<string, string>).cookie === 'official=accepted') return true;
            res.writeHead(401); res.end(); return false;
        },
    } }, join(dir, 'password'), join(dir, 'index.html'));
    const server = createServer((req, res) => {
        const handler = routes.get(new URL(req.url!, 'http://fixture').pathname);
        if (handler) Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end(); });
        else { res.writeHead(401); res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true }); });
    return { origin, password, get exchanges() { return exchanges; },
        get: (path: string, headers = {}) => fetch(origin + path, { headers, redirect: 'manual' }),
        post: (path: string, body: string, headers = {}) => fetch(origin + path, { method: 'POST', body,
            headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers }, redirect: 'manual' }),
    };
}

test('anonymous index shows only the password form while protected endpoints stay denied', async t => {
    const env = await fixture(t), response = await env.get('/');
    assert.equal(response.status, 200); const html = await response.text();
    assert.match(html, /autocomplete="current-password"/); assert.doesNotMatch(html, /official\.js|fixture-launch-secret/);
    assert.ok(!html.includes(env.password)); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin', 'native browser forms must preserve their POST Origin');
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await env.get('/api/session/list')).status, 401);
});

test('incorrect password never exchanges a credential and the page offers another attempt', async t => {
    const env = await fixture(t), response = await env.post('/login', 'password=incorrect');
    assert.equal(response.status, 401); assert.match(await response.text(), /role="alert"/);
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(env.exchanges, 0);
});

test('successful login delegates to Connection without returning a launch token', async t => {
    const env = await fixture(t), response = await env.post('/login', new URLSearchParams({ password: env.password }).toString());
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), './');
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal(await response.text(), ''); assert.equal(env.exchanges, 1);
    const index = await env.get('/', { cookie: 'official=accepted' });
    assert.match(await index.text(), /official\.js/);
});

test('foreign Origin, authority, malformed bodies and repeated password fields cannot log in', async t => {
    const env = await fixture(t), body = new URLSearchParams({ password: env.password }).toString();
    assert.equal((await env.post('/login', body, { origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await env.post('/login', body, { origin: '' })).status, 403);
    assert.equal(await new Promise<number | undefined>((resolve, reject) => {
        request(env.origin, { headers: { host: 'foreign.invalid' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
    }), 403);
    assert.equal((await env.post('/login', body, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await env.post('/login', body + '&' + body)).status, 401);
    assert.equal((await env.post('/login', 'password=' + 'x'.repeat(8192))).status, 413);
    assert.equal(env.exchanges, 0);
});

test('failed attempts are bounded and cannot mint cookies', async t => {
    const env = await fixture(t);
    for (let i = 0; i < 30; i++) assert.equal((await env.post('/login', 'password=wrong')).status, 401);
    const limited = await env.post('/login', new URLSearchParams({ password: env.password }).toString());
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60'); assert.equal(env.exchanges, 0);
});

test('sign out requires same-origin authenticated POST and expires the official cookie', async t => {
    const env = await fixture(t);
    assert.equal((await env.get('/login/logout', { cookie: 'official=accepted' })).status, 405);
    assert.equal((await env.post('/login/logout', '')).status, 403);
    assert.equal((await env.post('/login/logout', '', { cookie: 'official=accepted', origin: 'https://foreign.invalid' })).status, 403);
    const page = await env.get('/login', { cookie: 'official=accepted' }); assert.match(await page.text(), /退出登录/);
    const response = await env.post('/login/logout', '', { cookie: 'official=accepted' });
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/login');
    assert.match(response.headers.get('set-cookie')!, /^official=; Max-Age=0; Path=\/; Expires=Thu, 01 Jan 1970/);
    assert.equal((await env.get('/api/session/list')).status, 401);
});
