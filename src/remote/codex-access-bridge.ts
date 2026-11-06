/** Complete source-level native carrier. All execution and validation remain in Codex. */
import { join } from 'node:path';
import { CodexRpc, CodexRpcError, type NativeRequest } from './codex-rpc.ts';
import { ReceiptLedger } from './operation-ledger.ts';
import { SourceError } from './errors.ts';
import { codexMethods, codexUnavailable, type CodexMethod } from './codex-methods.ts';
import type { CodexCall, CodexCallResult, CodexCapabilities, CodexEvents, CodexEventsRequest, CodexPendingRequest, CodexReply, CodexEvent } from './codex-access.ts';

export class CodexAccessBridge {
    private readonly ledger: ReceiptLedger<CodexCallResult>;
    private readonly results = new Map<string, CodexCallResult>();
    private readonly pending = new Map<string, { request: NativeRequest; submitted: boolean }>();
    private events: CodexEvent[] = [];
    private bytes = 0;
    private sequence = 0;
    private eventsReadAt = 0;
    private droppedThrough = 0;
    private readonly stops: Array<() => void>;
    constructor(private readonly sourceId: string, private readonly rpc: CodexRpc, directory: string,
        private readonly beforeWrite: (method: string, params: Record<string, unknown> | null) => Promise<void>,
        private readonly afterCall: (method: string, params: Record<string, unknown> | null, result: unknown) => void,
        private readonly replyThread: (request: NativeRequest, operationId: string, result: unknown) => Promise<CodexCallResult>) {
        this.ledger = new ReceiptLedger(join(directory, 'native-operations'));
        this.stops = [rpc.onNotification(value => {
            this.append(value.method, value.params);
            if (value.method === 'serverRequest/resolved') {
                for (const [id, pending] of this.pending) if (pending.request.id === value.params.requestId) this.pending.delete(id);
            }
        }), rpc.onRequest(request => {
            const id = JSON.stringify([request.generation, typeof request.id, request.id]);
            this.pending.set(id, { request, submitted: false });
            this.append('$request', { requestId: id, method: request.method, params: request.params });
        }), rpc.onDisconnect(() => { this.pending.clear(); this.events = []; this.bytes = 0; })];
    }
    private append(method: string, params: Record<string, unknown>): void {
        const event = { sequence: ++this.sequence, generation: this.rpc.currentGeneration, method, params };
        // Normal chat consumes the existing source stream. Raw native events are retained only for active native clients.
        if (Date.now() - this.eventsReadAt > 30_000) { this.droppedThrough = event.sequence; return; }
        this.events.push(event); this.bytes += JSON.stringify(event).length;
        while (this.events.length > 512 || this.bytes > 2 * 1024 * 1024) {
            const first = this.events.shift(); if (!first) break;
            this.bytes -= JSON.stringify(first).length; this.droppedThrough = first.sequence;
        }
    }
    async capabilities(signal?: AbortSignal): Promise<CodexCapabilities> {
        const initialized = await this.rpc.connect(signal);
        return { protocolVersion: '0.165.0', runtime: initialized.userAgent, methods: codexMethods, unavailable: codexUnavailable };
    }
    readEvents(request: CodexEventsRequest): CodexEvents {
        this.assertSource(request.sourceId);
        this.eventsReadAt = Date.now();
        const generation = this.rpc.currentGeneration;
        const reset = request.generation !== generation || request.after === undefined || request.after < this.droppedThrough || request.after < (this.events[0]?.sequence ?? this.sequence + 1) - 1 || request.after > this.sequence;
        const pending: CodexPendingRequest[] = [...this.pending].map(([id, { request: native }]) => ({ id, method: native.method, params: native.params, generation: native.generation }));
        return { generation, cursor: this.sequence, reset, events: reset ? [] : this.events.filter(event => event.sequence > request.after!), pending };
    }
    private assertSource(sourceId: string): void {
        if (sourceId !== this.sourceId) throw new SourceError('INVALID_REQUEST', 'Native request belongs to another source.');
    }
    private mode(method: string): 'read' | 'write' {
        if (!Object.hasOwn(codexMethods, method)) throw new SourceError('UNSUPPORTED', 'This native method is not exposed by the pinned Codex carrier.');
        return codexMethods[method as CodexMethod];
    }
    private valid(value: unknown): value is CodexCallResult {
        return !!value && typeof value === 'object' && 'status' in value && ['accepted', 'rejected', 'indeterminate'].includes(String(value.status)) && 'message' in value && typeof value.message === 'string';
    }
    private async write(operationId: string | undefined, payload: unknown, execute: () => Promise<CodexCallResult>, lookup = false): Promise<CodexCallResult> {
        if (!operationId) throw new SourceError('INVALID_REQUEST', 'Native writes require a stable operation identity.');
        const uncertain: CodexCallResult = { status: 'indeterminate', message: 'Native outcome is unknown. This operation will not be resent.' };
        const work = async (): Promise<CodexCallResult> => {
            const response = await execute();
            this.results.set(operationId, response);
            if (this.results.size > 128) this.results.delete(this.results.keys().next().value!);
            // Tokens, configuration and native content are never copied into the receipt store.
            return { status: response.status, message: response.status === 'accepted' ? 'Native request accepted.' : 'Native request rejected.', resultUnavailable: true };
        };
        const receipt = lookup
            ? await this.ledger.lookup([this.sourceId, operationId], payload, value => this.valid(value))
            : await this.ledger.run([this.sourceId, operationId], payload, uncertain, value => this.valid(value), work);
        return receipt ? this.results.get(operationId) ?? receipt : { status: 'rejected', message: 'No native operation receipt exists.' };
    }
    async call(request: CodexCall, lookup = false, signal?: AbortSignal): Promise<CodexCallResult> {
        this.assertSource(request.sourceId);
        const mode = this.mode(request.method);
        const execute = async (): Promise<CodexCallResult> => {
            try {
                if (mode === 'write') await this.beforeWrite(request.method, request.params);
                const result = await this.rpc.request(request.method, request.params, { write: mode === 'write', ...(signal ? { signal } : {}) });
                this.afterCall(request.method, request.params, result);
                return { status: 'accepted', message: 'Native request accepted.', result };
            } catch (error) {
                if (error instanceof CodexRpcError) return { status: 'rejected', message: error.message, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } };
                throw error;
            }
        };
        if (mode === 'read') {
            if (lookup) throw new SourceError('INVALID_REQUEST', 'Read requests do not have write receipts.');
            return execute();
        }
        return this.write(request.operationId, [request.method, request.params], execute, lookup);
    }
    async reply(reply: CodexReply): Promise<CodexCallResult> {
        this.assertSource(reply.sourceId);
        return this.write(reply.operationId, ['$reply', reply.requestId, reply.result], async () => {
            const pending = this.pending.get(reply.requestId);
            if (!pending || pending.request.generation !== this.rpc.currentGeneration || pending.submitted) throw new SourceError('INVALID_REQUEST', 'The native request is no longer answerable.');
            pending.submitted = true;
            if (typeof pending.request.params.threadId === 'string') return this.replyThread(pending.request, reply.operationId, reply.result);
            await this.rpc.respond(pending.request, reply.result);
            this.pending.delete(reply.requestId);
            return { status: 'accepted', message: 'Native response delivered; execution remains owned by Codex.' };
        });
    }
    dispose(): void { for (const stop of this.stops) stop(); this.pending.clear(); this.results.clear(); this.events = []; }
}
