/** Explicit HAPI wire fixture. It does not claim to execute a real Codex model. */
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { HapiEvent, HapiMessage, HapiSession, HapiSendMessage, HapiMessagesPage } from '../src/codex/contracts.ts';
import type { NativeForkReceipt } from '../src/codex/control-types.ts';
import { WorkbenchWireFixture } from './workbench-fixture.ts';
import { SessionExtrasWireFixture } from './session-extras-fixture.ts';
import { ArtifactWireFixture } from './artifact-fixture.ts';
import { HistoryWireFixture } from './history-fixture.ts';
import { AdminWireFixture } from './admin-fixture.ts';
import { VoiceWireFixture } from './voice-fixture.ts';
import { NotificationsWireFixture } from './notifications-fixture.ts';
import { CollaborationWireFixture } from './collaboration-fixture.ts';
import { DshChildWireFixture } from './dsh-child-fixture.ts';
import type { LegacyWorkspaceSnapshot } from '../src/legacy-workspace-types.ts';

const token = 'e2e-hapi-access-token';
const jwt = 'e2e-hapi-jwt';
export interface NativeFixture {
    session: HapiSession
    rows: HapiMessage[]
    /** Explicit per-session history page override (remote hotfix hook). */
    readHistory?: (url: URL) => HapiMessagesPage | Promise<HapiMessagesPage>
}
/** Opt-in bounded Hub-faithful history paging for one fixture session. */
export interface HistoryPaging {
    epoch: number
    pageSize?: number
    /** Runs before a page is served; may rewrite rows and bump the epoch. */
    onPage?: (index: number, paging: HistoryPaging) => void
}
export interface ObservedFixtureOptions {
    /** Replace the default seed rows before the session is announced. */
    rows?: HapiMessage[]
    paging?: HistoryPaging
}

export class HapiWireFixture {
    readonly sessions = new Map<string, NativeFixture>();
    readonly historyPaging = new Map<string, HistoryPaging>();
    private readonly historyPageCounts = new Map<string, number>();
    readonly sent: Array<{ sessionId: string; message: HapiSendMessage }> = [];
    readonly approvals: Array<{ sessionId: string; requestId: string; answer: unknown }> = [];
    readonly uploads: unknown[] = [];
    readonly spawnRequests: Array<{ machineId: string; body: Record<string, unknown> }> = [];
    readonly cursorCatalogs = new Map<string, { availableModels: Array<{ modelId: string; name?: string }>; cliModelSkus: Array<{ modelId: string; name?: string }> }>();
    readonly cursorModelRequests: string[] = [];
    dropNextMessageReply = false;
    /** Discovery can omit an original history while its exact GET remains
     * available. Faults stay in effect until the test explicitly removes them. */
    readonly omittedFromSessionList = new Set<string>();
    readonly sessionReadErrors = new Map<string, { status: number; code: string }>();
    readonly sessionReads: Array<{ sessionId: string; status: number }> = [];
    legacyWorkspaces: LegacyWorkspaceSnapshot = { schemaVersion: 2, revision: 0, workspaces: [] };
    readonly settingChanges: Array<{ sessionId: string; route: string; body: unknown }> = [];
    readonly forkRequests: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
    readonly planRequests: Array<{ sessionId: string; planId: string }> = [];
    readonly cancelled: string[] = [];
    dropNextCancelReply = false;
    suppressNextCancelEvent = false;
    beforeCancel: ((sessionId: string) => Promise<void>) | undefined;
    readonly aborted: string[] = [];
    dropNextAbortReply = false;
    readonly readStates: Record<string, { seenAt: number; manualUnreadAt: number | null; version: number }> = {};
    readonly accessToken = token;
    eventConnections = 0;
    private readonly streams = new Set<ServerResponse>();
    private cursor = 0;
    private readonly server = createServer((request, response) => { void this.handle(request, response); });
    readonly workbench = new WorkbenchWireFixture(this.server, () => [...this.sessions.values()].map(value => value.session), jwt);
    readonly extras = new SessionExtrasWireFixture();
    readonly artifacts = new ArtifactWireFixture();
    readonly history = new HistoryWireFixture();
    readonly admin = new AdminWireFixture();
    readonly voice = new VoiceWireFixture(this.server, jwt);
    readonly notifications = new NotificationsWireFixture();
    readonly collaboration = new CollaborationWireFixture();
    readonly dshChildren = new DshChildWireFixture();
    private readonly spawns = new Map<string, string>();
    private readonly forks = new Map<string, NativeForkReceipt>();
    url = '';

