import { randomId } from './random-id.ts';
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { remoteValue, type CreateNativeSession, type HapiCatalog, type HapiRemoteApi, type MachineOptions, type NativeCreationState } from '../client-api.ts'
import { errorMessage, type WorkspaceController } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { LaunchDraftStore, nativeFieldsFromRequest, nativeFieldsForContext, nativeLaunchFieldsSchema, readNativeLaunchIntent, saveLaunchIntent, type NativeLaunchFields } from './launch-drafts.ts'
import { SourceDirectoryPicker, useLaunchDirectoryCheck } from './source-directory.tsx'
import { InitialTaskEditor, useInitialTask } from './initial-task-ui.tsx'
import type { InitialFileUpload } from './initial-task.ts'

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
    api: HapiRemoteApi; currentRequestId: string | undefined; changed: number; open: (id: string, request: CreateNativeSession) => void; t: WorkspaceTranslate
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
            opened.current.add(current.requestId); openRef.current(current.sessionId, current.request)
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
                {row.status === 'ready' && row.sessionId && <button type="button" onClick={() => open(row.sessionId!, row.request)}>{t('openCreatedSession')}</button>}
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
    accountId?: string; keyProfileId?: string; permission?: NativeLaunchFields['permission']; collaboration?: NativeLaunchFields['collaboration']; serviceTier?: NativeLaunchFields['serviceTier']
}, requestId: string): CreateNativeSession {
    if (!input.machineId) throw new Error('Choose a connected machine')
    if (!input.directory.trim()) throw new Error('Enter a working directory')
    return {
        machineId: input.machineId, directory: input.directory.trim(), requestId,
        ...(input.model ? { model: input.model } : {}), ...(input.reasoning ? { modelReasoningEffort: input.reasoning } : {}),
        ...(input.home ? { codexHome: input.home } : {}),
        ...(input.accountId ? { codexAccountId: input.accountId } : {}), ...(input.keyProfileId ? { codexKeyProfileId: input.keyProfileId } : {}),
        ...(input.permission ? { permissionMode: input.permission } : {}), ...(input.collaboration ? { collaborationMode: input.collaboration } : {}),
        ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
        sessionType: input.worktree ? 'worktree' : 'simple', ...(input.worktree && input.worktreeName.trim() ? { worktreeName: input.worktreeName.trim() } : {}),
    }
}

