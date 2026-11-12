/** Source-local OS file services. This owner is installed on the source, never the display Host. */
import { Context } from '@deepseek-ai/cordis';
import WorkspaceFiles from '@deepseek-ai/dsh-api-workspace-files';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import { FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-remote-access/types';
import { execFile } from 'node:child_process';
import { constants, chmodSync, mkdirSync } from 'node:fs';
import { access as canAccess, copyFile, lstat, mkdir, open, readFile, readlink, readdir, rm, rmdir, symlink } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { MAX_DOCUMENT_BYTES, MAX_EDITABLE_BYTES, workspaceFileManageRequestSchema, workspaceFileSaveRequestSchema,
    type WorkspaceUploadStart, type WorkspaceDocumentRef, type WorkspaceFileBaseline, type WorkspaceFileManageRequest, type WorkspaceFileSaveRequest } from '../workbench-types.ts';
import type { WorkspaceAccess, WorkspaceAction, WorkspaceBinding, WorkspaceDocument, WorkspaceEntry,
    WorkspaceMutationResult, WorkspaceServices } from './service-types.ts';

type Value = Awaited<ReturnType<WorkspaceServices['files']['stat']>> | WorkspaceEntry | null;
type Result = WorkspaceMutationResult<Value>;
type FileUploadCommit = { target: WorkspaceBinding['target']; operationId: string; path: string; baseline: WorkspaceFileBaseline; bytes: number };
class Conflict extends Error { constructor(readonly currentVersion: string | null) { super('The source entry changed.'); } }
class Rejected extends Error { constructor(readonly code: 'denied' | 'not-found' | 'invalid' | 'too-large' | 'unsupported', message: string) { super(message); } }
const exec = promisify(execFile);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const sameTarget = (a: WorkspaceBinding['target'], b: WorkspaceBinding['target']) => a.hostId === b.hostId && a.sessionId === b.sessionId;
const mimeTypes: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
    json: 'application/json', csv: 'text/csv', md: 'text/markdown', html: 'text/html' };
const textExtensions = new Set('txt md mdx csv tsv json jsonl yaml yml toml ini conf log html htm xml svg css scss js jsx ts tsx mjs cjs py rs go java kt c h cc cpp hpp sh bash zsh fish sql rb php swift vue svelte tex r ipynb gitignore env lock'.split(' '));
const binaryExtensions = new Set('pdf doc docx xls xlsx ppt pptx zip gz tar 7z rar wasm exe'.split(' '));
function decodeDocument(data: Uint8Array, name: string, mime: string): Pick<WorkspaceDocument, 'text' | 'format'> {
    const extension = extname(name).slice(1).toLowerCase();
    if (data.byteLength > MAX_EDITABLE_BYTES || data.includes(0) || binaryExtensions.has(extension)
        || !textExtensions.has(extension) && /^(image|audio|video)\//.test(mime)) return { text: null };
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        return { text: text.replaceAll('\r\n', '\n'), format: { bom: data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf,
            eol: text.includes('\r\n') ? '\r\n' : '\n' } };
    } catch { return { text: null }; }
}

export interface LocalSourceFileOptions {
    /** Private, durable source-side receipt database; never a workspace-controlled path. */
    database: string;
    signal: AbortSignal;
    readLimits?: Partial<{ maxBytes: number; maxFileBytes: number; maxLines: number; maxEntries: number }>;
    /** Bound recursive management work and filename search. */
    maxEntries?: number;
    maxCopyBytes?: number;
}

