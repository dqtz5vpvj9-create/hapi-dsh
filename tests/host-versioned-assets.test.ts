import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { mountVersionedAssets } from '../src/shared/versioned-assets.ts';

test('only versioned public assets receive immutable caching; index, mutable files and RPC remain untouched', async t => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hapi-assets-'), routes = new Map<string, WebRoute>();
    const file = 'index-CN7NIWNw.js', body = '/* original upstream bytes */ window.fixture = "会话";';
    await writeFile(join(directory, file), body);
    await writeFile(join(directory, 'config.js'), 'mutable');
    await writeFile(join(directory, 'index.html'), 'authenticated index');
    const dispose = await mountVersionedAssets({ register: route => {
        routes.set(route.path, route); return () => { routes.delete(route.path); };
    } }, directory);
    const server = createServer((req, res) => {
        const route = routes.get(req.url!);
        if (route) void route.handler(req, res);
        else { res.writeHead(401); res.end('Original authenticated fallback'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/assets/${file}`;
    const response = await fetch(url);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(await head.text(), ''); assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(body));
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    for (const path of ['/', '/index.html', '/assets/config.js', '/api/session/list']) {
        const untouched = await fetch(new URL(path, url));
        assert.equal(untouched.status, 401); assert.equal(untouched.headers.get('cache-control'), null);
    }
    await rm(join(directory, file));
    const missing = await fetch(url);
    assert.equal(missing.status, 404); assert.equal(missing.headers.get('cache-control'), 'no-store');
    dispose(); assert.equal(routes.size, 0);
});
