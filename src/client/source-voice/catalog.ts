import { remoteValue } from '../../client-api.ts';
import type { SourceVoiceApi, VoiceCapabilities } from '../../voice-types.ts';
import { voiceError } from './assistant.ts';

export interface VoiceCatalogState { value: VoiceCapabilities | null; loading: boolean; error: string | null }
/** Read-only readiness, shared by this plugin's composer and settings seats. */
export class VoiceCatalog {
    private state: VoiceCatalogState = { value: null, loading: false, error: null };
    private abort: AbortController | null = null;
    private flight: Promise<void> | null = null;
    private readonly listeners = new Set<() => void>();
    constructor(private readonly api: SourceVoiceApi) {}
    getSnapshot = (): VoiceCatalogState => this.state;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private update(patch: Partial<VoiceCatalogState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
    refresh = (): Promise<void> => {
        if (this.flight) return this.flight;
        const abort = new AbortController(); this.abort = abort; this.update({ loading: true, error: null });
        const pending = this.api.sourceVoiceCapabilities({}, abort.signal).then(remoteValue).then(value => { if (!abort.signal.aborted) this.update({ value, loading: false }); },
            error => { if (!abort.signal.aborted) this.update({ error: voiceError(error), loading: false }); });
        this.flight = pending; void pending.then(() => { if (this.flight === pending) { this.flight = null; this.abort = null; } }); return pending;
    };
    dispose(): void { this.abort?.abort(); this.listeners.clear(); }
}
