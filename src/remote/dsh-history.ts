/** Direct, read-only access to native DSH session logs. */
import { Context } from '@deepseek-ai/cordis';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { apply as applyJsonlPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { SessionPersistenceRevision, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import { SourceError, waitFor } from './errors.ts';
import { parseSourceSessionId, type SourceChanges, type SourceChangesRequest, type SourcePage, type SourceReadRequest, type SourceSession } from './protocol.ts';

/** Native persistence pages stay small; original event sequence numbers are never reassigned. */
export const DSH_NATIVE_PAGE_EVENTS = 160;

export interface NativeDshReadBatch {
    header: SessionPersistenceSnapshot['header'];
    events: readonly SessionEvent[];
    revision: SessionPersistenceRevision;
    offset: number;
    total: number | undefined;
}

export interface NativeDshSnapshot {
    readonly header: SessionPersistenceSnapshot['header'];
    readonly events: readonly SessionEvent[];
    readonly revision: SessionPersistenceRevision;
    readonly epoch: string;
    /** Native DSH logs are contiguous from seq 0, so the count is the source version. */
    readonly version: number;
    readonly dependencies: NativeEventDependencyIndex;
}

export interface NativeEventDependencyIndex {
    readonly turns: ReadonlyMap<number, number>;
    readonly steps: ReadonlyMap<string, number>;
    readonly calls: ReadonlyMap<string, number>;
    readonly assistantsByStep: ReadonlyMap<string, readonly number[]>;
}

interface CachedHistory {
    readonly snapshot: SessionPersistenceSnapshot;
    readonly events: readonly SessionEvent[];
    readonly dependencies: NativeEventDependencyIndex;
}

export interface NativeDshPageSelection {
    entries: SourcePage['entries'];
    before: number | null;
    after: number | null;
    hasBefore: boolean;
    hasAfter: boolean;
    context: number[];
}

function numberField(event: SessionEvent, key: string): number | undefined {
    const value = (event.data as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function callIdFor(event: SessionEvent): string | undefined {
    const data = event.data as Record<string, unknown>;
    if (event.type === 'tool/call') return typeof data.callId === 'string' ? data.callId : undefined;
    if (event.type === 'tool/result') {
        const message = data.message as Record<string, unknown> | undefined;
        return typeof message?.toolCallId === 'string' ? message.toolCallId : undefined;
    }
    return undefined;
}

function assistantCallIds(event: SessionEvent): string[] {
    if (event.type !== 'assistant/message') return [];
    const message = (event.data as Record<string, unknown>).message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap(block => {
        if (typeof block !== 'object' || block === null) return [];
        const record = block as Record<string, unknown>;
        return record.type === 'tool-call' && typeof record.id === 'string' ? [record.id] : [];
    });
}

function dependencyIndex(events: readonly SessionEvent[]): NativeEventDependencyIndex {
    const turns = new Map<number, number>(), steps = new Map<string, number>(), calls = new Map<string, number>();
    const assistantsByStep = new Map<string, number[]>();
    for (const event of events) {
        const turn = numberField(event, 'turn'), step = numberField(event, 'step');
        if (event.type === 'turn/start' && turn !== undefined && !turns.has(turn)) turns.set(turn, event.seq);
        if (event.type === 'step/start' && turn !== undefined && step !== undefined) steps.set(`${turn}:${step}`, event.seq);
        const callId = callIdFor(event);
        if (event.type === 'tool/call' && callId !== undefined) calls.set(callId, event.seq);
        if (event.type === 'assistant/message' && turn !== undefined && step !== undefined) {
            const key = `${turn}:${step}`, values = assistantsByStep.get(key) ?? [];
            values.push(event.seq); assistantsByStep.set(key, values);
        }
    }
    return { turns, steps, calls, assistantsByStep };
}

/**
 * Select one native log page and include the lifecycle and tool-call records
 * needed to interpret its body. Context entries remain outside its boundaries.
 * `sourceEventSeqs` cites model-surface provenance (including whole compacted
 * ranges), not Chat rendering dependencies. Preserve those annotations on the
 * original event, but let earlier pages load the cited transcript in log order.
 */
function selectNativeEventPage(events: readonly SessionEvent[], dependencies: NativeEventDependencyIndex,
    request: Pick<SourceReadRequest, 'before' | 'after' | 'around' | 'limit'>): NativeDshPageSelection {
    const limit = Math.min(request.limit ?? DSH_NATIVE_PAGE_EVENTS, DSH_NATIVE_PAGE_EVENTS);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new SourceError('INVALID_REQUEST', 'Native history page limit must be a positive integer.');

    let body: readonly SessionEvent[];
    if (request.around !== undefined) {
        const around = Math.min(request.around, events.length);
        const leftStart = Math.max(0, around - Math.floor(limit / 2));
        const left = events.slice(leftStart, around);
        const right = events.slice(around, around + limit - left.length);
        body = [...left, ...right];
    } else if (request.after !== undefined) {
        const start = Math.min(events.length, request.after + 1);
        body = events.slice(start, start + limit);
    } else {
        const end = Math.min(events.length, request.before ?? events.length);
        body = events.slice(Math.max(0, end - limit), end);
    }

    const selected = new Map<number, SessionEvent>(body.map(event => [event.seq, event]));
    const context = new Set<number>();
    const addContext = (seq: number): void => {
        if (selected.has(seq) || context.has(seq)) return;
        const event = events[seq];
        if (!event || event.seq !== seq) throw new SourceError('STALE_VERSION', 'A native history dependency is no longer available.');
        context.add(seq);
        const turn = numberField(event, 'turn'), step = numberField(event, 'step');
        if (turn !== undefined) {
            const start = dependencies.turns.get(turn);
            if (start !== undefined && start !== seq) addContext(start);
        }
        if (turn !== undefined && step !== undefined) {
            const start = dependencies.steps.get(`${turn}:${step}`);
            if (start !== undefined && start !== seq) addContext(start);
        }
        const callId = callIdFor(event);
        if (event.type === 'tool/result' && callId !== undefined) {
            const call = dependencies.calls.get(callId);
            if (call !== undefined) addContext(call);
        }
        if ((event.type === 'tool/call' || event.type === 'tool/result') && turn !== undefined && step !== undefined) {
            for (const assistant of dependencies.assistantsByStep.get(`${turn}:${step}`) ?? []) addContext(assistant);
        }
        for (const callId of assistantCallIds(event)) {
            const call = dependencies.calls.get(callId);
            if (call !== undefined) addContext(call);
        }
        const headerSeq = numberField(event, 'headerSeq');
        if (headerSeq !== undefined) addContext(headerSeq);
    };

    for (const event of body) {
        const turn = numberField(event, 'turn'), step = numberField(event, 'step');
        if (turn !== undefined) {
            const start = dependencies.turns.get(turn);
            if (start !== undefined) addContext(start);
        }
        if (turn !== undefined && step !== undefined) {
            const start = dependencies.steps.get(`${turn}:${step}`);
            if (start !== undefined) addContext(start);
        }
        const callId = callIdFor(event);
        if (event.type === 'tool/result' && callId !== undefined) {
            const call = dependencies.calls.get(callId);
            if (call !== undefined) addContext(call);
        }
        if ((event.type === 'tool/call' || event.type === 'tool/result') && turn !== undefined && step !== undefined) {
            for (const seq of dependencies.assistantsByStep.get(`${turn}:${step}`) ?? []) addContext(seq);
        }
        for (const callId of assistantCallIds(event)) {
            const call = dependencies.calls.get(callId);
            if (call !== undefined) addContext(call);
        }
        const headerSeq = numberField(event, 'headerSeq');
        if (headerSeq !== undefined) addContext(headerSeq);
    }

    const orderedSeqs = [...selected.keys(), ...context].sort((left, right) => left - right);
    const first = body[0]?.seq, last = body.at(-1)?.seq;
    return {
        entries: orderedSeqs.map(seq => ({ type: 'event', event: events[seq]! })),
        before: first ?? null,
        after: last ?? null,
        hasBefore: first !== undefined && first > 0,
        hasAfter: last !== undefined && last < events.length - 1,
        context: [...context].sort((left, right) => left - right),
    };
}

/** Build a SourcePage from one accepted revision-consistent native snapshot. */
export function pageNativeEvents(session: SourceSession, snapshot: NativeDshSnapshot, request: SourceReadRequest): SourcePage {
    if (request.sessionId !== session.id) throw new SourceError('INVALID_REQUEST', 'A native DSH request belongs to another source session.');
    if (request.epoch !== undefined && request.epoch !== snapshot.epoch) throw new SourceError('STALE_VERSION', 'The native DSH history cursor belongs to another session revision.');
    return { session, epoch: snapshot.epoch, version: snapshot.version, ...selectNativeEventPage(snapshot.events, snapshot.dependencies, request) };
}

/**
 * A storage-only reader for native DSH logs. Its private Cordis context mounts
 * only the official JSONL persistence provider; it never creates a Session,
 * Agent, or writer handle.
 */
export class DirectDshHistory {
    private readonly context = new Context();
    private readonly ready: Promise<void>;
    private readonly cache = new Map<string, CachedHistory>();
    private readonly loads = new Map<string, Promise<CachedHistory>>();
    private disposed = false;

    constructor(root: string) {
        this.ready = applyJsonlPersistence(this.context, { root, compression: 'zstd' });
    }

    private async persistence(): Promise<Context['sessionPersistence']> {
        if (this.disposed) throw new SourceError('DISPOSED', 'The native DSH history reader has been disposed.');
        await this.ready;
        return this.context.sessionPersistence;
    }

    /** Header-only snapshots from the official persistence catalog. */
    async list(signal?: AbortSignal): Promise<readonly SessionPersistenceSnapshot[]> {
        const persistence = await this.persistence();
        return waitFor(persistence.list(signal ? { signal } : undefined), signal);
    }

    /** Read one lightweight native header/revision without enumerating the catalog. */
    async stat(nativeId: string, signal?: AbortSignal): Promise<SessionPersistenceSnapshot | undefined> {
        const persistence = await this.persistence();
        return waitFor(persistence.stat(SessionId(nativeId), signal ? { signal } : undefined), signal);
    }

    /** Read a bounded range of original events without acquiring native write ownership. */
    async readEvents(nativeId: string, offset = 0, length = DSH_NATIVE_PAGE_EVENTS, signal?: AbortSignal): Promise<NativeDshReadBatch> {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > DSH_NATIVE_PAGE_EVENTS) {
            throw new SourceError('INVALID_REQUEST', `Native DSH reads are limited to ${DSH_NATIVE_PAGE_EVENTS} events per page.`);
        }
        const persistence = await this.persistence();
        const id = SessionId(nativeId);
        const snapshot = await waitFor(persistence.stat(id, signal ? { signal } : undefined), signal);
        if (!snapshot) throw new SourceError('TARGET_UNAVAILABLE', 'The native DSH session is unavailable.');
        const handle = await waitFor(persistence.open(id, 'read', signal ? { signal } : undefined), signal);
        try {
            const result = await waitFor(handle.read(offset, length, signal ? { signal } : undefined), signal);
            return { header: snapshot.header, events: result.events, revision: snapshot.revision, offset, total: snapshot.eventCount };
        } finally { await handle.close(); }
    }

    /** Read a SourcePage from a canonical DSH session identity, preserving native seq. */
    async read(session: SourceSession, request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
        this.assertSource(session, request.sessionId);
        const snapshot = await this.snapshot(session, signal);
        return pageNativeEvents(session, snapshot, request);
    }

    /** Return one revision-consistent native prefix for paging and change publication. */
    async snapshot(session: SourceSession, signal?: AbortSignal): Promise<NativeDshSnapshot> {
        this.assertSource(session, session.id);
        const cached = await this.history(session.nativeId, signal);
        return { header: cached.snapshot.header, events: cached.events, revision: cached.snapshot.revision,
            epoch: `${session.id}:${cached.snapshot.header.createdAt}`, version: cached.events.length, dependencies: cached.dependencies };
    }

    /**
     * Return one append-only change frame for a caller's current version.
     * The owner adapter can poll this method and supply refreshed catalog metadata.
     */
    async changes(session: SourceSession, request: SourceChangesRequest, signal?: AbortSignal): Promise<SourceChanges | undefined> {
        this.assertSource(session, request.sessionId);
        const cached = await this.snapshot(session, signal), version = cached.version;
        if (request.epoch !== cached.epoch || request.version > version) {
            return { session, epoch: cached.epoch, base: request.version, version, reset: true, upserts: [], removed: [] };
        }
        if (request.version === version) return undefined;
        return {
            session, epoch: cached.epoch, base: request.version, version, reset: false,
            upserts: cached.events.slice(request.version).map(event => ({ type: 'event', event })), removed: [],
        };
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        await this.ready;
        await this.context.fiber.dispose();
        this.cache.clear(); this.loads.clear();
    }

    private assertSource(session: SourceSession, requestedId: string): void {
        if (requestedId !== session.id || session.engine !== 'dsh') throw new SourceError('INVALID_REQUEST', 'A native DSH request belongs to another source session.');
        let identity;
        try { identity = parseSourceSessionId(session.id); }
        catch { throw new SourceError('INVALID_REQUEST', 'The native DSH source identity is invalid.'); }
        if (identity.engine !== 'dsh' || identity.nativeId !== session.nativeId
            || identity.sourceId !== session.sourceId || identity.machineId !== session.machineId) {
            throw new SourceError('INVALID_REQUEST', 'The native DSH source identity does not match its catalog entry.');
        }
    }

    private async history(nativeId: string, signal?: AbortSignal): Promise<CachedHistory> {
        const persistence = await this.persistence(), id = SessionId(nativeId);
        for (;;) {
            signal?.throwIfAborted();
            const snapshot = await waitFor(persistence.stat(id, signal ? { signal } : undefined), signal);
            if (!snapshot) throw new SourceError('TARGET_UNAVAILABLE', 'The native DSH session is unavailable.');
            const cached = this.cache.get(nativeId);
            if (cached?.snapshot.revision === snapshot.revision) return cached;
            const active = this.loads.get(nativeId);
            if (active) {
                const loaded = await waitFor(active, signal);
                if (loaded.snapshot.revision === snapshot.revision) return loaded;
                continue;
            }
            const loading = this.loadSnapshot(nativeId, snapshot, signal);
            this.loads.set(nativeId, loading);
            try {
                const loaded = await waitFor(loading, signal);
                const latest = await waitFor(persistence.stat(id, signal ? { signal } : undefined), signal);
                if (latest?.revision !== snapshot.revision) continue;
                this.cache.set(nativeId, loaded);
                return loaded;
            } finally {
                if (this.loads.get(nativeId) === loading) this.loads.delete(nativeId);
            }
        }
    }

    private async loadSnapshot(nativeId: string, snapshot: SessionPersistenceSnapshot, signal?: AbortSignal): Promise<CachedHistory> {
        const persistence = await this.persistence(), handle = await waitFor(persistence.open(SessionId(nativeId), 'read', signal ? { signal } : undefined), signal);
        try {
            const result = await waitFor(handle.read(0, snapshot.eventCount, signal ? { signal } : undefined), signal);
            return { snapshot, events: result.events, dependencies: dependencyIndex(result.events) };
        } finally { await handle.close(); }
    }
}
