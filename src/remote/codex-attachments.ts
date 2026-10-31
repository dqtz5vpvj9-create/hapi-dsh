/** Lazy native image projection. Only accepted transcript references can import source bytes. */
import { createHash } from 'node:crypto';
import { basename, isAbsolute, win32 } from 'node:path';
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import { readImageFile, saveImageFile, type NormalizationPolicy } from '@deepseek-ai/dsh-attachment-local';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { isRecord, nativeText, type NativeItem } from './codex-native.ts';
import { MAX_NATIVE_IMAGE_BYTES } from './codex-image-reader.ts';
import { SourceError, waitFor } from './errors.ts';
import type { SourceEventIndex } from './event-index.ts';
import type { SourceEntry, SourceResource } from './protocol.ts';
import { sourceImageAttachmentRefSchema } from '../source-attachment-types.ts';

const MAX_IMAGE_BYTES = MAX_NATIVE_IMAGE_BYTES;
const limits: ImageAttachmentLimits = { maxImageBytes: MAX_IMAGE_BYTES, maxImagesPerMessage: 20,
    maxMessageImageBytes: 32 * 1024 * 1024, maxImagePixels: 64_000_000, maxImageDimension: 8192,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] };
const policy: NormalizationPolicy = { maxPixels: 4_000_000, maxDimension: 8192, maxBytes: 2 * 1024 * 1024 };
interface NativeImageState { item: NativeItem; turnId: string; time: number; completed: boolean; presentationContent?: ContentBlock[] }
interface ImageIdentity { turnId: string; itemId: string }
interface PreparedContent { fingerprint: string; content: ContentBlock[]; retryAfter?: number }
interface Grant { turnId: string; itemId: string; fingerprint: string; attachment: ImageAttachmentRef }
type ReadSourceFile = (path: string, signal: AbortSignal) => Promise<unknown>;
const itemKey = (turnId: string, itemId: string): string => JSON.stringify(['item', turnId, itemId]);
const contentKey = (turnId: string, itemId: string): string => JSON.stringify(['codex-image-content', turnId, itemId]);
const grantKey = (id: string): string => `codex-image-grants:${id}`;
const imageResourcePath = /^attachment:sha256:[0-9a-f]{64}$/;
const fingerprint = (item: NativeItem): string => createHash('sha256').update(JSON.stringify(
    item.type === 'userMessage' ? [item.type, item.content] : [item.type, item.path])).digest('hex');
const hasImages = (item: NativeItem): boolean => item.type === 'imageView' || item.type === 'userMessage'
    && Array.isArray(item.content) && item.content.some(value => isRecord(value) && (value.type === 'image' || value.type === 'localImage'));

/** The same accepted native fingerprint gates live projection and version upgrades. */
export function nativeImageContent(index: SourceEventIndex, turnId: string, item: NativeItem): ContentBlock[] | undefined {
    if (!hasImages(item)) return undefined;
    const prepared = index.cached<PreparedContent>(contentKey(turnId, item.id));
    return prepared?.fingerprint === fingerprint(item) && !(prepared.retryAfter !== undefined && prepared.retryAfter <= Date.now()) ? prepared.content : undefined;
}

