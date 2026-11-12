import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import { SOURCE_UPLOAD_CHUNK_PATH, SOURCE_UPLOAD_CHUNK_BYTES } from '../shared/source-upload.ts';
import { workspaceUploadRequestSchema } from '../workbench-types.ts';
import type { WorkspaceAccess, WorkspaceServices } from './service-types.ts';

type Resolve = (sessionId: string, signal: AbortSignal) => Promise<{ services: WorkspaceServices; access: WorkspaceAccess }>;
const querySchema = workspaceUploadRequestSchema.extend({ offset: z.number().int().nonnegative() });
/** Called only after the official Connection registry admits an owner Peer. */
export async function appendSourceUpload(request: Request, resolve: Resolve): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const parsed = querySchema.safeParse({ target: { hostId: 'local', sessionId: query.get('sessionId') },
        uploadId: query.get('uploadId'), offset: query.has('offset') ? Number(query.get('offset')) : -1 });
    if (!parsed.success || !request.body) return Response.json({ error: 'Invalid upload chunk.' }, { status: 400 });
    try {
        const { services, access } = await resolve(parsed.data.target.sessionId, request.signal);
        if (!services.uploads) return Response.json({ error: 'Source uploads are unavailable.' }, { status: 409 });
        const status = await services.uploads.status({ target: parsed.data.target, uploadId: parsed.data.uploadId }, access);
        if (status.state !== 'uploading') return Response.json({ error: 'Check the original upload receipt before continuing.' }, { status: 409 });
        const limit = Math.min(SOURCE_UPLOAD_CHUNK_BYTES, status.transfer.chunkBytes, status.transfer.bytes - status.transfer.receivedBytes);
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = request.body.getReader();
        const abort = () => { void reader.cancel(request.signal.reason); };
        request.signal.addEventListener('abort', abort, { once: true });
        try {
            for (;;) {
                request.signal.throwIfAborted();
                const next = await reader.read(); if (next.done) break;
                size += next.value.byteLength;
                if (size > limit) { await reader.cancel(); return Response.json({ error: 'The chunk exceeds the original transfer.' }, { status: 413 }); }
                chunks.push(next.value);
            }
        } finally { request.signal.removeEventListener('abort', abort); reader.releaseLock(); }
        const data = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        request.signal.throwIfAborted();
        return Response.json(await services.uploads.append({ ...parsed.data, data }, access));
    } catch {
        return Response.json({ error: 'Upload interrupted. Check the original transfer before resuming.' }, { status: 409 });
    }
}
export function installSourceUploadRoute(ctx: Context, resolve: Resolve): void {
    ctx.inject(['connection'], owner => {
        owner.effect(() => owner.connection.fetch.register({ path: SOURCE_UPLOAD_CHUNK_PATH, methods: ['POST'],
            requestBody: 'streaming', fetch: request => appendSourceUpload(request, resolve) }), 'hhpi: source upload bytes');
    });
}
