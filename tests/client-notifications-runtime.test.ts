/** Explicit browser API lifecycle fixtures; these do not claim OS Push delivery or installation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceNotificationsRuntime, vapidBytes } from '../src/client/source-notifications/runtime.ts';
import { NOTIFICATIONS_STREAM_PATH, NOTIFICATIONS_WORKER_PATH, type NotificationSettings, type SourceNotificationsApi } from '../src/notification-types.ts';

function replace(name: string, value: unknown): () => void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { configurable: true, value });
    return () => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const publicKey = Buffer.from([4, ...Array<number>(64).fill(7)]).toString('base64url');
function fixture(options: { installed?: boolean; pushConfigured?: boolean; prepareUpdate?: () => Promise<void> } = {}) {
    const memory = new Map<string, string>(), events = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: 'visible', baseURI: 'https://workspace.fixture/' });
    const requested: unknown[] = [], removed: string[] = [], socketFrames: unknown[] = [], registers: string[] = [], badges: number[] = [], opened: unknown[] = [];
    const updates: unknown[] = []; let reloads = 0;
    let failSubscribe = false, failDelete = false, permissionRequests = 0, browserSubscriptions = 0, browserUnsubscriptions = 0, workerHub = 'stable-fixture-hub';
    let current: PushSubscription | null = null, unread: number | null = 3, unreadChanged: (() => void) | undefined;
    const settings: NotificationSettings = { hubId: 'stable-fixture-hub', vapidPublicKey: options.pushConfigured === false ? null : publicKey,
        ...(options.pushConfigured === false ? { pushError: 'Original Push configuration is unavailable' } : {}), workerPath: NOTIFICATIONS_WORKER_PATH, streamPath: NOTIFICATIONS_STREAM_PATH };
    const api: SourceNotificationsApi = {
        sourceNotificationSettings: async () => ({ ok: true, value: { ...settings } }),
        sourcePushSubscribe: async value => { requested.push(structuredClone(value)); if (failSubscribe) throw { message: 'Original subscribe reply was lost' }; return { ok: true, value: { subscribed: true } }; },
        sourcePushUnsubscribe: async value => { removed.push(value.endpoint); if (failDelete) throw { message: 'Original delete reply was lost' }; return { ok: true, value: { unsubscribed: true } }; },
    };
    class Permission {
        static permission: NotificationPermission = 'default';
        static async requestPermission(): Promise<NotificationPermission> { permissionRequests++; this.permission = 'granted'; return 'granted'; }
    }
    class Socket {
        static OPEN = 1; static CLOSED = 3;
        readyState = 0; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
        constructor(readonly url: URL) { queueMicrotask(() => { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'status', connected: true, visibility: 'visible' }) }); }); }
        send(data: string) { socketFrames.push(JSON.parse(data)); }
        close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
    }
    const registration = Object.assign(new EventTarget(), {
        scope: 'https://workspace.fixture/', waiting: null as ServiceWorker | null, installing: null,
        active: { scriptURL: 'https://workspace.fixture' + NOTIFICATIONS_WORKER_PATH, state: 'activated',
            postMessage(_data: unknown, ports: MessagePort[]) { ports[0]!.postMessage({ hubId: workerHub, appPath: '/' }); ports[0]!.close(); } },
        update: async () => {},
        pushManager: {
            getSubscription: async () => current,
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
    const window = Object.assign(events, { PushManager: class {}, Notification: Permission });
    const restore = [replace('window', window), replace('document', document), replace('navigator', navigator), replace('Notification', Permission), replace('WebSocket', Socket),
        replace('location', { reload: () => { reloads++; } }),
        replace('isSecureContext', true), replace('matchMedia', () => ({ matches: false })),
        replace('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } })];
    const runtime = new SourceNotificationsRuntime(api, { getUnreadCount: () => unread, subscribeUnread: listener => { unreadChanged = listener; return () => { unreadChanged = undefined; }; },
        openSource: source => { opened.push(source); }, ...(options.prepareUpdate ? { prepareUpdate: options.prepareUpdate } : {}) });
    return { runtime, memory, requested, removed, socketFrames, registers, badges, opened, events, document, settings,
        permissionRequests: () => permissionRequests, browserSubscriptions: () => browserSubscriptions, browserUnsubscriptions: () => browserUnsubscriptions,
        failSubscribe(value: boolean) { failSubscribe = value; }, failDelete(value: boolean) { failDelete = value; }, workerHub(value: string) { workerHub = value; },
        unread(value: number | null) { unread = value; unreadChanged?.(); },
        reloads: () => reloads, updates,
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

test('unknown original Hub admission stays unknown after a browser refresh; only explicit retry writes and stored confirmation contains no Push capability', async () => {
    const browser = fixture();
    try {
        await browser.runtime.start(); browser.failSubscribe(true); await browser.runtime.enablePush();
        assert.equal(browser.permissionRequests(), 1); assert.equal(browser.requested.length, 1); assert.equal(browser.runtime.getSnapshot().push, 'unknown');
        assert.match(browser.runtime.getSnapshot().error!, /reply was lost/);
        await browser.runtime.refreshPush(); assert.equal(browser.requested.length, 1); assert.equal(browser.runtime.getSnapshot().push, 'unknown');
        browser.failSubscribe(false); await browser.runtime.enablePush(); assert.equal(browser.requested.length, 2); assert.equal(browser.runtime.getSnapshot().push, 'on');
        const stored = [...browser.memory.values()].join('\n'); assert.equal(stored.includes('capability-'), false); assert.equal(stored.includes('P'.repeat(32)), false); assert.equal(stored.includes('A'.repeat(24)), false);
        assert.equal(browser.memory.get('hapi.push.vapidKey'), publicKey);
        browser.failDelete(true); await browser.runtime.disablePush(); assert.equal(browser.runtime.getSnapshot().push, 'off'); assert.match(browser.runtime.getSnapshot().error!, /delete reply was lost/);
        assert.equal(browser.memory.has('hapi-dsh.push.confirmed'), false); assert.ok(browser.browserUnsubscriptions() >= 1);
    } finally { browser.close(); }
});

test('a new unknown registration cannot inherit the previous successful confirmation for the same browser endpoint', async () => {
    const browser = fixture();
    try {
        await browser.runtime.start(); await browser.runtime.enablePush(); assert.equal(browser.runtime.getSnapshot().push, 'on');
        const creations = browser.browserSubscriptions(); browser.failSubscribe(true); await browser.runtime.enablePush();
        assert.equal(browser.browserSubscriptions(), creations); assert.equal(browser.runtime.getSnapshot().push, 'unknown');
        await browser.runtime.refreshPush(); assert.equal(browser.runtime.getSnapshot().push, 'unknown'); assert.equal(browser.requested.length, 2);
        assert.equal(browser.memory.has('hapi-dsh.push.confirmed'), false);
    } finally { browser.close(); }
});

test('an active worker belonging to the old Hub cannot accept a new Push subscription', async () => {
    const browser = fixture();
    try {
        await browser.runtime.start(); browser.workerHub('previous-hub'); await browser.runtime.enablePush();
        assert.equal(browser.browserSubscriptions(), 0); assert.equal(browser.requested.length, 0); assert.match(browser.runtime.getSnapshot().error!, /previous Hub/);
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

test('App Badge follows the shared unread snapshot and retains the known value during reconnect; source navigation is Hub-bound', async () => {
    const browser = fixture({ installed: true });
    try {
        await browser.runtime.start(); await settle(); assert.deepEqual(browser.badges, [0]);
        browser.runtime.setBadgeEnabled(true); await settle(); assert.equal(browser.badges.at(-1), 3);
        const count = browser.badges.length; browser.unread(null); await settle(); assert.equal(browser.badges.length, count);
        browser.unread(7); await settle(); assert.equal(browser.badges.at(-1), 7);
        await assert.rejects(browser.runtime.open({ hubId: 'another-hub', sessionId: 'source-one' }), /different source Hub/);
        assert.deepEqual(browser.opened, []); await browser.runtime.open({ hubId: 'stable-fixture-hub', sessionId: 'source-one' });
        assert.deepEqual(browser.opened, [{ hubId: 'stable-fixture-hub', sessionId: 'source-one' }]);
        browser.runtime.setBadgeEnabled(false); await settle(); assert.equal(browser.badges.at(-1), 0);
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
    const browser = fixture({ prepareUpdate: async () => { throw new Error('The original file draft could not be saved'); } });
    try {
        await browser.runtime.start(); browser.waiting(); await browser.runtime.applyUpdate();
        assert.equal(browser.reloads(), 0); assert.deepEqual(browser.updates, []);
        assert.equal(browser.runtime.getSnapshot().updating, false); assert.match(browser.runtime.getSnapshot().error!, /file draft could not be saved/u);
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
