import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HapiRequestError } from '../codex/contracts.ts';
import { SOURCE_BACKUP_PATH } from '../source-admin-types.ts';
import type { FederationMount } from '../hub/federation.ts';

export interface BackupSource {
    readonly hubId: string;
    downloadSqliteBackup(signal: AbortSignal): Promise<Response>;
}
function drained(response: ServerResponse): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => { response.off('drain', onDrain); response.off('close', onClose); response.off('error', onError); };
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); reject(new Error('The backup download was closed')); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        response.once('drain', onDrain); response.once('close', onClose); response.once('error', onError);
        if (response.destroyed) onClose();
    });
}
async function readRequest(request: IncomingMessage): Promise<{ hubId: string }> {
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || request.headers['x-hapi-backup'] !== '1') throw new HapiRequestError('Request this backup from Hub settings', 'rejected', 400);
    const buffers: Buffer[] = []; let total = 0;
    for await (const chunk of request) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += data.byteLength;
        if (total > 2048) throw new HapiRequestError('Invalid backup request', 'rejected', 413);
        buffers.push(data);
    }
    return z.strictObject({ hubId: z.string().min(1).max(512) }).parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
}

/** This authenticated stream is one fixed source operation, never a caller-supplied URL proxy. */
export function mountSourceBackup(source: BackupSource, { webServer, authorize }: FederationMount): () => void {
    return webServer.register({ kind: 'exact', path: SOURCE_BACKUP_PATH, handler: async (request, response) => {
        const rejection = authorize(request);
        if (rejection !== undefined) { response.writeHead(rejection); response.end(); return; }
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
        const abort = new AbortController(); const closed = () => abort.abort(); response.once('close', closed);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            const input = await readRequest(request);
            if (input.hubId !== source.hubId) throw new HapiRequestError('The backup belongs to another HAPI Hub', 'rejected', 409);
            const upstream = await source.downloadSqliteBackup(abort.signal);
            abort.signal.throwIfAborted();
            const name = `hapi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
            response.writeHead(200, { 'content-type': 'application/vnd.sqlite3', 'content-disposition': `attachment; filename="${name}"`,
                'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            reader = upstream.body!.getReader();
            for (;;) {
                const next = await reader.read();
                if (next.done) break;
                abort.signal.throwIfAborted();
                // The official compression wrapper preserves write's boolean and
                // drain, but not its optional callback. Respect real backpressure.
                if (!response.write(next.value)) await drained(response);
            }
            response.end();
        } catch (error) {
            if (response.destroyed) return;
            if (response.headersSent) { response.destroy(); return; }
            const status = error instanceof HapiRequestError ? error.status ?? 502 : 400;
            response.writeHead(status >= 400 && status <= 599 ? status : 502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: error instanceof HapiRequestError ? error.message : 'Invalid backup request' }));
        } finally {
            await reader?.cancel().catch(() => {}); reader?.releaseLock();
            response.off('close', closed); abort.abort();
        }
    } });
}
