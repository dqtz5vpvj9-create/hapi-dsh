/** Durable binary transfers owned by the source OS; a status query never commits a file. */
import { SOURCE_UPLOAD_CHUNK_BYTES } from '../shared/source-upload.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { workspaceUploadStartSchema, workspaceUploadRequestSchema, workspaceUploadChunkSchema,
    type WorkspaceUploadStart, type WorkspaceUploadRequest } from '../workbench-types.ts';
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceMutationResult, WorkspaceUploadReceipt,
    WorkspaceUploadService, WorkspaceUploadStatus, WorkspaceUploadTransfer } from './service-types.ts';

type Result = WorkspaceMutationResult<WorkspaceUploadReceipt>;
interface Row { id: string; scope: string; binding: string; request: string; received: number; state: 'uploading' | 'committing' | 'finished' | 'cancelled'; result: string | null }
export interface SourceUploadOptions {
    directory: string;
    signal: AbortSignal;
    maxBytes?: number;
    chunkBytes?: number;
    receipt?(binding: WorkspaceBinding, request: WorkspaceUploadStart, access: WorkspaceAccess): Promise<Result | null>;
    commit(binding: WorkspaceBinding, request: WorkspaceUploadStart, path: string, access: WorkspaceAccess): Promise<Result>;
}
export class SourceUploads {
    private readonly db: DatabaseSync;
    private readonly maxBytes: number;
    private readonly chunkBytes: number;
    private readonly controller = new AbortController();
    private readonly signal: AbortSignal;
    private readonly pending = new Set<Promise<unknown>>();
    private closing?: Promise<void>;
    constructor(private readonly options: SourceUploadOptions) {
        options.signal.throwIfAborted();
        this.signal = AbortSignal.any([options.signal, this.controller.signal]);
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        const database = join(options.directory, 'transfers.sqlite');
        this.db = new DatabaseSync(database); chmodSync(database, 0o600);
        this.db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY, scope TEXT NOT NULL, binding TEXT NOT NULL,
                operation TEXT NOT NULL, request TEXT NOT NULL, received INTEGER NOT NULL, state TEXT NOT NULL, result TEXT,
                UNIQUE(scope,binding,operation));`);
        this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
        this.chunkBytes = options.chunkBytes ?? SOURCE_UPLOAD_CHUNK_BYTES;
    }
    private path(id: string) { return join(this.options.directory, `${id}.bin`); }
    private async check(binding: WorkspaceBinding, access: WorkspaceAccess) {
        this.signal.throwIfAborted(); access.signal.throwIfAborted(); await access.assertAllowed(binding.target, 'upload');
    }
    private read(binding: WorkspaceBinding, request: WorkspaceUploadRequest, access: WorkspaceAccess): Row {
        workspaceUploadRequestSchema.parse({ target: request.target, uploadId: request.uploadId });
        if (request.target.hostId !== binding.target.hostId || request.target.sessionId !== binding.target.sessionId) throw new Error('The upload names another source.');
        const row = this.db.prepare('SELECT * FROM transfers WHERE id=? AND scope=? AND binding=?')
            .get(request.uploadId, access.scope, JSON.stringify(binding)) as unknown as Row | undefined;
        if (!row) throw new Error('The original upload is unavailable in this source account.');
        return row;
    }
    private transfer(row: Row): WorkspaceUploadTransfer {
        const request = JSON.parse(row.request) as WorkspaceUploadStart;
        return { uploadId: row.id, target: request.target, operationId: request.operationId, destination: request.destination,
            bytes: request.bytes, receivedBytes: row.received, maxBytes: this.maxBytes, chunkBytes: this.chunkBytes };
    }
    private statusOf(row: Row): WorkspaceUploadStatus {
        if (row.state === 'cancelled') return { state: 'cancelled' };
        if (row.state === 'uploading') return { state: 'uploading', transfer: this.transfer(row) };
        return { state: 'finished', result: row.result ? JSON.parse(row.result) as Result
            : { status: 'indeterminate', operationId: (JSON.parse(row.request) as WorkspaceUploadStart).operationId } };
    }
    private async reconcile(binding: WorkspaceBinding, row: Row, access: WorkspaceAccess): Promise<WorkspaceUploadStatus> {
        const status = this.statusOf(row);
        if (status.state !== 'finished' || status.result.status !== 'indeterminate' || !this.options.receipt) return status;
        const result = await this.options.receipt(binding, JSON.parse(row.request) as WorkspaceUploadStart, access);
        await this.check(binding, access);
        if (!result || result.status === 'indeterminate') return status;
        this.db.prepare('UPDATE transfers SET state=\'finished\',result=? WHERE id=?').run(JSON.stringify(result), row.id);
        if (result.status === 'applied') await rm(this.path(row.id), { force: true });
        return { state: 'finished', result };
    }
    private async track<T>(run: () => Promise<T>): Promise<T> {
        this.signal.throwIfAborted();
        const promise = run(); this.pending.add(promise);
        void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
        return promise;
    }
    workspace(binding: WorkspaceBinding): WorkspaceUploadService {
        const service = this.service(binding);
        return {
            begin: (...args) => this.track(() => service.begin(...args)),
            append: (...args) => this.track(() => service.append(...args)),
            status: (...args) => this.track(() => service.status(...args)),
            finish: (...args) => this.track(() => service.finish(...args)),
            cancel: (...args) => this.track(() => service.cancel(...args)),
        };
    }
    private service(binding: WorkspaceBinding): WorkspaceUploadService {
        return {
            begin: async (raw, access) => {
                const request = workspaceUploadStartSchema.parse(raw); await this.check(binding, access);
                if (request.destination.kind === 'attachment' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.operationId)) throw new Error('Invalid attachment upload identity.');
                if (request.target.hostId !== binding.target.hostId || request.target.sessionId !== binding.target.sessionId) throw new Error('The upload names another source.');
                if (request.bytes > this.maxBytes) throw new Error(`This source accepts files up to ${Math.floor(this.maxBytes / 1024 / 1024)} MiB. The original file is kept.`);
                const key = JSON.stringify(binding), encoded = JSON.stringify(request), id = randomUUID();
                this.db.prepare('INSERT OR IGNORE INTO transfers VALUES(?,?,?,?,?,0,\'uploading\',NULL)')
                    .run(id, access.scope, key, request.operationId, encoded);
                const row = this.db.prepare('SELECT * FROM transfers WHERE scope=? AND binding=? AND operation=?')
                    .get(access.scope, key, request.operationId) as unknown as Row;
                if (row.request !== encoded) throw new Error('This upload identity already names another file.');
                return this.transfer(row);
            },
            append: async (raw, access) => {
                const request = workspaceUploadChunkSchema.parse(raw); await this.check(binding, access);
                const initial = this.read(binding, request, access);
                return withFileLock(this.path(initial.id), async () => {
                    const row = this.read(binding, request, access), transfer = this.transfer(row);
                    await this.check(binding, access);
                    if (row.state !== 'uploading' || request.offset !== row.received) throw new Error('Read the original upload status before resuming its bytes.');
                    if (!request.data.length || request.data.length > this.chunkBytes || row.received + request.data.length > transfer.bytes) throw new Error('The upload chunk exceeds its declared transfer.');
                    const file = await open(this.path(row.id), row.received === 0 ? 'w' : 'r+', 0o600);
                    try {
                        // A crash after write but before receipt leaves unacknowledged bytes.
                        // Overwrite only from the durable offset; never append them twice.
                        await file.truncate(row.received);
                        let offset = 0;
                        while (offset < request.data.length) {
                            await this.check(binding, access);
                            const written = await file.write(request.data, offset, request.data.length - offset, row.received + offset);
                            offset += written.bytesWritten;
                        }
                        await file.sync(); await this.check(binding, access);
                        const receivedBytes = row.received + request.data.length;
                        this.db.prepare('UPDATE transfers SET received=? WHERE id=?').run(receivedBytes, row.id);
                        return { receivedBytes };
                    } finally { await file.close(); }
                }, { signal: AbortSignal.any([access.signal, this.signal]) });
            },
            status: async (request, access) => { await this.check(binding, access); return this.reconcile(binding, this.read(binding, request, access), access); },
            finish: async (request, access) => {
                await this.check(binding, access); const initial = this.read(binding, request, access);
                return withFileLock(this.path(initial.id), async () => {
                    const row = this.read(binding, request, access), start = JSON.parse(row.request) as WorkspaceUploadStart;
                    await this.check(binding, access);
                    const status = await this.reconcile(binding, row, access);
                    if (status.state === 'finished') return status.result;
                    if (status.state === 'cancelled') throw new Error('The upload was cancelled.');
                    if (row.received !== start.bytes) throw new Error('The file has not finished uploading.');
                    if (!start.bytes) { const file = await open(this.path(row.id), 'w', 0o600); await file.close(); }
                    const unknown: Result = { status: 'indeterminate', operationId: start.operationId };
                    this.db.prepare('UPDATE transfers SET state=\'committing\',result=? WHERE id=?').run(JSON.stringify(unknown), row.id);
                    let result: Result;
                    try { result = await this.options.commit(binding, start, this.path(row.id), access); }
                    catch { result = unknown; }
                    this.db.prepare('UPDATE transfers SET state=\'finished\',result=? WHERE id=?').run(JSON.stringify(result), row.id);
                    await this.check(binding, access);
                    if (result.status === 'applied') await rm(this.path(row.id), { force: true });
                    return result;
                }, { signal: AbortSignal.any([access.signal, this.signal]) });
            },
            cancel: async (request, access) => {
                await this.check(binding, access); const initial = this.read(binding, request, access);
                return withFileLock(this.path(initial.id), async () => {
                    const row = this.read(binding, request, access); await this.check(binding, access);
                    if (row.state !== 'uploading') return this.statusOf(row);
                    this.db.prepare('UPDATE transfers SET state=\'cancelled\' WHERE id=?').run(row.id);
                    await rm(this.path(row.id), { force: true }); return { state: 'cancelled' };
                }, { signal: AbortSignal.any([access.signal, this.signal]) });
            },
        };
    }
    close(): Promise<void> {
        return this.closing ??= (async () => {
            this.controller.abort(); await Promise.allSettled([...this.pending]); this.db.close();
        })();
    }
}
