/** Explicit source wire fixture for notes and original transcript exports. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { NativeFixture } from './hapi-fixture.ts';
import type { SourceNote, SourceAttachment } from '../src/session-extras-types.ts';

const limits = { maxBytesPerFile: 1024 * 1024, maxAttachmentsPerEntry: 10, maxBytesPerEntry: 10 * 1024 * 1024,
    maxBytesPerSession: 32 * 1024 * 1024, allowedMimeTypes: ['image/png', 'text/plain'] };
export class SessionExtrasWireFixture {
    readonly notes = new Map<string, Map<string, SourceNote>>();
    readonly mutations: Array<{ sessionId: string; method: string; tail: string }> = [];
    dropNextNoteReply = false;
    titleSuggestionAvailable = true;
    suggestedTitle = 'A suggested source title';
    dropNextTitleSuggestionReply = false;
    nextNoteReply: Promise<void> | null = null;
    noteReadsOffline = false;
    failReadsAfterNextNoteWrite = false;
    private readonly attachments = new Map<string, { sourceId: string; bytes: Buffer; metadata: SourceAttachment }>();
    seedAttachment(sourceId: string, filename: string, bytes: Buffer, mimeType = 'text/plain'): SourceAttachment {
        const id = randomUUID(), metadata = { id, filename, mimeType, size: bytes.length, path: `/fixture-notes/${id}` };
        this.attachments.set(id, { sourceId, bytes, metadata }); return metadata;
    }
    handle(fixture: NativeFixture, tail: string, url: URL, request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>): boolean {
        if (!tail.startsWith('scratchlist') && !['messages/outline', 'export', 'slash-commands', 'skills', 'title-suggestion'].includes(tail)) return false;
        const send = (value: unknown, status = 200): void => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        const id = fixture.session.id;
        const notes = this.notes.get(id) ?? new Map<string, SourceNote>(); this.notes.set(id, notes);
        if (request.method !== 'GET') this.mutations.push({ sessionId: id, method: request.method ?? 'GET', tail });
        if (tail === 'title-suggestion') {
            if (!this.titleSuggestionAvailable) { send({ error: 'No fixture title provider' }, 503); return true; }
            if (this.dropNextTitleSuggestionReply) { this.dropNextTitleSuggestionReply = false; response.destroy(); return true; }
            send({ title: this.suggestedTitle }); return true;
        }
        if (tail === 'scratchlist/limits') { send({ limits }); return true; }
        if (tail === 'scratchlist' && request.method === 'GET') { send(this.noteReadsOffline ? { error: 'Fixture note reads offline' } : { entries: [...notes.values()] }, this.noteReadsOffline ? 503 : 200); return true; }
        if (tail === 'scratchlist/upload') {
            const attachmentId = randomUUID(), bytes = Buffer.from(String(body.content), 'base64');
            const metadata: SourceAttachment = { id: attachmentId, filename: String(body.filename), mimeType: String(body.mimeType), size: bytes.length, path: `/fixture-notes/${attachmentId}` };
            this.attachments.set(attachmentId, { sourceId: id, bytes, metadata }); send({ success: true, attachment: metadata }); return true;
        }
        if (tail.startsWith('scratchlist/attachments/')) {
            const attachmentId = decodeURIComponent(tail.slice('scratchlist/attachments/'.length)), attachment = this.attachments.get(attachmentId);
            if (!attachment || attachment.sourceId !== id) { send({ error: 'Unknown fixture attachment' }, 404); return true; }
            if (request.method === 'DELETE') { this.attachments.delete(attachmentId); send({ ok: true }); return true; }
            response.writeHead(200, { 'content-type': attachment.metadata.mimeType, 'content-length': attachment.bytes.length,
                'content-disposition': `attachment; filename="${attachment.metadata.filename}"` }); response.end(attachment.bytes); return true;
        }
        if (tail.startsWith('scratchlist')) {
            const entryId = tail === 'scratchlist' ? String(body.entryId) : decodeURIComponent(tail.slice('scratchlist/'.length));
            if (request.method === 'DELETE') { notes.delete(entryId); send({ ok: true }); return true; }
            if (request.method === 'POST' && notes.has(entryId)) { send({ entry: notes.get(entryId) }); return true; }
            const previous = notes.get(entryId), at = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1);
            const entry: SourceNote = { entryId, text: String(body.text ?? '').trim(), attachments: body.attachments as SourceAttachment[] ?? [], createdAt: previous?.createdAt ?? (typeof body.createdAt === 'number' ? body.createdAt : at), updatedAt: at };
            notes.set(entryId, entry);
            if (this.failReadsAfterNextNoteWrite) { this.failReadsAfterNextNoteWrite = false; this.noteReadsOffline = true; response.destroy(); return true; }
            if (this.dropNextNoteReply) { this.dropNextNoteReply = false; response.destroy(); return true; }
            if (this.nextNoteReply) { const wait = this.nextNoteReply; this.nextNoteReply = null; void wait.then(() => send({ entry })); return true; }
            send({ entry }); return true;
        }
        if (tail === 'messages/outline') {
            const entries = fixture.rows.flatMap(row => {
                const content = row.content as { role: string; content: { text?: string } };
                return content.role === 'user' && row.invokedAt != null
                    ? [{ messageId: row.id, label: content.content.text ?? 'Input', at: row.createdAt, seq: row.seq ?? 0, createdAt: row.createdAt }] : [];
            }).reverse();
            send({ entries, page: { epoch: 1, reset: false, hasMore: false, beforeCursor: null, scannedThrough: fixture.rows.length,
                headSeq: fixture.rows.length, complete: true, unreadable: false, indexing: false } }); return true;
        }
        if (tail === 'export') {
            if (fixture.rows.length > 20_000 && url.searchParams.get('force') !== 'true') { send({ type: 'warning', count: fixture.rows.length, limit: 20_000, estimatedBytes: 100000 }); return true; }
            send({ schemaVersion: 1, exportedAt: Date.now(), session: fixture.session, messages: fixture.rows, scratchlist: [...notes.values()] }); return true;
        }
        if (tail === 'slash-commands') { send({ success: true, commands: [{ name: 'compact', description: 'Fixture original source command' }] }); return true; }
        send({ success: true, skills: [] }); return true;
    }
}
