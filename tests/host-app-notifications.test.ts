/** Actual installed Gateway plus application storage and authorization; native source and Push transport are explicit fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { SourceGateway } from '../src/remote/gateway.ts';
import { sourceSessionId, type SourceAdapter, type SourceSession } from '../src/remote/protocol.ts';
import { APP_SERVICES_HOST_CONTRACT } from '../src/workspace/app-api.ts';
import { AppServicesController } from '../src/workspace/app-service.ts';
import { AppNotificationHost } from '../src/workspace/notification-host.ts';
import { applicationPushTransport } from '../src/workspace/notification-vapid.ts';
import type { AppNotification } from '../src/notification-types.ts';
import type { AppServiceResponse } from '../src/workspace/app-service-types.ts';

test('Host application RPC resolves the stored original request, rechecks grants and retires only the logged-out device', async t => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-notifications-host-'), ctx = new Context();
    const identity = { machineId: 'synthetic-machine', sourceId: 'synthetic-source', engine: 'codex', nativeId: 'synthetic-thread' };
    const sessionId = sourceSessionId(identity);
    let pendingRequests: SourceSession['pendingRequests'] = [], available = true;
    const source: SourceSession = { id: sessionId, ...identity, title: 'Synthetic', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null,
        capabilities: { send: false, steer: false, cancel: false, approve: true, files: false }, pendingRequests: [] };
    const adapter: SourceAdapter = { id: identity.sourceId, machineId: identity.machineId, engine: 'codex',
        async list() { return [source]; }, async resolve() { if (!available) throw new Error('Source no longer available'); return { ...source, pendingRequests }; },
        async read() { throw new Error('Notification settings do not read a transcript'); }, async *changes() {}, async operate() { throw new Error('No execution'); }, dispose() {} };
    const sources = new SourceGateway([adapter]);
    await ctx.plugin(TypertRegistry); new RemoteAccess(ctx);
    ctx.typert.register({ package: 'hapi-dsh', face: 'host', schemas: [], invocations: APP_SERVICES_HOST_CONTRACT.invocations,
        model: { services: APP_SERVICES_HOST_CONTRACT.services, events: [], objects: [] } });
    const gateway = new Gateway(ctx, Gateway.Config({}));
    const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
    const host = new AppNotificationHost(ctx, { directory, origin: 'https://workspace.fixture', gateway: sources,
        transport: { publicKey: 'synthetic-vapid', async send() { throw new Error('No network Push in this test'); } } });
    new AppServicesController(ctx, { context: principal => host.context(principal), notifications: host.service });
    t.after(async () => { await host.close(); await sources.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true }); });
    const invoke = <T>(method: string, request: unknown): Promise<T> => gateway.invoke({ peer: connection.browserPeer, namespace: 'appServices', method, args: { request } }) as Promise<T>;
    const settings = await invoke<AppServiceResponse<'appNotificationSettings'>>('appNotificationSettings', { deviceId: 'first-device' });
    assert.equal(settings.deviceId, 'first-device'); assert.equal(settings.scope.origin, 'https://workspace.fixture');
    for (const deviceId of ['first-device', 'second-device']) await invoke('appPushSubscribe', { deviceId, subscription: {
        endpoint: `https://push.fixture/${deviceId}`, keys: { p256dh: 'P'.repeat(88), auth: 'A'.repeat(24) },
    } });
    const context = host.context(connection.browserPeer.principal);
    const notification: AppNotification = { id: 'original-event', scope: settings.scope, kind: 'request', createdAt: Date.now(), title: 'Response needed', body: '',
        target: { kind: 'request', source: { kind: 'hhpi', hostId: 'local', sessionId, identity }, position: { kind: 'native', turnId: 'old-turn', itemId: 'old-item' }, requestId: 'old-request' } };
    await host.publish(context, notification);
    pendingRequests = [{ id: 'new-request', method: 'item/commandExecution/requestApproval', params: {}, turnId: 'new-turn', itemId: null }];
    const resolved = await invoke<AppServiceResponse<'appNotificationResolve'>>('appNotificationResolve', { deviceId: 'first-device', notificationId: notification.id });
    assert.equal(resolved.requestState, 'settled'); assert.deepEqual(resolved.target, notification.target);
    available = false;
    await assert.rejects(invoke('appNotificationResolve', { deviceId: 'first-device', notificationId: notification.id }));
    available = true;
    host.logout({ headers: { cookie: 'hhpi-notification-device=first-device' } } as import('node:http').IncomingMessage);
    assert.deepEqual(host.store.subscriptions(settings.scope, Date.now()).map(value => value.deviceId), ['second-device']);
    await assert.rejects(invoke('appNotificationResolve', { deviceId: 'unknown-device', notificationId: notification.id }));
});

test('application VAPID identity survives restart and its private key is not world-readable', async t => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-notifications-vapid-');
    t.after(() => rm(directory, { recursive: true }));
    const first = await applicationPushTransport(directory, 'https://workspace.fixture');
    const second = await applicationPushTransport(directory, 'https://workspace.fixture');
    assert.ok(first?.publicKey); assert.equal(second?.publicKey, first.publicKey);
    assert.equal((await stat(join(directory, 'vapid.json'))).mode & 0o777, 0o600);
    assert.equal(await applicationPushTransport(directory, 'http://localhost:8080'), undefined);
});

test('foreground delivery without Push remains clickable and rejects another device', async t => {
    const { createServer } = await import('node:http'), { default: WebSocket } = await import('ws');
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-notifications-stream-'), ctx = new Context();
    await ctx.plugin(SessionStore);
    const routes = new Map<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown>();
    let upgrade: (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void = () => {};
    ctx.reflect.provide('webServer', { register(route: { path: string; handler: typeof routes extends Map<string, infer H> ? H : never }) {
        routes.set(route.path, route.handler); return () => { routes.delete(route.path); };
    }, registerUpgrade(route: { handler: typeof upgrade }) { upgrade = route.handler; return () => {}; } } as unknown as Context['webServer']);
    // Authentication is an explicit boundary fixture; HTTP and WebSocket are real transports.
    ctx.reflect.provide('connection', { browserPeer: { principal: { kind: 'owner' } }, requestRejection(request: import('node:http').IncomingMessage) {
        return request.headers.cookie === 'fixture=authorized' ? undefined : 401;
    } } as unknown as Context['connection']);
    new RemoteAccess(ctx);
    const sources = new SourceGateway([]), server = createServer((req, res) => {
        const handler = routes.get(new URL(req.url!, 'http://localhost').pathname);
        if (handler) void handler(req, res); else { res.writeHead(404); res.end(); }
    });
    server.on('upgrade', (req, socket, head) => upgrade(req, socket, head));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`, host = new AppNotificationHost(ctx, { directory, origin, gateway: sources });
    t.after(async () => { await host.close(); await sources.dispose(); await ctx.fiber.dispose(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true }); });
    host.mount();
    const denied = new WebSocket(origin.replace('http:', 'ws:') + '/hapi-dsh/notifications?deviceId=anonymous');
    const rejection = await new Promise<number>(resolve => { denied.once('unexpected-response', (request, response) => { resolve(response.statusCode!); request.destroy(); }); denied.on('error', () => {}); });
    assert.equal(rejection, 401);
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/hapi-dsh/notifications?deviceId=foreground', { headers: { cookie: 'fixture=authorized' } });
    t.after(() => socket.terminate());
    const frames: unknown[] = []; socket.on('message', value => frames.push(JSON.parse(value.toString())));
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'presence', visibility: 'visible' }));
    const pong = once(socket, 'pong', { signal: AbortSignal.timeout(3000) }); socket.ping(); await pong;
    const context = host.context({ kind: 'owner' });
    // Feed the actual registered native event hook. This synthetic source has
    // no Pane, catalog entry, transcript subscription, or Push subscription.
    const session = (ctx.sessions as unknown as SessionStore).create(SessionId('synthetic-dsh'));
    const received = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No source completion delivered')), 3000);
        socket.on('message', value => { if (JSON.parse(value.toString()).type === 'notification') { clearTimeout(timeout); resolve(); } });
    });
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic task' }] }), { surfaceOp: 'append' });
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
    const body = session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
        source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Synthetic completion' }],
    }) }, { surfaceOp: 'append' });
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await received;
    const notification = (frames.find(frame => (frame as { type: string }).type === 'notification') as { notification: AppNotification }).notification;
    assert.deepEqual(notification.target, { kind: 'reading', source: { kind: 'local-dsh', hostId: 'local', sessionId: 'synthetic-dsh' }, position: { kind: 'dsh', seq: body.seq } });
    assert.ok(frames.some(frame => (frame as { type: string }).type === 'notification'));
    assert.equal(host.store.subscriptions(context.scope, Date.now()).length, 0);
    assert.deepEqual((await host.service.appNotificationResolve(context, { deviceId: 'foreground', notificationId: notification.id })).target, notification.target);
    await assert.rejects(host.service.appNotificationResolve(context, { deviceId: 'another-device', notificationId: notification.id }));
    socket.close(); await once(socket, 'close');
});
