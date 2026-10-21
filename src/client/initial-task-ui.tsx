import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { HapiRemoteApi } from '../client-api.ts'
import { InitialTaskController, type InitialFileUpload } from './initial-task.ts'
import type { WorkspaceTranslate } from './locales.ts'

export function useInitialTask(api: HapiRemoteApi, upload: InitialFileUpload, storageKey: string) {
    const task = useMemo(() => new InitialTaskController(api, upload, storageKey), [api, upload, storageKey])
    const state = useSyncExternalStore(task.subscribe, task.getSnapshot)
    useEffect(() => { void task.load() }, [task])
    useEffect(() => {
        if (!state.draft.sessionId || state.draft.receipt?.sourceConfirmed) return
        const timer = setInterval(() => { void task.refresh() }, 2000)
        return () => clearInterval(timer)
    }, [task, state.draft.sessionId, state.draft.receipt?.sourceConfirmed])
    return { task, state }
}

export function InitialTaskEditor({ task, disabled, t, open, confirmed }: {
    task: InitialTaskController; disabled: boolean; t: WorkspaceTranslate; open: (sessionId: string) => void; confirmed: () => void
}) {
    const state = useSyncExternalStore(task.subscribe, task.getSnapshot)
    const { draft } = state
    const confirmRef = useRef(confirmed); confirmRef.current = confirmed
    const acknowledged = useRef(false)
    useEffect(() => {
        if (draft.receipt?.sourceConfirmed && !acknowledged.current) { acknowledged.current = true; confirmRef.current() }
    }, [draft.receipt?.sourceConfirmed])
    const blocked = disabled || state.busy || !state.loaded || Boolean(draft.creationRequestId)
    return <section className="hapi-initial-task">
        <label>{t('firstTask')}<textarea rows={4} value={draft.text} placeholder={t('firstTaskOptional')} disabled={blocked} onChange={event => task.setText(event.currentTarget.value)}/></label>
        <label>{t('firstTaskAttachments')}<input type="file" multiple disabled={blocked} onChange={event => {
            const files = [...event.currentTarget.files ?? []]; event.currentTarget.value = ''; void task.addFiles(files)
        }}/></label>
        {draft.files.length > 0 && <ul>{draft.files.map(file => <li key={file.id}>{file.name} · {Math.ceil(file.blob.size / 1024)} KiB <button type="button" disabled={blocked} onClick={() => task.removeFile(file.id)}>{t('removeTaskAttachment')}</button></li>)}</ul>}
        {!state.loaded && <p role="status">{t('loading')}</p>}
        {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
        {draft.sessionId && <div className="hapi-task-receipt" data-first-task-operation={draft.operationId}>
            <p role="status">{draft.receipt?.sourceConfirmed ? t('firstTaskConfirmed') : t('firstTaskPending')}{draft.receipt ? ` · ${draft.receipt.status}` : ''}</p>
            {draft.receipt?.message && <p>{draft.receipt.message}</p>}
            <div className="hapi-button-row"><button type="button" disabled={state.busy} onClick={() => { void task.refresh() }}>{t('checkNativeResult')}</button>
                {(!draft.receipt || draft.receipt.canRetry) && <button type="button" disabled={state.busy} onClick={() => { void task.ready(draft.sessionId!, draft.creationRequestId!, true) }}>{t('retryFirstTask')}</button>}
                <button type="button" onClick={() => open(draft.sessionId!)}>{t('openCreatedSession')}</button></div>
        </div>}
        <style>{`.hapi-initial-task{display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px solid var(--hapi-border)}.hapi-initial-task textarea{resize:vertical;min-height:80px;padding:8px;border:1px solid var(--hapi-border);border-radius:6px;background:var(--hapi-bg);color:inherit;font:inherit}.hapi-initial-task>label{display:flex;flex-direction:column;gap:5px}.hapi-initial-task ul{list-style:none;padding:0;display:flex;flex-direction:column;gap:6px}.hapi-initial-task li{overflow-wrap:anywhere}.hapi-initial-task li>button{margin-left:8px}`}</style>
    </section>
}