/** One real source execution world. Reads reuse the pinned official provider without an Agent. */
export class LocalSourceFileOwner {
    readonly permissions = 'system-user' as const;
    private readonly ctx = new Context();
    private readonly fs = new LocalFileSystem(this.ctx, LocalFileSystem.Config({}));
    private readonly files: WorkspaceFiles;
    private readonly db: DatabaseSync;
    private readonly controller = new AbortController();
    private readonly signal: AbortSignal;
    private tail: Promise<unknown> = Promise.resolve();
    private closed = false;
    constructor(private readonly options: LocalSourceFileOptions) {
        options.signal.throwIfAborted();
        this.signal = AbortSignal.any([options.signal, this.controller.signal]);
        this.files = new WorkspaceFiles(this.ctx, WorkspaceFiles.Config({ maxBytes: 2 * 1024 * 1024, maxFileBytes: MAX_DOCUMENT_BYTES,
            maxLines: 5000, maxEntries: 2000, ...options.readLimits }));
        if (options.database !== ':memory:') mkdirSync(dirname(options.database), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(options.database);
        if (options.database !== ':memory:') chmodSync(options.database, 0o600);
        this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS source_file_receipts (
                scope TEXT NOT NULL, workspace TEXT NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL,
                result TEXT NOT NULL, PRIMARY KEY(scope,workspace,operation));`);
    }
    workspace(binding: WorkspaceBinding): WorkspaceServices {
        this.signal.throwIfAborted();
        if (binding.pathStyle !== (process.platform === 'win32' ? 'win32' : 'posix') || !binding.root || resolve(binding.root) !== binding.root) {
            throw new Rejected('invalid', 'The workspace does not belong to this source filesystem.');
        }
        const scope = { sessionId: binding.target.sessionId as SessionId, workspaceRoot: binding.root };
        const run = async <T>(action: WorkspaceAction, access: WorkspaceAccess, call: (signal: AbortSignal) => Promise<T>): Promise<T> => {
            const signal = AbortSignal.any([access.signal, this.signal]);
            await this.check(binding, action, access, signal); const value = await call(signal);
            await this.check(binding, action, access, signal); return value;
        };
        return { binding, files: {
            read: (path, range, access) => run('read', access, signal => this.files.read(scope, path, range, signal)),
            readBytes: (path, options, access) => run('read', access, signal => this.files.readBytes(scope, path, options, signal)),
            stat: (path, access) => run('read', access, signal => this.files.stat(scope, path, signal)),
            list: (path, access) => run('list', access, signal => this.files.list(scope, path, signal)),
            changes: (path, access) => this.changes(binding, path, access),
        }, documents: {
            open: (document, access) => run('read', access, signal => this.document(binding, document, access, signal)),
            bytes: (document, options, access) => run('read', access, signal => this.files.readBytes(scope, this.fileDocument(document), options, signal)),
            inspect: (path, access) => run('read', access, signal => this.inspect(binding, path, signal)),
            search: (query, limit, access) => run('read', access, signal => this.search(binding, query, limit, access, signal)),
            git: (request, access) => run('read', access, async signal => {
                const args = request.kind === 'status' ? ['status', '--short', '--untracked-files=normal']
                    : ['diff', '--no-ext-diff', '--no-textconv', ...(request.staged ? ['--cached'] : []), ...(request.kind === 'numstat' ? ['--numstat'] : [])];
                if (request.path) { await this.confined(binding, request.path, signal); args.push('--', request.path); }
                try { const result = await exec('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: binding.root, signal, maxBuffer: 512 * 1024, timeout: 10_000 });
                    return { ...result, exitCode: 0 }; }
                catch (error) { signal.throwIfAborted(); const failure = error as { code?: unknown; stdout?: string; stderr?: string };
                    if (typeof failure.code !== 'number') throw error;
                    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code }; }
            }),
        }, mutations: {
            save: (request, access) => this.mutate(binding, 'save', workspaceFileSaveRequestSchema.parse(request), access,
                (signal, touched) => this.save(binding, request, access, signal, touched)) as Promise<WorkspaceMutationResult<Awaited<ReturnType<WorkspaceServices['files']['stat']>>>>,
            manage: (request, access) => this.mutate(binding, 'manage', workspaceFileManageRequestSchema.parse(request), access,
                (signal, touched) => this.manage(binding, request, access, signal, touched)) as Promise<WorkspaceMutationResult<WorkspaceEntry | null>>,
            receipt: (operation, access) => run('read', access, async () => this.receipt(binding, operation, access)),
        } };
    }
    private async check(binding: WorkspaceBinding, action: WorkspaceAction, access: WorkspaceAccess, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        try { await access.assertAllowed(binding.target, action); }
        catch (error) {
            signal.throwIfAborted();
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            throw new RemoteError('remote-access/denied', 'Current source access was denied.', { action: `sourceWorkspace/${action}`, reason: 'no-allow' });
        }
        signal.throwIfAborted();
    }
    private async *changes(binding: WorkspaceBinding, path: string, access: WorkspaceAccess) {
        const signal = AbortSignal.any([access.signal, this.signal]); await this.check(binding, 'watch', access, signal);
        for await (const frame of this.files.changes({ sessionId: binding.target.sessionId as SessionId, workspaceRoot: binding.root }, path, signal)) {
            await this.check(binding, 'watch', access, signal); yield frame;
        }
    }
    private fileDocument(document: WorkspaceDocumentRef): string {
        if (document.kind !== 'file') throw new Rejected('unsupported', 'This source document requires its own registered artifact provider.');
        return document.path;
    }
    private async document(binding: WorkspaceBinding, document: WorkspaceDocumentRef, access: WorkspaceAccess, signal: AbortSignal): Promise<WorkspaceDocument> {
        const path = this.fileDocument(document), scope = { sessionId: binding.target.sessionId as SessionId, workspaceRoot: binding.root };
        const stat = await this.files.stat(scope, path, signal), name = basename(stat.absolutePath), extension = extname(name).slice(1).toLowerCase();
        const mimeType = mimeTypes[extension] ?? (textExtensions.has(extension) ? 'text/plain' : 'application/octet-stream');
        const size = stat.bytes ?? (await this.fs.lstat(path, { cwd: binding.root }, signal))?.size;
        if (size === undefined) throw new Rejected('not-found', 'The source document no longer exists.');
        let decoded: Pick<WorkspaceDocument, 'text' | 'format'> = { text: null };
        if (size <= MAX_EDITABLE_BYTES) {
            const bytes = await this.files.readBytes(scope, path, {}, signal);
            const current = await this.files.stat(scope, path, signal);
            if (stat.version !== bytes.version || current.version !== stat.version) throw new Conflict(current.version);
            decoded = decodeDocument(bytes.data, name, mimeType);
        }
        let writable = false;
        if (decoded.text !== null) {
            try { await this.confined(binding, path, signal); await canAccess(stat.absolutePath, constants.W_OK);
                await this.check(binding, 'save', access, signal); writable = true; } catch { signal.throwIfAborted(); }
        }
        return { resource: { target: binding.target, document }, fileName: name, mimeType, bytes: size,
            version: stat.version, writable, ...decoded };
    }
    private async inspect(binding: WorkspaceBinding, path: string, signal: AbortSignal): Promise<WorkspaceEntry | null> {
        const entry = await this.fs.lstat(path, { cwd: binding.root }, signal); if (!entry) return null;
        if (entry.type === 'other') throw new Rejected('unsupported', 'Special files are not workspace documents.');
        const target = await this.fs.resolve(path, { cwd: binding.root, signal }), absolutePath = resolve(binding.root, path);
        return { absolutePath, name: basename(absolutePath), type: entry.type, version: entry.version, bytes: entry.size ?? 0,
            ...(entry.type === 'directory' ? { entryCount: (await this.fs.listDir(target, signal)).length } : {}) };
    }
    private async confined(binding: WorkspaceBinding, path: string, signal: AbortSignal, allowRoot = false): Promise<FsTarget> {
        const root = await this.fs.resolve(binding.root, { signal }), target = await this.fs.resolve(path, { cwd: binding.root, signal });
        if (!this.fs.contains(root, target) || !allowRoot && target.targetKey === root.targetKey) throw new Rejected('denied', 'The operation must stay inside the source workspace.');
        return target;
    }
    private async search(binding: WorkspaceBinding, query: string, limit: number, access: WorkspaceAccess, signal: AbortSignal): Promise<WorkspaceEntry[]> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || query.length > 4096) throw new Rejected('invalid', 'Invalid filename search.');
        const queue = [binding.root], result: WorkspaceEntry[] = []; let visited = 0;
        while (queue.length && result.length < limit && visited < (this.options.maxEntries ?? 20_000)) {
            const directory = queue.shift()!; await this.check(binding, 'read', access, signal);
            for (const item of await readdir(directory, { withFileTypes: true })) {
                if (++visited > (this.options.maxEntries ?? 20_000)) break;
                const path = join(directory, item.name);
                if (item.isDirectory() && item.name !== '.git') queue.push(path);
                if (relative(binding.root, path).toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
                    const entry = await this.inspect(binding, path, signal); if (entry) result.push(entry); if (result.length >= limit) break;
                }
            }
        }
        return result;
    }
    private key(binding: WorkspaceBinding): string { return JSON.stringify([binding.machineId, binding.workspaceId, binding.target.hostId, binding.target.sessionId]); }
    private receipt(binding: WorkspaceBinding, operation: string, access: WorkspaceAccess): Result | null {
        const row = this.db.prepare('SELECT result FROM source_file_receipts WHERE scope=? AND workspace=? AND operation=?').get(access.scope, this.key(binding), operation);
        return row ? JSON.parse(String(row.result)) as Result : null;
    }
    private mutate(binding: WorkspaceBinding, action: 'save' | 'manage' | 'upload', request: WorkspaceFileSaveRequest | WorkspaceFileManageRequest | FileUploadCommit,
        access: WorkspaceAccess, perform: (signal: AbortSignal, touched: () => void) => Promise<Value>): Promise<Result> {
        const promise = this.tail.then(async (): Promise<Result> => {
            const signal = AbortSignal.any([this.signal, access.signal]); await this.check(binding, action, access, signal);
            if (!sameTarget(request.target, binding.target)) throw new Rejected('denied', 'The operation names another source session.');
            const key = this.key(binding), payload = JSON.stringify([action, request]);
            const existing = this.db.prepare('SELECT request,result FROM source_file_receipts WHERE scope=? AND workspace=? AND operation=?').get(access.scope, key, request.operationId);
            if (existing) {
                if (existing.request !== payload) throw new Rejected('invalid', 'This operation identity was already used with different arguments.');
                return JSON.parse(String(existing.result)) as Result;
            }
            const unknown: Result = { status: 'indeterminate', operationId: request.operationId };
            this.db.prepare('INSERT INTO source_file_receipts VALUES(?,?,?,?,?)').run(access.scope, key, request.operationId, payload, JSON.stringify(unknown));
            let touched = false, result: Result;
            try {
                const value = await perform(signal, () => { touched = true; });
                result = { status: 'applied', operationId: request.operationId, value };
            } catch (error) {
                if (touched) result = unknown;
                else if (error instanceof Conflict) result = { status: 'conflict', operationId: request.operationId, currentVersion: error.currentVersion };
                else if (error instanceof Rejected) result = { status: 'rejected', operationId: request.operationId, code: error.code, message: error.message };
                else if (codeOf(error) === 'EEXIST' || codeOf(error) === 'FS_NOT_OBSERVED') result = { status: 'conflict', operationId: request.operationId, currentVersion: null };
                else if (missing(error)) result = { status: 'rejected', operationId: request.operationId, code: 'not-found', message: 'The source entry no longer exists.' };
                else if (['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_NOT_OBSERVED_MISSING'].includes(codeOf(error) ?? '')) {
                    const path = 'path' in request ? request.path : request.operation.path;
                    const current = await this.fs.lstat(path, { cwd: binding.root }, signal).catch(() => undefined);
                    result = { status: 'conflict', operationId: request.operationId, currentVersion: current?.version ?? null };
                }
                else if (['EACCES', 'EPERM', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(codeOf(error) ?? '') || error instanceof RemoteError && error.code === 'remote-access/denied') result = {
                    status: 'rejected', operationId: request.operationId, code: 'denied', message: 'The source did not allow this operation.' };
                else if (['ENOTEMPTY', 'EISDIR', 'ENOTDIR', 'FS_NOT_REGULAR_FILE'].includes(codeOf(error) ?? '')) result = {
                    status: 'rejected', operationId: request.operationId, code: 'invalid', message: 'This operation does not apply to the current source entry.' };
                else result = unknown;
            }
            this.db.prepare('UPDATE source_file_receipts SET result=? WHERE scope=? AND workspace=? AND operation=?').run(JSON.stringify(result), access.scope, key, request.operationId);
            await this.check(binding, action, access, signal); return result;
        });
        this.tail = promise.catch(() => {}); return promise;
    }
    private async baseline(binding: WorkspaceBinding, path: string, baseline: WorkspaceFileBaseline, signal: AbortSignal): Promise<void> {
        const info = await this.fs.lstat(path, { cwd: binding.root }, signal);
        if (baseline.kind === 'absent' ? !!info : !info || info.version !== baseline.version) throw new Conflict(info?.version ?? null);
        if (info && info.type !== 'file') throw new Rejected('invalid', 'Only regular files can be saved.');
    }
    /** Source-local binary publication shares official atomic writes and the file mutation ledger. */
    async commitUpload(binding: WorkspaceBinding, request: WorkspaceUploadStart, path: string, access: WorkspaceAccess): Promise<WorkspaceMutationResult<Awaited<ReturnType<WorkspaceServices['files']['stat']>>>> {
        if (request.destination.kind !== 'file') throw new Rejected('invalid', 'The upload does not name a workspace file.');
        const mutation: FileUploadCommit = { target: request.target, operationId: request.operationId, path: request.destination.path,
            baseline: request.destination.baseline, bytes: request.bytes };
        return this.mutate(binding, 'upload', mutation, access, async (signal, touched) => {
            const target = await this.confined(binding, mutation.path, signal);
            await this.baseline(binding, mutation.path, mutation.baseline, signal);
            const data = await readFile(path, { signal });
            if (data.length !== mutation.bytes) throw new Rejected('invalid', 'The saved upload is incomplete.');
            const checkpoint = async () => { await this.baseline(binding, mutation.path, mutation.baseline, signal);
                await this.confined(binding, mutation.path, signal); await this.check(binding, 'upload', access, signal); };
            await this.fs.writeBytes(target, data, mutation.baseline.kind === 'absent' ? { kind: 'createIfAbsent' }
                : { kind: 'replaceIfVersion', version: FsVersion(mutation.baseline.version) }, signal, undefined, checkpoint);
            touched();
            return this.files.stat({ sessionId: binding.target.sessionId as SessionId, workspaceRoot: binding.root }, mutation.path, signal);
        }) as Promise<WorkspaceMutationResult<Awaited<ReturnType<WorkspaceServices['files']['stat']>>>>;
    }
    private async save(binding: WorkspaceBinding, request: WorkspaceFileSaveRequest, access: WorkspaceAccess, signal: AbortSignal, touched: () => void) {
        const target = await this.confined(binding, request.path, signal);
        await this.baseline(binding, request.path, request.baseline, signal);
        const text = `${request.format?.bom ? '\uFEFF' : ''}${request.text.replaceAll('\r\n', '\n').replaceAll('\n', request.format?.eol ?? '\n')}`;
        if (Buffer.byteLength(text) > MAX_EDITABLE_BYTES) throw new Rejected('too-large', 'Text editing is limited to 4 MiB.');
        const checkpoint = async () => { await this.baseline(binding, request.path, request.baseline, signal); await this.confined(binding, request.path, signal);
            await this.check(binding, 'save', access, signal); };
        await this.fs.writeText(target, text, request.baseline.kind === 'absent' ? { kind: 'createIfAbsent' }
            : { kind: 'replaceIfVersion', version: FsVersion(request.baseline.version) }, signal, undefined, checkpoint);
        touched();
        return this.files.stat({ sessionId: binding.target.sessionId as SessionId, workspaceRoot: binding.root }, request.path, signal);
    }
    private async manage(binding: WorkspaceBinding, request: WorkspaceFileManageRequest, access: WorkspaceAccess, signal: AbortSignal, touched: () => void): Promise<WorkspaceEntry | null> {
        const op = request.operation, source = await this.confined(binding, op.path, signal), path = this.fs.processPath(source);
        const info = await this.fs.lstat(op.path, { cwd: binding.root }, signal);
        const check = async () => { await this.check(binding, 'manage', access, signal); await this.confined(binding, op.path, signal); };
        if (op.action === 'create-file') {
            if (info) throw new Conflict(info.version); await check();
            const file = await open(path, 'wx', 0o600); touched(); await file.close(); return this.inspect(binding, op.path, signal);
        }
        if (op.action === 'create-directory') {
            if (info) throw new Conflict(info.version); await check(); await mkdir(path); touched(); return this.inspect(binding, op.path, signal);
        }
        if (!info) throw new Rejected('not-found', 'The source entry no longer exists.');
        if (info.version !== op.expectedVersion) throw new Conflict(info.version);
        if (info.type === 'symlink' || info.type === 'other') throw new Rejected('unsupported', 'Manage the real file or directory, not a symbolic link or special file.');
        const fresh = async () => { const current = await this.fs.lstat(op.path, { cwd: binding.root }, signal);
            if (current?.version !== op.expectedVersion) throw new Conflict(current?.version ?? null); await check(); };
        if (op.action === 'delete') {
            await fresh();
            if (info.type === 'directory' && !op.recursive) await rmdir(path);
            else { touched(); await rm(path, { recursive: info.type === 'directory', force: false }); }
            touched(); return null;
        }
        const destinationTarget = await this.confined(binding, op.destination, signal), destination = this.fs.processPath(destinationTarget);
        if (destination === path || destination.startsWith(`${path}${sep}`)) throw new Rejected('invalid', 'The destination must be a different entry outside the source directory.');
        const present = await this.fs.lstat(op.destination, { cwd: binding.root }, signal); if (present) throw new Conflict(present.version);
        const budget = { entries: 0, bytes: 0 };
        await fresh();
        await this.copyTree(path, destination, info.type === 'directory', async () => { await this.check(binding, 'manage', access, signal);
            await this.confined(binding, op.destination, signal); }, touched, budget);
        if (op.action !== 'copy') { await fresh(); touched(); await rm(path, { recursive: info.type === 'directory', force: false }); }
        return this.inspect(binding, op.destination, signal);
    }
    private async copyTree(source: string, destination: string, directory: boolean, checkpoint: () => Promise<void>, touched: () => void,
        budget: { entries: number; bytes: number }): Promise<void> {
        if (++budget.entries > (this.options.maxEntries ?? 20_000)) throw new Rejected('too-large', 'The copy contains too many entries.');
        const info = await lstat(source);
        if (info.isFile()) { budget.bytes += info.size; if (budget.bytes > (this.options.maxCopyBytes ?? 1024 * 1024 * 1024)) throw new Rejected('too-large', 'The copy exceeds this source transfer limit.'); }
        await checkpoint();
        if (info.isSymbolicLink()) { await symlink(await readlink(source), destination); touched(); }
        else if (directory) {
            await mkdir(destination, { mode: info.mode & 0o777 }); touched();
            for (const child of await readdir(source, { withFileTypes: true })) await this.copyTree(join(source, child.name), join(destination, child.name), child.isDirectory(), checkpoint, touched, budget);
        } else if (info.isFile()) { await copyFile(source, destination, constants.COPYFILE_EXCL); touched(); }
        else throw new Rejected('unsupported', 'Special files cannot be copied.');
    }
    async close(): Promise<void> {
        if (this.closed) return; this.closed = true; this.controller.abort(); await this.tail;
        this.db.close(); await this.ctx.fiber.dispose();
    }
}
