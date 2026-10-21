/** Audio objects are explicit lifecycle fixtures; no speech quality or real provider is claimed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioRecording } from '../src/client/source-voice/audio/recording.ts';
import { PcmRecorder } from '../src/client/source-voice/audio/recorder.ts';
import { VoiceAssistant } from '../src/client/source-voice/assistant.ts';
import { SourceVoiceTransport } from '../src/client/source-voice/transport.ts';
import { DEFAULT_VOICE_PERSONALITY } from '../src/voice/protocol/voicePersonality.ts';
import type { SourceVoiceApi } from '../src/voice-types.ts';
import type { VoicePreferences } from '../src/client/source-voice/preferences.ts';
import type { VoiceContext } from '../src/client/source-voice/context.ts';
import type { VoiceToolOwner } from '../src/client/source-voice/tools.ts';
import { startBrowserLocalTranscription, startDeepgramRealtimeTranscription, startOpenAIRealtimeTranscription } from '../src/client/source-voice/realtime-transcription.ts';
import { hasBrowserLocalSpeechSupport } from '../src/client/source-voice/browser-local.ts';
import { OwnedScribeConnection, type ScribeConnection } from '../src/client/source-voice/scribe-connection.ts';

function replace(name: string, value: unknown): () => void { const previous = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { configurable: true, value });
    return () => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); }; }
function permission() {
    let release!: (stream: MediaStream) => void, stops = 0;
    const promise = new Promise<MediaStream>(resolve => { release = resolve; });
    const track = { stop() { stops++; }, onended: null, enabled: true }, stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    return { promise, release: () => release(stream), stops: () => stops, stream };
}

test('cancelled standard capture closes a delayed microphone grant and never constructs a recorder', async () => {
    const media = permission(), restore = replace('navigator', { mediaDevices: { getUserMedia: () => media.promise } });
    try { const recorder = new AudioRecording(() => assert.fail('A cancelled capture cannot report a fresh result'));
        const start = recorder.start(), rejected = assert.rejects(start, /cancelled/); recorder.cancel(); media.release(); await rejected; assert.equal(media.stops(), 1);
    } finally { restore(); }
});

test('cancelled PCM capture closes a delayed microphone grant before creating an AudioContext', async () => {
    const media = permission(), restore = replace('navigator', { mediaDevices: { getUserMedia: () => media.promise } });
    try { const recorder = new PcmRecorder(), start = recorder.start(() => assert.fail('No late microphone frames'), () => assert.fail('No late error'));
        const rejected = assert.rejects(start, /cancelled/); recorder.stop(); media.release(); await rejected; assert.equal(media.stops(), 1);
    } finally { restore(); }
});

test('standard recording retains real final chunk bytes and stops tracks before returning the upload file', async () => {
    const media = permission(), restoreNavigator = replace('navigator', { mediaDevices: { getUserMedia: async () => media.stream } });
    class Recorder {
        static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus'; }
        state = 'inactive'; mimeType = 'audio/webm'; ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null; onerror: (() => void) | null = null;
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array([2, 4, 6, 8])]) }); this.onstop?.(); }); }
    }
    const restoreRecorder = replace('MediaRecorder', Recorder);
    try { const recording = new AudioRecording(error => { throw error; }); await recording.start(); const pending = recording.finish();
        assert.equal(media.stops(), 1); const file = await pending; assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [2, 4, 6, 8]); assert.equal(file.type, 'audio/webm'); assert.equal(file.name, 'speech.webm');
    } finally { restoreRecorder(); restoreNavigator(); }
});

test('Deepgram token cancellation stops already-granted capture immediately and cannot create a late socket', async () => {
    const media = permission(), restore = replace('navigator', { mediaDevices: { getUserMedia: async () => media.stream } });
    let release!: (token: string) => void; const token = new Promise<string>(resolve => { release = resolve; }); const abort = new AbortController();
    try { const start = startDeepgramRealtimeTranscription({ getToken: () => token, signal: abort.signal,
        callbacks: { onConnected: () => assert.fail('Cannot connect a cancelled stream'), onPartial() {}, onFinal() {}, onError() {} } });
        const rejected = assert.rejects(start, /cancel token request/); await new Promise<void>(resolve => setImmediate(resolve));
        abort.abort(new Error('cancel token request')); assert.equal(media.stops(), 1); release('unused-fixture-token'); await rejected;
    } finally { restore(); }
});

test('OpenAI offer cancellation stops capture before a stalled public WebRTC setup finishes', async () => {
    const media = permission(), restoreNavigator = replace('navigator', { mediaDevices: { getUserMedia: async () => media.stream } });
    let release!: (offer: RTCSessionDescriptionInit) => void; const offer = new Promise<RTCSessionDescriptionInit>(resolve => { release = resolve; });
    let channelsClosed = 0, peersClosed = 0, tokenCalls = 0;
    class Peer extends EventTarget {
        createDataChannel() { return Object.assign(new EventTarget(), { close() { channelsClosed++; } }); }
        addTrack() {} createOffer() { return offer; } async setLocalDescription() {} close() { peersClosed++; }
    }
    const restorePeer = replace('RTCPeerConnection', Peer), abort = new AbortController();
    try { const start = startOpenAIRealtimeTranscription({ signal: abort.signal, getToken: async () => { tokenCalls++; return 'unused'; },
        callbacks: { onConnected: () => assert.fail('No connection after cancel'), onPartial() {}, onFinal() {}, onError() {} } });
        const rejected = assert.rejects(start, /cancel stalled offer/); await new Promise<void>(resolve => setImmediate(resolve));
        abort.abort(new Error('cancel stalled offer')); assert.equal(media.stops(), 1); assert.equal(channelsClosed, 1); assert.equal(peersClosed, 1);
        release({ type: 'offer', sdp: 'fixture' }); await rejected; assert.equal(tokenCalls, 0);
    } finally { restorePeer(); restoreNavigator(); }
});

test('browser-local recognition probes only on user start, requires desktop, and never uses a cloud fallback', async () => {
    let probes = 0, instances = 0, aborted = 0, active!: Local;
    class Local extends EventTarget {
        static available(options: { langs: string[]; processLocally: boolean }) { probes++; assert.equal(options.processLocally, true); assert.deepEqual(options.langs, ['en-US']); return 'available'; }
        continuous = false; interimResults = false; lang = ''; processLocally = false;
        onresult: ((event: unknown) => void) | null = null; onerror: ((event: { error: string }) => void) | null = null; onend: (() => void) | null = null;
        constructor() { super(); instances++; active = this; }
        start() { assert.equal(this.processLocally, true); }
        stop() { this.onend?.(); } abort() { aborted++; }
    }
    Object.defineProperty(Local.prototype, 'processLocally', { configurable: true, writable: true, value: false });
    const navigator = { language: 'en-US', userAgentData: { mobile: false, platform: 'Linux' } };
    const restoreNavigator = replace('navigator', navigator), restoreRecognition = replace('SpeechRecognition', Local);
    const partials: string[] = [], finals: string[] = [], errors: Error[] = [];
    const callbacks = { onConnected() {}, onPartial: (text: string) => partials.push(text), onFinal: (text: string) => finals.push(text), onError: (error: Error) => errors.push(error) };
    try {
        assert.equal(hasBrowserLocalSpeechSupport(), true); assert.equal(probes, 0); assert.equal(instances, 0);
        navigator.userAgentData.mobile = true; assert.equal(hasBrowserLocalSpeechSupport(), false); assert.equal(probes, 0); navigator.userAgentData.mobile = false;
        const session = await startBrowserLocalTranscription({ callbacks }); assert.equal(probes, 1); assert.equal(instances, 1);
        active.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'Local words' } }, { isFinal: false, 0: { transcript: 'only' } }] });
        assert.deepEqual(partials, ['Local words only']); await session.stop(); assert.deepEqual(finals, ['Local words only']); assert.equal(aborted, 1);
        const failed = await startBrowserLocalTranscription({ callbacks }); active.onerror?.({ error: 'language-not-supported' });
        assert.equal(aborted, 2); assert.equal(active.onresult, null); assert.equal(active.onend, null); assert.match(errors[0]!.message, /language-not-supported/); failed.cancel(); assert.equal(aborted, 2);
        const cancel = new AbortController(), pending = startBrowserLocalTranscription({ callbacks, signal: cancel.signal }); const rejection = assert.rejects(pending);
        cancel.abort(); await rejection; assert.equal(probes, 2); assert.equal(instances, 2);
    } finally { restoreRecognition(); restoreNavigator(); }
});

const voiceContext: VoiceContext = { sessionId: 'captured-source', title: 'Source', active: true, thinking: false, agentLabel: 'Codex', epoch: 1, hasEarlier: false, messages: [], approvals: [],
    plan: { bootstrap: 'Original context', streamChunks: [], truncated: false, totalMessages: 0, messagesInBootstrap: 0, messagesStreamed: 0, notice: null } };
const prefs: VoicePreferences = { mode: 'assistant', provider: null, transcriptionMode: 'standard', backend: 'elevenlabs', language: undefined, voice: undefined, proactive: false, personality: structuredClone(DEFAULT_VOICE_PERSONALITY) };

test('closing a pending SDK connection holds ownership until public endSession settles; old callbacks cannot control the next run', async () => {
    let finishStart!: () => void, finishEnd!: () => void, ended = 0, settled = 0, sends = 0;
    const startGate = new Promise<void>(resolve => { finishStart = resolve; }), endGate = new Promise<void>(resolve => { finishEnd = resolve; });
    const starts: Record<string, unknown>[] = [];
    const api = { sourceVoiceToken: async () => ({ ok: true, value: { allowed: true, backend: 'elevenlabs', token: 'fixture-ephemeral-token' } }) } as unknown as SourceVoiceApi;
    const transport = new SourceVoiceTransport(api, 'http://voice.fixture/');
    const owner: VoiceToolOwner = { current() {}, readContext: async () => voiceContext, submit: async (_text, _signal, id) => { sends++; id(`durable-${sends}`); }, answer: async () => {}, inspect: () => 'unknown' };
    const assistant = new VoiceAssistant(transport, owner, { start: async options => { starts.push(options); if (starts.length === 1) await startGate; },
        end: async () => { ended++; if (ended === 1) await endGate; }, text() {}, context() {} }, () => { settled++; });
    const starting = assistant.start(prefs); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(starts.length, 1);
    const stopping = assistant.stop(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, 0); assert.equal(assistant.getSnapshot().status, 'stopping');
    await assert.rejects(assistant.start(prefs), /End the current voice/); finishStart(); finishEnd(); await Promise.all([starting, stopping]); assert.equal(settled, 1);
    await assistant.start(prefs); const old = starts[0]!.clientTools as Record<string, (args: unknown) => Promise<string>>;
    assert.match(await old.messageCodingAgent!({ message: 'Late command' }), /original voice connection has ended/); assert.equal(sends, 0);
    const tools = starts[1]!.clientTools as Record<string, (args: unknown) => Promise<string>>;
    await tools.messageCodingAgent!({ message: 'Repeat this' }); await tools.messageCodingAgent!({ message: 'Repeat this' }); assert.equal(sends, 2);
    (starts[0]!.onDisconnect as (input: { reason: string }) => void)({ reason: 'agent' }); assert.equal(assistant.getSnapshot().status, 'connected');
    await assistant.stop(); assert.equal(settled, 2);
});

test('Scribe events and audio remain owned by the captured public connection after a previous connection closes late', () => {
    function connection() {
        const listeners = new Map<string, Set<(value: unknown) => void>>(), sent: unknown[] = [];
        let closes = 0, commits = 0;
        const surface = { on(event: string, listener: (value: unknown) => void) { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); },
            off(event: string, listener: (value: unknown) => void) { listeners.get(event)?.delete(listener); },
            send(value: unknown) { sent.push(value); }, commit() { commits++; }, close() { closes++; } } as unknown as ScribeConnection;
        return { surface, sent, listeners, closes: () => closes, commits: () => commits,
            emit(event: string, value: unknown) { for (const listener of listeners.get(event) ?? []) listener(value); } };
    }
    const old = connection(), next = connection(), received: string[] = [], errors: string[] = [];
    const observer = (id: string) => ({ onStarted() { received.push(`${id}:started`); }, onPartial(text: string) { received.push(`${id}:${text}`); },
        onFinal(text: string) { received.push(`${id}:final:${text}`); }, onError(error: Error) { errors.push(`${id}:${error.message}`); }, onDisconnect() { received.push(`${id}:closed`); } });
    const first = new OwnedScribeConnection(old.surface, observer('old'));
    const latePartial = [...old.listeners.get('partial_transcript')!][0]!, lateClose = [...old.listeners.get('close')!][0]!;
    first.close(); const second = new OwnedScribeConnection(next.surface, observer('next'));
    latePartial({ text: 'Late transcript' }); lateClose({}); old.emit('committed_transcript', { text: 'Another late transcript' });
    first.sendAudio('old-pcm'); assert.throws(() => first.commit(), /has ended/);
    next.emit('session_started', {}); second.sendAudio('new-pcm'); second.commit(); next.emit('partial_transcript', { text: 'Current words' });
    next.emit('error', { error: 'Quota exhausted' }); next.emit('partial_transcript', { text: 'x'.repeat(2 * 1024 * 1024 + 1) });
    assert.deepEqual(received, ['next:started', 'next:Current words']); assert.deepEqual(old.sent, []);
    assert.deepEqual(next.sent, [{ audioBase64: 'new-pcm', sampleRate: 16000 }]); assert.equal(next.commits(), 1);
    assert.equal(errors[0], 'next:Quota exhausted'); assert.match(errors[1]!, /safe text limit/);
    first.close(); assert.equal(old.closes(), 1); assert.equal(next.closes(), 0); second.close(); assert.equal(next.closes(), 1);
    assert.equal([...next.listeners.values()].reduce((total, listeners) => total + listeners.size, 0), 0);
});

test('voice start captures the hydrated source owner while an active connection cannot drift to a later React owner', async () => {
    const sent: string[] = [], starts: Record<string, unknown>[] = [], read: string[] = [];
    function owner(id: string): VoiceToolOwner {
        return { current() {}, readContext: async () => { read.push(id); return { ...voiceContext, sessionId: id, title: id }; },
            submit: async (text, _signal, identify) => { identify(`${id}-request`); sent.push(`${id}:${text}`); }, answer: async () => {}, inspect: () => 'unknown' };
    }
    let latest: VoiceToolOwner = { ...owner('not-hydrated'), readContext: async () => { assert.fail('The pre-hydration closure must not own a later explicit start'); } };
    const api = { sourceVoiceToken: async () => ({ ok: true, value: { allowed: true, backend: 'elevenlabs', token: 'fixture-ephemeral-token' } }) } as unknown as SourceVoiceApi;
    const assistant = new VoiceAssistant(new SourceVoiceTransport(api, 'http://voice.fixture/'), () => latest,
        { start: async options => { starts.push(options); }, end: async () => {}, text() {}, context() {} }, () => {});
    try {
        latest = owner('hydrated-alpha'); await assistant.start(prefs); assert.equal(assistant.getSnapshot().status, 'connected');
        assert.deepEqual(read, ['hydrated-alpha']);
        latest = owner('later-beta');
        await assistant.tool('messageCodingAgent', { message: 'Keep this original source' }, 'alpha-tool');
        assert.deepEqual(sent, ['hydrated-alpha:Keep this original source']);
        await assistant.stop(); await assistant.start(prefs);
        await assistant.tool('messageCodingAgent', { message: 'New explicit connection' }, 'beta-tool');
        assert.deepEqual(sent, ['hydrated-alpha:Keep this original source', 'later-beta:New explicit connection']);
        const stale = starts[0]!.clientTools as Record<string, (args: unknown) => Promise<string>>;
        assert.match(await stale.messageCodingAgent!({ message: 'Old connection' }), /original voice connection has ended/);
        assert.equal(sent.length, 2);
    } finally { await assistant.stop(); }
});
