/** Host lifetime for application notifications, independent of any mounted conversation. */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import type { Principal } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { appNotificationFrameSchema, notificationPresenceSchema, NOTIFICATION_LEASE_MS, type AppNotification } from '../notification-types.ts';
import { APP_NOTIFICATIONS_STREAM_PATH, APP_NOTIFICATIONS_WORKER_PATH, appAccountScopeSchema, appScopeKey,
    appSourceRouteSchema, type AppServiceContext, type AppAccountScope, type AppSourceRoute } from './app-service-types.ts';
import { buildAppNotificationWorker, normalizedAppPath } from '../notifications/worker.ts';
import { NotificationStore } from './notification-store.ts';
import { AppNotificationService, type AppPushTransport } from './notification-service.ts';
import { SourceAccessDenied } from '../remote/errors.ts';
import { sourceStorageScope } from '../remote/service.ts';
import type { SourceGateway, SourceAccess } from '../remote/gateway.ts';
import { SourceNotificationObserver, type NotificationObservationState } from './notification-events.ts';
import { NativeDshAttention } from './native-dsh-attention.ts';
import { ForeignSourceNotifications, type ForeignAttentionCatalog } from './foreign-attention.ts';
import { isSourceDisplayId } from '../shared/source-display-id.ts';

interface Browser { socket: WebSocket; scope: AppAccountScope; deviceId: string; visibleUntil: number }
const DEVICE_COOKIE = 'hhpi-notification-device';
function reject(socket: Duplex, status: number): void { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
export interface AppNotificationHostOptions {
    directory: string; origin: string; gateway: SourceGateway; transport?: AppPushTransport;
    sources?: readonly { id: string; machineId: string; engine: string }[];
    foreign?: ForeignAttentionCatalog;
    authorizeForeign?(principal: Principal, source: AppSourceRoute): Promise<void>;
    foreignRequestState?(target: Extract<AppNotification['target'], { kind: 'request' }>, signal: AbortSignal): Promise<'pending' | 'settled'>;
    requestState?(context: AppServiceContext, target: Extract<AppNotification['target'], { kind: 'request' }>): Promise<'pending' | 'settled'>;
}
export class AppNotificationHost {
    readonly service: AppNotificationService;
    readonly store: NotificationStore;
    readonly lifetime = new AbortController();
    private readonly contexts = new Map<string, AppServiceContext>();
    private readonly browsers = new Set<Browser>();
    private readonly principals = new Map<string, Principal>();
    private readonly observations = new Map<string, NotificationObservationState>();
    private readonly attention = new NativeDshAttention(this.lifetime.signal);
    private readonly observer: SourceNotificationObserver;
    private readonly foreignObservers: ForeignSourceNotifications[] = [];
    private mounted = false;
    private readonly server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
    private readonly disposers: Array<() => void> = [];
    private state: NotificationObservationState = 'connecting';
    constructor(private readonly ctx: Context, private readonly options: AppNotificationHostOptions) {
        this.store = new NotificationStore(join(options.directory, 'notifications.sqlite'));
        // The original owner's identity is stable across Host restarts. No browser token is stored.
        this.context({ kind: 'owner' });
        this.service = new AppNotificationService({ store: this.store,
            ...(options.transport ? { transport: options.transport } : {}),
            contextForScope: scope => this.contexts.get(appScopeKey(scope)) ?? null,
            requestState: (context, target) => options.requestState ? options.requestState(context, target) : this.requestState(context, target),
            onError: () => ctx.logger.warn('Application notification delivery could not be completed.'),
        });
        this.observer = new SourceNotificationObserver((context, notification) => this.publish(context, notification));
        this.server.on('headers', (headers, request) => {
            const deviceId = new URL(request.url!, this.options.origin).searchParams.get('deviceId');
            if (deviceId) headers.push(`Set-Cookie: ${DEVICE_COOKIE}=${encodeURIComponent(deviceId)}; Path=/; HttpOnly; SameSite=Strict${this.options.origin.startsWith('https:') ? '; Secure' : ''}`);
        });
    }
    access(principal: Principal): SourceAccess {
        const access = this.ctx.remoteAccess as unknown as RemoteAccessService;
        return resource => !this.lifetime.signal.aborted && access.decide({ principal,
            action: resource.kind === 'source' ? 'hhpi/nativeEvents' : 'hhpi/resolve',
            resources: [resource.kind === 'source' ? { kind: 'hhpiSource', id: resource.id } : { kind: 'session', id: resource.id as SessionId }],
        }).kind === 'allow';
    }
    context(principal: Principal): AppServiceContext {
        const scope = appAccountScopeSchema.parse({ accountId: sourceStorageScope(this.options.directory, principal), origin: this.options.origin });
        const key = appScopeKey(scope), existing = this.contexts.get(key);
        if (existing) return existing;
        const context: AppServiceContext = { scope, authorizeSource: async raw => {
            this.lifetime.signal.throwIfAborted();
            const source = appSourceRouteSchema.parse(raw);
            const access = this.ctx.remoteAccess as unknown as RemoteAccessService;
            if (access.decide({ principal, action: source.kind === 'hhpi' ? 'hhpi/resolve' : 'session/page',
                resources: [{ kind: 'session', id: source.sessionId as SessionId }] }).kind !== 'allow') throw new SourceAccessDenied();
            if (source.hostId !== 'local') {
                if (!this.options.authorizeForeign) throw new Error('The original remote Host is unavailable.');
                await this.options.authorizeForeign(principal, source); this.lifetime.signal.throwIfAborted(); return;
            }
            if (source.kind === 'hhpi') await this.options.gateway.resolve(source.sessionId, this.access(principal), this.lifetime.signal);
            else if (source.kind !== 'local-dsh') throw new SourceAccessDenied();
            this.lifetime.signal.throwIfAborted();
        } };
        this.contexts.set(key, context); this.principals.set(key, principal);
        if (this.mounted) this.observeContext(context, principal);
        return context;
    }
    private async requestState(context: AppServiceContext, target: Extract<AppNotification['target'], { kind: 'request' }>): Promise<'pending' | 'settled'> {
        await context.authorizeSource(target.source);
        if (target.source.hostId !== 'local' && this.options.foreignRequestState) {
            const state = await this.options.foreignRequestState(target, this.lifetime.signal);
            await context.authorizeSource(target.source); return state;
        }
        if (target.source.hostId === 'local' && target.source.kind === 'local-dsh') return this.attention.requestState(target.source.sessionId, target.requestId);
        if (target.source.hostId !== 'local' || target.source.kind !== 'hhpi') throw new Error('The original request resolver is unavailable.');
        const source = await this.options.gateway.resolve(target.source.sessionId, resource => {
            if (resource.kind !== 'session' || resource.id !== target.source.sessionId) return false;
            // The exact context was authorized above; source access is repeated after resolution below.
            return true;
        }, this.lifetime.signal);
        await context.authorizeSource(target.source);
        return source.pendingRequests.some(request => request.id === target.requestId) ? 'pending' : 'settled';
    }
    private observeContext(context: AppServiceContext, principal: Principal): void {
        const scope = appScopeKey(context.scope);
        const status = (id: string) => (state: NotificationObservationState | null): void => {
            const key = JSON.stringify([scope, id]);
            if (state === null) this.observations.delete(key); else this.observations.set(key, state);
            const values = [...this.observations.values()];
            this.status(values.includes('denied') ? 'denied' : values.includes('recovering') ? 'recovering'
                : values.includes('connecting') ? 'connecting' : values.includes('closed') ? 'closed' : 'watching');
        };
        if (this.options.foreign) this.foreignObservers.push(new ForeignSourceNotifications({ context, observer: this.observer,
            catalog: this.options.foreign, status: (id, state) => status(id)(state) }));
        this.observer.observeSource({ context, hostId: 'local', routeKind: 'local-dsh',
            source: { machineId: 'local', id: 'native-dsh', engine: 'dsh' }, feed: this.attention,
            authorizationSignal: this.lifetime.signal, status: status('native-dsh') });
        for (const source of this.options.sources ?? []) {
            // The former HAPI-backed DSH adapter is being retired. Actual DSH uses its committed event owner above.
            if (source.engine !== 'codex') continue;
            this.observer.observeSource({ context, hostId: 'local', source,
                feed: { attentionEvents: (cursor, signal) => this.options.gateway.attentionEvents(source.id, cursor, this.access(principal), signal) },
                authorizationSignal: this.lifetime.signal, status: status(source.id) });
        }
    }
    async publish(context: AppServiceContext, notification: AppNotification): Promise<void> {
        const result = await this.service.publish(context, notification);
        if (!result.created) return;
        for (const browser of this.browsers) if (browser.visibleUntil > Date.now() && appScopeKey(browser.scope) === appScopeKey(context.scope)) {
            this.store.presented(browser.scope, notification.id, browser.deviceId);
            this.send(browser, { type: 'notification', notification });
        }
    }
    status(state: NotificationObservationState): void {
        this.state = state;
        for (const browser of this.browsers) this.send(browser, { type: 'status', connected: state === 'watching',
            syncState: state === 'closed' ? 'recovering' : state });
    }
    private send(browser: Browser, frame: unknown): void {
        if (browser.socket.readyState !== WebSocket.OPEN) return;
        if (browser.socket.bufferedAmount > 256 * 1024) { browser.socket.terminate(); return; }
        browser.socket.send(JSON.stringify(appNotificationFrameSchema.parse(frame)), error => { if (error) browser.socket.terminate(); });
    }
    mount(): void {
        if (this.mounted) throw new Error('Application notifications are already mounted.');
        this.mounted = true;
        this.disposers.push(this.ctx.on('session/event', (session, event) => {
            if (isSourceDisplayId(session.id)) return;
            this.attention.accept(session, event);
        }));
        this.disposers.push(this.ctx.on('session/disposed', session => this.attention.forget(session)));
        for (const [key, context] of this.contexts) this.observeContext(context, this.principals.get(key)!);
        this.disposers.push(this.ctx.webServer.register({ kind: 'exact', path: APP_NOTIFICATIONS_WORKER_PATH, handler: (request, reply) => {
            if (request.method !== 'GET' && request.method !== 'HEAD') { reply.writeHead(405, { allow: 'GET, HEAD' }); reply.end(); return; }
            try {
                const appPath = normalizedAppPath(new URL(request.url!, this.options.origin).searchParams.get('app') ?? '/');
                const code = buildAppNotificationWorker(appPath);
                reply.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate',
                    'service-worker-allowed': '/', 'x-content-type-options': 'nosniff' }); reply.end(request.method === 'HEAD' ? undefined : code);
            } catch { reply.writeHead(400); reply.end('Invalid application scope'); }
        } }));
        this.disposers.push(this.ctx.webServer.registerUpgrade({ path: APP_NOTIFICATIONS_STREAM_PATH, handler: (request, socket, head) => {
            const denial = this.ctx.connection.requestRejection(request);
            if (denial !== undefined) { reject(socket, denial); return; }
            const deviceId = new URL(request.url!, this.options.origin).searchParams.get('deviceId');
            if (!deviceId || deviceId.length > 2048 || deviceId.includes('\0')) { reject(socket, 400); return; }
            if (this.browsers.size >= 128) { reject(socket, 429); return; }
            const context = this.context(this.ctx.connection.browserPeer.principal);
            this.server.handleUpgrade(request, socket, head, connection => this.attach(connection, context.scope, deviceId));
        } }));
        this.service.start();
    }
    private attach(socket: WebSocket, scope: AppAccountScope, deviceId: string): void {
        const browser: Browser = { socket, scope, deviceId, visibleUntil: 0 }; this.browsers.add(browser);
        this.send(browser, { type: 'ready', scope, deviceId });
        this.send(browser, { type: 'status', connected: this.state === 'watching', syncState: this.state === 'closed' ? 'recovering' : this.state });
        socket.on('message', (bytes, binary) => {
            try {
                if (binary) throw new Error();
                const presence = notificationPresenceSchema.parse(JSON.parse(bytes.toString()));
                browser.visibleUntil = presence.visibility === 'visible' ? Date.now() + NOTIFICATION_LEASE_MS : 0;
            } catch { socket.close(1008, 'Invalid browser presence'); }
        });
        socket.once('close', () => this.browsers.delete(browser));
        socket.on('error', () => { this.browsers.delete(browser); socket.terminate(); });
    }
    /** Authenticated logout retires this browser's endpoints, preserving other devices. */
    logout(request: IncomingMessage): void {
        const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${DEVICE_COOKIE}=`));
        if (!cookie) return;
        let deviceId: string; try { deviceId = decodeURIComponent(cookie.slice(DEVICE_COOKIE.length + 1)); } catch { return; }
        const context = this.context(this.ctx.connection.browserPeer.principal);
        for (const registration of this.store.subscriptions(context.scope, Date.now())) if (registration.deviceId === deviceId) {
            this.service.appPushUnsubscribe(context, { deviceId, endpoint: registration.subscription.endpoint });
        }
        for (const browser of this.browsers) if (browser.deviceId === deviceId && appScopeKey(browser.scope) === appScopeKey(context.scope)) browser.socket.close(1008, 'Signed out');
    }
    async close(): Promise<void> {
        this.lifetime.abort(); for (const dispose of this.disposers.splice(0)) dispose();
        for (const browser of this.browsers) browser.socket.close(1001, 'Application service stopped');
        this.browsers.clear(); this.server.close(); await Promise.all(this.foreignObservers.map(observer => observer.close()));
        await this.observer.close(); await this.service.close(); this.contexts.clear(); this.principals.clear();
    }
}
