import { randomId } from './random-id.ts'
/** Browser-local source editor recovery; content never enters workspace geometry. */
import { z } from 'zod';
import { MAX_EDITABLE_BYTES } from '../workbench-types.ts';
import { workspaceDocumentSchema } from '../workspace/source-api.ts';
import type { SourceDocumentDraft } from './workbench-drafts.ts';

const recordSchema = z.object({ version: z.literal(2), revision: z.string().uuid(), updatedAt: z.number().finite(),
    draft: z.object({ base: workspaceDocumentSchema, text: z.string().max(MAX_EDITABLE_BYTES), uncertain: z.boolean(),
        selection: z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), direction: z.enum(['forward', 'backward', 'none']) }).optional(),
        pending: z.strictObject({ operationId: z.string().uuid(), text: z.string().max(MAX_EDITABLE_BYTES), baselineVersion: z.string().min(1).max(4096) }).nullable() }).nullable() });
export type NativeDocumentJournalEntry = z.infer<typeof recordSchema>;
export interface NativeDocumentJournal {
    read(key: string): Promise<NativeDocumentJournalEntry | null>;
    /** Compare-and-swap prevents another tab's unsaved editor from being overwritten. */
    write(key: string, expectedRevision: string | null, value: SourceDocumentDraft | null): Promise<NativeDocumentJournalEntry>;
}
export class BrowserNativeDocumentJournal implements NativeDocumentJournal {
    private opening: Promise<IDBDatabase> | undefined;
    private open(): Promise<IDBDatabase> {
        if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Durable browser storage is unavailable. The source draft has not been saved.'));
        return this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
            let settled = false;
            const fail = (reason: unknown) => { if (!settled) { settled = true; reject(reason); } };
            const request = indexedDB.open('hhpi-workspace-document-drafts', 1);
            request.onupgradeneeded = () => { if (settled) request.transaction?.abort(); else request.result.createObjectStore('drafts'); };
            request.onsuccess = () => {
                if (settled) { request.result.close(); return; }
                settled = true;
                request.result.onversionchange = () => { request.result.close(); this.opening = undefined; };
                resolve(request.result);
            };
            request.onerror = () => fail(request.error ?? new Error('The browser could not open source file drafts.'));
            request.onblocked = () => fail(new Error('A source file draft upgrade is waiting for another browser window.'));
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
    async write(key: string, expectedRevision: string | null, draft: SourceDocumentDraft | null): Promise<NativeDocumentJournalEntry> {
        const database = await this.open();
        const value = recordSchema.parse({ version: 2, revision: randomId(), updatedAt: Date.now(), draft });
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
    async write(key: string, expectedRevision: string | null, draft: SourceDocumentDraft | null) {
        if ((this.rows.get(key)?.revision ?? null) !== expectedRevision) throw new Error('Another editor saved a newer draft for this source file.');
        const value: NativeDocumentJournalEntry = { version: 2, revision: randomId(), updatedAt: Date.now(), draft: structuredClone(draft) };
        this.rows.set(key, value); return value;
    }
}
export const nativeDocumentJournal: NativeDocumentJournal = typeof window === 'undefined' ? new ProcessDocumentJournal() : new BrowserNativeDocumentJournal();
