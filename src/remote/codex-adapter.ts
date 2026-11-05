/** Direct source-side Codex v2 adapter. Native thread identity and execution ownership are preserved. */
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { SourceError, waitFor } from './errors.ts';
import { sourceIsOffline, sourceOffline, sourceOnlineConnection } from '../shared/source-connectivity.ts';
import { CodexRpc, CodexRpcError, type NativeNotification, type NativeRequest } from './codex-rpc.ts';
import { CodexHistory, CODEX_HISTORY_PROJECTION_VERSION } from './codex-history.ts';
import { retainSelectedLegacyImages } from './codex-legacy-images.ts';
import { NativeMetadataReader } from './codex-metadata.ts';
import type { NativeMetadataRequest, NativeMetadataPage } from './codex-metadata-core.mjs';
import { CodexAttachments } from './codex-attachments.ts';
import { CodexToolDetails } from './codex-tool-details.ts';
import { CodexImageReader } from './codex-image-reader.ts';
import { SourceEventIndex } from './event-index.ts';
import { OperationLedger, CreationLedger } from './operation-ledger.ts';
import { isRecord, itemListSchema, loadedListSchema, nativeItemSchema, nativeThreadSchema, nativeTurnSchema, threadListSchema, threadResponseSchema, type NativeItemEntry, type NativeThread } from './codex-native.ts';
import { parseSourceSessionId, sourceSessionId, type DirectCodexConfig, type SourceAdapter, type SourceChanges, type SourceChangesRequest, type SourceCreateRequest, type SourceCreationReceipt, type SourceOperation, type SourcePage, type SourceReadRequest, type SourceReceipt, type SourceResource, type SourceResourceRequest, type SourceSession } from './protocol.ts';

interface ThreadOwner {
    native: NativeThread; session: SourceSession; history?: CodexHistory; attachments?: CodexAttachments; details?: CodexToolDetails;
    preparation?: { controller: AbortController; waiters: number; settled: boolean };
    preparing?: Promise<void>; refreshing?: Promise<void>; dirty: boolean; full: boolean;
    /** Native completion can arrive before its terminal history page is readable. */
    pendingCompletions: Set<string>;
    /** Versions only cover accepted source snapshots; native delta strings are not reapplied over snapshots. */
    pending: NativeNotification[]; pendingBytes: number; pendingOverflow: boolean; ready: boolean; rewrite: boolean;
}
interface PendingApproval { request: NativeRequest; sessionId: string; acknowledged: Promise<void>; resolve(): void; submitted: boolean }
interface NativeSourceRange { first: number | null; last: number | null; hasBefore: boolean; hasAfter: boolean }
interface NativeHistoryCheckpoint {
    version: 1;
    state: 'building' | 'complete';
    updatedAt: number;
    statusType: string;
}
interface AdapterOptions {
    rpc?: CodexRpc; pollMs?: number; readImage?: (path: string, signal: AbortSignal) => Promise<unknown>;
    now?: () => number; random?: () => number;
    readMetadata?: (request: NativeMetadataRequest, signal: AbortSignal) => Promise<NativeMetadataPage>;
}
const MAX_CATALOG = 10_000;
const MAX_NATIVE_PAGES = 10_000;
const ACK_TIMEOUT = 15_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const NATIVE_HISTORY_CHECKPOINT = 'native-history-checkpoint:v1';
const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const done = (): void => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});

export class DirectCodexAdapter implements SourceAdapter {
    readonly id: string; readonly machineId: string; readonly engine = 'codex';
    private readonly rpc: CodexRpc;
    private readonly imageReader: CodexImageReader;
    private readonly metadataReader: NativeMetadataReader;
    private readonly readMetadata: (request: NativeMetadataRequest, signal: AbortSignal) => Promise<NativeMetadataPage>;
    private readonly readImage: (path: string, signal: AbortSignal) => Promise<unknown>;
    private readonly ledger: OperationLedger;
    private readonly creations: CreationLedger;
    private readonly threads = new Map<string, ThreadOwner>();
    private readonly loaded = new Set<string>();
    private readonly approvals = new Map<string, PendingApproval>();
    private readonly receiptReads = new Map<string, Promise<void>>();
    private readonly lifetime = new AbortController();
    private readonly stops: Array<() => void>;
    private catalogRead: Promise<SourceSession[]> | undefined;
    private catalogAt = 0;
    private readonly now: () => number;
    private readonly random: () => number;
    private retryReadsAt = 0;
    private readFailures = 0;
    private reconnecting: Promise<void> | undefined;
    private readonly timer: ReturnType<typeof setInterval>;
    private disposed = false;

