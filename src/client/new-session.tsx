import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { remoteValue, type CreateNativeSession, type HapiCatalog, type HapiRemoteApi, type MachineOptions, type NativeCreationState } from '../client-api.ts'
import { errorMessage, type WorkspaceController } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'

/** Polls and explicit recovery reads may finish out of order. */
export function mergeCreationStates(previous: readonly NativeCreationState[], updates: readonly NativeCreationState[]): NativeCreationState[] {
    const rows = new Map(previous.map(row => [row.requestId, row]))
    for (const row of updates) {
        const current = rows.get(row.requestId)
        if (current && (current.updatedAt > row.updatedAt || current.status === 'ready' && row.status !== 'ready')) continue
        rows.set(row.requestId, row)
    }
    return [...rows.values()]
}

function NativeCreationHistory({ api, currentRequestId, changed, open, t }: {
    api: HapiRemoteApi; currentRequestId: string | undefined; changed: number; open: (id: string) => void; t: WorkspaceTranslate
}) {
    const [rows, setRows] = useState<NativeCreationState[]>([])
    const rowsRef = useRef<NativeCreationState[]>([])
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState<string | null>(null)
    const openRef = useRef(open); openRef.current = open
    const currentRef = useRef(currentRequestId); currentRef.current = currentRequestId
    const opened = useRef(new Set<string>())
    const accept = (next: NativeCreationState[]): void => {
        const merged = mergeCreationStates(rowsRef.current, next)
        rowsRef.current = merged; setRows(merged)
        const current = merged.find(row => row.requestId === currentRef.current && row.status === 'ready' && row.sessionId)
        if (current?.sessionId && !opened.current.has(current.requestId)) {
            opened.current.add(current.requestId); openRef.current(current.sessionId)
        }
    }
    useEffect(() => {
        let active = true
        let polling = false
        const refresh = async (): Promise<void> => {
            if (polling) return
            polling = true
            try {
                const source = remoteValue(await api.nativeCreations())
                // Read never dispatches a launch. It can observe a delayed
                // native identity and finish attaching an already accepted one.
                const fresh = await Promise.all(source.map(async row => {
                    if (['ready', 'rejected'].includes(row.status)) return row
                    try { return remoteValue(await api.nativeCreationOperation({ requestId: row.requestId, action: 'read' })) }
                    catch { return row }
                }))
                if (active) { accept(fresh); setError(null) }
            } catch (reason) { if (active) setError(errorMessage(reason)) }
            finally { polling = false }
        }
        void refresh()
        const timer = setInterval(() => { void refresh() }, 3000)
        return () => { active = false; clearInterval(timer) }
    }, [api, changed])
    const inspect = (requestId: string, action: 'read' | 'reconcile'): void => {
        if (pending) return
        setPending(requestId); setError(null)
        void api.nativeCreationOperation({ requestId, action }).then(remoteValue).then(value => {
            accept([value])
        }, reason => setError(errorMessage(reason))).finally(() => setPending(null))
    }
    if (!rows.length && !error) return null
    return <details className="hapi-native-creations" open={rows.some(row => !['ready', 'rejected'].includes(row.status))}>
        <summary>{t('nativeCreationHistory')}</summary>
        {rows.slice().sort((a, b) => b.createdAt - a.createdAt).map(row => <article className="hapi-fork-receipt" key={row.requestId} data-creation-request={row.requestId}>
            <header><strong>{row.status}</strong> · {row.request.machineId}</header><p>{row.request.directory}</p><code>{row.requestId}</code>
            {row.message && <p>{row.message}</p>}
            <div className="hapi-button-row">
                {row.status === 'ready' && row.sessionId && <button type="button" onClick={() => open(row.sessionId!)}>{t('openCreatedSession')}</button>}
                {!['ready', 'rejected'].includes(row.status) && <>
                    <button type="button" disabled={Boolean(pending)} onClick={() => inspect(row.requestId, 'read')}>{t('checkNativeResult')}</button>
                    <button type="button" disabled={Boolean(pending)} onClick={() => inspect(row.requestId, 'reconcile')}>{t('reconcileCreation')}</button>
                </>}
            </div>
        </article>)}
        {error && <p className="hapi-error" role="alert">{error}</p>}
    </details>
}

/** Build one explicit native creation request; defaults remain Runner-owned. */
export function nativeCreationRequest(input: {
    machineId: string; directory: string; model: string; reasoning: string; home: string; worktree: boolean; worktreeName: string
}, requestId: string): CreateNativeSession {
    if (!input.machineId) throw new Error('Choose a connected machine')
    if (!input.directory.trim()) throw new Error('Enter a working directory')
    if (input.worktree && !input.worktreeName.trim()) throw new Error('Enter a worktree name')
    return {
        machineId: input.machineId, directory: input.directory.trim(), requestId,
        ...(input.model ? { model: input.model } : {}), ...(input.reasoning ? { modelReasoningEffort: input.reasoning } : {}),
        ...(input.home ? { codexHome: input.home } : {}),
        sessionType: input.worktree ? 'worktree' : 'simple', ...(input.worktree ? { worktreeName: input.worktreeName.trim() } : {}),
    }
}

