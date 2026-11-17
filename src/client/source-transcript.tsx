/** Decorate the official assistant registration while retaining its plugin child slots. */
import { createElement, useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime, PropsRenderSlots, PropsRenderFactories, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-attachment/client'
import { isSourceSessionId } from '../remote/protocol.ts'
import { useLiveDisclosure } from './live-disclosure.ts'
import { SourcePlanActions, proposedPlanText } from './source-plan.tsx'
import type { SourceFileClient } from './source-workspace-provider.ts'
import { nativeMessageIdentity } from './native-question-presentation.ts'
import { sourceQuestion, sourceQuestionCallId } from '../shared/native-async-questions.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'

type Props = PropsRuntime<'conversation.chat.node', 'assistant-step'> & PropsRenderFactories
type OfficialProps = Props
    & Pick<PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.message.images'>, 'renderSlot'>

const emptySubscribe = () => () => {}, emptySnapshot = () => undefined
export function NativeQuestionHistoryActions({ ctx, sessionId, session, messageId }: {
    ctx: Context; sessionId: SessionId; session?: RemoteSourceSession | undefined; messageId?: string | undefined
}) {
    const metadata = useSyncExternalStore(session?.metadata.subscribe ?? emptySubscribe, session?.metadata.getSnapshot ?? emptySnapshot)
    const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
    const identity = metadata && nativeMessageIdentity(messageId, metadata.nativeId)
    const questions = identity ? metadata!.pendingRequests.filter(row => row.itemId === identity.itemId && row.turnId === identity.turnId && sourceQuestion(row))
        .sort((a, b) => Number(a.params.index) - Number(b.params.index)) : []
    if (!questions.length) return null
    const zh = language.startsWith('zh')
    return <div className="hhpi-question-history-actions">{questions.map(request => {
        const callId = sourceQuestionCallId(request)
        return <button type="button" key={callId} onClick={() => { ctx.get('userQuestionPanels')?.reveal(sessionId, callId) }}>
            {questions.length === 1 ? zh ? '回答问题' : 'Answer question' : `${zh ? '回答问题' : 'Answer question'} ${Number(request.params.index) + 1}`}
        </button>
    })}</div>
}

export function installSourceTranscript(ctx: Context, client?: SourceFileClient): () => void {
    return ctx.slots.inject('conversation.chat.node', () => {
        let original: StoredEntry | undefined, remove: (() => void) | undefined, updating = false
        const own = new Set<unknown>()
        const reconcile = () => {
            if (updating) return
            const entry = ctx.slots.entries('conversation.chat.node').find(value => value.options.key === 'assistant-step' && !own.has(value.component))
            if (entry === original) return
            updating = true
            try {
                remove?.(); remove = undefined; original = entry
                if (!entry) return
                const Official = entry.component as ComponentType<OfficialProps>
                function SourceNode(props: Props) {
                    const source = isSourceSessionId(props.sessionId), running = props.node.data.status === 'running'
                    const useDisclosure = useMemo(() => function useSourceDisclosure() {
                        return useLiveDisclosure(props.useDisclosure, running)
                    }, [props.useDisclosure, running])
                    const plan = source && props.groupPart !== 'reasoning' ? proposedPlanText(props.node.data.blocks) : null
                    return <>{createElement(Official, { ...props as OfficialProps, useDisclosure: source ? useDisclosure : props.useDisclosure })}
                        {plan && !running && <SourcePlanActions key={`${props.sessionId}:${props.node.key}`} ctx={ctx} sessionId={props.sessionId} planId={props.node.key} text={plan}
                            session={props.sessionBinding?.session as import('./remote-sessions.ts').RemoteSourceSession | undefined}/>}
                        {source && props.groupPart !== 'reasoning' && <NativeQuestionHistoryActions ctx={ctx} sessionId={props.sessionId}
                            session={props.sessionBinding?.session as RemoteSourceSession | undefined} messageId={props.node.data.finalNode?.messageId}/>}
                    </>
                }
                own.add(SourceNode)
                remove = ctx.slots.register({ name: 'conversation.chat.node', key: 'assistant-step', priority: (entry.options.priority ?? 0) - 1,
                    delegate: entry }, SourceNode)
            } finally { updating = false }
        }
        const stop = ctx.slots.subscribe('conversation.chat.node', reconcile); reconcile()
        return () => { stop(); remove?.() }
    })
}
