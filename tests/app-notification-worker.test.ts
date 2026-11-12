/** Execute the emitted application worker at browser API boundaries; this is not real provider/OS evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { buildAppNotificationWorker, normalizedAppPath } from '../src/notifications/worker.ts';
import type { AppNotificationReference } from '../src/notification-types.ts';

const reference: AppNotificationReference = { type: 'app-notification', notificationId: 'original-notification', deviceId: 'original-browser',
    scope: { accountId: 'original-account', origin: 'https://workspace.fixture' } };
interface EventRecord { waitUntil?(promise: Promise<unknown>): void; [key: string]: unknown }
function fixture() {
    const handlers = new Map<string, (event: EventRecord) => void>();
    const shown: Array<{ title: string; options: { body: string; icon: string; data: AppNotificationReference; tag: string } }> = [];
    const opened: string[] = [], windows: Array<{ url: string; focus(): Promise<void>; postMessage(value: unknown, ports: MessagePort[]): void }> = [];
    let activated = 0;
    const self = { location: { origin: reference.scope.origin },
        addEventListener(type: string, listener: (event: EventRecord) => void) { handlers.set(type, listener); },
        clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } },
        registration: { showNotification: async (title: string, options: (typeof shown)[number]['options']) => { shown.push({ title, options }); } },
        skipWaiting: async () => { activated++; } };
    runInNewContext(buildAppNotificationWorker('/dsh/'), { self, URL, Response, Blob, MessageChannel, setTimeout, clearTimeout });
    return { handlers, shown, opened, windows, activated: () => activated, async dispatch(type: string, value: EventRecord = {}) {
        const tasks: Promise<unknown>[] = []; handlers.get(type)?.({ ...value, waitUntil(task) { tasks.push(task); } }); await Promise.all(tasks);
    } };
}

test('application Push keeps a bounded opaque account/device reference and ignores arbitrary target URLs', async () => {
    const f = fixture();
    await f.dispatch('push', { data: { json: () => ({ title: 't'.repeat(400), body: 'b'.repeat(2000), url: 'https://attacker.invalid/',
        data: { ...reference, target: { sessionId: 'attacker-session' } } }) } });
    assert.equal(f.shown[0]?.title.length, 256); assert.equal(f.shown[0]?.options.body.length, 1024);
    assert.equal(f.shown[0]?.options.icon, 'https://workspace.fixture/dsh/favicon.svg');
    assert.deepEqual(JSON.parse(JSON.stringify(f.shown[0]?.options.data)), reference);
    await f.dispatch('push', { data: { json: () => ({ data: { ...reference, scope: { ...reference.scope, origin: 'https://foreign.invalid' } } }) } });
    await f.dispatch('push', { data: { json: () => ({ data: { hubId: 'legacy-hub', sessionId: 'legacy-session' } }) } });
    assert.equal(f.shown.length, 1);
});

test('existing workspace acknowledges the exact stored reference before focus without replacing unsaved pages', async () => {
    const f = fixture(), received: unknown[] = []; let focused = 0;
    f.windows.push({ url: 'https://foreign.invalid/dsh/', focus: async () => assert.fail(), postMessage: () => assert.fail() });
    f.windows.push({ url: 'https://workspace.fixture/dsh/?draft=kept', focus: async () => { focused++; }, postMessage(value, ports) {
        received.push(value); ports[0]!.postMessage({ opened: true }); ports[0]!.close();
    } });
    await f.dispatch('notificationclick', { notification: { data: reference, close() {} } });
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [reference]); assert.equal(focused, 1); assert.deepEqual(f.opened, []);
});

test('unauthenticated or declined navigation opens a local URL retaining the original reference through login', async () => {
    const f = fixture();
    f.windows.push({ url: 'https://workspace.fixture/dsh/', focus: async () => assert.fail(), postMessage(_value, ports) {
        ports[0]!.postMessage({ opened: false }); ports[0]!.close();
    } });
    await f.dispatch('notificationclick', { notification: { data: { ...reference, url: 'https://foreign.invalid/' }, close() {} } });
    const url = new URL(f.opened[0]!);
    assert.equal(url.origin, reference.scope.origin); assert.equal(url.pathname, '/dsh/');
    assert.equal(url.searchParams.get('hhpiNotification'), reference.notificationId);
    assert.equal(url.searchParams.get('hhpiAccount'), reference.scope.accountId); assert.equal(url.searchParams.get('hhpiDevice'), reference.deviceId);
    assert.equal(url.searchParams.has('hapiSession'), false);
});

test('worker identity and explicit activation stay inside the same application and invalid clicks cannot navigate', async () => {
    const f = fixture(), replies: unknown[] = [], port = { postMessage(value: unknown) { replies.push(value); } };
    await f.dispatch('install'); assert.equal(f.activated(), 0);
    await f.dispatch('message', { data: { type: 'hhpi/app-notifications/info' }, source: { url: 'https://foreign.invalid/dsh/' }, ports: [port] });
    assert.deepEqual(replies, []);
    await f.dispatch('message', { data: { type: 'hhpi/app-notifications/info' }, source: { url: 'https://workspace.fixture/dsh/' }, ports: [port] });
    assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ version: 1, appPath: '/dsh/' }]);
    await f.dispatch('notificationclick', { notification: { data: { ...reference, deviceId: '\0invalid' }, close() {} } });
    assert.deepEqual(f.opened, []);
    await f.dispatch('message', { data: { type: 'SKIP_WAITING' }, source: { url: 'https://workspace.fixture/other/' } });
    assert.equal(f.activated(), 0);
    await f.dispatch('message', { data: { type: 'SKIP_WAITING' }, source: { url: 'https://workspace.fixture/dsh/' } });
    assert.equal(f.activated(), 1);
    await f.dispatch('fetch', { request: { method: 'GET', url: 'https://workspace.fixture/dsh/api/events' }, respondWith() { assert.fail('Ordinary API requests are not intercepted'); } });
});

test('application scope rejects foreign origins, noncanonical paths and URL controls', () => {
    for (const path of ['//foreign.invalid/', '/a/../b/', '/a/?key=', '/a/#hash', '/a/\\b/', '/a/ b/', 'relative/']) assert.throws(() => normalizedAppPath(path));
    assert.equal(normalizedAppPath('/'), '/'); assert.equal(normalizedAppPath('/a/b/'), '/a/b/');
});

test('the combined worker never intercepts ordinary documents or authenticated APIs and only owns its exact same-origin share POST', async () => {
    const runtime = fixture(); assert.equal(runtime.handlers.has('fetch'), true);
    const passthrough = [
        ['GET', 'https://workspace.fixture/dsh/'], ['GET', 'https://workspace.fixture/dsh/hapi-dsh/share'],
        ['POST', 'https://workspace.fixture/dsh/api/session/prompt'], ['POST', 'https://workspace.fixture/dsh/api/auth'],
        ['GET', 'https://workspace.fixture/dsh/api/events'], ['POST', 'https://workspace.fixture/other/hapi-dsh/share'],
        ['POST', 'https://foreign.invalid/dsh/hapi-dsh/share'], ['DELETE', 'https://workspace.fixture/dsh/hapi-dsh/share'],
    ];
    for (const [method, url] of passthrough) await runtime.dispatch('fetch', { request: { method, url }, respondWith() { assert.fail(`A worker cannot intercept ${method} ${url}`); } });
    let response: Promise<Response> | undefined;
    await runtime.dispatch('fetch', { request: new Request('https://workspace.fixture/dsh/hapi-dsh/share', { method: 'POST', body: 'invalid multipart' }),
        respondWith(value: Promise<Response>) { response = value; } });
    assert.ok(response); const result = await response; assert.equal(result.status, 303);
    const location = new URL(result.headers.get('location')!);
    assert.equal(location.origin, 'https://workspace.fixture'); assert.equal(location.pathname, '/dsh/'); assert.equal(location.searchParams.get('hapiShareError'), 'ingest');
});
