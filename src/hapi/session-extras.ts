import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HapiRequestError } from '../codex/contracts.ts';
import { record } from '../codex/native.ts';
import type { HapiClient } from './client.ts';
import type { FederationMount } from '../hub/federation.ts';
import { workbenchSourceSchema, type WorkbenchSource } from '../workbench-types.ts';
import { sessionExtrasInputs, sessionExtrasOutputs, sourceNoteLimitsSchema, SOURCE_RESOURCE_PATH,
    type SessionExtrasRequest, type SessionExtrasResponse, type SourceExport } from '../session-extras-types.ts';

const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const exportWarning = z.object({ type: z.literal('warning'), count: z.number(), limit: z.number(), estimatedBytes: z.number() });
const exportPayload = z.object({ schemaVersion: z.number().int().positive(), exportedAt: z.number(), session: z.object({ id: z.string(), metadata: z.record(z.string(), z.unknown()).nullable() }).passthrough(),
    messages: z.array(z.object({ id: z.string(), content: z.unknown(), createdAt: z.number() }).passthrough()), scratchlist: z.array(z.unknown()).optional() }).passthrough();
const resourceQuery = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('export'), id: z.string().uuid(), source: workbenchSourceSchema }),
    z.strictObject({ kind: z.literal('attachment'), id: z.string().min(1).max(512), source: workbenchSourceSchema }),
]);
const sourcePath = (sourceId: string, suffix: string): string => `/api/sessions/${encodeURIComponent(sourceId)}${suffix}`;
const resourceUrl = (input: z.infer<typeof resourceQuery>): string => `${SOURCE_RESOURCE_PATH}?${new URLSearchParams({ request: JSON.stringify(input) })}`;
const success = z.object({ success: z.boolean(), error: z.string().optional() });
function assertSuccess(value: { success: boolean; error?: string | undefined }): void {
    if (!value.success) throw new HapiRequestError(value.error ?? 'The source rejected the request', 'rejected', 400);
}
function safeFileName(value: string): string { return value.replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, '_').slice(0, 120) || 'conversation'; }
function fenced(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const length = Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1));
    const fence = '`'.repeat(length); return `${fence}${typeof value === 'string' ? '' : 'json'}\n${text}\n${fence}`;
}
function readableContent(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(readableContent).filter(Boolean).join('\n\n');
    const item = record(value); if (!item) return value == null ? '' : fenced(value);
    if (typeof item.role === 'string' && item.content !== undefined) return readableContent(item.content);
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
    if (item.type === 'thinking' && typeof item.thinking === 'string') return `### Reasoning\n\n${item.thinking}`;
    if (item.type === 'output' || item.type === 'codex' || item.type === 'event') return readableContent(item.data);
    if ((item.type === 'message' || item.type === 'reasoning') && typeof item.message === 'string') return `${item.type === 'reasoning' ? '### Reasoning\n\n' : ''}${item.message}`;
    if ((item.type === 'assistant' || item.type === 'user') && record(item.message)?.content !== undefined) return readableContent(record(item.message)!.content);
    if (item.type === 'tool_use' || item.type === 'tool-call') return `### Tool: ${typeof item.name === 'string' ? item.name : 'Tool'}\n\n${fenced(item.input ?? {})}`;
    if (item.type === 'tool_result' || item.type === 'tool-call-result') return `### Tool result\n\n${fenced(item.content ?? item.output ?? item)}`;
    if (typeof item.summary === 'string') return `### Summary\n\n${item.summary}`;
    // Preserve unknown events and resource metadata in the archive instead of silently discarding them.
    return fenced(item);
}
export function exportMarkdown(value: z.infer<typeof exportPayload>): string {
    const title = typeof value.session.metadata?.name === 'string' ? value.session.metadata.name : value.session.id;
    const lines = ['---', `title: ${JSON.stringify(title)}`, `sessionId: ${JSON.stringify(value.session.id)}`, `exportedAt: ${value.exportedAt}`, `messageCount: ${value.messages.length}`, '---', '', `# ${title}`, ''];
    for (const note of value.scratchlist ?? []) {
        const item = record(note); lines.push('## Scratchlist note', '', typeof item?.text === 'string' ? item.text : fenced(note), '');
        if (Array.isArray(item?.attachments) && item.attachments.length) lines.push(fenced(item.attachments), '');
    }
    for (const message of value.messages) {
        const item = record(message.content); const role = item?.role === 'user' ? 'User' : item?.role === 'agent' ? 'Assistant' : 'Event';
        lines.push(`## ${role}`, '', `Time: ${new Date(message.createdAt).toISOString()} · Message: ${message.id}`, '', readableContent(message.content), '');
        const attachments = record(item?.content)?.attachments ?? item?.attachments;
        if (Array.isArray(attachments) && attachments.length) lines.push('### Attachments', '', fenced(attachments), '');
    }
    return lines.join('\n');
}

