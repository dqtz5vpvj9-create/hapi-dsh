/** Offline input contract, not a new Hub API. Source response/query shapes:
 * HAPI 0f8ef697 shared/src/apiTypes.ts MessagesResponse/MessagesQuerySchema.
 * Neither input values nor validation issues are returned to the caller. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { messagesSchema } from '../src/hapi/schemas.ts'
import { envelopeFor } from '../src/codex/native.ts'
import { DiagnosticInputError, diagnoseMessageRows, readDiagnosticJson, readDiagnosticSession } from './source-history-diagnostics.ts'

const captureSchema = z.object({ session: z.unknown(), pages: z.array(z.unknown()).min(1),
    requests: z.array(z.unknown()).optional() }).strict()
const pageSchema = messagesSchema.extend({ page: messagesSchema.shape.page.extend({
    limit: z.number().int().min(1).max(200), epoch: z.number().int().nonnegative(),
}) })
// Query-string numbers may be captured as strings or JSON numbers. bounded
// retains its actual HTTP values; URLs, headers and credentials are not part
// of this fixed optional request-evidence contract.
const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(), beforeAt: z.coerce.number().int().min(0).optional(),
    afterSeq: z.coerce.number().int().min(1).optional(), afterAt: z.coerce.number().int().min(0).optional(),
    untilSeq: z.coerce.number().int().min(1).optional(), untilAt: z.coerce.number().int().min(0).optional(),
    epoch: z.coerce.number().int().min(0).optional(), bounded: z.enum(['true', 'false']).optional(),
}).strict()
    .refine(q => (q.beforeAt === undefined) === (q.beforeSeq === undefined))
    .refine(q => (q.afterAt === undefined) === (q.afterSeq === undefined))
    .refine(q => (q.untilAt === undefined) === (q.untilSeq === undefined))
    .refine(q => q.beforeAt === undefined || q.afterAt === undefined)
    .refine(q => q.untilAt === undefined || q.afterAt !== undefined)
    .refine(q => q.epoch === undefined || q.beforeAt !== undefined || q.afterAt !== undefined)
type Page = z.infer<typeof pageSchema>
type Query = z.infer<typeof querySchema>
type Position = { at: number; seq: number }
const compare = (a: Position, b: Position) => a.at - b.at || a.seq - b.seq
function pair(at: number | null, seq: number | null): Position | null {
    return at === null || seq === null ? null : { at, seq }
}
function same(a: Position | null, b: Position | null): boolean {
    return a === null ? b === null : b !== null && compare(a, b) === 0
}
function position(row: Page['messages'][number]): Position | null {
    return row.seq === null ? null : { at: row.invokedAt ?? row.createdAt, seq: row.seq }
}
function usable(cursor: Position | null): boolean {
    return cursor !== null && Number.isInteger(cursor.at) && cursor.at >= 0 && Number.isInteger(cursor.seq) && cursor.seq >= 1
}

/** Check only the final uninterrupted capture segment. Epoch resets, a new
 * latest request, and after-direction captures never merge into that history. */
