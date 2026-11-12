/** Application-owned Push delivery. It has no Agent operations or HAPI transport. */
import { appNotificationSchema, type AppNotification } from '../notification-types.ts';
import { APP_NOTIFICATIONS_STREAM_PATH, APP_NOTIFICATIONS_WORKER_PATH, appAccountScopeSchema, appServiceInputs,
    authorizeAppRecord, type AppAccountScope, type AppNotificationTarget, type AppPushRegistration,
    type AppServiceContext, type AppServiceRequest, type AppServiceResponse } from './app-service-types.ts';
import { NotificationStore, type NotificationClaim, type NotificationDelivery } from './notification-store.ts';

export interface AppPushPayload {
    title: string; body: string; tag: string;
    data: { type: 'app-notification'; notificationId: string; scope: AppAccountScope; deviceId: string };
}
export interface AppPushTransport {
    readonly publicKey: string;
    /** Resolving means submitted to the provider, not displayed by the operating system. */
    send(subscription: AppPushRegistration['subscription'], payload: AppPushPayload,
        options: { ttlSeconds: number; timeoutMs: number; signal: AbortSignal }): Promise<void>;
}
export interface ServerVapidDetails { subject: string; publicKey: string; privateKey: string }
export type WebPushSender = (subscription: AppPushRegistration['subscription'], payload: string, options: {
    TTL: number; timeout: number; urgency: 'normal'; vapidDetails: ServerVapidDetails;
}) => Promise<unknown>;

/** Sanitized channel failure: endpoint, keys and provider response bodies are never retained. */
export class PushTransportError extends Error {
    constructor(readonly statusCode?: number, readonly retryAfterMs?: number) { super('The Push provider did not accept the delivery'); }
}
/** Bind the existing web-push sendNotification export with independent server-side VAPID details. */
export function createWebPushTransport(sendNotification: WebPushSender, details: ServerVapidDetails): AppPushTransport {
    const vapidDetails = { ...details };
    return { publicKey: vapidDetails.publicKey, async send(subscription, payload, { ttlSeconds, timeoutMs, signal }) {
        signal.throwIfAborted();
        try {
            await sendNotification(subscription, JSON.stringify(payload), { TTL: ttlSeconds, timeout: timeoutMs, urgency: 'normal', vapidDetails });
        } catch (error) {
            const response = error as { statusCode?: unknown; headers?: Record<string, unknown> };
            const status = typeof response?.statusCode === 'number' ? response.statusCode : undefined;
            const retry = response?.headers?.['retry-after'];
            let retryAfterMs: number | undefined;
            if (typeof retry === 'string') {
                const seconds = Number(retry), date = Date.parse(retry);
                const delay = Number.isFinite(seconds) ? seconds * 1000 : date - Date.now();
                if (Number.isFinite(delay) && delay >= 0) retryAfterMs = delay;
            }
            throw new PushTransportError(status, retryAfterMs);
        }
    } };
}

export const DEFAULT_NOTIFICATION_LIMITS = {
    retentionMs: 7 * 24 * 60 * 60 * 1000, maxNotifications: 1000, maxSubscriptions: 32,
    maxAttempts: 4, retryMs: 1000, maxRetryMs: 60_000, batchSize: 32, concurrency: 4,
    sendTimeoutMs: 10_000, pollMs: 1000,
} as const;
export interface NotificationServiceOptions {
    store: NotificationStore;
    transport?: AppPushTransport;
    /** Reconstruct current trusted authorization for background work without a browser/Pane. */
    contextForScope(scope: AppAccountScope): AppServiceContext | null | Promise<AppServiceContext | null>;
    /** Recheck the exact original request; never substitute a current pending request. */
    requestState?(context: AppServiceContext, target: Extract<AppNotificationTarget, { kind: 'request' }>): 'pending' | 'settled' | Promise<'pending' | 'settled'>;
    limits?: Partial<{ [K in keyof typeof DEFAULT_NOTIFICATION_LIMITS]: number }>;
    now?: () => number;
    onError?(error: unknown): void;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => { reject(signal.reason); };
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    });
}

