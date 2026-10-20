import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import type { HapiClient } from './client.ts';
import { HapiRequestError, type HapiAttachment, type HapiArtifactRef } from '../codex/contracts.ts';

const imageMediaTypes = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Copy authorized immutable native resources into DSH's ordinary attachment store. */
export function artifactImporter(store: AttachmentStore, client: HapiClient) {
    return async (sourceSessionId: string, ref: HapiArtifactRef): Promise<Extract<ContentBlock, { type: 'image' | 'file' }>> => {
        if (ref.externalUrl) throw new HapiRequestError('External artifacts must be opened as links', 'rejected');
        const artifact = await client.readArtifact(sourceSessionId, ref.id);
        const name = ref.fileName || artifact.fileName;
        if (imageMediaTypes.has(artifact.mimeType)) {
            // saveImage decodes and verifies bytes against the declared format and pixel limits.
            const attachment = await store.saveImage({ data: artifact.data, mediaType: artifact.mimeType as ImageMediaType, name });
            return { type: 'image', attachment };
        }
        return { type: 'file', attachment: await store.saveFile({ data: artifact.data, name }) };
    };
}

/** Resolve DSH-owned immutable bytes, then obtain a path from the owning HAPI Runner. */
export function attachmentResolver(store: AttachmentStore, client: HapiClient) {
    return async (sourceSessionId: string, message: UserMessage): Promise<HapiAttachment[]> => {
        const result: HapiAttachment[] = [];
        for (const block of message.content) {
            if (block.type === 'text') continue;
            if (block.type === 'image') {
                const image = await store.readImage(block.attachment);
                result.push(await client.uploadAttachment(sourceSessionId,
                    block.attachment.name ?? `image-${block.attachment.attachmentId}.${block.attachment.mediaType.split('/')[1]}`,
                    block.attachment.mediaType, image.data));
                continue;
            }
            if (block.type === 'file') {
                const chunks: Uint8Array[] = [];
                let size = 0;
                for await (const chunk of store.readFileStream(block.attachment)) {
                    size += chunk.byteLength;
                    if (size > 32 * 1024 * 1024) throw new Error('Native attachment exceeds 32 MiB');
                    chunks.push(chunk);
                }
                result.push(await client.uploadAttachment(sourceSessionId, block.attachment.name,
                    'application/octet-stream', Buffer.concat(chunks)));
            }
        }
        return result;
    };
}
