/** Direct source-side Codex v2 adapter. Native thread identity and execution ownership are preserved. */
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { SourceError, waitFor } from './errors.ts';
import { CodexRpc, CodexRpcError, type NativeNotification, type NativeRequest } from './codex-rpc.ts';
import { CodexHistory } from './codex-history.ts';
import { SourceEventIndex } from './event-index.ts';
import { OperationLedger, CreationLedger } from './operation-ledger.ts';
import { isRecord, itemListSchema, loadedListSchema, nativeItemSchema, nativeThreadSchema, nativeTurnSchema, threadListSchema, threadResponseSchema, turnListSchema, type NativeItemEntry, type NativeThread, type NativeTurn } from './codex-native.ts';
import { parseSourceSessionId, sourceSessionId, type DirectCodexConfig, type SourceAdapter, type SourceChanges, type SourceChangesRequest, type SourceCreateRequest, type SourceCreationReceipt, type SourceOperation, type SourcePage, type SourceReadRequest, type SourceReceipt, type SourceSession } from './protocol.ts';

interface ThreadOwner {
    native: NativeThread; session: SourceSession; history?: CodexHistory;
    preparing?: Promise<void>; refreshing?: Promise<void>; dirty: boolean; full: boolean;
    /** Versions only cover accepted source snapshots; native delta strings are not reapplied over snapshots. */
    pending: NativeNotification[]; pendingBytes: number; pendingOverflow: boolean; ready: boolean;
}
interface PendingApproval { request: NativeRequest; sessionId: string; acknowledged: Promise<void>; resolve(): void; submitted: boolean }
interface Tail { last: string; previous: string | null }
interface AdapterOptions { rpc?: CodexRpc; pollMs?: number }
const MAX_CATALOG = 10_000;
const MAX_NATIVE_PAGES = 10_000;
const ACK_TIMEOUT = 15_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const done = (): void => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});

export class DirectCodexAdapter implements SourceAdapter {
    readonly id: string; readonly machineId: string; readonly engine = 'codex';
    private readonly rpc: CodexRpc;
    private readonly ledger: OperationLedger;
    private readonly creations: CreationLedger;
    private readonly threads = new Map<string, ThreadOwner>();
    private readonly loaded = new Set<string>();
    private readonly approvals = new Map<string, PendingApproval>();
    private readonly lifetime = new AbortController();
    private readonly stops: Array<() => void>;
    private catalogRead: Promise<SourceSession[]> | undefined;
    private catalogAt = 0;
    private readonly timer: ReturnType<typeof setInterval>;
    private disposed = false;