/** Retain only image caches whose content and grant both match an accepted native item. */
export function retainedNativeImageCache(cache: ReadonlyMap<string, unknown>, items: readonly { turnId: string; item: NativeItem }[]): Map<string, unknown> {
    const retained = new Map<string, unknown>();
    for (const { turnId, item } of items) {
        if (!hasImages(item)) continue;
        const expected = fingerprint(item), prepared = cache.get(contentKey(turnId, item.id));
        if (!isRecord(prepared) || prepared.fingerprint !== expected || !Array.isArray(prepared.content)
            || prepared.retryAfter !== undefined && (typeof prepared.retryAfter !== 'number' || !Number.isFinite(prepared.retryAfter))) continue;
        const content: ContentBlock[] = [], grants: Grant[] = [];
        let valid = true;
        for (const block of prepared.content) {
            if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') { content.push({ type: 'text', text: block.text }); continue; }
            if (!isRecord(block) || block.type !== 'image') { valid = false; break; }
            const parsed = sourceImageAttachmentRefSchema.safeParse(block.attachment);
            if (!parsed.success) { valid = false; break; }
            const attachment = parsed.data;
            if (!imageResourcePath.test(`attachment:${attachment.attachmentId}`)) { valid = false; break; }
            if (attachment.bytes === 0 || attachment.bytes > limits.maxImageBytes || attachment.width > limits.maxImageDimension
                || attachment.height > limits.maxImageDimension || attachment.width * attachment.height > limits.maxImagePixels) { valid = false; break; }
            const previous = cache.get(grantKey(attachment.attachmentId));
            const granted = Array.isArray(previous) && previous.some(grant => {
                if (!isRecord(grant) || grant.turnId !== turnId || grant.itemId !== item.id || grant.fingerprint !== expected) return false;
                const reference = sourceImageAttachmentRefSchema.safeParse(grant.attachment);
                return reference.success && JSON.stringify(reference.data) === JSON.stringify(attachment);
            });
            if (!granted) { valid = false; break; }
            content.push({ type: 'image', attachment }); grants.push({ turnId, itemId: item.id, fingerprint: expected, attachment });
        }
        if (!valid || !grants.length || grants.length > limits.maxImagesPerMessage) continue;
        retained.set(contentKey(turnId, item.id), { fingerprint: expected, content,
            ...(prepared.retryAfter === undefined ? {} : { retryAfter: prepared.retryAfter }) });
        for (const grant of grants) {
            const key = grantKey(grant.attachment.attachmentId), previous = retained.get(key) as Grant[] | undefined;
            if (!previous?.some(value => value.turnId === turnId && value.itemId === item.id)) retained.set(key, [...previous ?? [], grant]);
        }
    }
    return retained;
}

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
    private closed = false;
    private revisionLifetime = new AbortController();
    // Queue identities, not image bytes or copies of whole native messages.
    private readonly queued = new Map<string, ImageIdentity>();
    private readonly running = new Map<string, { identity: ImageIdentity; work: Promise<void> }>();
    constructor(private readonly index: SourceEventIndex, private readonly directory: string,
        private readonly readSourceFile: ReadSourceFile, private readonly lifetime: AbortSignal,
        private readonly onPrepared: (identity: ImageIdentity) => void) {}

    /** Rewrites and source retirement revoke every in-flight byte read. */
    revoke(rewritten = false): void {
        this.revision++; this.rewritten ||= rewritten;
        for (const [key, { identity }] of this.running) this.queued.set(key, identity);
        this.revisionLifetime.abort(new SourceError('STALE_VERSION', 'The native image scope was revoked.'));
        this.revisionLifetime = new AbortController();
    }
    get revisionToken(): number { return this.revision; }
    get needsReconciliation(): boolean { return this.rewritten; }
    /** Only a native read begun after revocation can admit the new image scope. */
    acceptRevision(revision: number): void {
        if (this.revision === revision) { this.acceptedRevision = revision; this.rewritten = false; this.pump(); }
    }
    content(turnId: string, item: NativeItem): ContentBlock[] | undefined {
        return nativeImageContent(this.index, turnId, item);
    }
    /** Reader cancellation never owns preparation or publication. Full indexing does no image IO. */
    schedule(entries: readonly SourceEntry[]): void {
        if (this.closed || this.lifetime.aborted) return;
        for (const { event } of entries) {
            if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
            const message = event.type === 'user/message' ? event.data : event.data.message;
            const identity = String(message.id).split(':');
            if (identity.length !== 4 || identity[0] !== 'codex') continue;
            let nativeId: string, turnId: string, id: string;
            try { [nativeId, turnId, id] = identity.slice(1).map(decodeURIComponent) as [string, string, string]; } catch { continue; }
            if (nativeId !== this.index.session.nativeId) continue;
            // Loading native bytes (including embedded data URLs) belongs to the
            // workers too, so scheduling a large page cannot delay its text.
            if (event.type === 'assistant/message' && !message.content.some(block => block.type === 'tool-call'
                && (block.name === 'read_image' || block.name === 'codex.imageView'))) continue;
            this.queued.set(itemKey(turnId, id), { turnId, itemId: id });
        }
        this.pump();
    }
    private projected(state: NativeImageState): boolean {
        const content = this.content(state.turnId, state.item);
        return content !== undefined && JSON.stringify(content) === JSON.stringify(state.presentationContent);
    }
    /** One owner-wide worker budget, shared by all pages and subscriptions. */
    private pump(): void {
        if (this.closed || this.lifetime.aborted || this.acceptedRevision !== this.revision) return;
        while (this.running.size < 2) {
            let next: [string, ImageIdentity] | undefined;
            for (const entry of this.queued) if (!this.running.has(entry[0])) { next = entry; break; }
            if (!next) return;
            const [key, identity] = next;
            this.queued.delete(key);
            const work = Promise.resolve().then(() => this.publish(identity)).catch(() => {
                // Preview failures cannot take the source offline. A later requested page can retry.
            }).finally(() => { this.running.delete(key); this.pump(); });
            this.running.set(key, { identity, work });
        }
    }
    private async publish(identity: ImageIdentity): Promise<void> {
        if (this.closed || this.lifetime.aborted || this.acceptedRevision !== this.revision) return;
        const state = this.index.cached<NativeImageState>(itemKey(identity.turnId, identity.itemId));
        if (!state || !hasImages(state.item) || this.projected(state)) return;
        const expected = fingerprint(state.item), epoch = this.index.epoch, revision = this.revision;
        if (!this.content(state.turnId, state.item) && !await this.prepare(state)) return;
        // This also repairs successful caches left unprojected by a released older reader.
        if (this.current(state, expected, epoch, revision)) this.onPrepared(identity);
    }
    private current(state: NativeImageState, expected: string, epoch: string, revision: number): boolean {
        if (this.closed || this.lifetime.aborted) return false;
        const accepted = this.index.cached<NativeImageState>(itemKey(state.turnId, state.item.id));
        return this.revision === revision && this.acceptedRevision === revision && this.index.epoch === epoch && accepted !== undefined && fingerprint(accepted.item) === expected;
    }
    private async prepare(state: NativeImageState): Promise<NativeImageState | undefined> {
        const expected = fingerprint(state.item), epoch = this.index.epoch, revision = this.revision;
        const signal = AbortSignal.any([this.lifetime, this.revisionLifetime.signal]);
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
                        const response = await waitFor(this.readSourceFile(value.path, signal), signal);
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
        if (this.closed) throw new SourceError('DISPOSED', 'The native image source was closed.');
        if (this.acceptedRevision !== this.revision) throw new SourceError('STALE_VERSION', 'The source must reconcile its rewritten history before an image can be read.');
        if (!imageResourcePath.test(path)) throw new SourceError('INVALID_REQUEST', 'Only an image referenced by this conversation can be read.');
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
    async dispose(): Promise<void> {
        this.closed = true; this.queued.clear();
        this.revisionLifetime.abort(new SourceError('DISPOSED', 'The native image source was closed.'));
        await Promise.all([...this.running.values()].map(value => value.work));
    }
}
