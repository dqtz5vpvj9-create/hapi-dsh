/** Gemini/Qwen wire handling adapted from HAPI 0f8ef697 realtime/*VoiceSession.tsx (AGPL-3.0-only). */
import { randomId } from '../random-id.ts';
import { remoteValue } from '../../client-api.ts';
import { isObject } from '../../voice/messages.ts';
import { resolveComposedVoiceSystemPrompt, truncateUtf8ByteLength } from '../../voice/protocol/voicePersonality.ts';
import { resolveGeminiLiveVoice, resolveQwenRealtimeVoice } from '../../voice/protocol/voicePickerCatalog.ts';
import { GeminiAudioPlayer } from './audio/player.ts';
import { PcmRecorder } from './audio/recorder.ts';
import { buildElevenLabsSessionOverridesFromPrefs, capElevenLabsInitialContext, encodeVoiceSystemPromptForProxy, truncatePromptForProxy } from './personality-session.ts';
import { getElevenLabsCodeFromPreference } from './languages.ts';
import type { SourceVoiceTransport } from './transport.ts';
import type { VoicePreferences } from './preferences.ts';
import type { VoiceContext } from './context.ts';
import { VoiceToolDispatcher, type VoiceToolOwner, type VoiceToolReceipt } from './tools.ts';

export interface ElevenConversation {
    start(options: Record<string, unknown>): Promise<void>; end(): Promise<void>;
    text(value: string): void; context(value: string): void;
}
export interface VoiceAssistantState {
    status: 'idle' | 'connecting' | 'connected' | 'stopping' | 'error'; mode: 'listening' | 'speaking'; muted: boolean;
    error: string | null; notice: string | null; caption: string; receipts: readonly VoiceToolReceipt[];
}
interface Run {
    settings: VoicePreferences; owner: VoiceToolOwner; abort: AbortController; tools: VoiceToolDispatcher; context?: VoiceContext;
    socket?: WebSocket; playback?: AudioContext; player?: GeminiAudioPlayer; recorder?: PcmRecorder;
    instructions: string; updates: string[]; eventId: number; speaking: boolean; eleven: boolean; closing?: Promise<void>;
}
export const voiceError = (value: unknown): string => value instanceof Error ? value.message : isObject(value) && typeof value.message === 'string' ? value.message : 'Voice connection failed';
export function voiceDelay(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
    });
}

