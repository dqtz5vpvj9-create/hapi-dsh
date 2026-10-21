import { shareWorkerSource } from './share-worker.ts';
import { HAPI_DSH_BUILD_ID } from '../build-info.ts';
/** Source notification navigation is local and carries stable Hub identity. */
export function normalizedAppPath(value: string): string {
    if (!value.startsWith('/') || value.startsWith('//') || !value.endsWith('/') || value.length > 2048 || /[\\\u0000-\u0020\u007f?#]/u.test(value)) throw new Error('Invalid application scope');
    const url = new URL(value, 'https://scope.invalid');
    if (url.origin !== 'https://scope.invalid' || url.pathname !== value) throw new Error('Invalid application scope');
    return value;
}

/** Plain service-worker source; it never contains a Hub token or caches API responses. */
export function buildNotificationWorker(hubId: string, appPath: string): string {
    if (!hubId || hubId.length > 256 || /[\u0000-\u001f\u007f]/u.test(hubId)) throw new Error('Invalid notification Hub identity');
    const scope = normalizedAppPath(appPath);
    return `'use strict';\n// Workspace build: ${HAPI_DSH_BUILD_ID}\nconst HAPI_HUB_ID = ${JSON.stringify(hubId)};\nconst HAPI_APP_PATH = ${JSON.stringify(scope)};\n` + String.raw`
const ownedWindow = value => {
    try { const url = new URL(value); return url.origin === self.location.origin && url.pathname.startsWith(HAPI_APP_PATH); } catch { return false; }
};
const sessionIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
const sourceTarget = sessionId => {
    const url = new URL(HAPI_APP_PATH, self.location.origin);
    if (sessionId) { url.searchParams.set('hapiSession', sessionId); url.searchParams.set('hapiHub', HAPI_HUB_ID); }
    return url.href;
};
self.addEventListener('install', () => { /* An update waits for explicit activation. */ });
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING' && event.source && ownedWindow(event.source.url)) event.waitUntil(self.skipWaiting());
    if (event.data?.type === 'hapi-dsh/notification-info' && event.source && ownedWindow(event.source.url)) event.ports[0]?.postMessage({ hubId: HAPI_HUB_ID, appPath: HAPI_APP_PATH });
});
self.addEventListener('push', event => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    const sessionId = sessionIdentity(payload.data?.sessionId);
    const title = typeof payload.title === 'string' ? payload.title.slice(0, 2048) : 'HAPI';
    const options = {
        body: typeof payload.body === 'string' ? payload.body.slice(0, 32768) : '',
        icon: new URL('favicon.svg', new URL(HAPI_APP_PATH, self.location.origin)).href,
        data: { hubId: HAPI_HUB_ID, sessionId },
    };
    if (typeof payload.tag === 'string') options.tag = payload.tag.slice(0, 256);
    event.waitUntil(self.registration.showNotification(title || 'HAPI', options));
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const data = event.notification.data;
    // Ignore arbitrary payload URLs and refuse another Hub's old notification.
    const sessionId = data?.hubId === HAPI_HUB_ID ? sessionIdentity(data.sessionId) : null;
    event.waitUntil((async () => {
        if (sessionId) {
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of windows.filter(value => ownedWindow(value.url))) {
                const acknowledged = await new Promise(resolve => {
                    const channel = new MessageChannel();
                    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1000);
                    channel.port1.onmessage = message => { clearTimeout(timer); channel.port1.close(); resolve(message.data?.opened === true); };
                    client.postMessage({ type: 'hapi-dsh/notification-open', hubId: HAPI_HUB_ID, sessionId }, [channel.port2]);
                });
                if (acknowledged) { await client.focus(); return; }
            }
        }
        // A new window preserves any existing unsaved editor if it cannot yet
        // acknowledge the public workspace navigation request.
        await self.clients.openWindow(sourceTarget(sessionId));
    })());
});
` + shareWorkerSource;
}
