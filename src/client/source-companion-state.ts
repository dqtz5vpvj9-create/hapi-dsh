import { sourceCompanionInfoSchema, sourceCompanionLinkSchema,
    type SourceCompanionApi, type SourceCompanionInfo } from '../source-companion-types.ts';

export type CompanionDisplayError = 'read-failed' | 'reveal-failed' | 'owner-required' | 'source-changed'
    | 'credential-unavailable' | 'endpoint-unavailable' | 'invalid-response' | 'copy-failed';
export interface CompanionSnapshot {
    phase: 'idle' | 'loading' | 'ready' | 'revealing' | 'revealed';
    info: SourceCompanionInfo | null;
    link: string | null;
    qrDataUrl: string | null;
    qrFailed: boolean;
    copying: boolean;
    copied: boolean;
    error: CompanionDisplayError | null;
}
const empty = (): CompanionSnapshot => ({ phase: 'idle', info: null, link: null, qrDataUrl: null, qrFailed: false, copying: false, copied: false, error: null });
function failure(error: unknown, fallback: CompanionDisplayError): CompanionDisplayError {
    if (!error || typeof error !== 'object' || !('details' in error) || !error.details || typeof error.details !== 'object' || !('sourceCode' in error.details)) return fallback;
    switch (error.details.sourceCode) {
        case 'companion_owner_required': return 'owner-required';
        case 'companion_source_changed': return 'source-changed';
        case 'companion_credential_unavailable': return 'credential-unavailable';
        case 'companion_endpoint_unavailable': return 'endpoint-unavailable';
        default: return fallback;
    }
}

/** A short-lived settings view. It deliberately accepts no storage or logging capability. */
export class SourceCompanionController {
    private state = empty();
    private readonly listeners = new Set<() => void>();
    private epoch = 0;
    private disposed = false;
    constructor(private readonly api: SourceCompanionApi, private readonly renderQr: (link: string) => Promise<string>) {}
    getSnapshot = (): CompanionSnapshot => this.state;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(patch: Partial<CompanionSnapshot>): void {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }
    private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch; }
    /** React effect restart is allowed; an earlier effect's pending work still has a different epoch. */
    start(): Promise<void> { this.disposed = false; return this.refresh(); }
    async refresh(): Promise<void> {
        if (this.disposed) return;
        const epoch = ++this.epoch;
        this.publish({ ...empty(), phase: 'loading' });
        try {
            const result = await this.api.sourceCompanionInfo();
            if (!this.current(epoch)) return;
            if (!result.ok) throw result.error;
            const parsed = sourceCompanionInfoSchema.safeParse(result.value);
            if (!parsed.success) { this.publish({ phase: 'idle', error: 'invalid-response' }); return; }
            this.publish({ info: parsed.data, phase: 'ready' });
        } catch (error) { if (this.current(epoch)) this.publish({ phase: 'idle', error: failure(error, 'read-failed') }); }
    }
    async reveal(): Promise<void> {
        const info = this.state.info;
        if (this.disposed || this.state.phase !== 'ready' || !info?.endpoint) return;
        const epoch = ++this.epoch;
        this.publish({ phase: 'revealing', error: null, link: null, qrDataUrl: null, qrFailed: false, copying: false, copied: false });
        try {
            const result = await this.api.sourceCompanionReveal({ hubId: info.hubId, endpointUrl: info.endpoint.url });
            if (!this.current(epoch)) return;
            if (!result.ok) throw result.error;
            const parsed = sourceCompanionLinkSchema.safeParse(result.value);
            if (!parsed.success || parsed.data.hubId !== info.hubId || parsed.data.endpointUrl !== info.endpoint.url) {
                this.publish({ phase: 'ready', error: 'invalid-response' }); return;
            }
            const link = parsed.data.link;
            this.publish({ phase: 'revealed', link });
            try {
                const qrDataUrl = await this.renderQr(link);
                if (!this.current(epoch)) return;
                if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(qrDataUrl)) throw new Error('Invalid local QR image.');
                this.publish({ qrDataUrl });
            } catch { if (this.current(epoch)) this.publish({ qrFailed: true }); }
        } catch (error) {
            if (this.current(epoch)) this.publish({ phase: 'ready', error: failure(error, 'reveal-failed') });
        }
    }
    hide = (): void => {
        ++this.epoch;
        this.publish({ phase: this.state.info ? 'ready' : 'idle', link: null, qrDataUrl: null, qrFailed: false, copying: false, copied: false, error: null });
    };
    async copy(writeText: (link: string) => Promise<void>): Promise<void> {
        const { link } = this.state;
        if (this.disposed || this.state.phase !== 'revealed' || !link || this.state.copying) return;
        const epoch = this.epoch;
        this.publish({ copying: true, copied: false, error: null });
        try {
            await writeText(link);
            if (this.current(epoch)) this.publish({ copying: false, copied: true });
        } catch { if (this.current(epoch)) this.publish({ copying: false, error: 'copy-failed' }); }
    }
    dispose(): void {
        this.disposed = true;
        this.hide();
        this.listeners.clear();
    }
}
