/** Original HAPI SessionBulkActions selection and endpoints, with durable at-most-once dispatch. */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HapiRequestError, type HapiSession, type HapiSessionSummary } from '../codex/contracts.ts';
import { nativeSessionId, record } from '../codex/native.ts';
import { writeDurableJson } from '../codex/durable-file.ts';
import { sourceBulkOperationSchema, sourceBulkReceiptSchema, type SourceBulkOperation, type SourceBulkReceipt } from '../source-bulk-types.ts';

export interface SourceBulkTransport {
    readonly hubId: string;
    listSessions(): Promise<readonly HapiSessionSummary[]>;
    getSession(id: string): Promise<HapiSession>;
    request(path: string, options?: { method?: string; body?: unknown }): Promise<unknown>;
}
type Activity = HapiSessionSummary & { pendingRequestKinds?: readonly string[]; blockingRequestKinds?: readonly string[]; backgroundTaskCount?: number };
/** Same precedence as HAPI shared/sessionActivity.ts: waiting approvals/input and errors are not running. */
export function sourceBulkTargets(sessions: readonly HapiSessionSummary[], action: SourceBulkOperation['action']): HapiSessionSummary[] {
    return sessions.filter(raw => {
        const session = raw as Activity;
        if (action === 'standard') return session.metadata?.flavor === 'codex' && /^(fast|priority)$/iu.test(session.serviceTier?.trim() ?? '');
        if (!session.active || session.execution?.status === 'disconnected' || session.execution?.status === 'systemError') return false;
        // GET /sessions/:id returns the full AgentState, not derived summary
        // request kinds. Recheck it before dispatch so a new approval arriving
        // after the list snapshot does not get interrupted by this bulk action.
        if ('agentState' in session && Object.values((session as HapiSession).agentState?.requests ?? {}).some(request => request.blocking !== false)) return false;
        const blocking = session.blockingRequestKinds ?? session.pendingRequestKinds ?? [], waiting = session.execution?.waitingOn ?? [];
        if (waiting.includes('approval') || waiting.includes('input') || blocking.includes('permission') || blocking.includes('input')) return false;
        return (session.execution ? session.execution.status === 'active' : session.thinking) || (session.backgroundTaskCount ?? 0) > 0;
    });
}
const savedSchema = z.object({ version: z.literal(1), operations: z.array(sourceBulkReceiptSchema) });
const explanation = (error: unknown) => error instanceof Error ? error.message : 'The original Hub did not confirm this operation.';
const acknowledged = z.object({ ok: z.literal(true) });

export class SourceBulkActions {
    private readonly filename: string;
    private readonly operations = new Map<string, SourceBulkReceipt>();
    private readonly flights = new Map<string, Promise<SourceBulkReceipt>>();
    constructor(private readonly client: SourceBulkTransport, directory: string) {
        mkdirSync(directory, { recursive: true, mode: 0o700 }); this.filename = join(directory, `${nativeSessionId(client.hubId, 'bulk-actions')}.json`);
        try {
            const saved = savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')));
            for (const receipt of saved.operations) {
                if (receipt.hubId !== client.hubId) throw new Error('Bulk action journal belongs to another Hub.');
                if (receipt.state === 'running' || receipt.state === 'reading') {
                    receipt.state = 'interrupted'; receipt.error = 'The Host restarted. Unconfirmed source operations are not replayed.';
                    for (const target of receipt.targets) if (target.status === 'dispatching') target.status = 'unknown'; else if (target.status === 'prepared') target.status = 'skipped';
                }
                this.operations.set(receipt.operationId, receipt);
            }
        } catch (error) { if (record(error)?.code !== 'ENOENT') throw error; }
    }
    private save(receipt: SourceBulkReceipt): void {
        receipt.updatedAt = Date.now(); writeDurableJson(this.filename, { version: 1, operations: [...this.operations.values()] });
    }
    read(operationId: string): SourceBulkReceipt | null {
        const value = this.operations.get(operationId); return value ? structuredClone(value) : null;
    }
    operation(input: SourceBulkOperation): Promise<SourceBulkReceipt> {
        const request = sourceBulkOperationSchema.parse(input), previous = this.operations.get(request.operationId);
        if (previous) {
            if (previous.action !== request.action) return Promise.reject(new HapiRequestError('This bulk action identity has different input.', 'rejected', 409));
            return Promise.resolve(structuredClone(previous));
        }
        const now = Date.now(), receipt: SourceBulkReceipt = { ...request, hubId: this.client.hubId, createdAt: now, updatedAt: now, state: 'reading', error: null, targets: [] };
        this.operations.set(request.operationId, receipt);
        try { this.save(receipt); } catch (error) { this.operations.delete(request.operationId); return Promise.reject(error); }
        const flight = this.run(receipt); this.flights.set(request.operationId, flight);
        void flight.finally(() => this.flights.delete(request.operationId)).catch(() => {}); return flight;
    }
    private async run(receipt: SourceBulkReceipt): Promise<SourceBulkReceipt> {
        try {
            // Selection is refreshed at the original user click, never from a
            // cached sidebar or stale settings-page count.
            const sessions = sourceBulkTargets(await this.client.listSessions(), receipt.action);
            receipt.targets = sessions.map(session => ({ sourceSessionId: session.id, machineId: session.metadata?.machineId ?? null,
                name: session.metadata?.name || session.metadata?.path || session.id, namespace: null, sourceCreatedAt: null, status: 'prepared', error: null }));
            receipt.state = 'running'; this.save(receipt);
            let cursor = 0;
            await Promise.all(Array.from({ length: Math.min(6, receipt.targets.length) }, async () => {
                for (;;) {
                    const target = receipt.targets[cursor++]; if (!target) return;
                    let dispatched = false;
                    try {
                        const current = await this.client.getSession(target.sourceSessionId);
                        if (current.id !== target.sourceSessionId || (current.metadata?.machineId ?? null) !== target.machineId) throw new Error('The original source identity changed after selection.');
                        if (!sourceBulkTargets([current], receipt.action).length) { target.status = 'skipped'; target.error = 'The source no longer matches this action.'; this.save(receipt); continue; }
                        target.namespace = current.namespace; target.sourceCreatedAt = current.createdAt;
                        target.status = 'dispatching'; this.save(receipt); dispatched = true;
                        const endpoint = receipt.action === 'standard' ? 'service-tier' : 'abort';
                        const result = await this.client.request(`/api/sessions/${encodeURIComponent(target.sourceSessionId)}/${endpoint}`, { method: 'POST', body: receipt.action === 'standard' ? { serviceTier: 'standard' } : {} });
                        if (!acknowledged.safeParse(result).success) throw new HapiRequestError('The source reply did not confirm this operation.', 'indeterminate', 502);
                        target.status = 'accepted';
                    } catch (error) {
                        target.status = !dispatched || error instanceof HapiRequestError && error.outcome === 'rejected' ? 'rejected' : 'unknown'; target.error = explanation(error);
                    }
                    this.save(receipt);
                }
            }));
            receipt.state = 'finished';
        } catch (error) {
            receipt.state = receipt.targets.some(target => target.status === 'dispatching' || target.status === 'unknown') ? 'interrupted' : 'failed';
            receipt.error = explanation(error);
        }
        this.save(receipt); return structuredClone(receipt);
    }
    async settled(): Promise<void> { await Promise.allSettled(this.flights.values()); }
}
