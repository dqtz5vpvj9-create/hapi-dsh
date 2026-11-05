/** Native DSH events are read verbatim. Commands remain with the original execution owner. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { DshOwnerConnection, type DshOwnerConnectionOptions } from './dsh-owner.ts';
import { DirectDshHistory, DSH_NATIVE_PAGE_EVENTS, type NativeDshReadIndex } from './dsh-history.ts';
import { OperationLedger } from './operation-ledger.ts';
import { SourceError, waitFor } from './errors.ts';
import { parseSourceSessionId, type DirectDshConfig, type SourceAdapter, type SourceChanges, type SourceChangesRequest,
    type SourceOperation, type SourcePage, type SourceReadRequest, type SourceReceipt, type SourceSession } from './protocol.ts';

interface State {
    epoch: string; nativeEpoch: string; nativeVersion: number; version: number; metadata: string;
    session: SourceSession; frames: SourceChanges[];
}
export class DirectDshAdapter implements SourceAdapter {
    readonly id: string; readonly machineId: string; readonly engine = 'dsh';
    private readonly owner: DshOwnerConnection;
    private readonly history: DirectDshHistory;
    private readonly ledger: OperationLedger;
    private readonly states = new Map<string, State>();
    private readonly refreshing = new Map<string, Promise<void>>();
    private readonly lifetime = new AbortController();
    private readonly revisions: DatabaseSync;
    constructor(config: DirectDshConfig, directory: string, ownerOptions?: DshOwnerConnectionOptions) {
        this.id = config.id; this.machineId = config.machineId;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.revisions = new DatabaseSync(join(directory, 'dsh-reading-revisions.sqlite'));
        this.revisions.exec('CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, epoch TEXT NOT NULL, nativeEpoch TEXT NOT NULL, nativeVersion INTEGER NOT NULL, version INTEGER NOT NULL, metadata TEXT NOT NULL)');
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
        const nativeId = this.identity(sessionId);
        const saved = this.revisions.prepare('SELECT metadata FROM revisions WHERE id=?').get(sessionId) as { metadata: string } | undefined;
        if (saved) this.owner.restoreReadingSession(JSON.parse(saved.metadata) as SourceSession);
        const session = await this.owner.readingSession(nativeId, signal);
        signal?.throwIfAborted();
        return session;
    }
    async resolve(sessionId: string, signal?: AbortSignal): Promise<SourceSession> {
        return this.session(sessionId, signal);
    }
    private save(state: State): void {
        this.revisions.prepare('INSERT OR REPLACE INTO revisions VALUES (?,?,?,?,?,?)').run(
            state.session.id, state.epoch, state.nativeEpoch, state.nativeVersion, state.version, state.metadata);
    }
    private serialize<T>(id: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const previous = this.refreshing.get(id);
        const pending = (previous ? previous.catch(() => {}) : Promise.resolve()).then(work);
        const barrier = pending.then(() => undefined);
        this.refreshing.set(id, barrier);
        void barrier.finally(() => { if (this.refreshing.get(id) === barrier) this.refreshing.delete(id); }).catch(() => {});
        return waitFor(pending, signal);
    }
    private refresh(session: SourceSession, signal?: AbortSignal): Promise<State> {
        const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        return this.serialize(session.id, async () => {
            combined.throwIfAborted();
            return this.refreshNow(session, await this.history.readIndex(session, combined));
        }, combined);
    }
    private async refreshNow(session: SourceSession, native: Pick<NativeDshReadIndex, 'epoch' | 'eventCount'>): Promise<State> {
        this.lifetime.signal.throwIfAborted();
        let state = this.states.get(session.id);
        let changed = false;
        // Re-observing an unchanged connection after a Host restart is not a
        // new native revision. State/capability changes still publish normally.
        const metadata = JSON.stringify({ ...session,
            connection: session.connection ? { state: session.connection.state } : undefined });
        if (!state) {
            const saved = this.revisions.prepare('SELECT * FROM revisions WHERE id=?').get(session.id) as unknown as Omit<State, 'frames' | 'session'> | undefined;
            state = saved ? { ...saved, session, frames: [] } : { epoch: native.epoch, nativeEpoch: native.epoch,
                nativeVersion: native.eventCount, version: 1, metadata, session, frames: [] };
            changed = saved === undefined;
            this.states.set(session.id, state);
        }
        if (native.eventCount !== state.nativeVersion || native.epoch !== state.nativeEpoch || metadata !== state.metadata) {
            changed = true;
            const reset = native.epoch !== state.nativeEpoch || native.eventCount < state.nativeVersion;
            let replayGap = false;
            let upserts: SourceChanges['upserts'] = [];
            if (!reset && native.eventCount > state.nativeVersion) {
                // Missed large bursts re-establish the subscription baseline;
                // no response can carry an unbounded transcript as one delta.
                replayGap = native.eventCount - state.nativeVersion > DSH_NATIVE_PAGE_EVENTS;
                if (!replayGap) {
                    const page = await this.history.read(session, { sessionId: session.id,
                        ...(state.nativeVersion ? { after: state.nativeVersion - 1 } : {}),
                        limit: native.eventCount - state.nativeVersion }, this.lifetime.signal);
                    if (page.epoch !== native.epoch)
                        return this.refreshNow(session, { epoch: page.epoch, eventCount: page.version });
                    upserts = page.entries.filter(entry => entry.event.seq >= state!.nativeVersion && entry.event.seq < native.eventCount);
                    replayGap = upserts.length !== native.eventCount - state.nativeVersion;
                    if (replayGap) upserts = [];
                }
            }
            const base = state.version++;
            if (reset) state.epoch = `${native.epoch}:${randomUUID()}`;
            state.nativeEpoch = native.epoch; state.nativeVersion = native.eventCount; state.metadata = metadata; state.session = session;
            state.frames.push({ session, epoch: state.epoch, base, version: state.version, reset: reset || replayGap, upserts, removed: [] });
            if (state.frames.length > 256) state.frames.shift();
        }
        if (changed) this.save(state);
        return state;
    }
    async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
        const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        const session = await this.session(request.sessionId, combined);
        return this.serialize(session.id, async () => {
            combined.throwIfAborted();
            const { epoch: _epoch, ...nativeRequest } = request;
            const page = await this.history.read(session, nativeRequest, combined);
            const state = await this.refreshNow(session, { epoch: page.epoch, eventCount: page.version });
            if (state.nativeEpoch !== page.epoch) throw new SourceError('STALE_VERSION', 'The native DSH generation changed during this read.');
            this.owner.assertReadingSession(session.nativeId);
            if (request.epoch && request.epoch !== state.epoch) throw new SourceError('STALE_VERSION', 'The native DSH source generation changed.');
            return { ...page, epoch: state.epoch, version: state.version, session: state.session };
        }, combined);
    }
    async *changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
        this.identity(request.sessionId);
        const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        let version = request.version, epoch = request.epoch, opening = true;
        while (!combined.aborted) {
            const session = await this.session(request.sessionId, combined), state = await this.refresh(session, combined);
            this.owner.assertReadingSession(session.nativeId);
            if (epoch !== state.epoch) {
                yield { session, epoch: state.epoch, base: version, version: state.version, reset: true, upserts: [], removed: [] };
                epoch = state.epoch; version = state.version;
            } else if (version < state.version) {
                const frames = state.frames.filter(frame => frame.version > version);
                if (!frames.length || frames[0]!.base !== version) {
                    yield { session, epoch, base: version, version: state.version, reset: true, upserts: [], removed: [] };
                    version = state.version;
                } else for (const frame of frames) { combined.throwIfAborted(); yield frame; version = frame.version; }
            } else if (version > state.version) {
                yield { session, epoch, base: version, version: state.version, reset: true, upserts: [], removed: [] };
                version = state.version;
            }
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
        return this.ledger.run(request, () => this.owner.operate(nativeId, request),
            () => this.reconcile(nativeId, request, this.lifetime.signal));
    }
    private async reconcile(nativeId: string, request: SourceOperation, signal: AbortSignal): Promise<SourceReceipt | undefined> {
        const ownerAdmission = await this.owner.readAdmission(nativeId, request, signal);
        return ownerAdmission ? { sessionId: request.sessionId, operationId: request.operationId, status: 'accepted',
            message: 'The original HAPI owner durably saved this message. Native DSH execution is not confirmed.', ownerAdmission } : undefined;
    }
    async receipt(request: SourceOperation, signal?: AbortSignal): Promise<SourceReceipt | null> {
        const nativeId = this.identity(request.sessionId);
        const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
        combined.throwIfAborted();
        const receipt = await waitFor(this.ledger.lookup(request, () => this.reconcile(nativeId, request, combined)), combined);
        // A receipt query cannot install a ledger marker or become a first send.
        if (!receipt || receipt.status !== 'accepted' || receipt.ownerAdmission || request.kind !== 'send') return receipt;
        // Already-accepted operation retries stay local. Only this explicit
        // read asks whether the original owner has taken durable responsibility.
        const ownerAdmission = await this.owner.readAdmission(nativeId, request, combined).catch(() => undefined);
        combined.throwIfAborted();
        return ownerAdmission ? { ...receipt, ownerAdmission } : receipt;
    }
    async dispose(): Promise<void> {
        this.lifetime.abort(); this.states.clear();
        await Promise.allSettled([...this.refreshing.values()]);
        await this.owner.dispose(); await this.history.dispose(); this.revisions.close();
    }
}
