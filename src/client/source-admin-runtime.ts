import { remoteValue } from '../client-api.ts';
import type { SourceAdminApi, SourceAdministration } from '../source-admin-types.ts';
import { SourceAdminController } from './source-admin-state.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export interface SourceAdminSnapshot {
    data: SourceAdministration | null; error: string | null; loading: boolean; controller: SourceAdminController | null;
}

/** The Settings section and workspace banner share one read cache and mutation owner. */
export class SourceAdministrationRuntime {
    private state: SourceAdminSnapshot = { data: null, error: null, loading: false, controller: null };
    private readonly listeners = new Set<() => void>();
    private flight: Promise<void> | undefined;
    private disposed = false;
    constructor(private readonly api: SourceAdminApi, private readonly storage?: StorageLike) {}
    getSnapshot = (): SourceAdminSnapshot => this.state;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(patch: Partial<SourceAdminSnapshot>): void {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
    }
    refresh = (): Promise<void> => {
        if (this.disposed) return Promise.resolve();
        if (this.flight) return this.flight;
        this.publish({ loading: true });
        const work = Promise.resolve().then(async () => {
            try {
                const data = remoteValue(await this.api.sourceAdministration());
                if (this.disposed) return;
                const reused = this.state.data?.hubId === data.hubId && this.state.controller;
                const controller = reused || new SourceAdminController(this.api, data.hubId, this.storage);
                // A read-only page need not write an empty journal to browser storage.
                if (data.operations.length || controller.getSnapshot().receipts.length) controller.accept(data.operations);
                this.publish({ data, error: null, loading: false, controller });
                // Receipt recovery has its own coalesced reads. A restart whose
                // source response is still pending must not hold the overview
                // read open or prevent other machines/settings from refreshing.
                void controller.recover();
            } catch (error) { this.publish({ error: error instanceof Error ? error.message : String(error), loading: false }); }
        });
        this.flight = work;
        void work.finally(() => { if (this.flight === work) this.flight = undefined; });
        return work;
    };
    /** A completed mutation cannot reuse an overview request sent before it. */
    revalidate = async (): Promise<void> => {
        const preceding = this.flight;
        if (preceding) await preceding;
        await this.refresh();
    };
    dispose(): void { this.disposed = true; this.listeners.clear(); }
}
