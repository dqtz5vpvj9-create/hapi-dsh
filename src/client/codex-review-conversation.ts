import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sourceCodexReviewOf, type SourceCodexReviewRecord } from '../hapi-agent/codex-review.ts'

export const SOURCE_REVIEW_DATA = 'hapi-codex-review'
export type SourceReviewTurn = readonly SourceCodexReviewRecord[]
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ConversationTurnDataMap { 'hapi-codex-review': SourceReviewTurn }
}
function add(state: SourceReviewTurn, record: SourceCodexReviewRecord | null): SourceReviewTurn {
    if (!record) return state
    const previous = state.find(value => value.messageId === record.messageId)
    if (previous && JSON.stringify(previous) === JSON.stringify(record)) return state
    return [...state.filter(value => value.messageId !== record.messageId), record].sort((a, b) => a.surfaceSeq - b.surfaceSeq)
}

/** No chat view target is claimed: the original final JSON remains official
 * assistant content and the original Copy action remains unchanged. */
export const sourceReviewDefinition: ConversationNodeDefinition<SourceReviewTurn> = {
    kind: SOURCE_REVIEW_DATA,
    match(event) { const record = sourceCodexReviewOf(event); return record ? { id: String(record.turn), role: 'start' } : null },
    start(_context, match) { return add([], sourceCodexReviewOf(match.event)) },
    update(context, match) { return add(context.state, sourceCodexReviewOf(match.event)) },
    buildLocationData(context, scope, previous) {
        if (scope !== 'turn') return null
        const value = context.state ?? context.matches.reduce((state, match) => add(state, sourceCodexReviewOf(match.event)), [] as SourceReviewTurn)
        if (!value.length) return null
        if (previous?.kind === 'turn' && previous.key === SOURCE_REVIEW_DATA && previous.value === value) return previous
        return { kind: 'turn', turn: value[0]!.turn, key: SOURCE_REVIEW_DATA, value }
    },
}
