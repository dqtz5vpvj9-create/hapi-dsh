/** Source-local model inputs. Upload receipts and original files remain immutable. */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { SourceError } from './errors.ts';

// The current native model path resizes images above 6000px even with original
// detail. Crop instead of shrinking text. Adjacent pages share 128 source pixels.
export const NATIVE_IMAGE_PAGE_SIDE = 6000;
export const NATIVE_IMAGE_PAGE_OVERLAP = 128;
export const NATIVE_IMAGE_PAGE_LIMIT = 32;
// Base64 + JSON stays below the native carrier's 16MiB frame limit.
export const NATIVE_IMAGE_PAGE_BYTES = 11 * 1024 * 1024;
export interface NativeImagePage { path: string; sha256: string; bytes: number; x: number; y: number; width: number; height: number }
export interface NativeImagePlan { version: 1; sha256: string; width: number; height: number; pages: NativeImagePage[] }
const hash = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Receipt validation and the operation lock precede this source filesystem read. */
export async function prepareNativeImage(directory: string, identity: readonly string[], path: string, signal?: AbortSignal): Promise<NativeImagePlan> {
    signal?.throwIfAborted();
    const source = await readFile(path), image = sharp(source, { limitInputPixels: 64_000_000, animated: false }).autoOrient();
    const metadata = await image.metadata();
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
    const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
    if (!width || !height) throw new SourceError('INVALID_REQUEST', 'The source image has no dimensions.');
    const sha256 = hash(source), pages: NativeImagePage[] = [];
    if (width <= NATIVE_IMAGE_PAGE_SIDE && height <= NATIVE_IMAGE_PAGE_SIDE)
        return { version: 1, sha256, width, height, pages: [{ path, sha256, bytes: source.length, x: 0, y: 0, width, height }] };
    const step = NATIVE_IMAGE_PAGE_SIDE - NATIVE_IMAGE_PAGE_OVERLAP;
    const rectangles: Array<{ left: number; top: number; width: number; height: number }> = [];
    for (let top = 0; top < height; top += step) {
        for (let left = 0; left < width; left += step) {
            rectangles.push({ left, top, width: Math.min(NATIVE_IMAGE_PAGE_SIDE, width - left), height: Math.min(NATIVE_IMAGE_PAGE_SIDE, height - top) });
            if (rectangles.length > NATIVE_IMAGE_PAGE_LIMIT) throw new SourceError('CAPACITY_EXCEEDED', 'This image needs too many model input pages. Nothing was sent.', 'not-dispatched');
            if (left + NATIVE_IMAGE_PAGE_SIDE >= width) break;
        }
        if (top + NATIVE_IMAGE_PAGE_SIDE >= height) break;
    }
    const destination = join(directory, 'image-pages', hash(JSON.stringify(identity)));
    await mkdir(destination, { recursive: true, mode: 0o700 });
    let bytes = 0;
    for (const rectangle of rectangles) {
        signal?.throwIfAborted();
        // High-quality WebP avoids expanding photographic JPEG screenshots into
        // large lossless PNG transport frames. There is no pixel resampling.
        const pipeline = image.clone().extract(rectangle);
        const data = metadata.hasAlpha ? await pipeline.png().toBuffer()
            : await pipeline.webp({ quality: 95 }).toBuffer();
        bytes += data.length;
        if (bytes > NATIVE_IMAGE_PAGE_BYTES) throw new SourceError('CAPACITY_EXCEEDED', 'The model image pages exceed the source input budget. Nothing was sent.', 'not-dispatched');
        const pageHash = hash(data), target = join(destination, `${pages.length}-${pageHash}.${metadata.hasAlpha ? 'png' : 'webp'}`);
        await writeFileAtomic(target, data, { mode: 0o600 });
        pages.push({ path: target, sha256: pageHash, bytes: data.length, x: rectangle.left, y: rectangle.top, width: rectangle.width, height: rectangle.height });
    }
    signal?.throwIfAborted();
    return { version: 1, sha256, width, height, pages };
}

/** Reuse the pinned bytes; a retry never generates a different input plan. */
export async function validateNativeImagePlan(plan: NativeImagePlan, signal?: AbortSignal): Promise<void> {
    for (const page of plan.pages) {
        signal?.throwIfAborted();
        const bytes = await readFile(page.path);
        if (bytes.length !== page.bytes || hash(bytes) !== page.sha256) throw new SourceError('INVALID_REQUEST', 'The retained model image page changed. Nothing was sent.');
    }
}
