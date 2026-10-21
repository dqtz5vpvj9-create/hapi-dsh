import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { sourceToolProgressOf, type SourceToolProgress } from '../hapi-agent/tool-progress.ts'

export const SOURCE_TOOL_PROGRESS = 'hapi-tool-progress'
export type ToolProgressDisplay = SourceToolProgress
export interface SourceToolProgressState { readonly record: SourceToolProgress; readonly anchorSeq: number }
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
    interface ChatNodeDataMap { 'hapi-tool-progress': ToolProgressDisplay }
}

/** This owns only a new source-progress node. It neither claims standard tool
 * events nor replaces their renderer. The official chat target supplies its
 * timeline, grouping, virtualization, and subscription lifecycle. */
export const sourceToolProgressDefinition: ConversationNodeDefinition<SourceToolProgressState> = {
    kind: SOURCE_TOOL_PROGRESS,
    target: 'chat',
    match(event) {
        const record = sourceToolProgressOf(event)
        return record ? { id: record.callId, role: 'start' } : null
    },
    start(_context, match) {
        const record = sourceToolProgressOf(match.event)
        if (!record) throw new Error('Source progress requires a validated source progress record')
        return { record, anchorSeq: match.event.seq }
    },
    update(context, match) {
        const record = sourceToolProgressOf(match.event)
        if (!record || record.callId !== context.state.record.callId
            || record.turn !== context.state.record.turn || record.step !== context.state.record.step) return context.state
        // Ended source work cannot become running again through a late partial.
        if (context.state.record.phase !== 'progress' && record.phase === 'progress') return context.state
        if (context.state.record.phase === 'result' && record.phase !== 'result') return context.state
        if (JSON.stringify(context.state.record) === JSON.stringify(record)) return context.state
        return { ...context.state, record }
    },
    buildViewNode(context): ChatNode<'hapi-tool-progress'> | null {
        const state = context.state
        if (!state) return null
        return { key: context.key, kind: SOURCE_TOOL_PROGRESS, id: context.id, target: 'chat',
            anchorSeq: state.anchorSeq, location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
            // The official incremental assembler forbids withdrawing an
            // already materialized key. Publish its final hidden state, as
            // the official tool/assistant definitions do themselves.
            visibility: state.record.phase === 'result' ? 'hidden' : 'visible', groupTree: 'process', data: state.record }
    },
}
