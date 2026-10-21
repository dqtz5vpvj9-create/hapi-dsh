import { randomId } from './random-id.ts'
/** Source-successor draft transfer. No chat submission or private editor state. */
export interface HandoffSource { hubId: string; sessionId: string }
export interface HandoffAddress extends HandoffSource { displayId: string; hostId: string }
export interface HandoffReference {
    source: string; ref: string; offset: number; length: number; label: string; clipboardText: string;
    appearance?: 'session' | 'file' | 'folder'; invalid?: boolean;
}
export interface HandoffDraft {
    bindingId: string; paneId: string; revision: number; text: string; attachmentIds: string[];
    references: HandoffReference[]; command?: string;
    files: Array<{ id: string; file: File }>;
}
export interface HandoffEndpoint {
    readonly address: HandoffAddress;
    readonly paneId: string;
    /** The shared coordinator keeps this own pane graph alive until settlement. */
    retain(): () => void;
    capture(): HandoffDraft;
    writable(): boolean;
    insert(draft: HandoffDraft, expected: HandoffDraft, signal: AbortSignal): Promise<HandoffDraft>;
    /** Exact source binding, text revision and original attachment identity CAS. */
    clear(expected: HandoffDraft): boolean;
    focus(): void;
}
export interface HandoffRecord {
    version: 1; id: string; from: HandoffAddress; to: HandoffAddress; draft: HandoffDraft;
    status: 'prepared' | 'writing' | 'copied' | 'complete' | 'unknown';
    createdAt: number; target?: HandoffDraft; cleared?: boolean; error?: string;
}
export interface HandoffEntry { revision: string; record: HandoffRecord | null }
export interface HandoffStorage {
    read(owner: string): Promise<HandoffEntry | null>;
    write(owner: string, previous: string | null, record: HandoffRecord | null): Promise<HandoffEntry>;
}
export interface HandoffSnapshot {
    loaded: boolean; busy: boolean; opened: boolean; record: HandoffRecord | null;
    target: HandoffDraft | null; targetReady: boolean; error: string | null;
}
export const handoffSourceKey = (source: HandoffSource): string => JSON.stringify([source.hubId, source.sessionId]);
const sameAddress = (left: HandoffAddress, right: HandoffAddress): boolean => handoffSourceKey(left) === handoffSourceKey(right)
    && left.hostId === right.hostId && left.displayId === right.displayId;
