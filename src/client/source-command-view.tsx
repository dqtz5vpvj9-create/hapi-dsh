import { createElement, Fragment, useMemo, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { SOURCE_TOOL_ALIASES, SOURCE_TOOL_VIEW_TARGETS, sourceToolBlocks, sourceToolView } from './source-command-model.ts'

/** Adapt native data into the actual registered DSH tool components. */
export function installSourceCommandViews(ctx: Context): () => void {
    return ctx.slots.inject('tool.call.toolview', () => {
        let originals: Array<StoredEntry | undefined> = [], updating = false
        let registrations: Array<() => void> = []
        const update = (): void => {
            if (updating) return
            const targets = SOURCE_TOOL_VIEW_TARGETS
            const entries = targets.map(target => ctx.slots.entriesOfSlot('tool.call.toolview').find(value => value.options.key === target))
            if (entries.length === originals.length && entries.every((entry, index) => entry === originals[index])) return
            updating = true
            try {
                for (const stop of registrations) stop()
                registrations = []; originals = entries
                const registered = new Map(targets.map((target, index) => [target, entries[index]]))
                targets.forEach((target, index) => {
                    const entry = entries[index]
                    if (!entry) return
                    const Alias = (props: ToolCallViewProps & PropsLocale<'conversation'>) => {
                        const view = sourceToolView(props.block, target)
                        const Official = (registered.get(view.renderer) ?? entry).component as ComponentType<ToolCallViewProps>
                        const blocks = useMemo(() => sourceToolBlocks(props.block, view.toolName, {
                            read: props.t('tool.title.read'), search: props.t('tool.title.search'), listFiles: props.t('tool.title.glob'),
                            agentActivity: kind => {
                                switch (kind) {
                                    case 'spawn': case 'spawnAgent': return props.t('tool.title.spawnTeammate')
                                    case 'started': return props.t('detail.receipt.started')
                                    case 'interacted': return props.t('detail.status.accepted')
                                    case 'interrupted': return props.t('bash.stopped')
                                    case 'sendInput': case 'sendMessage': return props.t('tool.title.sendMessage')
                                    case 'resumeAgent': return props.t('detail.status.running')
                                    case 'closeAgent': return props.t('detail.receipt.closed')
                                    case 'followupTask': return props.t('detail.field.task')
                                    case 'interruptAgent': return props.t('tool.title.interruptAgent')
                                    case 'listAgents': return props.t('tool.title.listAgents')
                                    case 'wait': return props.t('tool.title.waitAgent')
                                    case 'completed': return props.t('detail.status.completed')
                                    case 'running': case 'inProgress': return props.t('detail.status.running')
                                    case 'failed': return props.t('detail.status.failed')
                                    default: return kind
                                }
                            },
                        }), [props.block, props.t, view.toolName])
                        return createElement(Fragment, null, blocks.map((block, index) =>
                            createElement(Official, { ...props, key: index, toolName: view.toolName, block } as ToolCallViewProps & { key: number })))
                    }
                    registrations.push(...(SOURCE_TOOL_ALIASES[target] ?? []).map(key => ctx.slots.register({ name: 'tool.call.toolview', key,
                        locale: 'conversation', priority: 1000 }, Alias)))
                })
            } finally { updating = false }
        }
        const stop = ctx.slots.subscribe('tool.call.toolview', update)
        update()
        return () => { stop(); for (const remove of registrations) remove() }
    })
}
