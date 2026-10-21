import { useEffect, useState } from 'react'
import { remoteValue, type CatalogMachine, type HapiRemoteApi, type SourceDirectory } from '../client-api.ts'
import { errorMessage } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'

export function joinSourceDirectory(base: string, name: string): string {
    if (!name || /[\\/\0]/.test(name) || name === '.' || name === '..') throw new Error('Invalid source directory entry')
    const separator = base.includes('\\') ? '\\' : '/'
    return `${base.replace(/[\\/]+$/, '')}${separator}${name}`
}
export function parentSourceDirectory(path: string): string {
    const separator = path.includes('\\') ? '\\' : '/'
    const clean = path.replace(/[\\/]+$/, '')
    if (/^[A-Za-z]:$/.test(clean)) return `${clean}${separator}`
    const index = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
    if (index < 0) return path
    const parent = clean.slice(0, index)
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}${separator}`
    // A UNC share is a filesystem root; the picker never fabricates a parent.
    if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+$/.test(clean)) return path
    return parent || separator
}

/** Only a creation-context picker; all normal file browsing remains the official DSH plugin. */
export function SourceDirectoryPicker({ api, machine, value, recent, disabled, onChoose, t }: {
    api: HapiRemoteApi; machine: CatalogMachine | undefined; value: string; recent: readonly string[];
    disabled: boolean; onChoose: (path: string) => void; t: WorkspaceTranslate
}) {
    const [open, setOpen] = useState(false)
    const [path, setPath] = useState('')
    const [hidden, setHidden] = useState(false)
    const [filter, setFilter] = useState('')
    const [limit, setLimit] = useState(300)
    const [revision, setRevision] = useState(0)
    const [entries, setEntries] = useState<SourceDirectory['entries']>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => { setOpen(false); setEntries([]) }, [machine?.id])
    useEffect(() => {
        if (!open || !machine || !path) return
        let active = true
        setBusy(true); setError(null); setEntries([]); setLimit(300)
        const timer = setTimeout(() => {
            void api.sourceMachineDirectory({ machineId: machine.id, path, includeHidden: hidden }).then(remoteValue).then(result => {
                if (active) setEntries(result.entries.filter(entry => entry.type === 'directory' && !entry.isSymbolicLink).sort((a, b) => a.name.localeCompare(b.name)))
            }, reason => { if (active) setError(errorMessage(reason)) }).finally(() => { if (active) setBusy(false) })
        }, 180)
        return () => { active = false; clearTimeout(timer) }
    }, [api, machine?.id, open, path, hidden, revision])
    const filtered = entries.filter(entry => entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
    return <section className="hapi-directory-picker">
        <style>{`.hapi-directory-browser{margin:8px 0;padding:10px;border:1px solid var(--hapi-border);border-radius:8px;display:flex;flex-direction:column;gap:8px}.hapi-directory-browser label{display:flex;flex-direction:column;gap:4px}.hapi-directory-entries{max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:3px}.hapi-directory-entries>button{text-align:left;overflow-wrap:anywhere;padding:7px}.hapi-directory-shortcuts{display:flex;gap:5px;flex-wrap:wrap}.hapi-directory-shortcuts>button{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.hapi-directory-browser .hapi-create-checkbox{flex-direction:row;align-items:center}`}</style>
        <button type="button" disabled={disabled || !machine?.online} aria-expanded={open} onClick={() => {
            if (!open) setPath(value.trim() || machine?.workspaceRoots?.[0] || machine?.homeDir || '.')
            setOpen(current => !current)
        }}>{t('browseDirectory')}</button>
        {open && <div className="hapi-directory-browser">
            <label>{t('browsePath')}<input value={path} disabled={disabled} onChange={event => setPath(event.currentTarget.value)}/></label>
            <div className="hapi-button-row"><button type="button" disabled={busy || disabled || !path} onClick={() => setPath(parentSourceDirectory(path))}>{t('parentDirectory')}</button>
                <button type="button" disabled={busy || disabled} onClick={() => setRevision(value => value + 1)}>{t('refresh')}</button>
                <label className="hapi-create-checkbox"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.currentTarget.checked)}/>{t('showHiddenFiles')}</label></div>
            <div className="hapi-directory-shortcuts">{[...new Set([...(machine?.workspaceRoots ?? []), ...recent.slice(0, 5)])].map(candidate => <button type="button" key={candidate} title={candidate} onClick={() => setPath(candidate)}>{candidate}</button>)}</div>
            <label>{t('filterDirectories')}<input value={filter} onChange={event => setFilter(event.currentTarget.value)}/></label>
            <div className="hapi-directory-entries" aria-busy={busy}>{filtered.slice(0, limit).map(entry => <button type="button" key={entry.name} disabled={disabled} onClick={() => { setPath(joinSourceDirectory(path, entry.name)); setFilter('') }}>
                <span aria-hidden="true">▸</span> {entry.name}{entry.isGitRepo ? ' · Git' : ''}
            </button>)}{filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 300)}>{t('showMoreDirectories')}</button>}</div>
            {busy && <p role="status">{t('loading')}</p>}{error && <p className="hapi-error" role="alert">{error}</p>}
            <button type="button" disabled={busy || disabled || !path.trim() || Boolean(error)} onClick={() => { onChoose(path); setOpen(false) }}>{t('chooseDirectory')}</button>
        </div>}
    </section>
}

/** A fresh source read before a new launch; recovery never runs this check or starts another session. */
export function useLaunchDirectoryCheck(api: HapiRemoteApi, machineId: string, directory: string, worktree: boolean, t: WorkspaceTranslate) {
    const [checking, setChecking] = useState(false)
    const [confirmation, setConfirmation] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const scope = `${machineId}\0${directory.trim()}\0${worktree}`
    useEffect(() => { setConfirmation(null); setMessage(null); setError(null) }, [scope])
    return { checking, message, error, async check(): Promise<boolean> {
        if (!machineId || !directory.trim() || checking) return false
        setChecking(true); setError(null); setMessage(null)
        try {
            const path = directory.trim()
            const result = remoteValue(await api.sourceMachinePaths({ machineId, paths: [path] }))
            if (result.outsideWorkspaceRoots?.includes(path)) throw new Error(t('directoryOutsideRoots'))
            if (result.exists[path] === false) {
                if (worktree) throw new Error(t('worktreeDirectoryMissing'))
                if (confirmation !== scope) { setConfirmation(scope); setMessage(t('confirmCreateDirectory')); return false }
            } else if (result.exists[path] !== true) throw new Error(t('directoryUnconfirmed'))
            return true
        } catch (reason) { setError(errorMessage(reason)); return false }
        finally { setChecking(false) }
    } }
}
