/** Real private SQLite/service behavior; only the external Push transport and source ACL are fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppNotification } from '../src/notification-types.ts';
import { appScopeKey, type AppAccountScope, type AppServiceContext } from '../src/workspace/app-service-types.ts';
import { AppNotificationService, PushTransportError, createWebPushTransport, type AppPushPayload, type AppPushTransport,
    type NotificationServiceOptions } from '../src/workspace/notification-service.ts';
import { NotificationStore } from '../src/workspace/notification-store.ts';

const scope = { accountId: 'one', origin: 'https://workspace.example' };
const other = { ...scope, accountId: 'two' };
const anotherOrigin = { ...scope, origin: 'https://another.example' };
const source = { kind: 'local-dsh' as const, hostId: 'local', sessionId: 'native-session' };
const subscription = (name = 'one', expirationTime?: number) => ({ endpoint: `https://push.example/${name}`,
    keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(24) }, ...(expirationTime === undefined ? {} : { expirationTime }) });
function notification(id = 'notice-one', account = scope, createdAt = 1000): AppNotification {
    return { id, scope: account, kind: 'completed', target: { kind: 'reading', source, position: { kind: 'dsh', seq: 40 } },
        title: 'Private source title', body: 'Private source details must not reach the background payload', createdAt };
}
function fixture(path = ':memory:', overrides: Partial<NotificationServiceOptions> = {}, configured = true) {
    let now = 1000, authorized = true, admitted = true;
    let dispatch: AppPushTransport['send'] = async () => {};
    const sent: Array<{ endpoint: string; payload: AppPushPayload; signal: AbortSignal }> = [], checked: string[] = [];
    const context = (account: AppAccountScope = scope): AppServiceContext => ({ scope: account, authorizeSource(route) {
        checked.push(route.sessionId); if (!authorized) throw new Error('Source access revoked');
    } });
    const store = new NotificationStore(path);
    const transport: AppPushTransport = { publicKey: 'public-vapid', async send(value, payload, options) {
        sent.push({ endpoint: value.endpoint, payload, signal: options.signal }); await dispatch(value, payload, options);
    } };
    const service = new AppNotificationService({ store, now: () => now, ...(configured ? { transport } : {}),
        contextForScope: account => admitted ? context(account) : null, requestState: () => 'settled',
        ...overrides, limits: { retryMs: 10, maxRetryMs: 100, concurrency: 1, ...overrides.limits } });
    return { store, service, sent, checked, context, setNow(value: number) { now = value; },
        setAuthorized(value: boolean) { authorized = value; }, setAdmitted(value: boolean) { admitted = value; },
        setDispatch(value: AppPushTransport['send']) { dispatch = value; } };
}
async function directory(run: (path: string) => Promise<void>): Promise<void> {
    await mkdir('/mnt/cache/data-cache', { recursive: true });
    const path = await mkdtemp('/mnt/cache/data-cache/hhpi-notification-');
    try { await run(join(path, 'notifications.sqlite')); } finally { await rm(path, { recursive: true, force: true }); }
}

test('an endpoint moves atomically to the new account while other origins and private targets remain isolated', async () => {
    const f = fixture();
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        await f.service.publish(f.context(), notification());
        f.service.appPushSubscribe(f.context(other), { deviceId: 'browser-two', subscription: subscription() });
        f.service.appPushSubscribe(f.context(anotherOrigin), { deviceId: 'browser', subscription: subscription() });
        assert.equal((await f.service.deliveryStates(f.context(), 'notice-one'))[0]?.state, 'cancelled');
        assert.equal(f.store.subscriptions(scope, 1000).length, 0);
        await f.service.publish(f.context(other), notification('new-account', other));
        await f.service.publish(f.context(anotherOrigin), notification('another-origin', anotherOrigin));
        assert.equal(await f.service.drain(), 2);
        assert.deepEqual(new Set(f.sent.map(value => appScopeKey(value.payload.data.scope))), new Set([appScopeKey(other), appScopeKey(anotherOrigin)]));
        assert.equal(JSON.stringify(f.sent).includes('Private source'), false);
        assert.equal(JSON.stringify(f.sent).includes('native-session'), false);
        await assert.rejects(f.service.appNotificationResolve(f.context(other), { deviceId: 'browser', notificationId: 'notice-one' }), /current account/);
    } finally { await f.service.close(); }
});

test('late unsubscribe cannot delete a replacement endpoint or another account subscription', async () => {
    const f = fixture();
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription('old') });
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription('new') });
        f.service.appPushUnsubscribe(f.context(), { deviceId: 'browser', endpoint: subscription('old').endpoint });
        f.service.appPushUnsubscribe(f.context(other), { deviceId: 'browser', endpoint: subscription('new').endpoint });
        assert.equal(f.store.subscriptions(scope, 1000)[0]?.subscription.endpoint, subscription('new').endpoint);
        f.service.appPushUnsubscribe(f.context(), { deviceId: 'browser', endpoint: subscription('new').endpoint });
        assert.equal(f.store.subscriptions(scope, 1000).length, 0);
    } finally { await f.service.close(); }
});

test('notification identity is durable, duplicate publication does not replay, and changed targets cannot reuse the identity', () => directory(async path => {
    let f = fixture(path);
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        assert.deepEqual(await f.service.publish(f.context(), notification()), { created: true, queued: 1 });
        assert.deepEqual(await f.service.publish(f.context(), notification()), { created: false, queued: 0 });
        await assert.rejects(f.service.publish(f.context(), { ...notification(), target: { kind: 'reading', source: { ...source, sessionId: 'another-session' }, position: { kind: 'dsh', seq: 40 } } }), /another event/);
        await f.service.drain(); assert.equal(f.sent.length, 1);
        await f.service.close();
        f = fixture(path);
        assert.deepEqual(await f.service.publish(f.context(), notification()), { created: false, queued: 0 });
        assert.equal(await f.service.drain(), 0);
        assert.equal((await f.service.deliveryStates(f.context(), 'notice-one'))[0]?.state, 'submitted');
        assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally { await f.service.close(); }
}));

test('temporary provider failures persist only bounded channel retries across restart and honor Retry-After', () => directory(async path => {
    let f = fixture(path);
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        await f.service.publish(f.context(), notification());
        f.setDispatch(async () => { throw new PushTransportError(429, 50); });
        await f.service.drain();
        assert.deepEqual((await f.service.deliveryStates(f.context(), 'notice-one'))[0], {
            notificationId: 'notice-one', deviceId: 'browser', state: 'pending', attempts: 1, nextAttemptAt: 1050, submittedAt: null, reason: null });
        await f.service.close(); f = fixture(path);
        f.setNow(1049); assert.equal(await f.service.drain(), 0);
        f.setNow(1050); assert.equal(await f.service.drain(), 1);
        assert.equal(f.sent.length, 1);
        const state = (await f.service.deliveryStates(f.context(), 'notice-one'))[0]!;
        assert.equal(state.state, 'submitted'); assert.equal(state.attempts, 2);
        assert.equal('displayed' in state, false, 'provider acceptance never claims an OS display or read');
    } finally { await f.service.close(); }
}));

test('provider/network retry exhaustion becomes a durable terminal state rather than an infinite resend loop', async () => {
    const f = fixture(':memory:', { limits: { maxAttempts: 2 } });
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        await f.service.publish(f.context(), notification());
        f.setDispatch(async () => { throw new Error('Synthetic network failure with private provider details'); });
        await f.service.drain(); f.setNow(1010); await f.service.drain(); f.setNow(2000); await f.service.drain();
        assert.equal(f.sent.length, 2);
        assert.equal((await f.service.deliveryStates(f.context(), 'notice-one'))[0]?.reason, 'retry-exhausted');
    } finally { await f.service.close(); }
});

test('expired and provider-gone subscriptions are removed and no longer receive later events', async () => {
    const f = fixture();
    try {
        assert.throws(() => f.service.appPushSubscribe(f.context(), { deviceId: 'already-expired', subscription: subscription('expired', 999) }), /expired/);
        f.service.appPushSubscribe(f.context(), { deviceId: 'expires', subscription: subscription('expires', 1010) });
        f.service.appPushSubscribe(f.context(), { deviceId: 'gone', subscription: subscription('gone') });
        await f.service.publish(f.context(), notification());
        f.setNow(1010); f.setDispatch(async () => { throw new PushTransportError(410); });
        await f.service.drain();
        assert.equal(f.sent.length, 1); assert.equal(f.sent[0]?.endpoint, subscription('gone').endpoint);
        assert.equal(f.store.subscriptions(scope, 1010).length, 0);
        assert.ok((await f.service.deliveryStates(f.context(), 'notice-one')).every(value => value.reason === 'expired'));
        assert.deepEqual(await f.service.publish(f.context(), notification('later')), { created: true, queued: 0 });
    } finally { await f.service.close(); }
});

test('permanent provider rejection does not retry and does not erase an otherwise valid subscription', async () => {
    const f = fixture();
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        await f.service.publish(f.context(), notification()); f.setDispatch(async () => { throw new PushTransportError(403); });
        await f.service.drain(); f.setNow(2000); await f.service.drain();
        assert.equal(f.sent.length, 1); assert.equal(f.store.subscriptions(scope, 2000).length, 1);
        assert.equal((await f.service.deliveryStates(f.context(), 'notice-one'))[0]?.reason, 'rejected');
    } finally { await f.service.close(); }
});

test('background delivery rechecks source/account access after enqueue without calling any execution operation', async () => {
    const f = fixture();
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        await f.service.publish(f.context(), notification()); f.setAuthorized(false);
        await f.service.drain(); assert.equal(f.sent.length, 0);
        assert.equal(f.store.deliveries(scope, 'notice-one')[0]?.reason, 'source-revoked');
        f.setAuthorized(true); await f.service.publish(f.context(), notification('account-revoked')); f.setAdmitted(false);
        await f.service.drain(); assert.equal(f.sent.length, 0);
        assert.equal(f.store.deliveries(scope, 'account-revoked')[0]?.reason, 'scope-revoked');
    } finally { await f.service.close(); }
});

test('exact old requests resolve as settled and source/account revocation prevents returning their target', async () => {
    const f = fixture();
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        const request: AppNotification = { ...notification(), kind: 'request', target: { kind: 'request', source,
            position: { kind: 'dsh', seq: 40 }, requestId: 'old-request' } };
        await f.service.publish(f.context(), request);
        assert.deepEqual(await f.service.appNotificationResolve(f.context(), { deviceId: 'browser', notificationId: request.id }), { target: request.target, requestState: 'settled' });
        await assert.rejects(f.service.appNotificationResolve(f.context(other), { deviceId: 'browser', notificationId: request.id }), /current account/);
        f.setAuthorized(false);
        await assert.rejects(f.service.appNotificationResolve(f.context(), { deviceId: 'browser', notificationId: request.id }), /Source access revoked/);
    } finally { await f.service.close(); }
});

test('unsubscribe aborts an in-flight delivery and its late success cannot resurrect the revoked record', async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        await f.service.publish(f.context(), notification());
        f.setDispatch(async () => { entered.resolve(); await reply.promise; });
        const pending = f.service.drain(); await entered.promise;
        f.service.appPushUnsubscribe(f.context(), { deviceId: 'browser', endpoint: subscription().endpoint });
        await pending; assert.equal(f.sent[0]?.signal.aborted, true);
        reply.resolve(); await Promise.resolve();
        assert.equal(f.store.deliveries(scope, 'notice-one')[0]?.state, 'cancelled');
        assert.equal(f.store.deliveries(scope, 'notice-one')[0]?.submittedAt, null);
    } finally { reply.resolve(); await f.service.close(); }
});

test('a leased attempt from a stopped Host recovers after its bounded lease, while two live stores cannot claim it together', () => directory(async path => {
    const original = fixture(path);
    original.service.appPushSubscribe(original.context(), { deviceId: 'browser', subscription: subscription() });
    await original.service.publish(original.context(), notification());
    assert.equal(original.store.claimDue(1000, 1, 100, 4).length, 1);
    await original.service.close();
    const a = fixture(path), b = fixture(path), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
    try {
        a.setNow(1099); assert.equal(await a.service.drain(), 0);
        a.setNow(1100); b.setNow(1100);
        a.setDispatch(async () => { entered.resolve(); await reply.promise; });
        const pending = a.service.drain(); await entered.promise;
        assert.equal(await b.service.drain(), 0);
        reply.resolve(); await pending;
        assert.equal(a.sent.length + b.sent.length, 1);
        assert.equal(a.store.deliveries(scope, 'notice-one')[0]?.attempts, 2);
    } finally { reply.resolve(); await a.service.close(); await b.service.close(); }
}));

test('Host shutdown releases a pending background authorization and leaves its bounded retry durable', { timeout: 2000 }, () => directory(async path => {
    const entered = Promise.withResolvers<void>(), authorization = Promise.withResolvers<AppServiceContext | null>();
    const f = fixture(path, { contextForScope() { entered.resolve(); return authorization.promise; } });
    f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
    await f.service.publish(f.context(), notification());
    const pending = f.service.drain(); await entered.promise;
    await f.service.close(); await pending;
    authorization.resolve(f.context());
    const reopened = new NotificationStore(path);
    try {
        assert.equal(reopened.deliveries(scope, 'notice-one')[0]?.state, 'pending');
        assert.equal(reopened.deliveries(scope, 'notice-one')[0]?.attempts, 1);
        assert.equal(f.sent.length, 0);
    } finally { reopened.close(); }
}));

test('retention, queue batches and subscription limits bound work and rollback failed account transfers', async () => {
    const f = fixture(':memory:', { limits: { maxSubscriptions: 1, maxNotifications: 3, batchSize: 2, retentionMs: 100 } });
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        f.service.appPushSubscribe(f.context(other), { deviceId: 'other-browser', subscription: subscription('other') });
        assert.throws(() => f.service.appPushSubscribe(f.context(other), { deviceId: 'overflow', subscription: subscription() }), /limit/);
        assert.equal(f.store.subscriptions(scope, 1000).length, 1, 'failed endpoint transfers roll back the original registration');
        for (let i = 0; i < 4; i++) await f.service.publish(f.context(), notification(`notice-${i}`, scope, 1000 + i));
        assert.equal(f.store.notification(scope, 'notice-0'), null);
        assert.equal(await f.service.drain(), 2); assert.equal(f.sent.length, 2);
        f.setNow(1104); await f.service.drain();
        assert.equal(f.sent.length, 2); assert.equal(f.store.notification(scope, 'notice-3'), null);
    } finally { await f.service.close(); }
});

test('logout revokes only the authenticated account/origin and cancels its pending channel work', async () => {
    const f = fixture();
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'one', subscription: subscription() });
        f.service.appPushSubscribe(f.context(other), { deviceId: 'two', subscription: subscription('two') });
        await f.service.publish(f.context(), notification());
        f.service.revokeScope(f.context());
        assert.equal(f.store.subscriptions(scope, 1000).length, 0);
        assert.equal(f.store.subscriptions(other, 1000).length, 1);
        assert.equal(await f.service.drain(), 0);
        assert.equal(f.store.deliveries(scope, 'notice-one')[0]?.reason, 'revoked');
    } finally { await f.service.close(); }
});

test('missing Push configuration is explicit and cannot produce a fake successful browser registration', async () => {
    const f = fixture(':memory:', {}, false);
    try {
        const settings = f.service.appNotificationSettings(f.context(), { deviceId: 'browser' });
        assert.equal(settings.vapidPublicKey, null); assert.match(settings.pushError!, /not configured/);
        assert.throws(() => f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() }), /not configured/);
        assert.equal(await f.service.drain(), 0);
    } finally { await f.service.close(); }
});

test('the production web-push adapter binds independent server keys per call and sanitizes rejected provider details', async () => {
    let captured: Parameters<Parameters<typeof createWebPushTransport>[0]> | undefined;
    const keys = { subject: 'mailto:operator@example.com', publicKey: 'independent-public', privateKey: 'independent-private-never-log' };
    const transport = createWebPushTransport(async (...args) => { captured = args; throw { statusCode: 503, headers: { 'retry-after': '2' }, body: 'private-provider-response' }; }, keys);
    await assert.rejects(transport.send(subscription(), { title: 'Task completed', body: '', tag: 'notice',
        data: { type: 'app-notification', notificationId: 'notice', scope, deviceId: 'browser' } },
        { ttlSeconds: 30, timeoutMs: 1000, signal: new AbortController().signal }), error => {
        assert.ok(error instanceof PushTransportError); assert.equal(error.statusCode, 503); assert.equal(error.retryAfterMs, 2000);
        assert.equal(error.message.includes('private'), false); return true;
    });
    assert.equal(transport.publicKey, keys.publicKey);
    assert.deepEqual(captured?.[2], { TTL: 30, timeout: 1000, urgency: 'normal', vapidDetails: keys });
    assert.equal(JSON.stringify({ publicKey: transport.publicKey }).includes(keys.privateKey), false);
});

test('server-only VAPID material is absent from persisted notifications and public settings', () => directory(async path => {
    const transport = createWebPushTransport(async () => {}, { subject: 'mailto:operator@example.com', publicKey: 'independent-public', privateKey: 'server-vapid-private-fixture' });
    const f = fixture(path, { transport });
    try {
        f.service.appPushSubscribe(f.context(), { deviceId: 'browser', subscription: subscription() });
        await f.service.publish(f.context(), notification()); await f.service.drain();
        assert.equal(JSON.stringify(f.service.appNotificationSettings(f.context(), { deviceId: 'browser' })).includes('server-vapid-private-fixture'), false);
        assert.equal((await readFile(path)).includes(Buffer.from('server-vapid-private-fixture')), false);
    } finally { await f.service.close(); }
}));
