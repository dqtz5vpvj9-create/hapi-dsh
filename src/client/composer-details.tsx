/** Show the native activity/usage pills in our More menu without taking ownership of its dock. */
import { createElement, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './composer-picker/slots.ts'
export function installComposerDetails(ctx: Context): () => void {
    return ctx.slots.inject('hapi.source.composer-details', () => {
        let previous: readonly StoredEntry[] = [], stops: Array<() => void> = []
        const update = () => {
            const entries = ctx.slots.entries('conversation.composer.dock').filter(entry => ['activity', 'usage'].includes(entry.options.id ?? ''))
            if (entries.length === previous.length && entries.every((entry, index) => entry === previous[index])) return
            for (const stop of stops) stop()
            stops = []; previous = entries
            for (const entry of entries) {
                if (entry.children || entry.store) continue
                const Official = entry.component as ComponentType<PropsRuntime<'hapi.source.composer-details'>>
                const Pill = (props: PropsRuntime<'hapi.source.composer-details'>) => createElement(Official, props)
                stops.push(ctx.slots.register({ name: 'hapi.source.composer-details', id: entry.options.id!, order: entry.options.order ?? 0,
                    locale: entry.locale as 'chat', inject: entry.inject as never }, Pill))
            }
        }
        const stop = ctx.slots.subscribe('conversation.composer.dock', update); update()
        return () => { stop(); for (const dispose of stops) dispose() }
    })
}
