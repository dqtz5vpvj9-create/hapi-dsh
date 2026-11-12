import { SOURCE_UPLOAD_CHUNK_PATH } from '../shared/source-upload.ts';
import type { WorkspaceUploadService } from '../workspace/service-types.ts';

/** `fetcher` belongs to the selected Host graph, including its authenticated tunnel. */
export function createSourceUploadAppend(fetcher: typeof fetch): WorkspaceUploadService['append'] {
    return async (request, access) => {
        access.signal.throwIfAborted(); await access.assertAllowed(request.target, 'upload');
        const query = new URLSearchParams({ sessionId: request.target.sessionId, uploadId: request.uploadId, offset: String(request.offset) });
        const response = await fetcher(`${SOURCE_UPLOAD_CHUNK_PATH}?${query}`, { method: 'POST',
            body: new Blob([new Uint8Array(request.data)]), signal: access.signal, headers: { 'Content-Type': 'application/octet-stream' } });
        access.signal.throwIfAborted(); await access.assertAllowed(request.target, 'upload');
        if (!response.ok) throw new Error('The upload was interrupted. Resume the original transfer to check its saved progress.');
        const value: unknown = await response.json();
        if (!value || typeof value !== 'object' || !('receivedBytes' in value) || !Number.isSafeInteger(value.receivedBytes)
            || value.receivedBytes !== request.offset + request.data.length) throw new Error('The source did not confirm this upload chunk. Check its original progress.');
        return { receivedBytes: value.receivedBytes as number };
    };
}
