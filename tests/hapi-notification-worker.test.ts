/** Execute the emitted worker against explicit browser protocol fixtures; no real Push provider is claimed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { buildNotificationWorker, normalizedAppPath } from '../src/notifications/worker.ts';

type EventRecord = { waitUntil?(promise: Promise<unknown>): void; [key: string]: unknown };
type WindowClient = { url: string; focus(): Promise<unknown>; postMessage(data: unknown, ports: MessagePort[]): void };
function worker() {
    const handlers = new Map<string, (event: EventRecord) => void>();
    const displayed: Array<{ title: string; options: { body: string; icon: string; data: { hubId: string; sessionId: string | null }; tag?: string } }> = [];
    const opened: string[] = [], windows: WindowClient[] = [];
    let claimed = 0, activated = 0;
    const self = { location: { origin: 'https://workspace.fixture' },
        addEventListener(type: string, listener: (event: EventRecord) => void) { handlers.set(type, listener); },
        clients: { claim: async () => { claimed++; }, matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } },
        registration: { showNotification: async (title: string, options: (typeof displayed)[number]['options']) => { displayed.push({ title, options }); } },
        skipWaiting: async () => { activated++; },
    };
    runInNewContext(buildNotificationWorker('stable-fixture-hub', '/dsh/'), { self, URL, Response, Blob, MessageChannel, setTimeout, clearTimeout });
    return { displayed, opened, windows, claimed: () => claimed, activated: () => activated,
        async dispatch(type: string, input: EventRecord = {}) { const pending: Promise<unknown>[] = []; handlers.get(type)?.({ ...input, waitUntil: promise => { pending.push(promise); } }); await Promise.all(pending); },
        handlers };
}

test('notification worker bounds visible payloads, ignores foreign URLs and uses source identity with a local icon', async () => {
    const runtime = worker();
    await runtime.dispatch('push', { data: { json: () => ({ title: 'Original title', body: 'b'.repeat(40_000), icon: 'https://foreign.invalid/tracker',
        data: { sessionId: 'source-one', url: 'https://foreign.invalid/redirect', hubId: 'attacker-hub' }, tag: 'g'.repeat(300) }) } });
    assert.equal(runtime.displayed.length, 1); const item = runtime.displayed[0]!;
    assert.equal(item.title, 'Original title'); assert.equal(item.options.body.length, 32_768); assert.equal(item.options.tag?.length, 256);
    assert.equal(item.options.icon, 'https://workspace.fixture/dsh/favicon.svg');
    assert.deepEqual(JSON.parse(JSON.stringify(item.options.data)), { hubId: 'stable-fixture-hub', sessionId: 'source-one' });
    await runtime.dispatch('push', { data: { json: () => ({ data: { sessionId: '\u0000bad' } }) } });
    assert.equal(runtime.displayed[1]!.options.data.sessionId, null);
    await runtime.dispatch('push', { data: { json: () => { throw new Error('Malformed Push'); } } });
    assert.equal(runtime.displayed.length, 2);
});

test('notification click opens the exact source through an acknowledged existing workspace without replacing its page', async () => {
    const runtime = worker(), messages: unknown[] = []; let focused = 0, closed = 0;
    runtime.windows.push({ url: 'https://foreign.invalid/dsh/', focus: async () => assert.fail('Foreign origins must not receive the notification'), postMessage: () => assert.fail('Foreign origin') });
    runtime.windows.push({ url: 'https://workspace.fixture/another-app/', focus: async () => assert.fail('Other app scopes must remain unchanged'), postMessage: () => assert.fail('Wrong scope') });
    runtime.windows.push({ url: 'https://workspace.fixture/dsh/?draft=preserved', focus: async () => { focused++; },
        postMessage(data, ports) { messages.push(data); ports[0]!.postMessage({ opened: true }); ports[0]!.close(); } });
    await runtime.dispatch('notificationclick', { notification: { data: { hubId: 'stable-fixture-hub', sessionId: 'source one/二' }, close() { closed++; } } });
    assert.equal(closed, 1); assert.equal(focused, 1); assert.deepEqual(runtime.opened, []);
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'hapi-dsh/notification-open', hubId: 'stable-fixture-hub', sessionId: 'source one/二' }]);
});

test('a declined workspace navigation opens a new local source URL; old-Hub notifications cannot navigate an identically named source', async () => {
    const runtime = worker(); let calls = 0;
    runtime.windows.push({ url: 'https://workspace.fixture/dsh/', focus: async () => assert.fail('A declined workspace must not be focused'),
        postMessage(_data, ports) { calls++; ports[0]!.postMessage({ opened: false }); ports[0]!.close(); } });
    await runtime.dispatch('notificationclick', { notification: { data: { hubId: 'stable-fixture-hub', sessionId: 'source one/二', url: 'https://foreign.invalid/' }, close() {} } });
    assert.equal(calls, 1); const target = new URL(runtime.opened[0]!);
    assert.equal(target.origin, 'https://workspace.fixture'); assert.equal(target.pathname, '/dsh/');
    assert.equal(target.searchParams.get('hapiSession'), 'source one/二'); assert.equal(target.searchParams.get('hapiHub'), 'stable-fixture-hub');
    await runtime.dispatch('notificationclick', { notification: { data: { hubId: 'previous-hub', sessionId: 'source one/二' }, close() {} } });
    assert.equal(calls, 1); assert.equal(runtime.opened[1], 'https://workspace.fixture/dsh/');
});

test('the worker confirms its own Hub only to its origin and scope, and never activates an update merely on installation', async () => {
    const runtime = worker(), replies: unknown[] = [];
    await runtime.dispatch('install'); assert.equal(runtime.activated(), 0);
    await runtime.dispatch('activate'); assert.equal(runtime.claimed(), 1);
    const port = { postMessage: (data: unknown) => { replies.push(data); } };
    await runtime.dispatch('message', { data: { type: 'hapi-dsh/notification-info' }, source: { url: 'https://foreign.invalid/dsh/' }, ports: [port] });
    await runtime.dispatch('message', { data: { type: 'SKIP_WAITING' }, source: { url: 'https://workspace.fixture/another/' }, ports: [] });
    assert.equal(replies.length, 0); assert.equal(runtime.activated(), 0);
    await runtime.dispatch('message', { data: { type: 'hapi-dsh/notification-info' }, source: { url: 'https://workspace.fixture/dsh/' }, ports: [port] });
    assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ hubId: 'stable-fixture-hub', appPath: '/dsh/' }]);
    await runtime.dispatch('message', { data: { type: 'SKIP_WAITING' }, source: { url: 'https://workspace.fixture/dsh/' }, ports: [] });
    assert.equal(runtime.activated(), 1);
    for (const path of ['//foreign.invalid/', '/a/../b/', '/a/?key=', '/a/#hash', '/a/\\b/', '/a/ b/', 'relative/']) assert.throws(() => normalizedAppPath(path));
    assert.equal(normalizedAppPath('/'), '/'); assert.equal(normalizedAppPath('/a/b/'), '/a/b/');
});

test('the combined worker never intercepts ordinary documents or authenticated APIs and only owns its exact same-origin share POST', async () => {
    const runtime = worker(); assert.equal(runtime.handlers.has('fetch'), true);
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
