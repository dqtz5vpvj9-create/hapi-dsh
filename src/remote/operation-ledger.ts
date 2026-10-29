/** Durable write-ahead receipts: loss of acknowledgement never becomes an automatic retry. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import type { SourceCreateRequest, SourceCreationReceipt, SourceOperation, SourceReceipt } from './protocol.ts';
import { SourceError } from './errors.ts';

interface Outcome { status: 'accepted' | 'rejected' | 'indeterminate'; message: string }
interface Stored<R> { fingerprint: string; receipt: R }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isOutcome = (value: unknown): value is Outcome => typeof value === 'object' && value !== null
    && ['accepted', 'rejected', 'indeterminate'].includes(String((value as Outcome).status)) && typeof (value as Outcome).message === 'string';

/** Shared persistence for native operations and native creation; never stores prompt bodies. */
class ReceiptLedger<R extends Outcome> {
    private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<R> }>();
    constructor(private readonly directory: string) {}
    run(identity: readonly string[], payload: unknown, uncertain: R, valid: (value: unknown) => value is R, execute: () => Promise<R>): Promise<R> {
        const key = hash(identity), fingerprint = hash(payload), active = this.inFlight.get(key);
        if (active) return active.fingerprint === fingerprint ? active.promise : Promise.reject(new SourceError('INVALID_REQUEST', 'An operation ID was reused with different arguments.'));
        const promise = mkdir(this.directory, { recursive: true, mode: 0o700 })
            .then(() => withFileLock(join(this.directory, key), () => this.perform(key, fingerprint, uncertain, valid, execute), { waitMs: 65_000 }))
            .finally(() => { if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key); });
        this.inFlight.set(key, { fingerprint, promise }); return promise;
    }
    private async store(key: string, record: Stored<R>): Promise<void> {
        const path = join(this.directory, `${key}.json`), temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx', flush: true });
            await rename(temporary, path);
            if (process.platform !== 'win32') { const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
        } finally { await rm(temporary, { force: true }); }
    }
    private async perform(key: string, fingerprint: string, uncertain: R, valid: (value: unknown) => value is R, execute: () => Promise<R>): Promise<R> {
        let prior: Stored<unknown> | undefined;
        try { prior = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')) as Stored<unknown>; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SourceError('TARGET_UNAVAILABLE', 'The durable operation receipt cannot be read. Nothing was sent.'); }
        if (prior) {
            if (typeof prior.fingerprint !== 'string' || !valid(prior.receipt)) throw new SourceError('TARGET_UNAVAILABLE', 'The stored receipt is invalid. Nothing was sent.');
            if (prior.fingerprint !== fingerprint) throw new SourceError('INVALID_REQUEST', 'An operation ID was reused with different arguments.');
            return prior.receipt;
        }
        // This fsynced uncertainty marker exists before the first external side effect.
        await this.store(key, { fingerprint, receipt: uncertain });
        let receipt: R;
        try { receipt = await execute(); }
        catch (error) {
            receipt = error instanceof SourceError && ['INVALID_REQUEST', 'UNSUPPORTED', 'TARGET_UNAVAILABLE', 'CAPACITY_EXCEEDED'].includes(error.code)
                ? { ...uncertain, status: 'rejected', message: error.message } : uncertain;
        }
        if (!valid(receipt)) throw new SourceError('OUTCOME_UNKNOWN', 'The native source returned a receipt for a different operation.');
        try { await this.store(key, { fingerprint, receipt }); } catch { return uncertain; }
        return receipt;
    }
}
export class OperationLedger {
    private readonly receipts: ReceiptLedger<SourceReceipt>;
    constructor(directory: string) { this.receipts = new ReceiptLedger(directory); }
    run(operation: SourceOperation, execute: () => Promise<SourceReceipt>): Promise<SourceReceipt> {
        const uncertain: SourceReceipt = { operationId: operation.operationId, sessionId: operation.sessionId, status: 'indeterminate', message: 'The source operation may have been dispatched. It will not be retried automatically.' };
        return this.receipts.run([operation.sessionId, operation.operationId],
            [operation.kind, operation.text ?? null, operation.turnId ?? null, operation.requestId ?? null, operation.decision ?? null], uncertain,
            (value): value is SourceReceipt => isOutcome(value) && (value as SourceReceipt).operationId === operation.operationId && (value as SourceReceipt).sessionId === operation.sessionId,
            execute);
    }
}
export class CreationLedger {
    private readonly receipts: ReceiptLedger<SourceCreationReceipt>;
    constructor(directory: string, private readonly sourceScope: string) { this.receipts = new ReceiptLedger(directory); }
    run(request: SourceCreateRequest, execute: () => Promise<SourceCreationReceipt>): Promise<SourceCreationReceipt> {
        const uncertain: SourceCreationReceipt = { operationId: request.operationId, sourceId: request.sourceId, status: 'indeterminate', message: 'Native thread creation may have succeeded. It will not be retried automatically; refresh the source catalog.' };
        return this.receipts.run([this.sourceScope, request.operationId], [request.sourceId, request.cwd ?? null], uncertain,
            (value): value is SourceCreationReceipt => isOutcome(value) && (value as SourceCreationReceipt).operationId === request.operationId
                && (value as SourceCreationReceipt).sourceId === request.sourceId
                && (value.status !== 'accepted' || typeof (value as SourceCreationReceipt).session?.id === 'string'), execute);
    }
}