    constructor(private readonly config: DirectCodexConfig, private readonly directory: string, options: AdapterOptions = {}) {
        this.id = config.id; this.machineId = config.machineId;
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        this.rpc = options.rpc ?? new CodexRpc(config);
        this.imageReader = new CodexImageReader(config);
        this.metadataReader = new NativeMetadataReader(config);
        this.readMetadata = options.readMetadata ?? ((request, signal) => this.metadataReader.read(request, signal));
        if (!options.readMetadata) this.metadataReader.warm();
        this.readImage = options.readImage ?? ((path, signal) => this.imageReader.read(path, signal));
        this.ledger = new OperationLedger(join(directory, 'operations'));
        this.creations = new CreationLedger(join(directory, 'creations'), JSON.stringify([this.machineId, this.id, this.engine]));
        this.stops = [this.rpc.onNotification(value => { this.notification(value); }), this.rpc.onRequest(request => { this.approval(request); }), this.rpc.onDisconnect(() => { this.disconnected(); })];
        // A source lifetime is independent of any Pane. This never cancels its native turn.
        this.timer = setInterval(() => {
            if (this.disposed || this.now() < this.retryReadsAt) return;
            for (const owner of this.threads.values()) {
                if (!owner.history || !owner.ready || owner.preparing) continue;
                if (owner.dirty || owner.full || owner.pendingCompletions.size || owner.session.status === 'running' || owner.session.status === 'waiting') {
                    void this.refresh(owner, owner.full).catch(() => { this.markOffline(owner); });
                }
            }
        }, options.pollMs ?? 250);
        this.timer.unref();
    }
    get online(): boolean { return this.rpc.online; }
    private readFailed(): void {
        if (this.disposed || this.now() < this.retryReadsAt) return;
        const ceiling = Math.min(30_000, 500 * 2 ** Math.min(this.readFailures++, 6));
        this.retryReadsAt = this.now() + Math.ceil(ceiling * (0.75 + 0.25 * this.random()));
    }
    private readRecovered(): void { this.readFailures = 0; this.retryReadsAt = 0; }
    private async connectForRead(): Promise<void> {
        this.lifetime.signal.throwIfAborted();
        if (this.reconnecting) return this.reconnecting;
        if (this.now() < this.retryReadsAt) throw new SourceError('TARGET_UNAVAILABLE', 'The native source is waiting to reconnect.');
        if (this.rpc.online) return;
        // Every thread reader and catalog shares one recovery probe. A failed
        // source connection never creates one reconnect loop per open thread.
        const work = this.rpc.connect(this.lifetime.signal).then(() => {}).catch((error: unknown) => {
            this.readFailed(); throw error;
        }).finally(() => { if (this.reconnecting === work) this.reconnecting = undefined; });
        this.reconnecting = work;
        return work;
    }
    private assertScope(id: string): string {
        let source;
        try { source = parseSourceSessionId(id); } catch { throw new SourceError('INVALID_REQUEST', 'Invalid source session identity.'); }
        if (source.sourceId !== this.id || source.machineId !== this.machineId || source.engine !== this.engine) throw new SourceError('INVALID_REQUEST', 'This session belongs to a different native source.');
        return source.nativeId;
    }
    private descriptor(thread: NativeThread): SourceSession {
        const nativeId = thread.id, previous = this.threads.get(nativeId)?.session;
        if (!this.rpc.online && previous) return sourceOffline(previous, this.now());
        const id = sourceSessionId({ sourceId: this.id, machineId: this.machineId, engine: this.engine, nativeId });
        const pendingRequests = [...this.approvals].filter(([, pending]) => pending.sessionId === id).map(([requestId, pending]) => ({
            id: requestId, method: pending.request.method,
            turnId: typeof pending.request.params.turnId === 'string' ? pending.request.params.turnId : null,
            itemId: typeof pending.request.params.itemId === 'string' ? pending.request.params.itemId : null,
            params: pending.request.params,
        }));
        const running = thread.status.type === 'active';
        const loaded = this.loaded.has(nativeId);
        // A stored thread can accept an explicit continuation without already
        // being loaded here. The native writer lock decides execution ownership.
        const resumable = this.config.ownership === 'exclusive' || this.config.writerLock === 'native';
        return { id, sourceId: this.id, machineId: this.machineId, engine: this.engine, nativeId,
            title: thread.name || thread.preview || `Codex ${nativeId.slice(0, 12)}`, cwd: thread.cwd, updatedAt: thread.updatedAt * 1000,
            status: pendingRequests.length ? 'waiting' : running ? 'running' : 'idle',
            connection: this.rpc.online ? sourceOnlineConnection(previous, this.now()) : { state: 'offline', observedAt: this.now() },
            activeTurnId: running ? previous?.activeTurnId ?? null : null,
            capabilities: { send: loaded || resumable, steer: loaded, cancel: loaded, approve: pendingRequests.length > 0, files: false }, pendingRequests };
    }
    private remember(thread: NativeThread): ThreadOwner {
        let owner = this.threads.get(thread.id);
        const session = this.descriptor(thread);
        if (owner) { owner.native = thread; this.metadata(owner, session); }
        else { owner = { native: thread, session, dirty: false, full: true, pendingCompletions: new Set(), pending: [], pendingBytes: 0, pendingOverflow: false, ready: false, rewrite: false }; this.threads.set(thread.id, owner); }
        return owner;
    }
    private metadata(owner: ThreadOwner, session: SourceSession): void {
        owner.session = session;
        if (owner.history) owner.history.index.edit(session, () => {});
    }
    private markOffline(owner: ThreadOwner): void {
        owner.attachments?.revoke();
        owner.full = true;
        this.metadata(owner, sourceOffline(owner.session, this.now()));
    }
    private disconnected(): void {
        this.readFailed();
        this.catalogAt = 0; this.loaded.clear(); this.approvals.clear();
        for (const owner of this.threads.values()) this.markOffline(owner);
    }
    private catalogSessions(): SourceSession[] {
        // Native ephemeral threads reject both paginated history and thread/read(includeTurns).
        // Retain their metadata for explicit old-link rejection, but never advertise them as readable.
        return [...this.threads.values()].filter(owner => owner.native.ephemeral !== true).map(owner => owner.session);
    }
    private assertReadable(thread: NativeThread): void {
        if (thread.ephemeral === true) throw new SourceError('UNSUPPORTED', 'The native app-server does not expose history for ephemeral threads.');
    }
    async list(signal?: AbortSignal): Promise<SourceSession[]> {
        this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
        if (this.rpc.online && this.now() - this.catalogAt < 1500) return this.catalogSessions();
        if (!this.catalogRead) {
            const work = this.readCatalog().then(sessions => { this.readRecovered(); return sessions; }, (error: unknown) => {
                this.readFailed(); throw error;
            }).finally(() => { if (this.catalogRead === work) this.catalogRead = undefined; });
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
        await this.connectForRead();
        const loaded = await this.loadedThreads(signal);
        let cursor: string | null = null;
        this.loaded.clear(); for (const id of loaded) this.loaded.add(id);
        const accepted = new Set<string>(), cursors = new Set<string>();
        do {
            const page = threadListSchema.parse(await this.rpc.request('thread/list', { limit: 100, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true, ...(cursor ? { cursor } : {}) }, { signal }));
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
        this.catalogAt = this.now();
        return this.catalogSessions();
    }
    private async owner(sessionId: string, signal?: AbortSignal): Promise<ThreadOwner> {
        const nativeId = this.assertScope(sessionId);
        let owner = this.threads.get(nativeId);
        if (!owner) {
            // A saved, canonical source identity is already enough to route a
            // read. Discovering every other thread must not gate this one.
            await waitFor(this.connectForRead(), signal);
            const response = threadResponseSchema.parse(await this.rpc.request('thread/read',
                { threadId: nativeId, includeTurns: false }, { ...(signal ? { signal } : {}) }));
            if (response.thread.id !== nativeId) throw new SourceError('INVALID_REQUEST', 'The native source returned another thread.');
            owner = this.remember(response.thread);
        }
        this.assertReadable(owner.native);
        return owner;
    }
    async resolve(sessionId: string, signal?: AbortSignal): Promise<SourceSession> {
        return (await this.owner(sessionId, signal)).session;
    }
    private async prepare(owner: ThreadOwner, callerSignal?: AbortSignal): Promise<void> {
        const signal = callerSignal ?? this.lifetime.signal;
        signal.throwIfAborted();
        if (owner.preparation?.controller.signal.aborted) {
            // A new reader must not inherit the last reader's cancelled work.
            await waitFor(owner.preparing!.catch(() => {}), signal);
            return this.prepare(owner, signal);
        }
        if (owner.history && owner.ready && !owner.preparing) return;
        if (!owner.preparing) this.startPreparation(owner);
        const preparation = owner.preparation!;
        preparation.waiters++;
        try { await waitFor(owner.preparing!, signal); }
        finally {
            preparation.waiters--;
            if (!preparation.waiters && !preparation.settled) preparation.controller.abort(new DOMException('All history preparation readers left.', 'AbortError'));
        }
    }
    private startPreparation(owner: ThreadOwner): void {
        const preparation = { controller: new AbortController(), waiters: 0, settled: false };
        const signal = AbortSignal.any([this.lifetime.signal, preparation.controller.signal]);
        owner.preparation = preparation;
        const work = (async () => {
            const hash = createHash('sha256').update(owner.session.id).digest('hex');
            let history = owner.history;
            if (!history) {
                const index = new SourceEventIndex(join(this.directory, 'history', `${hash}.v${CODEX_HISTORY_PROJECTION_VERSION}.sqlite`), owner.session);
                const attachments = new CodexAttachments(index, join(this.directory, 'images'), this.readImage, this.lifetime.signal, ({ turnId, itemId }) => {
                    const current = owner.history?.itemState(turnId, itemId);
                    if (current) owner.history!.acceptItem(owner.session, current.turnId, current.item, current.completed);
                });
                owner.attachments = attachments;
                const details = owner.details = new CodexToolDetails(index);
                history = new CodexHistory(index, { userContent: (turnId, item) => attachments.content(turnId, item),
                    toolContent: (turnId, item) => attachments.content(turnId, item), nativeOrder: true, toolPresentation: (turnId, item, tool) => details.project(turnId, item, tool) });
            }
            owner.history = history;
            try {
                await this.refresh(owner, true, signal);
                // Only whole native items are buffered. Delta strings trigger a source reread, never double-apply over the baseline.
                const buffered = owner.pending.splice(0); owner.pendingBytes = 0;
                if (owner.pendingOverflow) {
                    // Notifications are an optimization over the authoritative
                    // sparse snapshot. Overflow rereads the bounded tail; it
                    // must not turn a readable archive into a capacity error.
                    owner.pendingOverflow = false; owner.full = true;
                    await this.refresh(owner, true, signal);
                }
                signal.throwIfAborted();
                try { for (const frame of buffered) this.applyNotification(owner, frame); }
                catch (error) {
                    this.setNativeHistoryCheckpoint(history, owner.session, {
                        version: 1, state: 'building', updatedAt: owner.native.updatedAt,
                        statusType: owner.native.status.type,
                    });
                    throw error;
                }
                owner.ready = true;
            } catch (error) {
                owner.ready = false; if (!signal.aborted) this.markOffline(owner); throw error;
            }
        })().finally(() => {
            preparation.settled = true;
            if (owner.preparing === work) { delete owner.preparing; delete owner.preparation; }
        });
        owner.preparing = work;
    }
    async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
        const owner = await this.owner(request.sessionId, signal);
        await this.prepare(owner, signal); signal?.throwIfAborted();
        let range = owner.history!.index.cached<NativeSourceRange>('native-source-tail');
        if (request.before !== undefined || request.after !== undefined || request.around !== undefined || range === undefined) {
            range = await this.readNativePage(owner, request, false, signal);
        }
        const page = owner.history!.index.read(request, { from: range.first ?? Number.MAX_SAFE_INTEGER, through: range.last ?? 0 });
        page.hasBefore ||= range.hasBefore; page.hasAfter ||= range.hasAfter;
        owner.attachments?.schedule(page.entries);
        // The selected entries and subscription version describe one snapshot.
        // Image completion publishes a later revision independently of this reader.
        return page;
    }
    async *changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
        const owner = await this.owner(request.sessionId, signal);
        await this.prepare(owner, signal);
        signal?.throwIfAborted();
        const index = owner.history!.index;
        if (request.epoch === index.epoch && request.version === index.version) {
            yield { session: index.session, epoch: index.epoch, base: index.version, version: index.version,
                reset: false, upserts: [], removed: [] };
        }
        for await (const change of index.changes(request, signal)) {
            owner.attachments?.schedule(change.upserts);
            yield change;
        }
    }
    async readResource(request: SourceResourceRequest, signal?: AbortSignal): Promise<SourceResource> {
        const owner = await this.owner(request.sessionId, signal);
        await this.prepare(owner, signal);
        if (owner.full) await waitFor(this.refresh(owner, true), signal);
        if (sourceIsOffline(owner.session)) throw new SourceError('TARGET_UNAVAILABLE', 'The native source is offline.');
        return request.path.startsWith('detail:') ? owner.details!.read(request.path) : owner.attachments!.read(request.path, signal);
    }
    private refresh(owner: ThreadOwner, full: boolean, callerSignal?: AbortSignal): Promise<void> {
        if (owner.refreshing) { owner.dirty = true; owner.full ||= full; return waitFor(owner.refreshing, callerSignal); }
        const signal = callerSignal ? AbortSignal.any([this.lifetime.signal, callerSignal]) : this.lifetime.signal;
        const work = waitFor(this.connectForRead(), signal).then(() => this.refreshNative(owner, full, signal)).then(() => { this.readRecovered(); }, (error: unknown) => {
            if (!signal.aborted) this.readFailed(); throw error;
        }).finally(() => { if (owner.refreshing === work) delete owner.refreshing; });
        owner.refreshing = work;
        return work;
    }
    private async refreshNative(owner: ThreadOwner, full: boolean, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        const history = owner.history!;
        owner.dirty = false; owner.full = false;
        const response = threadResponseSchema.parse(await this.rpc.request('thread/read', { threadId: owner.native.id, includeTurns: false }, { signal }));
        if (response.thread.id !== owner.native.id) throw new SourceError('INVALID_REQUEST', 'The native source returned another thread.');
        this.remember(response.thread); this.assertReadable(response.thread);
        if (owner.rewrite) {
            history.index.edit(owner.session, () => { history.index.removeFrom(0); history.index.forget(''); });
            owner.rewrite = false;
        }
        // Coarse thread timestamps are not content revisions. Validate only
        // the selected sparse tail on reentry; unchanged native item revisions
        // reuse their accepted projection without any body RPC.
        await this.readNativePage(owner, { sessionId: owner.session.id, limit: 160 }, false, signal);
        this.setNativeHistoryCheckpoint(history, owner.session, { version: 1, state: owner.pendingCompletions.size ? 'building' : 'complete',
            updatedAt: response.thread.updatedAt, statusType: response.thread.status.type });
        owner.attachments?.acceptRevision(owner.attachments.revisionToken);
    }
    /** Fetch native metadata first, then only selected item bodies. History size
     * never determines the work needed to show a page. Native ordinals admit
     * older events before an existing window without changing any identity. */
    private async readNativePage(owner: ThreadOwner, request: SourceReadRequest, userOnly = false, callerSignal?: AbortSignal): Promise<NativeSourceRange> {
        const signal = callerSignal ? AbortSignal.any([this.lifetime.signal, callerSignal]) : this.lifetime.signal, history = owner.history!, index = history.index;
        if (request.epoch !== undefined && request.epoch !== index.epoch) throw new SourceError('STALE_VERSION', 'The source replaced this history cursor.');
        const initialized = await this.rpc.connect(signal);
        const query: NativeMetadataRequest = { home: initialized.codexHome, threadId: owner.native.id, limit: Math.ceil((request.limit ?? 160) / 8), ...(userOnly ? { userOnly: true } : {}),
            ...(request.before === undefined ? {} : { before: Math.floor((request.before - 1) / 8) }),
            ...(request.after === undefined ? {} : { after: Math.floor(request.after / 8) }),
            ...(request.around === undefined ? {} : { around: Math.floor(request.around / 8) }) };
        const metadata = await this.readMetadata(query, signal);
        signal.throwIfAborted();
        const latestRead = !userOnly && request.before === undefined && request.after === undefined && request.around === undefined;
        const sourceLast = Math.max(0, ...metadata.items.map(item => item.ordinal), ...metadata.turns.map(turn => turn.endOrdinal ?? turn.ordinal));
        const previousLast = index.cached<number>('native-source-last');
        if (latestRead && previousLast !== undefined && sourceLast < previousLast) {
            index.edit(owner.session, () => { index.removeFrom(0); index.forget(''); });
        }
        const oldCoordinates = index.cached<string>('native-source-coordinates');
        if (oldCoordinates !== undefined && oldCoordinates !== metadata.coordinates) {
            index.edit(owner.session, () => { index.removeFrom(0); index.forget(''); });
            if (request.epoch !== undefined) throw new SourceError('STALE_VERSION', 'The native execution history changed.');
        }
        // One item can emit only these eight schema-defined slots: turn start
        // 0 at its own ordinal; item step start 0, message 1, call 2, result 3,
        // step end 4; turn end 7 at its own native end ordinal. Slots 5/6 are
        // unused. This is an injective encoding of real native positions, not
        // speculative headroom, a loading-order allocator, or a browser offset.
        index.edit(owner.session, () => {
            index.cache('native-source-coordinates', metadata.coordinates);
            if (latestRead) index.cache('native-source-last', sourceLast);
            for (const turn of metadata.turns) {
                index.cache(`source-turn:${turn.id}`, turn.ordinal);
                if (turn.endOrdinal !== null) index.cache(`source-end:${turn.id}`, turn.endOrdinal);
            }
            for (const item of metadata.items) {
                index.cache(`source-item:${item.turnId}:${item.itemId}`, item.ordinal);
                index.cache(`source-declared-revision:${item.turnId}:${item.itemId}`, item.revision);
            }
        });
        const accepted: Array<{ items: typeof metadata.items; entries: NativeItemEntry[]; terminal: boolean }> = [];
        const ordered = [...metadata.items].sort((a, b) => a.ordinal - b.ordinal);
        for (let offset = 0; offset < ordered.length;) {
            const first = ordered[offset]!;
            let end = offset + 1;
            while (end < ordered.length && ordered[end]!.turnId === first.turnId
                && ordered[end]!.predecessorId === ordered[end - 1]!.itemId) end++;
            const selected = ordered.slice(offset, end);
            const changed = selected.some(item => index.cached<number>(`source-revision:${item.turnId}:${item.itemId}`) !== item.revision);
            if (changed) {
                const page = itemListSchema.parse(await this.rpc.request('thread/items/list', {
                    threadId: owner.native.id, turnId: first.turnId, sortDirection: 'asc', limit: selected.length,
                    ...(first.predecessorId ? { cursor: { type: 'item', itemId: first.predecessorId } } : {}),
                }, { signal }));
                if (page.data.length !== selected.length || page.data.some((entry, i) => entry.turnId !== selected[i]!.turnId || entry.item.id !== selected[i]!.itemId)) {
                    throw new SourceError('TARGET_UNAVAILABLE', 'The native item page changed while its metadata was being read.');
                }
                const terminal = metadata.turns.find(turn => turn.id === first.turnId)?.status !== 'inProgress';
                accepted.push({ items: selected, entries: page.data, terminal });
            }
            offset = end;
        }
        signal.throwIfAborted();
        // Remote IO is complete. One synchronous transaction publishes a
        // complete selected page, not one fsync/journal frame per lifecycle.
        const runningTurn = metadata.turns.find(turn => turn.status === 'inProgress');
        if (runningTurn) this.metadata(owner, { ...owner.session, activeTurnId: runningTurn.id, status: owner.session.pendingRequests.length ? 'waiting' : 'running' });
        index.batch(owner.session, () => {
            for (const turn of metadata.turns) history.beginTurn(owner.session, { ...turn });
            for (const group of accepted) {
                const entries = group.entries.map(entry => this.monotoneSnapshot(history, entry, group.terminal)).filter((entry): entry is NativeItemEntry => entry !== undefined);
                const hash = createHash('sha256').update(owner.session.id).digest('hex');
                retainSelectedLegacyImages(['.v3.sqlite', '.v2.sqlite', '.sqlite'].map(suffix => join(this.directory, 'history', `${hash}${suffix}`)),
                    index, owner.session, owner.native, entries);
                history.acceptItems(owner.session, entries, group.terminal);
                for (const item of group.items) index.cache(`source-revision:${item.turnId}:${item.itemId}`, item.revision);
            }
            for (const turn of metadata.turns) {
                history.acceptTurn(owner.session, { ...turn });
                if (turn.status !== 'inProgress') owner.pendingCompletions.delete(turn.id);
            }
        });
        const positions = [...metadata.items.map(item => item.ordinal), ...metadata.turns.flatMap(turn => turn.endOrdinal === null ? [] : [turn.endOrdinal])];
        const first = metadata.first === undefined ? (positions.length ? Math.min(...positions) : null) : metadata.first;
        const last = metadata.last === undefined ? (positions.length ? Math.max(...positions) : null) : metadata.last;
        const range: NativeSourceRange = { first: first === null ? null : first * 8, last: last === null ? null : last * 8 + 7,
            hasBefore: metadata.hasBefore, hasAfter: metadata.hasAfter };
        if (latestRead) index.edit(owner.session, () => index.cache('native-source-tail', range));
        return range;
    }
    private nativeHistoryCheckpoint(value: unknown): NativeHistoryCheckpoint | undefined {
        if (!isRecord(value) || value.version !== 1 || (value.state !== 'building' && value.state !== 'complete')
            || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
            || typeof value.statusType !== 'string') return undefined;
        return { version: 1, state: value.state, updatedAt: value.updatedAt, statusType: value.statusType };
    }
    private setNativeHistoryCheckpoint(history: CodexHistory, session: SourceSession, value: NativeHistoryCheckpoint): void {
        history.index.edit(session, () => history.index.cache(NATIVE_HISTORY_CHECKPOINT, value));
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
            if (method === 'thread/reverted' || method === 'thread/compacted') { owner.pendingCompletions.clear(); owner.attachments?.revoke(true); owner.rewrite = true; owner.full = true; return; }
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
                if (method === 'turn/completed') owner.pendingCompletions.add(turn.id);
                owner.native.status = { type: method === 'turn/started' ? 'active' : 'idle' };
                this.metadata(owner, { ...this.descriptor(owner.native), activeTurnId: method === 'turn/started' ? turn.id : null });
                if (owner.history) {
                    if (method === 'turn/started') owner.history.beginTurn(owner.session, { ...turn });
                    // An idle thread header can precede its persisted turn tail.
                    // Keep polling until terminal items are read before turn/end,
                    // and prevent a restart from adopting this incomplete cache.
                    else this.setNativeHistoryCheckpoint(owner.history, owner.session, {
                        version: 1, state: 'building', updatedAt: owner.native.updatedAt,
                        statusType: owner.native.status.type,
                    });
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
        return this.ledger.run(operation, () => this.perform(operation), receipt => this.reconcile(operation, receipt));
    }
    async receipt(operation: SourceOperation, signal?: AbortSignal): Promise<SourceReceipt | null> {
        const nativeId = this.assertScope(operation.sessionId);
        const receipt = await waitFor(this.ledger.lookup(operation, prior => this.reconcile(operation, prior)), signal);
        if (receipt?.status !== 'accepted') return receipt;
        // A terminal ledger result is immediately readable while the native
        // connection is down. Reconciliation remains read-only and runs outside
        // that response; the next lookup can locate a user item beyond the tail.
        const index = this.threads.get(nativeId)?.history?.index, seq = index?.userMessageSequence(operation.operationId);
        if (seq === undefined) this.observeAccepted(operation, nativeId);
        return seq === undefined || !index ? receipt : { ...receipt, observed: { epoch: index.epoch, seq } };
    }
    private observeAccepted(operation: SourceOperation, nativeId: string): void {
        if (this.disposed || this.receiptReads.has(nativeId) || this.now() < this.retryReadsAt
            || operation.kind !== 'send' && operation.kind !== 'steer') return;
        const work = (async () => {
            const owner = await this.owner(operation.sessionId);
            await this.prepare(owner);
            if (owner.history!.index.userMessageSequence(operation.operationId) === undefined) await this.readNativePage(owner, { sessionId: operation.sessionId, limit: 160 }, true);
        })().catch(() => { /* The accepted receipt remains authoritative during a read outage. */ })
            .finally(() => { if (this.receiptReads.get(nativeId) === work) this.receiptReads.delete(nativeId); });
        this.receiptReads.set(nativeId, work);
    }
    private async reconcile(operation: SourceOperation, receipt: SourceReceipt): Promise<SourceReceipt | undefined> {
        if (operation.kind !== 'send' && operation.kind !== 'steer') return undefined;
        const owner = await this.owner(operation.sessionId), signal = this.lifetime.signal;
        await this.prepare(owner);
        let seq = owner.history!.index.userMessageSequence(operation.operationId);
        if (seq === undefined) {
            await waitFor(this.readNativePage(owner, { sessionId: operation.sessionId, limit: 160 }, true), signal);
            seq = owner.history!.index.userMessageSequence(operation.operationId);
        }
        if (seq === undefined) return undefined;
        return { ...receipt, status: 'accepted', message: 'The native user message confirms this operation was accepted.', observed: { epoch: owner.history!.index.epoch, seq } };
    }
    private async perform(operation: SourceOperation): Promise<SourceReceipt> {
        const signal = this.lifetime.signal;
        let owner: ThreadOwner;
        try { owner = await this.owner(operation.sessionId); await this.rpc.connect(signal); }
        catch (error) { throw this.preflightFailure(error); }
        const receipt = (status: SourceReceipt['status'], message: string, turnId?: string): SourceReceipt => ({ sessionId: operation.sessionId, operationId: operation.operationId, status, message, ...(turnId ? { turnId } : {}) });
        if (operation.kind === 'approve') {
            const pending = operation.requestId ? this.approvals.get(operation.requestId) : undefined;
            if (!pending || pending.sessionId !== operation.sessionId || pending.request.generation !== this.rpc.currentGeneration || pending.submitted) throw new SourceError('INVALID_REQUEST', 'The native approval is no longer available for this source session.');
            if (!operation.decision) throw new SourceError('INVALID_REQUEST', 'An explicit native approval decision is required.');
            pending.submitted = true;
            try { await this.rpc.respond(pending.request, { decision: operation.decision }); }
            catch (error) {
                if (error instanceof SourceError && error.delivery === 'not-dispatched'
                    && this.approvals.get(operation.requestId!) === pending && pending.request.generation === this.rpc.currentGeneration) pending.submitted = false;
                throw error;
            }
            const timeout = new AbortController();
            try {
                const outcome = await Promise.race([pending.acknowledged.then(() => true), delay(ACK_TIMEOUT, AbortSignal.any([signal, timeout.signal])).then(() => false)]);
                return outcome ? receipt('accepted', 'The native engine resolved the approval request.') : receipt('indeterminate', 'The approval response was sent; native resolution has not been observed. It will not be resent.');
            } finally { timeout.abort(); }
        }
        if ((operation.kind === 'send' || operation.kind === 'steer') && !operation.text?.trim()) {
            throw new SourceError('INVALID_REQUEST', 'The source prompt is empty.');
        }
        try {
            // Recheck the configured native owner at dispatch. Only explicit
            // sends may resume; history, steering and cancellation never do.
            let loaded: Set<string>;
            try { loaded = await this.loadedThreads(signal); } catch (error) { throw this.preflightFailure(error); }
            if (loaded.has(owner.native.id)) this.loaded.add(owner.native.id);
            else this.loaded.delete(owner.native.id);
            this.metadata(owner, this.descriptor(owner.native));
            if (!loaded.has(owner.native.id)) {
                if (operation.kind !== 'send') throw new SourceError('UNSUPPORTED', 'This thread is not loaded by the connected native app-server. Steering and cancellation cannot resume it.');
                if (this.config.ownership !== 'exclusive' && this.config.writerLock !== 'native') {
                    throw new SourceError('UNSUPPORTED', 'Continuing shared native history requires verified native thread writer locking.');
                }
                // Default Local storage acquires its cross-process writer lock
                // before starting the original thread. A live owner is never
                // displaced. No new thread, fork or alternate daemon is used.
                const resumed = threadResponseSchema.parse(await this.rpc.request('thread/resume', { threadId: owner.native.id, excludeTurns: true }, { write: true }));
                if (resumed.thread.id !== owner.native.id) throw new SourceError('OUTCOME_UNKNOWN', 'The native app-server resumed a different thread. No prompt was sent.');
                this.loaded.add(owner.native.id); this.remember(resumed.thread);
            }
            if (operation.kind === 'send' || operation.kind === 'steer') {
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
    private preflightFailure(error: unknown): unknown {
        if (error instanceof SourceError && ['INVALID_REQUEST', 'UNSUPPORTED'].includes(error.code)) return error;
        if (error instanceof CodexRpcError) return new SourceError('UNSUPPORTED', error.message);
        return new SourceError('TARGET_UNAVAILABLE', 'The native source could not be checked. No operation was dispatched.', 'not-dispatched');
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
        for (const stop of this.stops) stop();
        await Promise.all([this.rpc.dispose(), this.metadataReader.dispose(), this.imageReader.dispose(), ...[...this.threads.values()].map(owner => owner.attachments?.dispose())]);
        await Promise.allSettled([...this.receiptReads.values(), ...[...this.threads.values()].flatMap(owner => [owner.preparing, owner.refreshing].filter((work): work is Promise<void> => Boolean(work)))]);
        for (const owner of this.threads.values()) owner.history?.index.dispose();
        this.threads.clear(); this.approvals.clear();
    }
}