export const hasHandoffContent = (draft: Pick<HandoffDraft, 'text' | 'files'>): boolean => draft.text.length > 0 || draft.files.length > 0;
export function handoffDraftMatches(left: HandoffDraft, right: HandoffDraft): boolean {
    return left.bindingId === right.bindingId && left.paneId === right.paneId && left.revision === right.revision
        && left.text === right.text && left.command === right.command
        && JSON.stringify(left.references) === JSON.stringify(right.references)
        && left.attachmentIds.length === right.attachmentIds.length && left.attachmentIds.every((id, index) => id === right.attachmentIds[index])
        && left.files.length === right.files.length && left.files.every((file, index) => file.id === right.files[index]?.id && file.file === right.files[index]?.file);
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function validateEntry(value: unknown): HandoffEntry | null {
    if (value == null) return null;
    if (typeof value !== 'object' || typeof Reflect.get(value, 'revision') !== 'string') throw new Error('The saved draft hand-off is incompatible. Its original data has been retained.');
    const entry = value as HandoffEntry, record = entry.record;
    if (record === null) return entry;
    const address = (item: HandoffAddress) => item && [item.hubId, item.sessionId, item.displayId, item.hostId].every(value => typeof value === 'string' && !!value);
    const draft = (item: HandoffDraft) => item && typeof item.bindingId === 'string' && typeof item.paneId === 'string'
        && Number.isSafeInteger(item.revision) && typeof item.text === 'string' && Array.isArray(item.attachmentIds)
        && item.attachmentIds.every(id => typeof id === 'string') && Array.isArray(item.references)
        && item.references.every(ref => ref && typeof ref.source === 'string' && typeof ref.ref === 'string' && typeof ref.label === 'string'
            && Number.isSafeInteger(ref.offset) && Number.isSafeInteger(ref.length) && ref.offset >= 0 && ref.length > 0
            && typeof ref.clipboardText === 'string' && item.text.slice(ref.offset, ref.offset + ref.length) === ref.clipboardText)
        && (item.command === undefined || typeof item.command === 'string') && Array.isArray(item.files)
        && item.files.every(file => file && typeof file.id === 'string' && file.file instanceof Blob);
    if (!record || record.version !== 1 || typeof record.id !== 'string' || !address(record.from) || !address(record.to)
        || record.from.hubId !== record.to.hubId || !draft(record.draft) || record.target !== undefined && !draft(record.target)
        || !['prepared', 'writing', 'copied', 'complete', 'unknown'].includes(record.status)) {
        throw new Error('The saved draft hand-off is incompatible. Its original data has been retained.');
    }
    return entry;
}

/** Original browser File bytes, not upload receipts, survive a refresh. */
export class BrowserHandoffStorage implements HandoffStorage {
    private open(): Promise<IDBDatabase> { return new Promise((resolve, reject) => {
        const request = indexedDB.open('hapi-dsh-draft-handoffs', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('windows');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Draft hand-off storage is unavailable.'));
        request.onblocked = () => reject(new Error('Another window is blocking the draft hand-off store.'));
    }); }
    async read(owner: string): Promise<HandoffEntry | null> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('windows'), request = tx.objectStore('windows').get(owner);
            tx.oncomplete = () => { db.close(); try { resolve(validateEntry(request.result)); } catch (error) { reject(error); } };
            tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('The saved draft hand-off could not be read.')); };
        });
    }
    async write(owner: string, previous: string | null, record: HandoffRecord | null): Promise<HandoffEntry> {
        const db = await this.open(), entry = { revision: randomId(), record };
        return new Promise((resolve, reject) => {
            const tx = db.transaction('windows', 'readwrite', { durability: 'strict' }), store = tx.objectStore('windows');
            const request = store.get(owner); let failure: unknown;
            request.onsuccess = () => { try {
                if ((validateEntry(request.result)?.revision ?? null) !== previous) throw new Error('Another window changed this draft hand-off. Both composers remain available; reload the recorded result.');
                store.put(entry, owner);
            } catch (error) { failure = error; tx.abort(); } };
            tx.oncomplete = () => { db.close(); resolve(entry); };
            tx.onerror = tx.onabort = () => { db.close(); reject(failure ?? tx.error ?? new Error('The original draft could not be retained. Nothing has been transferred.')); };
        });
    }
}

