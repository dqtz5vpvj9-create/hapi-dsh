import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { CreationChoice } from './source-create-choice.tsx'
import { randomId } from './random-id.ts'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import { errorMessage, WorkspaceDirectoryRequired, type WorkspaceController } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { isSourceSessionId } from '../remote/protocol.ts'

/** Select a real Host and directory, then create through its official Session Controller. */
export function DshSessionForm({ controller, close, t, selectedHostId, initialDirectory, onPendingChange }: {
    controller: WorkspaceController; close: () => void; t: WorkspaceTranslate; selectedHostId?: string; initialDirectory?: string; onPendingChange?(busy: boolean): void
}) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const focused = controller.store.focusedPane().resource
    const selected = focused.kind === 'chat' ? snapshot.catalog.byId[focused.sessionId] : undefined
    const [hostId, setHostId] = useState(selectedHostId ?? snapshot.creationContext?.hostId ?? selected?.hostId ?? 'local')
    const context = snapshot.creationContext
    const [directory, setDirectory] = useState(initialDirectory ?? (selectedHostId === undefined
        ? context ? context.sourceSessionId && isSourceSessionId(context.sourceSessionId) ? '' : context.directory
            : selected && !isSourceSessionId(selected.sourceSessionId) ? selected.cwd ?? '' : '' : ''))
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
    const generation = useRef(0)
    const datalist = useId()
    const host = controller.host(hostId)
    const hosts = controller.availableHosts()
    const directories = [...new Set(Object.values(snapshot.catalog.byId).filter(row => row.hostId === hostId && row.cwd && !isSourceSessionId(row.sourceSessionId)).map(row => row.cwd!))]
    useEffect(() => { ++generation.current; return () => { ++generation.current; scan.current?.abort() } }, [])
    useEffect(() => { onPendingChange?.(pending); return () => onPendingChange?.(false) }, [pending, onPendingChange])
    const browse = async (path?: string): Promise<void> => {
        const navigation = host?.navigation
        if (!navigation?.listDirectory || host?.directoryBrowsing === false) return
        scan.current?.abort()
        const current = new AbortController(); scan.current = current
        setBrowsing(true); setError(null)
        try {
            const next = await navigation.listDirectory(path, current.signal)
            if (!current.signal.aborted) { setListing(next); setDirectory(next.path) }
        } catch (reason) { if (!current.signal.aborted) setError(errorMessage(reason)) }
        finally { if (!current.signal.aborted) setBrowsing(false) }
    }
    return <form className="hapi-native-create hhpi-source-create hhpi-dsh-create" onSubmit={event => {
        event.preventDefault()
        if (pending || !host) return
        const request = attempt.current ?? { hostId, directory, sessionId: randomId() }
        attempt.current = request
        const current = generation.current
        setPending(true); setError(null)
        void controller.createSession(request.hostId, request.directory, request.sessionId, () => generation.current === current).then(() => {
            if (generation.current === current) close()
        }, reason => {
            if (generation.current !== current) return
            // DSH's public named-blank contract makes an explicit retry of this
            // exact identity safe. It never changes the target directory mid-flight.
            if (reason instanceof WorkspaceDirectoryRequired) { attempt.current = null; setError(t('directoryRequired')) }
            else { setUncertain(true); setError(errorMessage(reason)) }
        }).finally(() => { if (generation.current === current) setPending(false) })
    }}>
        {selectedHostId === undefined && <CreationChoice label={t('machine')} value={hostId} disabled={pending || uncertain} placeholder={t('machine')}
            options={hosts.map(item => ({ id: item.id, label: item.id === 'local' ? t('primaryHost') : item.label }))}
            onChange={next => { scan.current?.abort(); setListing(null); setBrowsing(false); setHostId(next); setDirectory(''); setError(null) }}/>}
        <label className="hhpi-create-field">{t('directory')}<Input value={directory} list={datalist} disabled={pending || uncertain}
            placeholder={t('hostDefaultDirectory')} onChange={event => setDirectory(event.currentTarget.value)}/></label>
        <datalist id={datalist}>{directories.map(path => <option key={path} value={path}/>)}</datalist>
        {host?.navigation.listDirectory && host.directoryBrowsing !== false && <Button type="button" disabled={pending || uncertain || browsing} onClick={() => { void browse(directory.trim() || undefined) }}>{t('browseDirectory')}</Button>}
        {listing && <section className="hapi-directory-browser" aria-label={t('browseDirectory')} aria-busy={browsing}>
            <nav aria-label={t('directory')}><Button type="button" disabled={browsing || pending || uncertain} onClick={() => { void browse(listing.home) }}>{t('homeDirectory')}</Button>
                {listing.crumbs.map(crumb => <Button type="button" key={crumb.path} disabled={browsing || pending || uncertain} onClick={() => { void browse(crumb.path) }}>{crumb.name}</Button>)}</nav>
            <div className="hapi-directory-entries">{listing.entries.filter(entry => hidden || !entry.hidden).map(entry => <Button type="button" key={entry.path} disabled={browsing || pending || uncertain} onClick={() => { void browse(entry.path) }}>{entry.name}</Button>)}</div>
            {listing.truncated && <p>{t('directoryTruncated')}</p>}
            <label className="hapi-create-checkbox"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.currentTarget.checked)}/>{t('showHidden')}</label>
            {host?.navigation.createDirectory && <div className="hapi-directory-create"><Input aria-label={t('newDirectory')} value={folder} disabled={pending || uncertain || creatingFolder} onChange={event => setFolder(event.currentTarget.value)} placeholder={t('newDirectory')}/>
                <Button type="button" disabled={!folder.trim() || pending || uncertain || creatingFolder} onClick={() => {
                    const navigation = host.navigation
                    setCreatingFolder(true); setError(null)
                    void navigation.createDirectory!(listing.path, folder.trim()).then(path => { setFolder(''); return browse(path) }, reason => setError(errorMessage(reason))).finally(() => setCreatingFolder(false))
                }}>{t('create')}</Button></div>}
        </section>}
        {error && <p className="hapi-error" role="alert">{error}</p>}
        {uncertain && <p>{t('namedSessionRetry')}</p>}
        <div className="hapi-button-row"><Button type="button" onClick={() => { ++generation.current; close() }}>{t('cancel')}</Button><Button variant="primary" type="submit" disabled={pending || !host}>{pending ? t('loading') : uncertain ? t('retry') : t('create')}</Button></div>
    </form>
}
