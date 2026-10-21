/** Original HAPI dictation providers with instance-owned, cancellable microphone lifetimes. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioFormat, CommitStrategy, useScribe } from '@elevenlabs/react';
import { ELEVENLABS_REALTIME_TRANSCRIPTION_MODEL, type TranscriptionProvider } from '../../voice/protocol/voice.ts';
import { AudioRecording } from './audio/recording.ts';
import { PcmRecorder } from './audio/recorder.ts';
import { OwnedScribeConnection } from './scribe-connection.ts';
import { startBrowserLocalTranscription, startDeepgramRealtimeTranscription, startOpenAIRealtimeTranscription, type RealtimeTranscriptionSession } from './realtime-transcription.ts';
import type { SourceVoiceTransport } from './transport.ts';
import type { VoicePreferences } from './preferences.ts';

export type DictationStatus = 'idle' | 'connecting' | 'listening' | 'processing' | 'error';
type RetryRecording = { file: File; provider: string; language: string | undefined };
interface Run {
    abort: AbortController; provider: TranscriptionProvider; mode: 'standard' | 'realtime'; session?: RealtimeTranscriptionSession;
    recording?: AudioRecording; pcm?: PcmRecorder; scribe?: OwnedScribeConnection; partial: string; stopping: boolean;
    resolveStarted?: () => void; rejectStarted?: (error: unknown) => void; resolveCommitted?: () => void;
}
const message = (error: unknown): string => error instanceof Error ? error.message : 'Voice transcription failed';

export function supportsDictation(preferences: VoicePreferences): boolean {
    if (!preferences.provider) return false;
    if (preferences.provider === 'browser-local') return true;
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return false;
    if (preferences.transcriptionMode === 'standard' || preferences.provider === 'deepgram') return typeof MediaRecorder !== 'undefined';
    if (preferences.provider === 'openai') return typeof RTCPeerConnection !== 'undefined';
    return preferences.provider === 'elevenlabs' && typeof AudioContext !== 'undefined';
}
export function useSourceDictation(transport: SourceVoiceTransport, onFinal: (text: string) => void, onSettled: () => void) {
    const [status, setStatus] = useState<DictationStatus>('idle'), [error, setError] = useState<string | null>(null), [partial, setPartial] = useState('');
    const [retryRecording, setRetryRecording] = useState<RetryRecording | null>(null);
    const active = useRef<Run | null>(null), mounted = useRef(true), callbacks = useRef({ onFinal, onSettled }); callbacks.current = { onFinal, onSettled };
    const disconnect = useRef<() => void>(() => {});
    const cleanup = useCallback((run: Run) => {
        run.abort.abort(); run.session?.cancel(); run.recording?.cancel(); run.pcm?.stop();
        run.scribe?.close();
        if (run.provider === 'elevenlabs' && run.mode === 'realtime') disconnect.current();
        run.rejectStarted?.(new Error('Dictation was cancelled')); run.resolveCommitted?.();
    }, []);
    const finish = useCallback((run: Run, text: string) => {
        if (active.current !== run) return; active.current = null; cleanup(run);
        if (mounted.current) { setPartial(''); setStatus('idle'); setRetryRecording(null); callbacks.current.onFinal(text.trim()); }
        callbacks.current.onSettled();
    }, [cleanup]);
    const fail = useCallback((run: Run, reason: unknown) => {
        if (active.current !== run) return; active.current = null; cleanup(run);
        if (mounted.current) { setStatus('error'); setError(message(reason)); }
        callbacks.current.onSettled();
    }, [cleanup]);
    const scribe = useScribe({ modelId: ELEVENLABS_REALTIME_TRANSCRIPTION_MODEL, commitStrategy: CommitStrategy.MANUAL, autoConnect: false });
    const scribeRef = useRef(scribe); scribeRef.current = scribe; disconnect.current = () => scribeRef.current.disconnect();
    const cancel = useCallback(() => {
        const run = active.current; active.current = null; if (run) cleanup(run);
        if (mounted.current) { setStatus('idle'); setPartial(''); setRetryRecording(null); }
        callbacks.current.onSettled();
    }, [cleanup]);
    const start = useCallback(async (preferences: VoicePreferences): Promise<void> => {
        if (active.current) throw new Error('A dictation is already active');
        if (!preferences.provider || !supportsDictation(preferences)) throw new Error('The selected dictation provider is not supported by this browser');
        const run: Run = { abort: new AbortController(), provider: preferences.provider, mode: preferences.transcriptionMode, partial: '', stopping: false };
        active.current = run; setStatus('connecting'); setPartial(''); setError(null); setRetryRecording(null);
        const signal = run.abort.signal, isCurrent = () => active.current === run && !signal.aborted;
        const update = (text: string) => { if (!isCurrent()) return; run.partial = text.slice(0, 2 * 1024 * 1024); setPartial(run.partial); };
        try {
            if (run.mode === 'standard') {
                run.recording = new AudioRecording(reason => fail(run, reason)); await run.recording.start(signal);
                if (!isCurrent()) return; setStatus('listening'); return;
            }
            const observer = { onConnected: () => { if (isCurrent()) setStatus('listening'); }, onPartial: update,
                onFinal: (text: string) => finish(run, text), onError: (reason: Error) => fail(run, reason) };
            if (run.provider === 'elevenlabs') {
                const token = await transport.token('elevenlabs', preferences.language, signal); if (!isCurrent()) return;
                const ready = new Promise<void>((resolve, reject) => { run.resolveStarted = resolve; run.rejectStarted = reject; }); void ready.catch(() => {});
                const timeout = setTimeout(() => run.rejectStarted?.(new Error('ElevenLabs transcription connection timed out')), 15_000);
                try {
                    // The SDK does not own getUserMedia: our cancellable PCM owner
                    // closes a late permission grant even after pane disposal.
                    await scribeRef.current.connect({ token, modelId: ELEVENLABS_REALTIME_TRANSCRIPTION_MODEL, commitStrategy: CommitStrategy.MANUAL,
                        audioFormat: AudioFormat.PCM_16000, sampleRate: 16000, ...(preferences.language ? { languageCode: preferences.language.split('-')[0]! } : {}) });
                    if (!isCurrent()) return;
                    const connection = scribeRef.current.getConnection();
                    if (!connection) throw new Error('ElevenLabs did not create a transcription connection');
                    run.scribe = new OwnedScribeConnection(connection, {
                        onStarted: () => { if (isCurrent()) run.resolveStarted?.(); },
                        onPartial: update,
                        onFinal: text => finish(run, text),
                        onError: reason => fail(run, reason),
                        onDisconnect: () => { if (isCurrent() && !run.stopping) fail(run, new Error('ElevenLabs transcription disconnected; the partial transcript is retained for review')); },
                    });
                    await ready;
                } finally { clearTimeout(timeout); delete run.resolveStarted; delete run.rejectStarted; }
                if (!isCurrent()) return;
                run.pcm = new PcmRecorder(); await run.pcm.start(chunk => { if (isCurrent()) run.scribe?.sendAudio(chunk); }, reason => fail(run, reason), signal);
                if (isCurrent()) setStatus('listening'); return;
            }
            const getToken = () => transport.token(run.provider as 'openai' | 'deepgram', preferences.language, signal);
            const options = { signal, callbacks: observer, ...(preferences.language ? { language: preferences.language } : {}) };
            const session = run.provider === 'openai' ? await startOpenAIRealtimeTranscription({ ...options, getToken })
                : run.provider === 'deepgram' ? await startDeepgramRealtimeTranscription({ ...options, getToken }) : await startBrowserLocalTranscription(options);
            if (isCurrent()) run.session = session; else session.cancel();
        } catch (reason) { if (isCurrent()) fail(run, reason); }
    }, [fail, finish, transport]);
    const stop = useCallback(async (): Promise<void> => {
        const run = active.current; if (!run || run.stopping) return;
        run.stopping = true; setStatus('processing');
        try {
            if (run.recording) {
                const file = await run.recording.finish(); if (active.current !== run) return;
                // Remember only the in-memory audio for an explicit user retry.
                const recording: RetryRecording = { file, provider: run.provider, language: languageForRun.current };
                setRetryRecording(recording);
                const text = await transport.transcribe(file, run.provider, recording.language, run.abort.signal); finish(run, text);
            } else if (run.provider === 'elevenlabs') {
                run.pcm?.stop();
                if (!run.pcm) { cancel(); return; }
                const commit = new Promise<void>(resolve => { run.resolveCommitted = resolve; }); run.scribe?.commit();
                let timeout: ReturnType<typeof setTimeout> | undefined;
                try { await Promise.race([commit, new Promise<void>(resolve => { timeout = setTimeout(resolve, 2500); })]); }
                finally { if (timeout) clearTimeout(timeout); }
                if (active.current === run) finish(run, run.partial);
            } else if (run.session) await run.session.stop();
            else cancel();
        } catch (reason) { fail(run, reason); }
    }, [cancel, fail, finish, transport]);
    const languageForRun = useRef<string | undefined>(undefined);
    const begin = useCallback(async (preferences: VoicePreferences) => { languageForRun.current = preferences.language; await start(preferences); }, [start]);
    const retry = useCallback(async () => {
        if (!retryRecording || active.current) return;
        const run: Run = { abort: new AbortController(), provider: retryRecording.provider as TranscriptionProvider, mode: 'standard', partial: '', stopping: true };
        active.current = run; setStatus('processing'); setError(null);
        try { finish(run, await transport.transcribe(retryRecording.file, retryRecording.provider, retryRecording.language, run.abort.signal)); }
        catch (reason) { fail(run, reason); }
    }, [retryRecording, fail, finish, transport]);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; const run = active.current; active.current = null; if (run) cleanup(run); callbacks.current.onSettled(); }; }, [cleanup]);
    return { status, error, partial, retryAvailable: retryRecording !== null, start: begin, stop, cancel, retry };
}
