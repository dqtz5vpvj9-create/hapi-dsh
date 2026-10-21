import type { ConversationNodeDefinition, ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sourceNotifySummaryOf, type SourceNotifySummary } from '../hapi-agent/notify-summary.ts'

export const SOURCE_SUMMARY_DATA = 'hapi-notify-summary'
export type SourceSummaryTurn = readonly SourceNotifySummary[]

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ConversationTurnDataMap { 'hapi-notify-summary': SourceSummaryTurn }
}

function append(state: SourceSummaryTurn, record: SourceNotifySummary | null): SourceSummaryTurn {
    if (!record) return state
    const existing = state.find(value => value.messageId === record.messageId)
    if (existing && JSON.stringify(existing) === JSON.stringify(record)) return state
    return [...state.filter(value => value.messageId !== record.messageId), record]
        .sort((a, b) => a.surfaceSeq - b.surfaceSeq)
}

function records(context: ConversationNodeContext<SourceSummaryTurn>): SourceSummaryTurn {
    if (context.state) return context.state
    return context.matches.reduce((state, match) => append(state, sourceNotifySummaryOf(match.event)), [] as SourceSummaryTurn)
}

/**
 * State-only Definition. It publishes its own Turn.data key; the official
 * assistant, Step, turn-tail, and every other target keep their definitions.
 */
export const sourceSummaryDefinition: ConversationNodeDefinition<SourceSummaryTurn> = {
    kind: SOURCE_SUMMARY_DATA,
    match(event) {
        const record = sourceNotifySummaryOf(event)
        return record ? { id: String(record.turn), role: 'start' } : null
    },
    start(_context, match) { return append([], sourceNotifySummaryOf(match.event)) },
    update(context, match) { return append(context.state, sourceNotifySummaryOf(match.event)) },
    buildLocationData(context, scope, previous) {
        if (scope !== 'turn') return null
        const value = records(context)
        if (!value.length) return null
        if (previous?.kind === 'turn' && previous.key === SOURCE_SUMMARY_DATA && previous.value === value) return previous
        return { kind: 'turn', turn: value[0]!.turn, key: SOURCE_SUMMARY_DATA, value }
    },
}
