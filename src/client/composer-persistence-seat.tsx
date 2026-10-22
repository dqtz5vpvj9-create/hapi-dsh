import { createElement, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSessionInjected, ConversationSessionSlotProps, ConversationStore } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ComposerPersistenceBindings } from './composer-persistence.ts'

/** Compose the public Session seat with its original store and business inject. */
export function installComposerPersistence(ctx: Context): () => void {
    const bindings = new ComposerPersistenceBindings()
    return ctx.slots.inject('conversation.session', () => {
        let original: StoredEntry | undefined, wrapped: ComponentType<ConversationSessionSlotProps> | undefined
        let remove: (() => void) | undefined, updating = false
        const update = () => {
            if (updating) return
            const entry = ctx.slots.entries('conversation.session').find(value => value.component !== wrapped)
            if (entry === original) return
            updating = true
            try {
                remove?.(); remove = undefined; original = entry
                if (!entry?.store || !entry.inject) return
                const Official = entry.component as ComponentType<ConversationSessionSlotProps>
                const inject = entry.inject as unknown as (id: SessionId, actions: BoundActions<ConversationStore>) => ConversationSessionInjected
                wrapped = props => createElement(Official, { ...props,
                    bindDraftPersistence: write => bindings.retain(props.inputActions, props.bindDraftPersistence, write) })
                remove = ctx.slots.register({ name: 'conversation.session', priority: (entry.options.priority ?? 0) - 1,
                    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
                    store: entry.store as ConversationStore, inject,
                }, wrapped)
            } finally { updating = false }
        }
        const stop = ctx.slots.subscribe('conversation.session', update)
        update()
        return () => { stop(); remove?.() }
    })
}