    constructor() {
        this.add('alpha', 'Laptop', 'machine-alpha');
        this.add('beta', 'Linux workstation', 'machine-beta');
    }
    add(key: string, host: string, machineId: string): NativeFixture {
        const now = 1_760_000_000_000;
        const id = `native-${key}`;
        const session: HapiSession = {
            id, namespace: 'e2e', seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now,
            thinking: false, thinkingAt: now, metadataVersion: 1, agentStateVersion: 1, model: 'fixture-model',
            modelReasoningEffort: 'medium', permissionMode: 'default', collaborationMode: 'default', serviceTier: 'standard',
            metadata: { path: `/workspace/${key}`, host, machineId, flavor: 'codex', name: `Native Codex ${key}`,
                codexNativeSession: true, codexNativeConnection: 'attached', codexSessionId: `codex-thread-${key}`,
                codexHome: `/home/${key}/.codex`, codexHomeId: `home-${key}` },
            agentState: { requests: {}, completedRequests: {} }, executionVersion: 1,
            execution: { owner: 'codex', generation: `generation-${key}`, sequence: 1, status: 'idle', waitingOn: [], turnId: null, startedAt: null, completedAt: now },
        };
        const fixture = { session, rows: [] as HapiMessage[] };
        this.sessions.set(id, fixture);
        this.readStates[id] = { seenAt: 0, manualUnreadAt: null, version: 0 };
        this.workbench.seed(session);
        fixture.rows.push(this.user(fixture, `input-${key}`, `Question from Codex TUI — ${key}`, true, now + 1));
        fixture.rows.push(this.agent(fixture, 'message', { message: `Native history ${key} in the official DSH Conversation.`, streamSnapshot: true }, `answer-${key}`, now + 2));
        fixture.rows.push(this.terminal(fixture, now + 3));
        return fixture;
    }
    /** SDK wire rows are explicit fixtures; no Claude/Pi process is launched here. */
    addObserved(flavor: 'claude' | 'pi' | 'cursor' | 'dsh', key: string, machineId = 'machine-alpha',
        options: ObservedFixtureOptions = {}): NativeFixture {
        const id = `source-${key}`, at = Date.now();
        const session: HapiSession = { id, namespace: 'e2e', seq: 1, createdAt: at, updatedAt: at,
            active: true, activeAt: at, thinking: false, thinkingAt: at, metadataVersion: 1, agentStateVersion: 1,
            metadata: { path: `/workspace/${key}`, host: machineId === 'machine-alpha' ? 'Laptop' : 'Linux workstation', machineId, flavor,
                name: `Source ${flavor} ${key}`, ...(flavor === 'claude' ? { claudeSessionId: `claude-thread-${key}` }
                    : flavor === 'cursor' ? { cursorSessionId: `cursor-thread-${key}` } : { piSessionId: `pi-thread-${key}` }),
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: flavor === 'pi' } } },
            agentState: { requests: {}, completedRequests: {}, controlledByUser: false }, model: flavor === 'claude' ? 'sonnet' : 'fixture-pi', effort: 'medium', permissionMode: 'default' };
        const fixture = { session, rows: [] as HapiMessage[] }; this.sessions.set(id, fixture);
        this.readStates[id] = { seenAt: 0, manualUnreadAt: null, version: 0 }; this.workbench.seed(session);
        // Supplied history exists before this source is announced. Publishing
        // default live rows first would make them a real unindexed suffix that
        // the receive journal must preserve even after REST uses options.rows.
        if (options.rows) fixture.rows = options.rows;
        else {
            fixture.rows.push({ id: `user-${key}`, localId: `original-user-${key}`, seq: 1, createdAt: at, invokedAt: at,
                content: { role: 'user', content: { type: 'text', text: `Original ${flavor} input` } } });
            this.observedAnswer(fixture, `Original ${flavor} answer in the official DSH Conversation.`);
        }
        if (options.paging) this.historyPaging.set(id, options.paging);
        this.emit({ type: 'session-added', sessionId: id }); return fixture;
    }
    private observedAnswer(fixture: NativeFixture, text: string): void {
        const seq = fixture.rows.length + 1, at = Date.now(), flavor = fixture.session.metadata!.flavor;
        const content = flavor === 'claude'
            ? { type: 'output', data: { type: 'assistant', uuid: `sdk-answer-${seq}`, message: { model: fixture.session.model,
                content: [{ type: 'text', text }] } } }
            : { type: 'codex', data: { type: 'message', id: `pi-answer-${seq}`, message: text, streamSnapshot: true } };
        const rows: HapiMessage[] = [{ id: `source-answer-${seq}`, localId: null, seq, createdAt: at, content: { role: 'agent', content } },
            { id: `source-ready-${seq}`, localId: null, seq: seq + 1, createdAt: at + 1,
                content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } }];
        for (const row of rows) { fixture.rows.push(row); this.emit({ type: 'message-received', sessionId: fixture.session.id, message: row }); }
    }
    private user(fixture: NativeFixture, localId: string, text: string, invoked: boolean, at = Date.now(), turnId = 'turn-1'): HapiMessage {
        return { id: `row:${localId}`, localId, seq: fixture.rows.length + 1, createdAt: at, invokedAt: invoked ? at : null,
            content: { role: 'user', content: { type: 'text', text }, meta: invoked
                ? { nativeExecution: { threadId: fixture.session.metadata!.codexSessionId, turnId, itemId: localId } }
                : { isNativeQueuedMessage: true } } };
    }
    private agent(fixture: NativeFixture, type: string, fields: Record<string, unknown>, item: string, at = Date.now(), turnId = 'turn-1'): HapiMessage {
        const threadId = fixture.session.metadata!.codexSessionId;
        const localId = `codex:${threadId}:${turnId}:${item}:${type}`;
        return { id: `native:${localId}`, localId, seq: fixture.rows.length + 1, createdAt: at,
            content: { role: 'agent', content: { type: 'codex', data: { type, id: localId, ...fields,
                nativeExecution: { threadId, turnId, itemId: item } } } } };
    }
    private terminal(fixture: NativeFixture, at = Date.now(), turnId = 'turn-1'): HapiMessage {
        const row = this.agent(fixture, 'native-turn', {}, `terminal-${turnId}`, at, turnId);
        const data = (row.content as { content: { data: Record<string, unknown> } }).content.data;
        data.nativeExecution = { threadId: fixture.session.metadata!.codexSessionId, turnId, turn: { status: 'completed', started: true, ended: true } };
        return row;
    }
    emit(event: HapiEvent | { type: 'machine-updated'; machineId: string }): void {
        const record = `id: fixture-${++this.cursor}\ndata: ${JSON.stringify(event)}\n\n`;
        for (const stream of this.streams) stream.write(record);
    }
    require(id: string): NativeFixture {
        const value = this.sessions.get(id);
        if (!value) throw new Error(`Unknown test session ${id}`);
        return value;
    }
    requestApproval(id: string, requestId = 'approval-e2e'): void {
        const source = this.require(id).session;
        source.agentState = { requests: { [requestId]: { tool: 'exec_command', arguments: { command: 'pwd' }, createdAt: Date.now() } }, completedRequests: {} };
        source.agentStateVersion++;
        if (source.execution) { source.execution = { ...source.execution, sequence: source.execution.sequence + 1, status: 'active', waitingOn: ['approval'] }; source.executionVersion!++; }
        this.emit({ type: 'session-updated', sessionId: id });
    }
    settleApproval(id: string, requestId = 'approval-e2e'): void {
        const source = this.require(id).session;
        const request = source.agentState!.requests![requestId]!;
        source.agentState = { requests: {}, completedRequests: { [requestId]: { ...request, status: 'resolved', completedAt: Date.now() } } };
        source.agentStateVersion++;
        if (source.execution) { source.execution = { ...source.execution, sequence: source.execution.sequence + 1, status: 'idle', waitingOn: [] }; source.executionVersion!++; }
        this.emit({ type: 'session-updated', sessionId: id });
    }
    proposePlan(id: string, planId: string): void {
        const source = this.require(id).session;
        source.agentState = { ...source.agentState, codexPlanProposalId: planId };
        source.agentStateVersion++;
        source.collaborationMode = 'plan';
        this.emit({ type: 'session-updated', sessionId: id });
    }
    consume(id: string, localId: string): void {
        const fixture = this.require(id);
        const queued = fixture.rows.find(row => row.localId === localId)!;
        const text = (queued.content as { content: { text: string } }).content.text;
        if (!fixture.session.metadata?.codexNativeSession) {
            queued.invokedAt = Date.now();
            queued.content = { role: 'user', content: { type: 'text', text } };
            this.emit({ type: 'messages-consumed', sessionId: id, localIds: [localId], invokedAt: queued.invokedAt });
            this.emit({ type: 'message-received', sessionId: id, message: queued });
            this.observedAnswer(fixture, `Source response to: ${text}`); return;
        }
        const turnId = `turn-${localId}`;
        const { id: rowId, seq, createdAt } = queued;
        Object.assign(queued, this.user(fixture, localId, text, true, Date.now(), turnId), { id: rowId, seq, createdAt });
        this.emit({ type: 'messages-consumed', sessionId: id, localIds: [localId], invokedAt: queued.invokedAt! });
        this.emit({ type: 'message-received', sessionId: id, message: queued });
        for (const row of [this.agent(fixture, 'message', { message: `Native response to: ${text}`, streamSnapshot: true }, `answer-${localId}`, Date.now(), turnId), this.terminal(fixture, Date.now(), turnId)]) {
            row.seq = fixture.rows.length + 1;
            fixture.rows.push(row);
            this.emit({ type: 'message-received', sessionId: id, message: row });
        }
    }
    disconnectEvents(): void { for (const stream of this.streams) stream.end(); this.streams.clear(); }
    async start(): Promise<void> {
        this.server.listen(0, '127.0.0.1');
        await once(this.server, 'listening');
        const address = this.server.address();
        if (!address || typeof address === 'string') throw new Error('Test server did not bind');
        this.url = `http://127.0.0.1:${address.port}`;
    }
    async close(): Promise<void> {
        this.disconnectEvents(); this.voice.close(); await this.workbench.close(); this.server.closeAllConnections();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
    /** Hub-faithful bounded page: cursor positions, snapshot head, and a reset signal
     * when the caller pins a stale epoch. */
    private historyPage(fixture: NativeFixture, paging: HistoryPaging, url: URL) {
        const id = fixture.session.id;
        const index = this.historyPageCounts.get(id) ?? 0;
        this.historyPageCounts.set(id, index + 1);
        paging.onPage?.(index, paging);
        const position = (row: HapiMessage) => ({ at: row.invokedAt ?? row.createdAt, seq: row.seq ?? 0 });
        const ordered = [...fixture.rows].sort((left, right) => {
            const a = position(left), b = position(right);
            return a.at - b.at || a.seq - b.seq;
        });
        const newest = ordered.at(-1);
        const epoch = Number(url.searchParams.get('epoch') ?? Number.NaN);
        const reset = Number.isFinite(epoch) && epoch !== paging.epoch;
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, paging.pageSize ?? 200);
        const beforeAt = url.searchParams.get('beforeAt'), beforeSeq = url.searchParams.get('beforeSeq');
        const untilAt = url.searchParams.get('untilAt'), untilSeq = url.searchParams.get('untilSeq');
        let pool = ordered;
        if (untilAt !== null && untilSeq !== null) {
            const until = { at: Number(untilAt), seq: Number(untilSeq) };
            pool = ordered.filter(row => { const at = position(row); return at.at < until.at || at.at === until.at && at.seq <= until.seq });
        }
        let selected: HapiMessage[];
        let available: number;
        if (!reset && beforeAt !== null && beforeSeq !== null) {
            const before = { at: Number(beforeAt), seq: Number(beforeSeq) };
            const older = pool.filter(row => { const at = position(row); return at.at < before.at || at.at === before.at && at.seq < before.seq });
            selected = older.slice(-limit); available = older.length;
        } else {
            selected = pool.slice(-limit); available = pool.length;
        }
        const oldest = selected[0];
        return { messages: selected, page: { direction: beforeAt === null ? 'latest' : 'before', limit, epoch: paging.epoch, reset,
            nextBeforeSeq: oldest?.seq ?? null, nextBeforeAt: oldest ? position(oldest).at : null,
            nextAfterSeq: null, nextAfterAt: null,
            snapshotHeadSeq: newest?.seq ?? null, snapshotHeadAt: newest ? position(newest).at : null,
            hasMore: !reset && available > selected.length } };
    }
    private async handle(request: import('node:http').IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://fixture');
        const send = (value: unknown, status = 200): void => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const rawBytes = Buffer.concat(chunks);
            if (await this.voice.handle(url, request, response, rawBytes)) return;
            const raw = rawBytes.toString();
            const body = raw ? JSON.parse(raw) : {};
            if (url.pathname === '/api/auth') { send(body.accessToken === token ? { token: jwt } : { error: 'fixture authentication failed' }, body.accessToken === token ? 200 : 401); return; }
            if (url.pathname === '/health') { send({ status: 'ok', capabilities: { titleSuggestion: this.extras.titleSuggestionAvailable, workGraph: this.collaboration.available } }); return; }
            if (request.headers.authorization !== `Bearer ${jwt}`) { send({ error: 'unauthorized' }, 401); return; }
            if (this.notifications.handle(url, request, response, body)) return;
            if (this.collaboration.handle(url, request, response)) return;
            if (this.admin.handle(this, url, request, response, body)) return;
            if (this.history.handle(this, url, request, response, body)) return;
            if (url.pathname === '/api/events') {
                this.eventConnections++;
                response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
                this.streams.add(response); response.on('close', () => this.streams.delete(response));
                const subscriptionId = this.notifications.attach(url, response);
                response.write(`id: fixture-${this.cursor}\ndata: ${JSON.stringify({ type: 'connection-changed', data: { status: 'connected', subscriptionId, resume: 'gap' } })}\n\n`);
                return;
            }
            if (url.pathname === '/api/sessions') { send({ sessions: [...this.sessions.values()].filter(value => !this.omittedFromSessionList.has(value.session.id)).map(value => value.session), readStates: this.readStates }); return; }
            if (url.pathname === '/api/workspaces') { send(this.legacyWorkspaces); return; }
            if (url.pathname === '/api/machines') {
                send({ machines: ['alpha', 'beta'].map(key => ({ id: `machine-${key}`, active: true, activeAt: Date.now(), metadata: { host: key === 'alpha' ? 'Laptop' : 'Linux workstation' } })) }); return;
            }
            if (/\/agent-availability$/.test(url.pathname)) { send({ agents: [{ agent: 'claude', available: true }, { agent: 'pi', available: true }, { agent: 'cursor', available: true }] }); return; }
            if (/\/cursor-models$/.test(url.pathname)) {
                const machineId = decodeURIComponent(url.pathname.split('/')[3]!); this.cursorModelRequests.push(machineId);
                send({ success: true, ...(this.cursorCatalogs.get(machineId) ?? { availableModels: [], cliModelSkus: [] }) }); return;
            }
            if (/\/paths\/exists$/.test(url.pathname)) { send({ exists: Object.fromEntries((body.paths as string[]).map(path => [path, !path.endsWith('/new-folder')])), outsideWorkspaceRoots: (body.paths as string[]).filter(path => path.startsWith('/outside/')) }); return; }
            if (/\/list-directory$/.test(url.pathname)) { send({ success: true, entries: [{ name: 'project', type: 'directory', isGitRepo: true }, { name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' }] }); return; }
            if (/\/codex-accounts$/.test(url.pathname)) { send({ success: true, accounts: [], currentAccountId: null }); return; }
            if (/\/codex-homes$/.test(url.pathname)) { send({ success: true, homes: [{ id: 'home-alpha', label: 'Personal', path: '/home/alpha/.codex' }] }); return; }
            if (/\/codex-models$/.test(url.pathname)) { send({ success: true, models: [{ id: 'fixture-model', displayName: 'Fixture model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'], serviceTiers: ['fast'] }] }); return; }
            if (/\/spawn$/.test(url.pathname)) {
                this.spawnRequests.push({ machineId: decodeURIComponent(url.pathname.split('/')[3]!), body: structuredClone(body) });
                let id = this.spawns.get(body.requestId);
                if (body.agent === 'claude' || body.agent === 'pi' || body.agent === 'cursor') {
                    if (!id) {
                        const machineId = decodeURIComponent(url.pathname.split('/')[3]!);
                        const created = this.addObserved(body.agent, `created-${this.spawns.size}`, machineId, { rows: [] });
                        created.session.metadata!.path = body.directory;
                        if (body.model) created.session.model = body.model;
                        if (body.effort) created.session.effort = body.effort;
                        if (body.permissionMode) created.session.permissionMode = body.permissionMode;
                        id = created.session.id; this.spawns.set(body.requestId, id);
                    }
                    send({ type: 'success', sessionId: id }); return;
                }
                if (!id) {
                    id = `native-created-${this.spawns.size}`;
                    const created = this.add(`created-${this.spawns.size}`, 'Laptop', 'machine-alpha');
                    created.rows = [];
                    Object.assign(created.session.metadata!, { path: body.directory, codexHome: body.codexHome ?? '/home/alpha/.codex', codexHomeId: 'home-alpha' });
                    Object.assign(created.session, { model: body.model ?? 'fixture-model', modelReasoningEffort: body.modelReasoningEffort ?? 'medium',
                        permissionMode: body.permissionMode ?? 'default', collaborationMode: body.collaborationMode ?? 'default', serviceTier: body.serviceTier ?? 'standard' });
                    this.spawns.set(body.requestId, id); this.emit({ type: 'session-added', sessionId: id });
                }
                send({ type: 'success', sessionId: id }); return;
            }
            const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
            if (parts[0] !== 'api' || parts[1] !== 'sessions' || !parts[2] || !this.sessions.has(parts[2])) { send({ error: 'fixture route not found' }, 404); return; }
            const fixture = this.require(parts[2]);
            const id = fixture.session.id;
            const tail = parts.slice(3).join('/');
            if (this.dshChildren.handle(this, fixture.session, tail, url, request, response, body)) return;
            if (this.artifacts.handle(fixture.session, tail, url, request, response, body)) return;
            if (this.workbench.handle(fixture.session, tail, url, request, response, body)) return;
            if (this.extras.handle(fixture, tail, url, request, response, body)) return;
            if (tail === 'read-state' && request.method === 'PUT') {
                const current = this.readStates[id]!;
                if (current.version !== body.expectedVersion) { send({ applied: false, state: current }); return; }
                const state = { seenAt: body.seenAt as number, manualUnreadAt: body.manualUnreadAt as number | null, version: current.version + 1 };
                this.readStates[id] = state; send({ applied: true, state }); return;
            }
            if (tail === 'codex/plan/implement' && request.method === 'POST') {
                this.planRequests.push({ sessionId: id, planId: body.planId });
                if (fixture.session.agentState?.codexPlanProposalId !== body.planId) { send({ ok: false, code: 'stale_plan', error: 'The fixture proposal has changed' }, 409); return; }
                const localId = `${body.planId}:implement`;
                if (!fixture.rows.some(row => row.localId === localId)) {
                    const row = this.user(fixture, localId, 'Implement the plan.', false);
                    fixture.rows.push(row); this.emit({ type: 'message-received', sessionId: id, message: row });
                }
                delete fixture.session.agentState!.codexPlanProposalId;
                fixture.session.agentStateVersion++;
                fixture.session.collaborationMode = 'default';
                this.emit({ type: 'session-updated', sessionId: id }); send({ ok: true }); return;
            }
            const settingKeys: Record<string, { source: string; request: string }> = {
                model: { source: 'model', request: 'model' }, 'model-reasoning-effort': { source: 'modelReasoningEffort', request: 'modelReasoningEffort' },
                effort: { source: 'effort', request: 'effort' },
                'permission-mode': { source: 'permissionMode', request: 'mode' }, 'collaboration-mode': { source: 'collaborationMode', request: 'mode' },
                'service-tier': { source: 'serviceTier', request: 'serviceTier' },
            };
            if (settingKeys[tail] && request.method === 'POST') {
                const setting = settingKeys[tail]!;
                this.settingChanges.push({ sessionId: id, route: tail, body });
                Object.assign(fixture.session, { [setting.source]: body[setting.request] });
                fixture.session.updatedAt = Date.now();
                this.emit({ type: 'session-updated', sessionId: id }); send({ ok: true }); return;
            }
            if (tail === 'fork-operations') {
                const operation = [...this.forks.values()].filter(item => item.sourceSessionId === id).at(-1);
                send({ revision: operation?.sourceRevision ?? 0, ...(operation ? { operation } : {}) }); return;
            }
            if (tail === 'fork' && request.method === 'POST') {
                this.forkRequests.push({ sessionId: id, body });
                if (!fixture.session.metadata?.codexNativeSession) {
                    const child = this.addObserved(fixture.session.metadata!.flavor as 'claude' | 'pi', `fork-${this.forkRequests.length}`, fixture.session.metadata!.machineId!);
                    child.session.metadata!.forkedFrom = id; child.session.metadata!.name = 'Original source fork';
                    send({ sessionId: child.session.id }); return;
                }
                let operation = this.forks.get(body.operationId);
                if (!operation) {
                    const metadata = fixture.session.metadata!;
                    const nativeThreadId = `codex-fork-${body.operationId}`;
                    const child = this.add(`fork-${this.forks.size}`, metadata.host ?? 'Fixture machine', metadata.machineId!);
                    child.session.metadata = { ...metadata, name: 'Native fork created', codexSessionId: nativeThreadId };
                    child.rows.length = 0;
                    child.rows.push(this.user(child, `fork-input-${body.operationId}`, 'Forked native input', true));
                    child.rows.push(this.agent(child, 'message', { message: 'Forked native answer', streamSnapshot: true }, `fork-answer-${body.operationId}`));
                    child.rows.push(this.terminal(child));
                    operation = { operationId: body.operationId, sourceSessionId: id, childSessionId: child.session.id,
                        sourceRevision: body.expectedForkRevision + 1, status: 'created', nativeThreadId,
                        binding: 'ready', message: 'Fixture native child is source-ready', updatedAt: Date.now() };
                    this.forks.set(body.operationId, operation); this.emit({ type: 'session-added', sessionId: child.session.id });
                }
                send({ operation, sessionId: operation.childSessionId }); return;
            }
            if (parts[3] === 'fork-operations' && parts[4]) {
                const operation = this.forks.get(parts[4]);
                send(operation ? { operation } : { error: 'unknown operation' }, operation ? 200 : 404); return;
            }
            if (!tail) {
                if (request.method === 'PATCH') { fixture.session.metadata!.name = body.name; fixture.session.metadataVersion++; this.emit({ type: 'session-updated', sessionId: id }); send({ ok: true }); }
                else {
                    const error = this.sessionReadErrors.get(id);
                    this.sessionReads.push({ sessionId: id, status: error?.status ?? 200 });
                    if (error) send({ error: 'Explicit original-session read failure fixture', code: error.code }, error.status);
                    else send({ session: fixture.session });
                }
                return;
            }
            if (tail === 'messages' && request.method === 'GET') {
                if (fixture.readHistory) { send(await fixture.readHistory(url)); return; }
                const paging = this.historyPaging.get(id);
                if (paging) { send(this.historyPage(fixture, paging, url)); return; }
                send({ messages: fixture.rows, page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
                    nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } }); return;
            }
            if (tail === 'messages' && request.method === 'POST') {
                this.sent.push({ sessionId: id, message: body });
                const row = this.user(fixture, body.localId, body.text, false);
                if (typeof body.scheduledAt === 'number') row.scheduledAt = body.scheduledAt;
                if (Array.isArray(body.attachments)) (row.content as { content: { attachments?: unknown[] } }).content.attachments = body.attachments;
                fixture.rows.push(row);
                if (this.dropNextMessageReply) { this.dropNextMessageReply = false; response.destroy(); }
                else send({ ok: true });
                this.emit({ type: 'message-received', sessionId: id, message: row }); return;
            }
            if (tail === 'messages/queued-state') {
                send({ queuedLocalIds: fixture.rows.filter(row => row.invokedAt === null && !row.deliveryState).map(row => row.localId),
                    dispatchingLocalIds: fixture.rows.filter(row => row.invokedAt === null && row.deliveryState === 'dispatching').map(row => row.localId),
                    indeterminateLocalIds: fixture.rows.filter(row => row.invokedAt === null && row.deliveryState === 'indeterminate').map(row => row.localId),
                    invokedLocalMessages: fixture.rows.filter(row => row.invokedAt != null).map(row => ({ localId: row.localId, invokedAt: row.invokedAt })) }); return;
            }
            if (parts[3] === 'messages' && request.method === 'DELETE') {
                await this.beforeCancel?.(id);
                const index = fixture.rows.findIndex(row => row.id === parts[4] || row.localId === parts[4]);
                const row = fixture.rows[index];
                if (row?.invokedAt) send({ status: 'invoked', message: row });
                else {
                    if (index >= 0) fixture.rows.splice(index, 1); this.cancelled.push(row?.localId ?? parts[4]!);
                    if (this.dropNextCancelReply) { this.dropNextCancelReply = false; response.destroy(); }
                    else send({ status: 'cancelled', localId: row?.localId ?? parts[4] });
                    if (this.suppressNextCancelEvent) this.suppressNextCancelEvent = false;
                    else this.emit({ type: 'message-cancelled', sessionId: id, messageId: row?.id ?? parts[4]!, ...(row?.localId ? { localId: row.localId } : {}) });
                }
                return;
            }
            if (parts[3] === 'permissions') { this.approvals.push({ sessionId: id, requestId: parts[4]!, answer: body }); send({ ok: true }); return; }
            if (tail === 'resume') { send({ sessionId: id }); return; }
            if (tail === 'pin' && request.method === 'PUT') { fixture.session.pinned = body.mode === 'project'; fixture.session.globalPinned = body.mode === 'global'; this.emit({ type: 'session-updated', sessionId: id }); send({ ok: true }); return; }
            if (tail === 'upload') { this.uploads.push(body); send({ success: true, path: `/runner/uploads/${body.filename}` }); return; }
            if (tail === 'abort') {
                this.aborted.push(id);
                if (this.dropNextAbortReply) { this.dropNextAbortReply = false; response.destroy(); }
                else send({ ok: true });
                return;
            }
            send({ error: 'fixture route not implemented', route: tail }, 404);
        } catch { if (!response.headersSent) send({ error: 'fixture failed' }, 500); else response.end(); }
    }
}
