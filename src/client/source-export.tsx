import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AppSourceRoute } from '../workspace/app-service-types.ts'
import { sourceRoute } from '../shared/source-capability.ts'
import type { WorkspaceCatalogRow, WorkspaceController } from './controller.ts'
import { downloadPreparedSourceExport, SourceExportController, type SourceExportFormat, type SourceExportPreferences, type SourceExportApi } from './source-export-state.ts'

/** Keep the row's original Host owner through offline/reconnect and graph replacement. */
export function WorkspaceSourceExportPanel({ controller, row, language, onDownloaded }: {
    controller: WorkspaceController; row: Pick<WorkspaceCatalogRow, 'id' | 'hostId' | 'sourceSessionId'>
    language?: string | undefined; onDownloaded?: (() => void) | undefined
}) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const [refreshing, setRefreshing] = useState(false), [error, setError] = useState<string | null>(null)
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    const tr = (en: string, zh: string): string => language?.startsWith('zh') ? zh : en
    const source = useMemo(() => { try { return { value: sourceRoute(row.hostId, row.sourceSessionId, 'local') } }
        catch (failure) { return { error: failure instanceof Error ? failure.message : String(failure) } } }, [row.hostId, row.sourceSessionId])
    const current = snapshot.catalog.byId[row.id], host = controller.host(row.hostId)
    const unavailable = source.error ?? (!host || current?.hostOnline === false
        ? tr('The original Host is offline. Reconnect it and refresh sources to export this conversation.', '原始 Host 已离线。请重新连接后刷新来源，再导出此会话。')
        : !current || current.hostId !== row.hostId || current.sourceSessionId !== row.sourceSessionId
        ? tr('The original source is not in this Host catalog. Refresh sources or close this dialog and select it again.', '原始来源尚未出现在此 Host 的目录中。请刷新来源，或关闭对话框后重新选择。')
            : !host.sourceExporter ? tr('Export is not registered on the original Host. Reconnect that Host after enabling its source reader.', '原始 Host 尚未注册导出服务。请启用其源读取服务后重新连接。') : null)
    if (unavailable || !source.value || !host?.sourceExporter) return <section aria-label={tr('Export original conversation', '导出完整原会话')}>
        <p role="alert">{unavailable}</p>{error && <p role="alert">{error}</p>}
        <button type="button" disabled={refreshing} onClick={() => {
            setRefreshing(true); setError(null)
            void controller.refresh().catch(failure => { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) })
                .finally(() => { if (mounted.current) setRefreshing(false) })
        }}>{tr('Refresh sources', '刷新来源')}</button>
    </section>
    return <SourceExportPanel api={host.sourceExporter} source={source.value} language={language} preferences={controller.options.storage}
        mode="download" onDownloaded={onDownloaded}/>
}

/** Shared by the row's original export dialog and the official History tab. */
export function SourceExportPanel({ api, source, language, preferences, mode = 'prepare', onDownloaded }: {
    api: SourceExportApi; source: AppSourceRoute; language?: string | undefined
    preferences?: SourceExportPreferences | undefined; mode?: 'prepare' | 'download'; onDownloaded?: (() => void) | undefined
}) {
    const controller = useMemo(() => new SourceExportController(api, source, preferences), [api, source.hostId, source.kind, source.sessionId, preferences])
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
            const blob = await downloadPreparedSourceExport(result, abort.signal)
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
        <p>{tr('Download the original source events as JSON or Markdown, including earlier content and structured tool or attachment data.', '导出原始来源的 JSON 或 Markdown 事件，包含较早内容以及工具、附件等完整结构数据。')}</p>
        <label>{tr('Export format', '导出格式')}<select aria-label={tr('Export format', '导出格式')} value={state.format} disabled={busy} onChange={event => { controller.setFormat(event.currentTarget.value as SourceExportFormat); setError(null) }}>
            <option value="json">JSON</option><option value="markdown">Markdown</option>
        </select></label>
        {state.result?.type === 'warning' ? <div role="alert">
            <p>{tr(`The source has at least ${state.result.count.toLocaleString()} events (${Math.ceil(state.result.estimatedBytes / 1024).toLocaleString()} KiB read so far). Continue to export the complete conversation.`,
                `源会话至少包含 ${state.result.count.toLocaleString()} 条事件，目前已读取 ${Math.ceil(state.result.estimatedBytes / 1024).toLocaleString()} KiB。确认后继续导出完整会话。`)}</p>
            <button type="button" disabled={busy} onClick={() => { void prepare(true) }}>{tr('Export all events', '导出全部事件')}</button>
        </div> : <button type="button" disabled={busy} onClick={() => { void prepare() }}>{mode === 'download' ? tr('Download conversation', '下载会话') : tr('Prepare download', '准备下载')}</button>}
        {busy && <p role="status">{tr('Preparing original export…', '正在准备原始导出…')}</p>}
        {state.persistenceError && <p role="alert">{tr('Export is available, but the format preference could not be saved: ', '可以继续导出，但无法保存格式偏好：')}{state.persistenceError}</p>}
        {(state.error || error) && <p className="hapi-error" role="alert">{state.error || error}</p>}
        {state.result?.type === 'ready' && mode === 'prepare' && <a href={state.result.url} download={state.result.fileName}>{tr('Download', '下载')} {state.result.fileName} ({Math.ceil(state.result.bytes / 1024)} KB)</a>}
    </section>
}
