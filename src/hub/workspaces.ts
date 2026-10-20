import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { parseWorkspaceState } from '../client/model.ts';
import type { WorkspaceDocument, WorkspaceWrite, WorkspaceWriteResult } from '../client-api.ts';

interface StoredWorkspace extends WorkspaceDocument { operationId: string | null }

/** Hub-owned compare-and-swap persistence; concurrent browsers never silently overwrite another revision. */
export class WorkspaceRepository {
    private queue: Promise<unknown> = Promise.resolve();
    constructor(private readonly path: string) {}

    private async read(): Promise<StoredWorkspace> {
        let source: string;
        try { source = await readFile(this.path, 'utf8'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, state: null, operationId: null };
            throw error;
        }
        if (source.length > 1024 * 1024) throw new Error('Stored workspace is too large');
        const value: unknown = JSON.parse(source);
        if (typeof value !== 'object' || value === null || !('revision' in value) || !('state' in value)
            || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error('Stored workspace is invalid');
        return {
            revision: Number(value.revision), state: value.state === null ? null : parseWorkspaceState(value.state),
            operationId: 'operationId' in value && typeof value.operationId === 'string' ? value.operationId : null,
        };
    }
    async get(): Promise<WorkspaceDocument> {
        await this.queue;
        const { revision, state } = await this.read();
        return { revision, state };
    }
    put(request: WorkspaceWrite): Promise<WorkspaceWriteResult> {
        const task = this.queue.then(() => this.write(request));
        this.queue = task.catch(() => undefined);
        return task;
    }
    private async write(request: WorkspaceWrite): Promise<WorkspaceWriteResult> {
        const state = parseWorkspaceState(request.state);
        if (!request.operationId || request.operationId.length > 512) throw new Error('Workspace operation requires a stable ID');
        if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('Invalid expected revision');
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        // Use DSH's public PID-aware writer lock. A terminated writer cannot
        // strand an empty sentinel and permanently disable workspace saves.
        return withFileLock(this.path, async () => {
            const temporary = `${this.path}.${randomUUID()}.tmp`;
            try {
                const current = await this.read();
                if (current.operationId === request.operationId) return { status: 'applied', revision: current.revision, state: current.state };
                if (current.revision !== request.expectedRevision) return { status: 'conflict', revision: current.revision, state: current.state };
                const next: StoredWorkspace = { revision: current.revision + 1, state, operationId: request.operationId };
                const data = `${JSON.stringify(next)}\n`;
                if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('Workspace exceeds 1 MiB');
                const file = await open(temporary, 'wx', 0o600);
                try { await file.writeFile(data, 'utf8'); await file.sync(); }
                finally { await file.close(); }
                await rename(temporary, this.path);
                if (process.platform !== 'win32') {
                    const directory = await open(dirname(this.path), 'r');
                    try { await directory.sync(); } finally { await directory.close(); }
                }
                return { status: 'applied', revision: next.revision, state: next.state };
            } finally { await rm(temporary, { force: true }); }
        });
    }
}
