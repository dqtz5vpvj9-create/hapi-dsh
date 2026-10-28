/** Explicit voice-provider protocol fixture. It never contacts a real speech/model service. */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { VoiceCredentialUpdate, VoiceCredentials } from '../../src/voice-types.ts';

type Backend = 'gemini-live' | 'qwen-realtime';
export class VoiceWireFixture {
    readonly transcriptions: Array<{ provider: string; mode: string; language: string | null; mimeType: string; bytes: Buffer }> = [];
    readonly credentialsUpdates: VoiceCredentialUpdate[] = [];
    readonly frames: Array<{ backend: Backend; connectionId: number; value: Record<string, unknown> }> = [];
    readonly connections: Array<{ id: number; backend: Backend; parameters: URLSearchParams; socket: WebSocket; closed: boolean }> = [];
    failNextTranscription = false;
    failNextCredentialReply = false;
    private readonly ws = new WebSocketServer({ noServer: true });
    private credentialState: VoiceCredentials;
    constructor(server: Server, private readonly jwt: string) {
        const configured = () => ({ configured: true, source: 'settings' as const, hint: '…fixture', editable: true });
        this.credentialState = { openai: configured(), elevenlabs: configured(), deepgram: configured(), groq: configured(),
            openaiCompatible: { configured: true, source: 'settings', baseUrl: 'https://voice-provider.fixture/v1', model: 'fixture-transcription', baseUrlEditable: true, modelEditable: true, apiKey: configured() },
            voiceBackends: { elevenlabs: configured(), geminiLive: configured(), qwenRealtime: configured() } };
        server.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url ?? '/', 'http://fixture');
            const backend = url.pathname === '/api/voice/gemini-ws' ? 'gemini-live' : url.pathname === '/api/voice/qwen-ws' ? 'qwen-realtime' : null;
            if (!backend) return;
            if (url.searchParams.get('token') !== jwt) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
            this.ws.handleUpgrade(request, socket, head, client => {
                const row: typeof this.connections[number] = { id: this.connections.length + 1, backend, parameters: url.searchParams, socket: client, closed: false }; this.connections.push(row);
                client.on('close', () => { row.closed = true; });
                client.on('message', raw => {
                    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
                    this.frames.push({ backend, connectionId: row.id, value });
                });
                client.send(JSON.stringify(backend === 'gemini-live' ? { setupComplete: {} } : { type: 'session.updated', session: { id: `voice-fixture-${row.id}` } }));
            });
        });
    }
    async handle(url: URL, request: IncomingMessage, response: ServerResponse, raw: Buffer): Promise<boolean> {
        if (!url.pathname.startsWith('/api/voice/')) return false;
        const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
        if (request.headers.authorization !== `Bearer ${this.jwt}`) { send({ error: 'Unauthorized fixture voice request' }, 401); return true; }
        const body = (): Record<string, unknown> => raw.length ? JSON.parse(raw.toString()) : {};
        if (url.pathname === '/api/voice/backend') { send({ backend: 'gemini-live', backends: ['elevenlabs', 'gemini-live', 'qwen-realtime'] }); return true; }
        if (url.pathname === '/api/voice/transcription/providers') { send({ providers: [
            { id: 'openai', label: 'OpenAI', modes: ['standard', 'realtime'] }, { id: 'elevenlabs', label: 'ElevenLabs', modes: ['standard', 'realtime'] },
            { id: 'deepgram', label: 'Deepgram', modes: ['standard', 'realtime'] }, { id: 'groq', label: 'Groq', modes: ['standard'] }, { id: 'openai-compatible', label: 'OpenAI-compatible', modes: ['standard'] },
        ] }); return true; }
        if (url.pathname === '/api/voice/transcription/credentials') {
            if (request.method === 'PUT') {
                const update = body() as VoiceCredentialUpdate; this.credentialsUpdates.push(structuredClone(update));
                for (const key of ['openai', 'elevenlabs', 'deepgram', 'groq', 'geminiLive', 'qwenRealtime'] as const) if (key in update) {
                    const value = { configured: update[key] !== null, source: update[key] === null ? 'none' as const : 'settings' as const, hint: update[key] === null ? null : '…fixture-updated', editable: true };
                    if (key === 'geminiLive' || key === 'qwenRealtime') this.credentialState.voiceBackends[key] = value; else this.credentialState[key] = value;
                }
                if (update.openaiCompatible) {
                    const next = update.openaiCompatible;
                    if ('baseUrl' in next) this.credentialState.openaiCompatible.baseUrl = next.baseUrl ?? null;
                    if ('model' in next) this.credentialState.openaiCompatible.model = next.model ?? null;
                    if ('apiKey' in next) this.credentialState.openaiCompatible.apiKey = { configured: next.apiKey !== null, source: next.apiKey === null ? 'none' : 'settings', hint: next.apiKey === null ? null : '…fixture-updated', editable: true };
                }
                if (this.failNextCredentialReply) { this.failNextCredentialReply = false; response.destroy(); return true; }
            }
            send(this.credentialState); return true;
        }
        if (url.pathname === '/api/voice/voices') { send({ voices: [{ id: 'fixture-voice', name: 'Fixture voice', previewUrl: null, category: 'fixture' }] }); return true; }
        if (url.pathname === '/api/voice/transcription' && request.method === 'POST') {
            const form = await new Response(new Uint8Array(raw), { headers: { 'Content-Type': request.headers['content-type'] ?? '' } }).formData();
            const file = form.get('file'); if (!(file instanceof File)) { send({ error: 'Missing fixture audio file' }, 400); return true; }
            this.transcriptions.push({ provider: String(form.get('provider')), mode: String(form.get('mode')), language: form.get('language') as string | null, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
            if (this.failNextTranscription) { this.failNextTranscription = false; send({ error: 'Fixture transcription is temporarily unavailable' }, 503); return true; }
            send({ text: 'Fixture voice transcript into the original draft', language: 'en' }); return true;
        }
        if (url.pathname.endsWith('gemini-token') || url.pathname.endsWith('qwen-token')) { send({ allowed: true, apiKey: 'proxied', wsUrl: '/fixture-must-not-be-trusted' }); return true; }
        if (url.pathname === '/api/voice/token' || url.pathname === '/api/voice/transcription/realtime-token') { send({ error: 'This browser fixture does not contact an external SDK/WebRTC provider' }, 503); return true; }
        send({ error: `Unknown fixture voice route ${url.pathname}` }, 404); return true;
    }
    sendTool(backend: Backend, name: string, args: unknown, id: string): void {
        const target = [...this.connections].reverse().find(row => row.backend === backend && !row.closed); if (!target) throw new Error('No live voice fixture connection');
        target.socket.send(JSON.stringify(backend === 'gemini-live' ? { toolCall: { functionCalls: [{ id, name, args }] } }
            : { type: 'response.function_call_arguments.done', call_id: id, name, arguments: JSON.stringify(args) }));
    }
    caption(backend: Backend, text: string): void {
        const target = [...this.connections].reverse().find(row => row.backend === backend && !row.closed); if (!target) throw new Error('No live voice fixture connection');
        target.socket.send(JSON.stringify(backend === 'gemini-live' ? { serverContent: { modelTurn: { parts: [{ text }] }, turnComplete: true } }
            : { type: 'response.audio_transcript.delta', delta: text }));
    }
    close(): void { for (const client of this.ws.clients) client.terminate(); this.ws.close(); }
}
