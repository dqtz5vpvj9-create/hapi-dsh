/** Lazy native image projection. Only accepted transcript references can import source bytes. */
import { createHash } from 'node:crypto';
import { basename, isAbsolute, win32 } from 'node:path';
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import { readImageFile, saveImageFile, type NormalizationPolicy } from '@deepseek-ai/dsh-attachment-local';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { isRecord, nativeText, type NativeItem } from './codex-native.ts';
import { SourceError, waitFor } from './errors.ts';
import type { SourceEventIndex } from './event-index.ts';
import type { SourceEntry, SourceResource } from './protocol.ts';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const limits: ImageAttachmentLimits = { maxImageBytes: MAX_IMAGE_BYTES, maxImagesPerMessage: 20,
    maxMessageImageBytes: 32 * 1024 * 1024, maxImagePixels: 64_000_000, maxImageDimension: 8192,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] };
const policy: NormalizationPolicy = { maxPixels: 4_000_000, maxDimension: 8192, maxBytes: 2 * 1024 * 1024 };
interface NativeImageState { item: NativeItem; turnId: string; time: number; completed: boolean }
interface PreparedContent { fingerprint: string; content: ContentBlock[]; retryAfter?: number }
interface Grant { turnId: string; itemId: string; fingerprint: string; attachment: ImageAttachmentRef }
type ReadSourceFile = (path: string, signal: AbortSignal) => Promise<unknown>;
const itemKey = (turnId: string, itemId: string): string => JSON.stringify(['item', turnId, itemId]);
const contentKey = (turnId: string, itemId: string): string => JSON.stringify(['codex-image-content', turnId, itemId]);
const grantKey = (id: string): string => `codex-image-grants:${id}`;
const fingerprint = (item: NativeItem): string => createHash('sha256').update(JSON.stringify(
    item.type === 'userMessage' ? [item.type, item.content] : [item.type, item.path])).digest('hex');
const hasImages = (item: NativeItem): boolean => item.type === 'imageView' || item.type === 'userMessage'
    && Array.isArray(item.content) && item.content.some(value => isRecord(value) && (value.type === 'image' || value.type === 'localImage'));

/** Strip source paths and upload transport prefixes from visible image names. */
export function nativeImageName(path: unknown): string {
    const name = typeof path === 'string' ? basename(path.replace(/\\/g, '/')) : '';
    return name.replace(/^\d{10,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '')
        .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'Image';
}
function decodeBase64(value: unknown): Buffer {
    if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
        throw new SourceError('CAPACITY_EXCEEDED', 'The image exceeds the native preview budget.');
    }
    const data = Buffer.from(value, 'base64');
    if (data.length > MAX_IMAGE_BYTES || data.toString('base64') !== value) throw new SourceError('INVALID_REQUEST', 'The source image is not canonical base64.');
    return data;
}
function mediaType(data: Buffer): ImageMediaType {
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
    throw new SourceError('UNSUPPORTED', 'This native attachment is not a supported raster image.');
}

export class CodexAttachments {
    private revision = 0;
    private acceptedRevision = 0;
    private rewritten = false;
    private readonly pending = new Map<string, Promise<NativeImageState | undefined>>();
    constructor(private readonly index: SourceEventIndex, private readonly directory: string,
        private readonly readSourceFile: ReadSourceFile, private readonly lifetime: AbortSignal) {}