    constructor(private readonly config: DirectCodexConfig, private readonly directory: string, options: AdapterOptions = {}) {
        this.id = config.id; this.machineId = config.machineId;
        this.rpc = options.rpc ?? new CodexRpc(config);
        this.ledger = new OperationLedger(join(directory, 'operations'));
        this.creations = new CreationLedger(join(directory, 'creations'), JSON.stringify([this.machineId, this.id, this.engine]));
        this.stops = [this.rpc.onNotification(value => { this.notification(value); }), this.rpc.onRequest(request => { this.approval(request); }), this.rpc.onDisconnect(() => { this.disconnected(); })];
        // A source lifetime is independent of any Pane. This never cancels its native turn.
        this.timer = setInterval(() => {
            for (const owner of this.threads.values()) {
                if (!owner.history || !owner.ready || owner.preparing) continue;
                if (owner.dirty || owner.full || owner.session.status === 'running' || owner.session.status === 'waiting') {
                    void this.refresh(owner, owner.full).catch(() => { this.markOffline(owner); });
                }
            }
        }, options.pollMs ?? 250);
        this.timer.unref();
    }
    get online(): boolean { return this.rpc.online; }
    private assertScope(id: string): string {
        let source;
        try { source = parseSourceSessionId(id); } catch { throw new SourceError('INVALID_REQUEST', 'Invalid source session identity.'); }
        if (source.sourceId !== this.id || source.machineId !== this.machineId || source.engine !== this.engine) throw new SourceError('INVALID_REQUEST', 'This session belongs to a different native source.');
        return source.nativeId;
    }
    private descriptor(thread: NativeThread): SourceSession {
        const nativeId = thread.id, previous = this.threads.get(nativeId)?.session;
        const id = sourceSessionId({ sourceId: this.id, machineId: this.machineId, engine: this.engine, nativeId });
        const pendingRequests = [...this.approvals].filter(([, pending]) => pending.sessionId === id).map(([requestId, pending]) => ({
            id: requestId, method: pending.request.method,
            turnId: typeof pending.request.params.turnId === 'string' ? pending.request.params.turnId : null,
            itemId: typeof pending.request.params.itemId === 'string' ? pending.request.params.itemId : null,
            params: pending.request.params,
        }));
        const running = thread.status.type === 'active';
        const allowed = this.loaded.has(nativeId) || this.config.ownership === 'exclusive';
        return { id, sourceId: this.id, machineId: this.machineId, engine: this.engine, nativeId,
            title: thread.name || thread.preview || `Codex ${nativeId.slice(0, 12)}`, cwd: thread.cwd, updatedAt: thread.updatedAt * 1000,
            status: this.rpc.online ? pendingRequests.length ? 'waiting' : running ? 'running' : 'idle' : 'offline',
            activeTurnId: running ? previous?.activeTurnId ?? null : null,
            capabilities: { send: allowed, steer: allowed, cancel: allowed, approve: pendingRequests.length > 0, files: false }, pendingRequests };
    }
    private remember(thread: NativeThread): ThreadOwner {
        let owner = this.threads.get(thread.id);
        const session = this.descriptor(thread);
        if (owner) { owner.native = thread; this.metadata(owner, session); }
        else { owner = { native: thread, session, dirty: false, full: true, pending: [], pendingBytes: 0, pendingOverflow: false, ready: false }; this.threads.set(thread.id, owner); }
        return owner;
    }
    private metadata(owner: ThreadOwner, session: SourceSession): void {
        owner.session = session;
        if (owner.history) owner.history.index.edit(session, () => {});
    }
    private markOffline(owner: ThreadOwner): void {
        owner.full = true;
        this.metadata(owner, { ...owner.session, status: 'offline', capabilities: { ...owner.session.capabilities, send: false, steer: false, cancel: false, approve: false }, pendingRequests: [] });
    }
    private disconnected(): void {
        this.catalogAt = 0; this.loaded.clear(); this.approvals.clear();
        for (const owner of this.threads.values()) this.markOffline(owner);
    }
    async list(signal?: AbortSignal): Promise<SourceSession[]> {
        this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
        if (this.rpc.online && Date.now() - this.catalogAt < 1500) return [...this.threads.values()].map(owner => owner.session);
        if (!this.catalogRead) {
            const work = this.readCatalog().finally(() => { if (this.catalogRead === work) this.catalogRead = undefined; });
            this.catalogRead = work;
        }
        return waitFor(this.catalogRead, signal);
    }
    private async loadedThreads(signal: AbortSignal): Promise<Set<string>> {
        const loaded = new Set<string>(), seenLoaded = new Set<string>();
        let cursor: string | null = null;
        do {
            const page = loadedListSchema.parse(await this.rpc.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }, { signal }));
            for (const id of page.data) loaded.add(id);
            if (loaded.size > MAX_CATALOG || seenLoaded.size >= MAX_NATIVE_PAGES) throw new SourceError('CAPACITY_EXCEEDED', 'The native loaded-thread catalog exceeds its source budget.');
            cursor = page.nextCursor;
            if (cursor && seenLoaded.has(cursor)) throw new SourceError('TARGET_UNAVAILABLE', 'The native loaded-thread cursor did not progress.');
            if (cursor) seenLoaded.add(cursor);
        } while (cursor);
        return loaded;
    }
    private async readCatalog(): Promise<SourceSession[]> {
        const signal = this.lifetime.signal;
        await this.rpc.connect(signal);
        const loaded = await this.loadedThreads(signal);
        let cursor: string | null = null;
        this.loaded.clear(); for (const id of loaded) this.loaded.add(id);
        const accepted = new Set<string>(), cursors = new Set<string>();
        do {
            const page = threadListSchema.parse(await this.rpc.request('thread/list', { limit: 100, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], ...(cursor ? { cursor } : {}) }, { signal }));
            for (const thread of page.data) { accepted.add(thread.id); this.remember(thread); }
            if (accepted.size > MAX_CATALOG) throw new SourceError('CAPACITY_EXCEEDED', 'This source catalog exceeds the 10,000-session limit.');
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor)) throw new SourceError('TARGET_UNAVAILABLE', 'The native thread-list cursor did not progress.');
            if (cursor) cursors.add(cursor);
        } while (cursor);
        // Ephemeral loaded native threads may be absent from the persisted catalog.
        for (const id of loaded) if (!accepted.has(id)) {
            const response = threadResponseSchema.parse(await this.rpc.request('thread/read', { threadId: id, includeTurns: false }, { signal }));
            this.remember(response.thread); accepted.add(id);
        }
        for (const [id, owner] of this.threads) if (!accepted.has(id)) this.markOffline(owner);
        this.catalogAt = Date.now();
        return [...this.threads.values()].map(owner => owner.session);
    }
    private async owner(sessionId: string, signal?: AbortSignal): Promise<ThreadOwner> {
        const nativeId = this.assertScope(sessionId);
        let owner = this.threads.get(nativeId);
        if (!owner) { await this.list(signal); owner = this.threads.get(nativeId); }
        if (!owner) throw new SourceError('TARGET_UNAVAILABLE', 'The native source did not advertise this session.');
        return owner;
    }
    private async prepare(owner: ThreadOwner): Promise<void> {
        if (owner.preparing) return owner.preparing;
        if (owner.history && owner.ready) return;
        const work = (async () => {
            const hash = createHash('sha256').update(owner.session.id).digest('hex');
            const history = owner.history ?? new CodexHistory(new SourceEventIndex(join(this.directory, 'history', `${hash}.sqlite`), owner.session));
            owner.history = history;
            try {
                await this.refresh(owner, true);
                // Only whole native items are buffered. Delta strings trigger a source reread, never double-apply over the baseline.
                const buffered = owner.pending.splice(0); owner.pendingBytes = 0;
                if (owner.pendingOverflow) {
                    owner.pendingOverflow = false; owner.full = true;
                    // No partially buffered tail is published as a continuous baseline.
                    throw new SourceError('CAPACITY_EXCEEDED', 'Native initialization exceeded its notification budget. The source must be read again.');
                }
                for (const frame of buffered) this.applyNotification(owner, frame);
                owner.ready = true;
            } catch (error) {
                owner.ready = false; this.markOffline(owner); throw error;
            }
        })().finally(() => { if (owner.preparing === work) delete owner.preparing; });
        owner.preparing = work;
        return work;
    }
    async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
        const owner = await this.owner(request.sessionId, signal);
        await waitFor(this.prepare(owner), signal); signal?.throwIfAborted();
        return owner.history!.index.read(request);
    }
    async *changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
        const owner = await this.owner(request.sessionId, signal);
        await waitFor(this.prepare(owner), signal);
        yield* owner.history!.index.changes(request, signal);
    }
    private refresh(owner: ThreadOwner, full: boolean): Promise<void> {
        if (owner.refreshing) { owner.dirty = true; owner.full ||= full; return owner.refreshing; }
        const work = this.refreshNative(owner, full).finally(() => { if (owner.refreshing === work) delete owner.refreshing; });
        owner.refreshing = work;
        return work;
    }
    private async refreshNative(owner: ThreadOwner, full: boolean): Promise<void> {
        const signal = this.lifetime.signal, history = owner.history!;
        owner.dirty = false; owner.full = false;
        const response = threadResponseSchema.parse(await this.rpc.request('thread/read', { threadId: owner.native.id, includeTurns: false }, { signal }));
        if (response.thread.id !== owner.native.id) throw new SourceError('INVALID_REQUEST', 'The native source returned another thread.');
        this.remember(response.thread);
        const turns: NativeTurn[] = [], cursors = new Set<string>();
        let cursor: string | null = null;
        do {
            let nativePage: unknown;
            try { nativePage = await this.rpc.request('thread/turns/list', { threadId: owner.native.id, sortDirection: full ? 'asc' : 'desc', itemsView: 'summary', limit: 100, ...(cursor ? { cursor } : {}) }, { signal }); }
            catch (error) {
                // Pinned native API explicitly reports an unmaterialized new thread before its first user message.
                if (history.index.count === 0 && error instanceof CodexRpcError && error.code === -32600
                    && error.message === `thread ${owner.native.id} is not materialized yet; thread/turns/list is unavailable before first user message`) break;
                throw error;
            }
            const page = turnListSchema.parse(nativePage);
            turns.push(...page.data);
            // The first already-indexed terminal turn bounds an ordinary tail refresh.
            if (!full && page.data.some(turn => history.hasTurn(turn.id) && turn.status !== 'inProgress')) break;
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor)) throw new SourceError('TARGET_UNAVAILABLE', 'The native turn cursor did not progress.');
            if (cursor) cursors.add(cursor);
            if (cursors.size > MAX_NATIVE_PAGES) throw new SourceError('CAPACITY_EXCEEDED', 'The native history exceeded the page safety limit.');
        } while (cursor);
        if (!full) turns.reverse();
        const known = history.index.cached<string[]>('turn-order') ?? [];
        if (full) {
            const next = turns.map(turn => turn.id);
            let prefix = 0; while (prefix < known.length && prefix < next.length && known[prefix] === next[prefix]) prefix++;
            if (prefix < known.length) history.invalidateSuffix(owner.session, known.slice(prefix));
        }
        for (const turn of turns) {
            signal.throwIfAborted();
            const previous = history.turnState(turn.id);
            if (!full && previous && previous.status !== 'inProgress' && previous.status === turn.status) continue;
            history.beginTurn(owner.session, turn);
            let tail = full ? undefined : history.index.cached<Tail>(`tail:${turn.id}`);
            let position: string | { type: 'item'; itemId: string } | null = tail?.previous ? { type: 'item', itemId: tail.previous } : null;
            const itemCursors = new Set<string>(); let pageCount = 0;
            do {
                const page = itemListSchema.parse(await this.rpc.request('thread/items/list', {
                    threadId: owner.native.id, turnId: turn.id, sortDirection: 'asc', limit: 200, ...(position ? { cursor: position } : {}),
                }, { signal }));
                if (page.data.some(entry => entry.turnId !== turn.id)) throw new SourceError('INVALID_REQUEST', 'The native source returned items from another turn.');
                // A full completion payload wins over an older in-flight incomplete snapshot.
                const entries = page.data.map(entry => this.monotoneSnapshot(history, entry, turn.status !== 'inProgress')).filter((entry): entry is NativeItemEntry => entry !== undefined);
                history.acceptItems(owner.session, entries, turn.status !== 'inProgress');
                for (const entry of page.data) {
                    if (tail?.last === entry.item.id || tail?.previous === entry.item.id) continue;
                    tail = { last: entry.item.id, previous: tail?.last ?? null };
                }
                position = page.nextCursor;
                if (position && itemCursors.has(position)) throw new SourceError('TARGET_UNAVAILABLE', 'The native item cursor did not progress.');
                if (position) itemCursors.add(position);
                if (++pageCount > MAX_NATIVE_PAGES) throw new SourceError('CAPACITY_EXCEEDED', 'The native history exceeded the page safety limit.');
            } while (position);
            history.acceptTurn(owner.session, turn);
            if (tail) history.index.edit(owner.session, () => { history.index.cache(`tail:${turn.id}`, tail); });
            const order = history.index.cached<string[]>('turn-order') ?? [];
            if (!order.includes(turn.id)) history.index.edit(owner.session, () => { history.index.cache('turn-order', [...order, turn.id]); });
            if (turn.status === 'inProgress') this.metadata(owner, { ...owner.session, activeTurnId: turn.id, status: owner.session.pendingRequests.length ? 'waiting' : 'running' });
        }
        if (full) history.index.edit(owner.session, () => { history.index.cache('turn-order', turns.map(turn => turn.id)); });
    }
    private monotoneSnapshot(history: CodexHistory, entry: NativeItemEntry, terminal: boolean): NativeItemEntry | undefined {
        const previous = history.itemState(entry.turnId, entry.item.id);
        if (!previous || terminal || entry.completedAtMs != null) return entry;
        if (previous.completed) return undefined;
        for (const field of ['text', 'aggregatedOutput'] as const) {
            const before = previous.item[field], after = entry.item[field];
            if (typeof before === 'string' && typeof after === 'string' && before.length > after.length && before.startsWith(after)) return undefined;
        }
        return entry;
    }
    private notification(frame: NativeNotification): void {
        const threadId = typeof frame.params.threadId === 'string' ? frame.params.threadId : isRecord(frame.params.thread) ? frame.params.thread.id : undefined;
        if (typeof threadId !== 'string') return;
        if (frame.method === 'thread/started') {
            const parsed = nativeThreadSchema.safeParse(frame.params.thread);
            if (parsed.success) { this.loaded.add(threadId); this.remember(parsed.data); }
        }
        const owner = this.threads.get(threadId);
        if (!owner) { this.catalogAt = 0; return; }
        if (owner.preparing) {
            if (frame.method.includes('delta') || frame.method.includes('Delta')) { owner.dirty = true; return; }
            const bytes = Buffer.byteLength(JSON.stringify(frame));
            if (owner.pendingOverflow || owner.pending.length >= 2048 || owner.pendingBytes + bytes > MAX_BUFFER_BYTES) {
                owner.pending.length = 0; owner.pendingBytes = 0; owner.pendingOverflow = true; owner.full = true;
            } else { owner.pending.push(frame); owner.pendingBytes += bytes; }
            return;
        }
        this.applyNotification(owner, frame);
    }
    private applyNotification(owner: ThreadOwner, frame: NativeNotification): void {
        const { method, params } = frame;
        owner.dirty = true;
        try {
            if (method === 'thread/reverted' || method === 'thread/compacted') { owner.full = true; return; }
            if (method === 'thread/deleted' || method === 'thread/closed' || method === 'thread/archived') { this.markOffline(owner); this.catalogAt = 0; return; }
            if (method === 'serverRequest/resolved') {
                const requestId = this.approvalId(params.requestId, this.rpc.currentGeneration), pending = this.approvals.get(requestId);
                if (pending?.sessionId === owner.session.id) { pending.resolve(); this.approvals.delete(requestId); this.metadata(owner, this.descriptor(owner.native)); }
                return;
            }
            if (method === 'thread/status/changed' && isRecord(params.status) && typeof params.status.type === 'string') {
                owner.native = { ...owner.native, status: params.status as NativeThread['status'] }; this.metadata(owner, this.descriptor(owner.native));
            }
            if (method === 'turn/started' || method === 'turn/completed') {
                const parsed = nativeTurnSchema.safeParse(params.turn);
                if (!parsed.success) { owner.full = true; return; }
                const turn = parsed.data;
                owner.native.status = { type: method === 'turn/started' ? 'active' : 'idle' };
                this.metadata(owner, { ...this.descriptor(owner.native), activeTurnId: method === 'turn/started' ? turn.id : null });
                if (owner.history) {
                    if (method === 'turn/started') owner.history.beginTurn(owner.session, turn);
                    // Completion refreshes bounded native item pages before publishing turn/end.
                    else owner.dirty = true;
                }
                return;
            }
            if (owner.history && (method === 'item/started' || method === 'item/completed') && typeof params.turnId === 'string') {
                const item = nativeItemSchema.safeParse(params.item);
                if (!item.success) { owner.full = true; return; }
                owner.history.acceptItem(owner.session, params.turnId, item.data, method === 'item/completed');
            }
            // All delta methods intentionally only mark dirty. Source snapshots fold each accepted byte once.
        } catch { owner.full = true; }
    }
    private approvalId(id: unknown, generation: number): string { return JSON.stringify([generation, typeof id, id]); }
    private approval(request: NativeRequest): void {
        const threadId = request.params.threadId;
        if (typeof threadId !== 'string' || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
            void this.rpc.respond(request, undefined, { code: -32601, message: 'HHPI does not implement this native request capability.' }).catch(() => {});
            return;
        }
        const owner = this.threads.get(threadId);
        if (!owner) { void this.rpc.respond(request, undefined, { code: -32602, message: 'This native thread is not registered with the source.' }).catch(() => {}); return; }
        const id = this.approvalId(request.id, request.generation), acknowledgement = Promise.withResolvers<void>();
        this.approvals.set(id, { request, sessionId: owner.session.id, acknowledged: acknowledgement.promise, resolve: acknowledgement.resolve, submitted: false });
        this.metadata(owner, this.descriptor(owner.native));
    }
    async operate(operation: SourceOperation): Promise<SourceReceipt> {
        this.assertScope(operation.sessionId);
        return this.ledger.run(operation, () => this.perform(operation));
    }
    private async perform(operation: SourceOperation): Promise<SourceReceipt> {
        const owner = await this.owner(operation.sessionId), signal = this.lifetime.signal;
        await this.rpc.connect(signal);
        const receipt = (status: SourceReceipt['status'], message: string, turnId?: string): SourceReceipt => ({ sessionId: operation.sessionId, operationId: operation.operationId, status, message, ...(turnId ? { turnId } : {}) });
        if (operation.kind === 'approve') {
            const pending = operation.requestId ? this.approvals.get(operation.requestId) : undefined;
            if (!pending || pending.sessionId !== operation.sessionId || pending.request.generation !== this.rpc.currentGeneration || pending.submitted) throw new SourceError('INVALID_REQUEST', 'The native approval is no longer available for this source session.');
            if (!operation.decision) throw new SourceError('INVALID_REQUEST', 'An explicit native approval decision is required.');
            pending.submitted = true;
            await this.rpc.respond(pending.request, { decision: operation.decision });
            const timeout = new AbortController();
            try {
                const outcome = await Promise.race([pending.acknowledged.then(() => true), delay(ACK_TIMEOUT, AbortSignal.any([signal, timeout.signal])).then(() => false)]);
                return outcome ? receipt('accepted', 'The native engine resolved the approval request.') : receipt('indeterminate', 'The approval response was sent; native resolution has not been observed. It will not be resent.');
            } finally { timeout.abort(); }
        }
        // The check happens at execution time, not when a browser rendered its button.
        const loaded = await this.loadedThreads(signal);
        if (!loaded.has(owner.native.id)) {
            if (operation.kind !== 'send' || this.config.ownership !== 'exclusive') throw new SourceError('UNSUPPORTED', 'This thread is not owned by the connected native app-server. Reading does not resume or transfer its execution.');
            const resumed = threadResponseSchema.parse(await this.rpc.request('thread/resume', { threadId: owner.native.id, excludeTurns: true }, { write: true }));
            if (resumed.thread.id !== owner.native.id) throw new SourceError('OUTCOME_UNKNOWN', 'The native app-server resumed a different thread. No prompt was sent.');
            this.loaded.add(owner.native.id); this.remember(resumed.thread);
        }
        try {
            if (operation.kind === 'send' || operation.kind === 'steer') {
                if (!operation.text?.trim()) throw new SourceError('INVALID_REQUEST', 'The source prompt is empty.');
                const input = [{ type: 'text', text: operation.text, text_elements: [] }];
                if (operation.kind === 'steer') {
                    if (!operation.turnId) throw new SourceError('INVALID_REQUEST', 'Steer requires the exact native active turn.');
                    const response = await this.rpc.request<{ turnId: string }>('turn/steer', { threadId: owner.native.id, expectedTurnId: operation.turnId, clientUserMessageId: operation.operationId, input }, { write: true });
                    return receipt('accepted', 'The native engine accepted the steering input.', response.turnId);
                }
                const response = await this.rpc.request<{ turn: { id: string } }>('turn/start', { threadId: owner.native.id, clientUserMessageId: operation.operationId, input }, { write: true });
                owner.dirty = true;
                return receipt('accepted', 'The native engine accepted the prompt.', response.turn.id);
            }
            if (!operation.turnId) throw new SourceError('INVALID_REQUEST', 'Cancel requires the exact native active turn.');
            await this.rpc.request('turn/interrupt', { threadId: owner.native.id, turnId: operation.turnId }, { write: true });
            return receipt('accepted', 'The native engine accepted the interrupt request.', operation.turnId);
        } catch (error) {
            if (error instanceof CodexRpcError) return receipt('rejected', error.message);
            throw error;
        }
    }
    async create(request: SourceCreateRequest): Promise<SourceCreationReceipt> {
        this.lifetime.signal.throwIfAborted();
        if (request.sourceId !== this.id || !request.operationId) throw new SourceError('INVALID_REQUEST', 'A source and stable creation operation ID are required.');
        return this.creations.run(request, async () => {
            const cwd = request.cwd ?? this.config.cwd;
            if (!cwd || !isAbsolute(cwd) || cwd.includes('\0')) throw new SourceError('INVALID_REQUEST', 'Native thread creation requires an absolute source working directory.');
            try {
                // No browser-provided executable, configuration, permissions or auth overrides are forwarded.
                const response = threadResponseSchema.parse(await this.rpc.request('thread/start', { cwd }, { write: true }));
                this.loaded.add(response.thread.id);
                const owner = this.remember(response.thread); this.catalogAt = 0;
                return { sourceId: this.id, operationId: request.operationId, status: 'accepted', message: 'The native source created the thread.', session: owner.session };
            } catch (error) {
                if (error instanceof CodexRpcError) return { sourceId: this.id, operationId: request.operationId, status: 'rejected', message: error.message };
                throw error;
            }
        });
    }
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true; clearInterval(this.timer); this.lifetime.abort();
        for (const stop of this.stops) stop(); await this.rpc.dispose();
        await Promise.allSettled([...this.threads.values()].flatMap(owner => [owner.preparing, owner.refreshing].filter((work): work is Promise<void> => Boolean(work))));
        for (const owner of this.threads.values()) owner.history?.index.dispose();
        this.threads.clear(); this.approvals.clear();
    }
}
