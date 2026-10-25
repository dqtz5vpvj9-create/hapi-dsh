import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
    HapiRequestError,
    type HapiTransport, type HapiSession, type HapiSessionSummary, type HapiMessagesPage,
    type HapiMessagesQuery, type HapiSendMessage, type HapiQueuedState, type HapiCancelResult,
    type HapiSteerResult, type HapiRetryResult, type HapiApprovalAnswer, type HapiEvent, type HapiAttachment,
} from '../codex/contracts.ts';
import * as schema from './schemas.ts';
import { readServerEvents } from './sse.ts';

export interface HapiClientOptions {
    hubId: string;
    url: string;
    token: string;
    requestTimeoutMs?: number;
    reconnectMinMs?: number;
    reconnectMaxMs?: number;
    /** HAPI emits a heartbeat every 30 seconds; a silent transport must reconnect. */
    streamIdleTimeoutMs?: number;
    fetch?: typeof fetch;
}
export interface SpawnSessionInput {
    requestId: string;
    directory: string;
    agent: 'agy' | 'claude' | 'codex' | 'dsh' | 'copilot' | 'cursor' | 'grok' | 'kimi' | 'opencode' | 'pi' | 'qoder';
    model?: string;
    effort?: string;
    modelReasoningEffort?: string;
    yolo?: boolean;
    permissionMode?: string;
    sessionType?: 'simple' | 'worktree';
    worktreeName?: string;
    serviceTier?: 'fast' | 'standard';
    collaborationMode?: string;
    copilotAgentMode?: 'interactive' | 'plan' | 'autopilot';
    startingMode?: 'remote' | 'pty';
    codexHome?: string;
    codexAccountId?: string;
    codexKeyProfileId?: string;
}
export const spawnSessionResponseSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('success'), sessionId: z.string().min(1) }),
    z.object({ type: z.literal('error'), message: z.string(), code: z.string().optional(),
        sessionId: z.string().min(1).optional(), childStarted: z.boolean().optional(), agent: z.string().optional() }),
]);
export type SpawnSessionResponse = z.infer<typeof spawnSessionResponseSchema>;
type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number };

/** Server-side HAPI client. Access tokens and refresh JWTs never enter client-facing data. */
export class HapiClient implements HapiTransport {
    readonly hubId: string;
    private readonly baseUrl: string;
    private readonly fetcher: typeof fetch;
    private readonly timeoutMs: number;
    private readonly lifetime = new AbortController();
    private token: { value: string; expiresAt: number } | undefined;
    private authentication: Promise<string> | undefined;
    private readonly listeners = new Set<(event: HapiEvent) => void | Promise<void>>();
    private readonly catalogListeners = new Set<() => void>();
    private stream: AbortController | undefined;
    private streamTask: Promise<void> | undefined;
    private cursor = '';
    private closed = false;
    private connected = false;
    private needsSnapshot = false;
    // A daemon is not a visible browser. Only live, expiring UI leases may
    // suppress original Hub Web Push in favour of foreground toast delivery.
    private visibility: 'visible' | 'hidden' = 'hidden';
    private subscriptionId: string | undefined;
    private appliedVisibility: { id: string; state: 'visible' | 'hidden' } | undefined;
    private visibilityTask: Promise<void> | undefined;

    constructor(private readonly options: HapiClientOptions) {
        const url = new URL(options.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
            throw new Error('HAPI URL must be HTTP(S) without embedded credentials, query, or fragment');
        }
        if (!options.hubId || !options.token || /[\r\n\0]/.test(options.token)) throw new Error('HAPI identity and token are required');
        this.hubId = options.hubId;
        this.baseUrl = url.toString().replace(/\/+$/, '');
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    }

    get isConnected(): boolean { return this.connected; }

    /** Publish the aggregate presence of real browsers to the original SSE subscription. */
    async setVisibility(state: 'visible' | 'hidden'): Promise<void> {
        if (state !== 'visible' && state !== 'hidden') throw new HapiRequestError('Invalid browser visibility', 'rejected');
        if (this.closed) throw new HapiRequestError('HAPI client has closed', 'rejected');
        this.visibility = state;
        await this.synchronizeVisibility();
    }

