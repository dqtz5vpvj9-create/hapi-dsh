/** HAPI share-page UX adapted from 0f8ef697. Copyright HAPI contributors.
 * AGPL-3.0-only. Selection only returns an immutable source address; delivery
 * and original Blob ownership remain with WorkspaceShareInbox. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkspaceController } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { SidebarSearchControls } from './sidebar-search-controls.tsx'
import { shareSeedText, type SharedFile, type ShareRecord } from './share-transfer.ts'
import { captureSharePicker, filterSharePicker, resolveShareCandidates, shareFileSize, sharePreviewText,
    type SharePickerCandidate, type SharePickerSnapshot } from '../workspace/share-picker.ts'
import { sidebarTimeRange } from '../workspace/sidebar-time.ts'

function saveOriginal(file: SharedFile): void {
    const url = URL.createObjectURL(file.blob), anchor = document.createElement('a')
    anchor.href = url; anchor.download = file.name; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function SingleFilePreview({ file }: { file: SharedFile }) {
    const [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false)
    const type = file.type || file.blob.type || 'application/octet-stream'
    useEffect(() => {
        setFailed(false)
        if (!type.startsWith('image/')) { setUrl(null); return }
        const value = URL.createObjectURL(file.blob); setUrl(value)
        return () => { URL.revokeObjectURL(value) }
    }, [file.blob, type])
    return <div className="hapi-share-file-preview">
        {url && !failed ? <img src={url} alt={file.name} onError={() => setFailed(true)}/>
            : <span className="hapi-share-file-badge" aria-hidden="true">{type.split('/')[1]?.slice(0, 4).toUpperCase() || 'FILE'}</span>}
        <div><strong>{file.name}</strong><small>{shareFileSize(file.blob.size)} · {type}</small></div>
    </div>
}

/** Preview is presentation only. The full payload and original files stay in IDB. */
export function SharePayloadPreview({ record, language }: { record: ShareRecord; language: string }) {
    const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en
    const first = record.files[0], text = sharePreviewText(record)
    return <section className="hapi-incoming-share-preview" aria-label={tr('Shared content preview', '分享内容预览')}>
        {!first ? <p data-share-text-preview>{text}</p>
            : record.files.length === 1 ? <SingleFilePreview file={first}/>
                : <div className="hapi-share-files-preview"><strong>{tr(`${record.files.length} files`, `${record.files.length} 个文件`)}</strong>
                    <p>{record.files.slice(0, 3).map(file => file.name).join(', ')}{record.files.length > 3 ? '…' : ''}</p></div>}
        <details className="hapi-share-originals"><summary>{tr('Review original content', '查看原始内容')}</summary>
            {shareSeedText(record) && <pre>{shareSeedText(record)}</pre>}
            {record.files.length > 0 && <ul>{record.files.map((file, index) => <li key={index}>
                <span>{file.name} · {shareFileSize(file.blob.size)}</span><button type="button" onClick={() => saveOriginal(file)}>{tr('Save original file', '保存原始文件')}</button>
            </li>)}</ul>}
        </details>
    </section>
}

