import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { HapiRemoteApi } from '../client-api.ts'
import type { WorkbenchSource } from '../workbench-types.ts'
import { downloadPreparedSourceExport, SourceExportController, type SourceExportFormat, type SourceExportPreferences } from './source-export-state.ts'

/** Shared by the row's original export dialog and the official History tab. */
export function SourceExportPanel({ api, source, language, preferences, mode = 'prepare', onDownloaded }: {
    api: Pick<HapiRemoteApi, 'sourceExport'>; source: WorkbenchSource; language?: string | undefined
    preferences?: SourceExportPreferences | undefined; mode?: 'prepare' | 'download'; onDownloaded?: (() => void) | undefined
}) {
    const controller = useMemo(() => new SourceExportController(api, source, preferences), [api, source.sourceHubId, source.sourceSessionId, source.machineId, preferences])
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const [downloading, setDownloading] = useState(false), [error, setError] = useState<string | null>(null)
    const download = useRef<AbortController | null>(null), mounted = useRef(true)
    const tr = (en: string, zh: string): string => language?.startsWith('zh') ? zh : en
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.dispose(); download.current?.abort() } }, [controller])
    const prepare = async (force = false): Promise<void> => {
        if (state.busy || download.current) return
        setError(null)
        const result = await controller.prepare(force)
        if (!mounted.current || !result || mode !== 'download') return
        const abort = new AbortController(); download.current = abort; setDownloading(true)
        try {
            const blob = await downloadPreparedSourceExport(result, location.href, fetch, abort.signal)
            abort.signal.throwIfAborted()
            const url = URL.createObjectURL(blob), anchor = document.createElement('a')
            anchor.href = url; anchor.download = result.fileName; anchor.rel = 'noopener'; document.body.append(anchor); anchor.click(); anchor.remove()
            setTimeout(() => URL.revokeObjectURL(url), 30_000)
            onDownloaded?.()
        } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) }
        finally { if (download.current === abort) download.current = null; if (mounted.current) setDownloading(false) }
    }
    const busy = state.busy || downloading
    return <section className="hapi-source-export" aria-label={tr('Export original conversation', '导出完整原会话')}>
        <h3>{tr('Export original conversation', '导出完整原会话')}</h3>
        <p>{tr('Download the original Hub history as JSON or Markdown. Hidden and earlier messages are included by the source.', '下载原 Hub 的 JSON 或 Markdown 历史，由源端包含较早及未显示的消息。')}</p>
        <label>{tr('Export format', '导出格式')}<select aria-label={tr('Export format', '导出格式')} value={state.format} disabled={busy} onChange={event => { controller.setFormat(event.currentTarget.value as SourceExportFormat); setError(null) }}>
            <option value="json">JSON</option><option value="markdown">Markdown</option>
        </select></label>
        {state.result?.type === 'warning' ? <div role="alert">
            <p>{tr(`This export contains ${state.result.count.toLocaleString()} messages and may take longer (${Math.ceil(state.result.estimatedBytes / 1024).toLocaleString()} KiB estimated).`,
                `本次导出包含 ${state.result.count.toLocaleString()} 条消息，预计 ${Math.ceil(state.result.estimatedBytes / 1024).toLocaleString()} KiB，可能需要较长时间。`)}</p>
            <button type="button" disabled={busy} onClick={() => { void prepare(true) }}>{tr('Export all messages', '导出全部消息')}</button>
        </div> : <button type="button" disabled={busy} onClick={() => { void prepare() }}>{mode === 'download' ? tr('Download conversation', '下载会话') : tr('Prepare download', '准备下载')}</button>}
        {busy && <p role="status">{tr('Preparing original export…', '正在准备原始导出…')}</p>}
        {state.persistenceError && <p role="alert">{tr('Export is available, but the format preference could not be saved: ', '可以继续导出，但无法保存格式偏好：')}{state.persistenceError}</p>}
        {(state.error || error) && <p className="hapi-error" role="alert">{state.error || error}</p>}
        {state.result?.type === 'ready' && mode === 'prepare' && <a href={state.result.url} download={state.result.fileName}>{tr('Download', '下载')} {state.result.fileName} ({Math.ceil(state.result.bytes / 1024)} KB)</a>}
    </section>
}
