/** Host-owned, bounded attention events. No transcript, rendering state or Agent operation is retained. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { waitFor } from '../remote/errors.ts';
import { appAccountScopeSchema, appEventPositionSchema, appSourceKey, appSourceRouteSchema,
    type AppEventPosition, type AppServiceContext, type AppSourceRoute } from './app-service-types.ts';
import type { AppNotification } from '../notification-types.ts';
import { parseSourceSessionId } from '../remote/protocol.ts';

const id = z.string().min(1).max(2048);
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const sourceAttentionEventSchema = z.strictObject({
    id, kind: z.enum(['completed', 'failed', 'request']), position: appEventPositionSchema,
    requestId: id.optional(), createdAt: ordinal,
}).refine(event => (event.kind === 'request') === (event.requestId !== undefined), 'A request event retains its exact request ID');
export type SourceAttentionEvent = z.infer<typeof sourceAttentionEventSchema>;
export interface NotificationCursor { epoch: string; version: number }
export interface SourceAttentionBatch {
    cursor: NotificationCursor; base: number; reset: boolean;
    /** Events already present when this connection opened are recovery, not new completions. */
    replay: boolean; events: readonly SourceAttentionEvent[];
}
export interface SourceAttentionFeed {
    notificationEvents(sessionId: string, cursor: NotificationCursor | undefined, signal: AbortSignal): AsyncIterable<SourceAttentionBatch>;
}
export interface SourceAttentionSourceBatch extends Omit<SourceAttentionBatch, 'events'> {
    events: readonly { sessionId: string; event: SourceAttentionEvent }[];
}
export interface SourceAttentionSourceFeed {
    attentionEvents(cursor: NotificationCursor | undefined, signal: AbortSignal): AsyncIterable<SourceAttentionSourceBatch>;
}

/** One native source journal, including sessions that have never appeared in a Pane or catalog. */
export class SourceAttentionAggregateJournal implements SourceAttentionSourceFeed {
    private epoch = randomUUID();
    private version = 0;
    private readonly entries: Array<{ version: number; sessionId: string; event: SourceAttentionEvent }> = [];
    private readonly listeners = new Set<() => void>();
    constructor(private readonly lifetime: AbortSignal, private readonly maxEvents = 2048) {}
    publish(sessionId: string, value: SourceAttentionEvent): void {
        if (this.lifetime.aborted) return;
        id.parse(sessionId);
        const event = sourceAttentionEventSchema.parse(value);
        if (this.entries.some(entry => entry.sessionId === sessionId && entry.event.id === event.id)) return;
        this.entries.push({ version: ++this.version, sessionId, event });
        if (this.entries.length > this.maxEvents) this.entries.shift();
        for (const wake of [...this.listeners]) wake();
    }
    reset(): void {
        this.epoch = randomUUID(); this.version = 0; this.entries.length = 0;
        for (const wake of [...this.listeners]) wake();
    }
    async *attentionEvents(saved: NotificationCursor | undefined, signal: AbortSignal): AsyncIterable<SourceAttentionSourceBatch> {
        const lifetime = AbortSignal.any([signal, this.lifetime]);
        let cursor = saved;
        while (!lifetime.aborted) {
            const first = this.entries[0]?.version ?? this.version + 1;
            if (!cursor || cursor.epoch !== this.epoch || cursor.version > this.version || cursor.version < first - 1) {
                const base = cursor?.version ?? 0;
                cursor = { epoch: this.epoch, version: this.version };
                yield { cursor, base, reset: true, replay: true, events: [] }; continue;
            }
            const next = this.entries.find(entry => entry.version > cursor!.version);
            if (next) {
                const base = cursor.version; cursor = { epoch: this.epoch, version: next.version };
                // These are original native events after the admitted cursor,
                // including events missed during a transport interruption.
                yield { cursor, base, reset: false, replay: false, events: [{ sessionId: next.sessionId, event: next.event }] }; continue;
            }
            await new Promise<void>((resolve, reject) => {
                const clean = () => { this.listeners.delete(wake); lifetime.removeEventListener('abort', abort); };
                const wake = () => { clean(); resolve(); };
                const abort = () => { clean(); reject(lifetime.reason); };
                this.listeners.add(wake); lifetime.addEventListener('abort', abort, { once: true });
                if (lifetime.aborted) abort(); else if (this.epoch !== cursor!.epoch || this.version !== cursor!.version) wake();
            });
        }
        lifetime.throwIfAborted();
    }
}

