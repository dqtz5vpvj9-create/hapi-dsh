import { createElement, useMemo, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { SOURCE_COMMAND_TOOLS, sourceShellBlock } from './source-command-model.ts'

/** Alias source shell names to the actual registered DSH Bash component. */
export function installSourceCommandViews(ctx: Context): () => void {
    return ctx.slots.inject('tool.call.toolview', () => {
        let original: StoredEntry | undefined, updating = false
        let registrations: Array<() => void> = []
        const update = (): void => {
            if (updating) return
            const entry = ctx.slots.entriesOfSlot('tool.call.toolview').find(value => value.options.key === 'bash')
            if (entry === original) return
            updating = true
            try {
                for (const stop of registrations) stop()
                registrations = []; original = entry
                if (!entry) return
                const Official = entry.component as ComponentType<ToolCallViewProps>
                const Alias = (props: ToolCallViewProps) => {
                    const block = useMemo(() => sourceShellBlock(props.block), [props.block])
                    return createElement(Official, { ...props, toolName: 'bash', block } as ToolCallViewProps)
                }
                registrations = SOURCE_COMMAND_TOOLS.map(key => ctx.slots.register({ name: 'tool.call.toolview', key,
                    locale: 'conversation', priority: 1000 }, Alias))
            } finally { updating = false }
        }
        const stop = ctx.slots.subscribe('tool.call.toolview', update)
        update()
        return () => { stop(); for (const remove of registrations) remove() }
    })
}
