import { z } from 'zod';
import { remoteValue, type SessionExtrasApi, type SourceAttachment, type SourceNote, type WorkbenchSource } from '../client-api.ts';
import { sourceAttachmentSchema, sourceNoteSchema } from '../session-extras-types.ts';
import { workbenchSourceSchema } from '../workbench-types.ts';

const snapshotSchema = z.object({ viewId: z.string(), text: z.string().max(10000), revision: z.number().int().nonnegative(), attachmentIds: z.array(z.string()).max(128) });
export type ParkedComposerSnapshot = z.infer<typeof snapshotSchema>;
const fileSchema = z.object({ draftId: z.string(), name: z.string(), mediaType: z.string(), lastModified: z.number(),
    blob: z.custom<Blob>(value => value instanceof Blob), upload: z.enum(['pending', 'sending', 'unknown', 'saved']), attachment: sourceAttachmentSchema.optional() });
export type ParkedComposerFile = z.infer<typeof fileSchema>;
const journalSchema = z.object({ version: z.literal(1), entryId: z.string().uuid(), createdAt: z.number().int().nonnegative(), source: workbenchSourceSchema,
    snapshot: snapshotSchema, files: z.array(fileSchema).max(128), state: z.enum(['preparing', 'submitting', 'saved', 'discarding']), note: sourceNoteSchema.optional() });
export type ComposerParkingJournal = z.infer<typeof journalSchema>;
export interface ComposerParkingStore { read(key: string): Promise<ComposerParkingJournal | null>; write(key: string, value: ComposerParkingJournal | null): Promise<void> }
type Api = Pick<SessionExtrasApi, 'sourceNotes' | 'sourceNoteUpload' | 'sourceNoteWrite'>;
type State = { loaded: boolean; busy: boolean; journal: ComposerParkingJournal | null; cleared: boolean; error: string | null };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
function sameSource(a: WorkbenchSource, b: WorkbenchSource): boolean { return a.sourceHubId === b.sourceHubId && a.sourceSessionId === b.sourceSessionId && a.machineId === b.machineId; }
export function parkingSnapshotMatches(snapshot: ParkedComposerSnapshot, input: { draft: string; draftRev: number; attachmentIds: readonly string[]; phase: string }, viewId: string): boolean {
    return snapshot.viewId === viewId && !['submitting', 'adjudicating'].includes(input.phase) && input.draftRev === snapshot.revision
        && input.draft === snapshot.text && JSON.stringify(input.attachmentIds) === JSON.stringify(snapshot.attachmentIds);
}

/** Attachment Blobs and every known source receipt survive closing a pane or reloading. */
export class BrowserComposerParkingStore implements ComposerParkingStore {
    private opening: Promise<IDBDatabase> | undefined;
    private open(): Promise<IDBDatabase> {
        return this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('hapi-dsh-composer-parking', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('drafts');
            request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
            request.onerror = () => reject(request.error ?? new Error('The browser could not open saved composer drafts.'));
            request.onblocked = () => reject(new Error('Close the other pending draft upgrade before continuing.'));
        }).catch(error => { this.opening = undefined; throw error; });
    }
    async read(key: string): Promise<ComposerParkingJournal | null> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const request = db.transaction('drafts', 'readonly').objectStore('drafts').get(key);
            request.onsuccess = () => {
                if (request.result === undefined || request.result === null) { resolve(null); return; }
                const value = journalSchema.safeParse(request.result);
                if (value.success) resolve(value.data); else reject(new Error('The saved composer draft cannot be decoded. It has been retained.'));
            };
            request.onerror = () => reject(request.error ?? new Error('The saved composer draft could not be read.'));
        });
    }
    async write(key: string, value: ComposerParkingJournal | null): Promise<void> {
        const db = await this.open();
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction('drafts', 'readwrite', { durability: 'strict' });
            if (value) transaction.objectStore('drafts').put(value, key); else transaction.objectStore('drafts').delete(key);
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('The original composer draft could not be saved.'));
        });
    }
}
const browserStore = new BrowserComposerParkingStore();
async function base64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
}
function matches(note: SourceNote, journal: ComposerParkingJournal): boolean {
    return note.entryId === journal.entryId && note.text === journal.snapshot.text.trim() && note.createdAt === journal.createdAt
        && JSON.stringify(note.attachments) === JSON.stringify(journal.files.map(file => file.attachment));
}

