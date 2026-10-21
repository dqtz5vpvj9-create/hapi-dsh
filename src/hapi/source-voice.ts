/** Provider protocols and credentials remain on the original HAPI Hub. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { HapiClient } from './client.ts';
import { HapiRequestError } from '../codex/contracts.ts';
import type { FederationMount } from '../hub/federation.ts';
import { MAX_VOICE_AUDIO_BYTES, VOICE_PROXY_PATHS, VOICE_TRANSCRIPTION_PATH, voiceInputs, voiceOutputs, voiceLanguageSchema,
    transcriptionProviderSchema, voiceBackendSchema, type VoiceRequest, type VoiceResponse, type VoiceMethod } from '../voice-types.ts';
import { buildSessionVoiceContextPlan } from '../voice/voiceContextPlan.ts';
import { formatMessage, formatPermissionRequest } from '../voice/contextFormatters.ts';
import { getSessionTitle } from '../voice/sessionTitle.ts';
import { truncateUtf8ByteLength } from '../voice/protocol/voicePersonality.ts';

export type SourceVoiceClient = Pick<HapiClient, 'hubId' | 'getSession' | 'readMessages' | 'request' | 'socketAuthentication'>;
const backendResponse = z.object({ backend: voiceBackendSchema.nullable(), backends: z.array(voiceBackendSchema).max(3) });
const providerResponse = voiceOutputs.sourceVoiceCapabilities.pick({ providers: true });
const tokenResponse = z.object({ allowed: z.boolean(), token: z.string().max(65_536).optional(), agentId: z.string().max(512).optional(), error: z.string().max(8192).optional() });
const transcriptionResponse = z.object({ text: z.string().max(2 * 1024 * 1024), language: z.string().max(64).optional() });
export const voiceProxyConfigurationSchema = z.strictObject({
    type: z.literal('hapi.voice.connect'), language: voiceLanguageSchema.optional(), voice: z.string().min(1).max(512).optional(),
    systemPrompt: z.string().min(1).max(12_000).regex(/^[A-Za-z0-9_-]+$/u).optional(), affectiveDialog: z.boolean().optional(),
});
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new HapiRequestError('The original Hub returned an incompatible voice response', 'indeterminate', 502, 'voice_protocol_mismatch');
    return result.data;
}
function reject(socket: Duplex, status: number): void { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
function answer(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value));
}
const MAX_PROXY_FRAME = 2 * 1024 * 1024;

export class SourceVoiceService {
    private readonly lifetime = new AbortController();
    private readonly disposers: Array<() => void> = [];
    private readonly sockets = new Set<WebSocket>();
    private readonly socketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PROXY_FRAME });
    constructor(private readonly client: SourceVoiceClient) {}
    private signal(signal?: AbortSignal): AbortSignal { return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]); }
    private async request<K extends VoiceMethod>(name: K, path: string, input: unknown, options: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<VoiceResponse<K>> {
        voiceInputs[name].parse(input);
        return parsed(voiceOutputs[name] as unknown as z.ZodType<VoiceResponse<K>>, await this.client.request(path, { ...options, signal: this.signal(options.signal) }));
    }
    async sourceVoiceCapabilities(input: VoiceRequest<'sourceVoiceCapabilities'>, signal?: AbortSignal): Promise<VoiceResponse<'sourceVoiceCapabilities'>> {
        voiceInputs.sourceVoiceCapabilities.parse(input); const options = { signal: this.signal(signal) };
        const [backends, providers] = await Promise.all([this.client.request('/api/voice/backend', options), this.client.request('/api/voice/transcription/providers', options)]);
        return { hubId: this.client.hubId, ...parsed(backendResponse, backends), ...parsed(providerResponse, providers) };
    }
    sourceVoiceCredentials(input: VoiceRequest<'sourceVoiceCredentials'>, signal?: AbortSignal) {
        return this.request('sourceVoiceCredentials', '/api/voice/transcription/credentials', input, { ...(signal ? { signal } : {}) });
    }
    sourceVoiceUpdateCredentials(input: VoiceRequest<'sourceVoiceUpdateCredentials'>, signal?: AbortSignal) {
        const request = voiceInputs.sourceVoiceUpdateCredentials.parse(input);
        // HAPI enforces the default namespace owner and its environment locks.
        // Plaintext credentials exist only in this single in-memory request.
        return this.request('sourceVoiceUpdateCredentials', '/api/voice/transcription/credentials', request,
            { method: 'PUT', body: request.update, ...(signal ? { signal } : {}) });
    }
    sourceVoiceVoices(input: VoiceRequest<'sourceVoiceVoices'>, signal?: AbortSignal) {
        return this.request('sourceVoiceVoices', '/api/voice/voices', input, { ...(signal ? { signal } : {}) });
    }
    sourceVoiceRealtimeToken(input: VoiceRequest<'sourceVoiceRealtimeToken'>, signal?: AbortSignal) {
        const request = voiceInputs.sourceVoiceRealtimeToken.parse(input);
        return this.request('sourceVoiceRealtimeToken', '/api/voice/transcription/realtime-token', request,
            { method: 'POST', body: request, timeoutMs: 20_000, ...(signal ? { signal } : {}) });
    }
    async sourceVoiceToken(input: VoiceRequest<'sourceVoiceToken'>, signal?: AbortSignal): Promise<VoiceResponse<'sourceVoiceToken'>> {
        const request = voiceInputs.sourceVoiceToken.parse(input), endpoint = { elevenlabs: 'token', 'gemini-live': 'gemini-token', 'qwen-realtime': 'qwen-token' }[request.backend];
        const result = parsed(tokenResponse, await this.client.request(`/api/voice/${endpoint}`, {
            method: 'POST', body: request.backend === 'elevenlabs' && request.voiceId ? { voiceId: request.voiceId } : {}, timeoutMs: 30_000, signal: this.signal(signal),
        }));
        if (request.backend === 'elevenlabs') return { ...result, backend: request.backend };
        // Never return a source URL, permanent provider key or HAPI JWT to the browser.
        return { allowed: result.allowed, backend: request.backend, ...(result.error ? { error: result.error } : {}),
            ...(result.allowed ? { socketPath: VOICE_PROXY_PATHS[request.backend] } : {}) };
    }
    async sourceVoiceContext(input: VoiceRequest<'sourceVoiceContext'>, signal?: AbortSignal): Promise<VoiceResponse<'sourceVoiceContext'>> {
        const request = voiceInputs.sourceVoiceContext.parse(input), combined = this.signal(signal); combined.throwIfAborted();
        if (request.source.sourceHubId !== undefined && request.source.sourceHubId !== this.client.hubId) throw new HapiRequestError('Voice context belongs to a different source Hub', 'rejected', 409, 'source_mismatch');
        const session = await this.client.getSession(request.source.sourceSessionId); combined.throwIfAborted();
        if (session.id !== request.source.sourceSessionId || request.source.machineId !== undefined && session.metadata?.machineId !== request.source.machineId) throw new HapiRequestError('Voice context belongs to a different source session or machine', 'rejected', 409, 'source_mismatch');
        const page = await this.client.readMessages(session.id, { limit: 50 }); combined.throwIfAborted();
        const agentLabel = truncateUtf8ByteLength(session.metadata?.flavor || 'Coding agent', 128);
        const plan = buildSessionVoiceContextPlan(session, page.messages, agentLabel);
        const approvals = Object.entries(session.agentState?.requests ?? {}).slice(0, 128).map(([id, value]) => ({
            id, tool: truncateUtf8ByteLength(value.tool, 1024), context: truncateUtf8ByteLength(formatPermissionRequest(session.id, id, value.tool, value.arguments, agentLabel), 8000),
            // Structured user input must be answered through its original question UI.
            answerable: !/AskUserQuestion|request_user_input|requestuserinput|userinput/i.test(value.tool),
        }));
        return parsed(voiceOutputs.sourceVoiceContext, {
            source: { ...request.source, sourceHubId: this.client.hubId, ...(session.metadata?.machineId ? { machineId: session.metadata.machineId } : {}) },
            sessionId: session.id, title: truncateUtf8ByteLength(getSessionTitle(session), 8192), agentLabel, active: session.active, thinking: session.thinking,
            epoch: page.page.epoch, hasEarlier: page.page.hasMore, plan, approvals,
            messages: page.messages.slice(-50).map(message => ({ id: message.id, seq: message.seq, text: (() => { const text = formatMessage(message, agentLabel); return text ? truncateUtf8ByteLength(text, 8000) : null; })() })),
        });
    }
    mount({ webServer, authorize }: FederationMount): void {
        if (this.disposers.length || this.lifetime.signal.aborted) throw new Error('The voice bridge can be mounted only once');
        this.disposers.push(webServer.register({ kind: 'exact', path: VOICE_TRANSCRIPTION_PATH, handler: async (request, response) => {
            const denial = authorize(request); if (denial !== undefined) { answer(response, denial, { error: 'Voice access denied' }); return; }
            await this.transcribe(request, response);
        } }));
        for (const backend of ['gemini-live', 'qwen-realtime'] as const) this.disposers.push(webServer.registerUpgrade({ path: VOICE_PROXY_PATHS[backend], handler: (request, socket, head) => {
            const denial = authorize(request); if (denial !== undefined) { reject(socket, denial); return; }
            if (this.sockets.size >= 16) { reject(socket, 429); return; }
            this.socketServer.handleUpgrade(request, socket, head, browser => this.proxy(browser, backend));
        } }));
    }
    close(): void {
        this.lifetime.abort(); for (const dispose of this.disposers.splice(0)) dispose();
        for (const browser of this.sockets) browser.close(1001, 'Voice bridge stopped'); this.sockets.clear(); this.socketServer.close();
    }
    private async transcribe(request: IncomingMessage, response: ServerResponse): Promise<void> {
        if (request.method !== 'POST') { response.setHeader('allow', 'POST'); answer(response, 405, { error: 'Use POST for transcription' }); return; }
        const controller = new AbortController(), signal = this.signal(controller.signal);
        const abort = () => controller.abort(); response.once('close', abort);
        try {
            const contentType = request.headers['content-type'];
            if (!contentType?.startsWith('multipart/form-data;')) throw new HapiRequestError('Expected an audio multipart upload', 'rejected', 415);
            const maxBytes = MAX_VOICE_AUDIO_BYTES + 1024 * 1024, declared = Number(request.headers['content-length']);
            if (Number.isFinite(declared) && declared > maxBytes) throw new HapiRequestError('Audio is limited to 25 MiB', 'rejected', 413);
            let length = 0; const chunks: Buffer[] = [];
            for await (const value of request) { signal.throwIfAborted(); const chunk = Buffer.from(value); length += chunk.length;
                if (length > maxBytes) throw new HapiRequestError('Audio is limited to 25 MiB', 'rejected', 413); chunks.push(chunk); }
            const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData(); signal.throwIfAborted();
            if ([...form.keys()].some(key => !['file', 'provider', 'mode', 'language'].includes(key)) || ['file', 'provider', 'mode', 'language'].some(key => form.getAll(key).length > 1)) throw new HapiRequestError('Invalid transcription fields', 'rejected', 400);
            const file = form.get('file'), provider = transcriptionProviderSchema.parse(form.get('provider'));
            if (provider === 'browser-local' || form.get('mode') !== 'standard') throw new HapiRequestError('This endpoint accepts standard provider transcription only', 'rejected', 400);
            if (!(file instanceof File) || file.size < 1 || file.size > MAX_VOICE_AUDIO_BYTES || !/^(audio\/[^;]+|video\/(webm|mp4))(?:;.*)?$/iu.test(file.type)) throw new HapiRequestError('Choose an audio recording up to 25 MiB', 'rejected', 400);
            const language = form.get('language'); if (language !== null) voiceLanguageSchema.parse(language);
            const upstream = new FormData(); upstream.set('file', file, file.name.slice(0, 255)); upstream.set('provider', provider); upstream.set('mode', 'standard'); if (typeof language === 'string') upstream.set('language', language);
            const result = parsed(transcriptionResponse, await this.client.request('/api/voice/transcription', { method: 'POST', body: upstream, timeoutMs: 125_000, signal }));
            answer(response, 200, result);
        } catch (error) {
            if (signal.aborted) return;
            const known = error instanceof HapiRequestError;
            answer(response, known && error.status && error.status >= 400 && error.status < 600 ? error.status : error instanceof z.ZodError ? 400 : 502,
                { error: known ? error.message : 'The audio transcription could not be confirmed', outcome: known ? error.outcome : 'indeterminate' });
        } finally { response.off('close', abort); }
    }
    private proxy(browser: WebSocket, backend: 'gemini-live' | 'qwen-realtime'): void {
        this.sockets.add(browser); let upstream: WebSocket | undefined, opening = false;
        const timer = setTimeout(() => browser.close(1008, 'Voice configuration required'), 10_000); timer.unref();
        const stop = () => { clearTimeout(timer); this.sockets.delete(browser); upstream?.terminate(); };
        browser.once('close', stop); browser.on('error', () => { stop(); browser.terminate(); });
        const failure = () => { browser.close(1011, 'The original voice connection ended'); upstream?.terminate(); };
        browser.on('message', (bytes, binary) => {
            if (binary) { browser.close(1003, 'Voice expects JSON protocol frames'); return; }
            if (!opening) {
                opening = true; let configuration: z.infer<typeof voiceProxyConfigurationSchema>;
                try { configuration = voiceProxyConfigurationSchema.parse(JSON.parse(bytes.toString())); }
                catch { browser.close(1008, 'Invalid voice configuration'); return; }
                void (async () => {
                    const auth = await this.client.socketAuthentication();
                    if (browser.readyState !== WebSocket.OPEN || this.lifetime.signal.aborted) return;
                    if (!auth.path.endsWith('/socket.io/')) throw new Error('Invalid original Hub socket prefix');
                    const url = new URL(`${auth.path.slice(0, -'/socket.io/'.length)}/api/voice/${backend === 'gemini-live' ? 'gemini-ws' : 'qwen-ws'}`, auth.url);
                    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('token', auth.token);
                    for (const key of ['language', 'voice', 'systemPrompt'] as const) if (configuration[key]) url.searchParams.set(key, configuration[key]);
                    if (backend === 'gemini-live' && configuration.affectiveDialog) url.searchParams.set('affectiveDialog', '1');
                    upstream = new WebSocket(url, { maxPayload: MAX_PROXY_FRAME, perMessageDeflate: false, handshakeTimeout: 15_000, followRedirects: false });
                    upstream.once('open', () => clearTimeout(timer));
                    upstream.on('message', (data, isBinary) => {
                        if (browser.readyState !== WebSocket.OPEN) return;
                        if (browser.bufferedAmount > 8 * 1024 * 1024) { browser.close(1013, 'Voice receiver is too slow'); upstream?.terminate(); return; }
                        browser.send(data, { binary: isBinary }, error => { if (error) failure(); });
                    });
                    upstream.once('close', () => { if (browser.readyState === WebSocket.OPEN) browser.close(1000, 'Original voice session ended'); });
                    upstream.on('error', failure);
                })().catch(failure);
                return;
            }
            if (upstream?.readyState !== WebSocket.OPEN) { browser.close(1008, 'Original voice connection is not ready'); return; }
            if (upstream.bufferedAmount > 8 * 1024 * 1024) { browser.close(1013, 'Voice sender is too fast'); return; }
            // No reconnect queue, retransmission or arbitrary endpoint. HAPI's
            // own Gemini/Qwen proxy retains its original setup-frame policy.
            upstream.send(bytes, { binary: false }, error => { if (error) failure(); });
        });
    }
}
