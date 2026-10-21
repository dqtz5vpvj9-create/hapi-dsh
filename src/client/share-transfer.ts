/** HAPI's original browser-only Web Share Target transfer format (AGPL-3.0). */
import { randomId } from './random-id.ts';

export const SHARE_DATABASE = 'hapi-share-transfers';
export const SHARE_STORE = 'transfers';
export const SHARE_TTL = 60 * 60 * 1000;
export const SHARE_FILE_LIMIT = 50 * 1024 * 1024;
export const SHARE_TOTAL_LIMIT = 128 * 1024 * 1024;
export interface SharedFile { name: string; type: string; blob: Blob }
export interface SharePayload { title: string; text: string; url: string; files: SharedFile[]; createdAt: number }
export interface ShareFields { title?: string; text?: string; url?: string; fileUrl?: string; fileName?: string; fileType?: string }
export type ShareTarget = { kind: 'hapi'; hubId: string; sessionId: string } | { kind: 'dsh'; hostId: string; sessionId: string };
export interface ShareDelivery { target: ShareTarget; status: 'ready' | 'inserting' | 'inserted' | 'unknown'; owner: string; afterText?: string; error?: string }
export interface ShareRecord extends SharePayload { id: string; hapiDshDelivery?: ShareDelivery }
export const shareTargetKey = (target: ShareTarget) => JSON.stringify(target.kind === 'hapi' ? ['hapi', target.hubId, target.sessionId] : ['dsh', target.hostId, target.sessionId]);
export const shareSeedText = (value: SharePayload) => [value.title, value.text, value.url].filter(part => part.length > 0).join('\n').trim();

export function parseShareFields(hash: string): ShareFields {
    if (hash.length > 1024 * 1024) throw new Error('The shared text exceeds the 1 MiB limit.');
    const params = new URLSearchParams(hash.replace(/^#/u, '')), result: ShareFields = {};
    for (const key of ['title', 'text', 'url', 'fileUrl', 'fileName', 'fileType'] as const) {
        const value = params.get(key); if (value?.trim()) result[key] = value;
    }
    return result;
}
export function validateSharePayload(value: unknown, now = Date.now()): SharePayload {
    if (!value || typeof value !== 'object') throw new Error('The shared content is unavailable.');
    const row = value as Partial<SharePayload>;
    if (!['title', 'text', 'url'].every(key => typeof Reflect.get(row, key) === 'string') || !Array.isArray(row.files)
        || !Number.isFinite(row.createdAt) || row.createdAt! > now + 60_000 || now - row.createdAt! > SHARE_TTL) throw new Error('The shared content has expired or is incompatible.');
    if (row.title!.length + row.text!.length + row.url!.length > 1024 * 1024 || row.files.length > 32) throw new Error('The shared content is too large.');
    let size = 0;
    for (const file of row.files) {
        if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 4096 || typeof file.type !== 'string' || !(file.blob instanceof Blob)) throw new Error('A shared file could not be read.');
        size += file.blob.size;
        if (file.blob.size > SHARE_FILE_LIMIT || size > SHARE_TOTAL_LIMIT) throw new Error('Use at most 50 MiB per shared file and 128 MiB in total.');
    }
    if (!shareSeedText(row as SharePayload) && !row.files.length) throw new Error('The share contains no text or files.');
    return row as SharePayload;
}

/** Content is fragment-only; external companion files never receive app cookies. */
export async function shareFromFragment(fields: ShareFields, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<SharePayload> {
    const payload: SharePayload = { title: fields.title ?? '', text: fields.text ?? '', url: fields.url ?? '', files: [], createdAt: Date.now() };
    if (fields.fileUrl) {
        const url = new URL(fields.fileUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('A companion file must use an HTTP(S) URL without embedded credentials.');
        const response = await fetcher(url, { signal, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(`The companion file could not be read (HTTP ${response.status}).`);
        if (Number(response.headers.get('content-length')) > SHARE_FILE_LIMIT) { await response.body?.cancel(); throw new Error('The shared file exceeds 50 MiB.'); }
        const chunks: Uint8Array[] = []; let size = 0;
        if (response.body) {
            const reader = response.body.getReader();
            try { for (;;) {
                signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
                size += next.value.byteLength; if (size > SHARE_FILE_LIMIT) throw new Error('The shared file exceeds 50 MiB.');
                chunks.push(next.value);
            } } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
        }
        const type = fields.fileType?.trim() || response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
        const leaf = url.pathname.split('/').filter(Boolean).at(-1);
        const name = fields.fileName?.trim() || (leaf?.includes('.') ? leaf : `shared.${type.split('/')[1]?.replace(/[^a-z0-9]/giu, '') || 'bin'}`);
        payload.files.push({ name, type, blob: new Blob(chunks as BlobPart[], { type }) });
    }
    signal.throwIfAborted(); return validateSharePayload(payload);
}

/** Same database/version/store as HAPI; no destructive migration or content in storage strings. */
export class BrowserShareTransfers {
    private open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(SHARE_DATABASE, 1);
            request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(SHARE_STORE)) request.result.createObjectStore(SHARE_STORE, { keyPath: 'id' }); };
            request.onerror = () => reject(request.error ?? new Error('Share storage is unavailable.'));
            request.onsuccess = () => resolve(request.result);
        });
    }
    async read(id: string): Promise<ShareRecord | null> {
        return this.transaction('readonly', store => store.get(id));
    }
    async put(payload: SharePayload): Promise<string> {
        validateSharePayload(payload); const id = randomId();
        await this.transaction('readwrite', store => store.add({ ...payload, id })); return id;
    }
    async delete(id: string): Promise<void> { await this.transaction('readwrite', store => store.delete(id)); }
    async update(id: string, change: (record: ShareRecord) => ShareRecord): Promise<ShareRecord> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SHARE_STORE, 'readwrite'), store = tx.objectStore(SHARE_STORE), request = store.get(id); let result: ShareRecord; let failure: unknown;
            request.onsuccess = () => { try {
                if (!request.result) throw new Error('The shared content is no longer available.');
                result = change(request.result as ShareRecord); store.put(result);
            } catch (error) { failure = error; tx.abort(); } };
            tx.oncomplete = () => { db.close(); resolve(result); };
            tx.onerror = tx.onabort = () => { db.close(); reject(failure ?? tx.error ?? new Error('The share hand-off could not be saved.')); };
        });
    }
    private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SHARE_STORE, mode), request = action(tx.objectStore(SHARE_STORE));
            tx.oncomplete = () => { db.close(); resolve(request.result); };
            tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Share storage is unavailable.')); };
        });
    }
}

export interface ShareTransfers {
    read(id: string): Promise<ShareRecord | null>;
    put(payload: SharePayload): Promise<string>;
    delete(id: string): Promise<void>;
    update(id: string, change: (record: ShareRecord) => ShareRecord): Promise<ShareRecord>;
}
