import { shareWorkerSource } from './share-worker.ts';
import { HAPI_DSH_BUILD_ID } from '../build-info.ts';
/** Notification and share navigation remain inside the local application scope. */
export function normalizedAppPath(value: string): string {
    if (!value.startsWith('/') || value.startsWith('//') || !value.endsWith('/') || value.length > 2048 || /[\\\u0000-\u0020\u007f?#]/u.test(value)) throw new Error('Invalid application scope');
    const url = new URL(value, 'https://scope.invalid');
    if (url.origin !== 'https://scope.invalid' || url.pathname !== value) throw new Error('Invalid application scope');
    return value;
}

/** Application worker: opaque account/device references are resolved by the authenticated Host after navigation. */
export function buildAppNotificationWorker(appPath: string): string {
    const scope = normalizedAppPath(appPath);
    return `'use strict';\n// Workspace build: ${HAPI_DSH_BUILD_ID}\nconst HAPI_APP_PATH = ${JSON.stringify(scope)};\n` + String.raw`
const ownedWindow = value => {
    try { const url = new URL(value); return url.origin === self.location.origin && url.pathname.startsWith(HAPI_APP_PATH); } catch { return false; }
};
const opaqueId = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
const notificationReference = value => value && value.type === 'app-notification' && opaqueId(value.notificationId)
    && opaqueId(value.deviceId) && value.scope && opaqueId(value.scope.accountId) && value.scope.origin === self.location.origin
    ? { type: 'app-notification', notificationId: value.notificationId, deviceId: value.deviceId,
        scope: { accountId: value.scope.accountId, origin: value.scope.origin } } : null;
const notificationUrl = reference => {
    const url = new URL(HAPI_APP_PATH, self.location.origin);
    url.searchParams.set('hhpiNotification', reference.notificationId);
    url.searchParams.set('hhpiDevice', reference.deviceId);
    url.searchParams.set('hhpiAccount', reference.scope.accountId);
    url.searchParams.set('hhpiOrigin', reference.scope.origin);
    return url.href;
};
self.addEventListener('install', () => {});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
    if (!event.source || !ownedWindow(event.source.url)) return;
    if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
    if (event.data?.type === 'hhpi/app-notifications/info') event.ports[0]?.postMessage({ version: 1, appPath: HAPI_APP_PATH });
});
self.addEventListener('push', event => {
    let payload; try { payload = event.data?.json(); } catch { return; }
    const reference = notificationReference(payload?.data);
    if (!reference) return;
    const title = typeof payload.title === 'string' ? payload.title.slice(0, 256) : 'HHPI';
    event.waitUntil(self.registration.showNotification(title || 'HHPI', {
        body: typeof payload.body === 'string' ? payload.body.slice(0, 1024) : '',
        icon: new URL('favicon.svg', new URL(HAPI_APP_PATH, self.location.origin)).href,
        tag: reference.notificationId, data: reference,
    }));
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const reference = notificationReference(event.notification.data);
    if (!reference) return;
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windows.filter(value => ownedWindow(value.url))) {
            const acknowledged = await new Promise(resolve => {
                const channel = new MessageChannel();
                const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1000);
                channel.port1.onmessage = message => { clearTimeout(timer); channel.port1.close(); resolve(message.data?.opened === true); };
                client.postMessage(reference, [channel.port2]);
            });
            if (acknowledged) { await client.focus(); return; }
        }
        // A fresh window keeps an existing editor intact and retains this reference through login.
        await self.clients.openWindow(notificationUrl(reference));
    })());
});
` + shareWorkerSource;
}
