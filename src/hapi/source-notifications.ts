/** Original HAPI Push subscriptions and live browser presence; no daemon-as-user visibility. */
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { HapiClient } from './client.ts';
import { HapiRequestError, type HapiEvent } from '../codex/contracts.ts';
import type { FederationMount } from '../hub/federation.ts';
import { NOTIFICATION_HEARTBEAT_MS, NOTIFICATION_LEASE_MS, NOTIFICATIONS_STREAM_PATH, NOTIFICATIONS_WORKER_PATH,
    notificationInputs, notificationPresenceSchema, type NotificationFrame, type NotificationRequest, type NotificationResponse } from '../notification-types.ts';
import { buildNotificationWorker, normalizedAppPath } from '../notifications/worker.ts';

export type SourceNotificationsClient = Pick<HapiClient, 'hubId' | 'request' | 'subscribe' | 'isConnected' | 'setVisibility'>;
const pushKey = z.object({ publicKey: z.string().min(1).max(512) });
const confirmed = z.object({ ok: z.literal(true) });
function response<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HapiRequestError('The original Hub returned an incompatible notification response', 'indeterminate', 502, 'notifications_protocol_mismatch');
    return parsed.data;
}
function reject(socket: Duplex, status: number): void { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
type Browser = { socket: WebSocket; visibleUntil: number };

export class SourceNotificationsService {
    private readonly lifetime = new AbortController();
    private readonly disposers: Array<() => void> = [];
    private readonly browsers = new Set<Browser>();
    private readonly server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
    private readonly unsubscribe: () => void;
    private readonly expiry: ReturnType<typeof setInterval>;
    private visibility: 'visible' | 'hidden' = 'hidden';
    private presenceError: string | undefined;
    private closed = false;

    constructor(private readonly client: SourceNotificationsClient) {
        this.unsubscribe = client.subscribe(event => this.event(event));
        this.expiry = setInterval(() => this.reconcilePresence(), 1000);
        this.expiry.unref();
    }
    private signal(signal?: AbortSignal): AbortSignal { return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]); }
    async sourceNotificationSettings(input: NotificationRequest<'sourceNotificationSettings'>, signal?: AbortSignal): Promise<NotificationResponse<'sourceNotificationSettings'>> {
        notificationInputs.sourceNotificationSettings.parse(input);
        const lifetime = this.signal(signal), base = { hubId: this.client.hubId, workerPath: NOTIFICATIONS_WORKER_PATH, streamPath: NOTIFICATIONS_STREAM_PATH } as const;
        try {
            const value = response(pushKey, await this.client.request('/api/push/vapid-public-key', { signal: lifetime }));
            return { ...base, vapidPublicKey: value.publicKey };
        } catch (error) {
            lifetime.throwIfAborted();
            // Push configuration and foreground presence are independent. Do
            // not expose the original request URL, response body or credentials.
            return { ...base, vapidPublicKey: null, pushError: 'The original Hub could not provide a Push public key. Check its Push configuration or connection, then explicitly enable notifications again.' };
        }
    }
    async sourcePushSubscribe(input: NotificationRequest<'sourcePushSubscribe'>, signal?: AbortSignal): Promise<NotificationResponse<'sourcePushSubscribe'>> {
        const request = notificationInputs.sourcePushSubscribe.parse(input);
        response(confirmed, await this.client.request('/api/push/subscribe', { method: 'POST', body: request, signal: this.signal(signal) }));
        return { subscribed: true };
    }
    async sourcePushUnsubscribe(input: NotificationRequest<'sourcePushUnsubscribe'>, signal?: AbortSignal): Promise<NotificationResponse<'sourcePushUnsubscribe'>> {
        const request = notificationInputs.sourcePushUnsubscribe.parse(input);
        response(confirmed, await this.client.request('/api/push/subscribe', { method: 'DELETE', body: request, signal: this.signal(signal) }));
        return { unsubscribed: true };
    }
    mount({ webServer, authorize }: FederationMount): void {
        if (this.disposers.length || this.closed) throw new Error('The notifications bridge can be mounted only once');
        this.disposers.push(webServer.register({ kind: 'exact', path: NOTIFICATIONS_WORKER_PATH, handler: (request, reply) => {
            // The worker is public executable code, not a credential carrier.
            // Installation must remain possible before a page gains a controller.
            if (request.method !== 'GET' && request.method !== 'HEAD') { reply.writeHead(405, { allow: 'GET, HEAD' }); reply.end(); return; }
            try {
                const url = new URL(request.url ?? NOTIFICATIONS_WORKER_PATH, 'http://worker.invalid');
                const appPath = normalizedAppPath(url.searchParams.get('app') ?? '/');
                const code = buildNotificationWorker(this.client.hubId, appPath);
                reply.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate',
                    'service-worker-allowed': '/', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(code) });
                reply.end(request.method === 'HEAD' ? undefined : code);
            } catch { reply.writeHead(400, { 'content-type': 'text/plain' }); reply.end('Invalid application scope'); }
        } }));
        this.disposers.push(webServer.registerUpgrade({ path: NOTIFICATIONS_STREAM_PATH, handler: (request, socket, head) => {
            const denial = authorize(request); if (denial !== undefined) { reject(socket, denial); return; }
            if (this.browsers.size >= 128) { reject(socket, 429); return; }
            this.server.handleUpgrade(request, socket, head, browser => this.attach(browser));
        } }));
    }
    private send(browser: Browser, frame: NotificationFrame): void {
        if (browser.socket.readyState !== WebSocket.OPEN) return;
        if (browser.socket.bufferedAmount > 256 * 1024) { browser.socket.terminate(); return; }
        browser.socket.send(JSON.stringify(frame), error => { if (error) browser.socket.terminate(); });
    }
    private status(): void {
        const frame: NotificationFrame = { type: 'status', connected: this.client.isConnected, visibility: this.visibility,
            ...(this.presenceError ? { error: this.presenceError } : {}) };
        for (const browser of this.browsers) this.send(browser, frame);
    }
    private event(event: HapiEvent): void {
        if (event.type === 'connection-changed') { this.status(); return; }
        if (event.type !== 'toast') return;
        const frame: NotificationFrame = { type: 'toast', notification: { id: randomUUID(), hubId: this.client.hubId,
            title: event.data.title, body: event.data.body, sessionId: event.data.sessionId, createdAt: Date.now() } };
        for (const browser of this.browsers) if (browser.visibleUntil > Date.now()) this.send(browser, frame);
    }
    private attach(socket: WebSocket): void {
        const browser: Browser = { socket, visibleUntil: 0 }; this.browsers.add(browser);
        this.send(browser, { type: 'ready', hubId: this.client.hubId, heartbeatMs: NOTIFICATION_HEARTBEAT_MS, leaseMs: NOTIFICATION_LEASE_MS });
        this.send(browser, { type: 'status', connected: this.client.isConnected, visibility: this.visibility });
        socket.on('message', (bytes, binary) => {
            let value: z.infer<typeof notificationPresenceSchema>;
            try { if (binary) throw new Error('JSON required'); value = notificationPresenceSchema.parse(JSON.parse(bytes.toString())); }
            catch { socket.close(1008, 'Invalid browser presence'); return; }
            browser.visibleUntil = value.visibility === 'visible' ? Date.now() + NOTIFICATION_LEASE_MS : 0;
            this.reconcilePresence(true);
        });
        const remove = (): void => { if (this.browsers.delete(browser)) this.reconcilePresence(); };
        socket.once('close', remove); socket.on('error', () => { remove(); socket.terminate(); });
    }
    private reconcilePresence(heartbeat = false): void {
        if (this.closed) return;
        const state = [...this.browsers].some(browser => browser.socket.readyState === WebSocket.OPEN && browser.visibleUntil > Date.now()) ? 'visible' : 'hidden';
        if (state === this.visibility && !heartbeat && !this.presenceError) return;
        this.visibility = state;
        void this.client.setVisibility(state).then(() => { this.presenceError = undefined; this.status(); }, () => {
            this.presenceError = 'Original notification presence could not be confirmed; background visibility is being reconciled';
            this.status();
        });
    }
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true; clearInterval(this.expiry); this.lifetime.abort(); this.unsubscribe();
        for (const dispose of this.disposers.splice(0)) dispose();
        for (const browser of this.browsers) browser.socket.close(1001, 'Notifications bridge stopped');
        this.browsers.clear(); this.server.close();
        await this.client.setVisibility('hidden').catch(() => {});
    }
}
