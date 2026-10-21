/** Adapted from HAPI 0f8ef697 web/src/realtime/gemini/audioPlayer.ts. AGPL-3.0-only; see ../../../voice/UPSTREAM.md. */
import { base64ToArrayBuffer, pcm16ToFloat32 } from './pcm.ts';

export class GeminiAudioPlayer {
  private audioContext: AudioContext;
  private ownsContext: boolean;
  private lastEndTime: number = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  constructor(audioContext?: AudioContext) {
    if (audioContext) {
      this.audioContext = audioContext;
      this.ownsContext = false;
    } else {
      this.audioContext = new AudioContext({ sampleRate: 24000 });
      this.ownsContext = true;
    }
    this.lastEndTime = this.audioContext.currentTime;
  }

  enqueue(base64Pcm: string): void {
    if (this.audioContext.state === 'closed') return;
    if (base64Pcm.length > 2 * 1024 * 1024 || this.activeSources.length >= 512 || this.lastEndTime - this.audioContext.currentTime > 60) throw new Error('Voice playback buffer exceeded its limit');
    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume().catch(() => {});
    }

    const arrayBuffer = base64ToArrayBuffer(base64Pcm);
    const float32Data = pcm16ToFloat32(arrayBuffer);
    
    if (float32Data.length === 0) return;

    const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, 24000);
    audioBuffer.copyToChannel(new Float32Array(float32Data), 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const startTime = Math.max(this.audioContext.currentTime, this.lastEndTime);
    
    source.onended = () => {
      source.disconnect();
      const index = this.activeSources.indexOf(source);
      if (index > -1) {
        this.activeSources.splice(index, 1);
      }
    };

    source.start(startTime);
    this.activeSources.push(source);

    this.lastEndTime = startTime + audioBuffer.duration;
  }

  clearQueue(): void {
    this.activeSources.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // Ignore if already stopped
      }
      source.disconnect();
    });
    this.activeSources = [];
    this.lastEndTime = this.audioContext.currentTime;
  }

  isPlaying(): boolean {
    return this.lastEndTime > this.audioContext.currentTime;
  }

  dispose(): void {
    this.clearQueue();
    if (this.ownsContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close().catch(() => {});
    }
  }
}