export class AppNotificationService {
    private readonly store: NotificationStore;
    private readonly now: () => number;
    private readonly limits: { [K in keyof typeof DEFAULT_NOTIFICATION_LIMITS]: number };
    private readonly lifetime = new AbortController();
    private readonly active = new Map<string, Set<AbortController>>();
    private timer: NodeJS.Timeout | undefined;
    private draining: Promise<number> | undefined;
    private closed = false;
    constructor(private readonly options: NotificationServiceOptions) {
        this.store = options.store; this.now = options.now ?? Date.now;
        this.limits = { ...DEFAULT_NOTIFICATION_LIMITS, ...options.limits };
    }
    private scope(context: AppServiceContext): AppAccountScope {
        this.lifetime.signal.throwIfAborted();
        return appAccountScopeSchema.parse(context.scope);
    }
    private abortRegistrations(ids: string[]): void {
        for (const id of ids) for (const controller of this.active.get(id) ?? []) controller.abort(new Error('This browser subscription was revoked'));
    }
    appNotificationSettings(context: AppServiceContext, value: AppServiceRequest<'appNotificationSettings'>): AppServiceResponse<'appNotificationSettings'> {
        const request = appServiceInputs.appNotificationSettings.parse(value), scope = this.scope(context);
        return { scope, deviceId: request.deviceId, vapidPublicKey: this.options.transport?.publicKey ?? null,
            ...(!this.options.transport ? { pushError: 'Push delivery is not configured on this Host.' } : {}),
            workerPath: APP_NOTIFICATIONS_WORKER_PATH, streamPath: APP_NOTIFICATIONS_STREAM_PATH };
    }
    appPushSubscribe(context: AppServiceContext, value: AppServiceRequest<'appPushSubscribe'>): AppServiceResponse<'appPushSubscribe'> {
        const request = appServiceInputs.appPushSubscribe.parse(value), scope = this.scope(context), now = this.now();
        if (!this.options.transport) throw new Error('Push delivery is not configured on this Host');
        if (request.subscription.expirationTime != null && request.subscription.expirationTime <= now) throw new Error('This browser subscription has expired; register a new subscription');
        this.abortRegistrations(this.store.subscribe({ scope, deviceId: request.deviceId, subscription: request.subscription, updatedAt: now }, this.limits.maxSubscriptions));
        return { subscribed: true };
    }
    appPushUnsubscribe(context: AppServiceContext, value: AppServiceRequest<'appPushUnsubscribe'>): AppServiceResponse<'appPushUnsubscribe'> {
        const request = appServiceInputs.appPushUnsubscribe.parse(value), scope = this.scope(context);
        this.abortRegistrations(this.store.unsubscribe(scope, request.deviceId, request.endpoint));
        return { unsubscribed: true };
    }
    /** Use before completing logout/account removal; unrelated origins and accounts remain intact. */
    revokeScope(context: AppServiceContext): void { this.abortRegistrations(this.store.revokeScope(this.scope(context))); }

    /** Server-side source observers call this; it is not a browser invocation. */
    async publish(context: AppServiceContext, value: AppNotification): Promise<{ created: boolean; queued: number }> {
        this.scope(context);
        const notification = appNotificationSchema.parse(value);
        await authorizeAppRecord(context, notification);
        this.lifetime.signal.throwIfAborted();
        return this.store.enqueue(notification, this.now(), this.limits.retentionMs, this.limits.maxNotifications);
    }
    async appNotificationResolve(context: AppServiceContext, value: AppServiceRequest<'appNotificationResolve'>): Promise<AppServiceResponse<'appNotificationResolve'>> {
        const request = appServiceInputs.appNotificationResolve.parse(value), scope = this.scope(context);
        this.store.cleanup(this.now());
        const notification = this.store.notification(scope, request.notificationId, request.deviceId);
        if (!notification) throw new Error('This notification is no longer available for the current account');
        await authorizeAppRecord(context, notification);
        const target = notification.target;
        if (target.kind !== 'request') return { target };
        if (!this.options.requestState) throw new Error('The original request state is not available from this Host');
        return { target, requestState: await this.options.requestState(context, target) };
    }
    async deliveryStates(context: AppServiceContext, notificationId: string): Promise<NotificationDelivery[]> {
        const scope = this.scope(context), notification = this.store.notification(scope, notificationId);
        if (!notification) return [];
        await authorizeAppRecord(context, notification);
        return this.store.deliveries(scope, notificationId);
    }

