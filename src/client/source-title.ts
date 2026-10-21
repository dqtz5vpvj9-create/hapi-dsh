import { remoteValue, type SessionExtrasApi, type SessionExtrasResponse, type WorkbenchSource } from '../client-api.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Draft = { version: 1; title: string; pending: boolean };
type State = { data: SessionExtrasResponse<'sourceTitleTools'> | null; draft: Draft | null; busy: boolean; error: string | null; status: 'idle' | 'confirmed' | 'observed' };
const failureText = (error: unknown): string => error instanceof Error ? error.message : String(error);
function rejected(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'details' in error && !!error.details && typeof error.details === 'object'
        && 'outcome' in error.details && error.details.outcome === 'rejected';
}

/** The source Hub suggests; the official SessionController owns the rename. */
export class SourceTitleController {
    private state: State = { data: null, draft: null, busy: false, error: null, status: 'idle' };
    private readonly listeners = new Set<() => void>();
    private readonly key: string;
    private reading: Promise<void> | undefined;
    constructor(private readonly api: Pick<SessionExtrasApi, 'sourceTitleTools' | 'sourceTitleSuggestion'>,
        private readonly source: WorkbenchSource, private readonly rename: (title: string) => Promise<void>, private readonly storage?: StorageLike) {
        this.key = `hapi-dsh:title-draft:${JSON.stringify([source.sourceHubId, source.sourceSessionId])}`;
        try {
            const value: unknown = JSON.parse(storage?.getItem(this.key) ?? 'null');
            if (value && typeof value === 'object' && 'version' in value && value.version === 1 && 'title' in value && typeof value.title === 'string'
                && value.title.length <= 255 && 'pending' in value && typeof value.pending === 'boolean') this.state.draft = { version: 1, title: value.title, pending: value.pending };
        } catch { this.state.error = 'The original title draft could not be read. The source title is unchanged.'; }
    }
    getSnapshot = (): State => this.state;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(value: Partial<State>): void { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
    private persist(draft: Draft | null): void {
        if (!this.storage || !this.source.sourceHubId) throw new Error('Browser storage and the original Hub identity are required before changing the title.');
        const encoded = JSON.stringify(draft); this.storage.setItem(this.key, encoded);
        if (this.storage.getItem(this.key) !== encoded) throw new Error('The original title request could not be saved. No rename was sent.');
    }
    setTitle(title: string): void {
        if (this.state.busy || this.state.draft?.pending) return;
        const draft: Draft = { version: 1, title: title.slice(0, 255), pending: false };
        this.publish({ draft, status: 'idle' });
        try { this.persist(draft); this.publish({ error: null }); } catch (error) { this.publish({ error: failureText(error) }); }
    }
    refresh(): Promise<void> {
        if (this.reading) return this.reading;
        this.reading = (async () => {
            try {
                const data = remoteValue(await this.api.sourceTitleTools({ source: this.source }));
                this.publish({ data });
                if (this.state.draft?.pending && data.title === this.state.draft.title) {
                    this.persist(null); this.publish({ draft: null, status: 'observed', error: null });
                }
            } catch (error) { this.publish({ error: failureText(error) }); }
            finally { this.reading = undefined; }
        })();
        return this.reading;
    }
    async suggest(): Promise<void> {
        if (this.state.busy || this.state.draft?.pending || !this.state.data?.suggestionAvailable) return;
        this.publish({ busy: true, error: null, status: 'idle' });
        try {
            const result = remoteValue(await this.api.sourceTitleSuggestion({ source: this.source }));
            const draft: Draft = { version: 1, title: result.title, pending: false };
            // A generated suggestion only fills the editable draft; it never
            // renames implicitly or overwrites an in-progress composer.
            this.publish({ draft }); this.persist(draft);
        } catch (error) { this.publish({ error: failureText(error) }); }
        finally { this.publish({ busy: false }); }
    }
    async apply(): Promise<void> {
        if (this.state.busy || !this.state.draft?.title.trim()) return;
        const draft: Draft = { version: 1, title: this.state.draft.title.trim(), pending: true };
        this.publish({ busy: true, error: null, status: 'idle' });
        try {
            this.persist(draft); this.publish({ draft });
            await this.rename(draft.title);
            this.persist(null); this.publish({ draft: null, status: 'confirmed' });
            await this.refresh();
        } catch (error) {
            this.publish({ error: failureText(error) });
            if (rejected(error)) {
                const editable = { ...draft, pending: false }; this.publish({ draft: editable });
                try { this.persist(editable); } catch { /* Keep the original pending journal for read-only recovery. */ }
            } else await this.refresh();
        } finally { this.publish({ busy: false }); }
    }
}