function inspectChain(pages: readonly Page[], requests: readonly Query[] | undefined) {
    const counts = { emptyNativePages: 0, queueOverlayRows: 0, otherNullSequenceRows: 0,
        nativeRowsBeyondLimit: 0, rowOrderViolations: 0, cursorPairViolations: 0, rowBoundaryViolations: 0,
        missingOrUnusableBeforeCursors: 0, repeatedBeforeCursors: 0, nonDescendingLinks: 0,
        followedReportedBeginning: 0, unexpectedDirections: 0, snapshotHeadChanges: 0, snapshotHeadRegressions: 0,
        repeatedNativeMessageIds: 0, changedRepeatedNativeRows: 0, requestDirectionMismatches: 0,
        requestLimitMismatches: 0, requestEpochMismatches: 0, requestCursorLinkMismatches: 0, requestEpochNotPinned: 0 }
    const cursors = new Set<string>(), ids = new Map<string, string>()
    for (let index = 0; index < pages.length; index++) {
        const response = pages[index]!, page = response.page, previous = pages[index - 1]?.page, query = requests?.[index]
        const native = response.messages.filter(row => row.seq !== null)
        const positions = native.map(row => position(row)!)
        if (!native.length) counts.emptyNativePages++
        for (const row of response.messages) {
            if (row.seq !== null) continue
            if (envelopeFor(row.content)?.role === 'user' && row.invokedAt == null) counts.queueOverlayRows++
            else counts.otherNullSequenceRows++
        }
        // NativeQueuePage appends seq:null inputs without changing page.limit
        // or native cursors. They are never checked as native page positions.
        counts.nativeRowsBeyondLimit += Math.max(0, native.length - page.limit)
        for (let i = 1; i < positions.length; i++) if (compare(positions[i - 1]!, positions[i]!) >= 0) counts.rowOrderViolations++
        for (const row of native) {
            const serialized = createHash('sha256').update(JSON.stringify(row)).digest('hex'), prior = ids.get(row.id)
            if (prior !== undefined) { counts.repeatedNativeMessageIds++; if (prior !== serialized) counts.changedRepeatedNativeRows++ }
            ids.set(row.id, serialized)
        }
        for (const [at, seq] of [[page.nextBeforeAt, page.nextBeforeSeq], [page.nextAfterAt, page.nextAfterSeq],
            [page.snapshotHeadAt, page.snapshotHeadSeq]]) if ((at === null) !== (seq === null)) counts.cursorPairViolations++
        const before = pair(page.nextBeforeAt, page.nextBeforeSeq), after = pair(page.nextAfterAt, page.nextAfterSeq)
        const head = pair(page.snapshotHeadAt, page.snapshotHeadSeq)
        if (positions.length && (!same(before, positions[0]!) || !same(after, positions.at(-1)!))) counts.rowBoundaryViolations++
        if (head && positions.some(value => compare(value, head) > 0)) counts.rowBoundaryViolations++
        if (page.hasMore && page.direction !== 'after') {
            if (!usable(before)) counts.missingOrUnusableBeforeCursors++
            if (before) {
                const key = `${before.at}:${before.seq}`
                if (cursors.has(key)) counts.repeatedBeforeCursors++
                cursors.add(key)
            }
        }
        if (page.direction !== (index === 0 ? 'latest' : 'before')) counts.unexpectedDirections++
        if (previous) {
            const boundary = pair(previous.nextBeforeAt, previous.nextBeforeSeq), priorHead = pair(previous.snapshotHeadAt, previous.snapshotHeadSeq)
            if (!previous.hasMore) counts.followedReportedBeginning++
            if (boundary && (positions.some(value => compare(value, boundary) >= 0)
                || page.hasMore && before && compare(before, boundary) >= 0)) counts.nonDescendingLinks++
            if (!same(head, priorHead)) counts.snapshotHeadChanges++
            if (head && priorHead && compare(head, priorHead) < 0) counts.snapshotHeadRegressions++
            if (query) {
                if (query.beforeAt !== previous.nextBeforeAt || query.beforeSeq !== previous.nextBeforeSeq) counts.requestCursorLinkMismatches++
                if (query.epoch === undefined) counts.requestEpochNotPinned++
                else if (query.epoch !== previous.epoch) counts.requestEpochMismatches++
            }
        }
        if (query) {
            const expected = page.reset ? 'latest' : query.afterAt !== undefined ? 'after' : query.beforeAt !== undefined ? 'before' : 'latest'
            if (page.direction !== expected) counts.requestDirectionMismatches++
            if (page.limit !== (query.limit ?? 50)) counts.requestLimitMismatches++
            if (query.epoch !== undefined && !page.reset && query.epoch !== page.epoch) counts.requestEpochMismatches++
        }
    }
    const compatible = pages[0]!.page.direction === 'latest' && [counts.nativeRowsBeyondLimit, counts.rowOrderViolations,
        counts.cursorPairViolations, counts.rowBoundaryViolations, counts.missingOrUnusableBeforeCursors,
        counts.repeatedBeforeCursors, counts.nonDescendingLinks, counts.followedReportedBeginning, counts.unexpectedDirections,
        counts.otherNullSequenceRows, counts.snapshotHeadRegressions, counts.requestDirectionMismatches,
        counts.requestLimitMismatches, counts.requestEpochMismatches, counts.requestCursorLinkMismatches].every(value => value === 0)
    return { ...counts, chainCompatible: compatible, requestsProvided: requests !== undefined,
        requestLinksVerified: requests !== undefined && compatible && counts.requestEpochNotPinned === 0,
        reachedReportedBeginning: pages.at(-1)!.page.direction !== 'after' && !pages.at(-1)!.page.hasMore,
        capturedHistoryCompletenessProven: false as const }
}

