import { createElement, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DeliveryView } from '../codex/projection-types.ts'
import type { NativeActionsApi } from './native-actions.tsx'
import { deliveryActions } from './native-status.ts'

export function editableSourceQueue(rows: readonly DeliveryView[]): DeliveryView[] {
    return rows.filter(row => ['queued', 'accepted', 'dispatching', 'indeterminate'].includes(row.state))
}

function QueueRow({ row, sessionId, api, disabled, steer, zh }: {
    row: DeliveryView; sessionId: string; api: NativeActionsApi; disabled: boolean; steer: boolean; zh: boolean
}) {
    const action = api.ledger.action(sessionId, 'delivery', row.localId)
    const state = useSyncExternalStore(action.subscribe, action.getSnapshot)
    const available = deliveryActions(row, steer)
    return <div className="hapi-source-queue-row" data-hapi-queue-id={row.localId}>
        <span title={row.text}>{row.text || (zh ? '附件消息' : 'Attachment message')}</span>
        {available.edit && api.queuedEditing && <button type="button" disabled={state.busy || api.queuedEditing.busy}
            title={zh ? '取消排队并取回编辑' : 'Cancel queue and edit'} aria-label={zh ? '编辑排队消息' : 'Edit queued message'}
            onClick={() => api.queuedEditing?.edit(sessionId, row)}>✎</button>}
        {available.cancel && <button type="button" disabled={disabled || state.busy} title={zh ? '取消排队' : 'Cancel queued message'}
            onClick={() => { void action.run(() => api.cancel(sessionId, row.localId), false) }}>×</button>}
        {available.steer && <button type="button" disabled={disabled || state.busy} title={zh ? '立即插话' : 'Steer now'}
            onClick={() => { void action.run(() => api.steer(sessionId, row.localId), false) }}>↑</button>}
        {row.state !== 'queued' && <small>{zh ? '等待源端确认' : 'Awaiting source confirmation'}</small>}
        {state.error && <p role="alert">{state.error}</p>}
    </div>
}

export function SourceQueue({ rows, sessionId, api, disabled, steer, zh }: {
    rows: readonly DeliveryView[]; sessionId: string; api: NativeActionsApi; disabled: boolean; steer: boolean; zh: boolean
}) {
    const [expanded, setExpanded] = useState(true)
    const queue = editableSourceQueue(rows)
    if (!queue.length) return null
    return <section className="hapi-source-queue">
        <button type="button" className="hapi-source-queue-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {queue.length} {zh ? '条排队消息' : 'queued messages'} <span>{expanded ? '⌃' : '⌄'}</span>
        </button>
        {expanded && <div className="hapi-source-queue-list">{queue.map(row => <QueueRow key={row.localId} row={row} sessionId={sessionId}
            api={api} disabled={disabled} steer={steer} zh={zh}/>)}</div>}
    </section>
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

export const sourceQueueStyles = `.hapi-source-queue{width:100%;box-sizing:border-box;border:1px solid var(--border-secondary,#8883);border-radius:12px;background:var(--bg-secondary,transparent);font-size:13px}.hapi-source-queue-heading{display:flex;justify-content:space-between;width:100%;border:0;background:none;color:inherit;padding:9px 12px;cursor:pointer;font:inherit}.hapi-source-queue-list{max-height:240px;overflow:auto}.hapi-source-queue-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border-top:1px solid var(--border-secondary,#8882)}.hapi-source-queue-row>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hapi-source-queue-row button{border:0;background:none;color:inherit;cursor:pointer;font-size:18px;min-width:30px;min-height:30px}.hapi-source-queue-row button:disabled{opacity:.4;cursor:default}.hapi-source-queue-row p{width:100%;margin:0;color:var(--text-error,#c44)}.hapi-source-queue-row small{opacity:.65}@media(max-width:640px){.hapi-source-queue-row button{min-width:44px;min-height:44px}}`
