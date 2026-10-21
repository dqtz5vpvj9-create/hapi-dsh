import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SourcePart } from './parser.ts'

/** Byte references remain in the display log without pretending that the
 * pinned official assistant renderer knows how to render file blocks. */
export const sourceGeneratedMediaRecordSchema = z.object({
    messageId: z.string().min(1), sourceRowId: z.string().min(1), surfaceSeq: z.number().int().nonnegative(),
    turn: z.number().int().positive(), step: z.number().int().positive(),
    files: z.array(z.object({
        blockIndex: z.number().int().nonnegative(), imageId: z.string().min(1).max(4096),
        fileName: z.string(), mimeType: z.string(),
        attachment: z.object({ attachmentId: z.string().min(1), name: z.string(), bytes: z.number().int().nonnegative() }),
    })).min(1),
})
export type SourceGeneratedMediaRecord = z.infer<typeof sourceGeneratedMediaRecordSchema>

declare module '@deepseek-ai/dsh-session/types' {
    interface PluginRecordMap { 'plugin:hapi-dsh/generated-media': SourceGeneratedMediaRecord }
}

/** Only successfully imported generated files move to this owned extension.
 * Images and failure explanations keep the unchanged official body. */
export function projectGeneratedMedia(parts: readonly SourcePart[], content: readonly ContentBlock[]): {
    content: readonly ContentBlock[]; files: SourceGeneratedMediaRecord['files'];
} {
    const files: SourceGeneratedMediaRecord['files'] = []
    const projected = content.filter((block, blockIndex) => {
        const part = parts[blockIndex]
        if (part?.type !== 'generated-media' || block.type !== 'file') return true
        files.push({ blockIndex, imageId: part.media.imageId, fileName: block.attachment.name,
            mimeType: part.media.mimeType ?? 'application/octet-stream', attachment: block.attachment })
        return false
    })
    return { content: files.length ? projected : content, files }
}

export function sourceGeneratedMediaRecordOf(event: { type: string; data: unknown }): SourceGeneratedMediaRecord | null {
    if (event.type !== 'plugin:hapi-dsh/generated-media') return null
    const parsed = sourceGeneratedMediaRecordSchema.safeParse(event.data)
    return parsed.success ? parsed.data : null
}
