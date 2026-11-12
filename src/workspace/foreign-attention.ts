/** Pairing owns background source subscriptions independently of browser Pane lifetimes. */
import type { AppServiceContext } from './app-service-types.ts';
import type { NotificationObservation, NotificationObservationState, SourceAttentionSourceFeed, SourceNotificationObserver } from './notification-events.ts';
export interface ForeignAttentionSource { id: string; machineId: string; engine: string; routeKind: 'hhpi' | 'federated-dsh' }
export interface ForeignAttentionMachine { id: string; online: boolean; generation?: string; connectedAt?: number }
export interface ForeignAttentionCatalog {
    machines(): readonly ForeignAttentionMachine[];
    subscribe(listener: () => void): () => void;
    listSources(hostId: string, signal: AbortSignal): Promise<readonly ForeignAttentionSource[]>;
    feed(hostId: string, source: ForeignAttentionSource): SourceAttentionSourceFeed;
}
export class ForeignSourceNotifications {
    private readonly lifetime = new AbortController();
    private readonly requests = new Map<string, { generation: string; abort: AbortController; done: Promise<void> }>();
    private readonly admitted = new Map<string, string>();
    private readonly observations = new Map<string, { hostId: string; observer: NotificationObservation }>();
    private readonly stopping = new Set<Promise<void>>();
    private readonly unsubscribe: () => void;
    constructor(private readonly options: { catalog: ForeignAttentionCatalog; context: AppServiceContext;
        observer: SourceNotificationObserver; status(id: string, state: NotificationObservationState | null): void }) {
        this.unsubscribe = options.catalog.subscribe(() => this.refresh()); this.refresh();
    }
    private generation(machine: ForeignAttentionMachine): string { return JSON.stringify([machine.generation, machine.connectedAt]); }
    private stop(key: string): void {
        const observation = this.observations.get(key); if (!observation) return;
        this.observations.delete(key);
        const done = observation.observer.stop().finally(() => {
            this.stopping.delete(done);
            if (!this.observations.has(key)) this.options.status(key, null);
        });
        this.stopping.add(done);
    }
    private refresh(): void {
        if (this.lifetime.signal.aborted) return;
        const machines = this.options.catalog.machines(), paired = new Set(machines.map(machine => machine.id));
        for (const [key, value] of this.observations) if (!paired.has(value.hostId)) this.stop(key);
        for (const [hostId, request] of this.requests) {
            const machine = machines.find(machine => machine.id === hostId);
            if (!machine?.online || request.generation !== this.generation(machine)) request.abort.abort();
        }
        for (const hostId of this.admitted.keys()) if (!paired.has(hostId)) this.admitted.delete(hostId);
        for (const machine of machines) {
            const generation = this.generation(machine);
            if (!machine.online || this.admitted.get(machine.id) === generation || this.requests.has(machine.id)) continue;
            const abort = new AbortController(), signal = AbortSignal.any([abort.signal, this.lifetime.signal]);
            const done = this.discover(machine, signal).finally(() => {
                this.requests.delete(machine.id);
                if (signal.aborted) this.refresh();
            });
            this.requests.set(machine.id, { generation, abort, done });
        }
    }
    private async discover(machine: ForeignAttentionMachine, signal: AbortSignal): Promise<void> {
        const catalogKey = `remote:${machine.id}:catalog`;
        this.options.status(catalogKey, 'connecting');
        try {
            const sources = await this.options.catalog.listSources(machine.id, signal); signal.throwIfAborted();
            const current = this.options.catalog.machines().find(value => value.id === machine.id);
            if (!current?.online || this.generation(current) !== this.generation(machine)) return;
            await Promise.all([...this.stopping]); signal.throwIfAborted();
            const expected = new Set(sources.map(source => JSON.stringify([machine.id, source.id, source.machineId, source.engine, source.routeKind])));
            for (const [key, value] of this.observations) if (value.hostId === machine.id && !expected.has(key)) this.stop(key);
            for (const source of sources) {
                const key = JSON.stringify([machine.id, source.id, source.machineId, source.engine, source.routeKind]);
                if (this.observations.has(key)) continue;
                const observer = this.options.observer.observeSource({ context: this.options.context, hostId: machine.id,
                    source, routeKind: source.routeKind, feed: this.options.catalog.feed(machine.id, source),
                    authorizationSignal: this.lifetime.signal, status: state => this.options.status(key, state) });
                this.observations.set(key, { hostId: machine.id, observer });
            }
            this.admitted.set(machine.id, this.generation(machine));
            this.options.status(catalogKey, null);
        } catch { if (!signal.aborted) this.options.status(catalogKey, 'recovering'); }
        finally { if (signal.aborted) this.options.status(catalogKey, null); }
    }
    async close(): Promise<void> {
        this.unsubscribe(); this.lifetime.abort();
        for (const key of this.observations.keys()) this.stop(key);
        await Promise.all([...this.stopping, ...[...this.requests.values()].map(request => request.done)]);
    }
}