/** One explicit source-successor operation per browser window, shared by all pane graphs. */
export class WorkspaceDraftHandoffs {
    private state: HandoffSnapshot = { loaded: false, busy: false, opened: false, record: null, target: null, targetReady: false, error: null };
    private readonly listeners = new Set<() => void>();
    private readonly endpoints = new Set<HandoffEndpoint>();
    private readonly lifetime = new AbortController();
    private readonly loading: Promise<void>;
    private revision: string | null = null;
    private retained: (() => void) | undefined;
    private sourceEndpoint: HandoffEndpoint | undefined;
    constructor(readonly owner: string, private readonly storage: HandoffStorage = new BrowserHandoffStorage(),
        private readonly checkpointEditors: () => Promise<void> = async () => {}) { this.loading = this.load(); }
    getSnapshot = (): HandoffSnapshot => this.state;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(patch: Partial<HandoffSnapshot>): void {
        if (this.lifetime.signal.aborted) return;
        this.state = { ...this.state, ...patch }; for (const listener of [...this.listeners]) listener();
    }
    private async load(): Promise<void> {
        try {
            const saved = await this.storage.read(this.owner); this.revision = saved?.revision ?? null;
            const record = saved?.record ?? null;
            // An interrupted write is never replayed. The original capture is
            // retained for explicit comparison with the target's real draft.
            const recovered = record && ['writing', 'copied'].includes(record.status)
                ? { ...record, status: 'unknown' as const, error: 'A previous transfer was interrupted. Inspect both drafts before explicitly starting another transfer.' } : record;
            this.publish({ loaded: true, record: recovered, opened: !!recovered, error: recovered?.error ?? null }); this.changed();
        } catch (error) { this.publish({ loaded: true, error: errorText(error), opened: true }); }
    }
    private async save(record: HandoffRecord | null): Promise<void> {
        const saved = await this.storage.write(this.owner, this.revision, record); this.revision = saved.revision;
        this.publish({ record });
    }
    register(endpoint: HandoffEndpoint): () => void {
        this.endpoints.add(endpoint); this.publish({}); this.changed();
        return () => { this.endpoints.delete(endpoint); this.publish({}); this.changed(); };
    }
    changed = (): void => {
        const record = this.state.record;
        const target = record ? [...this.endpoints].find(endpoint => sameAddress(endpoint.address, record.to) && endpoint.writable()) : undefined;
        let draft: HandoffDraft | null = null;
        try { draft = target?.capture() ?? null; } catch { /* The real graph will publish again when its original input is available. */ }
        if (!draft && !this.state.target || draft && this.state.target && handoffDraftMatches(draft, this.state.target)) {
            if (this.state.targetReady !== !!target) this.publish({ targetReady: !!target });
            return;
        }
        this.publish({ target: draft, targetReady: !!target });
    };
    show = (): void => { this.publish({ opened: true }); };
    hide = (): void => { this.publish({ opened: false }); };
    report = (error: unknown): void => { this.publish({ error: errorText(error), opened: true }); };
    sourceAvailable(from: HandoffAddress, paneId?: string): boolean {
        return [...this.endpoints].some(endpoint => sameAddress(endpoint.address, from) && (!paneId || endpoint.paneId === paneId));
    }
    /** Pending inbound shares wait while these two actual source drafts are
     * being compared. Delivered or uncertain shares never move implicitly. */
    blocksSource(source: HandoffSource): boolean {
        const record = this.state.record;
        return !!record && record.status !== 'complete' && [record.from, record.to].some(address => handoffSourceKey(address) === handoffSourceKey(source));
    }
    async prepare(from: HandoffAddress, to: HandoffAddress, paneId?: string): Promise<boolean> {
        await this.loading;
        if (this.state.busy) throw new Error('Another draft hand-off is still running.');
        if (from.hubId !== to.hubId || handoffSourceKey(from) === handoffSourceKey(to)) throw new Error('A hand-off requires two confirmed source sessions on the same Hub.');
        if (this.state.record && this.state.record.status !== 'complete') throw new Error('Review the existing draft hand-off before preparing another.');
        if (this.state.record) {
            const previous = this.state.record;
            await this.checkpointEditors();
            if (this.state.busy || this.state.record !== previous) throw new Error('The previous transfer changed while saving. Review it before starting another.');
        }
        const candidates = [...this.endpoints].filter(endpoint => sameAddress(endpoint.address, from) && (!paneId || endpoint.paneId === paneId));
        const captured = candidates.map(endpoint => ({ endpoint, draft: endpoint.capture() }));
        const nonempty = captured.filter(row => hasHandoffContent(row.draft));
        if (nonempty.length > 1) throw new Error('Several views of the original session contain drafts. Open the intended source pane and continue from its Session tools.');
        const selected = nonempty[0] ?? captured[0];
        if (!selected) throw new Error('Open the original conversation so its official composer can provide the saved draft.');
        if (!hasHandoffContent(selected.draft)) return false;
        const release = selected.endpoint.retain();
        this.publish({ busy: true, error: null });
        try {
            const record: HandoffRecord = { version: 1, id: randomId(), from, to, draft: selected.draft, status: 'prepared', createdAt: Date.now() };
            await this.save(record);
            this.retained?.(); this.retained = release; this.sourceEndpoint = selected.endpoint;
            this.publish({ opened: true }); this.changed(); return true;
        } catch (error) { release(); this.report(error); throw error; }
        finally { this.publish({ busy: false }); }
    }
    /** User-visible choice, never an implicit overwrite of an existing target. */
    async transfer(expected: HandoffDraft, append: boolean): Promise<void> {
        const record = this.state.record;
        if (this.state.busy || !record || record.status !== 'prepared') return;
        const endpoint = [...this.endpoints].find(row => sameAddress(row.address, record.to) && row.paneId === expected.paneId);
        if (!endpoint || !endpoint.writable() || !handoffDraftMatches(endpoint.capture(), expected)) { this.report(new Error('The target composer changed. Review its current draft before transferring.')); this.changed(); return; }
        if (hasHandoffContent(expected) && !append) { this.report(new Error('The target already contains a draft. Explicitly choose to append or keep both drafts.')); return; }
        if (hasHandoffContent(expected) && record.draft.command) { this.report(new Error('A command draft can only be transferred into an empty composer. Keep both drafts or review and clear the target yourself.')); return; }
        const releaseTarget = endpoint.retain(); this.publish({ busy: true, error: null });
        let wrote = false;
        try {
            await this.save({ ...record, status: 'writing' });
            const target = await endpoint.insert(record.draft, expected, this.lifetime.signal); wrote = true;
            await this.save({ ...record, status: 'copied', target });
            // Check the target again after the durable proof write. Source
            // cleanup is allowed only while both exact live bindings remain.
            const accepted = endpoint.writable() && handoffDraftMatches(endpoint.capture(), target);
            const cleared = accepted && this.sourceEndpoint?.clear(record.draft) === true;
            await this.save({ ...record, status: 'complete', target, cleared,
                ...(!cleared ? { error: 'The target accepted the captured draft. The original was retained because its live binding or contents changed.' } : {}) });
            this.publish({ error: cleared ? null : this.state.record?.error ?? null }); endpoint.focus();
            this.retained?.(); this.retained = undefined; this.sourceEndpoint = undefined;
        } catch (error) {
            const explanation = errorText(error);
            // Even a known refusal retains the immutable capture; no automatic
            // retry can double-insert files or a partially applied reference.
            try { await this.save({ ...record, status: 'unknown', error: explanation }); } catch { /* The durable 'writing' record remains a no-replay recovery marker. */ }
            this.report(new Error(wrote ? `The target may already contain this draft. ${explanation}` : explanation));
        } finally { releaseTarget(); this.publish({ busy: false }); this.changed(); }
    }
    async keepBoth(): Promise<void> {
        if (this.state.busy) return;
        const previous = this.state.record;
        const target = previous?.status === 'complete' ? [...this.endpoints].find(endpoint => sameAddress(endpoint.address, previous.to) && endpoint.writable()) : undefined;
        if (previous?.status === 'complete' && !target) throw new Error('Open the recovered conversation before finishing so its actual draft and attachments can be verified.');
        const before = target?.capture();
        // This transaction is deliberately not busy during the public
        // prepare/verify barrier: its own checkpoint must participate without
        // deadlocking. New editor changes or a replaced transaction veto Done.
        await this.checkpointEditors();
        if (this.state.busy || this.state.record !== previous) throw new Error('The draft transfer changed while saving. Review its current result.');
        if (target && before && (!target.writable() || !handoffDraftMatches(target.capture(), before))) throw new Error('The target draft changed while saving. Its transfer backup is retained; review it and try Done again.');
        this.publish({ busy: true });
        try {
            await this.save(null); this.retained?.(); this.retained = undefined; this.sourceEndpoint = undefined;
            this.publish({ opened: false, error: null, target: null, targetReady: false });
        } finally { this.publish({ busy: false }); }
    }
    /** Reload may proceed only once every editor effect has settled durably. */
    checkpoint(): void { if (this.state.busy || this.state.record?.status === 'writing') throw new Error('Finish the draft hand-off before refreshing.'); }
    dispose(): void { this.lifetime.abort(); this.retained?.(); this.retained = undefined; this.endpoints.clear(); this.listeners.clear(); }
}
