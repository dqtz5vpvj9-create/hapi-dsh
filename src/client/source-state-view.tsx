import { useLayoutEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SOURCE_STATE_VIEW, sourceStateDefinition, sourceStateViewDefinition } from './source-state-conversation.ts'

type StateProps = PropsRuntime<'conversation.view'> & PropsLocale<'hapiWorkspace'>

/** A real source-owned business view next to Chat and other official/plugin
 * views. It reports connection/identity/approval/queue facts, not chat messages. */
export function SourceStateView({ sessionId, useConversation, useProjection, useSessions, t }: StateProps) {
    const recorded = useConversation(state => state.views.get(SOURCE_STATE_VIEW))
    const native = useProjection('hapi'), observed = useProjection('hapiObserved')
    const source = native ?? observed
    const cwd = useSessions(state => state.byId[sessionId]?.cwd)
    if (!source || !recorded) return <p className="hapi-source-state-empty">{t('sourceStateUnavailable')}</p>
    return <section className="hapi-source-state-view" aria-label={t('sourceStateView')} data-hapi-source-state={source.hapiSessionId}>
        <h2>{t('sourceStateView')}</h2><p>{t('sourceStateHelp')}</p>
        <dl>
            <div><dt>{t('engine')}</dt><dd>{native ? 'Codex' : observed?.flavor}</dd></div>
            <div><dt>{t('sourceHub')}</dt><dd><code>{source.hubId}</code></dd></div>
            <div><dt>{t('sourceSession')}</dt><dd><code>{source.hapiSessionId}</code></dd></div>
            <div><dt>{t('machine')}</dt><dd>{source.machineName ?? source.machineId ?? t('sourceUnreportedValue')}{source.machineName && source.machineId && <small>{source.machineId}</small>}</dd></div>
            <div><dt>{t('directory')}</dt><dd><code>{observed?.path ?? cwd ?? t('sourceUnreportedValue')}</code></dd></div>
            {source.nativeId && <div><dt>{t('sourceThread')}</dt><dd><code>{source.nativeId}</code></dd></div>}
            {native?.nativeHome && <div><dt>{t('codexHome')}</dt><dd><code>{native.nativeHome}</code></dd></div>}
            <div><dt>{t('sourceStatus')}</dt><dd>{native?.nativeConnection ?? observed?.connection}</dd></div>
            {native?.execution && <div><dt>{t('sourceExecution')}</dt><dd>{native.execution.status}</dd></div>}
            <div><dt>{t('permission')}</dt><dd>{source.readOnly ? t('sourceReadOnly') : observed?.controlledByUser ? t('sourceControlled') : t('sourceStartRemote')}</dd></div>
            {source.model && <div><dt>{t('model')}</dt><dd>{source.model}</dd></div>}
        </dl>
        <section><h3>{t('nativeRequests')} · {source.pendingRequests.length}</h3>
            {source.pendingRequests.map(request => <p key={request.requestId}><code>{request.tool}</code> · {request.stage}{request.error && <span className="hapi-error">{request.error}</span>}</p>)}
        </section>
        <section><h3>{t('nativeDelivery')} · {source.delivery.length}</h3>
            {source.delivery.map(delivery => <p key={delivery.localId}><span>{delivery.text}</span> · <strong>{delivery.state}</strong>{delivery.error && <span className="hapi-error">{delivery.error}</span>}</p>)}
        </section>
        {source.error && <p className="hapi-error" role="alert">{source.error}</p>}
    </section>
}

/** One installed graph owns this view. Its tab exists only while a real source
 * composer is mounted; ordinary DSH sessions never acquire a source tab. */
export function installSourceStateView(ctx: Context): { useSourceState(sessionId: SessionId, source: boolean): void; dispose(): void } {
    const stopDefinition = ctx.uiConversation.events.register(sourceStateDefinition)
    const stopView = ctx.uiConversation.views.register(sourceStateViewDefinition)
    const consumers = new Set<object>()
    let stopSlot: (() => void) | undefined
    let disposed = false
    const retain = (sessionId: SessionId): (() => void) => {
        if (disposed) return () => {}
        const owner = {}, binding = ctx.sessions.binding(sessionId)
        if (!binding) return () => {}
        if (!consumers.size) stopSlot = ctx.slots.inject('conversation.view', () => ctx.slots.register({
            name: 'conversation.view', id: SOURCE_STATE_VIEW, order: 100, label: () => ctx.locale.bind('hapiWorkspace')('sourceStateView'), locale: 'hapiWorkspace',
        }, SourceStateView))
        consumers.add(owner)
        // activate is the public Conversation target lifecycle, not Session
        // execution. isActive still requires a real matching source record.
        ctx.uiConversation.binding(binding).activate(SOURCE_STATE_VIEW)
        return () => { consumers.delete(owner); if (!consumers.size) { stopSlot?.(); stopSlot = undefined } }
    }
    return {
        useSourceState(sessionId, source) { useLayoutEffect(() => source ? retain(sessionId) : undefined, [sessionId, source]) },
        dispose() { disposed = true; stopSlot?.(); stopSlot = undefined; consumers.clear(); stopView(); stopDefinition() },
    }
}