export function ShareTargetPicker({ controller, busy, language, t, onSelect }: {
    controller: WorkspaceController; busy: boolean; language: string; t: WorkspaceTranslate
    onSelect(candidate: SharePickerCandidate): void
}) {
    const current = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const sidebar = useSyncExternalStore(controller.sidebar.subscribe, controller.sidebar.getSnapshot)
    const [snapshot, setSnapshot] = useState<SharePickerSnapshot | null>(null)
    const [query, setQuery] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState(''), [expanded, setExpanded] = useState(true)
    const input = useRef<HTMLInputElement>(null), tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en
    const discovery = current.catalogDiscovery
    useEffect(() => {
        if (!snapshot && discovery.phase !== 'pending') setSnapshot(captureSharePicker(current.catalog, current.machines))
    }, [snapshot, discovery, current.catalog, current.machines])
    const capture = (): void => { setSnapshot(captureSharePicker(controller.getSnapshot().catalog, controller.getSnapshot().machines)) }
    const range = useMemo(() => sidebarTimeRange(start, end), [start, end])
    const results = useMemo(() => snapshot ? filterSharePicker(snapshot, query, range, sidebar.preferences.sessionPreviewLimit) : null,
        [snapshot, query, range, sidebar.preferences.sessionPreviewLimit])
    const availability = useMemo(() => resolveShareCandidates(results?.candidates ?? [], current.catalog), [results, current.catalog])
    const unavailable = discovery.hosts.filter(host => host.phase === 'unavailable')
    const hasLoadedHost = discovery.hosts.some(host => host.phase === 'ready')
    const statusLabel = (status: 'pending' | 'missing' | 'offline' | 'ambiguous'): string => status === 'offline' ? tr('Host offline', 'Host 离线')
        : status === 'pending' ? tr('Source identity is still loading', '源会话身份仍在加载')
            : status === 'ambiguous' ? tr('More than one binding reports this source. Refresh the list.', '多个显示绑定报告了同一源会话，请刷新列表。')
                : tr('This source is no longer listed. Refresh the list.', '该源会话已不在列表中，请刷新列表。')
    return <section className="hapi-share-picker" aria-label={tr('Choose share destination', '选择分享目标')}>
        <fieldset disabled={busy}><SidebarSearchControls query={query} onQueryChange={setQuery} start={start} end={end}
            onDatesChange={(from, through) => { setStart(from); setEnd(through) }} activityDates={snapshot?.activityDates ?? new Set()}
            expanded={expanded} onExpandedChange={setExpanded} inputRef={input} t={t}/></fieldset>
        {!snapshot && <p role="status">{tr('Loading the first conversation snapshot…', '正在加载首次会话快照…')}
            {hasLoadedHost && <button type="button" disabled={busy} onClick={capture}>{tr('Use loaded conversations', '使用已加载的会话')}</button>}</p>}
        {(discovery.source === 'unavailable' || unavailable.length > 0) && <p className="hapi-share-catalog-status" role="status">
            {discovery.source === 'unavailable' && <span>{tr('The original HAPI Hub is unavailable. Loaded conversations are still selectable.', '原 HAPI Hub 当前不可用，仍可选择已加载的会话。')}{discovery.sourceError ? ` ${discovery.sourceError}` : ''}</span>}
            {unavailable.length > 0 && <span>{tr('Unavailable Hosts', '不可用的 Host')}: {unavailable.map(host => host.label).join(', ')}</span>}
        </p>}
        {results && <>
            <header><h3>{results.searching ? tr('Matching sessions', '匹配的会话') : tr('Recent active sessions', '最近活跃会话')}</h3>
                <button type="button" disabled={busy || !hasLoadedHost} onClick={capture}>{tr('Refresh conversation snapshot', '刷新会话快照')}</button></header>
            {results.hiddenActive > 0 && <p className="hapi-share-hidden-count" role="status">{tr(
                `${results.hiddenActive} more active sessions are hidden. Search to see all matching sessions.`,
                `还有 ${results.hiddenActive} 个活跃会话未显示，搜索可查看所有匹配会话。`)}</p>}
            <div className="hapi-share-destinations">{results.candidates.map(candidate => {
                const available = availability.get(candidate.id), status = available?.status ?? 'missing'
                return <button type="button" key={candidate.id} data-share-candidate={candidate.id} disabled={busy || status !== 'ready'} onClick={() => onSelect(candidate)}>
                    <strong>{candidate.title}</strong><small>{candidate.hostLabel} · {candidate.machineLabel} · {candidate.directory}</small>
                    {status !== 'ready' && <small>{statusLabel(status)}</small>}
                </button>
            })}</div>
            {!results.candidates.length && <p>{results.searching ? tr('No matching sessions. Change the search or create a conversation.', '没有匹配的会话，可修改搜索或新建会话。')
                : tr('No active sessions in this snapshot. Search to include inactive conversations.', '当前快照没有活跃会话，搜索可包含离线会话。')}</p>}
            {!results.searching && <button type="button" disabled={busy} onClick={() => { setQuery('*'); setExpanded(true) }}>{tr('Browse all conversations', '浏览全部会话')}</button>}
        </>}
    </section>
}

export const sharePickerStyles = `
.hapi-incoming-share-dialog{--hapi-bg:var(--dsw-alias-bg-layer-1,#fff);--hapi-muted:var(--dsw-alias-bg-layer-2,#f6f7f8);--hapi-fg:var(--dsw-alias-label-primary,#22272c);--hapi-secondary:var(--dsw-alias-label-secondary,#65717b);--hapi-border:var(--dsw-alias-border-l2,#d8dedf);--hapi-hover:var(--dsw-alias-interactive-bg-hover,#eef2f1);--hapi-accent:var(--hapi-palette-accent,var(--dsw-alias-brand-primary,#359b6c))}
.hapi-incoming-share-preview p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.hapi-share-file-preview{display:flex;align-items:center;gap:12px;min-width:0}
.hapi-share-file-preview img,.hapi-share-file-badge{width:64px;height:64px;flex:none;object-fit:cover;border-radius:8px}
.hapi-share-file-badge{display:grid;place-items:center;background:var(--hapi-hover,#8882);font-size:12px}
.hapi-share-file-preview>div{display:grid;gap:6px;min-width:0;overflow-wrap:anywhere}
.hapi-share-file-preview small{color:var(--hapi-secondary)}
.hapi-share-originals{margin-top:10px}.hapi-share-originals summary{cursor:pointer;font-size:12px}.hapi-share-originals pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
.hapi-share-picker{margin-top:16px;min-width:0}.hapi-share-picker fieldset{margin:0;padding:0;min-width:0;border:0}
.hapi-share-picker>header{display:flex;align-items:center;justify-content:space-between;margin-top:12px;gap:8px}.hapi-share-picker h3{font-size:14px;margin:0}
.hapi-share-picker>header>button{font-size:11px}.hapi-share-picker .hapi-share-hidden-count{font-size:12px;color:var(--hapi-secondary)}
.hapi-share-catalog-status{display:grid;gap:6px;font-size:12px;overflow-wrap:anywhere}
.hapi-share-picker .hapi-sidebar-search-controls{width:100%;box-sizing:border-box}.hapi-share-picker .hapi-search{min-width:0}
.hapi-share-picker .hapi-sidebar-calendar{right:0;max-width:calc(100vw - 64px)}
.hapi-share-picker [role=status]>button{margin-inline-start:8px}
@media(max-width:480px){.hapi-share-picker>header{align-items:flex-start;flex-direction:column}.hapi-share-picker .hapi-sidebar-calendar{max-width:calc(100vw - 56px)}}
`