export function diagnoseNativePages(json: string) {
    const captured = captureSchema.safeParse(readDiagnosticJson(json))
    if (!captured.success) throw new DiagnosticInputError('unsupported-native-pages-envelope')
    const session = readDiagnosticSession(captured.data.session)
    const pages = captured.data.pages.map(raw => {
        const result = pageSchema.safeParse(raw)
        if (!result.success) throw new DiagnosticInputError('invalid-native-page-schema')
        return result.data
    })
    let requests: Query[] | undefined
    if (captured.data.requests !== undefined) {
        if (captured.data.requests.length !== pages.length) throw new DiagnosticInputError('invalid-native-requests-schema')
        requests = captured.data.requests.map(raw => {
            const result = querySchema.safeParse(raw)
            if (!result.success) throw new DiagnosticInputError('invalid-native-requests-schema')
            return result.data
        })
    }
    let start = 0, segments = 1, resets = 0, epochChanges = 0, headChanges = 0
    const epochs = new Set<number>()
    for (let index = 0; index < pages.length; index++) {
        const page = pages[index]!.page, previous = pages[index - 1]?.page
        epochs.add(page.epoch)
        if (page.reset) resets++
        if (!previous) continue
        if (page.epoch !== previous.epoch) epochChanges++
        else if (page.snapshotHeadAt !== previous.snapshotHeadAt || page.snapshotHeadSeq !== previous.snapshotHeadSeq) headChanges++
        if (page.reset || page.epoch !== previous.epoch || page.direction !== 'before') { start = index; segments++ }
    }
    const analyzed = pages.slice(start), rows = analyzed.flatMap(response => response.messages)
    const statistics = diagnoseMessageRows(session, rows, json)
    const evidence = inspectChain(analyzed, requests?.slice(start))
    const pageSizes = captured.data.pages.map(page => Buffer.byteLength(JSON.stringify(page)))
    return {
        diagnosticVersion: 1 as const, inputSchema: 'hapi-native-message-pages-v1' as const,
        coverage: 'source-messages-api-paged-snapshot' as const, statisticsScope: 'last-uninterrupted-capture-segment' as const,
        limitations: ['parser-candidates-are-not-live-renderer-verification', 'capture-completeness-unproven',
            'response-provenance-and-session-binding-not-independently-verifiable', 'native-head-may-advance-during-capture',
            'counts-describe-received-row-occurrences', ...(requests ? [] : ['request-cursors-not-recorded']),
            ...(session.metadata?.codexNativeSession === true ? [] : ['native-rpc-routing-not-advertised'])],
        ...statistics,
        bytes: { ...statistics.bytes, pagesTotal: pageSizes.reduce((a, b) => a + b, 0), largestPage: pageSizes.reduce((a, b) => Math.max(a, b), 0) },
        pagination: { capturedPages: pages.length, analyzedPages: analyzed.length, excludedEarlierPages: start,
            capturedRows: pages.reduce((sum, page) => sum + page.messages.length, 0), captureSegments: segments,
            distinctEpochs: epochs.size, epochChanges, resetPages: resets, sameEpochHeadChanges: headChanges, ...evidence },
    }
}

export type NativePagesDiagnostic = ReturnType<typeof diagnoseNativePages>
