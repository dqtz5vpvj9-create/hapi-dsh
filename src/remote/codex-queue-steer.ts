/** Source-owned queued-input transfer. Native dispatch never follows an uncertain deletion. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { ReceiptLedger } from './operation-ledger.ts';
import { SourceError } from './errors.ts';
import type { CodexCall, CodexCallResult } from './codex-access.ts';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
interface QueuedInput { id: string; clientUserMessageId: string; input: Record<string, unknown>[] }
interface Claim {
    status: 'accepted' | 'indeterminate'; message: string;
    operationId: string; threadId: string; expectedTurnId: string; item: QueuedInput;
}
export type QueueDelivery = 'sending' | 'confirming' | 'failed';
const validItem = (value: unknown): value is QueuedInput => record(value) && typeof value.id === 'string' && !!value.id
    && typeof value.clientUserMessageId === 'string' && !!value.clientUserMessageId && Array.isArray(value.input)
    && value.input.length > 0 && value.input.every(part => record(part) && typeof part.type === 'string');
const validClaim = (value: unknown): value is Claim => record(value) && (value.status === 'accepted' || value.status === 'indeterminate')
    && typeof value.message === 'string' && typeof value.operationId === 'string' && typeof value.threadId === 'string'
    && typeof value.expectedTurnId === 'string' && validItem(value.item);
const unknown = (): CodexCallResult => ({ status: 'indeterminate', message: 'This message is waiting for source confirmation. It will not be sent again.' });
const notAttempted = (receipt: CodexCallResult): boolean => record(receipt.result) && receipt.result.notAttempted === true;

/** Full native input stays in this source's private journal, never in a browser-owned replacement queue. */
export class CodexQueueSteer {
    private readonly claims: ReceiptLedger<Claim>;
    private readonly consumed: ReceiptLedger<CodexCallResult>;
    private readonly claimDirectory: string;
    constructor(private readonly sourceId: string, private readonly directory: string,
        private readonly call: (request: CodexCall, lookup: boolean) => Promise<CodexCallResult>,
        private readonly observed: (params: Record<string, unknown>) => Promise<boolean>) {
        this.claimDirectory = join(directory, 'queue-steer-inputs');
        this.claims = new ReceiptLedger(this.claimDirectory);
        this.consumed = new ReceiptLedger(join(directory, 'queue-steer-consumed'));
    }
    private identity(claim: Claim): string[] { return [this.sourceId, claim.operationId]; }
    private payload(claim: Claim): unknown { return [claim.threadId, claim.expectedTurnId, claim.item]; }
    private async locked<T>(threadId: string, itemId: string, work: () => Promise<T>): Promise<T> {
        const parent = join(this.directory, 'queue-steer-locks');
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const lock = join(parent, createHash('sha256').update(JSON.stringify([threadId, itemId])).digest('hex'));
        return withFileLock(lock, work, { waitMs: 65_000 });
    }
    /** HHPI clients cannot edit/delete an original while its source owner is transferring it. */
    async mutate(request: CodexCall, execute: () => Promise<CodexCallResult>): Promise<CodexCallResult> {
        const { threadId, queuedSubmissionId } = request.params ?? {};
        if (typeof threadId !== 'string' || typeof queuedSubmissionId !== 'string') return execute();
        return this.locked(threadId, queuedSubmissionId, async () => {
            for (const claim of await this.all(threadId)) if (claim.item.id === queuedSubmissionId) {
                const deleted = await this.deletion(claim, true);
                if (!notAttempted(deleted) && deleted.status !== 'rejected') return { status: 'rejected', message: 'This message is being sent or awaiting confirmation. Its original input has been kept.' };
            }
            return execute();
        });
    }
    private async all(threadId: string): Promise<Claim[]> {
        let names: string[];
        try { names = await readdir(this.claimDirectory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        const claims: Claim[] = [];
        for (const name of names) if (/^[a-f0-9]{64}\.json$/.test(name)) {
            const stored: unknown = JSON.parse(await readFile(join(this.claimDirectory, name), 'utf8'));
            if (!record(stored) || !validClaim(stored.receipt)) throw new SourceError('TARGET_UNAVAILABLE', 'The saved queued message cannot be read. Nothing was sent.');
            if (stored.receipt.threadId === threadId) claims.push(stored.receipt);
        }
        return claims;
    }
    private native(claim: Claim, method: string, suffix: string, params: Record<string, unknown>, lookup: boolean): Promise<CodexCallResult> {
        return this.call({ sourceId: this.sourceId, operationId: `${claim.operationId}:${suffix}`, method,
            params: { threadId: claim.threadId, ...params } }, lookup);
    }
    private deletion(claim: Claim, lookup: boolean): Promise<CodexCallResult> {
        return this.native(claim, 'thread/queue/delete', 'claim', { queuedSubmissionId: claim.item.id }, lookup);
    }
    private steering(claim: Claim, lookup: boolean): Promise<CodexCallResult> {
        return this.native(claim, 'turn/steer', 'steer', { expectedTurnId: claim.expectedTurnId,
            clientUserMessageId: claim.item.clientUserMessageId, input: claim.item.input }, lookup);
    }
    private restoring(claim: Claim, lookup: boolean): Promise<CodexCallResult> {
        return this.native(claim, 'thread/queue/add', 'restore', { clientUserMessageId: claim.item.clientUserMessageId, input: claim.item.input }, lookup);
    }
    private async find(claim: Claim): Promise<QueuedInput | undefined> {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
            const page = await this.call({ sourceId: this.sourceId, method: 'thread/queue/list', params: { threadId: claim.threadId, limit: 1, cursor } }, false);
            if (page.status !== 'accepted' || !record(page.result) || !Array.isArray(page.result.data)) throw new SourceError('TARGET_UNAVAILABLE', 'The original queue could not be checked. Nothing was sent.');
            const item = page.result.data.find(item => validItem(item) && item.id === claim.item.id);
            if (validItem(item)) return item;
            cursor = typeof page.result.nextCursor === 'string' && page.result.nextCursor ? page.result.nextCursor : null;
            if (cursor && (cursors.has(cursor) || cursors.size >= 1600)) throw new SourceError('TARGET_UNAVAILABLE', 'The queue cursor did not advance. Nothing was sent.');
            if (cursor) cursors.add(cursor);
        } while (cursor);
        return undefined;
    }
    private unchanged(current: QueuedInput | undefined, claim: Claim): boolean {
        return !!current && current.clientUserMessageId === claim.item.clientUserMessageId && JSON.stringify(current.input) === JSON.stringify(claim.item.input);
    }
    private async hasBody(claim: Claim, observe = true): Promise<boolean | undefined> {
        const valid = (value: unknown): value is CodexCallResult => record(value) && value.status === 'accepted' && typeof value.message === 'string';
        if (await this.consumed.lookup(this.identity(claim), this.payload(claim), valid)) return true;
        if (!observe) return false;
        // Body correlation is additional evidence, not the native queue's
        // acquisition boundary. A superseded/unavailable read proves neither
        // consumption nor rejection and must not hide the retained input.
        try { if (!await this.observed({ threadId: claim.threadId, clientUserMessageId: claim.item.clientUserMessageId })) return false; }
        catch { return undefined; }
        await this.consumed.run(this.identity(claim), this.payload(claim), { status: 'accepted', message: 'The original message is in native history.' }, valid,
            async () => ({ status: 'accepted', message: 'The original message is in native history.' }));
        return true;
    }
    private async settle(claim: Claim, lookup: boolean): Promise<CodexCallResult> {
        const priorDeletion = await this.deletion(claim, true);
        if (notAttempted(priorDeletion)) {
            // A still-exact native row is acquired only by deleted=true below.
            // Do not gate that operation on an unrelated live-tail body read.
            if (await this.hasBody(claim, false)) return { status: 'accepted', message: 'The original message is already in the source conversation.', resultUnavailable: true };
            if (lookup) return unknown();
            if (!this.unchanged(await this.find(claim), claim)) {
                if (await this.hasBody(claim)) return { status: 'accepted', message: 'The original message is already in the source conversation.', resultUnavailable: true };
                return { status: 'rejected', message: 'This queued message changed or has started. The original was not sent again.' };
            }
        } else if (await this.hasBody(claim)) {
            // Exact consumed-body proof still wins after any attempted step.
            return { status: 'accepted', message: 'The original message is already in the source conversation.', resultUnavailable: true };
        }
        const deleted = lookup ? priorDeletion : await this.deletion(claim, false);
        if (deleted.status !== 'accepted') return deleted;
        // A successful JSON-RPC response with deleted=false did NOT acquire the item.
        if (!record(deleted.result) || deleted.result.deleted !== true)
            return { status: 'rejected', message: 'This message has already left the source queue. It was not sent again.' };
        const steered = await this.steering(claim, lookup);
        if (notAttempted(steered)) return unknown();
        if (steered.status !== 'rejected') return steered;
        // Only a definite native rejection permits returning the original input.
        // Restoration has its own stable receipt; unknown restoration is never replayed.
        const restored = await this.restoring(claim, lookup);
        if (restored.status !== 'accepted') return unknown();
        return { status: 'rejected', message: 'The running turn changed. The original message was kept in the source queue.', result: { queueRestored: true } };
    }
    async run(request: CodexCall, lookup: boolean): Promise<CodexCallResult> {
        const params = request.params;
        if (!request.operationId || !params || typeof params.threadId !== 'string' || typeof params.expectedTurnId !== 'string' || !params.expectedTurnId
            || !validItem({ id: params.queuedSubmissionId, clientUserMessageId: params.clientUserMessageId, input: params.input }))
            throw new SourceError('INVALID_REQUEST', 'Queued steering requires the exact original item, input and active turn.');
        const resume = typeof params.resumeOperationId === 'string' && !!params.resumeOperationId ? params.resumeOperationId : undefined;
        const supplied: Claim = { status: 'accepted', message: 'Original queued input retained.', operationId: resume ?? request.operationId,
            threadId: params.threadId, expectedTurnId: params.expectedTurnId,
            item: { id: params.queuedSubmissionId as string, clientUserMessageId: params.clientUserMessageId as string, input: structuredClone(params.input) as Record<string, unknown>[] } };
        return this.locked(supplied.threadId, supplied.item.id, async () => {
            let claim = await this.claims.lookup(this.identity(supplied), this.payload(supplied), validClaim);
            if (!claim) {
                if (lookup || resume) return unknown();
                for (const prior of await this.all(supplied.threadId)) if (prior.item.id === supplied.item.id) {
                    const deletion = await this.deletion(prior, true);
                    if (notAttempted(deletion) && this.unchanged(supplied.item, prior)) return unknown();
                    if (!notAttempted(deletion) && deletion.status !== 'rejected') return this.settle(prior, true);
                }
                // Match by native ID and payload. Never fall back to matching text.
                if (!this.unchanged(await this.find(supplied), supplied))
                    return { status: 'rejected', message: 'This queued message changed or has started. The original was not sent again.' };
                claim = await this.claims.run(this.identity(supplied), this.payload(supplied), { ...supplied, status: 'indeterminate' }, validClaim, async () => supplied);
            }
            // Either journal state contains the complete fsynced input. No native
            // step precedes that write; its own receipt decides whether it can run.
            return this.settle(claim, lookup);
        });
    }
    /** Read-only supplementation while the native queue transfers ownership to the running turn. */
    async project(threadId: string, rows: readonly unknown[]): Promise<unknown[]> {
        const projected = [...rows];
        const claims = await this.all(threadId);
        for (const claim of claims) {
            const native = projected.find(item => validItem(item) && item.id === claim.item.id) as QueuedInput | undefined;
            const body = await this.hasBody(claim, !this.unchanged(native, claim));
            if (body) continue;
            const deleted = await this.deletion(claim, true);
            if (deleted.status === 'rejected' && !notAttempted(deleted)) continue; // Failed acquisition leaves the real row actionable.
            if (notAttempted(deleted) && !this.unchanged(native, claim) && (native || body !== undefined)) continue;
            if (deleted.status === 'accepted' && record(deleted.result) && deleted.result.deleted === false) {
                if (body === undefined && !native) projected.push({ ...claim.item, hhpiDelivery: 'confirming' });
                continue;
            }
            const steered = deleted.status === 'accepted' ? await this.steering(claim, true) : undefined;
            let resume = notAttempted(deleted) || !!steered && notAttempted(steered);
            let failed = false;
            if (steered?.status === 'rejected') {
                const restored = await this.restoring(claim, true);
                resume ||= notAttempted(restored);
                failed = restored.status === 'rejected' && !notAttempted(restored);
                // Preserve the original-client-ID alias even when restoration has a new native queue ID.
                if (restored.status === 'accepted' && projected.some(item => validItem(item) && item.clientUserMessageId === claim.item.clientUserMessageId)) continue;
                const restoredItem = record(restored.result) ? restored.result.queuedSubmission : undefined;
                // Confirmed restoration transfers this exact row to its successor
                // claim. Directory iteration order must not resurrect the old ID.
                if (restored.status === 'accepted' && record(restoredItem) && typeof restoredItem.id === 'string'
                    && restoredItem.clientUserMessageId === claim.item.clientUserMessageId
                    && claims.some(next => next.item.id === restoredItem.id && next.item.clientUserMessageId === claim.item.clientUserMessageId)) continue;
            }
            const delivery: QueueDelivery = failed ? 'failed' : steered?.status === 'accepted' ? 'sending' : 'confirming';
            const index = projected.findIndex(item => validItem(item) && item.id === claim.item.id);
            const held = { ...claim.item, ...(resume ? { hhpiResumeOperationId: claim.operationId, hhpiResumeTurnId: claim.expectedTurnId,
                hhpiTransferHeld: deleted.status === 'accepted' } : { hhpiDelivery: delivery }) };
            if (index < 0) projected.push(held); else projected[index] = held;
        }
        return projected;
    }
}
