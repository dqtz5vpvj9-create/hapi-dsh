import { capturePendingCall, pendingCallEvidence, type PendingCallAnchor } from './codex-pending-history.ts';
import { acceptNativeQuestions, type NativeQuestionState } from './codex-async-questions.ts';
import { nativeQuestionReply, NATIVE_ASYNC_QUESTION } from '../shared/native-async-questions.ts';
import { CodexUploads } from './codex-uploads.ts';
import type { SourceUploadRequest } from './protocol.ts';
import { sourceResumeContext, type SourceResumeContext } from '../workspace/source-navigation-api.ts';
import { SourceAttentionJournal, SourceAttentionAggregateJournal, type SourceAttentionEvent, type NotificationCursor, type SourceAttentionBatch, type SourceAttentionSourceBatch } from '../workspace/notification-events.ts';
/** Direct source-side Codex v2 adapter. Native thread identity and execution ownership are preserved. */
import { CodexAccessBridge } from './codex-access-bridge.ts';
import type { CodexCallResult } from './codex-access.ts';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join } from 'node:path';
import { CodexObservation, SupersededObservation } from './codex-observation.ts';
import { SourceError, waitFor } from './errors.ts';
import { sourceIsOffline, sourceOffline, sourceOnlineConnection } from '../shared/source-connectivity.ts';
import { CodexRpc, CodexRpcError, type NativeNotification, type NativeRequest } from './codex-rpc.ts';
import { CodexHistory, CODEX_HISTORY_PROJECTION_VERSION, type NativeReviewStart } from './codex-history.ts';
import { retainSelectedLegacyImages } from './codex-legacy-images.ts';
import { NativeMetadataReader, MissingNativeMetadataIndex } from './codex-metadata.ts';
import type { NativeMetadataRequest, NativeMetadataPage, NativeQuestionsRequest, NativeQuestionsPage } from './codex-metadata-core.mjs';
import { CodexAttachments } from './codex-attachments.ts';
import { CodexToolDetails } from './codex-tool-details.ts';
import { CodexImageReader } from './codex-image-reader.ts';
import { SourceEventIndex } from './event-index.ts';
import { OperationLedger, CreationLedger } from './operation-ledger.ts';
import { isRecord, itemListSchema, loadedListSchema, nativeItemSchema, nativeThreadSchema, nativeThreadTitle, nativeTurnSchema, threadListSchema, threadResponseSchema, turnListSchema, type NativeItemEntry, type NativeThread } from './codex-native.ts';
import { parseSourceSessionId, sourceSessionId, type DirectCodexConfig, type SourceAdapter, type SourceChanges, type SourceChangesRequest, type SourceCreateRequest, type SourceCreationReceipt, type SourceOperation, type SourcePage, type SourceReadRequest, type SourceReceipt, type SourceResource, type SourceResourceRequest, type SourceSession } from './protocol.ts';