export class VoiceAssistant {
    private run: Run | null = null;
    private state: VoiceAssistantState = { status: 'idle', mode: 'listening', muted: false, error: null, notice: null, caption: '', receipts: [] };
    private readonly listeners = new Set<() => void>();
    getSnapshot = (): VoiceAssistantState => this.state;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    constructor(private readonly transport: SourceVoiceTransport, private readonly owner: VoiceToolOwner | (() => VoiceToolOwner),
        private readonly eleven: ElevenConversation, private readonly onSettled: () => void) {}
    private update(patch: Partial<VoiceAssistantState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
    private current(run: Run): boolean { return this.run === run && !run.abort.signal.aborted; }
    private require(run: Run): void { if (!this.current(run)) throw new Error('Voice session ended'); run.owner.current(); }
    async start(settings: VoicePreferences): Promise<void> {
        if (this.run) throw new Error('End the current voice connection before starting another');
        if (!settings.backend) throw new Error('Configure a voice assistant backend in the original Hub settings');
        // A public projection may hydrate after React first constructs this
        // controller. Capture the latest owner at explicit start, then retain
        // that exact owner throughout the connection and all its callbacks.
        const owner = typeof this.owner === 'function' ? this.owner() : this.owner;
        owner.current();
        const abort = new AbortController();
        const run: Run = { settings, owner, abort, tools: new VoiceToolDispatcher(owner, abort.signal, () => { if (this.run === run) this.update({ receipts: run.tools.receipts() }); }),
            instructions: '', updates: [], eventId: 0, speaking: false, eleven: false };
        this.run = run; this.update({ status: 'connecting', error: null, notice: null, caption: '', receipts: [], mode: 'listening' });
        try {
            // Native AudioContext creation/resume stays inside the user's click.
            if (settings.backend !== 'elevenlabs') { run.playback = new AudioContext({ sampleRate: 24000 }); await run.playback.resume(); this.require(run); }
            const [context, token] = await Promise.all([
                run.owner.readContext(abort.signal),
                this.transport.api.sourceVoiceToken({ backend: settings.backend, ...(settings.voice ? { voiceId: settings.voice } : {}) }, abort.signal).then(remoteValue),
            ]);
            this.require(run); if (!token.allowed) throw new Error(token.error || 'The original Hub did not allow this voice backend');
            run.context = context; this.update({ notice: context.plan.notice });
            if (settings.backend === 'elevenlabs') {
                if (!token.token) throw new Error('The original Hub did not return a temporary conversation token');
                run.eleven = true;
                const language = getElevenLabsCodeFromPreference(settings.language ?? null);
                const tool = (name: string, args: unknown) => this.current(run)
                    ? run.tools.call({ id: randomId(), name, args }) : Promise.resolve('error (The original voice connection has ended)');
                await this.eleven.start({ conversationToken: token.token, connectionType: 'webrtc',
                    dynamicVariables: { sessionId: context.sessionId, initialConversationContext: capElevenLabsInitialContext(context.plan.bootstrap) },
                    overrides: buildElevenLabsSessionOverridesFromPrefs(settings.personality, { ...(language ? { language } : {}), ...(settings.voice ? { voiceId: settings.voice } : {}) }),
                    clientTools: { messageCodingAgent: (args: unknown) => tool('messageCodingAgent', args), processPermissionRequest: (args: unknown) => tool('processPermissionRequest', args) },
                    onModeChange: ({ mode }: { mode: 'listening' | 'speaking' }) => { if (this.current(run)) this.update({ mode }); },
                    onMessage: ({ message, role }: { message: string; role: string }) => { if (this.current(run) && role === 'agent') this.update({ caption: message.slice(0, 4096) }); },
                    onError: (message: string) => { if (this.current(run)) void this.finish(run, new Error(message)).catch(() => {}); },
                    onDisconnect: (details: { reason: string; message?: string }) => {
                        if (this.current(run)) void this.finish(run, details.reason === 'error' ? new Error(details.message ?? 'Voice connection ended') : undefined).catch(() => {});
                    },
                });
                this.require(run);
            } else await this.connectProxy(run, settings.backend);
            this.require(run); this.update({ status: 'connected' });
            for (const chunk of [...context.plan.streamChunks, context.plan.bootstrap]) { this.require(run); this.context(run, chunk); await voiceDelay(40, abort.signal); }
            run.tools.advertise(context);
            for (const approval of context.approvals) this.text(run, approval.context);
            if (settings.proactive) this.text(run, 'Based on the session context, give a brief spoken summary of the coding agent’s work, then wait for the user.');
            else if (settings.backend !== 'elevenlabs') this.text(run, '[Greet the user briefly and invite them to speak. Do not mention the model or provider name.]');
            void this.observe(run).catch(error => { if (this.current(run)) void this.finish(run, error); });
        } catch (error) { if (this.run === run) await this.finish(run, abort.signal.aborted ? undefined : error); }
    }
    stop(): Promise<void> { return this.run ? this.finish(this.run) : Promise.resolve(); }
    private finish(run: Run, error?: unknown): Promise<void> {
        if (run.closing) return run.closing;
        run.abort.abort(); run.tools.dispose(); run.recorder?.stop(); run.player?.dispose();
        if (run.socket && run.socket.readyState < WebSocket.CLOSING) run.socket.close(1000, 'Voice ended');
        this.update({ status: 'stopping', ...(error ? { error: voiceError(error) } : {}) });
        const pending = Promise.all([
            run.eleven ? Promise.resolve().then(() => this.eleven.end()) : Promise.resolve(),
            run.playback && run.playback.state !== 'closed' ? Promise.resolve().then(() => run.playback!.state !== 'closed' ? run.playback!.close() : undefined) : Promise.resolve(),
        ]).then(() => {
            if (this.run === run) { this.run = null; this.update({ status: error ? 'error' : 'idle', mode: 'listening', receipts: run.tools.receipts() }); this.onSettled(); }
        }, failure => {
            // Keep ownership on an unconfirmed audio cleanup; an explicit stop
            // can retry closing the same connection, never start another one.
            delete run.closing; this.update({ status: 'error', error: `Voice cleanup could not be confirmed: ${voiceError(failure)}` }); throw failure;
        });
        run.closing = pending; return pending;
    }
    setMuted(muted: boolean): void { this.update({ muted }); this.run?.recorder?.setMuted(muted || this.run.speaking); }
    providerMode(mode: 'speaking' | 'listening'): void { if (this.run?.eleven && this.current(this.run)) this.update({ mode }); }
    providerCaption(text: string): void { if (this.run?.eleven && this.current(this.run)) this.update({ caption: text.slice(0, 4096) }); }
    providerEnded(error?: unknown): void { const run = this.run; if (run?.eleven && this.current(run) && !run.closing) void this.finish(run, error).catch(() => {}); }
    tool(name: string, args: unknown, id: string = randomId()): Promise<string> {
        const run = this.run; if (!run || !this.current(run)) return Promise.resolve('error (The voice session has ended)');
        return run.tools.call({ id, name, args });
    }
    private send(run: Run, value: unknown): void {
        this.require(run); const socket = run.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('The voice connection is no longer open');
        if (socket.bufferedAmount > 2 * 1024 * 1024) throw new Error('Voice upload is too slow; the connection was stopped');
        const text = JSON.stringify(value); if (text.length > 1_500_000) throw new Error('Voice frame exceeded its limit'); socket.send(text);
    }
    private event(run: Run, type: string, data: Record<string, unknown> = {}): void { this.send(run, { event_id: `hapi-voice-${++run.eventId}`, type, ...data }); }
    private text(run: Run, text: string): void {
        if (run.settings.backend === 'elevenlabs') { this.require(run); this.eleven.text(truncateUtf8ByteLength(text, 8000)); return; }
        if (run.settings.backend === 'gemini-live') this.send(run, { clientContent: { turns: [{ role: 'user', parts: [{ text: truncateUtf8ByteLength(text, 8000) }] }], turnComplete: true } });
        else { this.event(run, 'conversation.item.create', { item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: truncateUtf8ByteLength(text, 8000) }] } }); this.event(run, 'response.create'); }
    }
    private context(run: Run, text: string): void {
        if (run.settings.backend === 'elevenlabs') { this.require(run); this.eleven.context(truncateUtf8ByteLength(text, 8000)); return; }
        if (run.settings.backend === 'gemini-live') this.send(run, { clientContent: { turns: [{ role: 'user', parts: [{ text: `[System Context Update] ${truncateUtf8ByteLength(text, 8000)}` }] }], turnComplete: false } });
        else {
            run.updates.push(`[System Context Update] ${truncateUtf8ByteLength(text, 8000)}`);
            if (run.updates.length > 64) { run.updates.shift(); this.update({ notice: 'Voice keeps the latest 64 bounded source updates; earlier updates were removed from its current instructions.' }); }
            this.event(run, 'session.update', { session: { instructions: `${run.instructions}\n\n${run.updates.join('\n\n')}` } });
        }
    }
    private async observe(run: Run): Promise<void> {
        while (this.current(run)) {
            await voiceDelay(2000, run.abort.signal); this.require(run);
            const current = await run.owner.readContext(run.abort.signal); this.require(run); const previous = run.context!;
            if (current.sessionId !== previous.sessionId || current.epoch !== previous.epoch) throw new Error('The original conversation history changed identity; start a fresh voice connection after reviewing it');
            const known = new Map(previous.messages.map(row => [row.id, row.text]));
            for (const row of current.messages) if (row.text && known.get(row.id) !== row.text) this.context(run, `New message in session ${current.sessionId}:\n${row.text}`);
            const approvals = new Set(previous.approvals.map(row => row.id));
            for (const approval of current.approvals) if (!approvals.has(approval.id)) this.text(run, approval.context);
            if (previous.thinking && !current.thinking) {
                const notice = `The coding agent finished its current turn in session ${current.sessionId}. Use the latest messages to describe the observed result; do not claim an unfinished task is complete.`;
                if (run.settings.proactive) this.text(run, notice); else this.context(run, notice);
            }
            if (current.active !== previous.active) this.context(run, `The original coding session is now ${current.active ? 'online' : 'offline'}.`);
            run.context = current; run.tools.advertise(current); run.tools.reconcile();
        }
    }
    private connectProxy(run: Run, backend: 'gemini-live' | 'qwen-realtime'): Promise<void> {
        run.instructions = resolveComposedVoiceSystemPrompt(run.settings.personality, { backend, ...(run.settings.language ? { language: run.settings.language } : {}) }).prompt;
        const socket = this.transport.open(backend); run.socket = socket;
        return new Promise<void>((resolve, reject) => {
            let ready = false; const timeout = setTimeout(() => reject(new Error('Voice provider setup timed out')), 25_000);
            const abort = () => { clearTimeout(timeout); reject(new Error('Voice setup cancelled')); };
            run.abort.signal.addEventListener('abort', abort, { once: true });
            const done = () => { clearTimeout(timeout); run.abort.signal.removeEventListener('abort', abort); resolve(); };
            socket.onopen = () => { try {
                this.send(run, { type: 'hapi.voice.connect', ...(run.settings.language ? { language: run.settings.language } : {}),
                    voice: backend === 'gemini-live' ? resolveGeminiLiveVoice(run.settings.voice) : resolveQwenRealtimeVoice(run.settings.voice),
                    systemPrompt: encodeVoiceSystemPromptForProxy(truncatePromptForProxy(run.instructions)),
                    ...(backend === 'gemini-live' ? { affectiveDialog: run.settings.personality.gemini.affective_dialog } : {}) });
            } catch (error) { reject(error); } };
            const fail = (error: unknown) => { if (!ready) reject(error); if (this.current(run)) void this.finish(run, error).catch(() => {}); };
            socket.onerror = () => fail(new Error('The original voice WebSocket connection failed'));
            socket.onclose = () => { clearTimeout(timeout); if (!ready) reject(new Error('Voice connection closed before setup completed')); if (this.current(run)) void this.finish(run).catch(() => {}); };
            socket.onmessage = event => {
                if (!this.current(run)) return;
                void (async () => {
                    const text = typeof event.data === 'string' ? event.data : event.data instanceof Blob ? await event.data.text() : '';
                    if (text.length > 2 * 1024 * 1024) throw new Error('Voice provider frame is too large');
                    const data: unknown = JSON.parse(text); if (!isObject(data)) return;
                    if (data.type === 'error' || isObject(data.error)) throw new Error(isObject(data.error) && typeof data.error.message === 'string' ? data.error.message : 'The original voice provider rejected the session');
                    if (!ready && (backend === 'gemini-live' && 'setupComplete' in data || backend === 'qwen-realtime' && data.type === 'session.updated')) {
                        ready = true; run.player = new GeminiAudioPlayer(run.playback); run.recorder = new PcmRecorder(); run.recorder.setMuted(this.state.muted);
                        await run.recorder.start(chunk => {
                            try { if (!this.current(run)) return; if (backend === 'gemini-live') this.send(run, { realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: chunk }] } });
                                else this.event(run, 'input_audio_buffer.append', { audio: chunk }); }
                            catch (error) { fail(error); }
                        }, fail, run.abort.signal);
                        this.require(run); done(); return;
                    }
                    if (backend === 'gemini-live') await this.gemini(run, data); else await this.qwen(run, data);
                })().catch(fail);
            };
        });
    }
    private async gemini(run: Run, data: Record<string, unknown>): Promise<void> {
        if (isObject(data.serverContent)) {
            const content = data.serverContent;
            if (isObject(content.modelTurn) && Array.isArray(content.modelTurn.parts)) {
                run.speaking = true; run.recorder?.setMuted(true); this.update({ mode: 'speaking' });
                for (const part of content.modelTurn.parts) if (isObject(part)) {
                    if (isObject(part.inlineData) && typeof part.inlineData.data === 'string') run.player?.enqueue(part.inlineData.data);
                    if (typeof part.text === 'string') this.update({ caption: part.text.slice(0, 4096) });
                }
            }
            if (content.interrupted === true) run.player?.clearQueue();
            if (content.turnComplete === true || content.interrupted === true) { run.speaking = false; run.recorder?.setMuted(this.state.muted); this.update({ mode: 'listening' }); }
        }
        if (isObject(data.toolCall) && Array.isArray(data.toolCall.functionCalls)) {
            const responses = [];
            for (const call of data.toolCall.functionCalls.slice(0, 32)) if (isObject(call) && typeof call.id === 'string' && typeof call.name === 'string') {
                const result = await run.tools.call({ id: call.id, name: call.name, args: call.args }); if (!this.current(run)) return;
                responses.push({ id: call.id, name: call.name, response: { result } });
            }
            if (responses.length) this.send(run, { toolResponse: { functionResponses: responses } });
        }
    }
    private async qwen(run: Run, data: Record<string, unknown>): Promise<void> {
        if (data.type === 'response.audio.delta' && typeof data.delta === 'string') { run.player?.enqueue(data.delta); this.update({ mode: 'speaking' }); }
        else if (data.type === 'response.audio_transcript.delta' && typeof data.delta === 'string') this.update({ caption: (this.state.caption + data.delta).slice(-4096) });
        else if (data.type === 'input_audio_buffer.speech_started') { run.player?.clearQueue(); this.update({ mode: 'listening', caption: '' }); }
        else if (data.type === 'response.done') this.update({ mode: 'listening' });
        else if (data.type === 'response.function_call_arguments.done' && typeof data.call_id === 'string' && typeof data.name === 'string') {
            let args: unknown = {}; if (typeof data.arguments === 'string') { try { args = JSON.parse(data.arguments); } catch { args = null; } }
            const result = await run.tools.call({ id: data.call_id, name: data.name, args }); if (!this.current(run)) return;
            this.event(run, 'conversation.item.create', { item: { type: 'function_call_output', call_id: data.call_id, output: result } }); this.event(run, 'response.create');
        }
    }
}