export function NativeSessionForm({ api, controller, close, t }: {
    api: HapiRemoteApi; controller: WorkspaceController; close: () => void; t: WorkspaceTranslate
}) {
    const [catalog, setCatalog] = useState<HapiCatalog | null>(null)
    const [options, setOptions] = useState<MachineOptions | null>(null)
    const [machineId, setMachineId] = useState('')
    const [directory, setDirectory] = useState('')
    const [home, setHome] = useState('')
    const [model, setModel] = useState('')
    const [reasoning, setReasoning] = useState('')
    const [worktree, setWorktree] = useState(false)
    const [worktreeName, setWorktreeName] = useState('')
    const [loadingOptions, setLoadingOptions] = useState(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [uncertain, setUncertain] = useState(false)
    const [historyChange, setHistoryChange] = useState(0)
    const attempt = useRef<CreateNativeSession | null>(null)
    const directoriesId = useId()
    useEffect(() => {
        let active = true
        void api.catalog().then(remoteValue).then(value => {
            if (!active) return
            setCatalog(value)
            setMachineId(value.machines.find(machine => machine.online)?.id ?? '')
        }, reason => { if (active) setError(errorMessage(reason)) })
        return () => { active = false }
    }, [api])
    useEffect(() => {
        if (!machineId) return
        let active = true
        setLoadingOptions(true); setOptions(null); setHome(''); setModel(''); setReasoning('')
        void api.machineOptions({ machineId }).then(remoteValue).then(value => {
            if (active) setOptions(value)
        }, reason => { if (active) setError(errorMessage(reason)) }).finally(() => { if (active) setLoadingOptions(false) })
        return () => { active = false }
    }, [api, machineId])
    const directories = useMemo(() => [...new Set(catalog?.sessions.filter(session => session.machineId === machineId).map(session => session.cwd) ?? [])], [catalog, machineId])
    const selectedModel = options?.models.find(option => option.id === model)
    const blocked = pending || uncertain
    return <form className="hapi-native-create" onSubmit={event => {
        event.preventDefault()
        if (pending) return
        let request: CreateNativeSession
        try {
            request = attempt.current ?? nativeCreationRequest({ machineId, directory, model, reasoning, home, worktree, worktreeName }, crypto.randomUUID())
        } catch (error) { setError(errorMessage(error)); return }
        attempt.current = request
        setPending(true); setError(null)
        void api.createSession(request).then(remoteValue).then(async result => {
            await controller.refresh()
            controller.openSession(result.sessionId)
            close()
        }, reason => {
            const detail: unknown = reason && typeof reason === 'object' ? Reflect.get(reason, 'details') : undefined
            const outcome = detail && typeof detail === 'object' ? Reflect.get(detail, 'outcome') : undefined
            // An explicit rejection permits editing. An uncertain attempt keeps
            // both payload and requestId for a user-triggered, idempotent retry.
            if (outcome === 'rejected') { attempt.current = null; setUncertain(false) }
            else setUncertain(true)
            setError(errorMessage(reason))
        }).finally(() => { setPending(false); setHistoryChange(value => value + 1) })
    }}>
        <p>{t('nativeCreateHelp')}</p>
        <NativeCreationHistory api={api} currentRequestId={attempt.current?.requestId} changed={historyChange} t={t} open={id => {
            void controller.refresh(); controller.openSession(id); close()
        }}/>
        <label>{t('machine')}<select required value={machineId} onChange={event => setMachineId(event.currentTarget.value)} disabled={blocked}>
            <option value="">{catalog ? t('noMachines') : t('loading')}</option>
            {catalog?.machines.map(machine => <option key={machine.id} value={machine.id} disabled={!machine.online}>{machine.label}{machine.online ? '' : ` · ${t('machineOffline')}`}</option>)}
        </select></label>
        <label>{t('directory')}<input required value={directory} list={directoriesId} placeholder="/path/to/project" onChange={event => setDirectory(event.currentTarget.value)} disabled={blocked}/></label>
        <datalist id={directoriesId}>{directories.map(path => <option key={path} value={path}/>)}</datalist>
        <label>{t('codexHome')}<select value={home} onChange={event => setHome(event.currentTarget.value)} disabled={blocked || loadingOptions}>
            <option value="">{t('defaultOption')}</option>{options?.homes.map(option => <option key={option.id} value={option.path}>{option.name} · {option.path}</option>)}
        </select></label>
        <div className="hapi-create-models"><label>{t('model')}<select value={model} onChange={event => { setModel(event.currentTarget.value); setReasoning('') }} disabled={blocked || loadingOptions}>
            <option value="">{t('defaultOption')}</option>{options?.models.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select></label><label>{t('reasoning')}<select value={reasoning} onChange={event => setReasoning(event.currentTarget.value)} disabled={blocked || loadingOptions || !selectedModel?.reasoningEfforts.length}>
            <option value="">{t('defaultOption')}</option>{selectedModel?.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select></label></div>
        <label className="hapi-create-checkbox"><input type="checkbox" checked={worktree} onChange={event => setWorktree(event.currentTarget.checked)} disabled={blocked}/>{t('workingTree')}</label>
        {worktree && <label>{t('worktreeName')}<input required value={worktreeName} maxLength={200} onChange={event => setWorktreeName(event.currentTarget.value)} disabled={blocked}/></label>}
        {options?.warnings.map((warning, index) => <p key={index} role="status">{warning}</p>)}
        {error && <p className="hapi-error" role="alert">{error}</p>}
        {uncertain && <p role="status">{t('awaitingConfirmation')}</p>}
        <div className="hapi-button-row"><button type="button" onClick={close} disabled={pending}>{t('cancel')}</button><button type="submit" disabled={pending || !machineId || !directory.trim()}>{pending ? t('loading') : uncertain ? t('retry') : t('create')}</button></div>
    </form>
}
