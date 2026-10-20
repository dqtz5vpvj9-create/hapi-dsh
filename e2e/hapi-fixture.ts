/** Explicit HAPI wire fixture. It does not claim to execute a real Codex model. */
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { HapiEvent, HapiMessage, HapiSession, HapiSendMessage } from '../src/codex/contracts.ts';
import type { NativeForkReceipt } from '../src/codex/control-types.ts';

const token = 'e2e-hapi-access-token';
const jwt = 'e2e-hapi-jwt';
export interface NativeFixture { session: HapiSession; rows: HapiMessage[] }

export class HapiWireFixture {
    readonly sessions = new Map<string, NativeFixture>();
    readonly sent: Array<{ sessionId: string; message: HapiSendMessage }> = [];
    readonly approvals: Array<{ sessionId: string; requestId: string; answer: unknown }> = [];
    readonly uploads: unknown[] = [];
    readonly settingChanges: Array<{ sessionId: string; route: string; body: unknown }> = [];
    readonly forkRequests: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
    readonly planRequests: Array<{ sessionId: string; planId: string }> = [];
    readonly cancelled: string[] = [];
    readonly accessToken = token;
    eventConnections = 0;
    private readonly streams = new Set<ServerResponse>();
    private cursor = 0;
    private readonly server = createServer((request, response) => { void this.handle(request, response); });
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
        fixture.rows.push(this.user(fixture, `input-${key}`, `Question from Codex TUI — ${key}`, true, now + 1));
        fixture.rows.push(this.agent(fixture, 'message', { message: `Native history ${key} in the official DSH Conversation.`, streamSnapshot: true }, `answer-${key}`, now + 2));
        fixture.rows.push(this.terminal(fixture, now + 3));
        return fixture;
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
    emit(event: HapiEvent): void {
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
        source.execution = { ...source.execution!, sequence: source.execution!.sequence + 1, status: 'active', waitingOn: ['approval'] };
        source.executionVersion!++;
        this.emit({ type: 'session-updated', sessionId: id });
    }
    settleApproval(id: string, requestId = 'approval-e2e'): void {
        const source = this.require(id).session;
        const request = source.agentState!.requests![requestId]!;
        source.agentState = { requests: {}, completedRequests: { [requestId]: { ...request, status: 'resolved', completedAt: Date.now() } } };
        source.agentStateVersion++;
        source.execution = { ...source.execution!, sequence: source.execution!.sequence + 1, status: 'idle', waitingOn: [] };
        source.executionVersion!++;
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
        this.disconnectEvents(); this.server.closeAllConnections();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
    private async handle(request: import('node:http').IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://fixture');
        const send = (value: unknown, status = 200): void => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const raw = Buffer.concat(chunks).toString();
            const body = raw ? JSON.parse(raw) : {};
            if (url.pathname === '/api/auth') { send(body.accessToken === token ? { token: jwt } : { error: 'fixture authentication failed' }, body.accessToken === token ? 200 : 401); return; }
            if (request.headers.authorization !== `Bearer ${jwt}`) { send({ error: 'unauthorized' }, 401); return; }
            if (url.pathname === '/api/events') {
                this.eventConnections++;
                response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
                this.streams.add(response); response.on('close', () => this.streams.delete(response));
                response.write(`id: fixture-${this.cursor}\ndata: ${JSON.stringify({ type: 'connection-changed', data: { status: 'connected', resume: 'gap' } })}\n\n`);
                return;
            }
            if (url.pathname === '/api/sessions') { send({ sessions: [...this.sessions.values()].map(value => value.session) }); return; }
            if (url.pathname === '/api/machines') {
                send({ machines: ['alpha', 'beta'].map(key => ({ id: `machine-${key}`, active: true, activeAt: Date.now(), metadata: { host: key === 'alpha' ? 'Laptop' : 'Linux workstation' } })) }); return;
            }
            if (/\/codex-homes$/.test(url.pathname)) { send({ success: true, homes: [{ id: 'home-alpha', label: 'Personal', path: '/home/alpha/.codex' }] }); return; }
            if (/\/codex-models$/.test(url.pathname)) { send({ success: true, models: [{ id: 'fixture-model', displayName: 'Fixture model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'], serviceTiers: ['fast'] }] }); return; }
            if (/\/spawn$/.test(url.pathname)) {
                let id = this.spawns.get(body.requestId);
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
                else send({ session: fixture.session });
                return;
            }
            if (tail === 'messages' && request.method === 'GET') {
                send({ messages: fixture.rows, page: { direction: 'latest', limit: 200, epoch: 1, reset: false,
                    nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null, snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } }); return;
            }
            if (tail === 'messages' && request.method === 'POST') {
                this.sent.push({ sessionId: id, message: body });
                const row = this.user(fixture, body.localId, body.text, false);
                fixture.rows.push(row); send({ ok: true }); this.emit({ type: 'message-received', sessionId: id, message: row }); return;
            }
            if (tail === 'messages/queued-state') {
                send({ queuedLocalIds: fixture.rows.filter(row => row.invokedAt === null).map(row => row.localId),
                    invokedLocalMessages: fixture.rows.filter(row => row.invokedAt != null).map(row => ({ localId: row.localId, invokedAt: row.invokedAt })) }); return;
            }
            if (parts[3] === 'messages' && request.method === 'DELETE') {
                const index = fixture.rows.findIndex(row => row.id === parts[4] || row.localId === parts[4]);
                const row = fixture.rows[index];
                if (row?.invokedAt) send({ status: 'invoked', message: row });
                else { if (index >= 0) fixture.rows.splice(index, 1); this.cancelled.push(row?.localId ?? parts[4]!); send({ status: 'cancelled', localId: row?.localId ?? parts[4] }); this.emit({ type: 'message-cancelled', sessionId: id, messageId: row?.id ?? parts[4]!, ...(row?.localId ? { localId: row.localId } : {}) }); }
                return;
            }
            if (parts[3] === 'permissions') { this.approvals.push({ sessionId: id, requestId: parts[4]!, answer: body }); send({ ok: true }); return; }
            if (tail === 'resume') { send({ sessionId: id }); return; }
            if (tail === 'upload') { this.uploads.push(body); send({ success: true, path: `/runner/uploads/${body.filename}` }); return; }
            if (tail === 'abort') { send({ ok: true }); return; }
            send({ error: 'fixture route not implemented', route: tail }, 404);
        } catch { if (!response.headersSent) send({ error: 'fixture failed' }, 500); else response.end(); }
    }
}
