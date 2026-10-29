import { useState, useSyncExternalStore } from 'react'
import type { DeliveryView, QueuedAttachment } from '../codex/projection-types.ts'
import type { NativeActionsApi } from './native-actions.tsx'
import { deliveryActions } from './native-status.ts'
import type { WorkbenchSource } from '../workbench-types.ts'
import { sourceAttachmentImageUrl } from './source-document-path.ts'
import { FileTypeIcon, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { editableSourceQueue } from './source-queue-ownership.ts'


function QueueIcon({ kind }: { kind: 'edit' | 'remove' | 'send' | 'expand' | 'collapse' }) {
    const paths = { edit: 'M12 4l4 4M4 12l9-9a2 2 0 0 1 3 3l-9 9-4 1z', remove: 'M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12', send: 'M10 16V4M5 9l5-5 5 5', expand: 'M5 8l5 5 5-5', collapse: 'M5 12l5-5 5 5' }
    return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>
}

function QueueAttachment({ source, file }: { source: WorkbenchSource; file: QueuedAttachment }) {
    const [failed, setFailed] = useState(false)
    const url = typeof location === 'undefined' ? undefined : sourceAttachmentImageUrl(source, file, location.href)
    return url && !failed ? <img className="hapi-queue-thumbnail" src={url} alt={file.filename} title={file.filename}
        loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>
        : <span className="hapi-queue-file" title={file.filename}><FileTypeIcon path={file.filename} size={14}/><span>{file.filename}</span></span>
}

function QueueRow({ row, sessionId, api, disabled, steer, zh, source }: {
    row: DeliveryView; sessionId: string; api: NativeActionsApi; disabled: boolean; steer: boolean; zh: boolean; source: WorkbenchSource
}) {
    const action = api.ledger.action(sessionId, 'delivery', row.localId)
    const state = useSyncExternalStore(action.subscribe, action.getSnapshot)
    const available = deliveryActions(row, steer)
    return <div className="hapi-source-queue-row" data-hapi-queue-id={row.localId}>
        {!!row.attachments?.length && <div className="hapi-queue-thumbnails">{row.attachments.map((file, index) =>
            <QueueAttachment key={`${source.sourceHubId}:${source.sourceSessionId}:${file.path}:${index}`} source={source} file={file}/>)}</div>}
        <span className="hapi-queue-preview">
            {row.text || (!row.attachments?.length ? row.attachmentNames?.join(', ') || (zh ? '附件消息' : 'Attachment message') : '')}
        </span>
        <div className="hapi-queue-actions">
        {available.edit && api.queuedEditing && <Tooltip portal label={zh ? '取回编辑' : 'Edit queued message'} side="bottom" delayMs={500}>
            <button type="button" disabled={state.busy || api.queuedEditing.busy} aria-label={zh ? '编辑排队消息' : 'Edit queued message'}
                onClick={() => api.queuedEditing?.edit(sessionId, row)}><QueueIcon kind="edit"/></button></Tooltip>}
        {available.cancel && <Tooltip portal label={zh ? '取消排队' : 'Cancel queued message'} side="bottom" delayMs={500}>
            <button type="button" disabled={disabled || state.busy} aria-label={zh ? '取消排队' : 'Cancel queued message'}
                onClick={() => { void action.run(() => api.cancel(sessionId, row.localId), false) }}><QueueIcon kind="remove"/></button></Tooltip>}
        {available.steer && <Tooltip portal label={zh ? '立即插话' : 'Steer now'} side="bottom" delayMs={500}>
            <button type="button" disabled={disabled || state.busy} aria-label={zh ? '立即插话' : 'Steer now'}
                onClick={() => { void action.run(() => api.steer(sessionId, row.localId), false) }}><QueueIcon kind="send"/></button></Tooltip>}
        </div>
        {state.error && <p role="alert">{state.error}</p>}
    </div>
}

export function SourceQueue({ rows, sessionId, api, disabled, steer, zh, source }: {
    rows: readonly DeliveryView[]; sessionId: string; api: NativeActionsApi; disabled: boolean; steer: boolean; zh: boolean; source: WorkbenchSource
}) {
    const [expanded, setExpanded] = useState(false)
    const queue = editableSourceQueue(rows)
    if (!queue.length) return null
    return <section className="hapi-source-queue" data-queue-dock=""><div className="hapi-source-queue-panel">
        {queue.length > 1 && <button type="button" className="hapi-source-queue-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {queue.length} {zh ? '条排队消息' : 'queued messages'} <QueueIcon kind={expanded ? 'collapse' : 'expand'}/>
        </button>}
        {(expanded || queue.length === 1) && <div className="hapi-source-queue-list">{queue.map(row => <QueueRow key={row.localId} row={row} sessionId={sessionId}
            api={api} disabled={disabled} steer={steer} zh={zh} source={source}/>)}</div>}
    </div></section>
}


export const sourceQueueStyles = `
.hapi-source-queue{box-sizing:border-box;position:relative;z-index:1;width:calc(100% - var(--dsh-composer-side-clearance,12px)*2 - var(--dsh-composer-dock-inset,10px)*2);max-width:calc(var(--dsh-composer-card-max-width,960px) - var(--dsh-composer-dock-inset,10px)*2);margin:0 auto calc(0px - var(--dsh-composer-stack-gap,4px) - 3px);padding:0 var(--dsh-composer-dock-inset,10px);flex:none;font:var(--dsw-font-xs-13,13px/20px system-ui);color:var(--dsw-alias-label-primary)}
.hapi-source-queue-panel{position:relative;isolation:isolate;border-radius:var(--dsw-radius-lg,14px) var(--dsw-radius-lg,14px) 0 0;border:.5px solid var(--dsw-alias-border-l1,#8882);border-bottom:0;background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));backdrop-filter:var(--dsw-menu-backdrop-filter);padding:2px 0;overflow:hidden}
.hapi-source-queue-heading{display:flex;align-items:center;justify-content:space-between;width:100%;height:36px;border:0;background:none;color:var(--dsw-alias-label-secondary);padding:4px 12px;cursor:pointer;font:inherit}
.hapi-source-queue-list{max-height:180px;overflow:auto}
.hapi-source-queue-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:36px;box-sizing:border-box;padding:4px 5px 4px 12px}
.hapi-source-queue-row+.hapi-source-queue-row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1,#8882)}
.hapi-queue-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary-dimmed)}
.hapi-queue-actions{display:flex;align-items:center;gap:10px;flex:none}
.hapi-source-queue-row button{display:grid;place-items:center;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;width:28px;height:28px;padding:0;border-radius:999px}
.hapi-source-queue-row button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hapi-source-queue-row button:disabled{opacity:.45;cursor:default}
.hapi-source-queue-row p{width:100%;margin:0;color:var(--text-error,#c44)}
.hapi-source-queue-row small{color:var(--dsw-alias-label-secondary)}
.hapi-queue-thumbnails{display:flex;gap:4px;max-width:45%;min-width:0;overflow:hidden;flex:none}
.hapi-queue-thumbnail{width:24px;height:24px;object-fit:cover;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs,4px);flex:none}
.hapi-queue-file{display:inline-flex;align-items:center;gap:4px;max-width:140px;min-width:0;height:24px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base)}
.hapi-queue-file>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.hapi-queue-file>svg{flex:none}
@media(pointer:coarse){.hapi-source-queue-row button,.hapi-source-queue-heading{min-width:44px;min-height:44px}.hapi-queue-actions{gap:2px}}
`
