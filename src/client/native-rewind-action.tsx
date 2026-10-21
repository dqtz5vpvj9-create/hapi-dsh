import { createElement, useLayoutEffect, useRef, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { HapiRemoteApi } from '../client-api.ts'
import { NativeRewindButton } from './native-library.tsx'
import { SourceHistoryAction } from './source-lifecycle.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from './pane-navigation.ts'
import { SourceMessageNavigation } from './source-navigation.ts'
import type {} from '../hapi-agent/projection-types.ts'

/** Public keyed-slot composition: retain the official row, add one native action. */
export function installNativeRewindAction(ctx: Context, api: HapiRemoteApi, refresh: () => void): () => void {
    const navigation = new SourceMessageNavigation(ctx, api)
    const unprovide = ctx.reflect.provide('hapiMessageNavigation', navigation)
    let wrapped: StoredEntry | undefined
    let shadow: (() => void) | undefined
    let component: ComponentType<ChatNodeViewProps<'user'>> | undefined
    let changing = false
    const reconcile = (): void => {
        if (changing) return
        const original = ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === 'user' && entry.component !== component)
        if (wrapped === original) return
        changing = true
        try {
            shadow?.(); shadow = undefined; wrapped = original
            // A custom renderer with its own declared subtree must retain that
            // subtree. The pinned official user row has none of these seats.
            if (!original || original.children || original.store || original.inject) return
            const Official = original.component as ComponentType<ChatNodeViewProps<'user'>>
            const NativeUserRow = (props: ChatNodeViewProps<'user'>) => {
                const native = props.useProjection('hapi')
                const observed = props.useProjection('hapiObserved')
                const anchor = useRef<HTMLDivElement>(null)
                const source = Boolean(native || observed && !observed.sidechain)
                useLayoutEffect(() => {
                    if (source && anchor.current) return navigation.anchor(props.sessionId, props.node.data.seq, anchor.current)
                }, [source, props.sessionId, props.node.data.seq])
                const row = <>{createElement(Official, props)}{native && <div className="hapi-native-user-actions">
                    <NativeRewindButton api={api} sessionId={props.sessionId} messageSeq={props.node.data.seq}
                        language={ctx.locale.getSnapshot().active} onChanged={refresh}/>
                </div>}{observed && !observed.sidechain && (observed.capabilities.forkAtMessage || observed.capabilities.rewindToMessage) && <div className="hapi-native-user-actions">
                    {(['fork', 'rewind'] as const).filter(kind => kind === 'fork' ? observed.capabilities.forkAtMessage : observed.capabilities.rewindToMessage).map(kind =>
                        <SourceHistoryAction key={kind} api={api} sessionId={props.sessionId} messageSeq={props.node.data.seq} kind={kind}
                            language={ctx.locale.getSnapshot().active} onChanged={refresh} onOpen={id => {
                                ctx.get('hapiWorkspacePane')?.revealConversation(); ctx.uiWorkspace.openSession(id as SessionId)
                            }}/>)}</div>}</>
                return source ? <div ref={anchor} className="hapi-source-message">{row}</div> : row
            }
            component = NativeUserRow
            shadow = ctx.slots.register({ name: 'conversation.chat.node', key: 'user', priority: (original.options.priority ?? 0) - 1, locale: 'chat' }, NativeUserRow)
        } finally { changing = false }
    }
    const stop = ctx.slots.subscribe('conversation.chat.node', reconcile)
    reconcile()
    return () => { stop(); shadow?.(); unprovide(); navigation.dispose() }
}
