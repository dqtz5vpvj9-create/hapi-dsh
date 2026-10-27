/** Wire-only bounded source navigation results. Transcript bodies stay request-local. */
import { z } from 'zod'

const position = z.object({ at: z.number().finite(), seq: z.number().int().nonnegative() })
export const sourceHistoryOutlineEntrySchema = z.object({
    turn: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    prompt: z.string().max(16_384),
    response: z.string().max(16_384),
    messageId: z.string().min(1).max(512),
    at: z.number().finite(),
    sourceSeq: z.number().int().nonnegative(),
})
export const sourceHistoryOutlineValueSchema = z.object({
    entries: z.array(sourceHistoryOutlineEntrySchema),
    seedIndex: z.number().int().nonnegative(),
    firstTurn: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative().optional(),
    complete: z.boolean().optional(),
    indexing: z.boolean().optional(),
    unreadable: z.boolean().optional(),
    scannedThrough: z.number().int().nonnegative().optional(),
    headSeq: z.number().int().nonnegative().optional(),
    head: z.object({ messageId: z.string().min(1).max(512), at: z.number().finite(), seq: z.number().int().nonnegative() }).optional(),
})
export type SourceHistoryOutlineValue = z.infer<typeof sourceHistoryOutlineValueSchema>

/** One bounded outline page. The preview already reflects every page read so far. */
export const sourceHistoryOutlinePageRequestSchema = z.object({
    sessionId: z.string().min(1).max(512),
    operationId: z.string().uuid().optional(),
    beforeAt: z.number().finite().optional(),
    beforeSeq: z.number().int().nonnegative().optional(),
    epoch: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).optional(),
}).strict()
export type SourceHistoryOutlinePageRequest = z.infer<typeof sourceHistoryOutlinePageRequestSchema>

export const sourceHistoryOutlinePageValueSchema = sourceHistoryOutlineValueSchema.extend({
    cursor: position.nullable().optional(),
    hasMore: z.boolean().optional(),
    pageSize: z.number().int().nonnegative().optional(),
})
export type SourceHistoryOutlinePageValue = z.infer<typeof sourceHistoryOutlinePageValueSchema>

export const sourceHistoryWindowRequestSchema = z.object({
    sessionId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512).optional(),
    epoch: z.number().int().nonnegative().optional(),
    cursorMessageId: z.string().min(1).max(512).optional(),
    radius: z.number().int().min(1).max(99).optional(),
    beforeAt: z.number().finite().optional(),
    beforeSeq: z.number().int().nonnegative().optional(),
    afterAt: z.number().finite().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
    startSeq: z.number().int().nonnegative().optional(),
    endSeq: z.number().int().nonnegative().optional(),
    fromOldest: z.boolean().optional(),
    /** One bounded backward page for pre-exposure viewport admission. */
    limit: z.number().int().min(1).max(200).optional(),
}).strict().superRefine((value, ctx) => {
    const hasMessage = value.messageId !== undefined
    const hasBefore = value.beforeAt !== undefined || value.beforeSeq !== undefined
    const hasAfter = value.afterAt !== undefined || value.afterSeq !== undefined
    const hasOldest = value.fromOldest === true
    if (Number(hasMessage) + Number(hasBefore) + Number(hasAfter) + Number(hasOldest) !== 1) ctx.addIssue({ code: 'custom', message: 'exactly one source window route is required' })
    if ((value.beforeAt === undefined) !== (value.beforeSeq === undefined)) ctx.addIssue({ code: 'custom', message: 'beforeAt and beforeSeq must be supplied together' })
    if ((value.afterAt === undefined) !== (value.afterSeq === undefined)) ctx.addIssue({ code: 'custom', message: 'afterAt and afterSeq must be supplied together' })
})
export type SourceHistoryWindowRequest = z.infer<typeof sourceHistoryWindowRequestSchema>
export const sourceHistoryWindowValueSchema = z.object({
    records: z.array(z.unknown()),
    hasMoreBefore: z.boolean(),
    hasMoreAfter: z.boolean(),
    before: position.nullable(),
    after: position.nullable(),
    epoch: z.number().int().nonnegative().optional(),
    beforeMessageId: z.string().min(1).max(512).optional(),
    afterMessageId: z.string().min(1).max(512).optional(),
})
export type SourceHistoryWindowValue = z.infer<typeof sourceHistoryWindowValueSchema>
