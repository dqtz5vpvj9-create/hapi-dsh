import { remoteValue } from '../client-api.ts';
import { sourceAdminOperationSchema, sourceAdminReceiptSchema, type SourceAdminAction, type SourceAdminApi, type SourceAdminOperation, type SourceAdminReceipt } from '../source-admin-types.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Snapshot = { busy: boolean; error: string | null; intents: SourceAdminOperation[]; receipts: SourceAdminReceipt[] };
const pending = (value: SourceAdminReceipt) => value.status === 'submitting' || value.status === 'indeterminate';
function overlaps(a: SourceAdminAction, b: SourceAdminAction): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'settings' && b.kind === 'settings') return Object.keys(a.values).some(key => key in b.values);
    if (a.kind === 'settings' || b.kind === 'settings' || a.machineId !== b.machineId) return false;
    return a.kind !== 'dsh-bundle' || b.kind !== 'dsh-bundle' || a.name === b.name;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Preserve the exact mutation identity before sending, across settings close and page reload. */
export class SourceAdminController {
    private state: Snapshot = { busy: false, error: null, intents: [], receipts: [] };
    private readonly listeners = new Set<() => void>();
    private readonly reads = new Map<string, Promise<SourceAdminReceipt | null>>();
    private readonly key: string;
    constructor(private readonly api: SourceAdminApi, private readonly hubId: string, private readonly storage?: StorageLike,
        private readonly nextId: () => string = () => crypto.randomUUID()) {
        this.key = `hapi-dsh:administration:${hubId}`;
        try {
            const value: unknown = JSON.parse(storage?.getItem(this.key) ?? 'null');
            if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return;
            if ('intents' in value && Array.isArray(value.intents)) this.state.intents = value.intents.flatMap(row => {
                const parsed = sourceAdminOperationSchema.safeParse(row); return parsed.success ? [parsed.data] : [];
            });
            if ('receipts' in value && Array.isArray(value.receipts)) this.state.receipts = value.receipts.flatMap(row => {
                const parsed = sourceAdminReceiptSchema.safeParse(row); return parsed.success && parsed.data.hubId === hubId ? [parsed.data] : [];
            });
        } catch { /* Source operation inventory still recovers durable Host receipts. */ }
    }
    getSnapshot = (): Snapshot => this.state;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(patch: Partial<Snapshot>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
    private persist(): void {
        if (!this.storage) throw new Error('Browser storage is unavailable. Enable storage before changing Hub or Runner settings.');
        const encoded = JSON.stringify({ version: 1, intents: this.state.intents, receipts: this.state.receipts });
        this.storage.setItem(this.key, encoded);
        if (this.storage.getItem(this.key) !== encoded) throw new Error('The original operation identity could not be saved. No change was sent.');
    }
    accept(receipts: readonly SourceAdminReceipt[]): void {
        const values = new Map(this.state.receipts.map(row => [row.operationId, row]));
        for (const value of receipts) {
            if (value.hubId !== this.hubId) continue;
            const previous = values.get(value.operationId);
            if (!previous || value.updatedAt >= previous.updatedAt) values.set(value.operationId, value);
        }
        this.publish({ receipts: [...values.values()].sort((a, b) => b.createdAt - a.createdAt) });
        try { this.persist(); } catch (error) { this.publish({ error: errorText(error) }); }
    }
    canRun(action: SourceAdminAction): boolean {
        return !this.state.busy && !this.state.intents.some(intent => {
            const receipt = this.state.receipts.find(value => value.operationId === intent.operationId);
            return overlaps(action, intent.action) && (!receipt || pending(receipt));
        }) && !this.state.receipts.some(receipt => pending(receipt) && overlaps(action, receipt.action));
    }
    async run(action: SourceAdminAction): Promise<SourceAdminReceipt | null> {
        if (!this.canRun(action)) return null;
        const input = sourceAdminOperationSchema.parse({ operationId: this.nextId(), action }), previous = this.state.intents;
        this.publish({ busy: true, error: null, intents: [...previous, input] });
        try { this.persist(); }
        catch (error) { this.publish({ busy: false, intents: previous, error: errorText(error) }); return null; }
        try { const value = remoteValue(await this.api.sourceAdminOperation(input)); this.accept([value]); return value; }
        catch (error) { this.publish({ error: errorText(error) }); return this.inspect(input.operationId); }
        finally { this.publish({ busy: false }); }
    }
    inspect(operationId: string): Promise<SourceAdminReceipt | null> {
        const previous = this.reads.get(operationId); if (previous) return previous;
        const work = (async () => {
            try {
                const value = remoteValue(await this.api.sourceAdminOperationRead({ operationId }));
                if (value) { this.accept([value]); this.publish({ error: null }); }
                else this.publish({ error: 'The original Host receipt is not yet available. This operation has not been sent again.' });
                return value;
            } catch (error) { this.publish({ error: errorText(error) }); return null; }
        })();
        this.reads.set(operationId, work);
        void work.finally(() => { if (this.reads.get(operationId) === work) this.reads.delete(operationId); });
        return work;
    }
    async recover(): Promise<void> {
        const ids = new Set(this.state.intents.filter(intent => {
            const receipt = this.state.receipts.find(value => value.operationId === intent.operationId); return !receipt || pending(receipt);
        }).map(intent => intent.operationId));
        for (const receipt of this.state.receipts) if (pending(receipt)) ids.add(receipt.operationId);
        await Promise.all([...ids].map(id => this.inspect(id)));
    }
}
