/** Account-scoped application Push, installation and exact stored-target navigation. */
import { remoteValue } from '../../client-api.ts';
import { NOTIFICATION_HEARTBEAT_MS, appNotificationFrameSchema, appNotificationReferenceSchema, type AppNotification, type AppNotificationReference, type AppNotificationsApi } from '../../notification-types.ts';
import { appScopeKey, type AppAccountScope, type AppNotificationTarget, type AppServiceResponse } from '../../workspace/app-service-types.ts';
import { appNotificationsSupported } from './capability.ts';
type NotificationSettings = AppServiceResponse<'appNotificationSettings'>;

export interface SourceNotificationsUiOptions {
    /** Application identity is available even when browser Push is unsupported. */
    onReady?(scope: AppAccountScope, deviceId: string): void;
    /** null means the sidebar snapshot is loading or failed: retain the last OS badge. */
    getUnreadCount(): number | null;
    subscribeUnread(listener: () => void): () => void;
    /** Capture the user's current navigation before resolving the stored target. */
    captureNavigation?(): () => boolean;
    openSource(target: AppNotificationTarget, requestState: 'pending' | 'settled' | undefined, signal: AbortSignal): void | Promise<void>;
    /** Finish every registered editor's durable writes before replacing this document. */
    prepareUpdate?(): Promise<void>;
    /** Activate exact reading tickets only after save/activation succeed; returns rollback if reload fails. */
    armForReload?(): () => void;
}
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
interface BadgeNavigator { setAppBadge?(value?: number): Promise<void>; clearAppBadge?(): Promise<void>; standalone?: boolean }
export interface NotificationsState {
    supported: boolean; permission: NotificationPermission; push: 'off' | 'on' | 'unknown'; busy: boolean;
    connected: boolean; error: string | null; presenceError: string | null;
    badgeEnabled: boolean; badgeSupported: boolean; unread: number | null;
    canInstall: boolean; iosInstall: boolean; installed: boolean; installing: boolean; installDismissed: boolean;
    updateReady: boolean; updating: boolean; notices: readonly AppNotification[];
    openingId: string | null; navigationFailure: { reference: AppNotificationReference; message: string } | null;
}
const REGISTERED = 'hhpi.push.confirmed';
const VAPID_KEY = 'hhpi.push.publicKey';
const BADGE_KEY = 'hapi-app-badge-enabled';
const INSTALL_DISMISSED = 'pwa_install_dismissed';
const message = (error: unknown): string => error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Notification operation failed';
const installed = (): boolean => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || (navigator as BadgeNavigator).standalone === true;
function ios(): boolean { const ua = navigator.userAgent; return /iPad|iPhone|iPod/.test(ua) && /WebKit/.test(ua) && !/CriOS|FxiOS/.test(ua); }
function read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
export function vapidBytes(value: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) throw new Error('The application Host returned an invalid Push public key');
    const raw = atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
    if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('The application Host returned an invalid Push public key');
    return bytes;
}
async function endpointDigest(endpoint: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function sameKey(buffer: ArrayBuffer | null | undefined, desired: Uint8Array): boolean {
    if (!buffer) return false;
    const actual = new Uint8Array(buffer); return actual.length === desired.length && actual.every((value, index) => value === desired[index]);
}

export class SourceNotificationsRuntime {
    private readonly lifetime = new AbortController();
    private readonly listeners = new Set<() => void>();
    private readonly disposers: Array<() => void> = [];
    private readonly appUrl: URL;
    private registration: ServiceWorkerRegistration | undefined;
    private settings: NotificationSettings | undefined;
    private starting: Promise<void> | undefined;
    private socket: WebSocket | undefined;
    private reconnect: ReturnType<typeof setTimeout> | undefined;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private retryMs = 500;
    private installPrompt: InstallPrompt | undefined;
    private lastBadge: number | undefined;
    private badgeTask: Promise<void> | undefined;
    private readonly notices = new Map<string, AppNotification>();
    private confirmedInMemory: { scope: string; publicKey: string; endpoint: string } | undefined;
    private admissionUnknown = false;
    private navigation: AbortController | undefined;
    private state: NotificationsState;

    readonly deviceId: string;

    constructor(private readonly api: AppNotificationsApi, private readonly options: SourceNotificationsUiOptions, base = document.baseURI) {
        this.appUrl = new URL('.', base);
        const deviceKey = `hhpi.notifications.device:${this.appUrl.href}`;
        this.deviceId = read(deviceKey) ?? crypto.randomUUID();
        try { localStorage.setItem(deviceKey, this.deviceId); } catch { /* This instance retains its device identity when browser storage is unavailable. */ }
        const standalone = installed(), badge = navigator as BadgeNavigator;
        this.state = { supported: appNotificationsSupported(),
            permission: typeof Notification === 'undefined' ? 'default' : Notification.permission, push: 'off', busy: false, connected: false,
            error: null, presenceError: null, badgeEnabled: read(BADGE_KEY) === 'true', badgeSupported: standalone && typeof badge.setAppBadge === 'function',
            unread: null, canInstall: false, iosInstall: ios() && !standalone, installed: standalone, installing: false,
            installDismissed: read(INSTALL_DISMISSED) === 'true', updateReady: false, updating: false, notices: [], openingId: null, navigationFailure: null };
        const beforeInstall = (event: Event): void => { event.preventDefault(); this.installPrompt = event as InstallPrompt; this.patch({ canInstall: true }); };
        const appInstalled = (): void => { this.installPrompt = undefined; this.patch({ installed: true, installing: false, canInstall: false, iosInstall: false, badgeSupported: typeof badge.setAppBadge === 'function' }); this.reconcileBadge(); };
        const visibility = (): void => { this.reportPresence(); if (document.visibilityState === 'visible') {
            void this.refreshPush().catch(error => this.patch({ error: message(error) })); void this.registration?.update().catch(() => {});
        } };
        const online = (): void => { void this.refreshPush(); };
        const pageHide = (): void => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'presence', visibility: 'hidden' })); };
        const storage = (event: StorageEvent): void => { if (event.key === BADGE_KEY || event.key === null) { this.patch({ badgeEnabled: read(BADGE_KEY) === 'true' }); this.reconcileBadge(); } };
        const workerMessage = (event: MessageEvent): void => {
            const parsed = appNotificationReferenceSchema.safeParse(event.data);
            if (!parsed.success) return;
            void this.openNotification(parsed.data).then(() => event.ports[0]?.postMessage({ opened: true }),
                () => event.ports[0]?.postMessage({ opened: false }));
        };
        window.addEventListener('beforeinstallprompt', beforeInstall); window.addEventListener('appinstalled', appInstalled);
        window.addEventListener('pagehide', pageHide); window.addEventListener('storage', storage); document.addEventListener('visibilitychange', visibility);
        window.addEventListener('online', online);
        navigator.serviceWorker?.addEventListener('message', workerMessage);
        this.disposers.push(() => { window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', appInstalled);
            window.removeEventListener('pagehide', pageHide); window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('online', online);
            navigator.serviceWorker?.removeEventListener('message', workerMessage); });
        this.disposers.push(options.subscribeUnread(() => this.reconcileBadge())); this.reconcileBadge();
    }
    readonly getSnapshot = (): NotificationsState => this.state;
    readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private patch(value: Partial<NotificationsState>): void { if (this.lifetime.signal.aborted) return; this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
    async start(): Promise<void> {
        if (this.starting) return this.starting;
        if (this.settings || this.lifetime.signal.aborted) return;
        this.starting = this.initialize();
        try { await this.starting; } finally { this.starting = undefined; }
    }
    private async initialize(): Promise<void> {
        try {
            const settings = remoteValue(await this.api.appNotificationSettings({ deviceId: this.deviceId }, this.lifetime.signal));
            this.lifetime.signal.throwIfAborted();
            this.acceptSettings(settings);
            this.patch({ error: settings.pushError ?? null });
            this.connect();
            if (isSecureContext && 'serviceWorker' in navigator) {
                try { await this.registerWorker(); await this.readBrowserPush(); }
                catch (error) { this.patch({ error: message(error) }); }
            }
            await this.resumeNotification();
        } catch (error) { if (!this.lifetime.signal.aborted) this.patch({ error: message(error) }); }
    }
    private acceptSettings(settings: NotificationSettings): void {
        const changed = !this.settings || appScopeKey(this.settings.scope) !== appScopeKey(settings.scope);
        if (changed && this.settings) {
            const socket = this.socket; this.socket = undefined;
            clearInterval(this.heartbeat); clearTimeout(this.reconnect); this.heartbeat = undefined; this.reconnect = undefined;
            socket?.close(); this.navigation?.abort(); this.notices.clear(); this.confirmedInMemory = undefined;
            this.patch({ connected: false, notices: [], navigationFailure: null, openingId: null, push: 'off' });
        }
        this.settings = settings;
        if (changed) this.options.onReady?.(settings.scope, this.deviceId);
    }
    private async registerWorker(): Promise<void> {
        const worker = new URL(this.settings!.workerPath.slice(1), this.appUrl); worker.searchParams.set('app', this.appUrl.pathname);
        const existing = await navigator.serviceWorker.getRegistration(this.appUrl.href);
        const owners = [existing?.active, existing?.waiting, existing?.installing].filter(Boolean) as ServiceWorker[];
        if (existing?.scope === this.appUrl.href && owners.some(owner => new URL(owner.scriptURL).pathname !== worker.pathname)) {
            throw new Error('Another application owns this service-worker scope. Use a separate app path or remove that registration explicitly before enabling application notifications.');
        }
        this.registration = await navigator.serviceWorker.register(worker.href, { scope: this.appUrl.pathname, updateViaCache: 'none' });
        if (this.lifetime.signal.aborted) return;
        const registration = this.registration;
        const changed = (): void => this.patch({ updateReady: Boolean(registration.waiting) });
        const updateFound = (): void => { const installing = registration.installing; if (installing) {
            installing.addEventListener('statechange', changed); this.disposers.push(() => installing.removeEventListener('statechange', changed));
        } changed(); };
        registration.addEventListener('updatefound', updateFound); updateFound();
        const check = setInterval(() => { void registration.update().catch(() => {}); }, 60 * 60 * 1000);
        this.disposers.push(() => { clearInterval(check); registration.removeEventListener('updatefound', updateFound); });
        if (!registration.active) await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => complete(new Error('The notification worker did not activate')), 15_000);
            const candidate = registration.installing ?? registration.waiting;
            const complete = (error?: Error): void => { clearTimeout(timeout); candidate?.removeEventListener('statechange', ready); this.lifetime.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
            const ready = (): void => { if (registration.active) complete(); else if (candidate?.state === 'redundant') complete(new Error('The notification worker could not be installed')); };
            const aborted = (): void => complete(new Error('Notification registration was cancelled'));
            candidate?.addEventListener('statechange', ready); this.lifetime.signal.addEventListener('abort', aborted, { once: true }); ready();
        });
    }
    private async verifyWorker(): Promise<void> {
        const worker = this.registration?.active;
        if (!worker || !this.settings) throw new Error('The notification worker is not ready');
        const identity = await new Promise<unknown>((resolve, reject) => {
            const channel = new MessageChannel();
            const timeout = setTimeout(() => complete(new Error('The active notification worker could not confirm its application scope. Close existing app windows and reopen before subscribing.')), 3000);
            const complete = (error: Error | null, value?: unknown): void => { clearTimeout(timeout); channel.port1.close(); this.lifetime.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(value); };
            const aborted = (): void => complete(new Error('Notification setup was cancelled'));
            this.lifetime.signal.addEventListener('abort', aborted, { once: true });
            channel.port1.onmessage = event => complete(null, event.data);
            worker.postMessage({ type: 'hhpi/app-notifications/info' }, [channel.port2]);
        });
        if (!identity || typeof identity !== 'object' || !('version' in identity) || identity.version !== 1
            || !('appPath' in identity) || identity.appPath !== this.appUrl.pathname) {
            throw new Error('The active notification worker belongs to another application. Close its windows and reopen before subscribing.');
        }
    }
    async checkUpdate(): Promise<void> {
        try { await this.registration?.update(); this.patch({ updateReady: Boolean(this.registration?.waiting) }); }
        catch (error) { this.patch({ error: message(error) }); }
    }
    async applyUpdate(): Promise<void> {
        if (this.state.updating || this.lifetime.signal.aborted) return;
        this.patch({ updating: true, error: null });
        let cancelReload: (() => void) | undefined;
        try {
            // Let the root modal make editors inert before asynchronous saves.
            if (typeof requestAnimationFrame === 'function') await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (!this.options.prepareUpdate) throw new Error('Workspace editor preparation is not ready. The page has not been reloaded.');
            const waiting = this.registration?.waiting;
            await this.options.prepareUpdate(); this.lifetime.signal.throwIfAborted();
            if (waiting && this.registration?.waiting !== waiting) throw new Error('The available update changed while saving. Check the update again.');
            if (waiting) await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => finish(new Error('The updated worker did not activate. Drafts are saved and the current page is still open.')), 10_000);
                const changed = () => { if (navigator.serviceWorker.controller === waiting) finish(); };
                const cancelled = () => finish(new Error('The workspace closed before the update activated.'));
                const finish = (error?: Error) => { clearTimeout(timeout); navigator.serviceWorker.removeEventListener('controllerchange', changed); this.lifetime.signal.removeEventListener('abort', cancelled); error ? reject(error) : resolve(); };
                navigator.serviceWorker.addEventListener('controllerchange', changed);
                this.lifetime.signal.addEventListener('abort', cancelled, { once: true });
                try { waiting.postMessage({ type: 'SKIP_WAITING' }); changed(); }
                catch (error) { finish(error instanceof Error ? error : new Error(message(error))); }
            });
            this.lifetime.signal.throwIfAborted();
            cancelReload = this.options.armForReload?.();
            location.reload();
        } catch (error) {
            cancelReload?.();
            this.patch({ error: message(error), updating: false });
        }
    }
    private connect(): void {
        if (this.lifetime.signal.aborted || !this.settings || this.socket) return;
        const url = new URL(this.settings.streamPath.slice(1), this.appUrl); url.searchParams.set('deviceId', this.deviceId); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url); this.socket = socket;
        socket.onopen = () => { if (this.socket !== socket || this.lifetime.signal.aborted) { socket.close(); return; }
            this.retryMs = 500; this.reportPresence(); this.heartbeat = setInterval(() => this.reportPresence(), NOTIFICATION_HEARTBEAT_MS); };
        socket.onmessage = event => {
            // Bound the complete carrier as well as the validated notification fields.
            if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 256 * 1024) return;
            try { const value = appNotificationFrameSchema.parse(JSON.parse(event.data));
                if (value.type === 'ready') {
                    if (appScopeKey(value.scope) !== appScopeKey(this.settings!.scope) || value.deviceId !== this.deviceId) throw new Error('Notification account changed');
                } else if (value.type === 'status') this.patch({ connected: value.connected, presenceError: value.error ?? (value.syncState === 'recovering' ? 'Source notifications are recovering after a connection gap.' : value.syncState === 'denied' ? 'Source notification access was revoked.' : null) });
                else if (appScopeKey(value.notification.scope) === appScopeKey(this.settings!.scope)) {
                    this.notices.set(value.notification.id, value.notification);
                    while (this.notices.size > 20) this.notices.delete(this.notices.keys().next().value!);
                    this.patch({ notices: [...this.notices.values()] });
                }
            } catch { socket.close(4008, 'Invalid application notification frame'); this.patch({ presenceError: 'The notification stream returned another account or an incompatible message' }); }

        };
        socket.onerror = () => { socket.close(); };
        socket.onclose = () => { if (this.socket !== socket) return; this.socket = undefined; clearInterval(this.heartbeat); this.heartbeat = undefined;
            this.patch({ connected: false }); if (!this.lifetime.signal.aborted) { const wait = this.retryMs; this.retryMs = Math.min(15_000, wait * 2); this.reconnect = setTimeout(() => this.connect(), wait); } };
    }
    private reportPresence(): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'presence', visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden' })); }
    async refreshPush(): Promise<void> {
        if (this.lifetime.signal.aborted) return;
        try {
            // Account services must recover even in browsers without Push.
            if (!this.settings) { await this.start(); return; }
            if (this.starting) { await this.starting; return; }
            if (!this.registration && isSecureContext && 'serviceWorker' in navigator) await this.registerWorker();
            await this.readBrowserPush();
        }
        catch (error) { this.patch({ error: message(error) }); }
    }
    private async readBrowserPush(): Promise<void> {
        if (!this.state.supported || !this.registration || !this.settings) return;
        const permission = Notification.permission, subscription = await this.registration.pushManager.getSubscription();
        if (!subscription || permission !== 'granted') { this.patch({ permission, push: 'off' }); return; }
        let confirmed = false;
        if (!this.admissionUnknown && this.confirmedInMemory?.scope === appScopeKey(this.settings.scope) && this.confirmedInMemory.publicKey === this.settings.vapidPublicKey && this.confirmedInMemory.endpoint === subscription.endpoint) confirmed = true;
        else if (!this.admissionUnknown) try { const stored = JSON.parse(read(REGISTERED) ?? 'null') as { scope?: unknown; publicKey?: unknown; digest?: unknown } | null;
            confirmed = stored?.scope === appScopeKey(this.settings.scope) && stored.publicKey === this.settings.vapidPublicKey && stored.digest === await endpointDigest(subscription.endpoint);
        } catch { /* Local possession does not prove application Host admission. */ }
        this.patch({ permission, push: confirmed ? 'on' : 'unknown' });
    }
    async enablePush(): Promise<void> {
        if (this.state.busy || !this.state.supported) return;
        this.patch({ busy: true, error: null });
        try {
            // The only permission prompt, called directly by the user's button.
            const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission; this.patch({ permission });
            if (permission !== 'granted') { this.patch({ push: 'off' }); return; }
            if (this.starting) await this.starting;
            const settings = remoteValue(await this.api.appNotificationSettings({ deviceId: this.deviceId }, this.lifetime.signal));
            this.lifetime.signal.throwIfAborted();
            this.acceptSettings(settings); this.connect();
            if (!settings.vapidPublicKey) throw new Error(settings.pushError ?? 'The application Host has not provided a Push public key');
            if (!this.registration) await this.registerWorker();
            if (!this.registration?.active) throw new Error('The notification worker is not ready');
            await this.verifyWorker();
            const key = vapidBytes(settings.vapidPublicKey), existing = await this.registration.pushManager.getSubscription();
            let subscription = existing;
            let oldScope: unknown; try { oldScope = JSON.parse(read(REGISTERED) ?? 'null')?.scope; } catch { /* Migrate by replacing an unidentified subscription. */ }
            if (existing && (!sameKey(existing.options.applicationServerKey, key) || oldScope !== appScopeKey(settings.scope))) {
                if (!await existing.unsubscribe()) throw new Error('The previous Push subscription could not be stopped');
                // The dead browser endpoint is safe even if Host cleanup is
                // unavailable. A new endpoint never inherits another account's Push.
                await this.api.appPushUnsubscribe({ deviceId: this.deviceId, endpoint: existing.endpoint }, this.lifetime.signal).catch(() => undefined);
                subscription = null;
            }
            if (!subscription) subscription = await this.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
            const value = subscription.toJSON();
            if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) throw new Error('The browser did not return a complete Push subscription');
            this.lifetime.signal.throwIfAborted();
            this.confirmedInMemory = undefined; this.admissionUnknown = true;
            // Invalidate an older admission before the explicit new write. A
            // lost reply must remain unknown even if the browser is refreshed.
            localStorage.removeItem(REGISTERED);
            remoteValue(await this.api.appPushSubscribe({ deviceId: this.deviceId, subscription: { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } } }, this.lifetime.signal));
            this.lifetime.signal.throwIfAborted();
            this.confirmedInMemory = { scope: appScopeKey(settings.scope), publicKey: settings.vapidPublicKey, endpoint: value.endpoint };
            this.admissionUnknown = false;
            this.patch({ push: 'on' });
            // Confirmation metadata and a public VAPID key only; no Push key or
            // endpoint capability is placed in localStorage.
            localStorage.setItem(REGISTERED, JSON.stringify({ scope: appScopeKey(settings.scope), publicKey: settings.vapidPublicKey, digest: await endpointDigest(value.endpoint) }));
            localStorage.setItem(VAPID_KEY, settings.vapidPublicKey);
        } catch (error) {
            this.patch({ error: message(error) });
            if (!this.confirmedInMemory) this.patch({ push: 'unknown' });
        } finally { this.patch({ busy: false }); }
    }
    async disablePush(): Promise<void> {
        if (this.state.busy || this.lifetime.signal.aborted) return;
        const scope = this.settings && appScopeKey(this.settings.scope);
        const current = (): void => {
            this.lifetime.signal.throwIfAborted();
            if (scope && (!this.settings || appScopeKey(this.settings.scope) !== scope)) throw new Error('The notification account changed. Stop notifications from the current account.');
        };
        this.patch({ busy: true, error: null });
        try {
            // A Settings click can precede the initial worker registration.
            // Finish that owner first so its late browser read cannot undo stop.
            if (this.starting) await this.starting;
            else if (!this.settings) await this.start();
            current();
            if (!this.registration) {
                if (!this.settings) throw new Error('Notification setup is not ready. Refresh browser status and retry stopping notifications.');
                await this.registerWorker(); current();
            }
            const registration = this.registration;
            if (!registration) throw new Error('The notification worker is not ready. Retry stopping notifications.');
            const subscription = await registration.pushManager.getSubscription();
            current();
            if (subscription) {
                const stopped = await subscription.unsubscribe(); current();
                if (!stopped) throw new Error('The browser could not stop its Push subscription');
            }
            this.confirmedInMemory = undefined; this.admissionUnknown = false; this.patch({ push: 'off' });
            let storageError: unknown;
            try { localStorage.removeItem(REGISTERED); localStorage.removeItem(VAPID_KEY); } catch (error) { storageError = error; }
            if (subscription) remoteValue(await this.api.appPushUnsubscribe({ deviceId: this.deviceId, endpoint: subscription.endpoint }, this.lifetime.signal));
            if (storageError) throw storageError;
        } catch (error) { this.patch({ error: message(error) }); }
        finally { this.patch({ busy: false }); }
    }
    setBadgeEnabled(value: boolean): void {
        this.patch({ badgeEnabled: value, error: null }); this.reconcileBadge();
        try { if (value) localStorage.setItem(BADGE_KEY, 'true'); else localStorage.removeItem(BADGE_KEY); }
        catch (error) { this.patch({ error: `Badge preference could not be saved: ${message(error)}` }); }
    }
    private reconcileBadge(): void {
        const count = this.options.getUnreadCount();
        if (count !== null && Number.isSafeInteger(count) && count >= 0) this.patch({ unread: count });
        if (!this.state.badgeSupported || this.badgeTask) return;
        const target = this.state.badgeEnabled ? this.state.unread : 0;
        if (target === null || target === this.lastBadge) return;
        const badge = navigator as BadgeNavigator;
        this.badgeTask = Promise.resolve().then(() => target > 0 ? badge.setAppBadge?.(target) : badge.clearAppBadge ? badge.clearAppBadge() : badge.setAppBadge?.(0)).then(() => {
            this.lastBadge = target;
        }, error => { this.patch({ error: `The system badge could not be updated: ${message(error)}` }); }).finally(() => {
            this.badgeTask = undefined;
            if (this.lastBadge === target && target !== (this.state.badgeEnabled ? this.state.unread : 0)) this.reconcileBadge();
        });
    }
    async promptInstall(): Promise<void> {
        const prompt = this.installPrompt; if (!prompt || this.state.installing) return;
        this.installPrompt = undefined; this.patch({ installing: true, canInstall: false, error: null });
        try { await prompt.prompt(); await prompt.userChoice; }
        catch (error) { this.patch({ error: message(error) }); }
        finally { this.patch({ installing: false }); }
    }
    dismissInstall(): void { this.patch({ installDismissed: true }); try { localStorage.setItem(INSTALL_DISMISSED, 'true'); } catch (error) { this.patch({ error: message(error) }); } }
    dismiss(id: string): void { this.notices.delete(id); this.patch({ notices: [...this.notices.values()] }); }
    dismissNavigationError(): void { this.patch({ navigationFailure: null }); }
    async retryNavigation(): Promise<void> {
        const failure = this.state.navigationFailure;
        if (failure) await this.openNotification(failure.reference);
    }
    async openNotification(value: AppNotificationReference): Promise<void> {
        this.navigation?.abort(new Error('A newer notification was opened.'));
        const navigation = new AbortController(); this.navigation = navigation;
        const signal = AbortSignal.any([this.lifetime.signal, navigation.signal]);
        const navigationCurrent = this.options.captureNavigation?.();
        this.patch({ openingId: value.notificationId, navigationFailure: null });
        try {
            const reference = appNotificationReferenceSchema.parse(value);
            if (!this.settings || appScopeKey(reference.scope) !== appScopeKey(this.settings.scope) || reference.deviceId !== this.deviceId) {
                throw new Error('This notification belongs to another account or browser. Sign in to its original account to open it.');
            }
            const result = remoteValue(await this.api.appNotificationResolve({ deviceId: this.deviceId, notificationId: reference.notificationId }, signal));
            if (navigationCurrent && !navigationCurrent()) navigation.abort(new Error('A newer navigation replaced this notification.'));
            signal.throwIfAborted();
            await this.options.openSource(result.target, result.requestState, signal);
            signal.throwIfAborted();
        } catch (error) {
            if (!signal.aborted) this.patch({ error: message(error), navigationFailure: { reference: value, message: message(error) } });
            throw error;
        } finally {
            if (this.navigation === navigation) { this.navigation = undefined; this.patch({ openingId: null }); }
        }
    }
    async open(notice: AppNotification): Promise<void> {
        await this.openNotification({ type: 'app-notification', scope: notice.scope, deviceId: this.deviceId, notificationId: notice.id });
    }
    private async resumeNotification(): Promise<void> {
        const url = new URL(typeof location.href === 'string' ? location.href : document.baseURI);
        const notificationId = url.searchParams.get('hhpiNotification');
        if (!notificationId) return;
        await this.openNotification({ type: 'app-notification', notificationId,
            scope: { accountId: url.searchParams.get('hhpiAccount') ?? '', origin: url.searchParams.get('hhpiOrigin') ?? '' },
            deviceId: url.searchParams.get('hhpiDevice') ?? '' });
        for (const key of ['hhpiNotification', 'hhpiAccount', 'hhpiOrigin', 'hhpiDevice']) url.searchParams.delete(key);
        if (typeof history !== 'undefined') history.replaceState(history.state, '', url.href);
    }
    close(): void {
        if (this.lifetime.signal.aborted) return;
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'presence', visibility: 'hidden' }));
        this.lifetime.abort(); clearInterval(this.heartbeat); clearTimeout(this.reconnect); this.socket?.close(1000, 'Workspace notification owner closed');
        this.socket = undefined; for (const dispose of this.disposers.splice(0).reverse()) dispose(); this.listeners.clear();
    }
}
