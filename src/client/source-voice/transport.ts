import type { SourceVoiceApi, VoiceBackend } from '../../voice-types.ts';
import { MAX_VOICE_AUDIO_BYTES, VOICE_TRANSCRIPTION_PATH, VOICE_PROXY_PATHS } from '../../voice-types.ts';
import { remoteValue } from '../../client-api.ts';

/** Captured from the primary plugin graph, so source voice never targets a remote DSH Runner by accident. */
export class SourceVoiceTransport {
    constructor(readonly api: SourceVoiceApi, private readonly base: string = document.baseURI, private readonly fetcher: typeof fetch = fetch,
        private readonly socketFactory: (url: string) => WebSocket = url => new WebSocket(url)) {}
    async token(provider: 'openai' | 'elevenlabs' | 'deepgram', language: string | undefined, signal: AbortSignal): Promise<string> {
        return remoteValue(await this.api.sourceVoiceRealtimeToken({ provider, ...(language ? { language } : {}) }, signal)).token;
    }
    async transcribe(file: File, provider: string, language: string | undefined, signal: AbortSignal): Promise<string> {
        if (!file.size || file.size > MAX_VOICE_AUDIO_BYTES) throw new Error('Audio recording must be between 1 byte and 25 MiB');
        const form = new FormData(); form.set('file', file); form.set('provider', provider); form.set('mode', 'standard'); if (language) form.set('language', language);
        const response = await this.fetcher(new URL(VOICE_TRANSCRIPTION_PATH.slice(1), this.base), { method: 'POST', body: form,
            credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal });
        const result: unknown = await response.json();
        if (!response.ok) throw new Error(typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string' ? result.error : `Transcription returned HTTP ${response.status}`);
        if (typeof result !== 'object' || result === null || !('text' in result) || typeof result.text !== 'string') throw new Error('The source returned an incompatible transcript');
        return result.text;
    }
    open(backend: Exclude<VoiceBackend, 'elevenlabs'>): WebSocket {
        const url = new URL(VOICE_PROXY_PATHS[backend].slice(1), this.base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return this.socketFactory(url.href);
    }
}