    /** Explicit lifetime registration lets Host background work continue without retaining a Pane. */
    start(): void {
        this.lifetime.signal.throwIfAborted();
        if (this.timer) return;
        const run = () => { void this.drain().catch(error => this.options.onError?.(error)); };
        this.timer = setInterval(run, this.limits.pollMs); this.timer.unref(); run();
    }
    drain(): Promise<number> {
        if (this.closed) return Promise.resolve(0);
        if (!this.draining) this.draining = this.flush().finally(() => { this.draining = undefined; });
        return this.draining;
    }
    private async flush(): Promise<number> {
        this.store.cleanup(this.now());
        if (!this.options.transport) return 0;
        let count = 0;
        while (!this.closed && count < this.limits.batchSize) {
            const claims = this.store.claimDue(this.now(), Math.min(this.limits.concurrency, this.limits.batchSize - count),
                this.limits.sendTimeoutMs + 1000, this.limits.maxAttempts);
            if (!claims.length) break;
            count += claims.length;
            await Promise.all(claims.map(claim => this.send(claim)));
        }
        return count;
    }
    private async send(claim: NotificationClaim): Promise<void> {
        const { notification, registration } = claim;
        const controller = new AbortController(), active = this.active.get(claim.registrationId) ?? new Set<AbortController>();
        active.add(controller); this.active.set(claim.registrationId, active);
        const signal = AbortSignal.any([this.lifetime.signal, controller.signal, AbortSignal.timeout(this.limits.sendTimeoutMs)]);
        const deadline = performance.now() + this.limits.sendTimeoutMs;
        try {
            let context: AppServiceContext | null;
            try { context = await abortable(Promise.resolve(this.options.contextForScope(notification.scope)), signal); }
            catch { this.retry(claim); return; }
            if (!context) { this.store.settle(claim, 'cancelled', this.now(), 'scope-revoked'); return; }
            try { await abortable(authorizeAppRecord(context, notification), signal); }
            catch {
                if (signal.aborted) this.retry(claim);
                else this.store.settle(claim, 'cancelled', this.now(), 'source-revoked');
                return;
            }
            if (!this.store.isCurrent(claim, this.now())) return;
            const remainingMs = claim.expiresAt - this.now();
            if (remainingMs <= 0) { this.store.settle(claim, 'cancelled', this.now(), 'expired'); return; }
            // The background payload exposes a status and an opaque lookup identity.
            // Native targets and potentially sensitive source summaries stay on Host.
            const payload: AppPushPayload = {
                title: notification.kind === 'completed' ? 'Task completed' : notification.kind === 'failed' ? 'Task failed' : 'Your response is needed',
                body: '', tag: notification.id,
                data: { type: 'app-notification', notificationId: notification.id, scope: notification.scope, deviceId: registration.deviceId },
            };
            if (Buffer.byteLength(JSON.stringify(payload)) > 3500) { this.store.settle(claim, 'failed', this.now(), 'payload-too-large'); return; }
            try {
                signal.throwIfAborted();
                await abortable(this.options.transport!.send(registration.subscription, payload,
                    { ttlSeconds: Math.max(1, Math.ceil(remainingMs / 1000)), timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())), signal }), signal);
                this.store.settle(claim, 'submitted', this.now());
            } catch (error) {
                if (!this.store.isCurrent(claim, this.now())) return;
                const status = error instanceof PushTransportError ? error.statusCode : undefined;
                if (status === 404 || status === 410) this.store.expireRegistration(claim);
                else if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) this.store.settle(claim, 'failed', this.now(), 'rejected');
                else this.retry(claim, error instanceof PushTransportError ? error.retryAfterMs : undefined);
            }
        } finally { active.delete(controller); if (!active.size) this.active.delete(claim.registrationId); }
    }
    private retry(claim: NotificationClaim, retryAfterMs?: number): void {
        const now = this.now(), delay = Math.max(retryAfterMs ?? 0, Math.min(this.limits.retryMs * 2 ** (claim.attempts - 1), this.limits.maxRetryMs));
        if (claim.attempts >= this.limits.maxAttempts) this.store.settle(claim, 'failed', now, 'retry-exhausted');
        else if (now + delay >= claim.expiresAt) this.store.settle(claim, 'failed', now, 'expired');
        else this.store.settle(claim, 'pending', now, null, now + delay);
    }
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true; this.lifetime.abort(new Error('The notification service is closing'));
        if (this.timer) clearInterval(this.timer);
        try { await this.draining; } finally { this.store.close(); }
    }
}
