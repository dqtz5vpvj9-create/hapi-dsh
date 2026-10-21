import { z } from 'zod'

export const sourceReviewFindingSchema = z.object({
    title: z.string(), body: z.string(), priority: z.number().finite().nullable(),
    confidenceScore: z.number().finite().nullable(), filePath: z.string().nullable(),
    lineStart: z.number().finite().nullable(), lineEnd: z.number().finite().nullable(),
})
export const sourceCodexReviewSchema = z.object({
    findings: z.array(sourceReviewFindingSchema), overallCorrectness: z.string().nullable(),
    overallExplanation: z.string().nullable(), overallConfidenceScore: z.number().finite().nullable(),
})
export type SourceCodexReview = z.infer<typeof sourceCodexReviewSchema>
export type SourceReviewFinding = z.infer<typeof sourceReviewFindingSchema>
export const sourceCodexReviewRecordSchema = z.object({
    messageId: z.string().min(1), sourceRowId: z.string().min(1), surfaceSeq: z.number().int().nonnegative(),
    turn: z.number().int().positive(), step: z.number().int().positive(), review: sourceCodexReviewSchema,
})
export type SourceCodexReviewRecord = z.infer<typeof sourceCodexReviewRecordSchema>

declare module '@deepseek-ai/dsh-session/types' {
    interface PluginRecordMap { 'plugin:hapi-dsh/codex-review': SourceCodexReviewRecord }
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Match the pinned HAPI final JSON convention, not arbitrary prose or code
 * fences. Original text is retained by the official assistant message. */
export function parseSourceCodexReview(message: string): SourceCodexReview | null {
    const trimmed = message.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
    let raw: unknown
    try { raw = JSON.parse(trimmed) } catch { return null }
    const value = object(raw)
    if (!value || !(Array.isArray(value.findings) || 'overall_correctness' in value || 'overallCorrectness' in value
        || 'overall_explanation' in value || 'overallExplanation' in value)) return null
    const findings = Array.isArray(value.findings) ? value.findings.flatMap((raw): SourceReviewFinding[] => {
        const finding = object(raw), title = text(finding?.title), body = text(finding?.body)
        if (!finding || !title || !body) return []
        const location = object(finding.code_location) ?? object(finding.codeLocation)
        const lines = object(location?.line_range) ?? object(location?.lineRange)
        return [{ title, body, priority: number(finding.priority), confidenceScore: number(finding.confidence_score ?? finding.confidenceScore),
            filePath: text(location?.absolute_file_path ?? location?.absoluteFilePath ?? location?.path),
            lineStart: number(lines?.start), lineEnd: number(lines?.end) }]
    }) : []
    const overallCorrectness = text(value.overall_correctness ?? value.overallCorrectness)
    const overallExplanation = text(value.overall_explanation ?? value.overallExplanation)
    const overallConfidenceScore = number(value.overall_confidence_score ?? value.overallConfidenceScore)
    if (!findings.length && !overallCorrectness && !overallExplanation && overallConfidenceScore === null) return null
    return { findings, overallCorrectness, overallExplanation, overallConfidenceScore }
}

/** Pi cumulative snapshots remain ordinary text, even when their current
 * prefix happens to be a complete review-shaped JSON object. */
export function sourceStandaloneReview(message: string, provenance: { streamSnapshot?: unknown; id?: unknown }): SourceCodexReview | null {
    if (provenance.streamSnapshot === true || typeof provenance.id === 'string' && /^pi-.+-turn-\d+-message-\d+-text-\d+$/.test(provenance.id)) return null
    return parseSourceCodexReview(message)
}

export function sourceCodexReviewOf(event: { type: string; data: unknown }): SourceCodexReviewRecord | null {
    if (event.type !== 'plugin:hapi-dsh/codex-review') return null
    const parsed = sourceCodexReviewRecordSchema.safeParse(event.data)
    return parsed.success ? parsed.data : null
}