export function NativeSessionForm({ api, controller, close, t, uploadInitialFile }: {
    api: HapiRemoteApi; controller: WorkspaceController; close: () => void; t: WorkspaceTranslate; uploadInitialFile: InitialFileUpload
}) {
    const [catalog, setCatalog] = useState<HapiCatalog | null>(null)
    const [options, setOptions] = useState<MachineOptions | null>(null)
    const intentKey = `${controller.options.storageKey}:native-launch`
    const initial = useInitialTask(api, uploadInitialFile, `${intentKey}:task`)
    const drafts = useMemo(() => new LaunchDraftStore(controller.options.storage, `${intentKey}:form`, nativeLaunchFieldsSchema), [controller, intentKey])
    const attempt = useRef<CreateNativeSession | null>(readNativeLaunchIntent(controller.options.storage, intentKey))
    const [context] = useState(() => controller.getSnapshot().creationContext)
    const [fields, setFields] = useState(() => attempt.current ? nativeFieldsFromRequest(attempt.current) : nativeFieldsForContext(drafts.load(), context))
    const { machineId, directory, home, model, reasoning, worktree, worktreeName, accountId, keyProfileId, permission, collaboration, serviceTier } = fields
    const update = <K extends keyof NativeLaunchFields>(key: K, value: NativeLaunchFields[K]): void => setFields(current => ({ ...current, [key]: value }))
    const completed = useRef(false)
    const [loadingOptions, setLoadingOptions] = useState(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [uncertain, setUncertain] = useState(Boolean(attempt.current))
    const [historyChange, setHistoryChange] = useState(0)
    const directoriesId = useId()
    useEffect(() => { if (!completed.current) drafts.save(fields) }, [drafts, fields])
    const finish = async (id: string, request: CreateNativeSession): Promise<void> => {
        if (completed.current) return
        if (request.requestId === attempt.current?.requestId) {
            if (!await initial.task.ready(id, request.requestId)) return
            if (completed.current) return
            try { await initial.task.completed() } catch (reason) { setError(errorMessage(reason)); return }
            completed.current = true; drafts.completed(nativeFieldsFromRequest(request))
            try { saveLaunchIntent(controller.options.storage, intentKey, null) } catch { /* Reopening the ready receipt is safe. */ }
        }
        void controller.refresh(); controller.openCreatedSession(id); close()
    }
    useEffect(() => {
        let active = true
        void api.catalog().then(remoteValue).then(value => {
            if (!active) return
            setCatalog(value)
            setFields(current => current.machineId || context ? current : { ...current, machineId: value.machines.find(machine => machine.online)?.id ?? '' })
        }, reason => { if (active) setError(errorMessage(reason)) })
        return () => { active = false }
    }, [api])
    useEffect(() => {
        if (!machineId) return
        let active = true
        setLoadingOptions(true); setOptions(null)
        void api.machineOptions({ machineId }).then(remoteValue).then(value => {
            if (active) setOptions(value)
        }, reason => { if (active) setError(errorMessage(reason)) }).finally(() => { if (active) setLoadingOptions(false) })
        return () => { active = false }
    }, [api, machineId])
    const directories = useMemo(() => [...new Set(catalog?.sessions.filter(session => session.machineId === machineId).map(session => session.cwd) ?? [])], [catalog, machineId])
    const selectedModel = options?.models.find(option => option.id === model)
    const directoryCheck = useLaunchDirectoryCheck(api, machineId, directory, worktree, t)
    const blocked = pending || uncertain || directoryCheck.checking || initial.state.busy || Boolean(initial.state.draft.creationRequestId)
    return <form className="hapi-native-create" onSubmit={async event => {
        event.preventDefault()
        if (pending || directoryCheck.checking || initial.state.busy || initial.state.draft.sessionId) return
        if (!attempt.current && !await directoryCheck.check()) return
        let request: CreateNativeSession
        try {
            request = attempt.current ?? nativeCreationRequest(fields, initial.state.draft.creationRequestId ?? randomId())
            saveLaunchIntent(controller.options.storage, intentKey, request)
            attempt.current = request
            await initial.task.prepare(request.requestId)
        } catch (error) { setUncertain(Boolean(attempt.current)); setError(errorMessage(error)); return }
        setPending(true); setError(null)
        void api.createSession(request).then(remoteValue).then(async result => {
            await finish(result.sessionId, request)
        }, reason => {
            const detail: unknown = reason && typeof reason === 'object' ? Reflect.get(reason, 'details') : undefined
            const outcome = detail && typeof detail === 'object' ? Reflect.get(detail, 'outcome') : undefined
            // An explicit rejection permits editing. An uncertain attempt keeps
            // both payload and requestId for a user-triggered, idempotent retry.
            if (outcome === 'rejected') {
                try { saveLaunchIntent(controller.options.storage, intentKey, null); attempt.current = null; setUncertain(false); void initial.task.releaseRejectedCreation() }
                catch { setUncertain(true) }
            }
            else setUncertain(true)
            setError(errorMessage(reason))
        }).finally(() => { setPending(false); setHistoryChange(value => value + 1) })
    }}>
        <p>{t('nativeCreateHelp')}</p>
        <NativeCreationHistory api={api} currentRequestId={attempt.current?.requestId} changed={historyChange} t={t} open={finish}/>
        <label>{t('machine')}<select required value={machineId} onChange={event => {
            const next = event.currentTarget.value
            setFields(current => ({ ...current, machineId: next, home: '', accountId: '', keyProfileId: '', model: '', reasoning: '' }))
        }} disabled={blocked}>
            <option value="">{catalog ? t('noMachines') : t('loading')}</option>
            {catalog?.machines.map(machine => <option key={machine.id} value={machine.id} disabled={!machine.online}>{machine.label}{machine.online ? '' : ` · ${t('machineOffline')}`}</option>)}
        </select></label>
        <label>{t('directory')}<input required value={directory} list={directoriesId} placeholder="/path/to/project" onChange={event => update('directory', event.currentTarget.value)} disabled={blocked}/></label>
        <datalist id={directoriesId}>{directories.map(path => <option key={path} value={path}/>)}</datalist>
        <SourceDirectoryPicker api={api} machine={catalog?.machines.find(row => row.id === machineId)} value={directory} recent={directories} disabled={blocked} onChoose={path => update('directory', path)} t={t}/>
        {directoryCheck.message && <p role="status">{directoryCheck.message}</p>}{directoryCheck.error && <p role="alert" className="hapi-error">{directoryCheck.error}</p>}
        <label>{t('codexHome')}<select value={home} onChange={event => { update('home', event.currentTarget.value); update('accountId', '') }} disabled={blocked || loadingOptions}>
            <option value="">{t('defaultOption')}</option>{options?.homes.map(option => <option key={option.id} value={option.path}>{option.name} · {option.path}</option>)}
            {home && !options?.homes.some(option => option.path === home) && <option value={home}>{home}</option>}
        </select></label>
        <label>{t('launchAccount')}<select value={accountId} onChange={event => update('accountId', event.currentTarget.value)} disabled={blocked || loadingOptions || Boolean(home && !options?.homes.find(option => option.path === home)?.official)}>
            <option value="">{t('defaultOption')}</option>{options?.accounts?.map(account => <option key={account.id} value={account.id} disabled={!account.enabled}>{account.label}{account.email ? ` · ${account.email}` : ''}</option>)}
            {accountId && !options?.accounts?.some(option => option.id === accountId) && <option value={accountId}>{accountId}</option>}
        </select></label>
        {Boolean(options?.keyProfiles?.length || keyProfileId) && <label>{t('launchKeyProfile')}<select value={keyProfileId} onChange={event => update('keyProfileId', event.currentTarget.value)} disabled={blocked || loadingOptions}>
            <option value="">{t('defaultOption')}</option>{options?.keyProfiles?.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
            {keyProfileId && !options?.keyProfiles?.some(option => option.id === keyProfileId) && <option value={keyProfileId}>{keyProfileId}</option>}
        </select></label>}
        <div className="hapi-create-models"><label>{t('model')}<select value={model} onChange={event => { update('model', event.currentTarget.value); update('reasoning', '') }} disabled={blocked || loadingOptions}>
            <option value="">{t('defaultOption')}</option>{options?.models.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
            {model && !selectedModel && <option value={model}>{model}</option>}
        </select></label><label>{t('reasoning')}<select value={reasoning} onChange={event => update('reasoning', event.currentTarget.value)} disabled={blocked || loadingOptions || !selectedModel?.reasoningEfforts.length}>
            <option value="">{t('defaultOption')}</option>{selectedModel?.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
            {reasoning && !selectedModel?.reasoningEfforts.includes(reasoning) && <option value={reasoning}>{reasoning}</option>}
        </select></label></div>
        <div className="hapi-create-models"><label>{t('permission')}<select value={permission} disabled={blocked} onChange={event => update('permission', event.currentTarget.value as NativeLaunchFields['permission'])}>
            <option value="">{t('defaultOption')}</option><option value="default">{t('permissionDefault')}</option><option value="read-only">{t('permissionReadOnly')}</option><option value="yolo">{t('permissionYolo')}</option>
        </select></label><label>{t('collaboration')}<select value={collaboration} disabled={blocked} onChange={event => update('collaboration', event.currentTarget.value as NativeLaunchFields['collaboration'])}>
            <option value="">{t('defaultOption')}</option><option value="default">{t('collaborationDefault')}</option><option value="plan">{t('collaborationPlan')}</option>
        </select></label><label>{t('serviceTier')}<select value={serviceTier} disabled={blocked} onChange={event => update('serviceTier', event.currentTarget.value as NativeLaunchFields['serviceTier'])}>
            <option value="">{t('defaultOption')}</option><option value="standard">Standard</option><option value="fast">Fast</option>
        </select></label></div>
        <label className="hapi-create-checkbox"><input type="checkbox" checked={worktree} onChange={event => update('worktree', event.currentTarget.checked)} disabled={blocked}/>{t('workingTree')}</label>
        {worktree && <label>{t('worktreeName')}<input value={worktreeName} maxLength={200} placeholder={t('defaultOption')} onChange={event => update('worktreeName', event.currentTarget.value)} disabled={blocked}/></label>}
        <InitialTaskEditor task={initial.task} disabled={pending || uncertain} t={t} open={id => { void controller.refresh(); controller.openCreatedSession(id); close() }} confirmed={() => {
            const request = attempt.current; const id = initial.task.getSnapshot().draft.sessionId
            if (request && id) void finish(id, request)
        }}/>
        {options?.warnings.map((warning, index) => <p key={index} role="status">{warning}</p>)}
        {error && <p className="hapi-error" role="alert">{error}</p>}
        {uncertain && <p role="status">{t('awaitingConfirmation')}</p>}
        <div className="hapi-button-row"><button type="button" onClick={close} disabled={pending}>{t('cancel')}</button><button type="submit" disabled={pending || initial.state.busy || !initial.state.loaded || Boolean(initial.state.draft.sessionId) || directoryCheck.checking || !machineId || !directory.trim()}>{pending || directoryCheck.checking ? t('loading') : uncertain ? t('retry') : t('create')}</button></div>
    </form>
}
