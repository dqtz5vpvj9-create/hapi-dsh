import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { sourceToolProgressDefinition, SOURCE_TOOL_PROGRESS } from './tool-progress-conversation.ts'
import { installSourceCommandViews } from './source-command-view.tsx'

/** An additive business node for the original engine's partialResult; the
 * original tool call and its eventual result remain official DSH nodes. */
export function installToolProgressDisplay(ctx: Context): () => void {
    const Progress = (props: PropsRuntime<'conversation.chat.node', 'hapi-tool-progress'>) => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        const zh = language.startsWith('zh'), value = props.node.data
        if (value.phase === 'result') return null
        const label = `${value.toolName} · ${zh ? '中间输出' : 'Partial output'}`
        return <section className="hapi-tool-progress" data-hapi-tool-progress={value.sourceCallId} data-hapi-tool-progress-phase={value.phase}
            aria-label={label}>
            <details><summary>{label}</summary>
            {value.phase === 'turn-ended' && <p>{zh
                ? '源轮次已结束，未收到该工具的最终结果。以下保留最后一次中间输出。'
                : 'The source turn ended without a final tool result. The last partial output is retained below.'}</p>}
            <JsonBlock label={label} payload={value.payload} defaultOpen
                truncatedLabel={length => zh ? `显示已截断；源输出共 ${length} 个字符。` : `Display truncated; the source output contains ${length} characters.`}/>
            </details>
        </section>
    }
    const stopCommands = installSourceCommandViews(ctx)
    const stopDefinition = ctx.uiConversation.events.register(sourceToolProgressDefinition)
    const stopSlot = ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node', key: SOURCE_TOOL_PROGRESS,
    }, Progress))
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => { stopSlot(); stopDefinition(); stopCommands(); style.remove() }
}
const styles = `.hapi-tool-progress{min-width:0;max-width:100%;padding:3px 0}.hapi-tool-progress summary{cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary,#888)}.hapi-tool-progress p{font-size:12px;color:var(--text-secondary,#888);margin:4px 0 6px}.hapi-tool-progress pre{max-height:260px;overflow:auto}`
