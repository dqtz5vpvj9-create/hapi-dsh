/** Readable native tool previews and source-authorized detail pages. */
import { z } from 'zod';
export const SOURCE_EVENT_MAX_BYTES = 4 * 1024 * 1024;
export const SOURCE_PAGE_MAX_BYTES = 8 * 1024 * 1024;
// A native item has eight schema-defined event positions. Its inline material
// must leave room for the complete lifecycle/call dependency closure.
export const TOOL_INLINE_BYTES = Math.floor(SOURCE_EVENT_MAX_BYTES / 8);
export const TOOL_PREVIEW_BYTES = Math.floor(TOOL_INLINE_BYTES / 8);
export const TOOL_DETAIL_CHUNK_BYTES = TOOL_PREVIEW_BYTES;
export const TOOL_DETAIL_MIME = 'application/vnd.hhpi.tool-detail+json';
export const toolDetailSchema = z.strictObject({ kind: z.literal('hhpi-tool-detail'), ref: z.string().uuid(),
    revision: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), part: z.enum(['input', 'output']) });
export type ToolDetail = z.infer<typeof toolDetailSchema>;
export const toolDetailPageSchema = z.strictObject({ ref: z.string().uuid(), revision: z.number().int().nonnegative(),
    part: z.enum(['input', 'output']), offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
    total: z.number().int().nonnegative(), bytesBase64: z.string() });
export type ToolDetailPage = z.infer<typeof toolDetailPageSchema>;
export interface ToolDetailEnvelope { _hhpiDetail: ToolDetail; preview: string }
export function toolDetailEnvelope(value: unknown): ToolDetailEnvelope | undefined {
    if (typeof value !== 'object' || value === null || !('_hhpiDetail' in value) || !('preview' in value) || typeof value.preview !== 'string') return;
    const detail = toolDetailSchema.safeParse(value._hhpiDetail);
    return detail.success ? { _hhpiDetail: detail.data, preview: value.preview } : undefined;
}
export const toolDetailPath = (detail: ToolDetail, offset = 0): string => `detail:${detail.ref}:${detail.revision}:${offset}`;
