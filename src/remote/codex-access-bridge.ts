/** Complete source-level native carrier. All execution and validation remain in Codex. */
import { join } from 'node:path';
import { CodexRpc, CodexRpcError, type NativeRequest } from './codex-rpc.ts';
import { ReceiptLedger } from './operation-ledger.ts';
import { SourceError } from './errors.ts';
import { CodexQueueSteer } from './codex-queue-steer.ts';
import { QUEUED_STEER_METHOD, QUEUE_VIEW_METHOD } from './codex-access.ts';
import { codexMethods, codexUnavailable, type CodexMethod } from './codex-methods.ts';
import type { CodexCall, CodexCallResult, CodexCapabilities, CodexEvents, CodexEventsRequest, CodexPendingRequest, CodexReply, CodexEvent } from './codex-access.ts';

export class CodexAccessBridge {
    private readonly ledger: ReceiptLedger<CodexCallResult>;
    private readonly queuedSteer: CodexQueueSteer | undefined;
    private readonly results = new Map<string, CodexCallResult>();
    private readonly pending = new Map<string, { request: NativeRequest; submitted: boolean }>();
    private events: CodexEvent[] = [];
    private bytes = 0;
    private sequence = 0;
    private eventsReadAt = 0;
    private droppedThrough = 0;
    private readonly stops: Array<() => void>;
    constructor(private readonly sourceId: string, private readonly rpc: CodexRpc, directory: string,
        private readonly beforeWrite: (method: string, params: Record<string, unknown> | null) => Promise<Record<string, unknown> | void>,
        private readonly afterCall: (method: string, params: Record<string, unknown> | null, result: unknown) => void,
        private readonly replyThread: (request: NativeRequest, operationId: string, result: unknown) => Promise<CodexCallResult>,
        private readonly reconcileWrite?: (method: string, params: Record<string, unknown> | null) => Promise<CodexCallResult | undefined>,
        private readonly sourceRead?: (method: string, params: Record<string, unknown> | null, signal?: AbortSignal) => Promise<CodexCallResult | undefined>,
        private readonly queuePresentation?: (threadId: string, rows: unknown[]) => unknown[]) {
        this.ledger = new ReceiptLedger(join(directory, 'native-operations'));
        if (this.reconcileWrite) this.queuedSteer = new CodexQueueSteer(sourceId, directory,
            (request, lookup) => this.call(request, lookup, undefined, true),
            async params => (await this.reconcileWrite!('turn/steer', params))?.status === 'accepted');
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
        return { protocolVersion: '0.165.0', runtime: initialized.userAgent, methods: { ...codexMethods,
            ...(this.queuedSteer ? { [QUEUED_STEER_METHOD]: 'write' as const, [QUEUE_VIEW_METHOD]: 'read' as const } : {}) }, unavailable: codexUnavailable };
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
        if (method === QUEUED_STEER_METHOD && this.queuedSteer) return 'write';
        if (method === QUEUE_VIEW_METHOD && this.queuedSteer) return 'read';
        if (!Object.hasOwn(codexMethods, method)) throw new SourceError('UNSUPPORTED', 'This native method is not exposed by the pinned Codex carrier.');
        return codexMethods[method as CodexMethod];
    }
    private valid(value: unknown): value is CodexCallResult {
        return !!value && typeof value === 'object' && 'status' in value && ['accepted', 'rejected', 'indeterminate'].includes(String(value.status)) && 'message' in value && typeof value.message === 'string';
    }
    private async write(operationId: string | undefined, payload: unknown, execute: () => Promise<CodexCallResult>, lookup = false, targetMethod?: string, distinguishAbsent = false, retainQueueIdentity = false): Promise<CodexCallResult> {
        if (!operationId) throw new SourceError('INVALID_REQUEST', 'Native writes require a stable operation identity.');
        const uncertain: CodexCallResult = { status: 'indeterminate', message: 'Native outcome is unknown. This operation will not be resent.' };
        const work = async (): Promise<CodexCallResult> => {
            const response = await execute();
            this.results.set(operationId, response);
            if (this.results.size > 128) this.results.delete(this.results.keys().next().value!);
            // Persist only target/delete/restore identity correlations. Native
            // tokens, configuration and response content stay outside this receipt.
            const result = response.result;
            const thread = result && typeof result === 'object' && 'thread' in result ? result.thread : undefined;
            const id = thread && typeof thread === 'object' && 'id' in thread ? thread.id : undefined;
            const queued = result && typeof result === 'object' && 'queuedSubmission' in result ? result.queuedSubmission : undefined;
            const target = response.status === 'accepted' && (targetMethod === 'thread/fork' || targetMethod === 'thread/start')
                && typeof id === 'string' && id.length > 0 ? { thread: { id } }
                : response.status === 'accepted' && targetMethod === 'thread/queue/delete' && result && typeof result === 'object'
                    && 'deleted' in result && typeof result.deleted === 'boolean' ? { deleted: result.deleted }
                    : response.status === 'accepted' && retainQueueIdentity && queued && typeof queued === 'object'
                        && 'id' in queued && typeof queued.id === 'string' && 'clientUserMessageId' in queued && typeof queued.clientUserMessageId === 'string'
                        ? { queuedSubmission: { id: queued.id, clientUserMessageId: queued.clientUserMessageId } } : undefined;
            return { status: response.status, message: response.status === 'accepted' ? 'Native request accepted.' : 'Native request rejected.',
                ...(target ? { result: target } : { resultUnavailable: true as const }) };
        };
        const recovery = (targetMethod === 'thread/queue/add' || targetMethod === 'turn/steer') && this.reconcileWrite ? {
            retry: (value: CodexCallResult): boolean => targetMethod === 'thread/queue/add' && 'retryable' in value && value.retryable === true,
            reconcile: (): Promise<CodexCallResult | undefined> => this.reconcileWrite!(targetMethod, (payload as [string, Record<string, unknown> | null])[1]),
        } : undefined;
        const receipt = lookup
            ? await this.ledger.lookup([this.sourceId, operationId], payload, value => this.valid(value), recovery?.reconcile)
            : await this.ledger.run([this.sourceId, operationId], payload, uncertain, value => this.valid(value), work,
                recovery);
        const current = this.results.get(operationId);
        return receipt ? current?.status === receipt.status ? current : receipt
            : distinguishAbsent ? { status: 'rejected', message: 'This native step has not been attempted.', result: { notAttempted: true } }
            : { status: 'indeterminate', message: 'No native operation receipt confirms this action. It will not be resent.' };
    }
    async call(request: CodexCall, lookup = false, signal?: AbortSignal, transferChild = false): Promise<CodexCallResult> {
        this.assertSource(request.sourceId);
        const mode = this.mode(request.method);
        if (request.method === QUEUE_VIEW_METHOD) {
            if (lookup || !this.queuedSteer || typeof request.params?.threadId !== 'string') throw new SourceError('INVALID_REQUEST', 'A source queue read requires its exact native thread.');
            const rows: unknown[] = [], cursors = new Set<string>();
            let cursor: string | null = null;
            do {
                signal?.throwIfAborted();
                const page = await this.call({ sourceId: this.sourceId, method: 'thread/queue/list', params: { threadId: request.params.threadId, cursor, limit: 1 } }, false, signal);
                const result = page.result;
                if (page.status !== 'accepted') return page;
                if (!result || typeof result !== 'object' || !('data' in result) || !Array.isArray(result.data)) throw new SourceError('TARGET_UNAVAILABLE', 'The source queue could not be read.');
                rows.push(...this.queuePresentation?.(request.params.threadId, result.data) ?? result.data);
                cursor = 'nextCursor' in result && typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
                if (cursor && (cursors.has(cursor) || cursors.size >= 1600)) throw new SourceError('TARGET_UNAVAILABLE', 'The queue view could not be completed. Nothing was changed.');
                if (cursor) cursors.add(cursor);
            } while (cursor);
            const projected = await this.queuedSteer.project(request.params.threadId, rows);
            return { status: 'accepted', message: 'Source queue read.', result: { data: this.queuePresentation?.(request.params.threadId, projected) ?? projected, nextCursor: null } };
        }
        if (request.method === QUEUED_STEER_METHOD) {
            if (!this.queuedSteer) throw new SourceError('UNSUPPORTED', 'This source has no queued-input transfer owner. Nothing was sent.');
            if (!lookup) await this.beforeWrite('turn/steer', request.params);
            return this.queuedSteer.run(request, lookup);
        }
        const execute = async (): Promise<CodexCallResult> => {
            try {
                // Restoring a definitely rejected transfer never resumes another owner.
                const dispatchParams = mode === 'write' ? await this.beforeWrite(transferChild && request.method === 'thread/queue/add' ? 'turn/steer' : request.method, request.params) ?? request.params : request.params;
                if (mode === 'read') {
                    const source = await this.sourceRead?.(request.method, request.params, signal);
                    if (source !== undefined) return source;
                }
                let result = await this.rpc.request(request.method, dispatchParams, { write: mode === 'write', ...(signal ? { signal } : {}) });
                if (transferChild && request.method === 'thread/queue/list' && request.params && typeof request.params.threadId === 'string'
                    && result && typeof result === 'object' && 'data' in result && Array.isArray(result.data) && this.queuePresentation)
                    result = { ...result, data: this.queuePresentation(request.params.threadId, result.data) };
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
        const write = () => this.write(request.operationId, [request.method, request.params], execute, lookup, request.method, transferChild && lookup,
            transferChild && request.method === 'thread/queue/add');
        return !lookup && !transferChild && this.queuedSteer && ['thread/queue/update', 'thread/queue/delete', 'thread/queue/start'].includes(request.method)
            ? this.queuedSteer.mutate(request, write) : write();
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
