import { z } from 'zod'

/** The source sends partialResult independently of the eventual tool result.
 * Keep that distinction in a plugin-owned event, never a tool/result event. */
export const sourceToolProgressPayloadSchema = z.json()
const coordinates = {
    callId: z.string().min(1), sourceCallId: z.string().min(1), toolName: z.string(),
    sourceRowId: z.string().min(1), createdAt: z.number().finite().nonnegative(),
    turn: z.number().int().positive(), step: z.number().int().positive(),
}
export const sourceToolProgressSchema = z.discriminatedUnion('phase', [
    z.object({ ...coordinates, phase: z.literal('progress'), payload: sourceToolProgressPayloadSchema }),
    z.object({ ...coordinates, phase: z.literal('result'), isError: z.boolean() }),
    z.object({ ...coordinates, phase: z.literal('turn-ended'), payload: sourceToolProgressPayloadSchema,
        reason: z.enum(['completed', 'aborted', 'error']) }),
])
export type SourceToolProgressPayload = z.infer<typeof sourceToolProgressPayloadSchema>
export type SourceToolProgress = z.infer<typeof sourceToolProgressSchema>

declare module '@deepseek-ai/dsh-session/types' {
    interface PluginRecordMap { 'plugin:hapi-dsh/tool-progress': SourceToolProgress }
}

export function sourceToolProgressOf(event: { type: string; data: unknown }): SourceToolProgress | null {
    if (event.type !== 'plugin:hapi-dsh/tool-progress') return null
    const parsed = sourceToolProgressSchema.safeParse(event.data)
    return parsed.success ? parsed.data : null
}
