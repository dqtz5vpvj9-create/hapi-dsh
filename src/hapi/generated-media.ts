import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { HapiRequestError } from '../codex/contracts.ts'
import type { NativeArtifactBlock } from '../codex/content.ts'
import type { SourceGeneratedMedia } from '../hapi-agent/generated-media-types.ts'
import type { HapiClient } from './client.ts'

/** Matches the pinned source registry's MAX_GENERATED_IMAGE_BYTES. */
export const MAX_SOURCE_GENERATED_MEDIA = 25 * 1024 * 1024
const rasters = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function rasterType(data: Uint8Array): ImageMediaType | undefined {
    const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 16))
    if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
    if (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif'
    if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
    return undefined
}
function basename(value: string): string {
    return value.replace(/[\r\n\0]/g, '').split(/[\\/]/).at(-1)?.trim() || 'generated-media'
}

/**
 * The original Hub authorizes the source session and routes the opaque media
 * ID to its Runner. Never interpret it as a local path, artifact ID or URL.
 * Only validated immutable references are returned to the official renderer.
 */
export function sourceGeneratedMediaImporter(store: AttachmentStore, client: Pick<HapiClient, 'getSession' | 'readBinary'>) {
    return async (sourceSessionId: string, media: SourceGeneratedMedia): Promise<NativeArtifactBlock> => {
        if (!sourceSessionId || sourceSessionId.length > 512 || !media.imageId || media.imageId.length > 4096
            || /[\r\n\0]/.test(sourceSessionId + media.imageId)) throw new HapiRequestError('Invalid original generated media identity', 'rejected', 400)
        const source = await client.getSession(sourceSessionId)
        if (source.id !== sourceSessionId) throw new HapiRequestError('Generated media source identity changed', 'rejected', 409)
        const result = await client.readBinary(`/api/sessions/${encodeURIComponent(sourceSessionId)}/generated-images/${encodeURIComponent(media.imageId)}`,
            { maxBytes: MAX_SOURCE_GENERATED_MEDIA })
        if (result.status !== 200 || result.data.byteLength === 0 || result.data.byteLength > MAX_SOURCE_GENERATED_MEDIA) {
            throw new HapiRequestError('The original generated media response is empty, partial or too large', 'indeterminate', result.status)
        }
        // The authenticated binary response owns the media type. Transcript
        // hints cannot turn HTML/JSON into an image or bypass DSH validation.
        const mime = result.mimeType === 'application/octet-stream' ? rasterType(result.data) ?? result.mimeType : result.mimeType
        const name = basename(result.fileName && result.fileName !== 'native-resource' ? result.fileName : media.fileName)
        if (rasters.has(mime)) return { type: 'image', attachment: await store.saveImage({ data: result.data, mediaType: mime as ImageMediaType, name }) }
        // Video, audio, PDF and other original media stay exact downloadable
        // files. Their normal official file/plugin views decide presentation.
        return { type: 'file', attachment: await store.saveFile({ data: result.data, name }) }
    }
}
