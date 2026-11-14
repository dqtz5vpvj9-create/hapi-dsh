/** Source-owned folder selection; the official browse backend supplies every path. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SourceDirectoryIdentity, SourceDirectoryListing } from '../workspace/source-api.ts'

export type SourceDirectoryBrowser = (source: SourceDirectoryIdentity, path: string | undefined, signal: AbortSignal) => Promise<SourceDirectoryListing>
export function SourceDirectoryPicker({ source, value, disabled, language, browse, onChange }: {
    source: SourceDirectoryIdentity; value: string; disabled: boolean; language: string; browse?: SourceDirectoryBrowser; onChange(path: string): void
}) {
    const zh = language.startsWith('zh'), text = (en: string, cn: string) => zh ? cn : en, id = useId()
    const [open, setOpen] = useState(false), [manual, setManual] = useState(false), [page, setPage] = useState<SourceDirectoryListing | null>(null)
    const [busy, setBusy] = useState(false), [error, setError] = useState(false), [hidden, setHidden] = useState(false)
    const pending = useRef<AbortController | null>(null)
    useEffect(() => {
        setPage(null); setOpen(false); setBusy(false); setError(false)
        return () => pending.current?.abort()
    }, [browse, source.machineId, source.sourceId, source.engine])
    const cancel = (): void => { pending.current?.abort(); setOpen(false); setBusy(false); setError(false) }
    const scan = async (path?: string): Promise<void> => {
        pending.current?.abort()
        const current = new AbortController(); pending.current = current
        setOpen(true); setBusy(true); setError(false)
        try {
            if (!browse) throw new Error('The source directory browser is unavailable')
            const next = await browse(source, path, AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]))
            if (current.signal.aborted) return
            if (next.source.machineId !== source.machineId || next.source.sourceId !== source.sourceId || next.source.engine !== source.engine) throw new Error('Wrong source directory result')
            setPage(next)
        } catch { if (!current.signal.aborted) setError(true) }
        finally { if (!current.signal.aborted) setBusy(false) }
    }
    const listing = page?.listing
    return <div className="hhpi-source-folder-picker">
        <div className="hhpi-create-field"><span>{text('Working directory', '工作目录')}</span>
            <Button type="button" variant="outline" disabled={disabled} onClick={() => { void scan(value || undefined) }}>{text('Choose folder', '选择文件夹')}</Button>
            <span title={value}>{value || text('Choose a folder on this Agent’s machine.', '请选择此 Agent 所在机器上的文件夹。')}</span>
        </div>
        {open && <section className="hapi-directory-browser" aria-label={text('Choose folder', '选择文件夹')} aria-busy={busy}>
            <nav aria-label={text('Source roots', '磁盘与主目录')}><Button type="button" disabled={disabled || busy} onClick={() => { void scan() }}>{text('Home', '主目录')}</Button>
                {page?.roots.map(root => <Button type="button" key={root.path} disabled={disabled || busy} onClick={() => { void scan(root.path) }}>{root.name}</Button>)}</nav>
            {busy && <p role="status">{text('Loading folders…', '正在加载文件夹…')}</p>}
            {error && <div><p role="alert">{text('Folders on this source could not be opened. Retry or reconnect its machine.', '暂时无法浏览此来源的文件夹，请重试或重新连接该机器。')}</p>
                <Button type="button" disabled={disabled || busy} onClick={() => { void scan(listing?.path || value || undefined) }}>{text('Retry', '重试')}</Button></div>}
            {listing && <>
                <nav aria-label={text('Current folder', '当前文件夹')}>
                    {listing.crumbs.length > 1 && <Button type="button" disabled={disabled || busy} onClick={() => { void scan(listing.crumbs.at(-2)!.path) }}>{text('Parent folder', '上一级')}</Button>}
                    {listing.crumbs.map(crumb => <Button type="button" key={crumb.path} disabled={disabled || busy || crumb.path === listing.path} onClick={() => { void scan(crumb.path) }}>{crumb.name}</Button>)}
                </nav>
                <div className="hapi-directory-entries">{listing.entries.filter(entry => hidden || !entry.hidden).map(entry => <Button type="button" key={entry.path} disabled={disabled || busy} onClick={() => { void scan(entry.path) }}>{entry.name}</Button>)}</div>
                {!listing.entries.length && !busy && <p>{text('No subfolders in this folder.', '此文件夹没有子文件夹。')}</p>}
                {listing.truncated && <p>{text('Only the first folders are shown.', '文件夹较多，当前仅显示前面一部分。')}</p>}
                <label className="hapi-create-checkbox"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.currentTarget.checked)}/>{text('Show hidden folders', '显示隐藏文件夹')}</label>
            </>}
            <div className="hapi-button-row"><Button type="button" onClick={cancel}>{text('Cancel selection', '取消选择')}</Button>
                <Button type="button" variant="primary" disabled={disabled || busy || error || !listing} onClick={() => { if (listing) { onChange(listing.path); cancel() } }}>{text('Select this folder', '选择此文件夹')}</Button></div>
        </section>}
        <Button type="button" disabled={disabled} onClick={() => setManual(current => !current)} aria-expanded={manual}>{text('Enter a path (optional)', '手动输入路径（可选）')}</Button>
        {manual && <label className="hhpi-create-field" htmlFor={id}>{text('Working directory', '工作目录')}<Input id={id} value={value} disabled={disabled}
            placeholder={text('Absolute path on this Agent’s machine', '此 Agent 所在机器上的绝对路径')} onChange={event => onChange(event.currentTarget.value)}/></label>}
    </div>
}
