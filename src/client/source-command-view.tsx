import { createElement, Fragment, useMemo, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { SOURCE_TOOL_ALIASES, sourceToolBlocks } from './source-command-model.ts'

/** Alias source shell names to the actual registered DSH Bash component. */
export function installSourceCommandViews(ctx: Context): () => void {
    return ctx.slots.inject('tool.call.toolview', () => {
        let originals: Array<StoredEntry | undefined> = [], updating = false
        let registrations: Array<() => void> = []
        const update = (): void => {
            if (updating) return
            const targets = Object.entries(SOURCE_TOOL_ALIASES)
            const entries = targets.map(([target]) => ctx.slots.entriesOfSlot('tool.call.toolview').find(value => value.options.key === target))
            if (entries.length === originals.length && entries.every((entry, index) => entry === originals[index])) return
            updating = true
            try {
                for (const stop of registrations) stop()
                registrations = []; originals = entries
                targets.forEach(([target, names], index) => {
                    const entry = entries[index]
                    if (!entry) return
                    const Official = entry.component as ComponentType<ToolCallViewProps>
                    const Alias = (props: ToolCallViewProps) => {
                        const blocks = useMemo(() => sourceToolBlocks(props.block, target), [props.block])
                        return createElement(Fragment, null, blocks.map((block, index) =>
                            createElement(Official, { ...props, key: index, toolName: target, block } as ToolCallViewProps & { key: number })))
                    }
                    registrations.push(...names.map(key => ctx.slots.register({ name: 'tool.call.toolview', key,
                        locale: (entry.locale ?? 'conversation') as keyof LocaleNamespaceMap, priority: 1000 }, Alias)))
                })
            } finally { updating = false }
        }
        const stop = ctx.slots.subscribe('tool.call.toolview', update)
        update()
        return () => { stop(); for (const remove of registrations) remove() }
    })
}
