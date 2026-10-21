import { randomId } from './random-id.ts'
/** Lossless import of HAPI v1 scratchlists and original HAPI session exports. */
import { z } from 'zod';
import { remoteValue, type SessionExtrasApi, type SourceNote, type WorkbenchSource } from '../client-api.ts';
import { sourceAttachmentSchema, sourceNoteSchema } from '../session-extras-types.ts';

const legacyNote = z.object({ id: z.string().min(1).max(128), text: z.string().max(10000),
    createdAt: z.number().int().nonnegative(), attachments: z.array(sourceAttachmentSchema).max(128).default([]) })
    .refine(row => row.text.trim().length > 0 || row.attachments.length > 0);
export type LegacyNote = z.infer<typeof legacyNote>;
const migrationRow = z.object({ original: legacyNote, targetId: z.string().min(1).max(128),
    state: z.enum(['pending', 'saved', 'conflict', 'error', 'kept']), error: z.string().optional(), sourceVersion: sourceNoteSchema.optional() });
const journalSchema = z.object({ version: z.literal(1), hubId: z.string(), sourceSessionId: z.string(), raw: z.string().max(5_000_000),
    issues: z.array(z.string()), rows: z.array(migrationRow).max(200), dismissed: z.boolean() });
export type NoteMigrationJournal = z.infer<typeof journalSchema>;
export type NoteMigrationSnapshot = { journal: NoteMigrationJournal | null; busy: boolean; error: string | null };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function parseLegacyNotes(raw: string, sourceSessionId: string): { rows: LegacyNote[]; issues: string[] } {
    if (raw.length > 5_000_000) throw new Error('The note import exceeds 5 MB. The original file is unchanged.');
    const value: unknown = JSON.parse(raw);
    let candidates: unknown = value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const exported = value as Record<string, unknown>;
        const session = exported.session as { id?: unknown } | undefined;
        if (!session || session.id !== sourceSessionId) throw new Error('This export belongs to a different original HAPI session.');
        candidates = exported.scratchlist;
    }
    if (!Array.isArray(candidates)) throw new Error('Choose a HAPI scratchlist array or an original session JSON export containing scratchlist.');
    if (candidates.length > 200) throw new Error('This import contains more than the original Hub’s 200-note limit. No notes were discarded.');
    const rows: LegacyNote[] = [], issues: string[] = [], ids = new Set<string>();
    for (let index = 0; index < candidates.length; index++) {
        const value = candidates[index];
        const object = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
        const candidate = object ? { ...object, id: object.id ?? object.entryId } : value;
        const result = legacyNote.safeParse(candidate);
        if (!result.success) { issues.push(`Entry ${index + 1}: invalid text, timestamp or attachment metadata. Its original bytes are retained in the import backup.`); continue; }
        if (ids.has(result.data.id)) { issues.push(`Entry ${index + 1}: duplicate note ID. The original import backup retains both entries.`); continue; }
        ids.add(result.data.id); rows.push(result.data);
    }
    return { rows, issues };
}
export function sameMigratedNote(original: LegacyNote, source: SourceNote): boolean {
    return original.text.trim() === source.text && original.createdAt === source.createdAt
        && JSON.stringify(original.attachments) === JSON.stringify(source.attachments);
}

/** Original IDs make retry safe even when HAPI returned no acknowledgement.
 * A source collision never authorizes an update or deletion. */
