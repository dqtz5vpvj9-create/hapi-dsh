import { randomId } from './random-id.ts';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import { errorMessage, type WorkspaceController } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'

/** Select a real Host and directory, then create through its official Session Controller. */
export function DshSessionForm({ controller, close, t }: { controller: WorkspaceController; close: () => void; t: WorkspaceTranslate }) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const focused = controller.store.focusedPane().resource
    const selected = focused.kind === 'chat' ? snapshot.catalog.byId[focused.sessionId] : undefined
    const [hostId, setHostId] = useState(snapshot.creationContext?.hostId ?? selected?.hostId ?? 'local')
    const [directory, setDirectory] = useState(snapshot.creationContext?.directory ?? selected?.cwd ?? '')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [listing, setListing] = useState<DirectoryListing | null>(null)
    const [browsing, setBrowsing] = useState(false)
    const [hidden, setHidden] = useState(false)
    const [folder, setFolder] = useState('')
    const [creatingFolder, setCreatingFolder] = useState(false)
    const [uncertain, setUncertain] = useState(false)
    const attempt = useRef<{ hostId: string; directory: string; sessionId: string } | null>(null)
    const scan = useRef<AbortController | null>(null)
    const datalist = useId()
    const host = controller.host(hostId)
    const hosts = controller.availableHosts()
    const directories = [...new Set(Object.values(snapshot.catalog.byId).filter(row => row.hostId === hostId && row.cwd).map(row => row.cwd!))]
    useEffect(() => () => { scan.current?.abort() }, [])
    const browse = async (path?: string): Promise<void> => {
        const navigation = host?.navigation
        if (!navigation?.listDirectory) return
        scan.current?.abort()
        const current = new AbortController(); scan.current = current
        setBrowsing(true); setError(null)
        try {
            const next = await navigation.listDirectory(path, current.signal)
            if (!current.signal.aborted) { setListing(next); setDirectory(next.path) }
        } catch (reason) { if (!current.signal.aborted) setError(errorMessage(reason)) }
        finally { if (!current.signal.aborted) setBrowsing(false) }
    }
    return <form className="hapi-native-create" onSubmit={event => {
        event.preventDefault()
        if (pending || !host) return
        const request = attempt.current ?? { hostId, directory, sessionId: randomId() }
        attempt.current = request
        setPending(true); setError(null)
        void controller.createSession(request.hostId, request.directory, request.sessionId).then(close, reason => {
            // DSH's public named-blank contract makes an explicit retry of this
            // exact identity safe. It never changes the target directory mid-flight.
            setUncertain(true); setError(errorMessage(reason))
        }).finally(() => setPending(false))
    }}>
        <p>{t('dshCreateHelp')}</p>
        <label>{t('machine')}<select value={hostId} disabled={pending || uncertain} onChange={event => {
            scan.current?.abort(); setListing(null); setBrowsing(false); setHostId(event.currentTarget.value); setDirectory(''); setError(null)
        }}>{hosts.map(item => <option key={item.id} value={item.id}>{item.id === 'local' ? t('primaryHost') : item.label}</option>)}</select></label>
        <label>{t('directory')}<input value={directory} list={datalist} disabled={pending || uncertain} placeholder={t('hostDefaultDirectory')} onChange={event => setDirectory(event.currentTarget.value)}/></label>
        <datalist id={datalist}>{directories.map(path => <option key={path} value={path}/>)}</datalist>
        {host?.navigation.listDirectory && <button type="button" disabled={pending || uncertain || browsing} onClick={() => { void browse(directory.trim() || undefined) }}>{t('browseDirectory')}</button>}
        {listing && <section className="hapi-directory-browser" aria-label={t('browseDirectory')} aria-busy={browsing}>
            <nav aria-label={t('directory')}><button type="button" disabled={browsing || pending || uncertain} onClick={() => { void browse(listing.home) }}>{t('homeDirectory')}</button>
                {listing.crumbs.map(crumb => <button type="button" key={crumb.path} disabled={browsing || pending || uncertain} onClick={() => { void browse(crumb.path) }}>{crumb.name}</button>)}</nav>
            <div className="hapi-directory-entries">{listing.entries.filter(entry => hidden || !entry.hidden).map(entry => <button type="button" key={entry.path} disabled={browsing || pending || uncertain} onClick={() => { void browse(entry.path) }}>{entry.name}</button>)}</div>
            {listing.truncated && <p>{t('directoryTruncated')}</p>}
            <label className="hapi-create-checkbox"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.currentTarget.checked)}/>{t('showHidden')}</label>
            {host?.navigation.createDirectory && <div className="hapi-directory-create"><input aria-label={t('newDirectory')} value={folder} disabled={pending || uncertain || creatingFolder} onChange={event => setFolder(event.currentTarget.value)} placeholder={t('newDirectory')}/>
                <button type="button" disabled={!folder.trim() || pending || uncertain || creatingFolder} onClick={() => {
                    const navigation = host.navigation
                    setCreatingFolder(true); setError(null)
                    void navigation.createDirectory!(listing.path, folder.trim()).then(path => { setFolder(''); return browse(path) }, reason => setError(errorMessage(reason))).finally(() => setCreatingFolder(false))
                }}>{t('create')}</button></div>}
        </section>}
        {error && <p className="hapi-error" role="alert">{error}</p>}
        {uncertain && <p>{t('namedSessionRetry')}</p>}
        <div className="hapi-button-row"><button type="button" disabled={pending} onClick={close}>{t('cancel')}</button><button type="submit" disabled={pending || !host}>{pending ? t('loading') : uncertain ? t('retry') : t('create')}</button></div>
    </form>
}
