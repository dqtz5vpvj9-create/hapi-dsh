/** Durable write-ahead receipts: loss of acknowledgement never becomes an automatic retry. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import type { SourceCreateRequest, SourceCreationReceipt, SourceOperation, SourceReceipt } from './protocol.ts';
import { sourceSessionId, parseSourceSessionId } from './protocol.ts';
import { SourceError } from './errors.ts';

interface Outcome { status: 'accepted' | 'rejected' | 'indeterminate'; message: string; retryable?: true }
interface Stored<R> { fingerprint: string; receipt: R }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isOutcome = (value: unknown): value is Outcome => typeof value === 'object' && value !== null
    && ['accepted', 'rejected', 'indeterminate'].includes(String((value as Outcome).status)) && typeof (value as Outcome).message === 'string';

/** Shared persistence for native operations and native creation; never stores prompt bodies. */
export class ReceiptLedger<R extends Outcome> {
    private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<R> }>();
    constructor(private readonly directory: string, private readonly persistReceipt: (receipt: R) => R = receipt => receipt) {}
    /** Read only the durable snapshot, including while this operation is running.
     * Never joins its promise, takes its lock, reconciles or dispatches a write. */
    stored(identity: readonly string[], payload: unknown, valid: (value: unknown) => value is R): Promise<R | null> {
        return this.read(hash(identity), hash(payload), valid);
    }
    /** Lookup never installs an uncertainty marker and never invokes execute. */
    async lookup(identity: readonly string[], payload: unknown, valid: (value: unknown) => value is R,
        reconcile?: (receipt: R) => Promise<R | undefined>): Promise<R | null> {
        const key = hash(identity), fingerprint = hash(payload), active = this.inFlight.get(key);
        if (active) {
            if (active.fingerprint !== fingerprint) throw new SourceError('INVALID_REQUEST', 'An operation ID was reused with different arguments.');
            return active.promise;
        }
        const initial = await this.read(key, fingerprint, valid);
        if (!initial || initial.status !== 'indeterminate' || !reconcile) return initial;
        return withFileLock(join(this.directory, key), async () => {
            const prior = await this.read(key, fingerprint, valid);
            if (!prior || prior.status !== 'indeterminate') return prior;
            const confirmed = await reconcile(prior).catch(() => undefined);
            if (!confirmed) return prior;
            if (!valid(confirmed) || confirmed.status !== 'accepted') throw new SourceError('OUTCOME_UNKNOWN', 'Native history did not confirm this operation identity.');
            try { await this.store(key, { fingerprint, receipt: confirmed }); } catch { return prior; }
            return confirmed;
        }, { waitMs: 65_000 });
    }
    private async read(key: string, fingerprint: string, valid: (value: unknown) => value is R): Promise<R | null> {
        let stored: Stored<unknown>;
        try { stored = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')) as Stored<unknown>; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new SourceError('TARGET_UNAVAILABLE', 'The durable operation receipt cannot be read. Nothing was sent.'); }
        if (typeof stored.fingerprint !== 'string' || !valid(stored.receipt)) throw new SourceError('TARGET_UNAVAILABLE', 'The stored receipt is invalid. Nothing was sent.');
        if (stored.fingerprint !== fingerprint) throw new SourceError('INVALID_REQUEST', 'An operation ID was reused with different arguments.');
        return stored.receipt;
    }
    run(identity: readonly string[], payload: unknown, uncertain: R, valid: (value: unknown) => value is R, execute: () => Promise<R>, recovery?: {
        retry(receipt: R): boolean;
        reconcile(receipt: R): Promise<R | undefined>;
    }): Promise<R> {
        const key = hash(identity), fingerprint = hash(payload), active = this.inFlight.get(key);
        if (active) return active.fingerprint === fingerprint ? active.promise : Promise.reject(new SourceError('INVALID_REQUEST', 'An operation ID was reused with different arguments.'));
        const promise = mkdir(this.directory, { recursive: true, mode: 0o700 })
            .then(() => withFileLock(join(this.directory, key), () => this.perform(key, fingerprint, uncertain, valid, execute, recovery), { waitMs: 65_000 }))
            .finally(() => { if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key); });
        this.inFlight.set(key, { fingerprint, promise }); return promise;
    }
    private async store(key: string, record: Stored<R>): Promise<void> {
        const path = join(this.directory, `${key}.json`), temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify({ ...record, receipt: this.persistReceipt(record.receipt) })}\n`, { mode: 0o600, flag: 'wx', flush: true });
            await rename(temporary, path);
            if (process.platform !== 'win32') { const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
        } finally { await rm(temporary, { force: true }); }
    }
    private async perform(key: string, fingerprint: string, uncertain: R, valid: (value: unknown) => value is R, execute: () => Promise<R>, recovery?: {
        retry(receipt: R): boolean;
        reconcile(receipt: R): Promise<R | undefined>;
    }): Promise<R> {
        let prior: Stored<unknown> | undefined;
        try { prior = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')) as Stored<unknown>; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SourceError('TARGET_UNAVAILABLE', 'The durable operation receipt cannot be read. Nothing was sent.'); }
        if (prior) {
            if (typeof prior.fingerprint !== 'string' || !valid(prior.receipt)) throw new SourceError('TARGET_UNAVAILABLE', 'The stored receipt is invalid. Nothing was sent.');
            if (prior.fingerprint !== fingerprint) throw new SourceError('INVALID_REQUEST', 'An operation ID was reused with different arguments.');
            if (!recovery?.retry(prior.receipt)) {
                // Correlation reads may prove acceptance. A failed or absent
                // correlation never authorizes replay of a possibly sent write.
                const confirmed = prior.receipt.status === 'indeterminate' ? await recovery?.reconcile(prior.receipt).catch(() => undefined) : undefined;
                if (!confirmed) return prior.receipt;
                if (!valid(confirmed) || confirmed.status !== 'accepted') throw new SourceError('OUTCOME_UNKNOWN', 'Native history did not confirm this operation identity.');
                try { await this.store(key, { fingerprint, receipt: confirmed }); } catch { return prior.receipt; }
                return confirmed;
            }
        }
        // This fsynced uncertainty marker exists before the first external side effect.
        await this.store(key, { fingerprint, receipt: uncertain });
        let receipt: R;
        try { receipt = await execute(); }
        catch (error) {
            receipt = error instanceof SourceError && (error.delivery === 'not-dispatched' || ['INVALID_REQUEST', 'UNSUPPORTED'].includes(error.code))
                ? { ...uncertain, status: 'rejected', message: error.message, ...(error.delivery === 'not-dispatched' && recovery ? { retryable: true as const } : {}) } : uncertain;
        }
        if (!valid(receipt)) throw new SourceError('OUTCOME_UNKNOWN', 'The native source returned a receipt for a different operation.');
        try { await this.store(key, { fingerprint, receipt }); } catch { return uncertain; }
        return receipt;
    }
}
export class OperationLedger {
    private readonly receipts: ReceiptLedger<SourceReceipt>;
    constructor(directory: string) { this.receipts = new ReceiptLedger(directory); }
    private payload(operation: SourceOperation): unknown {
        return [operation.kind, operation.text ?? null, operation.turnId ?? null, operation.requestId ?? null, operation.decision ?? null, ...(operation.response === undefined ? [] : [operation.response]), ...(operation.images === undefined ? [] : [operation.images]), ...(operation.files === undefined ? [] : [operation.files])];
    }
    private valid(operation: SourceOperation, value: unknown): value is SourceReceipt {
        if (!isOutcome(value) || (value as SourceReceipt).operationId !== operation.operationId || (value as SourceReceipt).sessionId !== operation.sessionId) return false;
        const receipt = value as SourceReceipt;
        return (receipt.retryable === undefined || receipt.retryable === true && receipt.status === 'rejected')
            && (receipt.ownerAdmission === undefined || receipt.status === 'accepted' && receipt.ownerAdmission.localId === operation.operationId
                && ['queued', 'dispatching', 'indeterminate', 'consumed'].includes(receipt.ownerAdmission.state))
            && (receipt.observed === undefined || receipt.status === 'accepted' && typeof receipt.observed.epoch === 'string'
                && Number.isSafeInteger(receipt.observed.seq) && receipt.observed.seq >= 0);
    }
    lookup(operation: SourceOperation, reconcile?: (receipt: SourceReceipt) => Promise<SourceReceipt | undefined>): Promise<SourceReceipt | null> {
        return this.receipts.lookup([operation.sessionId, operation.operationId], this.payload(operation),
            (value): value is SourceReceipt => this.valid(operation, value), reconcile);
    }
    stored(operation: SourceOperation): Promise<SourceReceipt | null> {
        return this.receipts.stored([operation.sessionId, operation.operationId], this.payload(operation),
            (value): value is SourceReceipt => this.valid(operation, value));
    }
    run(operation: SourceOperation, execute: () => Promise<SourceReceipt>, reconcile?: (receipt: SourceReceipt) => Promise<SourceReceipt | undefined>): Promise<SourceReceipt> {
        const uncertain: SourceReceipt = { operationId: operation.operationId, sessionId: operation.sessionId, status: 'indeterminate', message: 'The source operation may have been dispatched. It will not be retried automatically.' };
        return this.receipts.run([operation.sessionId, operation.operationId],
            this.payload(operation), uncertain,
            (value): value is SourceReceipt => this.valid(operation, value),
            execute, { retry: receipt => receipt.status === 'rejected' && receipt.retryable === true,
                reconcile: receipt => receipt.status === 'indeterminate' && reconcile ? reconcile(receipt) : Promise.resolve(undefined) });
    }
}
export class CreationLedger {
    private readonly receipts: ReceiptLedger<SourceCreationReceipt>;
    private protectionRead: Promise<{ targets: Set<string>; unknown: boolean }> | undefined;
    private readonly created = new Set<string>();
    private creating = 0;
    constructor(private readonly directory: string, private readonly sourceScope: string, private readonly operationDirectories: readonly string[] = []) {
        this.receipts = new ReceiptLedger(directory, receipt => {
            if (!receipt.session) return receipt;
            // A durable creation receipt is a target correlation, not a saved
            // source snapshot. The adapter re-reads that exact native identity
            // before publishing a restarted receipt through the v1 wire.
            const { id, machineId, sourceId, engine, nativeId } = receipt.session;
            return { ...receipt, session: { id, machineId, sourceId, engine, nativeId } as NonNullable<SourceCreationReceipt['session']> };
        });
    }
    invalidateProtection(): void { this.protectionRead = undefined; }
    protectTarget(nativeId: string): void { this.created.add(nativeId); }
    /** Failed/uncertain creation storage is protection, never deletion authority. */
    async protection(): Promise<{ targets: ReadonlySet<string>; unknown: boolean }> {
        this.protectionRead ??= (async () => {
            const targets = new Set<string>(); let unknown = false;
            for (const directory of [this.directory, ...this.operationDirectories]) {
            let files: string[];
            try { files = await readdir(directory); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unknown = true; continue; }
            if (files.length > 10_000) return { targets, unknown: true };
            for (const file of files) {
                if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
                try {
                    const stored = JSON.parse(await readFile(join(directory, file), 'utf8')) as Stored<SourceCreationReceipt & Partial<SourceReceipt> & { result?: { thread?: { id?: string } } }>;
                    if (!isOutcome(stored.receipt)) { unknown = true; continue; }
                    const receipt = stored.receipt;
                    if (receipt.status === 'indeterminate') unknown = true;
                    const session = receipt.session;
                    if (session && sourceSessionId(session) === session.id
                        && JSON.stringify([session.machineId, session.sourceId, session.engine]) === this.sourceScope) targets.add(session.nativeId);
                    if (receipt.sessionId) {
                        const identity = parseSourceSessionId(receipt.sessionId);
                        if (JSON.stringify([identity.machineId, identity.sourceId, identity.engine]) === this.sourceScope) targets.add(identity.nativeId);
                    }
                    if (typeof receipt.result?.thread?.id === 'string') targets.add(receipt.result.thread.id);
                } catch { unknown = true; }
            }
            }
            return { targets, unknown };
        })();
        const saved = await this.protectionRead;
        return { targets: new Set([...saved.targets, ...this.created]), unknown: saved.unknown || this.creating > 0 };
    }
    async run(request: SourceCreateRequest, execute: () => Promise<SourceCreationReceipt>): Promise<SourceCreationReceipt> {
        const uncertain: SourceCreationReceipt = { operationId: request.operationId, sourceId: request.sourceId, status: 'indeterminate', message: 'Native thread creation may have succeeded. It will not be retried automatically; refresh the source catalog.' };
        this.creating++;
        try {
        const receipt = await this.receipts.run([this.sourceScope, request.operationId], [request.sourceId, request.cwd ?? null], uncertain,
            (value): value is SourceCreationReceipt => isOutcome(value) && (value as SourceCreationReceipt).operationId === request.operationId
                && (value as SourceCreationReceipt).sourceId === request.sourceId
                && (value.status !== 'accepted' || typeof (value as SourceCreationReceipt).session?.id === 'string'
                    && (value as SourceCreationReceipt).session?.sourceId === request.sourceId
                    && sourceSessionId((value as SourceCreationReceipt).session!) === (value as SourceCreationReceipt).session!.id), execute);
        if (receipt.session) this.created.add(receipt.session.nativeId);
        if (receipt.status === 'indeterminate') this.protectionRead = Promise.resolve({ targets: new Set(this.created), unknown: true });
        return receipt;
        } finally { this.creating--; }
    }
}