export class NoteMigrationController {
    private snapshot: NoteMigrationSnapshot;
    private readonly listeners = new Set<() => void>();
    private readonly key: string;
    constructor(private readonly api: Pick<SessionExtrasApi, 'sourceNotes' | 'sourceNoteWrite'>,
        private readonly source: WorkbenchSource, private readonly storage?: StorageLike) {
        this.key = `hapi-dsh:note-migration:${JSON.stringify([source.sourceHubId, source.sourceSessionId])}`;
        let journal: NoteMigrationJournal | null = null;
        try {
            const parsed = journalSchema.safeParse(JSON.parse(storage?.getItem(this.key) ?? 'null'));
            if (parsed.success && parsed.data.hubId === source.sourceHubId && parsed.data.sourceSessionId === source.sourceSessionId) journal = parsed.data;
        } catch { /* A damaged journal cannot authorize a write. The original local data remains untouched. */ }
        this.snapshot = { journal, busy: false, error: null };
    }
    getSnapshot = (): NoteMigrationSnapshot => this.snapshot;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(patch: Partial<NoteMigrationSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch }; for (const listener of [...this.listeners]) listener();
    }
    private save(journal: NoteMigrationJournal): void {
        const encoded = JSON.stringify(journal);
        if (!this.storage) throw new Error('Browser storage is unavailable. Export these notes before migrating; nothing was sent.');
        this.storage.setItem(this.key, encoded);
        if (this.storage.getItem(this.key) !== encoded) throw new Error('The migration journal could not be verified. Nothing new was sent.');
        this.publish({ journal: structuredClone(journal) });
    }
    prepare(raw: string): void {
        if (this.snapshot.busy) return;
        try {
            if (!this.source.sourceHubId) throw new Error('The original Hub identity must be known before importing notes.');
            const parsed = parseLegacyNotes(raw, this.source.sourceSessionId);
            this.save({ version: 1, hubId: this.source.sourceHubId, sourceSessionId: this.source.sourceSessionId, raw,
                issues: parsed.issues, rows: parsed.rows.map(original => ({ original, targetId: original.id, state: 'pending' })), dismissed: false });
            this.publish({ error: null });
        } catch (error) { this.publish({ error: error instanceof Error ? error.message : String(error) }); }
    }
    dismiss(): void {
        const journal = this.snapshot.journal;
        if (!journal || this.snapshot.busy || journal.rows.some(row => !['saved', 'kept'].includes(row.state))) return;
        try { this.save({ ...journal, dismissed: true }); }
        catch (error) { this.publish({ error: String(error) }); }
    }
    resolve(originalId: string, choice: 'keep-source' | 'separate'): void {
        const journal = this.snapshot.journal; if (!journal || this.snapshot.busy) return;
        try {
            this.save({ ...journal, rows: journal.rows.map(row => row.original.id !== originalId || row.state !== 'conflict' ? row
                : choice === 'keep-source' ? { ...row, state: 'kept', error: undefined }
                    : { ...row, targetId: randomId(), state: 'pending', error: undefined }) });
            this.publish({ error: null });
        } catch (error) { this.publish({ error: String(error) }); }
    }
    async inspect(): Promise<void> { await this.perform(false); }
    async import(): Promise<void> { await this.perform(true); }
    private async perform(write: boolean): Promise<void> {
        if (this.snapshot.busy || !this.snapshot.journal) return;
        this.publish({ busy: true, error: null });
        try {
            let journal = structuredClone(this.snapshot.journal);
            // Persist the complete immutable originals and any conflict-copy IDs
            // before the first POST. Never rely on a volatile React state.
            this.save(journal);
            const notes = remoteValue(await this.api.sourceNotes({ source: this.source }));
            const sourceRows = new Map(notes.entries.map(row => [row.entryId, row]));
            for (let index = 0; index < journal.rows.length; index++) {
                const row = journal.rows[index]!;
                if (row.state === 'saved' || row.state === 'kept') continue;
                const found = sourceRows.get(row.targetId);
                if (found) {
                    const same = sameMigratedNote(row.original, found);
                    journal.rows[index] = { ...row, state: same ? 'saved' : 'conflict',
                        ...(same ? {} : { sourceVersion: found, error: 'The Hub already has a different note with this ID. Choose which copies to keep.' }) };
                    this.save(journal); continue;
                }
                if (!write || row.state === 'conflict') continue;
                try {
                    const result = remoteValue(await this.api.sourceNoteWrite({ source: this.source, action: {
                        kind: 'create', entryId: row.targetId, text: row.original.text,
                        attachments: row.original.attachments, createdAt: row.original.createdAt,
                    } }));
                    if (!result.entry || result.entry.entryId !== row.targetId) throw new Error('The original Hub did not confirm this note identity.');
                    const same = sameMigratedNote(row.original, result.entry);
                    journal.rows[index] = { ...row, state: same ? 'saved' : 'conflict',
                        ...(same ? {} : { sourceVersion: result.entry, error: 'The returned note differs from the preserved original. No content was overwritten.' }) };
                } catch (error) {
                    journal.rows[index] = { ...row, state: 'error', error: error instanceof Error ? error.message : String(error) };
                    this.save(journal);
                    // A lost response is resolved by a read, never by another POST.
                    try {
                        const recovered = remoteValue(await this.api.sourceNotes({ source: this.source })).entries.find(entry => entry.entryId === row.targetId);
                        if (recovered) journal.rows[index] = { ...row, state: sameMigratedNote(row.original, recovered) ? 'saved' : 'conflict', sourceVersion: recovered };
                    } catch { /* Leave the durable uncertainty visible for explicit recovery. */ }
                    this.save(journal); break;
                }
                this.save(journal);
            }
        } catch (error) { this.publish({ error: error instanceof Error ? error.message : String(error) }); }
        finally { this.publish({ busy: false }); }
    }
}
