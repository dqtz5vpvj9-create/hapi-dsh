/** Real authenticated HTTP/WebSocket carriers; the original Hub is an explicit protocol fixture. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { SourceNotificationsService, type SourceNotificationsClient } from '../src/hapi/source-notifications.ts';
import { HapiRequestError, type HapiEvent } from '../src/codex/contracts.ts';
import type { FederationMount } from '../src/hub/federation.ts';
import { NOTIFICATION_LEASE_MS, NOTIFICATIONS_STREAM_PATH, NOTIFICATIONS_WORKER_PATH, type NotificationFrame } from '../src/notification-types.ts';

function fixtureClient() {
    const calls: Array<{ path: string; options: Parameters<SourceNotificationsClient['request']>[1] }> = [];
    const visibility: Array<'visible' | 'hidden'> = [], listeners = new Set<(event: HapiEvent) => void>();
    let response: unknown = { ok: true }, failure: Error | undefined;
    const client: SourceNotificationsClient = {
        hubId: 'stable-fixture-hub', isConnected: true,
        request: async (path, options) => { calls.push({ path, options }); if (failure) throw failure; return path.endsWith('/vapid-public-key') ? { publicKey: 'fixture-public-vapid' } : response; },
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        setVisibility: async state => { visibility.push(state); },
    };
    return { client, calls, visibility, emit: (event: HapiEvent) => { for (const listener of listeners) listener(event); },
        respond(value: unknown) { response = value; }, fail(error: Error) { failure = error; }, listeners };
}
async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) { if (predicate()) return; await delay(5); }
    assert.fail('The authenticated notification fixture did not reach its expected state');
}
async function mount(service: SourceNotificationsService) {
    const routes = new Map<string, Parameters<FederationMount['webServer']['register']>[0]['handler']>();
    const upgrades = new Map<string, Parameters<FederationMount['webServer']['registerUpgrade']>[0]['handler']>();
    const http = createServer((request, reply) => {
        const handler = routes.get(new URL(request.url!, 'http://fixture').pathname);
        if (handler) void handler(request, reply); else { reply.writeHead(404); reply.end(); }
    });
    http.on('upgrade', (request, socket, head) => {
        const handler = upgrades.get(new URL(request.url!, 'http://fixture').pathname);
        if (handler) void handler(request, socket, head); else socket.destroy();
    });
    service.mount({ webServer: {
        register: route => { routes.set(route.path, route.handler); return () => { routes.delete(route.path); }; },
        registerUpgrade: route => { upgrades.set(route.path, route.handler); return () => { upgrades.delete(route.path); }; },
    }, authorize: request => request.headers.cookie === 'fixture=admitted' ? undefined : 401 });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`, peers: WebSocket[] = [];
    return { url, async browser() {
        const frames: NotificationFrame[] = [];
        const socket = new WebSocket(url.replace('http:', 'ws:') + NOTIFICATIONS_STREAM_PATH, { headers: { cookie: 'fixture=admitted' } });
        peers.push(socket); socket.on('message', bytes => { frames.push(JSON.parse(bytes.toString()) as NotificationFrame); });
        await once(socket, 'open'); await until(() => frames.some(frame => frame.type === 'ready'));
        return { socket, frames, presence: (visibility: 'visible' | 'hidden') => socket.send(JSON.stringify({ type: 'presence', visibility })) };
    }, async close() {
        for (const socket of peers) socket.terminate(); await service.close(); http.closeAllConnections();
        await new Promise<void>(resolve => http.close(() => resolve()));
    } };
}

test('Push methods preserve exact original paths and bodies, and an unknown admission is never retried or called subscribed', async () => {
    const fixture = fixtureClient(), service = new SourceNotificationsService(fixture.client);
    const subscription = { endpoint: 'https://push.fixture.invalid/opaque', keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(24) } };
    try {
        assert.deepEqual(await service.sourceNotificationSettings({}), { hubId: 'stable-fixture-hub', vapidPublicKey: 'fixture-public-vapid', workerPath: NOTIFICATIONS_WORKER_PATH, streamPath: NOTIFICATIONS_STREAM_PATH });
        assert.deepEqual(await service.sourcePushSubscribe(subscription), { subscribed: true });
        assert.deepEqual(await service.sourcePushUnsubscribe({ endpoint: subscription.endpoint }), { unsubscribed: true });
        assert.deepEqual(fixture.calls.map(call => [call.path, call.options?.method ?? 'GET', call.options?.body]), [
            ['/api/push/vapid-public-key', 'GET', undefined], ['/api/push/subscribe', 'POST', subscription], ['/api/push/subscribe', 'DELETE', { endpoint: subscription.endpoint }],
        ]);
        await assert.rejects(service.sourcePushSubscribe({ ...subscription, endpoint: 'http://push.fixture.invalid/opaque' }));
        assert.equal(fixture.calls.length, 3);
        fixture.respond({ ok: false });
        await assert.rejects(service.sourcePushSubscribe(subscription), error => error instanceof HapiRequestError && error.outcome === 'indeterminate');
        fixture.fail(new HapiRequestError('Fixture lost write acknowledgement', 'indeterminate', 401));
        await assert.rejects(service.sourcePushSubscribe(subscription), /lost write acknowledgement/);
        assert.equal(fixture.calls.filter(call => call.options?.method === 'POST').length, 3);
        const available = await service.sourceNotificationSettings({});
        assert.equal(available.vapidPublicKey, null); assert.equal(available.streamPath, NOTIFICATIONS_STREAM_PATH);
        assert.equal(available.hubId, 'stable-fixture-hub'); assert.match(available.pushError!, /original Hub could not provide/);
        assert.equal(available.pushError!.includes('Fixture lost write'), false);
        const aborted = new AbortController(); aborted.abort(new Error('Explicit cancelled settings read'));
        await assert.rejects(service.sourceNotificationSettings({}, aborted.signal), /Explicit cancelled/);
    } finally { await service.close(); }
});

test('one real visible browser lease controls original Hub visibility; hidden tabs receive no foreground toast and close releases the last lease', async () => {
    const fixture = fixtureClient(), service = new SourceNotificationsService(fixture.client), environment = await mount(service);
    try {
        const first = await environment.browser(), second = await environment.browser();
        assert.deepEqual(fixture.visibility, []);
        first.presence('visible'); await until(() => fixture.visibility.at(-1) === 'visible');
        second.presence('hidden'); await until(() => fixture.visibility.length === 2);
        assert.equal(fixture.visibility.at(-1), 'visible');
        fixture.emit({ type: 'toast', data: { title: 'Original task ready', body: 'Original machine answer', sessionId: 'source-one', url: 'https://untrusted.invalid/' } });
        await until(() => first.frames.some(frame => frame.type === 'toast'));
        assert.equal(second.frames.some(frame => frame.type === 'toast'), false);
        const toast = first.frames.find(frame => frame.type === 'toast'); assert.ok(toast?.type === 'toast');
        assert.deepEqual({ ...toast.notification, id: 'id', createdAt: 0 }, { id: 'id', createdAt: 0, hubId: 'stable-fixture-hub', sessionId: 'source-one', title: 'Original task ready', body: 'Original machine answer' });
        const ended = once(first.socket, 'close'); first.socket.close(); await ended;
        await until(() => fixture.visibility.at(-1) === 'hidden');
        second.presence('visible'); await until(() => fixture.visibility.at(-1) === 'visible');
        second.presence('hidden'); await until(() => fixture.visibility.at(-1) === 'hidden');
    } finally { await environment.close(); }
    assert.equal(fixture.visibility.at(-1), 'hidden'); assert.equal(fixture.listeners.size, 0);
});

test('a silent still-connected browser loses visibility after its lease expires; bad frames and unauthenticated clients cannot renew it', async context => {
    let now = Date.now(); context.mock.method(Date, 'now', () => now);
    const fixture = fixtureClient(), service = new SourceNotificationsService(fixture.client), environment = await mount(service);
    try {
        const denied = new WebSocket(environment.url.replace('http:', 'ws:') + NOTIFICATIONS_STREAM_PATH);
        const error = await once(denied, 'error'); assert.match(String(error[0]), /401/); denied.terminate();
        const browser = await environment.browser(); browser.presence('visible'); await until(() => fixture.visibility.at(-1) === 'visible');
        now += NOTIFICATION_LEASE_MS + 1;
        await until(() => fixture.visibility.at(-1) === 'hidden'); assert.equal(browser.socket.readyState, WebSocket.OPEN);
        fixture.emit({ type: 'toast', data: { title: 'Expired', body: '', sessionId: 'source-one', url: '/sessions/source-one' } });
        await delay(20); assert.equal(browser.frames.some(frame => frame.type === 'toast'), false);
        const ended = once(browser.socket, 'close'); browser.socket.send(JSON.stringify({ type: 'presence', visibility: 'visible', injected: true }));
        const [code] = await ended; assert.equal(code, 1008); assert.equal(fixture.visibility.at(-1), 'hidden');
    } finally { await environment.close(); }
});

test('public notification worker serves only bounded same-origin source navigation code and never credentials or an API cache', async () => {
    const fixture = fixtureClient(), environment = await mount(new SourceNotificationsService(fixture.client));
    try {
        const result = await fetch(environment.url + NOTIFICATIONS_WORKER_PATH + '?app=%2Fdsh%2F');
        assert.equal(result.status, 200); assert.match(result.headers.get('content-type')!, /javascript/);
        assert.equal(result.headers.get('service-worker-allowed'), '/');
        const code = await result.text(); assert.match(code, /stable-fixture-hub/); assert.match(code, /const HAPI_APP_PATH = "\/dsh\/"/);
        assert.doesNotMatch(code, /fixture=admitted|Authorization|Bearer |caches\./);
        assert.equal((await fetch(environment.url + NOTIFICATIONS_WORKER_PATH + '?app=%2F%2Fevil.invalid%2F')).status, 400);
        assert.equal((await fetch(environment.url + NOTIFICATIONS_WORKER_PATH, { method: 'POST' })).status, 405);
        const head = await fetch(environment.url + NOTIFICATIONS_WORKER_PATH, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
        assert.equal(fixture.calls.length, 0);
    } finally { await environment.close(); }
});
