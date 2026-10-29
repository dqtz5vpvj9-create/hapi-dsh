/** Wire-only bounded source navigation results. Transcript bodies stay request-local. */
import { z } from 'zod'
import type { SourceFrame } from './shared/source-frames.ts'

/** Keep streamed source-history decode work small enough to yield between frames. */
export const SOURCE_HISTORY_FRAME_CHUNK_SIZE = 32

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
const sourceFrameSchema = z.object({
    key: z.string(),
    source: position.extend({ messageId: z.string() }).optional(),
    contentRevision: z.number().int().nonnegative().optional(),
    turnKey: z.string().optional(), stepKey: z.string().optional(),
    event: z.custom<SourceFrame['event']>(), transient: z.literal(true).optional(),
    refs: z.object({ surfaceKey: z.string().optional(), sourceEventKeys: z.array(z.string()).optional(),
        surfaceOp: z.object({ startKey: z.string().optional(), endKey: z.string().optional() }).optional() }).optional(),
})
export const sourceHistoryWindowValueSchema = z.object({
    records: z.array(z.unknown()),
    frames: z.array(sourceFrameSchema).optional(),
    hasMoreBefore: z.boolean(),
    hasMoreAfter: z.boolean(),
    before: position.nullable(),
    after: position.nullable(),
    epoch: z.number().int().nonnegative().optional(),
    beforeMessageId: z.string().min(1).max(512).optional(),
    afterMessageId: z.string().min(1).max(512).optional(),
})
export type SourceHistoryWindowValue = z.infer<typeof sourceHistoryWindowValueSchema>

/** One page read transported as small frame batches and a final cursor record. */
export const sourceHistoryWindowPageStreamItemSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('frames'), frames: z.array(sourceFrameSchema).min(1).max(SOURCE_HISTORY_FRAME_CHUNK_SIZE) }).strict(),
    z.object({ kind: z.literal('complete'), value: sourceHistoryWindowValueSchema.omit({ records: true, frames: true }) }).strict(),
])
export type SourceHistoryWindowPageStreamItem = z.infer<typeof sourceHistoryWindowPageStreamItemSchema>

/** Minimal newest-window head probe: the open path needs no directory page. */
export const sourceHistoryHeadRequestSchema = z.object({ sessionId: z.string().min(1).max(512) }).strict()
export type SourceHistoryHeadRequest = z.infer<typeof sourceHistoryHeadRequestSchema>

export const sourceHistoryHeadValueSchema = z.object({
    messageId: z.string().min(1).max(512),
    at: z.number().finite(),
    seq: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative().optional(),
}).strict()
export type SourceHistoryHeadValue = z.infer<typeof sourceHistoryHeadValueSchema>
