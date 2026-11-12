/** Source-owned immutable receipts and accepted generated-media grants; no display filesystem fallback. */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { WorkspaceByteReadOptions } from '@deepseek-ai/dsh-api-workspace-files/types';
import type { WorkspaceDocumentRef } from '../workbench-types.ts';
import { MAX_DOCUMENT_BYTES, MAX_EDITABLE_BYTES } from '../workbench-types.ts';
import { storedCodexAttachment, storedCodexUpload } from '../remote/codex-uploads.ts';
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceDocument, WorkspaceDocumentService } from './service-types.ts';

export interface GeneratedSourceDocument { data: Uint8Array; name: string; mimeType: string; version: string }
export type ReadGeneratedSourceDocument = (binding: WorkspaceBinding, id: string, access: WorkspaceAccess) => Promise<GeneratedSourceDocument>;
const extensions: Record<string, string> = { pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', json: 'application/json',
    html: 'text/html', htm: 'text/html', csv: 'text/csv', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' };
export function sourceDocumentMime(data: Uint8Array, name: string, declared?: string): string {
    const bytes = Buffer.from(data), ascii = bytes.subarray(0, 16).toString('ascii');
    if (ascii.startsWith('%PDF-')) return 'application/pdf';
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
    if (ascii.startsWith('OggS')) return 'audio/ogg';
    if (ascii.startsWith('ID3')) return 'audio/mpeg';
    if (ascii.slice(4, 8) === 'ftyp') return 'video/mp4';
    if (bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return 'video/webm';
    const mime = declared?.split(';', 1)[0]?.trim().toLowerCase();
    return mime && mime !== 'application/octet-stream' ? mime : extensions[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
export function sourceDocumentText(data: Uint8Array, mime: string, name: string): string | null {
    if (data.length > MAX_EDITABLE_BYTES || data.includes(0) || /^(image|audio|video)\//.test(mime)
        || mime === 'application/pdf' || /\.(?:docx?|xlsx?|pptx?|zip|gz|7z|rar|wasm|exe)$/i.test(name)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; }
}
interface Material { name: string; mimeType: string; version: string; bytes: number; data(): AsyncIterable<Uint8Array> }

export class SourceArtifactDocuments {
    constructor(private readonly options: { receipts?: string | undefined; store: Pick<AttachmentStore, 'readFileStream' | 'readImage'>; generated?: ReadGeneratedSourceDocument }) {}
    compose(binding: WorkspaceBinding, files: WorkspaceDocumentService): WorkspaceDocumentService {
        return { ...files,
            open: (document, access) => document.kind === 'file' ? files.open(document, access) : this.open(binding, document, access),
            bytes: (document, options, access) => document.kind === 'file' ? files.bytes(document, options, access) : this.bytes(binding, document, options, access),
        };
    }
    private async check(binding: WorkspaceBinding, access: WorkspaceAccess): Promise<void> {
        access.signal.throwIfAborted(); await access.assertAllowed(binding.target, 'read'); access.signal.throwIfAborted();
    }
    private async material(binding: WorkspaceBinding, document: WorkspaceDocumentRef, access: WorkspaceAccess): Promise<Material> {
        await this.check(binding, access);
        if (document.kind === 'generated-media') {
            if (!this.options.generated) throw new Error('Generated media is not registered on this source. Its original reference is kept.');
            const value = await this.options.generated(binding, document.id, access); await this.check(binding, access);
            return { ...value, bytes: value.data.length, async *data() { yield value.data; } };
        }
        if (document.kind !== 'artifact') throw new Error('An immutable source artifact is required.');
        if (!this.options.receipts) throw new Error('Attachment receipts are not registered on this source. The original reference is kept.');
        let attachment: { id: string; name: string } | undefined;
        if (document.id.startsWith('attachment:')) {
            const encoded = document.id.slice('attachment:'.length).split('/');
            if (encoded.length !== 2) throw new Error('The source attachment address is incomplete. Reopen its original card.');
            attachment = { id: decodeURIComponent(encoded[0]!), name: decodeURIComponent(encoded[1]!) };
        }
        const stored = attachment
            ? await storedCodexAttachment(this.options.receipts, binding.target.sessionId, attachment.id, access.signal, attachment.name)
            : await storedCodexUpload(this.options.receipts, binding.target.sessionId, document.id, access.signal);
        await this.check(binding, access);
        if (!stored?.value) throw new Error('This source attachment is unavailable or has no immutable receipt. Its reference is kept; restore source access or upload the original again.');
        const value = stored.value;
        if ('image' in value) {
            const image = value.image, store = this.options.store;
            return { name: image.name ?? stored.name, mimeType: image.mediaType, version: image.attachmentId, bytes: image.bytes,
                async *data() { const result = await store.readImage(image, access.signal); yield result.data; } };
        }
        const file = value.file, store = this.options.store;
        return { name: file.name, mimeType: sourceDocumentMime(new Uint8Array(), file.name, stored.mimeType), version: file.attachmentId, bytes: file.bytes,
            data: () => store.readFileStream(file, access.signal) };
    }
    private async collect(binding: WorkspaceBinding, value: Material, access: WorkspaceAccess, offset = 0, length = MAX_DOCUMENT_BYTES): Promise<Uint8Array<ArrayBuffer>> {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_DOCUMENT_BYTES) throw new Error('The source document byte range is invalid.');
        const chunks: Uint8Array[] = []; let position = 0, total = 0;
        for await (const chunk of value.data()) {
            await this.check(binding, access);
            const start = Math.max(0, offset - position), end = Math.min(chunk.length, offset + length - position);
            if (end > start) { const part = chunk.subarray(start, end); chunks.push(part); total += part.length; }
            position += chunk.length;
            if (position > MAX_DOCUMENT_BYTES) throw new Error('This source document exceeds the 64 MiB preview/download limit. The original source file is retained.');
        }
        await this.check(binding, access);
        const data = new Uint8Array(total); let target = 0; for (const part of chunks) { data.set(part, target); target += part.length; } return data;
    }
    private async open(binding: WorkspaceBinding, document: WorkspaceDocumentRef, access: WorkspaceAccess): Promise<WorkspaceDocument> {
        const value = await this.material(binding, document, access);
        const data = value.bytes <= MAX_EDITABLE_BYTES ? await this.collect(binding, value, access) : new Uint8Array();
        const mimeType = sourceDocumentMime(data, value.name, value.mimeType), text = value.bytes <= MAX_EDITABLE_BYTES ? sourceDocumentText(data, mimeType, value.name) : null;
        await this.check(binding, access);
        return { resource: { target: binding.target, document }, fileName: value.name, mimeType, bytes: value.bytes, version: value.version, writable: false, text };
    }
    private async bytes(binding: WorkspaceBinding, document: WorkspaceDocumentRef, options: WorkspaceByteReadOptions, access: WorkspaceAccess) {
        if (options.baseFile !== undefined) throw new Error('An opaque source artifact has no filesystem dependency base.');
        const value = await this.material(binding, document, access), offset = options.range?.offset ?? 0;
        const data = await this.collect(binding, value, access, offset, options.range?.length ?? MAX_DOCUMENT_BYTES);
        return { absolutePath: '', version: value.version, bytes: value.bytes,
            offset, data, eof: offset + data.length >= value.bytes };
    }
}
