/** Production contracts and authorization helpers; no external Push or native execution is invoked. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceSessionId } from '../src/remote/protocol.ts';
import { appNotificationSchema } from '../src/notification-types.ts';
import { appAccountScopeSchema, appDeviceKey, appEventPositionSchema, appNotificationTargetSchema, appOriginSchema,
    appPushRegistrationSchema, appReadStateSchema, appScopeKey, appServiceInputs, appServiceOutputs, appShareRecordSchema,
    appSourceKey, appSourceRouteSchema, authorizeAppRecord, authorizeAppTarget,
    type AppAccountScope, type AppNotificationTarget, type AppSourceRoute, type AppServiceContext,
} from '../src/workspace/app-service-types.ts';

const scope: AppAccountScope = { accountId: 'account-one', origin: 'https://workspace.example' };
const identity = { machineId: 'machine:one', sourceId: 'source/one', engine: 'codex', nativeId: 'native:one' };
const routes: AppSourceRoute[] = [
    { kind: 'local-dsh', hostId: 'local', sessionId: 'native-one' },
    { kind: 'federated-dsh', hostId: 'remote-one', sessionId: 'native-one' },
    { kind: 'hhpi', hostId: 'local', sessionId: sourceSessionId(identity), identity },
];
const position = (route: AppSourceRoute, seq = 40) => route.kind === 'hhpi'
    ? { kind: 'hhpi' as const, epoch: 'source-epoch-one', seq }
    : { kind: 'dsh' as const, seq };
const requestTarget = (route: AppSourceRoute): AppNotificationTarget => ({ kind: 'request', source: route,
    position: position(route), requestId: 'original-request' });
const subscription = { endpoint: 'https://push.example/browser-endpoint', keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(24) } };

test('application storage partitions repeated device/source IDs by account, origin and owning Host', () => {
    const otherAccount = { ...scope, accountId: 'account-two' };
    const otherOrigin = { ...scope, origin: 'https://second.example' };
    assert.equal(new Set([scope, otherAccount, otherOrigin].map(value => appScopeKey(value))).size, 3);
    assert.equal(new Set([scope, otherAccount, otherOrigin].map(value => appDeviceKey(value, 'same-device'))).size, 3);
    assert.equal(new Set(routes.map(route => appSourceKey(scope, route))).size, 3);
    assert.notEqual(appSourceKey(scope, routes[1]!), appSourceKey(scope, { ...routes[1]!, hostId: 'remote-two' }));
    assert.notEqual(appDeviceKey({ accountId: 'a:b', origin: scope.origin }, 'c'), appDeviceKey({ accountId: 'a', origin: scope.origin }, 'b:c'));
    assert.equal(appAccountScopeSchema.safeParse({ ...scope, token: 'not-an-account-identity' }).success, false);
});

test('application origins cannot become arbitrary navigation URLs or insecure remote origins', () => {
    for (const origin of [scope.origin, 'http://localhost:8100', 'http://127.0.0.1:8100', 'http://[::1]:8100']) assert.equal(appOriginSchema.safeParse(origin).success, true);
    for (const origin of ['http://remote.example', 'https://workspace.example/', 'https://workspace.example/path',
        'https://user:password@workspace.example', 'https://workspace.example?account=two', 'file:///workspace']) {
        assert.equal(appOriginSchema.safeParse(origin).success, false, origin);
    }
});

test('all native routes retain exact identity and cannot disguise an HHPI source as a DSH session', () => {
    for (const route of routes) assert.deepEqual(appSourceRouteSchema.parse(route), route);
    const hhpi = routes[2]!;
    assert.equal(appSourceRouteSchema.safeParse({ ...hhpi, identity: { ...identity, nativeId: 'another-thread' } }).success, false);
    assert.equal(appSourceRouteSchema.safeParse({ kind: 'local-dsh', hostId: 'local', sessionId: sourceSessionId(identity) }).success, false);
    assert.equal(appSourceRouteSchema.safeParse({ kind: 'hhpi', hostId: 'local', sessionId: sourceSessionId(identity) }).success, false);
});

test('notification targets retain original request and event coordinates across every native route', () => {
    for (const route of routes) {
        const target = requestTarget(route);
        assert.deepEqual(appNotificationTargetSchema.parse(target), target);
        const result = appServiceOutputs.appNotificationResolve.parse({ target, requestState: 'settled' });
        assert.equal(result.target.kind, 'request');
        assert.equal(result.target.requestId, 'original-request');
        assert.deepEqual(result.target.source, route);
        assert.equal(appServiceOutputs.appNotificationResolve.safeParse({ target }).success, false);
        assert.equal(appNotificationSchema.safeParse({ id: 'notice', scope, kind: 'request', target, title: 'Approval required', body: '', createdAt: 100 }).success, true);
    }
    const original = requestTarget(routes[2]!);
    assert.equal(appNotificationTargetSchema.safeParse({ ...original, requestId: undefined }).success, false);
    assert.equal(appNotificationTargetSchema.safeParse({ ...original, position: { kind: 'dsh', seq: 40 } }).success, false);
    assert.equal(appEventPositionSchema.safeParse({ kind: 'hhpi', seq: 40 }).success, false);
    assert.equal(appNotificationSchema.safeParse({ id: 'notice', scope, kind: 'completed', target: original, title: '', body: '', createdAt: 100 }).success, false);
    assert.equal(appNotificationSchema.safeParse({ id: 'notice', scope, kind: 'request', target: original, title: '', body: 'x'.repeat(1025), createdAt: 100 }).success, false);
    assert.equal(appServiceInputs.appNotificationResolve.safeParse({ deviceId: 'browser', notificationId: 'notice', target: requestTarget(routes[0]!) }).success, false);
});

test('persisted notification/share targets check account and origin before accessing the exact original source', async () => {
    const authorized: AppSourceRoute[] = [];
    const context: AppServiceContext = { scope, authorizeSource(source) { authorized.push(source); } };
    const target = requestTarget(routes[1]!);
    const original = { scope, target };
    assert.equal(await authorizeAppRecord(context, original), original);
    assert.deepEqual(authorized, [routes[1]]);
    authorized.length = 0;
    await assert.rejects(authorizeAppRecord(context, { scope: { ...scope, accountId: 'another-account' }, target }), /another account or origin/);
    await assert.rejects(authorizeAppRecord(context, { scope: { ...scope, origin: 'https://another.example' }, target }), /another account or origin/);
    assert.deepEqual(authorized, []);
    await assert.rejects(authorizeAppTarget({ scope, async authorizeSource() { throw new Error('source ACL denied'); } },
        { ...target, source: { ...routes[1]!, hostId: 'unauthorized-host' } }), /source ACL denied/);
});

test('push registration preserves account/device/origin scope while public settings exclude subscription capabilities and private keys', () => {
    const registered = appPushRegistrationSchema.parse({ scope, deviceId: 'browser', subscription: { ...subscription, expirationTime: null }, updatedAt: 100 });
    assert.deepEqual(registered.subscription.keys, subscription.keys);
    assert.equal(appServiceInputs.appPushSubscribe.safeParse({ accountId: 'another-account', deviceId: 'browser', subscription }).success, false);
    assert.equal(appServiceInputs.appPushSubscribe.safeParse({ deviceId: 'browser', subscription: { ...subscription, endpoint: 'http://push.example/endpoint' } }).success, false);
    const settings = { scope, deviceId: 'browser', vapidPublicKey: null, workerPath: '/hapi-dsh/notifications-worker.js', streamPath: '/hapi-dsh/notifications' };
    assert.deepEqual(appServiceOutputs.appNotificationSettings.parse(settings), settings);
    assert.equal(appServiceOutputs.appNotificationSettings.safeParse({ ...settings, vapidPrivateKey: 'never-public' }).success, false);
    assert.equal(appServiceOutputs.appNotificationSettings.safeParse({ ...settings, subscription }).success, false);
});

test('read contracts require an explicit revision and operation identity and keep manual unread separate from the seen position', () => {
    for (const source of routes) {
        const intent = { kind: 'seen' as const, position: position(source), at: 100 };
        const write = { deviceId: 'browser', source, expectedRevision: 7, operationId: 'read-operation', intent };
        assert.deepEqual(appServiceInputs.appReadStateWrite.parse(write), write);
        assert.equal(appServiceInputs.appReadStateWrite.safeParse({ ...write, expectedRevision: undefined }).success, false);
        assert.equal(appServiceInputs.appReadStateWrite.safeParse({ ...write, operationId: undefined }).success, false);
        const state = appReadStateSchema.parse({ scope, source, revision: 8, seen: { position: position(source), at: 100 }, manualUnreadAt: 110, lastOperationId: 'mark-unread' });
        assert.equal(state.manualUnreadAt, 110);
        assert.equal(state.seen?.position.seq, 40);
        assert.deepEqual(appServiceOutputs.appReadStateWrite.parse({ applied: false, state }).state, state);
        assert.equal(appServiceInputs.appReadStateWrite.safeParse({ ...write, accountId: 'another-account' }).success, false);
    }
    assert.equal(appServiceInputs.appReadStateWrite.safeParse({ deviceId: 'browser', source: routes[0], expectedRevision: 1,
        operationId: 'read', intent: { kind: 'seen', position: { kind: 'hhpi', epoch: 'epoch', seq: 10 }, at: 100 } }).success, false);
});

test('native notification targets preserve turn/item IDs without pretending a reading projection exists', () => {
    const position = { kind: 'native', turnId: 'original-turn', itemId: 'original-tool' };
    const target = { kind: 'request', source: routes[2], position, requestId: 'original-request' };
    assert.deepEqual(appNotificationTargetSchema.parse(target), target);
    assert.equal(appNotificationTargetSchema.safeParse({ ...target, source: routes[0] }).success, false);
    assert.equal(appNotificationTargetSchema.safeParse({ ...target, position: { ...position, seq: 0 } }).success, false);
    assert.equal(appNotificationTargetSchema.safeParse({ ...target, position: { kind: 'native', itemId: 'orphan-item' } }).success, false);
    assert.equal(appServiceInputs.appReadStateWrite.safeParse({ deviceId: 'browser', source: routes[2], operationId: 'read',
        expectedRevision: 0, intent: { kind: 'seen', position, at: 100 } }).success, false);
});

test('reading state batches admit at most 200 exact original routes', () => {
    assert.equal(appServiceInputs.appReadStates.safeParse({ sources: Array.from({ length: 200 }, () => routes[2]) }).success, true);
    assert.equal(appServiceInputs.appReadStates.safeParse({ sources: Array.from({ length: 201 }, () => routes[2]) }).success, false);
});

test('share records retain account scope and native targets without creating public or arbitrary-URL access', () => {
    for (const source of routes) {
        const target = { kind: 'reading' as const, source, position: position(source) };
        const record = { id: 'share-one', scope, target, visibility: 'account' as const, createdAt: 100 };
        assert.deepEqual(appShareRecordSchema.parse(record), record);
        assert.equal(appShareRecordSchema.safeParse({ ...record, visibility: 'public' }).success, false);
        assert.equal(appServiceInputs.appShareCreate.safeParse({ deviceId: 'browser', target, scope: { ...scope, accountId: 'another-account' } }).success, false);
        assert.equal(appServiceInputs.appShareCreate.safeParse({ deviceId: 'browser', target, url: 'https://another.example/' }).success, false);
    }
});