    private synchronizeVisibility(): Promise<void> {
        if (this.visibilityTask) return this.visibilityTask.then(() => this.synchronizeVisibility());
        const task = this.flushVisibility();
        this.visibilityTask = task;
        void task.finally(() => { if (this.visibilityTask === task) this.visibilityTask = undefined; }).catch(() => {});
        return task;
    }

    private async flushVisibility(): Promise<void> {
        for (;;) {
            const id = this.subscriptionId, state = this.visibility;
            if (!id || this.closed || this.appliedVisibility?.id === id && this.appliedVisibility.state === state) return;
            try {
                await this.request('/api/visibility', { method: 'POST', body: { subscriptionId: id, visibility: state }, timeoutMs: 5000 });
            } catch (error) {
                // An unconfirmed hide must not leave the daemon suppressing
                // Push forever. Tear down this original subscription; its next
                // connection starts with the latest real-browser visibility.
                if (this.subscriptionId === id && this.visibility === 'hidden') this.stream?.abort();
                throw error;
            }
            if (this.subscriptionId === id) this.appliedVisibility = { id, state };
            // A visible/hidden transition may have arrived while the POST was
            // in flight. Serialize the latest state after that response.
        }
    }

    private async readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
        const declaredSize = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
            await response.body?.cancel();
            throw new HapiRequestError('HAPI response exceeds the supported size', 'indeterminate', response.status);
        }
        if (!response.body) return new Uint8Array();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > maxBytes) throw new HapiRequestError('HAPI response exceeds the supported size', 'indeterminate', response.status);
                chunks.push(chunk.value);
            }
        } catch (error) {
            if (error instanceof HapiRequestError) throw error;
            throw new HapiRequestError('HAPI response ended before completion; verify native state before retrying', 'indeterminate', response.status);
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        return Buffer.concat(chunks);
    }

    private async decode(response: Response, maxBytes = 64 * 1024 * 1024): Promise<unknown> {
        const text = Buffer.from(await this.readBody(response, maxBytes)).toString('utf8');
        if (!text.trim()) return null;
        try { return JSON.parse(text); }
        catch { throw new HapiRequestError('HAPI returned invalid JSON; mutation outcome is unknown', 'indeterminate', response.status); }
    }

    private async authenticate(): Promise<string> {
        if (this.closed) throw new HapiRequestError('HAPI client has closed', 'rejected');
        if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
        if (this.authentication) return this.authentication;
        this.authentication = (async () => {
            let response: Response;
            try {
                response = await this.fetcher(`${this.baseUrl}/api/auth`, {
                    method: 'POST', redirect: 'manual', cache: 'no-store',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ accessToken: this.options.token }),
                    signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]),
                });
            } catch {
                throw new HapiRequestError('Unable to authenticate with HAPI', 'rejected');
            }
            if (!response.ok) {
                await response.body?.cancel();
                throw new HapiRequestError('HAPI authentication was rejected', 'rejected', response.status);
            }
            const value = z.object({ token: z.string().min(1) }).safeParse(await this.decode(response));
            if (!value.success) throw new HapiRequestError('Invalid HAPI authentication response', 'rejected');
            // JWT claims only schedule refresh; the Hub verifies authorization on every request.
            let expiresAt = Date.now() + 3 * 60 * 60 * 1000;
            try {
                const payload: unknown = JSON.parse(Buffer.from(value.data.token.split('.')[1] ?? '', 'base64url').toString('utf8'));
                const expires = z.object({ exp: z.number().positive() }).safeParse(payload);
                if (expires.success) expiresAt = Math.min(expiresAt, expires.data.exp * 1000);
            } catch { /* Non-JWT test/compatible auth providers use conservative refresh. */ }
            this.token = { value: value.data.token, expiresAt };
            return value.data.token;
        })();
        try { return await this.authentication; }
        finally { this.authentication = undefined; }
    }

    async request(path: string, options: RequestOptions = {}): Promise<unknown> {
        const method = (options.method ?? 'GET').toUpperCase();
        // HAPI's authorized document endpoint returns at most 64 MiB of file
        // bytes as base64 JSON. Keep the wire bound explicit instead of rejecting
        // an otherwise supported document at the generic 64 MiB JSON limit.
        const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
        if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 90 * 1024 * 1024) throw new Error('Invalid HAPI response byte limit');
        // The original additive capability advertisement is the one public
        // route outside /api/. It is read-only and cannot broaden proxy paths.
        if (!(path.startsWith('/api/') || path === '/health' && method === 'GET') || path.includes('://')) throw new Error('Invalid HAPI API path');
        const readOnly = method === 'GET' || method === 'HEAD';
        const multipart = options.body instanceof FormData;
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.authenticate();
            let response: Response;
            try {
                response = await this.fetcher(`${this.baseUrl}${path}`, {
                    method, redirect: 'manual', cache: 'no-store',
                    // A FormData boundary belongs to fetch. Setting JSON headers or
                    // serializing it would silently discard recorded audio.
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }) },
                    ...(options.body === undefined ? {} : { body: multipart ? options.body as FormData : JSON.stringify(options.body) }),
                    signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs), ...(options.signal ? [options.signal] : [])]),
                });
            } catch {
                throw new HapiRequestError('HAPI connection ended before a result; verify native state before retrying', 'indeterminate');
            }
            // The pinned HAPI auth middleware also catches downstream handler
            // failures as 401. A write may already have executed: refreshing
            // credentials never authorizes replay of that mutation.
            if (response.status === 401) {
                await response.body?.cancel();
                if (this.token?.value === token) this.token = undefined;
                if (readOnly && attempt === 0) continue;
                throw new HapiRequestError(readOnly ? 'HAPI authentication failed' : 'HAPI returned HTTP 401; the operation may already have executed. Refresh native state before retrying.',
                    readOnly ? 'rejected' : 'indeterminate', 401, 'reauthentication_required');
            }
            const value = await this.decode(response, maxResponseBytes);
            if (!response.ok) {
                const code = z.object({ code: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional() }).safeParse(value);
                throw new HapiRequestError(`HAPI request returned HTTP ${response.status}`,
                    response.status >= 400 && response.status < 500 ? 'rejected' : 'indeterminate',
                    response.status, code.success ? code.data.code : undefined, value);
            }
            return value;
        }
        throw new HapiRequestError('HAPI authentication failed', 'rejected', 401);
    }

    private async validated<T>(path: string, validator: z.ZodType, options?: RequestOptions): Promise<T> {
        const value = validator.safeParse(await this.request(path, options));
        if (!value.success) throw new HapiRequestError('HAPI returned an incompatible response', 'indeterminate', undefined, 'protocol_mismatch');
        return value.data as T;
    }

    async listSessions(): Promise<readonly HapiSessionSummary[]> {
        return (await this.validated<{ sessions: HapiSessionSummary[] }>('/api/sessions', z.object({ sessions: z.array(schema.sessionSummarySchema) }))).sessions;
    }
    async getSession(id: string): Promise<HapiSession> {
        return (await this.validated<{ session: HapiSession }>(this.sessionPath(id), z.object({ session: schema.sessionSchema }))).session;
    }
    async readMessages(id: string, query: HapiMessagesQuery = {}): Promise<HapiMessagesPage> {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
        return this.validated(`${this.sessionPath(id)}/messages?${params}`, schema.messagesSchema);
    }
    async sendMessage(id: string, message: HapiSendMessage): Promise<void> {
        await this.request(`${this.sessionPath(id)}/messages`, { method: 'POST', body: message });
    }
    getQueuedState(id: string, localIds: string[]): Promise<HapiQueuedState> {
        return this.validated(`${this.sessionPath(id)}/messages/queued-state`, schema.queuedStateSchema, { method: 'POST', body: { localIds } });
    }
    cancelQueuedMessage(id: string, messageId: string): Promise<HapiCancelResult> {
        return this.validated(`${this.sessionPath(id)}/messages/${encodeURIComponent(messageId)}`, schema.cancelResultSchema, { method: 'DELETE' });
    }
    steerQueuedMessage(id: string, messageId: string): Promise<HapiSteerResult> {
        return this.validated(`${this.sessionPath(id)}/messages/${encodeURIComponent(messageId)}/steer`, schema.steerResultSchema, { method: 'POST', body: {} });
    }
    retryIndeterminateMessage(id: string, messageId: string): Promise<HapiRetryResult> {
        return this.validated(`${this.sessionPath(id)}/messages/${encodeURIComponent(messageId)}/retry`, schema.retryResultSchema, { method: 'POST', body: {} });
    }
    async abortSession(id: string): Promise<void> { await this.request(`${this.sessionPath(id)}/abort`, { method: 'POST', body: {} }); }
    async approve(id: string, requestId: string, answer: HapiApprovalAnswer): Promise<void> {
        await this.request(`${this.sessionPath(id)}/permissions/${encodeURIComponent(requestId)}/approve`, { method: 'POST', body: answer });
    }
    async deny(id: string, requestId: string, answer: HapiApprovalAnswer = {}): Promise<void> {
        await this.request(`${this.sessionPath(id)}/permissions/${encodeURIComponent(requestId)}/deny`, { method: 'POST', body: answer });
    }
    async resumeSession(id: string, permissionMode?: string): Promise<string> {
        const result = await this.validated<{ sessionId: string }>(`${this.sessionPath(id)}/resume`, z.object({ sessionId: z.string() }), {
            method: 'POST', body: permissionMode === undefined ? {} : { permissionMode }, timeoutMs: 120_000,
        });
        return result.sessionId;
    }
    async renameSession(id: string, name: string): Promise<void> {
        await this.request(this.sessionPath(id), { method: 'PATCH', body: { name } });
    }
    async listMachines(): Promise<schema.HapiMachine[]> {
        return (await this.validated<{ machines: schema.HapiMachine[] }>('/api/machines?includeOffline=true', z.object({ machines: z.array(schema.machineSchema) }))).machines;
    }
    async listSlashCommands(id: string): Promise<readonly { name: string; description: string; source?: string; content?: string }[]> {
        const result = await this.validated<{ success: boolean; commands?: { name: string; description: string; source?: string; content?: string }[]; error?: string }>(
            `${this.sessionPath(id)}/slash-commands`, z.object({ success: z.boolean(), commands: z.array(z.object({
                name: z.string().min(1), description: z.string().default(''), source: z.string().optional(), content: z.string().optional(),
            })).optional(), error: z.string().optional() }));
        if (!result.success) throw new HapiRequestError(result.error ?? 'The original session command catalog is unavailable', 'rejected');
        return result.commands ?? [];
    }
    async spawnSession(machineId: string, input: SpawnSessionInput): Promise<SpawnSessionResponse> {
        // A spawn_outcome_unknown response can already own a reserved source
        // row and a live child. Preserve its durable identity and proof fields.
        return this.validated(`/api/machines/${encodeURIComponent(machineId)}/spawn`, spawnSessionResponseSchema,
            { method: 'POST', body: input, timeoutMs: 180_000 });
    }
    async uploadAttachment(id: string, filename: string, mimeType: string, data: Uint8Array): Promise<HapiAttachment> {
        if (data.byteLength === 0) throw new HapiRequestError('The HAPI Runner does not accept empty attachments', 'rejected');
        if (data.byteLength > 32 * 1024 * 1024) throw new HapiRequestError('Attachment exceeds 32 MiB', 'rejected');
        const result = await this.validated<{ success: boolean; path?: string }>(`${this.sessionPath(id)}/upload`,
            z.object({ success: z.boolean(), path: z.string().optional() }),
            { method: 'POST', body: { filename, mimeType, content: Buffer.from(data).toString('base64') }, timeoutMs: 120_000 });
        if (!result.success || !result.path) throw new HapiRequestError('HAPI Runner did not accept the attachment', 'rejected');
        return { id: randomUUID(), filename, mimeType, size: data.byteLength, path: result.path };
    }
    /** Server-side terminal bridge only. Never include this result in a Remote response or browser config. */
    async socketAuthentication(): Promise<{ url: string; path: string; token: string }> {
        const base = new URL(this.baseUrl);
        return { url: base.origin, path: `${base.pathname.replace(/\/+$/, '')}/socket.io/`, token: await this.authenticate() };
    }
    /** Exact owner-only backup endpoint. Stream the snapshot without buffering the database or replaying a POST. */
    async downloadSqliteBackup(signal: AbortSignal): Promise<Response> {
        const token = await this.authenticate();
        let response: Response;
        try {
            response = await this.fetcher(`${this.baseUrl}/api/storage/sqlite/backup`, {
                method: 'POST', redirect: 'manual', cache: 'no-store',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.sqlite3' },
                signal: AbortSignal.any([this.lifetime.signal, signal, AbortSignal.timeout(30 * 60 * 1000)]),
            });
        } catch { throw new HapiRequestError('The source backup connection ended before its response', 'indeterminate'); }
        if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 401 && this.token?.value === token) this.token = undefined;
            throw new HapiRequestError(response.status === 403 ? 'Only the original HAPI Hub owner can download its database backup'
                : response.status === 409 ? 'The original Hub is already creating a backup; wait before requesting another snapshot'
                : `The original Hub backup returned HTTP ${response.status}`,
                response.status >= 400 && response.status < 500 ? 'rejected' : 'indeterminate', response.status);
        }
        if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/vnd.sqlite3') {
            await response.body?.cancel();
            throw new HapiRequestError('The original Hub did not return a SQLite backup', 'indeterminate', 502);
        }
        return response;
    }
    /** Bounded source-owned bytes. This method never follows bearer credentials to a redirect target. */
    async readBinary(path: string, options: {
        signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; headers?: { Range?: string };
    } = {}): Promise<{ data: Uint8Array; mimeType: string; fileName: string; status: number; headers: Record<string, string> }> {
        const url = new URL(`${this.baseUrl}${path}`);
        const prefix = `${new URL(this.baseUrl).pathname.replace(/\/+$/, '')}/api/`;
        if (!path.startsWith('/api/') || path.includes('://') || /[\r\n\0#]/.test(path)
            || url.origin !== new URL(this.baseUrl).origin || !url.pathname.startsWith(prefix)) throw new Error('Invalid HAPI binary API path');
        const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) throw new Error('Invalid native binary size limit');
        const range = options.headers?.Range;
        if (range !== undefined && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new Error('Invalid native byte range');
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.authenticate();
            let response: Response;
            try {
                response = await this.fetcher(url, {
                    method: 'GET', redirect: 'manual', cache: 'no-store',
                    headers: { Authorization: `Bearer ${token}`, Accept: '*/*', ...(range ? { Range: range } : {}) },
                    signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000), ...(options.signal ? [options.signal] : [])]),
                });
            } catch { throw new HapiRequestError('The native resource could not be read', 'indeterminate'); }
            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel();
                if (this.token?.value === token) this.token = undefined;
                continue;
            }
            if (!response.ok) {
                await response.body?.cancel();
                throw new HapiRequestError(`Native resource returned HTTP ${response.status}`,
                    response.status >= 400 && response.status < 500 ? 'rejected' : 'indeterminate', response.status);
            }
            const data = await this.readBody(response, maxBytes);
            const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
            const disposition = response.headers.get('content-disposition') ?? '';
            const encodedName = /(?:^|;)\s*filename\*=UTF-8''([^;]*)/i.exec(disposition)?.[1]
                ?? /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1];
            let fileName = 'native-resource';
            if (encodedName) { try { fileName = decodeURIComponent(encodedName); } catch { fileName = encodedName; } }
            fileName = fileName.replace(/[\r\n\0]/g, '').split(/[\\/]/).at(-1) || 'native-resource';
            const headers: Record<string, string> = {};
            for (const key of ['content-range', 'content-length', 'accept-ranges', 'etag', 'last-modified', 'x-document-version']) {
                const value = response.headers.get(key);
                if (value !== null) headers[key] = value;
            }
            return { data, mimeType, fileName, status: response.status, headers };
        }
        throw new HapiRequestError('Native resource authentication failed', 'rejected', 401);
    }
    /** Read an opaque artifact only through its owning Hub; never resolve native paths or arbitrary URLs. */
    async readArtifact(id: string, artifactId: string): Promise<{ data: Uint8Array; mimeType: string; fileName: string }> {
        if (!artifactId || artifactId.length > 4096) throw new HapiRequestError('Invalid native artifact identity', 'rejected');
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.authenticate();
            let response: Response;
            try {
                response = await this.fetcher(`${this.baseUrl}${this.sessionPath(id)}/artifacts/${encodeURIComponent(artifactId)}`, {
                    redirect: 'manual', cache: 'no-store', headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
                    signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000)]),
                });
            } catch { throw new HapiRequestError('Native artifact is currently unavailable', 'indeterminate'); }
            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel();
                if (this.token?.value === token) this.token = undefined;
                continue;
            }
            if (!response.ok) {
                await response.body?.cancel();
                throw new HapiRequestError(`Native artifact returned HTTP ${response.status}`,
                    response.status >= 400 && response.status < 500 ? 'rejected' : 'indeterminate', response.status);
            }
            const data = await this.readBody(response, 32 * 1024 * 1024);
            const mimeType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
            const encodedName = /(?:^|;)\s*filename="([^"]*)"/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
            let fileName = 'native-resource';
            if (encodedName) {
                try { fileName = decodeURIComponent(encodedName); } catch { fileName = encodedName; }
            }
            return { data, mimeType, fileName };
        }
        throw new HapiRequestError('Native artifact authentication failed', 'rejected', 401);
    }
    private sessionPath(id: string): string { return `/api/sessions/${encodeURIComponent(id)}`; }

    subscribe(listener: (event: HapiEvent) => void | Promise<void>): () => void {
        if (this.closed) throw new Error('HAPI client has closed');
        this.listeners.add(listener);
        this.ensureStream();
        return () => { this.listeners.delete(listener); this.stopUnusedStream(); };
    }
    subscribeCatalog(listener: () => void): () => void {
        this.catalogListeners.add(listener);
        this.ensureStream();
        return () => { this.catalogListeners.delete(listener); this.stopUnusedStream(); };
    }
    private stopUnusedStream(): void {
        if (!this.listeners.size && !this.catalogListeners.size) this.stream?.abort();
    }
    private publish(event: HapiEvent): void | Promise<void> {
        const pending: Promise<void>[] = [];
        for (const listener of [...this.listeners]) {
            try { const pressure = listener(event); if (pressure) pending.push(pressure); }
            catch (error) { pending.push(Promise.reject(error)); }
        }
        if (pending.length) return Promise.all(pending).then(() => {});
    }
    private async waitForSubscribers(pending: Promise<void>, signal: AbortSignal): Promise<void> {
        if (signal.aborted) throw signal.reason;
        await new Promise<void>((resolve, reject) => {
            const abort = (): void => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }
    private ensureStream(): void {
        if (this.stream || this.closed) return;
        const controller = new AbortController();
        this.stream = controller;
        this.streamTask = this.runStream(controller.signal).finally(() => {
            if (this.stream === controller) this.stream = undefined;
            if (!this.closed && (this.listeners.size || this.catalogListeners.size)) this.ensureStream();
        });
    }
    private async runStream(signal: AbortSignal): Promise<void> {
        let backoff = this.options.reconnectMinMs ?? 500;
        while (!signal.aborted && !this.closed) {
            const idle = new AbortController();
            let idleTimer: ReturnType<typeof setTimeout>;
            const touch = (): void => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => idle.abort(new Error('HAPI event heartbeat timed out')), this.options.streamIdleTimeoutMs ?? 90_000);
                idleTimer.unref();
            };
            touch();
            const streamSignal = AbortSignal.any([signal, this.lifetime.signal, idle.signal]);
            try {
                const token = await this.authenticate();
                const initialVisibility = this.visibility;
                const response = await this.fetcher(`${this.baseUrl}/api/events?all=true&messageMode=full&visibility=${initialVisibility}`, {
                    redirect: 'manual', cache: 'no-store', signal: streamSignal,
                    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', ...(this.cursor ? { 'Last-Event-ID': this.cursor } : {}) },
                });
                if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
                    if (response.status === 401 && this.token?.value === token) this.token = undefined;
                    await response.body?.cancel();
                    throw new Error('HAPI event stream is unavailable');
                }
                for await (const record of readServerEvents(response.body, streamSignal)) {
                    touch();
                    // A cursor is sent as an HTTP header on the next connection. Never
                    // let an incompatible source ID poison every subsequent reconnect.
                    if (record.id !== undefined && (record.id.length > 1024 || !/^[\x21-\x7e]*$/.test(record.id))) {
                        this.cursor = '';
                        this.needsSnapshot = true;
                        throw new Error('Invalid HAPI stream cursor; a full native reconciliation is required');
                    }
                    if (record.retry !== undefined) backoff = Math.max(100, Math.min(record.retry, 30_000));
                    if (!record.data) { if (record.id !== undefined) this.cursor = record.id; continue; }
                    let value: unknown;
                    try { value = JSON.parse(record.data); }
                    catch { this.cursor = ''; this.needsSnapshot = true; throw new Error('Invalid HAPI stream record'); }
                    const parsed = schema.eventSchema.safeParse(value);
                    if (parsed.success) {
                        const event = parsed.data as HapiEvent;
                        if (event.type === 'connection-changed') {
                            this.connected = event.data?.status === 'connected';
                            this.subscriptionId = this.connected ? event.data?.subscriptionId : undefined;
                            this.appliedVisibility = this.subscriptionId ? { id: this.subscriptionId, state: initialVisibility } : undefined;
                            if (this.subscriptionId && this.visibility !== initialVisibility) void this.synchronizeVisibility().catch(() => {});
                            if (this.connected && this.needsSnapshot) {
                                event.data = { ...event.data!, resume: 'gap' };
                                this.needsSnapshot = false;
                            }
                        }
                        const pressure = this.publish(event);
                        if (pressure) {
                            // Waiting for local capacity is not a missing network heartbeat.
                            clearTimeout(idleTimer!);
                            try { await this.waitForSubscribers(pressure, streamSignal); }
                            catch (error) { this.cursor = ''; this.needsSnapshot = true; throw error; }
                            touch();
                        }
                    } else if (typeof value === 'object' && value && 'type' in value &&
                        /^(session-(added|updated|removed|ended)|message-(received|updated|cancelled)|messages-(invalidated|consumed|indeterminate|dispatching|requeued)|scheduled-matured|connection-changed)$/.test(String(value.type))) {
                        // Never acknowledge a malformed business event. Reconnect from a
                        // full authoritative snapshot instead of silently advancing past it.
                        this.cursor = '';
                        this.needsSnapshot = true;
                        throw new Error('HAPI event protocol changed; a full native reconciliation is required');
                    }
                    if (typeof value === 'object' && value && 'type' in value && /^(machine-|session-|connection-changed)/.test(String(value.type))) {
                        for (const listener of [...this.catalogListeners]) { try { listener(); } catch { /* isolate */ } }
                    }
                    if (record.id !== undefined) this.cursor = record.id;
                    backoff = this.options.reconnectMinMs ?? 500;
                }
            } catch { /* Reads reconnect; mutations are never replayed here. */ }
            finally { clearTimeout(idleTimer!); this.subscriptionId = undefined; this.appliedVisibility = undefined; }
            this.connected = false;
            if (signal.aborted || this.closed) break;
            const pressure = this.publish({ type: 'connection-changed', data: { status: 'disconnected' } });
            if (pressure) {
                try { await this.waitForSubscribers(pressure, signal); }
                catch { this.cursor = ''; this.needsSnapshot = true; }
            }
            await delay(backoff, undefined, { signal }).catch(() => undefined);
            backoff = Math.min(backoff * 2, this.options.reconnectMaxMs ?? 15_000);
        }
    }
    async close(): Promise<void> {
        this.closed = true;
        this.connected = false;
        this.lifetime.abort();
        this.stream?.abort();
        await this.streamTask;
        this.listeners.clear();
        this.catalogListeners.clear();
        this.token = undefined;
    }
}
