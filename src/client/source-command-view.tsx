import { useEffect, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { SOURCE_COMMAND_TOOLS, SOURCE_COMPACT_TOOLS, sourceCommandModel, sourceToolSummary } from './source-command-model.ts'

/** Atomic views in the official tool tree: call identity, children, navigation
 * and auto-review denials remain owned by the upstream tool plugin. */
export function installSourceCommandViews(ctx: Context): () => void {
    const Command = (props: ToolCallViewProps) => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        const zh = language.startsWith('zh'), model = sourceCommandModel(props.block)
        const { expanded, toggle } = props.useDisclosure()
        const state = model.status === 'preparing' ? zh ? '准备中' : 'Preparing'
            : model.status === 'running' ? zh ? '运行中' : 'Running'
            : model.status === 'stopped' ? zh ? '已停止' : 'Stopped'
            : model.status === 'error' ? model.exitCode === null ? zh ? '失败' : 'Failed' : `${zh ? '退出' : 'Exit'} ${model.exitCode}`
            : zh ? '完成' : 'Done'
        return <section className="hapi-source-command" data-state={model.status}>
            <button type="button" className="hapi-source-command-toggle" aria-expanded={expanded} onClick={toggle}>
                <span className="hapi-source-command-line"><span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
                    <span>{zh ? '命令' : 'Shell'}</span>
                    {model.description && <span className="hapi-source-command-description">{model.description}</span>}
                    <span className="hapi-source-command-status">{state}</span>
                </span>
                <code className="hapi-source-command-preview" title={model.command ?? undefined}>
                    {model.command ?? (zh ? '命令内容未提供' : 'Command not provided')}
                </code>
            </button>
            {expanded && <div className="hapi-source-command-body">
                {model.command && <pre aria-label={zh ? '命令' : 'Command'}>{model.command}</pre>}
                {model.output && <pre aria-label={zh ? '输出' : 'Output'}>{model.output}</pre>}
                {(model.raw || model.resultRaw) && <details><summary>{zh ? '原始参数与结果' : 'Raw arguments and result'}</summary>
                    {model.raw && <pre>{model.raw}</pre>}{model.resultRaw && <pre>{model.resultRaw}</pre>}
                </details>}
                {props.inspect && <button type="button" onClick={props.inspect}>{zh ? '查看调用记录' : 'Inspect call'}</button>}
            </div>}
        </section>
    }
    const Compact = (props: ToolCallViewProps) => {
        const { expanded, toggle } = props.useDisclosure(), model = sourceCommandModel(props.block)
        const summary = sourceToolSummary(props.block)
        return <section className="hapi-source-command hapi-source-tool" data-state={model.status}>
            <button type="button" className="hapi-source-command-toggle hapi-source-command-line" aria-expanded={expanded} onClick={toggle}>
                <span aria-hidden="true">{expanded ? '⌄' : '›'}</span><span>{props.toolName}</span>
                <span className="hapi-source-command-description" title={summary ?? undefined}>{summary}</span>
                {model.status === 'running' && <span className="hapi-source-command-status" aria-label="Running">◌</span>}
                {model.status === 'error' && <span className="hapi-source-command-status" title={model.exitCode === null ? 'Failed' : `Exit ${model.exitCode}`}>!</span>}
            </button>
            {expanded && <div className="hapi-source-command-body">{model.raw && <pre>{model.raw}</pre>}{model.output && <pre>{model.output}</pre>}
                {props.inspect && <button type="button" onClick={props.inspect}>↗</button>}</div>}
        </section>
    }
    const dynamic = new Map<string, () => void>()
    const richTools = new Set<string>()
    const discover = (entries: readonly SessionEventLikeEntry[], calls: Map<string, string>) => {
        for (const entry of entries) {
            if (entry.type !== 'event') continue
            if (entry.event.type === 'tool/result') {
                const message = entry.event.data.message
                const name = calls.get(message.toolCallId)
                if (name && message.content.some(part => part.type !== 'text')) {
                    richTools.add(name); dynamic.get(name)?.(); dynamic.delete(name)
                }
                continue
            }
            if (entry.event.type !== 'tool/call') continue
            const name = entry.event.data.name
            calls.set(entry.event.data.callId, name)
            if (richTools.has(name) || dynamic.has(name) || ctx.slots.entries('tool.call.toolview').some(item => item.options.key === name)) continue
            // Lowest priority: a tool plugin arriving later keeps its complete
            // image, approval, question, or custom artifact view.
            dynamic.set(name, ctx.slots.register({ name: 'tool.call.toolview', key: name, priority: 1000 }, Compact))
        }
    }
    const Discovery = (props: PropsRuntime<'conversation.input.dock'>) => {
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), source = native ?? observed
        useEffect(() => {
            if (!source) return
            const events = ctx.sessions.binding(props.sessionId)?.eventSource
            if (!events) return
            const calls = new Map<string, string>()
            discover(events.getSnapshot().entries, calls)
            return events.subscribe(() => {
                const change = events.getSnapshot().change
                if (change.kind !== 'settle-assistant') discover(change.entries, calls)
            })
        }, [props.sessionId, Boolean(source)])
        return null
    }
    const stopDiscovery = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'hapi.compact-tools', order: -100 }, Discovery))
    const stop = ctx.slots.inject('tool.call.toolview', () => {
        const entries = [...SOURCE_COMMAND_TOOLS.map(key => ctx.slots.register({ name: 'tool.call.toolview', key }, Command)),
            ...SOURCE_COMPACT_TOOLS.map(key => ctx.slots.register({ name: 'tool.call.toolview', key }, Compact))]
        return () => { for (const dispose of entries.reverse()) dispose() }
    })
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => { stopDiscovery(); for (const dispose of dynamic.values()) dispose(); stop(); style.remove() }
}

const styles = `
.hapi-source-command{min-width:0;max-width:100%;padding:3px 0;color:var(--dsw-alias-label-secondary,#6b706e);font-size:13px}
.hapi-source-command-toggle{display:block;width:100%;min-width:0;min-height:26px;padding:2px 0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.hapi-source-tool .hapi-source-command-toggle{display:flex}
.hapi-source-command-line{display:flex;align-items:center;gap:7px;min-width:0;line-height:20px}
.hapi-source-command-description{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hapi-source-command-status{margin-left:auto;flex-shrink:0;font-size:11px}
.hapi-source-command[data-state=error] .hapi-source-command-status{color:var(--dsw-alias-label-danger,#b54b42)}
.hapi-source-command-preview{display:block;padding-left:14px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;color:var(--dsw-alias-label-primary,#222426)}
.hapi-source-command-body{padding:4px 0 6px 14px;min-width:0}
.hapi-source-command-body pre{margin:5px 0;max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#222426)}
.hapi-source-command-body summary{cursor:pointer;font-size:12px}
.hapi-source-command-toggle:focus-visible{outline:2px solid var(--hapi-palette-accent,#359b6c);outline-offset:2px;border-radius:4px}
@media(pointer:coarse){.hapi-source-command-toggle{min-height:44px}}
`
