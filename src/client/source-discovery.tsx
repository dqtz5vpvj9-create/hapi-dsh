import { useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogMachine } from '../client-api.ts'
import type { WorkspaceCatalogRow } from './controller.ts'
import { discoveredSourceKey, type SourceDiscovery } from '../source-discovery-types.ts'
import { discoveredSourceTarget, sourceDiscoveryRows, type SourceDiscoveryFilters, type SourceDiscoveryRow } from '../workspace/source-discovery.ts'
import { normalizeSessionPreviewLimit } from '../workspace/sidebar-sections.ts'
import { SourceResumeMenu } from './source-resume-menu.tsx'

type SourceTarget = ReturnType<typeof discoveredSourceTarget>
interface SourceDiscoveryProps extends SourceDiscoveryFilters {
    discovery: SourceDiscovery | null | undefined
    catalogRows: readonly Pick<WorkspaceCatalogRow, 'projectionValues'>[]
    machines: readonly Pick<CatalogMachine, 'id' | 'label'>[]
    previewLimit?: number | undefined
    language?: string | undefined
    statusOnly?: boolean | undefined
    onOpen(source: SourceTarget): Promise<void>
    onRefresh(): Promise<void>
}
const message = (error: unknown): string => error && typeof error === 'object' && typeof Reflect.get(error, 'message') === 'string'
    ? String(Reflect.get(error, 'message')) : 'The original source session could not be opened.'

export const compactDiscoveryStyles = `.hapi-session-row.hapi-discovery-row{padding:0;position:relative;min-width:0}.hapi-session-open.hapi-discovery-open{display:block;padding:7px 8px}.hapi-source-activity{color:var(--hapi-secondary);font-size:10px}.hapi-source-activity[data-running]{color:var(--hapi-accent)}.hapi-discovery-row>.hapi-menu{position:absolute;right:4px;top:4px;opacity:0}.hapi-discovery-row:hover>.hapi-menu,.hapi-discovery-row:focus-within>.hapi-menu,.hapi-discovery-row>.hapi-menu[open]{opacity:1}.hapi-discovery-row code{overflow-wrap:anywhere;white-space:normal}.hapi-discovery-status,.hapi-discovery-error{font:var(--hapi-font-small,12px/1.5 system-ui);padding:4px 8px}`

const css = `.hapi-discovered-sources{padding:7px 0;border-top:1px solid var(--hapi-border);min-width:0}.hapi-discovered-sources>header{display:flex;gap:6px;align-items:center;padding:6px 8px;font:var(--hapi-font-small,12px/1.5 system-ui);color:var(--hapi-secondary)}.hapi-discovered-sources>header strong{flex:1}.hapi-discovered-sources button{font:inherit;color:inherit;cursor:pointer}.hapi-discovered-sources button:disabled{cursor:default;opacity:.6}.hapi-discovered-sources>header button,.hapi-discovery-pages button,.hapi-discovery-retry{background:transparent;border:1px solid var(--hapi-border);border-radius:5px;padding:3px 7px}.hapi-discovered-sources>p,.hapi-discovery-error{padding:6px 8px;margin:0;font:var(--hapi-font-small,12px/1.5 system-ui);overflow-wrap:anywhere}.hapi-discovery-error{color:var(--hapi-danger,#b53232)}.hapi-discovery-row{padding:4px 8px;min-width:0}.hapi-discovery-open{display:grid;gap:2px;text-align:left;background:transparent;border:0;border-radius:5px;width:100%;min-width:0;padding:5px}.hapi-discovery-open:hover{background:var(--hapi-hover)}.hapi-discovery-open>strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hapi-discovery-open>small{color:var(--hapi-secondary);overflow-wrap:anywhere}.hapi-discovery-status{color:var(--hapi-secondary);font:var(--hapi-font-small,12px/1.5 system-ui);padding:0 5px}.hapi-discovery-identities{font:var(--hapi-font-small,12px/1.5 system-ui);padding:3px 5px;color:var(--hapi-secondary)}.hapi-discovery-identities code{display:block;overflow-wrap:anywhere;user-select:all}.hapi-discovery-pages{display:flex;gap:6px;flex-wrap:wrap;padding:5px 8px}`

