/** Browser-local source editor recovery; content never enters workspace geometry. */
import { randomId } from './random-id.ts';
import { z } from 'zod';
import { MAX_EDITABLE_BYTES, nativeDocumentSchema } from '../workbench-types.ts';
import type { NativeDocumentDraft } from './workbench-drafts.ts';

const recordSchema = z.object({ version: z.literal(1), revision: z.string().uuid(), updatedAt: z.number().finite(),
    draft: z.object({ base: nativeDocumentSchema, text: z.string().max(MAX_EDITABLE_BYTES), uncertain: z.boolean() }).nullable() });
export type NativeDocumentJournalEntry = z.infer<typeof recordSchema>;
export interface NativeDocumentJournal {
    read(key: string): Promise<NativeDocumentJournalEntry | null>;
    /** Compare-and-swap prevents another tab's unsaved editor from being overwritten. */
    write(key: string, expectedRevision: string | null, value: NativeDocumentDraft | null): Promise<NativeDocumentJournalEntry>;
}
export class BrowserNativeDocumentJournal implements NativeDocumentJournal {
    private opening: Promise<IDBDatabase> | undefined;
    private open(): Promise<IDBDatabase> {
        return this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('hapi-dsh-source-document-drafts', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('drafts');
            request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.opening = undefined; }; resolve(request.result); };
            request.onerror = () => reject(request.error ?? new Error('The browser could not open source file drafts.'));
            request.onblocked = () => reject(new Error('A source file draft upgrade is waiting for another browser window.'));
        }).catch(error => { this.opening = undefined; throw error; });
    }
    async read(key: string): Promise<NativeDocumentJournalEntry | null> {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const request = database.transaction('drafts', 'readonly').objectStore('drafts').get(key);
            request.onsuccess = () => {
                if (request.result == null) { resolve(null); return; }
                const decoded = recordSchema.safeParse(request.result);
                if (decoded.success) resolve(decoded.data); else reject(new Error('The saved source file draft is incompatible. Its original bytes have been retained.'));
            };
            request.onerror = () => reject(request.error ?? new Error('The source file draft could not be read.'));
        });
    }
    async write(key: string, expectedRevision: string | null, draft: NativeDocumentDraft | null): Promise<NativeDocumentJournalEntry> {
        const database = await this.open();
        const value = recordSchema.parse({ version: 1, revision: randomId(), updatedAt: Date.now(), draft });
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('drafts', 'readwrite', { durability: 'strict' }), store = transaction.objectStore('drafts');
            let reason: Error | undefined;
            const current = store.get(key);
            current.onsuccess = () => {
                const prior = current.result === undefined ? null : recordSchema.safeParse(current.result);
                if (prior && !prior.success) reason = new Error('The saved file draft is incompatible; it was not overwritten.');
                else if ((prior?.data?.revision ?? null) !== expectedRevision) reason = new Error('Another editor saved a newer draft for this source file. This editor and the saved copy are both retained.');
                if (reason) transaction.abort(); else store.put(value, key);
            };
            transaction.oncomplete = () => resolve(value);
            transaction.onerror = transaction.onabort = () => reject(reason ?? transaction.error ?? new Error('The source file draft could not be saved.'));
        });
    }
}

/** Used only outside a browser; browser storage denial never silently falls back. */
class ProcessDocumentJournal implements NativeDocumentJournal {
    private rows = new Map<string, NativeDocumentJournalEntry>();
    async read(key: string) { return structuredClone(this.rows.get(key) ?? null); }
    async write(key: string, expectedRevision: string | null, draft: NativeDocumentDraft | null) {
        if ((this.rows.get(key)?.revision ?? null) !== expectedRevision) throw new Error('Another editor saved a newer draft for this source file.');
        const value: NativeDocumentJournalEntry = { version: 1, revision: randomId(), updatedAt: Date.now(), draft: structuredClone(draft) };
        this.rows.set(key, value); return value;
    }
}
export const nativeDocumentJournal: NativeDocumentJournal = typeof indexedDB === 'undefined' ? new ProcessDocumentJournal() : new BrowserNativeDocumentJournal();