interface Journal {
    epoch: string; version: number; readers: number;
    entries: Array<{ version: number; event: SourceAttentionEvent }>;
    listeners: Set<() => void>;
}
/** Shares the original source connection. Only actively observed sessions receive a journal. */
export class SourceAttentionJournal implements SourceAttentionFeed {
    private readonly sessions = new Map<string, Journal>();
    constructor(private readonly lifetime: AbortSignal, private readonly maxEvents = 256, private readonly maxSessions = 256) {}
    publish(sessionId: string, value: SourceAttentionEvent): void {
        const state = this.sessions.get(sessionId);
        if (!state || this.lifetime.aborted) return;
        const event = sourceAttentionEventSchema.parse(value);
        if (state.entries.some(entry => entry.event.id === event.id)) return;
        state.entries.push({ version: ++state.version, event });
        if (state.entries.length > this.maxEvents) state.entries.shift();
        for (const wake of [...state.listeners]) wake();
    }
    reset(): void {
        for (const state of this.sessions.values()) {
            state.epoch = randomUUID(); state.version = 0; state.entries.length = 0;
            for (const wake of [...state.listeners]) wake();
        }
    }
    async *notificationEvents(sessionId: string, saved: NotificationCursor | undefined, signal: AbortSignal): AsyncIterable<SourceAttentionBatch> {
        const lifetime = AbortSignal.any([this.lifetime, signal]); lifetime.throwIfAborted();
        let state = this.sessions.get(sessionId);
        if (!state) {
            if (this.sessions.size >= this.maxSessions) throw new Error('The background source observer limit has been reached');
            state = { epoch: randomUUID(), version: 0, readers: 0, entries: [], listeners: new Set() };
            this.sessions.set(sessionId, state);
        }
        state.readers++;
        const openedAt = { epoch: state.epoch, version: state.version };
        let cursor = saved;
        try {
            while (!lifetime.aborted) {
                const first = state.entries[0]?.version ?? state.version + 1;
                if (!cursor || cursor.epoch !== state.epoch || cursor.version > state.version || cursor.version < first - 1) {
                    cursor = { epoch: state.epoch, version: state.version };
                    yield { cursor, base: saved?.version ?? 0, reset: true, replay: true, events: [] };
                    continue;
                }
                const next = state.entries.find(entry => entry.version > cursor!.version);
                if (next) {
                    const base = cursor.version; cursor = { epoch: state.epoch, version: next.version };
                    yield { cursor, base, reset: false, replay: cursor.epoch === openedAt.epoch && next.version <= openedAt.version, events: [next.event] };
                    continue;
                }
                await new Promise<void>((resolve, reject) => {
                    const clean = () => { state!.listeners.delete(wake); lifetime.removeEventListener('abort', abort); };
                    const wake = () => { clean(); resolve(); };
                    const abort = () => { clean(); reject(lifetime.reason); };
                    state!.listeners.add(wake); lifetime.addEventListener('abort', abort, { once: true });
                    if (lifetime.aborted) abort(); else if (state!.epoch !== cursor!.epoch || state!.version !== cursor!.version) wake();
                });
            }
            lifetime.throwIfAborted();
        } finally {
            if (--state.readers === 0) this.sessions.delete(sessionId);
        }
    }
}

