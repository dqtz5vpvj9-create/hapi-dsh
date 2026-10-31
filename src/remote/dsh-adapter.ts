/** Native DSH events are read verbatim. Commands remain with the original execution owner. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DshOwnerConnection, type DshOwnerConnectionOptions } from './dsh-owner.ts';
import { DirectDshHistory, pageNativeEvents, type NativeDshSnapshot } from './dsh-history.ts';
import { OperationLedger } from './operation-ledger.ts';
import { SourceError } from './errors.ts';
import { parseSourceSessionId, type DirectDshConfig, type SourceAdapter, type SourceChanges, type SourceChangesRequest,
    type SourceOperation, type SourcePage, type SourceReadRequest, type SourceReceipt, type SourceSession } from './protocol.ts';

interface State {
    epoch: string; nativeEpoch: string; nativeVersion: number; version: number; metadata: string;
    session: SourceSession; frames: SourceChanges[]; snapshot: NativeDshSnapshot;
}
export class DirectDshAdapter implements SourceAdapter {
    readonly id: string; readonly machineId: string; readonly engine = 'dsh';
    private readonly owner: DshOwnerConnection;
    private readonly history: DirectDshHistory;
    private readonly ledger: OperationLedger;
    private readonly states = new Map<string, State>();
    private readonly refreshing = new Map<string, Promise<State>>();
    private readonly lifetime = new AbortController();
    private readonly generation = randomUUID();
    constructor(config: DirectDshConfig, directory: string, ownerOptions?: DshOwnerConnectionOptions) {
        this.id = config.id; this.machineId = config.machineId;
        this.owner = new DshOwnerConnection(config, ownerOptions);
        this.history = new DirectDshHistory(config.root);
        this.ledger = new OperationLedger(join(directory, 'operations'));
    }
    private identity(sessionId: string): string {
        this.lifetime.signal.throwIfAborted();
        const identity = parseSourceSessionId(sessionId);
        if (identity.sourceId !== this.id || identity.machineId !== this.machineId || identity.engine !== this.engine) {
            throw new SourceError('INVALID_REQUEST', 'This native DSH source does not own the requested session.');
        }
        return identity.nativeId;
    }
    async list(signal?: AbortSignal): Promise<SourceSession[]> {
        this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
        const sessions = await this.owner.catalog();
        const snapshots = await Promise.all(sessions.map(session => this.history.stat(session.nativeId, signal)));
        signal?.throwIfAborted();
        const stored = new Set<string>(snapshots.flatMap(snapshot => snapshot ? [snapshot.header.id] : []));
        return sessions.filter(session => stored.has(session.nativeId));
    }
    private async session(sessionId: string, signal?: AbortSignal): Promise<SourceSession> {
        this.identity(sessionId);
        const session = (await this.owner.catalog()).find(session => session.id === sessionId);
        signal?.throwIfAborted();
        if (!session) throw new SourceError('TARGET_UNAVAILABLE', 'The original DSH owner no longer advertises this native session.');
        return session;
    }
    private async refresh(session: SourceSession, signal?: AbortSignal): Promise<State> {
        const pending = this.refreshing.get(session.id);
        if (pending) return pending;
        const work = (async () => {
            const native = await this.history.snapshot(session, this.lifetime.signal);
            this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
            let state = this.states.get(session.id);
            const metadata = JSON.stringify(session);
            if (!state) {
                state = { epoch: `${native.epoch}:${this.generation}`, nativeEpoch: native.epoch, nativeVersion: native.version,
                    version: 1, metadata, session, frames: [], snapshot: native };
                this.states.set(session.id, state);
            } else if (native.version !== state.nativeVersion || native.epoch !== state.nativeEpoch || metadata !== state.metadata) {
                const reset = native.epoch !== state.nativeEpoch || native.version < state.nativeVersion;
                const upserts = reset ? [] : native.events.slice(state.nativeVersion)
                    .map(event => ({ type: 'event' as const, event }));
                const base = state.version++;
                if (reset) state.epoch = `${native.epoch}:${randomUUID()}`;
                state.nativeEpoch = native.epoch; state.nativeVersion = native.version; state.metadata = metadata; state.session = session;
                state.snapshot = native;
                state.frames.push({ session, epoch: state.epoch, base, version: state.version, reset, upserts, removed: [] });
                // A reader older than the retained journal explicitly recovers its accepted window.
                if (state.frames.length > 256) state.frames.shift();
            }
            return state;
        })().finally(() => { if (this.refreshing.get(session.id) === work) this.refreshing.delete(session.id); });
        this.refreshing.set(session.id, work);
        return work;
    }
    async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
        const session = await this.session(request.sessionId, signal), state = await this.refresh(session, signal);
        if (request.epoch && request.epoch !== state.epoch) throw new SourceError('STALE_VERSION', 'The native DSH source generation changed.');
        const { epoch: _epoch, ...nativeRequest } = request;
        const page = pageNativeEvents(state.session, state.snapshot, nativeRequest);
        return { ...page, epoch: state.epoch, version: state.version, session: state.session };
    }
    async *changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
        this.identity(request.sessionId);
        const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        let version = request.version, epoch = request.epoch, opening = true;
        while (!combined.aborted) {
            const session = await this.session(request.sessionId, combined), state = await this.refresh(session, combined);
            if (epoch !== state.epoch) {
                yield { session, epoch: state.epoch, base: version, version: state.version, reset: true, upserts: [], removed: [] };
                epoch = state.epoch; version = state.version;
            } else if (version < state.version) {
                const frames = state.frames.filter(frame => frame.version > version);
                if (!frames.length || frames[0]!.base !== version) throw new SourceError('STALE_VERSION', 'The native DSH reader must recover a missed source revision.');
                for (const frame of frames) { combined.throwIfAborted(); yield frame; version = frame.version; }
            } else if (version > state.version) throw new SourceError('STALE_VERSION', 'The native DSH source revision changed.');
            else if (opening) {
                // A quiet but successfully opened subscription accepts its
                // cursor, so repeated idle reconnects do not look unopened.
                yield { session, epoch, base: version, version, reset: false, upserts: [], removed: [] };
            }
            opening = false;
            await delay(1000, undefined, { signal: combined });
        }
    }
    operate(request: SourceOperation): Promise<SourceReceipt> {
        const nativeId = this.identity(request.sessionId);
        return this.ledger.run(request, () => this.owner.operate(nativeId, request));
    }
    async dispose(): Promise<void> {
        this.lifetime.abort(); this.states.clear();
        await Promise.allSettled([...this.refreshing.values()]);
        await this.owner.dispose(); await this.history.dispose();
    }
}
