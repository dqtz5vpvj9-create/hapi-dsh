/** Durable write-ahead receipts: loss of acknowledgement never becomes an automatic retry. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import type { SourceOperation, SourceReceipt } from './protocol.ts';
import { SourceError } from './errors.ts';

interface Stored { fingerprint: string; receipt: SourceReceipt }
export class OperationLedger {
    private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<SourceReceipt> }>();
    constructor(private readonly directory: string) {}
    run(operation: SourceOperation, execute: () => Promise<SourceReceipt>): Promise<SourceReceipt> {
        const key = createHash('sha256').update(JSON.stringify([operation.sessionId, operation.operationId])).digest('hex');
        const fingerprint = createHash('sha256').update(JSON.stringify([operation.kind, operation.text ?? null, operation.turnId ?? null, operation.requestId ?? null, operation.decision ?? null])).digest('hex');
        const active = this.inFlight.get(key);
        if (active) return active.fingerprint === fingerprint ? active.promise : Promise.reject(new SourceError('INVALID_REQUEST', 'An operation ID was reused with different arguments.'));
        const promise = mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => withFileLock(join(this.directory, key), () => this.perform(key, fingerprint, operation, execute), { waitMs: 65_000 })).finally(() => { this.inFlight.delete(key); });
        this.inFlight.set(key, { fingerprint, promise });
        return promise;
    }
    private async store(key: string, record: Stored): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = join(this.directory, `${key}.json`), temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx', flush: true }); await rename(temporary, path); }
        finally { await rm(temporary, { force: true }); }
    }
    private async perform(key: string, fingerprint: string, operation: SourceOperation, execute: () => Promise<SourceReceipt>): Promise<SourceReceipt> {
        let prior: Stored | undefined;
        try { prior = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')) as Stored; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SourceError('TARGET_UNAVAILABLE', 'The durable operation receipt cannot be read. Nothing was sent.'); }
        if (prior) {
            if (typeof prior.fingerprint !== 'string' || !prior.receipt || prior.receipt.operationId !== operation.operationId || prior.receipt.sessionId !== operation.sessionId
                || !['accepted', 'rejected', 'indeterminate'].includes(prior.receipt.status) || typeof prior.receipt.message !== 'string') {
                throw new SourceError('TARGET_UNAVAILABLE', 'The stored receipt is invalid. Nothing was sent.');
            }
            if (prior.fingerprint !== fingerprint) throw new SourceError('INVALID_REQUEST', 'An operation ID was reused with different arguments.');
            return prior.receipt;
        }
        const uncertain: SourceReceipt = { operationId: operation.operationId, sessionId: operation.sessionId, status: 'indeterminate', message: 'The source operation may have been dispatched. It will not be retried automatically.' };
        await this.store(key, { fingerprint, receipt: uncertain });
        let receipt: SourceReceipt;
        try { receipt = await execute(); }
        catch (error) {
            receipt = error instanceof SourceError && ['INVALID_REQUEST', 'UNSUPPORTED', 'TARGET_UNAVAILABLE'].includes(error.code)
                ? { ...uncertain, status: 'rejected', message: error.message } : uncertain;
        }
        if (receipt.operationId !== operation.operationId || receipt.sessionId !== operation.sessionId) throw new SourceError('OUTCOME_UNKNOWN', 'The source returned a receipt for a different operation.');
        try { await this.store(key, { fingerprint, receipt }); }
        catch { return uncertain; }
        return receipt;
    }
}
