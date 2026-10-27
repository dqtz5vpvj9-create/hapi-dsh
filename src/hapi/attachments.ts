import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import type { HapiClient } from './client.ts';
import { HapiRequestError, type HapiAttachment, type HapiArtifactRef } from '../codex/contracts.ts';
import { z } from 'zod';
import type { NativeArtifactBlock } from '../codex/content.ts';

const imageMediaTypes = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_NATIVE_ATTACHMENT = 32 * 1024 * 1024;

function decodeNativeBytes(base64: string): Uint8Array {
    if (base64.length > Math.ceil(MAX_NATIVE_ATTACHMENT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
        throw new HapiRequestError('Invalid native attachment bytes or attachment exceeds 32 MiB', 'rejected', 413);
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength > MAX_NATIVE_ATTACHMENT) throw new HapiRequestError('Native attachment exceeds 32 MiB', 'rejected', 413);
    return bytes;
}

/**
 * HAPI keeps queued uploads in per-session blob directories that can rotate
 * (temporary upload dir removed while the message stays in the transcript).
 * The same original filename is usually still retained under a sibling
 * `<sessionId>-*` directory; recover those bytes instead of failing the import.
 */
function recoverLocalUpload(path: string, sourceSessionId: string, filename: string): { bytes: Buffer; mimeType: string } | undefined {
    if (!path.startsWith('/') || path.includes('\0') || sourceSessionId.includes('/') || sourceSessionId.includes('..')) return undefined
    const missingDirectory = dirname(path), root = dirname(missingDirectory)
    if (!root.endsWith('hapi-blobs')) return undefined
    const want = basename(path)
    let directories: string[]
    try { directories = readdirSync(root) } catch { return undefined }
    const suffix = `-${filename}`
    for (const directory of directories) {
        if (!directory.startsWith(`${sourceSessionId}-`)) continue
        const full = join(root, directory)
        let files: string[]
        try { if (!statSync(full).isDirectory()) continue; files = readdirSync(full) } catch { continue }
        const match = files.find(file => file === want)
            ?? files.find(file => file === filename || file.endsWith(suffix))
        if (match === undefined) continue
        try {
            const bytes = readFileSync(join(full, match))
            if (bytes.byteLength === 0 || bytes.byteLength > MAX_NATIVE_ATTACHMENT) continue
            return { bytes, mimeType: nativeAttachmentMediaType(match, bytes) }
        } catch { continue }
    }
    return undefined
}

async function saveNativeBytes(store: AttachmentStore, name: string, mimeType: string, data: Uint8Array): Promise<NativeArtifactBlock> {
    if (imageMediaTypes.has(mimeType)) return { type: 'image', attachment: await store.saveImage({ data, mediaType: mimeType as ImageMediaType, name }) };
    return { type: 'file', attachment: await store.saveFile({ data, name }) };
}

/** Legacy transcript uploads are fetched by the authenticated source session, never a Hub-local filesystem read. */
export function sourceUploadImporter(store: AttachmentStore, client: HapiClient) {
    return async (sourceSessionId: string, attachment: HapiAttachment): Promise<NativeArtifactBlock> => {
        const source = await client.getSession(sourceSessionId);
        if (source.id !== sourceSessionId) throw new HapiRequestError('Attachment source identity changed', 'rejected', 409);
        if (!attachment.path || attachment.path.includes('\0') || attachment.size > MAX_NATIVE_ATTACHMENT) throw new HapiRequestError('Invalid native attachment reference', 'rejected', 400);
        let result: { success: boolean; content?: string | undefined; error?: string | undefined }
        try {
            result = z.object({ success: z.boolean(), content: z.string().optional(), error: z.string().optional() }).parse(await client.request(
                `/api/sessions/${encodeURIComponent(sourceSessionId)}/file?${new URLSearchParams({ path: attachment.path })}`));
        } catch (error) {
            const recovered = recoverLocalUpload(attachment.path, sourceSessionId, attachment.filename);
            if (recovered === undefined) throw error;
            return saveNativeBytes(store, attachment.filename, recovered.mimeType, recovered.bytes);
        }
        if (!result.success || result.content === undefined) {
            const recovered = recoverLocalUpload(attachment.path, sourceSessionId, attachment.filename);
            if (recovered === undefined) throw new HapiRequestError(result.error ?? 'The source attachment is unavailable', 'rejected', 404);
            return saveNativeBytes(store, attachment.filename, recovered.mimeType, recovered.bytes);
        }
        return saveNativeBytes(store, attachment.filename, attachment.mimeType, decodeNativeBytes(result.content));
    };
}

/** SDK inline resources already came from an authenticated transcript; image decoding remains in DSH's attachment service. */
export function sourceInlineImporter(store: AttachmentStore) {
    return async (_sourceSessionId: string, resource: { fileName: string; mimeType: string; base64: string }): Promise<NativeArtifactBlock> =>
        saveNativeBytes(store, resource.fileName, resource.mimeType, decodeNativeBytes(resource.base64));
}

/** DSH file references retain names and bytes, so recover native audio semantics from both. */
export function nativeAttachmentMediaType(name: string, data: Uint8Array): string {
    const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 32));
    const extension = name.split('.').at(-1)?.toLowerCase();
    if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
    if (head.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
    if (head.toString('ascii', 0, 4) === 'OggS' && ['ogg', 'oga', 'opus'].includes(extension ?? '')) return 'audio/ogg';
    if (head.toString('ascii', 0, 3) === 'ID3' || head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && extension === 'mp3') return 'audio/mpeg';
    if (head.toString('ascii', 4, 8) === 'ftyp' && ['m4a', 'm4b', 'aac'].includes(extension ?? '')) return 'audio/mp4';
    const types: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav',
        flac: 'audio/flac', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
        txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf',
        html: 'text/html', svg: 'image/svg+xml', zip: 'application/zip' };
    return types[extension ?? ''] ?? 'application/octet-stream';
}

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
                const data = Buffer.concat(chunks);
                result.push(await client.uploadAttachment(sourceSessionId, block.attachment.name,
                    nativeAttachmentMediaType(block.attachment.name, data), data));
            }
        }
        return result;
    };
}
