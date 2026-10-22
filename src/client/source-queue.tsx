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

function QueueIcon({ kind }: { kind: 'edit' | 'remove' | 'send' | 'expand' | 'collapse' }) {
    const paths = { edit: 'M12 4l4 4M4 12l9-9a2 2 0 0 1 3 3l-9 9-4 1z', remove: 'M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12', send: 'M10 16V4M5 9l5-5 5 5', expand: 'M5 8l5 5 5-5', collapse: 'M5 12l5-5 5 5' }
    return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>
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
            onClick={() => api.queuedEditing?.edit(sessionId, row)}><QueueIcon kind="edit"/></button>}
        {available.cancel && <button type="button" disabled={disabled || state.busy} title={zh ? '取消排队' : 'Cancel queued message'}
            onClick={() => { void action.run(() => api.cancel(sessionId, row.localId), false) }}><QueueIcon kind="remove"/></button>}
        {available.steer && <button type="button" disabled={disabled || state.busy} title={zh ? '立即插话' : 'Steer now'}
            onClick={() => { void action.run(() => api.steer(sessionId, row.localId), false) }}><QueueIcon kind="send"/></button>}
        {row.state !== 'queued' && <small>{zh ? '等待源端确认' : 'Awaiting source confirmation'}</small>}
        {state.error && <p role="alert">{state.error}</p>}
    </div>
}

export function SourceQueue({ rows, sessionId, api, disabled, steer, zh }: {
    rows: readonly DeliveryView[]; sessionId: string; api: NativeActionsApi; disabled: boolean; steer: boolean; zh: boolean
}) {
    const [expanded, setExpanded] = useState(false)
    const queue = editableSourceQueue(rows)
    if (!queue.length) return null
    return <section className="hapi-source-queue">
        <button type="button" className="hapi-source-queue-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {queue.length} {zh ? '条排队消息' : 'queued messages'} <QueueIcon kind={expanded ? 'collapse' : 'expand'}/>
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

export const sourceQueueStyles = `
.hapi-source-queue{width:100%;max-width:960px;margin:0 auto 4px;box-sizing:border-box;border:0;border-radius:8px;background:var(--dsw-alias-bg-base,transparent);font:var(--dsw-font-xs-13,13px/20px system-ui);color:var(--dsw-alias-label-primary)}
.hapi-source-queue-heading{display:flex;align-items:center;justify-content:space-between;width:100%;border:0;background:none;color:var(--dsw-alias-label-secondary);padding:6px 10px;cursor:pointer;font:inherit;border-radius:6px}
.hapi-source-queue-heading:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hapi-source-queue-list{max-height:176px;overflow:auto;padding:0 4px}
.hapi-source-queue-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 6px;border-top:1px solid var(--dsw-alias-border-l2,#8882)}
.hapi-source-queue-row>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hapi-source-queue-row button{display:inline-flex;align-items:center;justify-content:center;border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;width:28px;height:28px;padding:5px;border-radius:5px}
.hapi-source-queue-row button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.hapi-source-queue-row button:disabled{opacity:.4;cursor:default}
.hapi-source-queue-row p{width:100%;margin:0;color:var(--text-error,#c44)}
.hapi-source-queue-row small{color:var(--dsw-alias-label-secondary)}
@media(pointer:coarse){.hapi-source-queue-row button,.hapi-source-queue-heading{min-width:44px;min-height:44px}}
`