/** One source note identity; refresh only observes and never replays a note or upload. */
export class ComposerParkingController {
    private state: State = { loaded: false, busy: false, journal: null, cleared: false, error: null };
    private listeners = new Set<() => void>();
    private loading: Promise<void> | undefined;
    private reading: Promise<void> | undefined;
    constructor(private readonly api: Api, private readonly source: WorkbenchSource, private readonly key: string,
        private readonly clear: (snapshot: ParkedComposerSnapshot) => boolean, private readonly store: ComposerParkingStore = browserStore) {}
    getSnapshot = (): State => this.state;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(value: Partial<State>): void { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
    private async save(journal: ComposerParkingJournal): Promise<void> {
        await this.store.write(this.key, journal);
        const verified = await this.store.read(this.key);
        if (!verified || verified.entryId !== journal.entryId || verified.state !== journal.state
            || verified.files.length !== journal.files.length || verified.files.some((file, i) => file.blob.size !== journal.files[i]!.blob.size || file.attachment?.id !== journal.files[i]!.attachment?.id)) {
            throw new Error('The original composer draft could not be verified in browser storage. No further write was sent.');
        }
        this.publish({ journal: verified });
    }
    load(): Promise<void> {
        return this.loading ??= (async () => {
            try {
                const journal = await this.store.read(this.key);
                if (journal && !sameSource(journal.source, this.source)) throw new Error('This saved draft belongs to a different source conversation.');
                this.publish({ loaded: true, journal });
                if (journal?.state === 'submitting') await this.inspect();
            } catch (error) { this.publish({ error: errorText(error) }); }
        })();
    }
    async start(snapshot: ParkedComposerSnapshot, files: readonly { id: string; file: File }[]): Promise<void> {
        if (this.state.busy || !this.state.loaded || this.state.journal && this.state.journal.state !== 'saved') return;
        if (!snapshot.text.trim() && !files.length) return;
        this.publish({ busy: true, error: null, cleared: false });
        try {
            if (!this.source.sourceHubId) throw new Error('The original Hub identity is unavailable.');
            snapshotSchema.parse(snapshot);
            if (JSON.stringify(snapshot.attachmentIds) !== JSON.stringify(files.map(file => file.id))) throw new Error('The composer attachments changed before parking. The draft is retained.');
            const journal: ComposerParkingJournal = { version: 1, source: this.source, entryId: crypto.randomUUID(), createdAt: Date.now(), snapshot,
                state: 'preparing', files: files.map(({ id, file }) => ({ draftId: id, name: file.name, mediaType: file.type || 'application/octet-stream', lastModified: file.lastModified, blob: file, upload: 'pending' })) };
            await this.save(journal); await this.commit(false);
        } catch (error) { this.publish({ error: errorText(error) }); }
        finally { this.publish({ busy: false }); }
    }
    private async confirmed(note: SourceNote): Promise<void> {
        const journal = this.state.journal!;
        if (!matches(note, journal)) throw new Error('The Hub contains a different note under this identity. The original composer and saved bytes are retained.');
        await this.save({ ...journal, state: 'saved', note });
        this.publish({ cleared: this.clear(journal.snapshot), error: null });
    }
    inspect(): Promise<void> {
        if (this.reading || !this.state.journal || this.state.journal.state === 'saved') return this.reading ?? Promise.resolve();
        this.reading = (async () => {
            try {
                const data = remoteValue(await this.api.sourceNotes({ source: this.source }));
                const note = data.entries.find(row => row.entryId === this.state.journal?.entryId);
                if (note) await this.confirmed(note);
            } catch (error) { this.publish({ error: errorText(error) }); }
            finally { this.reading = undefined; }
        })();
        return this.reading;
    }
    async retry(): Promise<void> {
        if (this.state.busy || !this.state.journal || this.state.journal.state === 'saved' || this.state.journal.state === 'discarding') return;
        this.publish({ busy: true, error: null });
        try { await this.commit(true); } catch (error) { this.publish({ error: errorText(error) }); }
        finally { this.publish({ busy: false }); }
    }
    /** Only an unsubmitted note may be discarded; source note contents are never deleted. */
    async discard(): Promise<void> {
        if (this.state.busy || !this.state.journal || !['preparing', 'discarding'].includes(this.state.journal.state)) return;
        this.publish({ busy: true, error: null });
        try {
            await this.inspect(); if (this.state.journal?.state === 'saved') return;
            await this.save({ ...this.state.journal!, state: 'discarding' });
            for (let index = 0; index < this.state.journal!.files.length; index++) {
                const attachment = this.state.journal!.files[index]!.attachment; if (!attachment) continue;
                try { remoteValue(await this.api.sourceNoteWrite({ source: this.source, action: { kind: 'delete-attachment', attachmentId: attachment.id } })); }
                catch (error) {
                    const details = error && typeof error === 'object' && 'details' in error ? error.details : null;
                    if (!details || typeof details !== 'object' || !('status' in details) || details.status !== 404) throw error;
                }
                await this.save({ ...this.state.journal!, files: this.state.journal!.files.map((file, i) => {
                    if (i !== index) return file; const { attachment: _released, ...retained } = file; return { ...retained, upload: 'pending' };
                }) });
            }
            await this.store.write(this.key, null); this.publish({ journal: null, cleared: false });
        } catch (error) { this.publish({ error: errorText(error) }); }
        finally { this.publish({ busy: false }); }
    }
    private async commit(explicit: boolean): Promise<void> {
        let journal = this.state.journal!;
        const data = remoteValue(await this.api.sourceNotes({ source: this.source }));
        const existing = data.entries.find(note => note.entryId === journal.entryId);
        if (existing) { await this.confirmed(existing); return; }
        const total = journal.files.reduce((sum, file) => sum + file.blob.size, 0), limits = data.limits;
        if (journal.files.length > limits.maxAttachmentsPerEntry || total > limits.maxBytesPerEntry || total > limits.maxBytesPerSession
            || journal.files.some(file => file.blob.size > limits.maxBytesPerFile || !limits.allowedMimeTypes.includes(file.mediaType))) {
            throw new Error('The selected attachments exceed the original Hub note limits or use an unsupported format. The composer is retained.');
        }
        for (let index = 0; index < journal.files.length; index++) {
            const file = journal.files[index]!; if (file.attachment) continue;
            if (file.upload !== 'pending' && !explicit) throw new Error('An earlier upload has no source receipt. Check the saved note or explicitly retry; the original file bytes remain saved.');
            await this.save({ ...journal, files: journal.files.map((value, i) => i === index ? { ...value, upload: 'sending' } : value) });
            try {
                const result = remoteValue(await this.api.sourceNoteUpload({ source: this.source, filename: file.name, mimeType: file.mediaType, content: await base64(file.blob) }));
                if (result.attachment.filename !== file.name || result.attachment.size !== file.blob.size || result.attachment.mimeType !== file.mediaType) throw new Error('The source attachment receipt differs from the original file.');
                journal = { ...this.state.journal!, files: this.state.journal!.files.map((value, i) => i === index ? { ...value, upload: 'saved', attachment: result.attachment } : value) };
                await this.save(journal);
            } catch (error) {
                await this.save({ ...this.state.journal!, files: this.state.journal!.files.map((value, i) => i === index ? { ...value, upload: 'unknown' } : value) }).catch(() => {});
                throw error;
            }
        }
        journal = this.state.journal!;
        const attachments = journal.files.map(file => file.attachment!);
        await this.save({ ...journal, state: 'submitting' });
        try {
            const result = remoteValue(await this.api.sourceNoteWrite({ source: this.source, action: { kind: 'create', entryId: journal.entryId, createdAt: journal.createdAt,
                text: journal.snapshot.text, attachments } }));
            if (!result.entry) throw new Error('The source did not return the original note.');
            await this.confirmed(result.entry);
        } catch (error) {
            await this.inspect(); if (this.state.journal?.state !== 'saved') throw error;
        }
    }
}
