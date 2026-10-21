/** Adapted from HAPI 0f8ef697 web/src/realtime/gemini/audioRecorder.ts (AGPL-3.0-only). */
import { float32ToPcm16, arrayBufferToBase64 } from './pcm.ts';

const WORKLET = `class PcmRecorderProcessor extends AudioWorkletProcessor {
 constructor(){super();this.buffer=new Float32Array(4096);this.index=0;}
 process(inputs){const channel=inputs[0]?.[0];if(channel)for(let i=0;i<channel.length;i++){
  this.buffer[this.index++]=channel[i];if(this.index===4096){this.port.postMessage({samples:this.buffer.slice()});this.index=0;}
 }return true;}}
registerProcessor('hapi-voice-pcm-recorder',PcmRecorderProcessor);`;

/** A pending permission/worklet request cannot revive a stopped microphone. */
export class PcmRecorder {
    private generation = 0;
    private stream: MediaStream | undefined;
    private context: AudioContext | undefined;
    private source: MediaStreamAudioSourceNode | undefined;
    private processor: AudioWorkletNode | ScriptProcessorNode | undefined;
    private sink: GainNode | undefined;
    private muted = false;
    async start(onChunk: (chunk: string) => void, onError: (error: Error) => void, signal?: AbortSignal): Promise<void> {
        this.stop(); const generation = ++this.generation;
        const check = () => { signal?.throwIfAborted(); if (generation !== this.generation) throw new Error('Microphone start cancelled'); };
        try {
            check(); const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
            try { check(); } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
            this.stream = stream;
            stream.getTracks().forEach(track => { track.enabled = !this.muted; track.onended = () => { if (generation === this.generation) { this.stop(); onError(new Error('Microphone disconnected')); } }; });
            const context = new AudioContext({ sampleRate: 16000 }); this.context = context;
            if (context.state === 'suspended') await context.resume(); check();
            if (context.sampleRate !== 16000) throw new Error('This browser cannot capture the required 16 kHz voice stream');
            const source = context.createMediaStreamSource(stream); this.source = source;
            const send = (samples: Float32Array) => {
                if (generation !== this.generation || signal?.aborted || this.muted) return;
                try { onChunk(arrayBufferToBase64(float32ToPcm16(samples))); }
                catch (error) { this.stop(); onError(error instanceof Error ? error : new Error('Microphone delivery failed')); }
            };
            let workletReady = false;
            if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
                const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
                try { await context.audioWorklet.addModule(url); check(); workletReady = true; }
                catch (error) { check(); /* The original HAPI fallback supports browsers without AudioWorklet. */ }
                finally { URL.revokeObjectURL(url); }
            }
            check();
            if (workletReady) {
                const processor = new AudioWorkletNode(context, 'hapi-voice-pcm-recorder'); this.processor = processor;
                processor.port.onmessage = event => { if (event.data?.samples instanceof Float32Array) send(event.data.samples); };
                const sink = context.createGain(); sink.gain.value = 0; this.sink = sink;
                source.connect(processor); processor.connect(sink); sink.connect(context.destination);
            } else {
                const processor = context.createScriptProcessor(4096, 1, 1); this.processor = processor;
                processor.onaudioprocess = event => send(new Float32Array(event.inputBuffer.getChannelData(0)));
                source.connect(processor); processor.connect(context.destination);
            }
        } catch (error) { if (generation === this.generation) this.stop(); throw error; }
    }
    setMuted(value: boolean): void { this.muted = value; this.stream?.getAudioTracks().forEach(track => { track.enabled = !value; }); }
    stop(): void {
        this.generation++;
        this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = undefined;
        if (this.processor) {
            if ('port' in this.processor) { this.processor.port.onmessage = null; this.processor.port.close(); }
            else this.processor.onaudioprocess = null;
            this.processor.disconnect(); this.processor = undefined;
        }
        this.source?.disconnect(); this.source = undefined; this.sink?.disconnect(); this.sink = undefined;
        const context = this.context; this.context = undefined; if (context && context.state !== 'closed') void context.close().catch(() => {});
    }
}
