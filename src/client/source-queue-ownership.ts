import { createElement, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DeliveryView } from '../codex/projection-types.ts'

export function editableSourceQueue(rows: readonly DeliveryView[]): DeliveryView[] {
    return rows.filter(row => ['queued', 'accepted', 'dispatching', 'indeterminate'].includes(row.state))
}

/** Native queue ownership is different; ordinary DSH keeps its original queue. */
export function installSourceQueueOwnership(ctx: Context): () => void {
    return ctx.slots.inject('conversation.input.dock', () => {
        let original: StoredEntry | undefined, wrapped: ComponentType<PropsRuntime<'conversation.input.dock'>> | undefined
        let remove: (() => void) | undefined, updating = false
        const update = () => {
            if (updating) return
            const entry = ctx.slots.entries('conversation.input.dock').find(value => value.options.id === 'queue' && value.component !== wrapped)
            if (entry === original) return
            updating = true
            try {
                remove?.(); remove = undefined; original = entry
                if (!entry || entry.children || entry.store) return
                const Official = entry.component as ComponentType<PropsRuntime<'conversation.input.dock'>>
                const inject = entry.inject as ((sessionId: SessionId) => Record<string, unknown>) | undefined
                wrapped = props => {
                    const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved')
                    return native || observed && !observed.sidechain ? null : createElement(Official, props)
                }
                remove = ctx.slots.register({ name: 'conversation.input.dock', id: 'queue', order: entry.options.order ?? 20,
                    priority: (entry.options.priority ?? 0) - 1, locale: 'conversation', inject: (sessionId: SessionId) => inject?.(sessionId) ?? {},
                }, wrapped)
            } finally { updating = false }
        }
        const stop = ctx.slots.subscribe('conversation.input.dock', update)
        update()
        return () => { stop(); remove?.() }
    })
}
