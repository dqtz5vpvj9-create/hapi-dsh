/** Explicit browser API lifecycle fixtures; these do not claim OS Push delivery or installation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceNotificationsRuntime, vapidBytes } from '../src/client/source-notifications/runtime.ts';
import { NOTIFICATIONS_STREAM_PATH, NOTIFICATIONS_WORKER_PATH, type AppNotificationsApi } from '../src/notification-types.ts';
import type { AppServiceResponse } from '../src/workspace/app-service-types.ts';
type NotificationSettings = AppServiceResponse<'appNotificationSettings'>;

function replace(name: string, value: unknown): () => void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { configurable: true, value });
    return () => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const publicKey = Buffer.from([4, ...Array<number>(64).fill(7)]).toString('base64url');
function fixture(options: { installed?: boolean; pushConfigured?: boolean; pushSupported?: boolean; onReady?: (scope: NotificationSettings['scope'], deviceId: string) => void; prepareUpdate?: () => Promise<void>; armForReload?: () => () => void; reload?: () => void; launchUrl?: string; captureNavigation?: () => () => boolean;
    settings?: (value: NotificationSettings) => Promise<NotificationSettings>;
    resolve?: () => Promise<AppServiceResponse<'appNotificationResolve'>> } = {}) {
    const memory = new Map<string, string>(), events = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: 'visible', baseURI: 'https://workspace.fixture/' });
    const requested: unknown[] = [], removed: string[] = [], socketFrames: unknown[] = [], registers: string[] = [], badges: number[] = [], opened: unknown[] = [];
    const sockets: Socket[] = [], socketCloseCodes: number[] = [];
    memory.set('hhpi.notifications.device:https://workspace.fixture/', 'fixture-device');
    const updates: unknown[] = [], resolved: unknown[] = [], replacedUrls: string[] = []; let reloads = 0;
    let failSubscribe = false, failDelete = false, permissionRequests = 0, browserSubscriptions = 0, browserUnsubscriptions = 0, workerVersion = 1;
    let current: PushSubscription | null = null, subscriptionRead: Promise<void> | undefined, unread: number | null = 3, unreadChanged: (() => void) | undefined;
    const settings: NotificationSettings = { scope: { accountId: 'fixture-account', origin: 'https://workspace.fixture' }, deviceId: 'fixture-device', vapidPublicKey: options.pushConfigured === false ? null : publicKey,
        ...(options.pushConfigured === false ? { pushError: 'Original Push configuration is unavailable' } : {}), workerPath: NOTIFICATIONS_WORKER_PATH, streamPath: NOTIFICATIONS_STREAM_PATH };
    const api: AppNotificationsApi = {
        appNotificationSettings: async request => ({ ok: true, value: options.settings ? await options.settings({ ...settings, deviceId: request.deviceId }) : { ...settings, deviceId: request.deviceId } }),
        appPushSubscribe: async value => { requested.push(structuredClone(value)); if (failSubscribe) throw { message: 'Original subscribe reply was lost' }; return { ok: true, value: { subscribed: true } }; },
        appPushUnsubscribe: async value => { removed.push(value.endpoint); if (failDelete) throw { message: 'Original delete reply was lost' }; return { ok: true, value: { unsubscribed: true } }; },
        appNotificationResolve: async request => { resolved.push(request); if (options.resolve) return { ok: true, value: await options.resolve() }; return { ok: true, value: { target: { kind: 'request', source: { kind: 'local-dsh', hostId: 'local', sessionId: 'original-session' }, position: { kind: 'dsh', seq: 42 }, requestId: 'original-request' }, requestState: 'settled' } }; },
    };
    class Permission {
        static permission: NotificationPermission = 'default';
        static async requestPermission(): Promise<NotificationPermission> { permissionRequests++; this.permission = 'granted'; return 'granted'; }
    }
    class Socket {
        static OPEN = 1; static CLOSED = 3;
        readyState = 0; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
        constructor(readonly url: URL) { sockets.push(this); queueMicrotask(() => { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'status', connected: true }) }); }); }
        send(data: string) { socketFrames.push(JSON.parse(data)); }
        close(code?: number, reason = '') {
            if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException('Invalid browser WebSocket close code', 'InvalidAccessError');
            if (Buffer.byteLength(reason, 'utf8') > 123) throw new DOMException('WebSocket close reason exceeds 123 bytes', 'SyntaxError');
            if (this.readyState === 3) return;
            if (code !== undefined) socketCloseCodes.push(code);
            this.readyState = 3; this.onclose?.();
        }
    }
    const registration = Object.assign(new EventTarget(), {
        scope: 'https://workspace.fixture/', waiting: null as ServiceWorker | null, installing: null,
        active: { scriptURL: 'https://workspace.fixture' + NOTIFICATIONS_WORKER_PATH, state: 'activated',
            postMessage(_data: unknown, ports: MessagePort[]) { ports[0]!.postMessage({ version: workerVersion, appPath: '/' }); ports[0]!.close(); } },
        update: async () => {},
        pushManager: {
            getSubscription: async () => { const value = current; await subscriptionRead; return value; },
            subscribe: async (value: PushSubscriptionOptionsInit) => {
                browserSubscriptions++;
                const endpoint = `https://push.fixture.invalid/capability-${browserSubscriptions}`;
                const subscription = { endpoint, options: { applicationServerKey: (value.applicationServerKey as Uint8Array).slice().buffer },
                    toJSON: () => ({ endpoint, keys: { p256dh: 'P'.repeat(88), auth: 'A'.repeat(24) } }),
                    unsubscribe: async () => { browserUnsubscriptions++; if (current === subscription) current = null; return true; },
                } as unknown as PushSubscription;
                current = subscription; return subscription;
            },
        },
    });
    const workers = Object.assign(new EventTarget(), { controller: null as ServiceWorker | null, getRegistration: async () => registration,
        register: async (url: string) => { registers.push(url); return registration; } });
    const navigator = { userAgent: 'Fixture desktop', serviceWorker: workers, standalone: options.installed === true,
        setAppBadge: async (count: number = 0) => { badges.push(count); }, clearAppBadge: async () => { badges.push(0); } };
    const window = Object.assign(events, { ...(options.pushSupported === false ? {} : { PushManager: class {} }), Notification: Permission });
    const restore = [replace('window', window), replace('document', document), replace('navigator', navigator), replace('Notification', Permission), replace('WebSocket', Socket),
        replace('location', { href: options.launchUrl ?? 'https://workspace.fixture/', reload: () => { reloads++; options.reload?.(); } }),
        replace('history', { state: null, replaceState(_state: unknown, _title: string, url: string) { replacedUrls.push(url); } }),
        replace('isSecureContext', true), replace('matchMedia', () => ({ matches: false })),
        replace('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } })];
    const runtime = new SourceNotificationsRuntime(api, { getUnreadCount: () => unread, subscribeUnread: listener => { unreadChanged = listener; return () => { unreadChanged = undefined; }; },
        openSource: (target, requestState) => { opened.push({ target, requestState }); }, ...(options.onReady ? { onReady: options.onReady } : {}), ...(options.prepareUpdate ? { prepareUpdate: options.prepareUpdate } : {}),
        ...(options.armForReload ? { armForReload: options.armForReload } : {}),
        ...(options.captureNavigation ? { captureNavigation: options.captureNavigation } : {}) });
    return { runtime, memory, requested, removed, socketFrames, sockets, socketCloseCodes, registers, badges, opened, events, document, settings, resolved, replacedUrls,
        permissionRequests: () => permissionRequests, browserSubscriptions: () => browserSubscriptions, browserUnsubscriptions: () => browserUnsubscriptions,
        existingBrowserSubscription: () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(publicKey) }),
        pauseSubscriptionRead() { let release!: () => void; subscriptionRead = new Promise<void>(resolve => { release = resolve; }); return () => { subscriptionRead = undefined; release(); }; },
        failSubscribe(value: boolean) { failSubscribe = value; }, failDelete(value: boolean) { failDelete = value; }, workerHub(_value: string) { workerVersion = 0; },
        permission(value: NotificationPermission) { Permission.permission = value; },
        unread(value: number | null) { unread = value; unreadChanged?.(); },
        reloads: () => reloads, updates, workerController: () => workers.controller,
        waiting() {
            const next = { state: 'installed', scriptURL: 'https://workspace.fixture' + NOTIFICATIONS_WORKER_PATH,
                postMessage(value: unknown) { updates.push(value); queueMicrotask(() => { workers.controller = next as unknown as ServiceWorker; workers.dispatchEvent(new Event('controllerchange')); }); },
            };
            registration.waiting = next as unknown as ServiceWorker; return next;
        },
        close() { runtime.close(); for (const undo of restore.reverse()) undo(); } };
}

test('initial notification mount registers the owned worker and reports real presence without requesting permission or subscribing', async () => {
    const browser = fixture();
    try {
        await browser.runtime.start(); await settle();
        assert.equal(browser.permissionRequests(), 0); assert.equal(browser.browserSubscriptions(), 0); assert.equal(browser.requested.length, 0);
        assert.equal(browser.registers.length, 1); assert.equal(new URL(browser.registers[0]!).pathname, NOTIFICATIONS_WORKER_PATH);
        assert.deepEqual(browser.socketFrames[0], { type: 'presence', visibility: 'visible' }); assert.equal(browser.runtime.getSnapshot().connected, true);
        browser.document.visibilityState = 'hidden'; browser.document.dispatchEvent(new Event('visibilitychange'));
        assert.deepEqual(browser.socketFrames.at(-1), { type: 'presence', visibility: 'hidden' });
        browser.runtime.close(); assert.deepEqual(browser.socketFrames.at(-1), { type: 'presence', visibility: 'hidden' });
    } finally { browser.close(); }
});

test('an account-mismatched frame closes with a browser-valid application code and still recovers its original account stream', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const browser = fixture();
    try {
        await browser.runtime.start(); await settle();
        const socket = browser.sockets[0]!;
        assert.throws(() => socket.close(1008), { name: 'InvalidAccessError' }, 'the socket fixture enforces the browser close-code restriction');
        assert.equal(socket.readyState, 1);
        assert.doesNotThrow(() => socket.onmessage?.({ data: JSON.stringify({ type: 'ready', scope: { ...browser.settings.scope, accountId: 'another-account' }, deviceId: browser.runtime.deviceId }) }));
        assert.deepEqual(browser.socketCloseCodes, [4008]);
        assert.equal(socket.readyState, 3); assert.equal(browser.runtime.getSnapshot().connected, false);
        assert.match(browser.runtime.getSnapshot().presenceError!, /another account/);
        socket.onmessage?.({ data: JSON.stringify({ type: 'status', connected: true }) });
        assert.equal(browser.runtime.getSnapshot().connected, false, 'the rejected socket can no longer publish status');
        assert.deepEqual(browser.runtime.getSnapshot().notices, []); assert.deepEqual(browser.resolved, []); assert.deepEqual(browser.opened, []);
        t.mock.timers.tick(500); await settle();
        assert.equal(browser.sockets.length, 2); assert.equal(browser.runtime.getSnapshot().connected, true);
        browser.sockets[1]!.onmessage?.({ data: JSON.stringify({ type: 'ready', scope: browser.settings.scope, deviceId: browser.runtime.deviceId }) });
        assert.deepEqual(browser.socketCloseCodes, [4008]); assert.equal(browser.runtime.getSnapshot().presenceError, null);
    } finally { browser.close(); }
});

test('unknown application admission stays unknown after a browser refresh; only explicit retry writes and stored confirmation contains no Push capability', async () => {
    const browser = fixture();
    try {
        await browser.runtime.start(); browser.failSubscribe(true); await browser.runtime.enablePush();
        assert.equal(browser.permissionRequests(), 1); assert.equal(browser.requested.length, 1); assert.equal(browser.runtime.getSnapshot().push, 'unknown');
        assert.match(browser.runtime.getSnapshot().error!, /reply was lost/);
        await browser.runtime.refreshPush(); assert.equal(browser.requested.length, 1); assert.equal(browser.runtime.getSnapshot().push, 'unknown');
        browser.failSubscribe(false); await browser.runtime.enablePush(); assert.equal(browser.requested.length, 2); assert.equal(browser.runtime.getSnapshot().push, 'on');
        const stored = [...browser.memory.values()].join('\n'); assert.equal(stored.includes('capability-'), false); assert.equal(stored.includes('P'.repeat(32)), false); assert.equal(stored.includes('A'.repeat(24)), false);
        assert.equal(browser.memory.get('hhpi.push.publicKey'), publicKey);
        browser.failDelete(true); await browser.runtime.disablePush(); assert.equal(browser.runtime.getSnapshot().push, 'off'); assert.match(browser.runtime.getSnapshot().error!, /delete reply was lost/);
        assert.equal(browser.memory.has('hhpi.push.confirmed'), false); assert.ok(browser.browserUnsubscriptions() >= 1);
    } finally { browser.close(); }
});

test('Disable Push clicked during initial account setup waits for its worker and revokes the existing browser subscription', async () => {
    let ready!: () => void;
    const accountReady = new Promise<void>(resolve => { ready = resolve; });
    const browser = fixture({ settings: async value => { await accountReady; return value; } });
    try {
        browser.permission('granted');
        const original = await browser.existingBrowserSubscription();
        const starting = browser.runtime.start(), stopping = browser.runtime.disablePush();
        ready(); await Promise.all([starting, stopping]);
        assert.equal(browser.browserUnsubscriptions(), 1, 'the explicit stop is not lost while initial settings are pending');
        assert.deepEqual(browser.removed, [original.endpoint]);
        assert.equal(browser.runtime.getSnapshot().push, 'off');
        assert.equal(browser.runtime.getSnapshot().busy, false);
        assert.equal(browser.permissionRequests(), 0);
    } finally { ready(); browser.close(); }
});

test('a delayed Disable Push from a retired account cannot revoke the replacement browser subscription', async () => {
    const browser = fixture();
    try {
        await browser.runtime.start(); await browser.runtime.enablePush();
        const release = browser.pauseSubscriptionRead();
        const stopping = browser.runtime.disablePush();
        browser.runtime.close();
        const replacement = await browser.existingBrowserSubscription();
        release(); await stopping;
        assert.equal(browser.browserUnsubscriptions(), 0, 'retired account work cannot unsubscribe after its browser read settles');
        assert.deepEqual(browser.removed, [], 'no old-account Host unsubscribe is dispatched');
        assert.equal(browser.browserSubscriptions(), 2);
        assert.match(replacement.endpoint, /capability-2$/);
    } finally { browser.close(); }
});

test('a new unknown registration cannot inherit the previous successful confirmation for the same browser endpoint', async () => {
    const browser = fixture();
    try {
        await browser.runtime.start(); await browser.runtime.enablePush(); assert.equal(browser.runtime.getSnapshot().push, 'on');
        const creations = browser.browserSubscriptions(); browser.failSubscribe(true); await browser.runtime.enablePush();
        assert.equal(browser.browserSubscriptions(), creations); assert.equal(browser.runtime.getSnapshot().push, 'unknown');
        await browser.runtime.refreshPush(); assert.equal(browser.runtime.getSnapshot().push, 'unknown'); assert.equal(browser.requested.length, 2);
        assert.equal(browser.memory.has('hhpi.push.confirmed'), false);
    } finally { browser.close(); }
});

test('an active incompatible worker cannot accept a new Push subscription', async () => {
    const browser = fixture();
    try {
        await browser.runtime.start(); browser.workerHub('previous-hub'); await browser.runtime.enablePush();
        assert.equal(browser.browserSubscriptions(), 0); assert.equal(browser.requested.length, 0); assert.match(browser.runtime.getSnapshot().error!, /another application/);
    } finally { browser.close(); }
});

test('missing original Push configuration leaves foreground presence and the worker operational without a dummy public key', async () => {
    const browser = fixture({ pushConfigured: false });
    try {
        await browser.runtime.start(); await settle(); assert.equal(browser.runtime.getSnapshot().connected, true); assert.equal(browser.registers.length, 1);
        assert.deepEqual(browser.socketFrames[0], { type: 'presence', visibility: 'visible' }); assert.match(browser.runtime.getSnapshot().error!, /configuration is unavailable/);
        await browser.runtime.enablePush(); assert.equal(browser.browserSubscriptions(), 0); assert.equal(browser.requested.length, 0);
        assert.throws(() => vapidBytes('invalid-key'), /invalid Push public key/);
    } finally { browser.close(); }
});

test('App Badge retains uncertain read counts while notification opening resolves only the stored exact request', async () => {
    const browser = fixture({ installed: true });
    try {
        await browser.runtime.start(); await settle(); assert.deepEqual(browser.badges, [0]);
        browser.runtime.setBadgeEnabled(true); await settle(); assert.equal(browser.badges.at(-1), 3);
        const count = browser.badges.length; browser.unread(null); await settle(); assert.equal(browser.badges.length, count);
        browser.unread(7); await settle(); assert.equal(browser.badges.at(-1), 7);
        const reference = { type: 'app-notification' as const, scope: browser.settings.scope, deviceId: browser.runtime.deviceId, notificationId: 'original-notice' };
        await assert.rejects(browser.runtime.openNotification({ ...reference, scope: { ...reference.scope, accountId: 'another-account' } }), /another account/);
        assert.deepEqual(browser.opened, []); assert.deepEqual(browser.resolved, []);
        await browser.runtime.openNotification(reference);
        assert.deepEqual(browser.resolved, [{ deviceId: 'fixture-device', notificationId: 'original-notice' }]);
        assert.deepEqual(browser.opened, [{ target: { kind: 'request', source: { kind: 'local-dsh', hostId: 'local', sessionId: 'original-session' },
            position: { kind: 'dsh', seq: 42 }, requestId: 'original-request' }, requestState: 'settled' }]);
        browser.runtime.setBadgeEnabled(false); await settle(); assert.equal(browser.badges.at(-1), 0);
    } finally { browser.close(); }
});

test('a blocked permission can recover after browser settings change without a mount-time permission prompt', async () => {
    const browser = fixture();
    try {
        browser.permission('denied'); await browser.runtime.start(); await browser.runtime.enablePush();
        assert.equal(browser.permissionRequests(), 0); assert.equal(browser.runtime.getSnapshot().push, 'off');
        await browser.runtime.disablePush(); browser.permission('denied'); await browser.runtime.refreshPush();
        assert.equal(browser.runtime.getSnapshot().permission, 'denied');
        browser.permission('granted'); await browser.runtime.refreshPush(); await browser.runtime.enablePush();
        assert.equal(browser.runtime.getSnapshot().push, 'on');
    } finally { browser.close(); }
});

test('authenticated startup continues the original opaque notification and only then removes its URL fields', async () => {
    const url = new URL('https://workspace.fixture/?other=kept');
    for (const [key, value] of Object.entries({ hhpiNotification: 'original-notice', hhpiAccount: 'fixture-account',
        hhpiOrigin: 'https://workspace.fixture', hhpiDevice: 'fixture-device' })) url.searchParams.set(key, value);
    const browser = fixture({ launchUrl: url.href });
    try {
        await browser.runtime.start();
        assert.deepEqual(browser.resolved, [{ deviceId: 'fixture-device', notificationId: 'original-notice' }]);
        assert.equal(browser.opened.length, 1); assert.equal(new URL(browser.replacedUrls[0]!).searchParams.get('other'), 'kept');
        assert.equal(new URL(browser.replacedUrls[0]!).searchParams.has('hhpiNotification'), false);
    } finally { browser.close(); }
});

test('a notification for another account stays in the login URL and cannot resolve against the current account', async () => {
    const browser = fixture({ launchUrl: 'https://workspace.fixture/?hhpiNotification=original&hhpiAccount=another-account&hhpiDevice=fixture-device&hhpiOrigin=https%3A%2F%2Fworkspace.fixture' });
    try {
        await browser.runtime.start();
        assert.deepEqual(browser.resolved, []); assert.deepEqual(browser.opened, []); assert.deepEqual(browser.replacedUrls, []);
        assert.match(browser.runtime.getSnapshot().error!, /original account/);
    } finally { browser.close(); }
});

test('a late notification resolution after logout/unmount cannot navigate or mark the old request read', async () => {
    const reply = Promise.withResolvers<AppServiceResponse<'appNotificationResolve'>>();
    const browser = fixture({ resolve: () => reply.promise });
    try {
        await browser.runtime.start();
        const pending = browser.runtime.openNotification({ type: 'app-notification', scope: browser.settings.scope,
            deviceId: browser.runtime.deviceId, notificationId: 'old-request-notice' });
        const rejected = assert.rejects(pending, /abort/iu);
        browser.runtime.close();
        reply.resolve({ target: { kind: 'request', source: { kind: 'local-dsh', hostId: 'local', sessionId: 'original-session' },
            position: { kind: 'dsh', seq: 42 }, requestId: 'old-request' }, requestState: 'settled' });
        await rejected; assert.deepEqual(browser.opened, []); assert.deepEqual(browser.replacedUrls, []);
    } finally { browser.close(); }
});

test('accepting an installation prompt is not reported as installed until the browser emits appinstalled', async () => {
    const browser = fixture(); let prompts = 0;
    try {
        await browser.runtime.start();
        const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => { prompts++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
        browser.events.dispatchEvent(offer); assert.equal(offer.defaultPrevented, true); assert.equal(browser.runtime.getSnapshot().canInstall, true);
        await browser.runtime.promptInstall(); assert.equal(prompts, 1); assert.equal(browser.runtime.getSnapshot().installed, false); assert.equal(browser.runtime.getSnapshot().canInstall, false);
        browser.events.dispatchEvent(new Event('appinstalled')); assert.equal(browser.runtime.getSnapshot().installed, true);
    } finally { browser.close(); }
});

test('a failed editor checkpoint leaves the document and waiting worker untouched', async () => {
    let armed = false;
    const browser = fixture({ prepareUpdate: async () => { throw new Error('The original file draft could not be saved'); }, armForReload: () => { armed = true; return () => {}; } });
    try {
        await browser.runtime.start(); browser.waiting(); await browser.runtime.applyUpdate();
        assert.equal(browser.reloads(), 0); assert.deepEqual(browser.updates, []);
        assert.equal(armed, false);
        assert.equal(browser.runtime.getSnapshot().updating, false); assert.match(browser.runtime.getSnapshot().error!, /file draft could not be saved/u);
    } finally { browser.close(); }
});

test('reading tickets activate after actual worker activation immediately before reload and roll back if reload fails', async () => {
    const order: string[] = []; let next: unknown;
    const browser = fixture({ prepareUpdate: async () => { order.push('save'); },
        armForReload: () => { assert.equal(browser.workerController(), next); order.push('arm'); return () => { order.push('rollback'); }; },
        reload: () => { order.push('reload'); throw new Error('Reload could not begin'); } });
    try {
        await browser.runtime.start(); next = browser.waiting(); await browser.runtime.applyUpdate();
        assert.deepEqual(order, ['save', 'arm', 'reload', 'rollback']);
        assert.equal(browser.runtime.getSnapshot().updating, false);
        assert.match(browser.runtime.getSnapshot().error!, /Reload could not begin/u);
    } finally { browser.close(); }
});

test('a worker activation failure never activates reading tickets', async () => {
    let arms = 0;
    const browser = fixture({ prepareUpdate: async () => {}, armForReload: () => { arms++; return () => {}; } });
    try {
        await browser.runtime.start(); const waiting = browser.waiting();
        waiting.postMessage = () => { throw new Error('Worker activation failed'); };
        await browser.runtime.applyUpdate();
        assert.equal(arms, 0); assert.equal(browser.reloads(), 0);
        assert.match(browser.runtime.getSnapshot().error!, /Worker activation failed/u);
    } finally { browser.close(); }
});

test('a slow old notification lookup cannot replace a newer opened target', async () => {
    const old = Promise.withResolvers<AppServiceResponse<'appNotificationResolve'>>();
    let calls = 0;
    const newer: AppServiceResponse<'appNotificationResolve'> = { target: { kind: 'reading',
        source: { kind: 'local-dsh', hostId: 'local', sessionId: 'newer-task' }, position: { kind: 'dsh', seq: 9 } } };
    const browser = fixture({ resolve: () => ++calls === 1 ? old.promise : Promise.resolve(newer) });
    try {
        await browser.runtime.start();
        const reference = { type: 'app-notification' as const, scope: browser.settings.scope, deviceId: browser.runtime.deviceId, notificationId: 'old' };
        const first = browser.runtime.openNotification(reference), cancelled = assert.rejects(first, /newer notification/);
        await browser.runtime.openNotification({ ...reference, notificationId: 'new' });
        old.resolve({ target: { ...newer.target, source: { kind: 'local-dsh', hostId: 'local', sessionId: 'old-task' } } });
        await cancelled;
        assert.deepEqual(browser.opened, [{ target: newer.target, requestState: undefined }]);
        assert.equal(browser.runtime.getSnapshot().navigationFailure, null);
        assert.equal(browser.runtime.getSnapshot().openingId, null);
    } finally { browser.close(); }
});

test('failed notification navigation keeps its exact reference for an explicit retry', async () => {
    let fail = true;
    const browser = fixture({ resolve: async () => {
        if (fail) throw new Error('The original machine is offline.');
        return { target: { kind: 'reading', source: { kind: 'local-dsh', hostId: 'local', sessionId: 'original-task' }, position: { kind: 'dsh', seq: 2 } } };
    } });
    try {
        await browser.runtime.start();
        const reference = { type: 'app-notification' as const, scope: browser.settings.scope, deviceId: browser.runtime.deviceId, notificationId: 'retry-me' };
        await assert.rejects(browser.runtime.openNotification(reference), /offline/);
        assert.deepEqual(browser.runtime.getSnapshot().navigationFailure, { reference, message: 'The original machine is offline.' });
        assert.equal(browser.opened.length, 0);
        fail = false; await browser.runtime.retryNavigation();
        assert.deepEqual(browser.resolved, Array(2).fill({ deviceId: reference.deviceId, notificationId: 'retry-me' }));
        assert.equal(browser.opened.length, 1); assert.equal(browser.runtime.getSnapshot().navigationFailure, null);
    } finally { browser.close(); }
});

test('manual navigation during notification resolution keeps the newly selected conversation', async () => {
    let current = true;
    const delayed = Promise.withResolvers<AppServiceResponse<'appNotificationResolve'>>();
    const browser = fixture({ resolve: () => delayed.promise, captureNavigation: () => () => current });
    try {
        await browser.runtime.start();
        const opening = browser.runtime.openNotification({ type: 'app-notification', scope: browser.settings.scope,
            deviceId: browser.runtime.deviceId, notificationId: 'delayed' });
        const cancelled = assert.rejects(opening, /newer navigation/); current = false;
        delayed.resolve({ target: { kind: 'reading', source: { kind: 'local-dsh', hostId: 'local', sessionId: 'old-selection' }, position: { kind: 'dsh', seq: 8 } } });
        await cancelled; assert.deepEqual(browser.opened, []);
        assert.equal(browser.runtime.getSnapshot().navigationFailure, null);
    } finally { browser.close(); }
});

test('the explicit update waits for all editor preparation and its own worker activation before reloading once', async () => {
    let release!: () => void, preparations = 0;
    const browser = fixture({ prepareUpdate: () => { preparations++; return new Promise<void>(resolve => { release = resolve; }); } });
    try {
        await browser.runtime.start(); browser.waiting();
        const update = browser.runtime.applyUpdate(); await browser.runtime.applyUpdate();
        assert.equal(preparations, 1); assert.equal(browser.reloads(), 0); assert.deepEqual(browser.updates, []);
        release(); await update;
        assert.deepEqual(browser.updates, [{ type: 'SKIP_WAITING' }]); assert.equal(browser.reloads(), 1);
    } finally { browser.close(); }
});

test('a changed update is not activated using a checkpoint prepared for another worker', async () => {
    let release!: () => void;
    const browser = fixture({ prepareUpdate: () => new Promise<void>(resolve => { release = resolve; }) });
    try {
        await browser.runtime.start(); browser.waiting(); const update = browser.runtime.applyUpdate();
        browser.waiting(); release(); await update;
        assert.deepEqual(browser.updates, []); assert.equal(browser.reloads(), 0); assert.match(browser.runtime.getSnapshot().error!, /update changed/u);
    } finally { browser.close(); }
});

test('authenticated application identity becomes ready for reading sync without browser Push support', async () => {
    const ready: unknown[] = [], browser = fixture({ pushSupported: false, onReady: (scope, deviceId) => { ready.push({ scope, deviceId }) } })
    try {
        await browser.runtime.start()
        assert.equal(browser.runtime.getSnapshot().supported, false)
        assert.deepEqual(ready, [{ scope: browser.settings.scope, deviceId: 'fixture-device' }])
        assert.equal(browser.permissionRequests(), 0); assert.equal(browser.browserSubscriptions(), 0)
    } finally { browser.close() }
})

test('failed initial account settings recover once on online and visibility without Push or duplicate source activation', async () => {
    let calls = 0, release!: () => void;
    const ready: unknown[] = [];
    const browser = fixture({ pushSupported: false, onReady: scope => ready.push(scope), settings: async value => {
        calls++;
        if (calls === 1) throw new Error('Account transport is offline');
        await new Promise<void>(resolve => { release = resolve; }); return value;
    } });
    try {
        await browser.runtime.start(); assert.match(browser.runtime.getSnapshot().error!, /offline/u);
        assert.deepEqual(ready, []);
        browser.events.dispatchEvent(new Event('online'));
        browser.document.dispatchEvent(new Event('visibilitychange'));
        const retry = browser.runtime.refreshPush();
        assert.equal(calls, 2, 'all recovery entries share one initial account read');
        release(); await retry; await settle();
        assert.deepEqual(ready, [browser.settings.scope]);
        assert.equal(browser.runtime.getSnapshot().error, null);
        assert.equal(browser.runtime.getSnapshot().connected, true);
        assert.equal(browser.permissionRequests(), 0); assert.equal(browser.browserSubscriptions(), 0);
        await browser.runtime.start(); assert.equal(calls, 2);
    } finally { browser.close(); }
});

test('a late initial account reply after closing cannot start reading sync or connect a new notification stream', async () => {
    let release!: () => void;
    const ready: unknown[] = [];
    const browser = fixture({ onReady: scope => ready.push(scope), settings: async value => {
        await new Promise<void>(resolve => { release = resolve; }); return value;
    } });
    try {
        const pending = browser.runtime.start(); browser.runtime.close(); release(); await pending;
        browser.events.dispatchEvent(new Event('online')); await settle();
        assert.deepEqual(ready, []); assert.deepEqual(browser.socketFrames, []); assert.deepEqual(browser.registers, []);
    } finally { browser.close(); }
});
