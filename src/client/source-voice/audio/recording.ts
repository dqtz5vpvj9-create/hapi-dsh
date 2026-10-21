/** Standard-recording lifecycle adapted from HAPI 0f8ef697 hooks/useDictation.ts (AGPL-3.0-only). */
import { MAX_VOICE_AUDIO_BYTES } from '../../../voice-types.ts';

export function recordingMimeType(): string | undefined {
    if (typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
    return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(value => MediaRecorder.isTypeSupported(value));
}
export class AudioRecording {
    private generation = 0;
    private stream: MediaStream | undefined;
    private recorder: MediaRecorder | undefined;
    private chunks: Blob[] = [];
    private bytes = 0;
    private pending: { resolve(file: File): void; reject(error: unknown): void } | undefined;
    constructor(private readonly onError: (error: Error) => void) {}
    async start(signal?: AbortSignal): Promise<void> {
        this.cancel(); const generation = ++this.generation; signal?.throwIfAborted();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (generation !== this.generation || signal?.aborted) { stream.getTracks().forEach(track => track.stop()); throw signal?.reason ?? new Error('Recording cancelled'); }
        this.stream = stream;
        try {
            const mimeType = recordingMimeType(); const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); this.recorder = recorder;
            const fail = (error: Error) => { if (generation !== this.generation) return; this.pending?.reject(error); this.pending = undefined; this.cancel(); this.onError(error); };
            recorder.ondataavailable = event => {
                if (generation !== this.generation || !event.data.size) return;
                if (this.bytes + event.data.size > MAX_VOICE_AUDIO_BYTES) { fail(new Error('Recording reached the 25 MiB source upload limit')); return; }
                this.bytes += event.data.size; this.chunks.push(event.data);
            };
            recorder.onerror = () => fail(new Error('Audio recording failed'));
            recorder.onstop = () => {
                if (generation !== this.generation) return;
                this.stopTracks(); this.recorder = undefined; const type = recorder.mimeType || mimeType || 'audio/webm';
                const file = new File(this.chunks, `speech.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type });
                this.chunks = []; this.bytes = 0; const pending = this.pending; this.pending = undefined;
                if (!pending) { this.onError(new Error('The browser stopped recording before submission')); return; }
                if (file.size) pending.resolve(file); else pending.reject(new Error('No audio was recorded'));
            };
            stream.getTracks().forEach(track => { track.onended = () => fail(new Error('Microphone disconnected')); });
            recorder.start(250);
        } catch (error) { this.cancel(); throw error; }
    }
    finish(): Promise<File> {
        if (!this.recorder || this.recorder.state === 'inactive' || this.pending) return Promise.reject(new Error('No active recording'));
        return new Promise<File>((resolve, reject) => { this.pending = { resolve, reject }; this.recorder!.stop(); this.stopTracks(); });
    }
    private stopTracks(): void { this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = undefined; }
    cancel(): void {
        this.generation++; this.stopTracks(); this.pending?.reject(new Error('Recording cancelled')); this.pending = undefined;
        const recorder = this.recorder; this.recorder = undefined;
        if (recorder) { recorder.onstop = null; recorder.ondataavailable = null; recorder.onerror = null; if (recorder.state !== 'inactive') recorder.stop(); }
        this.chunks = []; this.bytes = 0;
    }
}
