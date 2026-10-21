/** POST-only Web Share Target. Ordinary documents and authenticated APIs are never intercepted. */
export const shareWorkerSource = String.raw`
const HAPI_SHARE_DB = 'hapi-share-transfers';
const HAPI_SHARE_STORE = 'transfers';
const HAPI_SHARE_MAX_FILE = 50 * 1024 * 1024;
const HAPI_SHARE_MAX_TOTAL = 128 * 1024 * 1024;
const putIncomingShare = payload => new Promise((resolve, reject) => {
    const opening = indexedDB.open(HAPI_SHARE_DB, 1);
    opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(HAPI_SHARE_STORE)) opening.result.createObjectStore(HAPI_SHARE_STORE, { keyPath: 'id' });
    };
    opening.onerror = () => reject(new Error('Share storage is unavailable'));
    opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction(HAPI_SHARE_STORE, 'readwrite'), id = crypto.randomUUID();
        tx.objectStore(HAPI_SHARE_STORE).add({ ...payload, id });
        tx.oncomplete = () => { db.close(); resolve(id); };
        tx.onerror = tx.onabort = () => { db.close(); reject(new Error('The shared content could not be saved')); };
    };
});
const incomingShare = async request => {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new Error('Multipart share required');
    const maximum = HAPI_SHARE_MAX_TOTAL + 2 * 1024 * 1024;
    if (Number(request.headers.get('content-length')) > maximum || !request.body) throw new Error('Share too large');
    const reader = request.body.getReader(), chunks = []; let size = 0;
    try {
        for (;;) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength; if (size > maximum) throw new Error('Share too large');
            chunks.push(next.value);
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    const form = await new Response(new Blob(chunks), { headers: { 'content-type': contentType } }).formData();
    const field = name => typeof form.get(name) === 'string' ? form.get(name) : '';
    const title = field('title'), text = field('text'), url = field('url');
    const files = form.getAll('files').filter(value => typeof value !== 'string').map(file => ({ name: file.name, type: file.type || 'application/octet-stream', blob: file }));
    if (title.length + text.length + url.length > 1024 * 1024 || files.length > 32 || files.some(file => file.blob.size > HAPI_SHARE_MAX_FILE)
        || files.reduce((sum, file) => sum + file.blob.size, 0) > HAPI_SHARE_MAX_TOTAL) throw new Error('Share too large');
    if (![title, text, url].some(value => value.trim()) && !files.length) throw new Error('Empty share');
    return putIncomingShare({ title, text, url, files, createdAt: Date.now() });
};
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url), target = new URL('hapi-dsh/share', new URL(HAPI_APP_PATH, self.location.origin));
    if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== target.pathname) return;
    event.respondWith((async () => {
        const destination = new URL(HAPI_APP_PATH, self.location.origin);
        try { destination.searchParams.set('hapiShare', await incomingShare(event.request)); }
        catch { destination.searchParams.set('hapiShareError', 'ingest'); }
        return Response.redirect(destination.href, 303);
    })());
});
`;