export type NotificationObservationState = 'connecting' | 'watching' | 'recovering' | 'denied' | 'closed';
export interface NotificationObservation {
    readonly done: Promise<void>;
    stop(): Promise<void>;
}
export interface NotificationObservationOptions {
    context: AppServiceContext; source: AppSourceRoute; feed: SourceAttentionFeed;
    /** The Host aborts this on account/logout/source-grant loss, even while the source is idle. */
    authorizationSignal: AbortSignal;
    status?(state: NotificationObservationState): void;
}
export interface SourceNotificationObservationOptions {
    context: AppServiceContext; hostId: string;
    source: { machineId: string; id: string; engine: string };
    /** Ordinary/federated DSH passes its real Host route; HHPI is the default. */
    routeKind?: AppSourceRoute['kind'];
    feed: SourceAttentionSourceFeed; authorizationSignal: AbortSignal;
    status?(state: NotificationObservationState): void;
}
/** One background subscription per account/origin/full source route, independently of all Panes. */
export class SourceNotificationObserver {
    private readonly observations = new Map<string, NotificationObservation>();
    private readonly lifetime = new AbortController();
    constructor(private readonly publish: (context: AppServiceContext, notification: AppNotification) => Promise<unknown>,
        private readonly options: { maxSources?: number; reconnectMs?: number } = {}) {}
    observeSource(options: SourceNotificationObservationOptions): NotificationObservation {
        const scope = appAccountScopeSchema.parse(options.context.scope), kind = options.routeKind ?? 'hhpi';
        const context = { scope, authorizeSource: options.context.authorizeSource.bind(options.context) };
        const key = JSON.stringify(['source', scope.accountId, scope.origin, options.hostId, kind, options.source.machineId, options.source.id, options.source.engine]);
        if (this.observations.has(key)) throw new Error('This account already observes the original source');
        if (this.observations.size >= (this.options.maxSources ?? 256)) throw new Error('The account source observer limit has been reached');
        const stop = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, stop.signal, options.authorizationSignal]);
        const run = async (): Promise<void> => {
            let cursor: NotificationCursor | undefined;
            const authorize = async (source: AppSourceRoute): Promise<boolean> => {
                try { signal.throwIfAborted(); await waitFor(Promise.resolve(context.authorizeSource(source)), signal); signal.throwIfAborted(); return true; }
                catch { return false; }
            };
            while (!signal.aborted) {
                options.status?.('connecting');
                try {
                    for await (const batch of options.feed.attentionEvents(cursor, signal)) {
                        signal.throwIfAborted();
                        if (!batch.reset && cursor && (batch.cursor.epoch !== cursor.epoch || batch.base !== cursor.version)) {
                            cursor = undefined; options.status?.('recovering'); break;
                        }
                        if (batch.events.length > 160) throw new Error('The source attention batch exceeded its event budget');
                        if (batch.reset) options.status?.('recovering');
                        for (const item of batch.events) {
                            if (batch.reset || batch.replay) continue;
                            const event = sourceAttentionEventSchema.parse(item.event);
                            let source: AppSourceRoute;
                            if (kind === 'hhpi') {
                                const identity = parseSourceSessionId(item.sessionId);
                                if (identity.sourceId !== options.source.id || identity.machineId !== options.source.machineId || identity.engine !== options.source.engine) continue;
                                source = appSourceRouteSchema.parse({ kind, hostId: options.hostId, sessionId: item.sessionId, identity });
                            } else source = appSourceRouteSchema.parse({ kind, hostId: options.hostId, sessionId: item.sessionId });
                            if (!await authorize(source)) continue;
                            const target = event.kind === 'request'
                                ? { kind: 'request' as const, source, position: event.position, requestId: event.requestId! }
                                : { kind: 'reading' as const, source, position: event.position };
                            await waitFor(this.publish(context, {
                                id: JSON.stringify([source.hostId, source.kind, source.sessionId, event.id]), scope,
                                kind: event.kind, target, title: event.kind === 'completed' ? 'Task completed' : event.kind === 'failed' ? 'Task failed' : 'Your response is needed',
                                body: '', createdAt: event.createdAt,
                            }), signal);
                            signal.throwIfAborted();
                        }
                        cursor = batch.cursor; options.status?.('watching');
                    }
                } catch { if (signal.aborted) break; options.status?.('recovering'); }
                if (!signal.aborted) await delay(this.options.reconnectMs ?? 1000, undefined, { signal }).catch(() => {});
            }
        };
        const done = Promise.resolve().then(run).finally(() => { this.observations.delete(key); options.status?.('closed'); });
        const observation = { done, async stop() { stop.abort(); await done; } };
        this.observations.set(key, observation); return observation;
    }
    observe(options: NotificationObservationOptions): NotificationObservation {
        const source = appSourceRouteSchema.parse(options.source), scope = appAccountScopeSchema.parse(options.context.scope);
        const context = { scope, authorizeSource: options.context.authorizeSource.bind(options.context) };
        const key = appSourceKey(scope, source);
        if (this.observations.has(key)) throw new Error('This account already observes the original source');
        if (this.observations.size >= (this.options.maxSources ?? 256)) throw new Error('The account source observer limit has been reached');
        const stop = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, stop.signal, options.authorizationSignal]);
        const run = async (): Promise<void> => {
            let cursor: NotificationCursor | undefined;
            const authorize = async (): Promise<boolean> => {
                try { signal.throwIfAborted(); await waitFor(Promise.resolve(context.authorizeSource(source)), signal); signal.throwIfAborted(); return true; }
                catch { if (!signal.aborted) options.status?.('denied'); return false; }
            };
            while (!signal.aborted) {
                if (!await authorize()) return;
                options.status?.('connecting');
                try {
                    for await (const batch of options.feed.notificationEvents(source.sessionId, cursor, signal)) {
                        if (!await authorize()) return;
                        if (!batch.reset && cursor && (batch.cursor.epoch !== cursor.epoch || batch.base !== cursor.version)) {
                            // Do not guess at an unreported gap. Reopen at the source head.
                            cursor = undefined; options.status?.('recovering'); break;
                        }
                        if (batch.events.length > 160) throw new Error('The source attention batch exceeded its event budget');
                        if (batch.reset) options.status?.('recovering');
                        for (const value of batch.events) {
                            const event = sourceAttentionEventSchema.parse(value);
                            if (batch.reset || batch.replay) continue;
                            if (!await authorize()) return;
                            const target = event.kind === 'request'
                                ? { kind: 'request' as const, source, position: event.position, requestId: event.requestId! }
                                : { kind: 'reading' as const, source, position: event.position };
                            await waitFor(this.publish(context, {
                                id: JSON.stringify([source.hostId, source.kind, source.sessionId, event.id]), scope,
                                kind: event.kind, target, title: event.kind === 'completed' ? 'Task completed' : event.kind === 'failed' ? 'Task failed' : 'Your response is needed',
                                body: '', createdAt: event.createdAt,
                            }), signal);
                            if (!await authorize()) return;
                        }
                        cursor = batch.cursor; options.status?.('watching');
                    }
                } catch { if (signal.aborted) break; options.status?.('recovering'); }
                if (!signal.aborted) await delay(this.options.reconnectMs ?? 1000, undefined, { signal }).catch(() => {});
            }
        };
        const done = Promise.resolve().then(run).finally(() => { this.observations.delete(key); options.status?.('closed'); });
        const observation = { done, async stop() { stop.abort(); await done; } };
        this.observations.set(key, observation);
        return observation;
    }
    async close(): Promise<void> { this.lifetime.abort(); await Promise.all([...this.observations.values()].map(value => value.done)); }
}

/** Native DSH events retain their source seq; the source supplies its current epoch when needed. */
export function attentionFromDshEvent(event: { type: string; seq: number; time: number; data: unknown }, position: AppEventPosition): SourceAttentionEvent | undefined {
    if (event.type !== 'turn/end' || typeof event.data !== 'object' || event.data === null) return;
    const reason = (event.data as { reason?: { kind?: unknown } }).reason?.kind;
    if (reason !== 'completed' && reason !== 'error') return;
    return { id: JSON.stringify(['turn/end', event.seq]), kind: reason === 'completed' ? 'completed' : 'failed', position, createdAt: event.time };
}