interface ThreadOwner {
    native: NativeThread; session: SourceSession; history?: CodexHistory; attachments?: CodexAttachments; details?: CodexToolDetails;
    preparation?: { controller: AbortController; waiters: number; settled: boolean };
    preparing?: Promise<void>; refreshing?: Promise<void>; dirty: boolean; full: boolean;
    /** Native completion can arrive before its terminal history page is readable. */
    observation: CodexObservation; observers: number; touched: number; deleted: boolean; archived: boolean;
    pendingCompletions: Set<string>;
    /** Versions only cover accepted source snapshots; native delta strings are not reapplied over snapshots. */
    pending: NativeNotification[]; pendingBytes: number; pendingOverflow: boolean; ready: boolean; rewrite: boolean;
    /** Directory membership only; retained history/receipts and exact reads survive. */
    catalogRetired?: boolean;
    asyncQuestions?: NativeQuestionState;
}
interface PendingApproval { request: NativeRequest; sessionId: string; acknowledged: Promise<void>; resolve(): void; submitted: boolean; recovered?: boolean; visible?: boolean }
interface CachedPendingApproval { version: 1; daemon: string; epoch: string; id: string; request: NativeRequest; anchor: PendingCallAnchor; submitted: boolean; resolved: boolean }
interface NativeSourceRange { first: number | null; last: number | null; hasBefore: boolean; hasAfter: boolean }
interface NativeHistoryCheckpoint {
    version: 1;
    state: 'building' | 'complete';
    updatedAt: number;
    statusType: string;
}
interface AdapterOptions {
    localImageFiles?: boolean;
    rpc?: CodexRpc; pollMs?: number; readImage?: (path: string, signal: AbortSignal) => Promise<unknown>;
    now?: () => number; random?: () => number;
    readMetadata?: (request: NativeMetadataRequest, signal: AbortSignal) => Promise<NativeMetadataPage>;
    readQuestions?: (request: NativeQuestionsRequest, signal: AbortSignal) => Promise<NativeQuestionsPage>;
}
const MAX_CATALOG = 10_000;
const MAX_NATIVE_PAGES = 10_000;
const ACK_TIMEOUT = 15_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const NATIVE_PENDING_REQUESTS = 'native-pending-requests:v1';
const NATIVE_ASYNC_QUESTIONS = 'native-async-questions:v1';
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
    readonly nativeAccess: CodexAccessBridge;
    private readonly imageReader: CodexImageReader;
    private readonly metadataReader: NativeMetadataReader;
    private readonly readMetadata: (request: NativeMetadataRequest, signal: AbortSignal) => Promise<NativeMetadataPage>;
    private readonly readQuestions: (request: NativeQuestionsRequest, signal: AbortSignal) => Promise<NativeQuestionsPage>;
    private readonly readImage: (path: string, signal: AbortSignal) => Promise<unknown>;
    private readonly ledger: OperationLedger;
    private readonly creations: CreationLedger;
    private readonly threads = new Map<string, ThreadOwner>();
    private readonly loaded = new Set<string>();
    private readonly subscriptions = new Map<string, number>();
    private readonly subscriptionJoins = new Map<string, { generation: number; work: Promise<void> }>();
    private readonly approvals = new Map<string, PendingApproval>();
    private readonly receiptReads = new Map<string, Promise<void>>();
    private readonly lifetime = new AbortController();
    private readonly attention = new SourceAttentionJournal(this.lifetime.signal);
    private readonly sourceAttention = new SourceAttentionAggregateJournal(this.lifetime.signal);
    private attentionConnection = new AbortController();
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
        this.imageReader = new CodexImageReader(config, 30_000, options.localImageFiles === true);
        this.metadataReader = new NativeMetadataReader(config);
        this.readMetadata = options.readMetadata ?? ((request, signal) => this.metadataReader.read(request, signal));
        this.readQuestions = options.readQuestions ?? ((request, signal) => this.metadataReader.questions(request, signal));
        if (!options.readMetadata) this.metadataReader.warm();
        this.readImage = options.readImage ?? ((path, signal) => this.imageReader.read(path, signal));
        this.ledger = new OperationLedger(join(directory, 'operations'));
        this.creations = new CreationLedger(join(directory, 'creations'), JSON.stringify([this.machineId, this.id, this.engine]),
            [join(directory, 'operations'), join(directory, 'native-operations')]);
        this.nativeAccess = new CodexAccessBridge(this.id, this.rpc, directory,
            async (method, params) => {
                this.creations.invalidateProtection();
                if (typeof params?.threadId === 'string') this.creations.protectTarget(params.threadId);
                if (method === 'thread/resume' && this.config.ownership !== 'exclusive' && this.config.writerLock !== 'native') {
                    throw new SourceError('UNSUPPORTED', 'Resuming shared history requires verified native writer locking.');
                }
                if (method === 'thread/queue/add') {
                    if (typeof params?.threadId !== 'string' || !Array.isArray(params.input) || !params.input.length) throw new SourceError('INVALID_REQUEST', 'A native thread and nonempty queue input are required.');
                    const owner = await this.owner(sourceSessionId({ machineId: this.machineId, sourceId: this.id, engine: this.engine, nativeId: params.threadId }));
                    await this.ensureExecutionOwner(owner, true);
                }
                // Execution methods never silently resume or replace an existing owner.
                if (params && typeof params.threadId === 'string' && (method.startsWith('turn/') || method === 'thread/settings/update' || method === 'review/start' || method === 'thread/compact/start')) {
                    const loaded = await this.loadedThreads(this.lifetime.signal);
                    if (!loaded.has(params.threadId)) throw new SourceError('UNSUPPORTED', 'This thread is not loaded by this native execution owner.');
                    if (method === 'thread/settings/update') {
                        const owner = await this.owner(sourceSessionId({ machineId: this.machineId, sourceId: this.id, engine: this.engine, nativeId: params.threadId }));
                        await this.ensureExecutionOwner(owner, true, true);
                    }
                }
            },
            (method, params, response) => {
                this.creations.invalidateProtection();
                if (isRecord(response) && isRecord(response.thread)) {
                    const thread = nativeThreadSchema.safeParse(response.thread);
                    if (thread.success) {
                        if (method === 'thread/start' || method === 'thread/fork') this.creations.protectTarget(thread.data.id);
                        if (method === 'thread/start' || method === 'thread/fork' || method === 'thread/resume') this.subscriptions.set(thread.data.id, this.rpc.currentGeneration);
                        this.rememberResponse({ ...response, thread: thread.data });
                    }
                }
                const owner = typeof params?.threadId === 'string' ? this.threads.get(params.threadId) : undefined;
                if (owner && (method === 'thread/archive' || method === 'thread/unarchive')) {
                    owner.observation.invalidateHistory();
                    owner.archived = method === 'thread/archive';
                    if (owner.archived) this.markOffline(owner);
                    else this.metadata(owner, this.descriptor(owner.native));
                }
                this.catalogAt = 0;
            },
            async (request, operationId, response) => {
                const owner = this.threads.get(String(request.params.threadId));
                if (!owner || !isRecord(response)) throw new SourceError('INVALID_REQUEST', 'Native response requires an owned thread and an object result.');
                const receipt = await this.operate({ sessionId: owner.session.id, operationId, kind: 'approve', requestId: this.approvalId(request.id, request.generation), response });
                return { status: receipt.status, message: receipt.message };
            }, (method, params) => this.reconcileNativeInput(method, params), async (method, params, callerSignal) => {
                if (method !== 'thread/search') return undefined;
                if (!params) throw new SourceError('INVALID_REQUEST', 'A message query is required.');
                if (!this.config.historyMetadata && options.localImageFiles !== true) throw new SourceError('HISTORY_UNAVAILABLE', 'Search needs the original source filesystem or its configured read-only history helper.');
                const signal = callerSignal ? AbortSignal.any([callerSignal, this.lifetime.signal]) : this.lifetime.signal;
                const initialized = await this.rpc.connect(signal);
                const page = await this.metadataReader.search({ home: initialized.codexHome, params }, signal);
                const data = [];
                for (const match of page.data) {
                    signal.throwIfAborted();
                    const response = threadResponseSchema.parse(await this.rpc.request('thread/read', { threadId: match.threadId, includeTurns: false }, { signal }));
                    if (response.thread.id !== match.threadId) throw new SourceError('INVALID_REQUEST', 'The native source returned another search identity.');
                    data.push({ thread: response.thread, snippet: match.snippet });
                }
                return { status: 'accepted', message: 'Source history search read.', result: { data, nextCursor: page.nextCursor } };
            });
        this.stops = [this.rpc.onNotification(value => { this.notification(value); }), this.rpc.onRequest(request => { this.approval(request); }), this.rpc.onDisconnect(() => { this.disconnected(); })];
        // A source lifetime is independent of any Pane. This never cancels its native turn.
        this.timer = setInterval(() => {
            if (this.disposed || this.now() < this.retryReadsAt) return;
            for (const owner of this.threads.values()) {
                if (owner.history && owner.observers === 0 && !owner.refreshing && !owner.preparing && !this.receiptReads.has(owner.native.id) && this.now() - owner.touched > 30_000) {
                    owner.observation.invalidateHistory(); void owner.attachments?.dispose(); owner.history.index.dispose();
                    delete owner.history; delete owner.attachments; delete owner.details; owner.ready = false;
                }
                if (owner.observers === 0) continue;
                if (!owner.history || !owner.ready || owner.preparing) continue;
                if (owner.dirty || owner.full || owner.pendingCompletions.size || owner.session.status === 'running' || owner.session.status === 'waiting') {
                    void this.refresh(owner, owner.full).catch(() => { this.markOffline(owner); });
                }
            }
        }, options.pollMs ?? 250);
        this.timer.unref();
    }
    private uploads?: CodexUploads;
    private fileUploads(): CodexUploads { return this.uploads ??= new CodexUploads(join(this.directory, 'uploads'), this.nativeAccess); }
    async upload(request: SourceUploadRequest, signal?: AbortSignal) { return this.fileUploads().upload(await this.resolve(request.sessionId, signal), request, signal); }
    /** Read existing upload receipts under the same native Session; no upload or execution is created. */
    async uploadInputs(sessionId: string, receiptIds: readonly string[], signal?: AbortSignal, clientUserMessageId?: string) {
        await this.resolve(sessionId, signal);
        const input = await this.fileUploads().inputs(sessionId, receiptIds, signal);
        if (clientUserMessageId) await this.fileUploads().associate(sessionId, clientUserMessageId, receiptIds, signal);
        signal?.throwIfAborted();
        return input;
    }
    /** Exact native metadata lookup plus a bounded page; never scan from the beginning or substitute latest. */
    async locatePosition(sessionId: string, position: { turnId: string; itemId?: string }, callerSignal?: AbortSignal): Promise<{ epoch: string; seq: number }> {
        this.assertScope(sessionId);
        const signal = callerSignal ? AbortSignal.any([this.lifetime.signal, callerSignal]) : this.lifetime.signal;
        const owner = await this.owner(sessionId, signal);
        owner.observers++;
        try {
        let pinnedHistory: CodexHistory | undefined, pinnedEpoch: string | undefined;
        return await this.observeRead(async () => {
        await this.prepare(owner, signal);
        const history = owner.history!, index = history.index;
        if (pinnedHistory && (history !== pinnedHistory || index.epoch !== pinnedEpoch)) throw new SourceError('STALE_VERSION', 'The source replaced this history while its native position was being located.');
        pinnedHistory ??= history;
        const epoch = pinnedEpoch ??= index.epoch;
        const initialized = await this.rpc.connect(signal);
        const query: NativeMetadataRequest = { home: initialized.codexHome, threadId: owner.native.id, position, limit: 1 };
        const metadata = await this.readMetadata(query, signal); signal.throwIfAborted();
        if (metadata.positionMissing === undefined) throw new SourceError('UNSUPPORTED', 'The source metadata helper must be updated to locate exact native positions. The original reference is kept.');
        const item = metadata.items.find(item => item.turnId === position.turnId && (position.itemId === undefined || item.itemId === position.itemId));
        const turn = metadata.turns.find(turn => turn.id === position.turnId);
        const ordinal = item?.ordinal;
        if (metadata.positionMissing || ordinal === undefined) throw new SourceError('TARGET_UNAVAILABLE', 'The original native position is no longer available. Its exact reference was kept.');
        await this.readNativePage(owner, { sessionId, epoch, around: ordinal * 8, limit: 32 }, false, signal);
        const current = owner.observation.capture(() => this.rpc.currentGeneration, () => owner.history, () => index.epoch, () => index.version);
        const verified = await this.readMetadata(query, signal); signal.throwIfAborted();
        const same = JSON.stringify(verified.turns.find(value => value.id === position.turnId)) === JSON.stringify(turn)
            && JSON.stringify(verified.items.find(value => value.turnId === position.turnId && (position.itemId === undefined || value.itemId === position.itemId))) === JSON.stringify(item);
        if (!same || verified.positionMissing || verified.coordinates !== metadata.coordinates) throw new SourceError('STALE_VERSION', 'The original native position changed while it was being located. Retry its exact reference.');
        return owner.observation.commit(current, () => {
            if (index.cached<string>('native-source-coordinates') !== verified.coordinates) throw new SourceError('STALE_VERSION', 'The original native history was replaced while its position was being located.');
            const seq = history.locatePosition(position.turnId, item!.itemId);
            if (seq === undefined) throw new SourceError('TARGET_UNAVAILABLE', 'The original native item has no accepted reading position. Its exact reference was kept.');
            return { epoch: index.epoch, seq };
        });
        }, signal);
        } finally { owner.observers--; owner.touched = this.now(); }
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
        const blockingRequests = [...this.approvals].filter(([, pending]) => pending.sessionId === id && pending.visible !== false).map(([requestId, pending]) => ({
            id: requestId, method: pending.request.method,
            turnId: typeof pending.request.params.turnId === 'string' ? pending.request.params.turnId : null,
            itemId: typeof pending.request.params.itemId === 'string' ? pending.request.params.itemId : null,
            params: pending.request.params,
        }));
        const pendingRequests = [...blockingRequests, ...(this.threads.get(nativeId)?.asyncQuestions?.active ?? [])];
        const running = thread.status.type === 'active';
        const loaded = this.loaded.has(nativeId);
        // A stored thread can accept an explicit continuation without already
        // being loaded here. The native writer lock decides execution ownership.
        const resumable = this.config.ownership === 'exclusive' || this.config.writerLock === 'native';
        return { id, sourceId: this.id, machineId: this.machineId, engine: this.engine, nativeId,
            title: nativeThreadTitle(thread), cwd: thread.cwd, updatedAt: thread.updatedAt * 1000,
            status: blockingRequests.length || running && Array.isArray(thread.status.activeFlags) && thread.status.activeFlags.some(flag => flag === 'waitingOnUserInput' || flag === 'waitingOnApproval') ? 'waiting' : running ? 'running' : 'idle',
            connection: this.rpc.online ? sourceOnlineConnection(previous, this.now()) : { state: 'offline', observedAt: this.now() },
            activeTurnId: running ? previous?.activeTurnId ?? null : null,
            codex: { model: typeof thread.model === 'string' ? thread.model : null, reasoningEffort: typeof thread.reasoningEffort === 'string' ? thread.reasoningEffort : null, parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null, agentNickname: typeof thread.agentNickname === 'string' ? thread.agentNickname : null, ...(isRecord(thread.threadSettings) ? { settings: thread.threadSettings } : previous?.codex?.settings ? { settings: previous.codex.settings } : {}) },
            capabilities: { send: resumable || loaded && this.subscriptions.get(nativeId) === this.rpc.currentGeneration, steer: loaded, cancel: loaded, approve: pendingRequests.length > 0, files: true, images: true }, pendingRequests };
    }
    private remember(thread: NativeThread): ThreadOwner {
        let owner = this.threads.get(thread.id);
        const session = this.descriptor(thread);
        if (owner) { owner.native = thread; owner.catalogRetired = false; this.metadata(owner, session); }
        else { owner = { observation: new CodexObservation(), observers: 0, touched: this.now(), deleted: false, archived: false, native: thread, session, dirty: false, full: true, pendingCompletions: new Set(), pending: [], pendingBytes: 0, pendingOverflow: false, ready: false, rewrite: false }; this.threads.set(thread.id, owner); }
        return owner;
    }
    private rememberResponse(response: { thread: NativeThread } & Record<string, unknown>): ThreadOwner {
        // start/resume/fork report effective settings beside `thread` in v2.
        // Preserve only fields actually returned; an empty write ACK or an
        // ordinary thread/read must never turn a requested value into current.
        const settings = isRecord(response.thread.threadSettings) ? { ...response.thread.threadSettings } : {};
        for (const key of ['activePermissionProfile', 'approvalPolicy', 'approvalsReviewer', 'collaborationMode', 'serviceTier']) {
            if (key in response) settings[key] = response[key];
        }
        return this.remember({ ...response.thread,
            ...(typeof response.model === 'string' ? { model: response.model } : {}),
            ...(response.reasoningEffort === null || typeof response.reasoningEffort === 'string' ? { reasoningEffort: response.reasoningEffort } : {}),
            ...(Object.keys(settings).length ? { threadSettings: settings } : {}),
        });
    }
    private metadata(owner: ThreadOwner, session: SourceSession): void {
        if (JSON.stringify(owner.session) !== JSON.stringify(session)) owner.observation.invalidate();
        owner.session = session;
        if (owner.history) owner.history.index.edit(session, () => {});
    }
    private markOffline(owner: ThreadOwner): void {
        owner.observation.invalidateHistory();
        owner.attachments?.revoke();
        owner.full = true;
        this.metadata(owner, sourceOffline(owner.session, this.now()));
    }
    private disconnected(): void {
        this.attention.reset(); this.sourceAttention.reset(); this.attentionConnection.abort(new Error('The native notification connection changed'));
        this.attentionConnection = new AbortController();
        this.readFailed();
        this.catalogAt = 0; this.loaded.clear(); this.subscriptions.clear(); this.subscriptionJoins.clear(); this.approvals.clear();
        for (const owner of this.threads.values()) { owner.observation.invalidateHistory(); owner.pending.length = 0; owner.pendingBytes = 0; this.markOffline(owner); }
    }
    private catalogSessions(): SourceSession[] {
        // Native ephemeral threads reject both paginated history and thread/read(includeTurns).
        // Retain their metadata for explicit old-link rejection, but never advertise them as readable.
        return [...this.threads.values()].filter(owner => owner.native.ephemeral !== true && !owner.deleted && !owner.archived && !owner.catalogRetired).map(owner => owner.session);
    }
    private assertReadable(thread: NativeThread): void {
        if (thread.ephemeral === true) throw new SourceError('UNSUPPORTED', 'The native app-server does not expose history for ephemeral threads.');
    }
    async list(signal?: AbortSignal): Promise<SourceSession[]> {
        this.lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
        if (this.rpc.online && this.catalogAt > 0 && this.now() - this.catalogAt < 15_000) return this.catalogSessions();
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
        const generation = this.rpc.currentGeneration;
        const observations = new Map([...this.threads].map(([id, owner]) => [id, owner.observation.capture()]));
        const loaded = await this.loadedThreads(signal);
        let cursor: string | null = null;
        this.loaded.clear(); for (const id of loaded) this.loaded.add(id);
        const accepted = new Set<string>(), cursors = new Set<string>();
        do {
            const page = threadListSchema.parse(await this.rpc.request('thread/list', { limit: 100, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true, ...(cursor ? { cursor } : {}) }, { signal }));
            for (const thread of page.data) { accepted.add(thread.id); if (generation === this.rpc.currentGeneration && observations.get(thread.id)?.() !== false) this.remember(thread).archived = false; }
            if (accepted.size > MAX_CATALOG) throw new SourceError('CAPACITY_EXCEEDED', 'This source catalog exceeds the 10,000-session limit.');
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor)) throw new SourceError('TARGET_UNAVAILABLE', 'The native thread-list cursor did not progress.');
            if (cursor) cursors.add(cursor);
        } while (cursor);
        if (generation !== this.rpc.currentGeneration) throw new SourceError('TARGET_UNAVAILABLE', 'The native catalog connection was replaced.');
        // Ephemeral loaded native threads may be absent from the persisted catalog.
        for (const id of loaded) if (!accepted.has(id)) {
            const response = threadResponseSchema.parse(await this.rpc.request('thread/read', { threadId: id, includeTurns: false }, { signal }));
            this.remember(response.thread); accepted.add(id);
        }
        // An omission can be a transient catalog gap. Hide only IDs the native
        // archived directory explicitly confirms, never every absent owner.
        const omitted = new Set([...this.threads].filter(([id, owner]) => !accepted.has(id) && !owner.archived && !owner.deleted && !owner.catalogRetired).map(([id]) => id));
        const archivedCursors = new Set<string>();
        cursor = null;
        while (omitted.size) {
            const page = threadListSchema.parse(await this.rpc.request('thread/list', { archived: true, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true, ...(cursor ? { cursor } : {}) }, { signal }));
            for (const thread of page.data) if (omitted.delete(thread.id) && observations.get(thread.id)?.() !== false) this.threads.get(thread.id)!.archived = true;
            cursor = page.nextCursor;
            if (!cursor) break;
            if (archivedCursors.has(cursor) || archivedCursors.size >= MAX_NATIVE_PAGES) throw new SourceError('TARGET_UNAVAILABLE', 'The native archived-thread cursor did not progress within its source budget.');
            archivedCursors.add(cursor);
        }
        // A restored zero-turn rollout can be readable before the native state
        // database lists it again. Verify only already-known, unconfirmed gaps;
        // an archived-directory fact is never replaced by a successful read.
        const unloaded: string[] = [];
        for (const id of omitted) {
            if (observations.get(id)?.() === false) continue;
            try {
                const response = threadResponseSchema.parse(await this.rpc.request('thread/read', { threadId: id, includeTurns: false }, { signal }));
                if (response.thread.id !== id) throw new SourceError('INVALID_REQUEST', 'The native source returned another thread.');
                if (generation === this.rpc.currentGeneration && observations.get(id)?.() !== false) { this.remember(response.thread); accepted.add(id); }
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof SourceError && error.code === 'INVALID_REQUEST') throw error;
                if (!loaded.has(id) && error instanceof CodexRpcError && error.code === -32600 && error.message === `thread not loaded: ${id}`) unloaded.push(id);
                // Keep the last-known offline entry when the exact owner cannot
                // confirm this gap; absence never becomes an archive decision.
            }
        }
        // Only exact not-loaded outcomes after complete active/archive/loaded
        // directories may ask the source-local persistence owner for proof.
        if (unloaded.length) {
            const protection = await this.creations.protection();
            const candidates = unloaded.filter(id => {
                const owner = this.threads.get(id)!;
                return !protection.unknown && !protection.targets.has(id) && owner.observers === 0
                    && owner.native.status.type === 'idle' && !owner.pendingCompletions.size
                    && !owner.native.preview?.trim() && !(typeof owner.native.path === 'string' && owner.native.path)
                    && !owner.native.turns?.length && !owner.native.parentThreadId
                    && !owner.history?.index.read({ sessionId: owner.session.id, limit: 1 }).entries.length;
            }).slice(0, 32).map(id => ({ threadId: id, createdAt: this.threads.get(id)!.native.createdAt }));
            if (candidates.length) {
                const initialized = await this.rpc.connect(signal);
                const proof = await this.metadataReader.lifecycles({ kind: 'lifecycle', home: initialized.codexHome, candidates }, signal).catch(() => ({ absent: [] }));
                const protectedNow = await this.creations.protection();
                for (const id of proof.absent) {
                    const owner = this.threads.get(id);
                    if (owner && candidates.some(candidate => candidate.threadId === id) && !owner.observers
                        && generation === this.rpc.currentGeneration && observations.get(id)?.() === true
                        && !protectedNow.unknown && !protectedNow.targets.has(id)) owner.catalogRetired = true;
                }
            }
        }
        if (generation !== this.rpc.currentGeneration) throw new SourceError('TARGET_UNAVAILABLE', 'The native catalog connection was replaced.');
        for (const [id, owner] of this.threads) if (!accepted.has(id) && observations.get(id)?.() !== false) this.markOffline(owner);
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
        if (owner.deleted) throw new SourceError('HISTORY_UNAVAILABLE', 'The native owner removed this thread.');
        owner.touched = this.now();
        this.assertReadable(owner.native);
        return owner;
    }
    async resolve(sessionId: string, signal?: AbortSignal): Promise<SourceSession> {
        return (await this.owner(sessionId, signal)).session;
    }
    /** Copy-only CLI metadata from this same native connection; never resume or create a thread. */
    async resumeContext(sessionId: string, callerSignal: AbortSignal): Promise<SourceResumeContext> {
        this.assertScope(sessionId);
        const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
        const session = await this.resolve(sessionId, signal), initialized = await this.rpc.connect(signal);
        signal.throwIfAborted();
        const result = sourceResumeContext.safeParse({ sessionId, machineId: session.machineId, sourceId: session.sourceId,
            engine: session.engine, nativeId: session.nativeId, cwd: session.cwd, codexHome: initialized.codexHome,
            platformOs: initialized.platformOs, platformFamily: initialized.platformFamily });
        if (!result.success) throw new SourceError('UNSUPPORTED', 'The original source has not reported a usable CLI store and operating system.');
        return result.data;
    }
    /** Native attention has no dependency on history preparation, attachments or a Pane. */
    async *notificationEvents(sessionId: string, cursor: NotificationCursor | undefined, signal: AbortSignal): AsyncIterable<SourceAttentionBatch> {
        await waitFor(this.connectForRead(), signal);
        await this.owner(sessionId, signal);
        const lifetime = AbortSignal.any([signal, this.lifetime.signal, this.attentionConnection.signal]);
        yield* this.attention.notificationEvents(sessionId, cursor, lifetime);
    }
    /** Source-level observation shares the live RPC and never lists, resolves or opens a thread. */
    async *attentionEvents(cursor: NotificationCursor | undefined, signal: AbortSignal): AsyncIterable<SourceAttentionSourceBatch> {
        await waitFor(this.connectForRead(), signal);
        const lifetime = AbortSignal.any([signal, this.lifetime.signal, this.attentionConnection.signal]);
        yield* this.sourceAttention.attentionEvents(cursor, lifetime);
    }
    private publishAttention(sessionId: string, event: SourceAttentionEvent): void {
        this.attention.publish(sessionId, event); this.sourceAttention.publish(sessionId, event);
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
    private history(owner: ThreadOwner): CodexHistory {
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
            history = new CodexHistory(index, { userContent: (turnId, item) => this.fileUploads().content(owner.session.id, item, attachments.content(turnId, item)) ?? attachments.content(turnId, item),
                toolContent: (turnId, item) => attachments.content(turnId, item), nativeOrder: true, toolPresentation: (turnId, item, tool) => details.project(turnId, item, tool) });
        }
        owner.history = history;
        return history;
    }
    private startPreparation(owner: ThreadOwner): void {
        const preparation = { controller: new AbortController(), waiters: 0, settled: false };
        const signal = AbortSignal.any([this.lifetime.signal, preparation.controller.signal]);
        owner.preparation = preparation;
        const work = (async () => {
            const history = this.history(owner);
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
                owner.ready = false; if (!signal.aborted && !(error instanceof SupersededObservation)) this.markOffline(owner); throw error;
            }
        })().finally(() => {
            preparation.settled = true;
            if (owner.preparing === work) { delete owner.preparing; delete owner.preparation; }
        });
        owner.preparing = work;
    }
    /** Independent accepted pages can invalidate concurrent read observations.
     * Reobserve only that internal conflict, preserving the caller's exact target
     * and epoch. Native failures and stale source cursors are never retried here. */
    private async observeRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            signal?.throwIfAborted();
            try { return await read(); }
            catch (error) { if (!(error instanceof SupersededObservation) || attempt >= 2) throw error; }
        }
    }
    async read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
        return this.observeRead(() => this.readAcceptedPage(request, signal), signal);
    }
    private async readAcceptedPage(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage> {
        const owner = await this.owner(request.sessionId, signal);
        owner.observers++;
        try {
        await this.prepare(owner, signal); signal?.throwIfAborted();
        // A fixed older page validates its own source revisions. Tail dirtiness
        // stays with the live reader instead of adding a head read to this cursor.
        if ((owner.dirty || owner.full || owner.rewrite) && !owner.preparing
            && (request.before === undefined || owner.full || owner.rewrite)) await this.refresh(owner, owner.full, signal);
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
        } finally { owner.observers--; owner.touched = this.now(); }
    }
    async *changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
        const owner = await this.owner(request.sessionId, signal);
        owner.observers++;
        try {
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
        } finally { owner.observers--; owner.touched = this.now(); }
    }
    async readResource(request: SourceResourceRequest, signal?: AbortSignal): Promise<SourceResource> {
        const owner = await this.owner(request.sessionId, signal);
        owner.observers++;
        try {
        await this.prepare(owner, signal);
        if (owner.full) await waitFor(this.refresh(owner, true), signal);
        if (sourceIsOffline(owner.session)) throw new SourceError('TARGET_UNAVAILABLE', 'The native source is offline.');
        return await (request.path.startsWith('detail:') ? owner.details!.read(request.path) : owner.attachments!.read(request.path, signal));
        } finally { owner.observers--; owner.touched = this.now(); }
    }
    private refresh(owner: ThreadOwner, full: boolean, callerSignal?: AbortSignal): Promise<void> {
        if (owner.refreshing) { owner.dirty = true; owner.full ||= full; return waitFor(owner.refreshing, callerSignal); }
        const signal = callerSignal ? AbortSignal.any([this.lifetime.signal, callerSignal]) : this.lifetime.signal;
        const work = waitFor(this.connectForRead(), signal).then(async () => {
            try { await this.refreshNative(owner, full, signal); }
            catch (error) {
                if (!(error instanceof SupersededObservation)) throw error;
                signal.throwIfAborted(); await this.refreshNative(owner, true, signal);
            }
        }).then(() => { this.readRecovered(); }, (error: unknown) => {
            if (!signal.aborted && !(error instanceof SupersededObservation)) this.readFailed(); throw error;
        }).finally(() => { if (owner.refreshing === work) delete owner.refreshing; });
        owner.refreshing = work;
        return work;
    }
    private async refreshNative(owner: ThreadOwner, full: boolean, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        const history = owner.history!;
        owner.dirty = false; owner.full = false;
        const metadataCurrent = owner.observation.capture(() => this.rpc.currentGeneration, () => owner.history);
        const response = threadResponseSchema.parse(await this.rpc.request('thread/read', { threadId: owner.native.id, includeTurns: false }, { signal }));
        if (!metadataCurrent()) throw new SupersededObservation();
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
        await this.recoverPending(owner);
        try { await this.recoverAsyncQuestions(owner, signal); }
        catch (error) {
            // Optional interaction projection cannot make readable chat fail.
            // Keep its last good state. Dispatch below performs a strict fresh
            // confirmation and never authorizes a reply from this cached state.
            if (signal.aborted || error instanceof SupersededObservation) throw error;
        }
        owner.attachments?.acceptRevision(owner.attachments.revisionToken);
    }
    /** A fresh 0.162 home has no sparse database before its first user input.
     * Confirm that exact native state; missing files alone never prove empty. */
    private async readPageMetadata(query: NativeMetadataRequest, signal: AbortSignal): Promise<NativeMetadataPage> {
        try { return await this.readMetadata(query, signal); }
        catch (error) {
            if (!(error instanceof MissingNativeMetadataIndex)) throw error;
            try { await this.rpc.request('thread/turns/list', { threadId: query.threadId, limit: 1 }, { signal }); }
            catch (nativeError) {
                signal.throwIfAborted();
                if (nativeError instanceof CodexRpcError && nativeError.code === -32600
                    && nativeError.message === `thread ${query.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`) {
                    // Recheck the database after confirmation: the first turn
                    // may have materialized while the native read was in flight.
                    return this.readMetadata({ ...query, unmaterialized: true }, signal);
                }
            }
            throw error;
        }
    }
    /** Fetch native metadata first, then only selected item bodies. History size
     * never determines the work needed to show a page. Native ordinals admit
     * older events before an existing window without changing any identity. */
    private async readNativePage(owner: ThreadOwner, request: SourceReadRequest, userOnly = false, callerSignal?: AbortSignal): Promise<NativeSourceRange> {
        const signal = callerSignal ? AbortSignal.any([this.lifetime.signal, callerSignal]) : this.lifetime.signal, history = owner.history!, index = history.index;
        if (request.epoch !== undefined && request.epoch !== index.epoch) throw new SourceError('STALE_VERSION', 'The source replaced this history cursor.');
        const initialized = await this.rpc.connect(signal);
        const historical = request.before !== undefined;
        const current = historical
            ? owner.observation.captureHistory(() => this.rpc.currentGeneration, () => owner.history, () => index.epoch, () => owner.native.path)
            : owner.observation.capture(() => this.rpc.currentGeneration, () => owner.history, () => index.epoch, () => index.version);
        const query: NativeMetadataRequest = { home: initialized.codexHome, threadId: owner.native.id, limit: Math.ceil((request.limit ?? 160) / 8), ...(userOnly ? { userOnly: true } : {}),
            ...(request.before === undefined ? {} : { before: Math.floor((request.before - 1) / 8) }),
            ...(request.after === undefined ? {} : { after: Math.floor(request.after / 8) }),
            ...(request.around === undefined ? {} : { around: Math.floor(request.around / 8) }) };
        const metadata = await this.readPageMetadata(query, signal);
        signal.throwIfAborted();
        const latestRead = !userOnly && request.before === undefined && request.after === undefined && request.around === undefined;
        const sourceLast = Math.max(0, ...metadata.items.map(item => item.ordinal), ...metadata.turns.map(turn => turn.endOrdinal ?? turn.ordinal));
        const previousLast = index.cached<number>('native-source-last');
        const oldCoordinates = index.cached<string>('native-source-coordinates');
        const replaced = oldCoordinates !== undefined && oldCoordinates !== metadata.coordinates
            || latestRead && previousLast !== undefined && sourceLast < previousLast;
        if (replaced && request.epoch !== undefined) throw new SourceError('STALE_VERSION', 'The native execution history changed.');
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
        const reviewStarts = new Map<string, NativeReviewStart>();
        const prefixes: Array<{ query: NativeMetadataRequest; page: NativeMetadataPage }> = [];
        for (const turn of metadata.turns) {
            // 0.162 Review may first insert its outer sparse row at completion.
            // An exact first-item lookup also works for end-only selected pages.
            if (turn.ordinal !== turn.endOrdinal) continue;
            const cached = replaced ? undefined : index.cached<NativeReviewStart>(`source-review-start:${turn.id}`);
            if (cached?.turnOrdinal === turn.ordinal) { reviewStarts.set(turn.id, cached); continue; }
            const prefixQuery: NativeMetadataRequest = { home: initialized.codexHome, threadId: owner.native.id, position: { turnId: turn.id }, limit: 1 };
            const prefix = await this.readMetadata(prefixQuery, signal);
            if (prefix.coordinates !== metadata.coordinates) throw new SupersededObservation();
            const first = prefix.items[0];
            if (!first || first.ordinal > turn.ordinal) continue;
            let entry = accepted.flatMap(group => group.entries).find(entry => entry.turnId === turn.id && entry.item.id === first.itemId);
            if (!entry) {
                const page = itemListSchema.parse(await this.rpc.request('thread/items/list', { threadId: owner.native.id,
                    turnId: turn.id, sortDirection: 'asc', limit: 1 }, { signal }));
                if (page.data.length !== 1 || page.data[0]!.turnId !== turn.id || page.data[0]!.item.id !== first.itemId) {
                    throw new SourceError('TARGET_UNAVAILABLE', 'The native Review prefix changed while it was being read.');
                }
                entry = page.data[0]!;
            }
            if (entry.item.type !== 'enteredReviewMode') continue;
            reviewStarts.set(turn.id, { itemId: first.itemId, ordinal: first.ordinal, turnOrdinal: turn.ordinal });
            prefixes.push({ query: prefixQuery, page: prefix });
        }
        const terminalReviews = new Map<string, NativeMetadataPage['turns'][number]>();
        let turns = metadata.turns.map(turn => {
            const cached = replaced ? undefined : index.cached<NativeMetadataPage['turns'][number]>(`source-review-terminal:${turn.id}`);
            return turn.status === 'inProgress' && cached?.ordinal === turn.ordinal && cached.status !== 'inProgress'
                ? { ...turn, status: cached.status, startedAt: cached.startedAt, completedAt: cached.completedAt,
                    ...(cached.error === undefined ? {} : { error: cached.error }) } : { ...turn };
        });
        if (reviewStarts.size && owner.native.status.type === 'idle' && turns.some(turn => turn.status === 'inProgress')) {
            // Nested Review sparse rows can remain inProgress. Ask for one
            // bounded native tail and adopt only exact terminal turn facts;
            // never infer an end ordinal from the idle header or Review result.
            const page = turnListSchema.parse(await this.rpc.request('thread/turns/list', { threadId: owner.native.id,
                sortDirection: 'desc', limit: 100, itemsView: 'notLoaded' }, { signal }));
            turns = turns.map(turn => {
                const native = page.data.find(native => native.id === turn.id && native.status !== 'inProgress');
                if (turn.status !== 'inProgress' || !native) return turn;
                const terminal = { ...turn, status: native.status,
                    startedAt: native.startedAt ?? turn.startedAt, completedAt: native.completedAt ?? turn.completedAt,
                    ...(native.error === undefined ? {} : { error: native.error }) };
                terminalReviews.set(turn.id, terminal);
                return terminal;
            });
        }
        for (const group of accepted) group.terminal = turns.find(turn => turn.id === group.entries[0]?.turnId)?.status !== 'inProgress';
        if (historical || accepted.length || prefixes.length) {
            const verified = await this.readMetadata(query, signal);
            const identity = (page: NativeMetadataPage) => JSON.stringify([page.coordinates, page.items, page.turns, page.first, page.last, page.hasBefore, page.hasAfter]);
            if (identity(metadata) !== identity(verified)) throw new SourceError('TARGET_UNAVAILABLE', 'The selected native revisions changed during the body read. Existing history is unchanged.');
            for (const prefix of prefixes) if (identity(prefix.page) !== identity(await this.readMetadata(prefix.query, signal))) {
                throw new SourceError('TARGET_UNAVAILABLE', 'The native Review prefix changed during the body read. Existing history is unchanged.');
            }
        }
        signal.throwIfAborted();
        // Remote IO is complete. One synchronous transaction publishes a
        // complete selected page, not one fsync/journal frame per lifecycle.
        const positions = [...metadata.items.map(item => item.ordinal), ...metadata.turns.flatMap(turn => turn.endOrdinal === null ? [] : [turn.endOrdinal])];
        const first = metadata.first === undefined ? (positions.length ? Math.min(...positions) : null) : metadata.first;
        const last = metadata.last === undefined ? (positions.length ? Math.max(...positions) : null) : metadata.last;
        const range: NativeSourceRange = { first: first === null ? null : first * 8, last: last === null ? null : last * 8 + 7,
            hasBefore: metadata.hasBefore, hasAfter: metadata.hasAfter };
        return owner.observation.commit(current, () => {
        // A concurrently accepted page may already hold a later revision of
        // one selected item. Never overwrite it with a delayed native response.
        for (const item of metadata.items) {
            if ((index.cached<number>(`source-revision:${item.turnId}:${item.itemId}`) ?? -1) > item.revision
                || (index.cached<number>(`source-declared-revision:${item.turnId}:${item.itemId}`) ?? -1) > item.revision) throw new SupersededObservation();
        }
        if (historical) turns = turns.map(turn => {
            const previous = history.turnState(turn.id);
            return turn.status === 'inProgress' && previous && previous.status !== 'inProgress'
                ? { ...turn, status: previous.status, startedAt: previous.startedAt ?? turn.startedAt,
                    completedAt: previous.completedAt ?? turn.completedAt, ...(previous.error === undefined ? {} : { error: previous.error }) } : turn;
        });
        const runningTurn = turns.find(turn => turn.status === 'inProgress');
        const session = !historical && runningTurn && (!owner.session.activeTurnId || owner.session.activeTurnId === runningTurn.id)
            ? { ...owner.session, activeTurnId: runningTurn.id, status: owner.session.status === 'waiting' ? 'waiting' as const : 'running' as const } : owner.session;
        index.batch(session, () => {
            if (replaced) { index.removeFrom(0); index.forget(''); }
            index.cache('native-source-coordinates', metadata.coordinates);
            if (latestRead) index.cache('native-source-last', sourceLast);
            for (const turn of metadata.turns) {
                index.cache(`source-turn:${turn.id}`, turn.ordinal);
                if (turn.endOrdinal !== null) index.cache(`source-end:${turn.id}`, turn.endOrdinal);
            }
            for (const [turnId, start] of reviewStarts) index.cache(`source-review-start:${turnId}`, start);
            for (const [turnId, turn] of terminalReviews) index.cache(`source-review-terminal:${turnId}`, turn);
            for (const item of metadata.items) {
                index.cache(`source-item:${item.turnId}:${item.itemId}`, item.ordinal);
                index.cache(`source-declared-revision:${item.turnId}:${item.itemId}`, item.revision);
            }
            for (const turn of turns) history.beginTurn(session, { ...turn });
            for (const group of accepted) {
                const entries = group.entries.map(entry => this.monotoneSnapshot(history, entry, group.terminal)).filter((entry): entry is NativeItemEntry => entry !== undefined);
                const hash = createHash('sha256').update(owner.session.id).digest('hex');
                retainSelectedLegacyImages(['.v7.sqlite', '.v6.sqlite', '.v5.sqlite', '.v4.sqlite', '.v3.sqlite', '.v2.sqlite', '.sqlite'].map(suffix => join(this.directory, 'history', `${hash}${suffix}`)),
                    index, owner.session, owner.native, entries);
                history.acceptItems(session, entries, group.terminal);
                for (const item of group.items) index.cache(`source-revision:${item.turnId}:${item.itemId}`, item.revision);
            }
            for (const turn of turns) {
                history.acceptTurn(session, { ...turn });
                if (turn.status !== 'inProgress') owner.pendingCompletions.delete(turn.id);
            }
            if (latestRead) index.cache('native-source-tail', range);
        });
        owner.session = session;
        return range;
        });
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
        if (frame.method === 'turn/completed' && isRecord(frame.params.turn)
            && typeof frame.params.turn.id === 'string'
            && (frame.params.turn.status === 'completed' || frame.params.turn.status === 'failed')) {
            const turn = frame.params.turn;
            this.publishAttention(sourceSessionId({ machineId: this.machineId, sourceId: this.id, engine: this.engine, nativeId: threadId }), {
                id: JSON.stringify(['turn', turn.id, turn.status]), kind: turn.status === 'failed' ? 'failed' : 'completed',
                position: { kind: 'native', turnId: String(turn.id) }, createdAt: this.now(),
            });
        }
        if (frame.method === 'thread/started') {
            this.catalogAt = 0;
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
        owner.observation.invalidate();
        if (['thread/reverted', 'thread/compacted', 'thread/deleted', 'thread/archived', 'thread/closed'].includes(method)) owner.observation.invalidateHistory();
        owner.dirty = true;
        try {
            if (method === 'thread/settings/updated' && isRecord(params.threadSettings)) {
                owner.native = { ...owner.native, threadSettings: params.threadSettings, ...(typeof params.threadSettings.model === 'string' ? { model: params.threadSettings.model } : {}), reasoningEffort: params.threadSettings.reasoningEffort ?? params.threadSettings.effort ?? owner.native.reasoningEffort };
                this.metadata(owner, this.descriptor(owner.native)); return;
            }
            if (method === 'thread/reverted' || method === 'thread/compacted') { owner.pendingCompletions.clear(); owner.attachments?.revoke(true); owner.rewrite = true; owner.full = true; return; }
            if (method === 'thread/deleted') { owner.deleted = true; this.markOffline(owner); this.catalogAt = 0; return; }
            if (method === 'thread/archived') { owner.archived = true; this.markOffline(owner); this.catalogAt = 0; return; }
            if (method === 'thread/unarchived') { owner.archived = false; this.metadata(owner, this.descriptor(owner.native)); this.catalogAt = 0; return; }
            if (method === 'thread/closed') { this.subscriptions.delete(owner.native.id); this.markOffline(owner); this.catalogAt = 0; return; }
            if (method === 'serverRequest/resolved') {
                const requestId = this.approvalId(params.requestId, this.rpc.currentGeneration), pending = this.approvals.get(requestId);
                if (pending?.sessionId === owner.session.id) { this.finishPending(owner, requestId); pending.resolve(); this.approvals.delete(requestId); this.metadata(owner, this.descriptor(owner.native)); }
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
    private cachedPending(owner: ThreadOwner): CachedPendingApproval[] {
        return this.history(owner).index.cached<CachedPendingApproval[]>(NATIVE_PENDING_REQUESTS) ?? [];
    }
    /** v7 -> v8 changes display material, not the native source. Carry only
     * previously received blocking calls from the exact same source snapshot.
     * recoverPending still verifies daemon, native anchor and live wait state. */
    private migratePending(owner: ThreadOwner): void {
        const index = this.history(owner).index;
        if (index.hasCached(NATIVE_PENDING_REQUESTS)) return;
        const coordinates = index.cached<string>('native-source-coordinates');
        if (!coordinates) return;
        const hash = createHash('sha256').update(owner.session.id).digest('hex');
        let previous: DatabaseSync | undefined, records: CachedPendingApproval[] = [];
        try {
            previous = new DatabaseSync(join(this.directory, 'history', `${hash}.v7.sqlite`), { readOnly: true });
            const metadata = (key: string) => (previous!.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined)?.value;
            const cached = (key: string) => (previous!.prepare('SELECT value FROM native_cache WHERE key=?').get(key) as { value: string } | undefined)?.value;
            const session = metadata('session'), epoch = metadata('epoch'), sourceCoordinates = cached('native-source-coordinates');
            const value = cached(NATIVE_PENDING_REQUESTS);
            if (session && epoch && sourceCoordinates && value && JSON.parse(session).id === owner.session.id
                && JSON.parse(sourceCoordinates) === coordinates) {
                const parsed: unknown = JSON.parse(value);
                if (Array.isArray(parsed) && parsed.length <= 64) records = parsed.filter((record): record is CachedPendingApproval => isRecord(record)
                    && record.version === 1 && record.epoch === epoch && record.daemon === this.rpc.daemonIdentity
                    && isRecord(record.request) && record.request.method === 'item/tool/requestUserInput'
                    && isRecord(record.request.params) && record.request.params.threadId === owner.native.id
                    && isRecord(record.anchor) && record.anchor.threadId === owner.native.id)
                    .map(record => ({ ...record, epoch: index.epoch }));
            }
        } catch { /* Missing or unverifiable evidence never creates a native request. */ }
        finally { previous?.close(); }
        index.edit(owner.session, () => index.cache(NATIVE_PENDING_REQUESTS, records));
    }
    private async recoverAsyncQuestions(owner: ThreadOwner, signal: AbortSignal): Promise<void> {
        const initialized = await this.rpc.connect(signal), index = this.history(owner).index;
        let state = index.cached<NativeQuestionState>(NATIVE_ASYNC_QUESTIONS);
        const current = owner.observation.capture(() => this.rpc.currentGeneration, () => owner.history);
        for (let pageNumber = 0; pageNumber < MAX_NATIVE_PAGES; pageNumber++) {
            const page = await this.readQuestions({ kind: 'questions', home: initialized.codexHome, threadId: owner.native.id,
                ...(state ? { after: state.through, coordinates: state.coordinates,
                    known: [...new Set(state.active.flatMap(row => row.itemId ? [row.itemId] : []))] } : {}) }, signal);
            if (!current()) throw new SupersededObservation();
            state = acceptNativeQuestions(state, page);
            if (!page.more) {
                owner.asyncQuestions = state;
                const session = this.descriptor(owner.native);
                index.edit(session, () => index.cache(NATIVE_ASYNC_QUESTIONS, state));
                this.metadata(owner, session);
                return;
            }
        }
        throw new SourceError('HISTORY_UNAVAILABLE', 'Native questions exceeded their source read budget.');
    }
    private savePending(owner: ThreadOwner, records: CachedPendingApproval[]): void {
        const index = this.history(owner).index;
        index.edit(owner.session, () => { index.cache(NATIVE_PENDING_REQUESTS, records.slice(-64)); });
    }
    private finishPending(owner: ThreadOwner, id: string): void {
        const records = this.cachedPending(owner), saved = records.find(record => record.id === id);
        if (saved) { saved.resolved = true; this.savePending(owner, records); }
    }
    private async capturePending(owner: ThreadOwner, id: string, pending: PendingApproval): Promise<void> {
        const daemon = this.rpc.daemonIdentity, generation = this.rpc.currentGeneration;
        if (!daemon || pending.request.method !== 'item/tool/requestUserInput' || typeof owner.native.path !== 'string'
            || Buffer.byteLength(JSON.stringify(pending.request)) > 256 * 1024) return;
        const initialized = await this.rpc.connect(this.lifetime.signal);
        const anchor = await capturePendingCall(initialized.codexHome, owner.native.path, pending.request);
        if (!anchor || this.disposed || this.rpc.daemonIdentity !== daemon || this.rpc.currentGeneration !== generation || this.approvals.get(id) !== pending) return;
        const records = this.cachedPending(owner).filter(record => record.id !== id);
        records.push({ version: 1, daemon, epoch: owner.history!.index.epoch, id, request: pending.request, anchor, submitted: pending.submitted, resolved: false });
        this.savePending(owner, records);
    }
    /** Rebuild only known received questions with canonical, complete evidence.
     * No native subscription, resume, execution claim, or request is created. */
    private async recoverPending(owner: ThreadOwner): Promise<void> {
        const daemon = this.rpc.daemonIdentity;
        if (!daemon) return;
        this.migratePending(owner);
        const index = this.history(owner).index, epoch = index.epoch, generation = this.rpc.currentGeneration;
        const initialized = await this.rpc.connect(this.lifetime.signal), records = this.cachedPending(owner);
        for (const [id, pending] of this.approvals) {
            if (pending.recovered && pending.sessionId === owner.session.id && !records.some(saved => saved.id === id && saved.daemon === daemon && saved.epoch === epoch && !saved.resolved)) this.approvals.delete(id);
        }
        let changed = false;
        for (const saved of records) {
            if (saved.version !== 1 || saved.resolved || saved.daemon !== daemon || saved.epoch !== epoch
                || saved.request.method !== 'item/tool/requestUserInput' || saved.request.params.threadId !== owner.native.id
                || saved.anchor.threadId !== owner.native.id || saved.anchor.turnId !== saved.request.params.turnId || saved.anchor.callId !== saved.request.params.itemId) continue;
            const evidence = await pendingCallEvidence(initialized.codexHome, saved.anchor);
            if (this.disposed || this.rpc.daemonIdentity !== daemon || this.rpc.currentGeneration !== generation || owner.history?.index !== index || index.epoch !== epoch) return;
            let pending = this.approvals.get(saved.id);
            if (evidence === 'resolved') {
                saved.resolved = true; changed = true; pending?.resolve(); this.approvals.delete(saved.id); continue;
            }
            const active = owner.session.activeTurnId === saved.anchor.turnId && owner.native.status.type === 'active'
                && Array.isArray(owner.native.status.activeFlags) && owner.native.status.activeFlags.includes('waitingOnUserInput');
            const visible = evidence === 'pending' && active && (!saved.submitted || pending?.visible === true);
            if (!pending && (visible || saved.submitted)) {
                const acknowledgment = Promise.withResolvers<void>();
                pending = { request: { ...saved.request, generation }, sessionId: owner.session.id, acknowledged: acknowledgment.promise,
                    resolve: acknowledgment.resolve, submitted: saved.submitted, recovered: true, visible };
                this.approvals.set(saved.id, pending);
            } else if (pending?.recovered) pending.visible = visible;
        }
        if (changed) this.savePending(owner, records);
        this.metadata(owner, this.descriptor(owner.native));
    }
    private approvalId(id: unknown, generation: number): string { return JSON.stringify([generation, typeof id, id]); }
    private approval(request: NativeRequest): void {
        const threadId = request.params.threadId;
        // Source-level requests are handled by nativeAccess; thread requests stay with this owner.
        if (typeof threadId !== 'string') return;
        const owner = this.threads.get(threadId);
        if (!owner) { void this.rpc.respond(request, undefined, { code: -32602, message: 'This native thread is not registered with the source.' }).catch(() => {}); return; }
        const id = this.approvalId(request.id, request.generation), acknowledgement = Promise.withResolvers<void>();
        const pending: PendingApproval = { request, sessionId: owner.session.id, acknowledged: acknowledgement.promise, resolve: acknowledgement.resolve, submitted: false };
        this.approvals.set(id, pending);
        void this.capturePending(owner, id, pending).catch(() => { /* No durable evidence means no automatic restoration. */ });
        if (typeof request.params.turnId === 'string') this.publishAttention(owner.session.id, {
            id: JSON.stringify(['request', id]), kind: 'request', requestId: id, createdAt: this.now(),
            position: { kind: 'native', turnId: request.params.turnId,
                ...(typeof request.params.itemId === 'string' ? { itemId: request.params.itemId } : {}) },
        });
        this.metadata(owner, this.descriptor(owner.native));
    }
    async operate(operation: SourceOperation): Promise<SourceReceipt> {
        this.creations.invalidateProtection();
        this.creations.protectTarget(this.assertScope(operation.sessionId));
        // A question has one immutable reply identity across Clients and Panes.
        // A caller cannot bypass the durable receipt by inventing another ID.
        if (operation.kind === 'approve' && operation.requestId?.startsWith('["request_user_input_async",')) {
            const target = JSON.stringify([operation.requestId, operation.response?.nativeQuestionRevision]);
            const expected = `hhpi-control:${createHash('sha256').update(JSON.stringify([operation.sessionId, 'approve', target])).digest('hex')}`;
            if (operation.operationId !== expected) throw new SourceError('INVALID_REQUEST', 'Use the original native question operation identity.');
        }
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
    /** These correlation reads never resume, dequeue or resubmit anything. */
    private async reconcileNativeInput(method: string, params: Record<string, unknown> | null): Promise<CodexCallResult | undefined> {
        if ((method !== 'thread/queue/add' && method !== 'turn/steer') || typeof params?.threadId !== 'string' || typeof params.clientUserMessageId !== 'string') return undefined;
        const confirmed = (): CodexCallResult => ({ status: 'accepted', message: 'The original native input confirms admission.', resultUnavailable: true });
        // Queue admission may be durable before a userMessage exists. Follow
        // opaque cursors, with a bounded lookup; absence never permits replay.
        const seen = new Set<string>();
        let cursor: string | null = null;
        for (let pageNumber = 0; method === 'thread/queue/add' && pageNumber < 16; pageNumber++) {
            const page: unknown = await this.rpc.request('thread/queue/list', { threadId: params.threadId, limit: 100, cursor }, { signal: this.lifetime.signal });
            if (!isRecord(page) || !Array.isArray(page.data)) throw new SourceError('OUTCOME_UNKNOWN', 'The native queue could not confirm the original input.');
            const queued = page.data.find(item => isRecord(item) && item.clientUserMessageId === params.clientUserMessageId);
            if (isRecord(queued)) return typeof queued.id === 'string' ? { status: 'accepted', message: 'The original native queue item confirms admission.',
                result: { queuedSubmission: { id: queued.id, clientUserMessageId: params.clientUserMessageId } } } : confirmed();
            cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
            if (!cursor || seen.has(cursor)) break;
            seen.add(cursor);
        }
        const owner = await this.owner(sourceSessionId({ machineId: this.machineId, sourceId: this.id, engine: this.engine, nativeId: params.threadId }));
        await this.prepare(owner);
        if (owner.history!.index.userMessageSequence(params.clientUserMessageId) !== undefined) return confirmed();
        await this.readNativePage(owner, { sessionId: owner.session.id, limit: 160 }, true);
        return owner.history!.index.userMessageSequence(params.clientUserMessageId) !== undefined ? confirmed() : undefined;
    }
    private async reconcile(operation: SourceOperation, receipt: SourceReceipt): Promise<SourceReceipt | undefined> {
        if (operation.kind === 'approve' && operation.requestId?.startsWith('["request_user_input_async",')) {
            const owner = await this.owner(operation.sessionId); await this.prepare(owner);
            const channel = owner.history!.index.cached<{ method: string }>(`native-question-channel:${operation.requestId}`);
            const admission = channel && await this.reconcileNativeInput(channel.method, { threadId: owner.native.id, clientUserMessageId: operation.operationId });
            await this.recoverAsyncQuestions(owner, this.lifetime.signal);
            return admission?.status === 'accepted' ? { ...receipt, status: 'accepted', message: 'The original native question reply confirms admission.' } : undefined;
        }
        if (operation.kind === 'approve' && operation.requestId) {
            const owner = await this.owner(operation.sessionId); await this.prepare(owner); await this.refresh(owner, true);
            const saved = this.cachedPending(owner).find(record => record.id === operation.requestId);
            return saved && saved.daemon === this.rpc.daemonIdentity && saved.epoch === owner.history!.index.epoch && saved.submitted && saved.resolved
                ? { ...receipt, status: 'accepted', message: 'The native engine resolved the original question.' } : undefined;
        }
        if (operation.kind !== 'send' && operation.kind !== 'steer') return undefined;
        let admitted: SourceReceipt | undefined;
        if (operation.kind === 'send') {
            const owner = await this.owner(operation.sessionId);
            const fileInputs = await this.fileUploads().inputs(operation.sessionId, operation.files ?? []);
            const input = this.operationInput(operation, fileInputs);
            // This is the same native receipt used by structured composer input.
            const admission = await this.nativeAccess.call({ sourceId: this.id, operationId: operation.operationId,
                method: 'thread/queue/add', params: { threadId: owner.native.id, clientUserMessageId: operation.operationId, input } }, true);
            if (admission.status === 'accepted') admitted = { ...receipt, status: 'accepted', message: admission.message,
                ownerAdmission: { localId: operation.operationId, state: 'queued' } };
        }
        const owner = await this.owner(operation.sessionId), signal = this.lifetime.signal;
        let seq: number | undefined;
        try {
            await this.prepare(owner);
            seq = owner.history!.index.userMessageSequence(operation.operationId);
            if (seq === undefined) {
                await waitFor(this.readNativePage(owner, { sessionId: operation.sessionId, limit: 160 }, true), signal);
                seq = owner.history!.index.userMessageSequence(operation.operationId);
            }
        } catch (error) {
            // Exact queue ownership is already confirmed even if its optional
            // consumed-message coordinates are temporarily unreadable.
            if (admitted) return admitted;
            throw error;
        }
        if (seq === undefined) return admitted;
        return { ...(admitted ?? receipt), status: 'accepted', message: 'The native user message confirms this operation was accepted.', observed: { epoch: owner.history!.index.epoch, seq } };
    }
    private async waitPendingResolution(owner: ThreadOwner, pending: PendingApproval, signal: AbortSignal): Promise<void> {
        let resolved = false;
        void pending.acknowledged.then(() => { resolved = true; });
        while (!resolved) {
            signal.throwIfAborted();
            await this.refresh(owner, true, signal);
            if (!resolved) await delay(100, signal);
        }
    }
    private operationInput(operation: SourceOperation, fileInputs: readonly unknown[]): unknown[] {
        return [...fileInputs, ...(operation.text?.trim() ? [{ type: 'text', text: operation.text, text_elements: [] }] : []), ...(operation.images ?? []).map(image => ({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` }))];
    }
    private async ensureExecutionOwner(owner: ThreadOwner, allowResume: boolean, requireLoaded = false): Promise<void> {
        let loaded: Set<string>, generation: number;
        try {
            await this.rpc.connect(this.lifetime.signal);
            generation = this.rpc.currentGeneration;
            loaded = await this.loadedThreads(this.lifetime.signal);
            if (generation !== this.rpc.currentGeneration) throw new Error('The native connection changed while checking its loaded threads.');
        } catch (error) { throw this.preflightFailure(error); }
        if (loaded.has(owner.native.id)) this.loaded.add(owner.native.id);
        else { this.loaded.delete(owner.native.id); this.subscriptions.delete(owner.native.id); }
        this.metadata(owner, this.descriptor(owner.native));
        if (loaded.has(owner.native.id) && (!allowResume || this.subscriptions.get(owner.native.id) === generation)) return;
        if (requireLoaded && !loaded.has(owner.native.id)) throw new SourceError('UNSUPPORTED', 'This thread is no longer loaded. Settings cannot load an execution owner.');
        if (!allowResume) throw new SourceError('UNSUPPORTED', 'This thread is not loaded by the connected native app-server. Steering and cancellation cannot resume it.');
        if (this.config.ownership !== 'exclusive' && this.config.writerLock !== 'native') throw new SourceError('UNSUPPORTED', 'Continuing shared native history requires verified native thread writer locking.');
        // Loaded belongs to the daemon; subscription belongs to this connection.
        // Explicit settings may join an already-loaded thread; only new queue
        // admission may cold-resume the exact
        // native thread. Receipt reads, history, reconnect and controls do not.
        const prior = this.subscriptionJoins.get(owner.native.id);
        if (prior?.generation === generation) return prior.work;
        const work = (async () => {
            const resumed = threadResponseSchema.parse(await this.rpc.request('thread/resume', { threadId: owner.native.id, excludeTurns: true }, { write: true }));
            if (resumed.thread.id !== owner.native.id) throw new SourceError('OUTCOME_UNKNOWN', 'The native app-server resumed a different thread. No prompt was sent.');
            if (generation !== this.rpc.currentGeneration) throw new SourceError('TARGET_UNAVAILABLE', 'The native connection changed before queue admission. No input was dispatched.', 'not-dispatched');
            this.subscriptions.set(owner.native.id, generation);
            this.loaded.add(owner.native.id); this.rememberResponse(resumed);
        })();
        this.subscriptionJoins.set(owner.native.id, { generation, work });
        try { await work; }
        finally { if (this.subscriptionJoins.get(owner.native.id)?.work === work) this.subscriptionJoins.delete(owner.native.id); }
    }
    private async perform(operation: SourceOperation): Promise<SourceReceipt> {
        const signal = this.lifetime.signal;
        let owner: ThreadOwner;
        try { owner = await this.owner(operation.sessionId); await this.rpc.connect(signal); }
        catch (error) { throw this.preflightFailure(error); }
        const receipt = (status: SourceReceipt['status'], message: string, turnId?: string): SourceReceipt => ({ sessionId: operation.sessionId, operationId: operation.operationId, status, message, ...(turnId ? { turnId } : {}) });
        if (operation.kind === 'approve') {
            if (operation.requestId?.startsWith('["request_user_input_async",')) {
                try { await this.prepare(owner); await this.refresh(owner, true, signal); await this.recoverAsyncQuestions(owner, signal); }
                catch (error) { throw this.preflightFailure(error); }
                const question = owner.asyncQuestions?.active.find(row => row.id === operation.requestId);
                if (!question) throw new SourceError('INVALID_REQUEST', 'The original native question is no longer answerable.');
                if (operation.response?.nativeQuestionRevision !== question.params.revision) throw new SourceError('INVALID_REQUEST', 'The original native question changed. No answer was dispatched.');
                let text: string;
                try { text = nativeQuestionReply(question, operation.response); }
                catch (error) { throw new SourceError('INVALID_REQUEST', error instanceof Error ? error.message : 'Invalid native answer.'); }
                const index = owner.history!.index, key = `native-question-channel:${operation.requestId}`;
                const prior = index.cached<{ method: 'turn/steer' | 'thread/queue/add'; operationId: string; turnId?: string; rejected?: boolean }>(key);
                if (prior && !prior.rejected && prior.operationId !== operation.operationId) throw new SourceError('INVALID_REQUEST', 'The original native question already has a submitted reply.');
                const turnId = owner.session.activeTurnId;
                const channel = prior && !prior.rejected ? prior : turnId && owner.native.status.type === 'active'
                    ? { method: 'turn/steer' as const, operationId: operation.operationId, turnId } : { method: 'thread/queue/add' as const, operationId: operation.operationId };
                index.edit(owner.session, () => index.cache(key, channel));
                const nativeOperationId = `${operation.operationId}:${createHash('sha256').update(JSON.stringify([channel.method, channel.turnId])).digest('hex').slice(0, 16)}`;
                const response = await this.nativeAccess.call({ sourceId: this.id, operationId: nativeOperationId, method: channel.method,
                    params: { threadId: owner.native.id, clientUserMessageId: operation.operationId,
                        ...(channel.turnId ? { expectedTurnId: channel.turnId } : {}), input: [{ type: 'text', text, text_elements: [] }] } });
                if (response.status === 'rejected') index.edit(owner.session, () => index.cache(key, { ...channel, rejected: true }));
                owner.dirty = true;
                // Admission does not settle the question. The explicit native
                // user-message reply owns that transition on the next refresh.
                return { ...receipt(response.status, response.message), ...(response.status === 'rejected' ? { retryable: true as const } : {}) };
            }
            if (operation.requestId && !this.approvals.has(operation.requestId)) await this.prepare(owner);
            let pending = operation.requestId ? this.approvals.get(operation.requestId) : undefined;
            if (pending?.recovered) { await this.refresh(owner, true, signal); pending = this.approvals.get(operation.requestId!); }
            if (!pending || pending.sessionId !== operation.sessionId || pending.request.generation !== this.rpc.currentGeneration || pending.submitted || pending.visible === false) throw new SourceError('INVALID_REQUEST', 'The native approval is no longer available for this source session.');
            if (!operation.decision && !operation.response) throw new SourceError('INVALID_REQUEST', 'An explicit native response is required.');
            if (operation.decision && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(pending.request.method)) throw new SourceError('INVALID_REQUEST', 'This native request requires its typed answer, not an approval decision.');
            pending.submitted = true;
            const records = this.cachedPending(owner), saved = records.find(record => record.id === operation.requestId);
            if (saved) { saved.submitted = true; this.savePending(owner, records); }
            try { await this.rpc.respond(pending.request, operation.response ?? { decision: operation.decision }); }
            catch (error) {
                if (error instanceof SourceError && error.delivery === 'not-dispatched'
                    && this.approvals.get(operation.requestId!) === pending && pending.request.generation === this.rpc.currentGeneration) {
                    pending.submitted = false;
                    if (saved) { saved.submitted = false; this.savePending(owner, records); }
                }
                throw error;
            }
            const timeout = new AbortController();
            try {
                const observed = pending.recovered ? this.waitPendingResolution(owner, pending, AbortSignal.any([signal, timeout.signal])) : pending.acknowledged;
                const outcome = await Promise.race([observed.then(() => true), delay(ACK_TIMEOUT, AbortSignal.any([signal, timeout.signal])).then(() => false)]);
                return outcome ? receipt('accepted', 'The native engine resolved the approval request.') : receipt('indeterminate', 'The approval response was sent; native resolution has not been observed. It will not be resent.');
            } finally { timeout.abort(); }
        }
        const fileInputs = await this.fileUploads().inputs(operation.sessionId, operation.files ?? []);
        if ((operation.kind === 'send' || operation.kind === 'steer') && operation.files?.length) await this.fileUploads().associate(operation.sessionId, operation.operationId, operation.files, signal);
        if ((operation.kind === 'send' || operation.kind === 'steer') && !operation.text?.trim() && !operation.images?.length && !operation.files?.length) {
            throw new SourceError('INVALID_REQUEST', 'The source prompt is empty.');
        }
        try {
            // Recheck the configured native owner at dispatch. Only explicit
            // sends may resume; history, steering and cancellation never do.
            // Queue writes own their preflight inside the shared native
            // receipt. Reading an already-confirmed ID must not resume again.
            if (operation.kind !== 'send') await this.ensureExecutionOwner(owner, false);
            if (operation.kind === 'send' || operation.kind === 'steer') {
                const input = this.operationInput(operation, fileInputs);
                if (operation.kind === 'steer') {
                    if (!operation.turnId) throw new SourceError('INVALID_REQUEST', 'Steer requires the exact native active turn.');
                    const response = await this.rpc.request<{ turnId: string }>('turn/steer', { threadId: owner.native.id, expectedTurnId: operation.turnId, clientUserMessageId: operation.operationId, input }, { write: true });
                    return receipt('accepted', 'The native engine accepted the steering input.', response.turnId);
                }
                // turn/start implicitly steers an active native turn. Normal
                // sends must join the same editable queue as structured input,
                // with exactly one native write receipt for the original ID.
                const response = await this.nativeAccess.call({ sourceId: this.id, operationId: operation.operationId,
                    method: 'thread/queue/add', params: { threadId: owner.native.id, clientUserMessageId: operation.operationId, input } });
                owner.dirty = true;
                return { ...receipt(response.status, response.message),
                    ...('retryable' in response && response.retryable === true ? { retryable: true as const } : {}),
                    ...(response.status === 'accepted' ? { ownerAdmission: { localId: operation.operationId, state: 'queued' as const } } : {}) };
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
        const receipt = await this.creations.run(request, async () => {
            const cwd = request.cwd ?? this.config.cwd;
            if (!cwd || !isAbsolute(cwd) || cwd.includes('\0')) throw new SourceError('INVALID_REQUEST', 'Native thread creation requires an absolute source working directory.');
            try {
                // No browser-provided executable, configuration, permissions or auth overrides are forwarded.
                const response = threadResponseSchema.parse(await this.rpc.request('thread/start', { cwd }, { write: true }));
                this.subscriptions.set(response.thread.id, this.rpc.currentGeneration);
                this.loaded.add(response.thread.id);
                const owner = this.rememberResponse(response); this.catalogAt = 0;
                return { sourceId: this.id, operationId: request.operationId, status: 'accepted', message: 'The native source created the thread.', session: owner.session };
            } catch (error) {
                if (error instanceof CodexRpcError) return { sourceId: this.id, operationId: request.operationId, status: 'rejected', message: error.message };
                throw error;
            }
        });
        if (receipt.status !== 'accepted' || !receipt.session) return receipt;
        try { return { ...receipt, session: await this.resolve(receipt.session.id) }; }
        catch {
            // The durable receipt still owns the exact created native ID.
            // A temporarily unreadable target never authorizes another start.
            return { sourceId: this.id, operationId: request.operationId, status: 'indeterminate',
                message: 'The original thread was created, but its current state is unavailable. Check this same creation operation again; no new thread will be started.' };
        }
    }
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true; this.nativeAccess.dispose(); clearInterval(this.timer); this.lifetime.abort();
        for (const stop of this.stops) stop();
        await Promise.all([this.rpc.dispose(), this.metadataReader.dispose(), this.imageReader.dispose(), ...[...this.threads.values()].map(owner => owner.attachments?.dispose())]);
        await Promise.allSettled([...this.receiptReads.values(), ...[...this.threads.values()].flatMap(owner => [owner.preparing, owner.refreshing].filter((work): work is Promise<void> => Boolean(work)))]);
        for (const owner of this.threads.values()) owner.history?.index.dispose();
        this.threads.clear(); this.approvals.clear();
    }
}