export function DiscoveredSourceRow({ row, chinese, onOpen }: { row: SourceDiscoveryRow; chinese: boolean; onOpen(source: SourceTarget): Promise<void> }) {
    const { source, machineLabel } = row
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
    const tr = (en: string, zh: string): string => chinese ? zh : en
    const open = async (): Promise<void> => {
        if (busy) return
        setBusy(true); setError(null)
        try { await onOpen(discoveredSourceTarget(source)) }
        catch (failure) { setError(message(failure)) }
        finally { setBusy(false) }
    }
    const status = busy ? tr('Opening the original session…', '正在打开原会话…')
        : source.binding === 'failed' ? tr('Session loading failed', '会话加载失败')
            : source.binding === 'attached' ? tr('Session ready; synchronizing the list', '会话已就绪，正在同步列表')
                : tr('Session not loaded yet', '会话尚未加载')
    return <article className="hapi-session-row hapi-discovery-row" data-hapi-discovered-source={source.sourceSessionId} data-hapi-source-hub={source.hubId}
        data-session-view-anchor={`source:${discoveredSourceKey(source)}`}>
        <button type="button" className="hapi-session-open hapi-discovery-open" disabled={busy} onClick={() => { void open() }} title={[source.title, machineLabel, source.cwd].filter(Boolean).join('\n')}>
            <div className="hapi-session-title"><span className="hapi-source-activity" data-running={source.thinking || undefined}>●</span><span>{source.title}</span></div>
            <div className="hapi-session-meta"><span className={`hapi-engine hapi-engine-${source.engine === 'codex' ? 'codex' : 'dsh'}`}>{source.engine === 'codex' ? 'Codex' : source.engine === 'dsh' ? 'DSH' : source.engine}</span><span className="hapi-ellipsis">{machineLabel}</span><span className="hapi-ellipsis hapi-session-directory">{source.cwd?.split(/[\\/]/).filter(Boolean).at(-1)}</span></div>
        </button>
        {(busy || source.binding === 'failed') && <div className="hapi-discovery-status" role="status">{status}</div>}
        {(error || source.error) && <p role="alert" className="hapi-discovery-error">{error || source.error}</p>}
        {(error || source.binding === 'failed') && <button type="button" className="hapi-discovery-retry" disabled={busy} onClick={() => { void open() }}>{tr('Retry opening', '重试打开')}</button>}
        <details className="hapi-menu hapi-discovery-identities"><summary aria-label={tr('Original IDs', '原始 ID')}>···</summary><div className="hapi-menu-content">
            <span>HAPI</span><code>{source.sourceSessionId}</code>
            <span>{tr('Native', '原生')}</span><code>{source.nativeId ?? tr('Not published by the source', '源端尚未发布')}</code>
            <button type="button" onClick={() => { void navigator.clipboard.writeText(source.sourceSessionId).catch(error => setError(message(error))) }}>{tr('Copy source ID', '复制来源 ID')}</button>
            <button type="button" disabled={!source.nativeId} onClick={() => { if (source.nativeId) void navigator.clipboard.writeText(source.nativeId).catch(error => setError(message(error))) }}>{tr('Copy native ID', '复制原生 ID')}</button>
            <SourceResumeMenu identity={{ engine: source.engine, nativeId: source.nativeId, directory: source.cwd, machineId: source.machineId, machineName: source.machineName }} chinese={chinese}/>
        </div></details>
    </article>
}

/** Additional rows in the same sidebar, never fabricated SessionReferences. */
export function SourceDiscoveryList(props: SourceDiscoveryProps) {
    const { discovery, catalogRows, machines, language, onOpen, onRefresh } = props
    const chinese = language?.startsWith('zh') === true
    const tr = (en: string, zh: string): string => chinese ? zh : en
    const rows = useMemo(() => sourceDiscoveryRows(discovery, catalogRows, machines, props),
        [discovery, catalogRows, machines, props.query, props.engine, props.machine, props.archived, props.activeOnly, props.filter, props.timeRange, props.isUnread])
    const step = normalizeSessionPreviewLimit(props.previewLimit ?? 8)
    const scope = JSON.stringify([props.query, props.engine, props.machine, props.archived, props.activeOnly, props.filter, props.timeRange, step])
    const [preview, setPreview] = useState({ scope, count: step })
    const cap = Math.max(step, preview.scope === scope ? preview.count : step), shown = rows.slice(0, cap)
    const more = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const node = more.current, viewport = node?.closest('.hapi-session-list')
        if (!node || !viewport || cap >= rows.length) return
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting) && viewport.scrollTop > 0) setPreview({ scope, count: cap + step })
        }, { root: viewport, threshold: 0.1 })
        observer.observe(node)
        return () => observer.disconnect()
    }, [scope, cap, step, rows.length])
    const [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState<string | null>(null)
    const refresh = async (): Promise<void> => {
        if (refreshing) return
        setRefreshing(true); setRefreshError(null)
        try { await onRefresh() } catch (failure) { setRefreshError(message(failure)) }
        finally { setRefreshing(false) }
    }
    if (!discovery || discovery.phase === 'ready' && (!rows.length || props.statusOnly)) return null
    return <section className="hapi-discovered-sources" aria-label={tr('Discovered source sessions', '已发现的源会话')} data-hapi-source-discovery={discovery.phase}>
        <style>{css}</style>
        {discovery.phase !== 'ready' && <header><button type="button" disabled={refreshing} onClick={() => { void refresh() }}>{refreshing ? tr('Refreshing…', '正在刷新…') : tr('Refresh source list', '刷新源列表')}</button></header>}
        {discovery.phase !== 'ready' && <p role="status">{discovery.phase === 'pending' ? tr('The original session catalog is loading.', '正在读取原始会话目录。')
            : discovery.phase === 'stale' ? tr('The source catalog is stale. These are the last observed sessions; refresh it after reconnecting.', '源目录已过期。当前保留上次读取的会话，连接恢复后请刷新。')
                : tr('The source catalog is unavailable. Reconnect the original Hub and retry.', '源目录当前不可用，请恢复原 Hub 连接后重试。')}</p>}
        {(refreshError || discovery.error) && <p role="alert" className="hapi-discovery-error">{refreshError || discovery.error}</p>}
        {!props.statusOnly && shown.map(row => <DiscoveredSourceRow key={discoveredSourceKey(row.source)} row={row} chinese={chinese} onOpen={onOpen}/>)}
        {!props.statusOnly && (rows.length > shown.length || cap > step) && <div ref={more} className="hapi-discovery-pages" data-hapi-source-discovery-more="">
            {rows.length > shown.length && <button type="button" onClick={() => setPreview({ scope, count: cap + step })}>{tr('Show more sessions', '显示更多会话')} · {Math.min(step, rows.length - shown.length)}</button>}
            {cap > step && <button type="button" onClick={() => setPreview({ scope, count: Math.max(step, cap - step) })}>{tr('Show fewer sessions', '收起部分会话')}</button>}
        </div>}
    </section>
}
