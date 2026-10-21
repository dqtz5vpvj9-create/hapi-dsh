/**
 * Bind an ElevenLabs public RealtimeConnection to exactly one dictation.
 *
 * useScribe's shared hook reference is only used to create a connection. Its
 * old CLOSE callback may clear that reference after a successor starts, so all
 * audio, commits, events and cleanup below belong to the captured connection.
 */
import { RealtimeEvents, type RealtimeConnection } from '@elevenlabs/react';

export type ScribeConnection = Pick<RealtimeConnection, 'on' | 'off' | 'send' | 'commit' | 'close'>;
export interface ScribeObserver {
    onStarted(): void;
    onPartial(text: string): void;
    onFinal(text: string): void;
    onError(error: Error): void;
    onDisconnect(): void;
}

const transcript = (value: unknown): string => {
    if (typeof value !== 'object' || value === null || !('text' in value) || typeof value.text !== 'string') {
        throw new Error('ElevenLabs returned an invalid transcript');
    }
    if (value.text.length > 2 * 1024 * 1024) throw new Error('ElevenLabs transcript exceeds the safe text limit');
    return value.text;
};

export class OwnedScribeConnection {
    private closed = false;
    private readonly listeners: Array<{ event: RealtimeEvents; listener: (value: unknown) => void }> = [];

    constructor(readonly connection: ScribeConnection, observer: ScribeObserver) {
        const listen = (event: RealtimeEvents, listener: (value: unknown) => void) => {
            const owned = (value: unknown) => {
                if (this.closed) return;
                try { listener(value); } catch (error) { observer.onError(error instanceof Error ? error : new Error('ElevenLabs transcription failed')); }
            };
            connection.on(event, owned);
            this.listeners.push({ event, listener: owned });
        };
        listen(RealtimeEvents.SESSION_STARTED, () => observer.onStarted());
        listen(RealtimeEvents.PARTIAL_TRANSCRIPT, value => observer.onPartial(transcript(value)));
        listen(RealtimeEvents.COMMITTED_TRANSCRIPT, value => observer.onFinal(transcript(value)));
        // The SDK emits ERROR for all specific provider error types, including
        // auth/quota/terms/queue failures. Never wait for a timeout to hide them.
        listen(RealtimeEvents.ERROR, value => observer.onError(new Error(
            typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
                ? value.error.slice(0, 4096) : 'ElevenLabs transcription failed')));
        listen(RealtimeEvents.CLOSE, () => observer.onDisconnect());
    }

    sendAudio(audioBase64: string): void {
        if (this.closed) return;
        this.connection.send({ audioBase64, sampleRate: 16000 });
    }
    commit(): void {
        if (this.closed) throw new Error('This ElevenLabs dictation has ended');
        this.connection.commit();
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const { event, listener } of this.listeners) this.connection.off(event, listener);
        this.listeners.length = 0;
        this.connection.close();
    }
}