/** Extra session operations always keep the original Hub's namespace, source ownership and caps. */
export class HapiSessionExtras {
    private readonly exports = new Map<string, { sourceId: string; bytes: Uint8Array; mimeType: string; fileName: string; expiresAt: number }>();
    private dispose: (() => void) | undefined;
    constructor(private readonly client: Pick<HapiClient, 'hubId' | 'getSession' | 'request' | 'readBinary'>) {}
    async resolveSource(source: WorkbenchSource): Promise<void> {
        if (source.sourceHubId && source.sourceHubId !== this.client.hubId) throw new HapiRequestError('This session belongs to a different Hub', 'rejected', 403);
        const session = await this.client.getSession(source.sourceSessionId);
        if (session.id !== source.sourceSessionId || source.machineId && source.machineId !== session.metadata?.machineId) throw new HapiRequestError('Session ownership changed; refresh its source identity', 'rejected', 409);
    }
    async sourceNotes(input: SessionExtrasRequest<'sourceNotes'>): Promise<SessionExtrasResponse<'sourceNotes'>> {
        const request = sessionExtrasInputs.sourceNotes.parse(input); await this.resolveSource(request.source);
        const [entries, limits] = await Promise.all([
            this.client.request(sourcePath(request.source.sourceSessionId, '/scratchlist')),
            this.client.request(sourcePath(request.source.sourceSessionId, '/scratchlist/limits')),
        ]);
        const rows = sessionExtrasOutputs.sourceNotes.shape.entries.parse(record(entries)?.entries);
        const parsedLimits = sourceNoteLimitsSchema.parse(record(limits)?.limits);
        return { entries: rows, limits: parsedLimits, attachmentUrls: Object.fromEntries(rows.flatMap(row => row.attachments.map(attachment =>
            [attachment.id, resourceUrl({ kind: 'attachment', id: attachment.id, source: request.source })]))) };
    }
    async sourceNoteWrite(input: SessionExtrasRequest<'sourceNoteWrite'>): Promise<SessionExtrasResponse<'sourceNoteWrite'>> {
        const request = sessionExtrasInputs.sourceNoteWrite.parse(input); await this.resolveSource(request.source);
        const action = request.action; const path = sourcePath(request.source.sourceSessionId, '/scratchlist');
        if (action.kind === 'delete' || action.kind === 'delete-attachment') {
            const suffix = action.kind === 'delete' ? encodeURIComponent(action.entryId) : `attachments/${encodeURIComponent(action.attachmentId)}`;
            return z.object({ ok: z.literal(true) }).parse(await this.client.request(`${path}/${suffix}`, { method: 'DELETE' }));
        }
        if (!action.text.trim() && !action.attachments.length) throw new HapiRequestError('A note needs text or attachments', 'rejected', 400);
        const result = await this.client.request(action.kind === 'create' ? path : `${path}/${encodeURIComponent(action.entryId)}`, {
            method: action.kind === 'create' ? 'POST' : 'PUT', body: { text: action.text, attachments: action.attachments,
                ...(action.kind === 'create' ? { entryId: action.entryId, ...(action.createdAt === undefined ? {} : { createdAt: action.createdAt }) } : {}) },
        });
        return z.object({ entry: sessionExtrasOutputs.sourceNoteWrite.shape.entry.unwrap() }).parse(result);
    }
    async sourceNoteUpload(input: SessionExtrasRequest<'sourceNoteUpload'>): Promise<SessionExtrasResponse<'sourceNoteUpload'>> {
        const request = sessionExtrasInputs.sourceNoteUpload.parse(input); await this.resolveSource(request.source);
        const { limits } = z.object({ limits: sourceNoteLimitsSchema }).parse(await this.client.request(sourcePath(request.source.sourceSessionId, '/scratchlist/limits')));
        if (!limits.allowedMimeTypes.includes(request.mimeType) || Buffer.byteLength(request.content, 'base64') > limits.maxBytesPerFile
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.content)) throw new HapiRequestError('This attachment exceeds the source note limits or uses an unsupported format', 'rejected', 400);
        const value = success.extend({ attachment: sessionExtrasOutputs.sourceNoteUpload.shape.attachment.optional() }).parse(await this.client.request(
            sourcePath(request.source.sourceSessionId, '/scratchlist/upload'), { method: 'POST', body: { filename: request.filename, mimeType: request.mimeType, content: request.content }, timeoutMs: 60_000 }));
        assertSuccess(value); if (!value.attachment) throw new HapiRequestError('The note upload did not return its source identity', 'indeterminate');
        return { attachment: value.attachment };
    }
    async sourceOutline(input: SessionExtrasRequest<'sourceOutline'>): Promise<SessionExtrasResponse<'sourceOutline'>> {
        const request = sessionExtrasInputs.sourceOutline.parse(input); await this.resolveSource(request.source);
        const query = new URLSearchParams(); for (const [key, value] of Object.entries(request.query)) if (value !== undefined) query.set(key, String(value));
        return sessionExtrasOutputs.sourceOutline.parse(await this.client.request(sourcePath(request.source.sourceSessionId, `/messages/outline?${query}`)));
    }
    async sourceMessageContext(input: SessionExtrasRequest<'sourceMessageContext'>): Promise<SessionExtrasResponse<'sourceMessageContext'>> {
        const request = sessionExtrasInputs.sourceMessageContext.parse(input); await this.resolveSource(request.source);
        const query = new URLSearchParams({ radius: String(request.radius ?? 50), ...(request.epoch === undefined ? {} : { epoch: String(request.epoch) }) });
        return sessionExtrasOutputs.sourceMessageContext.parse(await this.client.request(sourcePath(request.source.sourceSessionId, `/messages/${encodeURIComponent(request.messageId)}/context?${query}`)));
    }
    async sourceSkills(input: SessionExtrasRequest<'sourceSkills'>): Promise<SessionExtrasResponse<'sourceSkills'>> {
        const request = sessionExtrasInputs.sourceSkills.parse(input); await this.resolveSource(request.source);
        const value = success.extend({ skills: sessionExtrasOutputs.sourceSkills.shape.skills.default([]) }).parse(await this.client.request(sourcePath(request.source.sourceSessionId, '/skills')));
        assertSuccess(value); return { skills: value.skills };
    }
    async sourceTitleTools(input: SessionExtrasRequest<'sourceTitleTools'>): Promise<SessionExtrasResponse<'sourceTitleTools'>> {
        const request = sessionExtrasInputs.sourceTitleTools.parse(input); await this.resolveSource(request.source);
        const [session, health] = await Promise.all([this.client.getSession(request.source.sourceSessionId), this.client.request('/health')]);
        if (session.id !== request.source.sourceSessionId || request.source.machineId && request.source.machineId !== session.metadata?.machineId) {
            throw new HapiRequestError('Session ownership changed; refresh its source identity', 'rejected', 409);
        }
        return { title: typeof session.metadata?.name === 'string' ? session.metadata.name : '',
            suggestionAvailable: record(record(health)?.capabilities)?.titleSuggestion === true };
    }
    async sourceTitleSuggestion(input: SessionExtrasRequest<'sourceTitleSuggestion'>): Promise<SessionExtrasResponse<'sourceTitleSuggestion'>> {
        const request = sessionExtrasInputs.sourceTitleSuggestion.parse(input); await this.resolveSource(request.source);
        // The original Hub owns provider configuration, prompt, rate limit and
        // billing. A lost reply must never trigger a second generation request.
        return sessionExtrasOutputs.sourceTitleSuggestion.parse(await this.client.request(sourcePath(request.source.sourceSessionId, '/title-suggestion'), { method: 'POST' }));
    }
    async sourceWorkGraph(input: SessionExtrasRequest<'sourceWorkGraph'>): Promise<SessionExtrasResponse<'sourceWorkGraph'>> {
        const request = sessionExtrasInputs.sourceWorkGraph.parse(input); await this.resolveSource(request.source);
        const health = await this.client.request('/health'), requestedLimit = request.limit ?? 100;
        if (record(record(health)?.capabilities)?.workGraph !== true) return { available: false, events: [], requestedLimit };
        const query = new URLSearchParams({ related_session_id: request.source.sourceSessionId, limit: String(requestedLimit) });
        const { events } = sessionExtrasOutputs.sourceWorkGraph.pick({ events: true }).parse(await this.client.request(`/api/work-graph/events?${query}`));
        if (events.some(event => event.relatedSessionId !== request.source.sourceSessionId)) throw new HapiRequestError('The work ledger returned events from another source conversation', 'rejected', 409);
        return { available: true, events, requestedLimit };
    }
    async sourceWorkGraphLinks(input: SessionExtrasRequest<'sourceWorkGraphLinks'>): Promise<SessionExtrasResponse<'sourceWorkGraphLinks'>> {
        const request = sessionExtrasInputs.sourceWorkGraphLinks.parse(input); await this.resolveSource(request.source);
        const path = `/api/work-graph/events/${encodeURIComponent(request.eventId)}`;
        const { event } = sessionExtrasOutputs.sourceWorkGraphLinks.pick({ event: true }).parse(await this.client.request(path));
        if (event.id !== request.eventId || event.relatedSessionId !== request.source.sourceSessionId) throw new HapiRequestError('This work event does not belong to the selected source conversation', 'rejected', 403);
        const { links } = sessionExtrasOutputs.sourceWorkGraphLinks.pick({ links: true }).parse(await this.client.request(`${path}/links`));
        if (links.some(link => link.fromEventId !== event.id && link.toEventId !== event.id)) throw new HapiRequestError('The work ledger returned links belonging to another event', 'rejected', 409);
        return { event, links };
    }
    async sourceExport(input: SessionExtrasRequest<'sourceExport'>): Promise<SourceExport> {
        const request = sessionExtrasInputs.sourceExport.parse(input); await this.resolveSource(request.source);
        const result = await this.client.readBinary(sourcePath(request.source.sourceSessionId, `/export${request.force ? '?force=true' : ''}`), { maxBytes: MAX_EXPORT_BYTES, timeoutMs: 120_000 });
        const data: unknown = JSON.parse(Buffer.from(result.data).toString('utf8'));
        const warning = exportWarning.safeParse(data); if (warning.success) return warning.data;
        const payload = exportPayload.parse(data);
        if (payload.session.id !== request.source.sourceSessionId) throw new HapiRequestError('The export belongs to a different source session', 'indeterminate');
        const bytes = request.format === 'json' ? result.data : Buffer.from(exportMarkdown(payload));
        if (bytes.byteLength > MAX_EXPORT_BYTES) throw new HapiRequestError('Session export exceeds 100 MiB', 'rejected', 413);
        const title = typeof payload.session.metadata?.name === 'string' ? payload.session.metadata.name : payload.session.id;
        const fileName = `${safeFileName(title)}.${request.format === 'json' ? 'json' : 'md'}`;
        const now = Date.now(); for (const [id, entry] of this.exports) if (entry.expiresAt < now) this.exports.delete(id);
        let total = [...this.exports.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
        for (const [id, entry] of this.exports) { if (total + bytes.byteLength <= 200 * 1024 * 1024) break; this.exports.delete(id); total -= entry.bytes.byteLength; }
        const id = randomUUID(); this.exports.set(id, { sourceId: payload.session.id, bytes, fileName, mimeType: request.format === 'json' ? 'application/json' : 'text/markdown; charset=utf-8', expiresAt: now + 10 * 60_000 });
        return { type: 'ready', fileName, bytes: bytes.byteLength, url: resourceUrl({ kind: 'export', id, source: request.source }) };
    }
    mount({ webServer, authorize }: FederationMount): void {
        this.dispose = webServer.register({ kind: 'exact', path: SOURCE_RESOURCE_PATH, handler: async (request, response) => {
            const rejection = authorize(request); if (rejection !== undefined) { response.writeHead(rejection); response.end(); return; }
            await this.serve(request, response);
        } });
    }
    close(): void { this.dispose?.(); this.dispose = undefined; this.exports.clear(); }
    private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
        try {
            const raw = new URL(request.url ?? '/', 'http://source.local').searchParams.get('request');
            if (!raw || raw.length > 16384) throw new HapiRequestError('Invalid session resource request', 'rejected', 400);
            const value = resourceQuery.parse(JSON.parse(raw)); await this.resolveSource(value.source);
            let bytes: Uint8Array; let fileName: string; let mimeType: string;
            if (value.kind === 'export') {
                const entry = this.exports.get(value.id);
                if (!entry || entry.expiresAt < Date.now() || entry.sourceId !== value.source.sourceSessionId) throw new HapiRequestError('This export expired; generate it again', 'rejected', 410);
                ({ bytes, fileName, mimeType } = entry);
            } else {
                const abort = new AbortController(); response.once('close', () => abort.abort());
                const result = await this.client.readBinary(sourcePath(value.source.sourceSessionId, `/scratchlist/attachments/${encodeURIComponent(value.id)}`), { maxBytes: 64 * 1024 * 1024, signal: abort.signal });
                bytes = result.data; fileName = result.fileName; mimeType = result.mimeType;
            }
            response.writeHead(200, { 'content-type': mimeType, 'content-length': String(bytes.byteLength), 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
                'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(bytes);
        } catch (failure) {
            if (response.destroyed) return;
            const status = failure instanceof HapiRequestError ? failure.status ?? 502 : 400;
            response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: failure instanceof HapiRequestError ? failure.message : 'Invalid session resource request' }));
        }
    }
}