    /** Rewrites and source retirement revoke every in-flight byte read. */
    revoke(rewritten = false): void { this.revision++; this.rewritten ||= rewritten; }
    get revisionToken(): number { return this.revision; }
    get needsReconciliation(): boolean { return this.rewritten; }
    /** Only a native read begun after revocation can admit the new image scope. */
    acceptRevision(revision: number): void {
        if (this.revision === revision) { this.acceptedRevision = revision; this.rewritten = false; }
    }
    content(turnId: string, item: NativeItem): ContentBlock[] | undefined {
        if (!hasImages(item)) return undefined;
        const prepared = this.index.cached<PreparedContent>(contentKey(turnId, item.id));
        return prepared?.fingerprint === fingerprint(item) && !(prepared.retryAfter !== undefined && prepared.retryAfter <= Date.now()) ? prepared.content : undefined;
    }
    /** At most two requested-page images decode concurrently; full indexing does no image IO. */
    async enrich(entries: readonly SourceEntry[], signal?: AbortSignal): Promise<NativeImageState[]> {
        if (this.acceptedRevision !== this.revision) return [];
        const selected = new Map<string, NativeImageState>();
        for (const { event } of entries) {
            if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
            const message = event.type === 'user/message' ? event.data : event.data.message;
            const identity = String(message.id).split(':');
            if (identity.length !== 4 || identity[0] !== 'codex') continue;
            let nativeId: string, turnId: string, id: string;
            try { [nativeId, turnId, id] = identity.slice(1).map(decodeURIComponent) as [string, string, string]; } catch { continue; }
            if (nativeId !== this.index.session.nativeId) continue;
            const state = this.index.cached<NativeImageState>(itemKey(turnId, id));
            if (state && hasImages(state.item) && !this.content(turnId, state.item)) selected.set(itemKey(turnId, id), state);
        }
        const queue = [...selected.values()], prepared: NativeImageState[] = [];
        const worker = async (): Promise<void> => {
            for (;;) {
                const state = queue.shift(); if (!state) return;
                signal?.throwIfAborted(); this.lifetime.throwIfAborted();
                const id = itemKey(state.turnId, state.item.id);
                let work = this.pending.get(id);
                if (!work) {
                    work = this.prepare(state).finally(() => { if (this.pending.get(id) === work) this.pending.delete(id); });
                    this.pending.set(id, work);
                }
                const result = await waitFor(work, signal);
                signal?.throwIfAborted(); if (result) prepared.push(result);
            }
        };
        await Promise.all([worker(), worker()]);
        return prepared;
    }
    private current(state: NativeImageState, expected: string, epoch: string, revision: number): boolean {
        this.lifetime.throwIfAborted();
        const accepted = this.index.cached<NativeImageState>(itemKey(state.turnId, state.item.id));
        return this.revision === revision && this.acceptedRevision === revision && this.index.epoch === epoch && accepted !== undefined && fingerprint(accepted.item) === expected;
    }
    private async prepare(state: NativeImageState): Promise<NativeImageState | undefined> {
        const expected = fingerprint(state.item), epoch = this.index.epoch, revision = this.revision;
        const parts = state.item.type === 'imageView' ? [{ type: 'localImage', path: state.item.path }]
            : Array.isArray(state.item.content) ? state.item.content : [];
        const content: ContentBlock[] = [], images: ImageAttachmentRef[] = [];
        let imageCount = 0, imageBytes = 0, retryable = false;
        for (const value of parts) {
            if (!isRecord(value)) continue;
            if (value.type === 'text' && typeof value.text === 'string') { content.push({ type: 'text', text: value.text }); continue; }
            if (value.type === 'image' || value.type === 'localImage') {
                if (!this.current(state, expected, epoch, revision)) return undefined;
                const name = nativeImageName(value.name ?? value.path);
                try {
                    if (++imageCount > limits.maxImagesPerMessage) throw new SourceError('CAPACITY_EXCEEDED', 'Too many images in one native message.');
                    if (imageBytes >= limits.maxMessageImageBytes) throw new SourceError('CAPACITY_EXCEEDED', 'The native message exceeds its image preview budget.');
                    let data: Buffer;
                    if (value.type === 'localImage') {
                        if (typeof value.path !== 'string' || !(isAbsolute(value.path) || win32.isAbsolute(value.path)) || value.path.includes('\0')) {
                            throw new SourceError('INVALID_REQUEST', 'The native image has no valid source path.');
                        }
                        // This path came from this accepted native item, never from the browser.
                        const response = await this.readSourceFile(value.path, this.lifetime);
                        if (!isRecord(response)) throw new SourceError('INVALID_REQUEST', 'The source returned an invalid image response.');
                        data = decodeBase64(response.dataBase64);
                    } else {
                        if (typeof value.url !== 'string' || !value.url.startsWith('data:image/')) throw new SourceError('UNSUPPORTED', 'The source does not expose bytes for this image.');
                        const marker = value.url.indexOf(';base64,');
                        if (marker === -1) throw new SourceError('UNSUPPORTED', 'The native image encoding is unsupported.');
                        data = decodeBase64(value.url.slice(marker + 8));
                    }
                    imageBytes += data.length;
                    if (imageBytes > limits.maxMessageImageBytes) throw new SourceError('CAPACITY_EXCEEDED', 'The native message exceeds its image preview budget.');
                    if (!this.current(state, expected, epoch, revision)) return undefined;
                    const attachment = await saveImageFile(this.directory, { data, mediaType: mediaType(data), name }, limits, policy);
                    if (!this.current(state, expected, epoch, revision)) return undefined;
                    images.push(attachment);
                    if (state.item.type === 'imageView') content.push({ type: 'text',
                        text: `<path>${nativeText(state.item.path)}</path>\n<type>image</type>\n<content>\n${attachment.width} × ${attachment.height} pixels\n</content>` });
                    content.push({ type: 'image', attachment });
                } catch {
                    if (!this.current(state, expected, epoch, revision)) return undefined;
                    if (value.type === 'localImage') retryable = true;
                    content.push({ type: 'text', text: name === 'Image' ? 'Image preview unavailable.' : `Image preview unavailable: ${name}` });
                }
            } else if (value.type === 'audio' || value.type === 'localAudio') content.push({ type: 'text', text: 'Audio attachment unavailable.' });
            else if (value.type === 'skill' || value.type === 'mention') content.push({ type: 'text', text: nativeText(value.name) || String(value.type) });
        }
        if (!this.current(state, expected, epoch, revision)) return undefined;
        this.index.edit(this.index.session, () => {
            this.index.cache(contentKey(state.turnId, state.item.id), { fingerprint: expected, content,
                ...(retryable ? { retryAfter: Date.now() + 30_000 } : {}) } satisfies PreparedContent);
            for (const attachment of images) {
                const key = grantKey(attachment.attachmentId), previous = this.index.cached<Grant[]>(key) ?? [];
                const grants = previous.filter(grant => grant.turnId !== state.turnId || grant.itemId !== state.item.id);
                grants.push({ turnId: state.turnId, itemId: state.item.id, fingerprint: expected, attachment });
                this.index.cache(key, grants);
            }
        });
        return this.index.cached<NativeImageState>(itemKey(state.turnId, state.item.id));
    }
    async read(path: string, signal?: AbortSignal): Promise<SourceResource> {
        this.lifetime.throwIfAborted(); signal?.throwIfAborted();
        if (this.acceptedRevision !== this.revision) throw new SourceError('STALE_VERSION', 'The source must reconcile its rewritten history before an image can be read.');
        if (!/^attachment:sha256:[0-9a-f]{64}$/.test(path)) throw new SourceError('INVALID_REQUEST', 'Only an image referenced by this conversation can be read.');
        const id = path.slice('attachment:'.length), epoch = this.index.epoch, revision = this.revision;
        const accepted = (): Grant | undefined => (this.index.cached<Grant[]>(grantKey(id)) ?? []).find(grant => {
            const state = this.index.cached<NativeImageState>(itemKey(grant.turnId, grant.itemId));
            return state !== undefined && fingerprint(state.item) === grant.fingerprint;
        });
        const grant = accepted();
        if (!grant) throw new SourceError('INVALID_REQUEST', 'This conversation no longer references the requested image.');
        const image = await readImageFile(this.directory, grant.attachment, AbortSignal.any([this.lifetime, ...(signal ? [signal] : [])]));
        if (this.revision !== revision || this.index.epoch !== epoch || !accepted()) throw new SourceError('STALE_VERSION', 'The conversation changed while its image was loading.');
        return { encoding: 'base64', content: Buffer.from(image.data).toString('base64'), mimeType: image.ref.mediaType, attachment: image.ref };
    }
}
