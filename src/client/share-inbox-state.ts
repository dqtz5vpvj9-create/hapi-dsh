import { randomId } from './random-id.ts'
import { BrowserShareTransfers, shareTargetKey, validateSharePayload, type ShareDelivery, type SharePayload, type ShareRecord, type ShareTarget, type ShareTransfers } from './share-transfer.ts';
import { appAccountScopeSchema, appScopeKey, appSourceRouteSchema, type AppAccountScope } from '../workspace/app-service-types.ts';

export interface ShareReceiver {
    readonly paneId?: string | undefined;
    ready(): boolean;
    insert(payload: SharePayload, signal: AbortSignal, options?: { exactText: boolean }): Promise<{ afterText: string }>;
}
export interface ShareInboxSnapshot {
    record: ShareRecord | null; phase: 'idle' | 'loading' | 'pick' | 'creating' | 'waiting' | 'inserting' | 'inserted' | 'unknown' | 'error';
    opened: boolean; error: string | null;
}
/** One root coordinator; each pane contributes only its own live composer capability. */
export class WorkspaceShareInbox {
    private snapshot: ShareInboxSnapshot = { record: null, phase: 'idle', opened: false, error: null };
    private readonly listeners = new Set<() => void>();
    private readonly receivers = new Map<string, Set<ShareReceiver>>();
    private readonly receiverChanges = new Set<() => void>();
    private readonly lifetime = new AbortController();
    private loading = 0;
    private running = false;
    private creationToken: string | null = null;
    private scope: AppAccountScope | undefined;
    private authorization = new AbortController();
    readonly owner: string;
    constructor(private readonly transfers: ShareTransfers = new BrowserShareTransfers(), storage?: Pick<Storage, 'getItem' | 'setItem'>, scope?: AppAccountScope) {
        this.scope = scope && appAccountScopeSchema.parse(scope);
        let owner = '';
        try { owner = storage?.getItem('hapi-dsh:share-window:v1') ?? ''; } catch { /* Recovery never replays an unknown insertion. */ }
        if (!owner || owner.length > 128) { owner = randomId(); try { storage?.setItem('hapi-dsh:share-window:v1', owner); } catch { /* A fresh window can still stage content. */ } }
        this.owner = owner;
    }
    getSnapshot = (): ShareInboxSnapshot => this.snapshot;
    setScope(scope: AppAccountScope | undefined): void {
        const next = scope && appAccountScopeSchema.parse(scope);
        if (next && this.scope && appScopeKey(next) === appScopeKey(this.scope)) return;
        this.authorization.abort(new Error('The authenticated share account changed')); this.authorization = new AbortController(); this.scope = next;
        this.creationToken = null;
        if (this.snapshot.record?.hapiDshDelivery) this.publish({ record: null, phase: 'idle', opened: false, error: null });
    }
    private requireScope(): AppAccountScope {
        if (!this.scope) throw new Error('Authenticate before choosing a conversation for this share');
        return this.scope;
    }
    private assertDelivery(delivery: ShareDelivery): void {
        const target = appSourceRouteSchema.safeParse(delivery.target), scope = appAccountScopeSchema.safeParse(delivery.scope);
        if (!target.success || !scope.success) throw new Error('This saved share uses an earlier hand-off format. Its original content is retained and will not be inserted automatically');
        if (appScopeKey(scope.data) !== appScopeKey(this.requireScope())) throw new Error('The saved share belongs to another authenticated account or application origin; its original content is retained');
    }
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(update: Partial<ShareInboxSnapshot>): void {
        if (this.lifetime.signal.aborted) return;
        this.snapshot = { ...this.snapshot, ...update }; for (const listener of this.listeners) listener();
    }
    show = (): void => { this.publish({ opened: true }); };
    hide = (): void => { this.publish({ opened: false }); };
    report = (error: unknown): void => { this.publish({ phase: 'error', opened: true, error: error instanceof Error ? error.message : 'The shared content could not be read.' }); };
    async ingest(payload: SharePayload): Promise<string> { const id = await this.transfers.put(payload); await this.load(id); return id; }
    async load(id: string): Promise<void> {
        if (!id || id.length > 256 || /[\u0000-\u0020\u007f]/u.test(id)) { this.report(new Error('The share identity is invalid.')); return; }
        const request = ++this.loading; this.publish({ record: null, phase: 'loading', opened: true, error: null });
        try {
            const record = await this.transfers.read(id); if (request !== this.loading) return;
            validateSharePayload(record);
            const delivery = record!.hapiDshDelivery;
            if (delivery && (!delivery.target || !delivery.target.sessionId
                || !['ready', 'inserting', 'inserted', 'unknown'].includes(delivery.status) || typeof delivery.owner !== 'string')) throw new Error('The saved share hand-off is incompatible; its original content is retained.');
            if (delivery) this.assertDelivery(delivery);
            const phase = !delivery ? 'pick' : delivery.status === 'ready' ? 'waiting' : delivery.status === 'inserted' ? 'inserted' : 'unknown';
            this.publish({ record: record!, phase, opened: phase !== 'inserted', error: delivery?.error ?? null });
            if (delivery?.owner === this.owner && phase === 'waiting') this.wake();
        } catch (error) { if (request === this.loading) this.report(error); }
    }
    async select(target: ShareTarget, explicitRetry = false): Promise<void> {
        const current = this.snapshot.record; if (!current || this.running) return;
        try {
            const scope = this.requireScope(), signal = this.authorization.signal; appSourceRouteSchema.parse(target);
            const record = await this.transfers.update(current.id, record => {
                validateSharePayload(record);
                if (record.hapiDshDelivery) this.assertDelivery(record.hapiDshDelivery);
                if (record.hapiDshDelivery && record.hapiDshDelivery.status !== 'ready' && !explicitRetry) throw new Error('This share already has an insertion receipt. Review it before inserting again.');
                return { ...record, hapiDshDelivery: { scope, target, owner: this.owner, status: 'ready' } };
            });
            signal.throwIfAborted();
            this.publish({ record, phase: 'waiting', error: null, opened: false }); this.wake();
        } catch (error) { this.report(error); }
    }
    beginCreation(): string | null {
        if (!this.snapshot.record || this.running) return null;
        this.creationToken = randomId(); this.publish({ phase: 'creating', opened: false, error: null }); return this.creationToken;
    }
    cancelCreation(): void { if (this.creationToken) { this.creationToken = null; this.publish({ phase: 'pick', opened: true }); } }
    created(target: ShareTarget): void { if (this.creationToken) { this.creationToken = null; void this.select(target); } }
    /** Follow only a backend-confirmed successor, before this window has made
     * any composer effect. An inserted or uncertain receipt stays on its
     * original source and is never interpreted as a new pending share. */
    async retargetPending(from: ShareTarget, to: ShareTarget): Promise<boolean> {
        appSourceRouteSchema.parse(from); appSourceRouteSchema.parse(to);
        if (from.kind !== to.kind || from.hostId !== to.hostId || from.kind === 'hhpi' && (to.kind !== 'hhpi'
            || from.identity.machineId !== to.identity.machineId || from.identity.sourceId !== to.identity.sourceId || from.identity.engine !== to.identity.engine)) throw new Error('A pending share cannot cross an unconfirmed source owner');
        const current = this.snapshot.record, delivery = current?.hapiDshDelivery;
        const matches = (target: ShareTarget) => shareTargetKey(target) === shareTargetKey(from);
        if (this.running || !current || !delivery || delivery.owner !== this.owner || delivery.status !== 'ready' || !matches(delivery.target)) return false;
        this.running = true;
        try {
            const record = await this.transfers.update(current.id, value => {
                const pending = value.hapiDshDelivery;
                if (!pending || pending.owner !== this.owner || pending.status !== 'ready' || !matches(pending.target)) throw new Error('The pending share changed before the successor was ready. Its original receipt is retained.');
                this.assertDelivery(pending);
                return { ...value, hapiDshDelivery: { ...pending, target: to } };
            });
            this.publish({ record, phase: 'waiting', error: null }); return true;
        } finally { this.running = false; this.wake(); }
    }
    register(target: ShareTarget, receiver: ShareReceiver): () => void {
        const key = shareTargetKey(target), entries = this.receivers.get(key) ?? new Set();
        entries.add(receiver); this.receivers.set(key, entries); this.wake();
        return () => { entries.delete(receiver); if (!entries.size) this.receivers.delete(key); };
    }
    wake = (): void => { queueMicrotask(() => { for (const changed of this.receiverChanges) changed(); void this.apply(); }); };
    /** An original source note is already durable. Insert it once into the named
     * live composer, without creating a second share or changing its receipts. */
    async insertOriginal(target: ShareTarget, paneId: string, payload: SharePayload, signal: AbortSignal): Promise<void> {
        this.requireScope(); appSourceRouteSchema.parse(target);
        const lifetime = AbortSignal.any([signal, this.lifetime.signal, this.authorization.signal, AbortSignal.timeout(30_000)]);
        lifetime.throwIfAborted();
        const receiver = await new Promise<ShareReceiver>((resolve, reject) => {
            const finish = () => { this.receiverChanges.delete(changed); lifetime.removeEventListener('abort', abort); };
            const abort = () => { finish(); reject(lifetime.reason); };
            const changed = () => {
                const current = [...this.receivers.get(shareTargetKey(target)) ?? []].find(row => row.paneId === paneId && row.ready());
                if (current) { finish(); resolve(current); }
            };
            this.receiverChanges.add(changed); lifetime.addEventListener('abort', abort, { once: true }); changed();
        });
        lifetime.throwIfAborted();
        await receiver.insert(payload, lifetime, { exactText: true });
    }
    private async apply(): Promise<void> {
        const { record, phase } = this.snapshot, delivery = record?.hapiDshDelivery;
        if (this.running || phase !== 'waiting' || !record || !delivery || delivery.owner !== this.owner) return;
        this.assertDelivery(delivery);
        const signal = AbortSignal.any([this.lifetime.signal, this.authorization.signal]);
        const receiver = [...this.receivers.get(shareTargetKey(delivery.target)) ?? []].find(candidate => candidate.ready());
        if (!receiver) return;
        this.running = true;
        try {
            // An atomic durable claim precedes every composer effect. Reopening
            // an interrupted claim is read-only, never an automatic duplicate.
            const claimed = await this.transfers.update(record.id, value => {
                const pending = value.hapiDshDelivery;
                if (!pending || pending.status !== 'ready' || pending.owner !== this.owner || shareTargetKey(pending.target) !== shareTargetKey(delivery.target)) throw new Error('Another view already claimed this share.');
                return { ...value, hapiDshDelivery: { ...pending, status: 'inserting' } };
            });
            this.publish({ record: claimed, phase: 'inserting' });
            if (!receiver.ready()) throw new Error('The target composer changed before the share could be inserted.');
            signal.throwIfAborted();
            const result = await receiver.insert(claimed, signal);
            signal.throwIfAborted();
            const inserted = await this.transfers.update(record.id, value => {
                if (value.hapiDshDelivery?.owner !== this.owner || value.hapiDshDelivery.status !== 'inserting') throw new Error('The insertion receipt could not be confirmed.');
                return { ...value, hapiDshDelivery: { ...value.hapiDshDelivery, status: 'inserted', afterText: result.afterText } };
            });
            if (!signal.aborted) this.publish({ record: inserted, phase: 'inserted', opened: false, error: null });
        } catch (error) {
            const explanation = error instanceof Error ? error.message : 'The shared content could not be inserted.';
            let current = this.snapshot.record;
            try { current = await this.transfers.update(record.id, value => {
                if (value.hapiDshDelivery?.owner !== this.owner || value.hapiDshDelivery.status !== 'inserting') return value;
                return { ...value, hapiDshDelivery: { ...value.hapiDshDelivery, status: 'unknown', error: explanation } };
            }); } catch { /* The original payload remains the recovery source. */ }
            if (!signal.aborted) this.publish({ record: current, phase: 'unknown', opened: true, error: explanation });
        } finally { this.running = false; }
    }
    async discard(): Promise<void> {
        const record = this.snapshot.record; if (!record || this.running) return;
        try { await this.transfers.delete(record.id); this.publish({ record: null, phase: 'idle', opened: false, error: null }); }
        catch (error) { this.report(error); }
    }
    dispose(): void { this.lifetime.abort(); this.receivers.clear(); this.listeners.clear(); }
}
