import { randomId } from './random-id.ts';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { remoteValue, type HapiCatalog, type HapiRemoteApi } from '../client-api.ts'
import { SOURCE_CREATION_FLAVORS, SOURCE_LAUNCH_PERMISSION_MODES, type SourceCreationFlavor, type SourceCreationState } from '../hapi-agent/creation-types.ts'
import { errorMessage, type WorkspaceController } from './controller.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { SourceCreationController, type SourceLaunchFields } from './source-creation.ts'
import type { SourceMachineOptions } from '../source-machine-types.ts'
import { LaunchDraftStore, sourceFieldsForContext, sourceLaunchFieldsSchema } from './launch-drafts.ts'
import { SourceDirectoryPicker, useLaunchDirectoryCheck } from './source-directory.tsx'
import { InitialTaskEditor, useInitialTask } from './initial-task-ui.tsx'
import type { InitialFileUpload } from './initial-task.ts'
import { chooseCursorLaunchModel, cursorLaunchPicker } from './cursor-models/launch.ts'

const labels: Record<SourceCreationFlavor, string> = { agy: 'Antigravity', claude: 'Claude Code', dsh: 'DSH via HAPI', copilot: 'GitHub Copilot', cursor: 'Cursor', grok: 'Grok', kimi: 'Kimi', opencode: 'OpenCode', pi: 'Pi', qoder: 'Qoder' }
const requestFields = (request: SourceCreationState['request']): SourceLaunchFields => ({ agent: request.agent, machineId: request.machineId, directory: request.directory,
    model: request.model ?? '', effort: request.effort ?? '', reasoning: request.modelReasoningEffort ?? '',
    permission: request.permissionMode ?? '', startingMode: request.startingMode ?? 'remote', copilotMode: request.copilotAgentMode ?? '',
    worktree: request.sessionType === 'worktree', worktreeName: request.worktreeName ?? '' })

export function SourceSessionForm({ api, controller, close, t, uploadInitialFile }: {
    api: HapiRemoteApi; controller: WorkspaceController; close: () => void; t: WorkspaceTranslate; uploadInitialFile: InitialFileUpload
}) {
    const creation = useMemo(() => new SourceCreationController(api, () => randomId(), controller.options.storage, `${controller.options.storageKey}:source-launch`), [api, controller])
    const drafts = useMemo(() => new LaunchDraftStore(controller.options.storage, `${controller.options.storageKey}:source-launch:form`, sourceLaunchFieldsSchema), [controller])
    const initial = useInitialTask(api, uploadInitialFile, `${controller.options.storageKey}:source-launch:task`)
    const state = useSyncExternalStore(creation.subscribe, creation.getSnapshot)
    const [catalog, setCatalog] = useState<HapiCatalog | null>(null)
    const [context] = useState(() => controller.getSnapshot().creationContext)
    const [fields, setFields] = useState<SourceLaunchFields>(() => {
        const request = creation.getSnapshot().request
        return request ? requestFields(request) : sourceFieldsForContext(drafts.load(), context)
    })
    const [error, setError] = useState<string | null>(null)
    const [options, setOptions] = useState<SourceMachineOptions | null>(null)
    const [optionsLoading, setOptionsLoading] = useState(false)
    const [optionsRevision, setOptionsRevision] = useState(0)
    const [customModel, setCustomModel] = useState(Boolean(fields.model) && fields.agent !== 'cursor')
    const directoriesId = useId()
    const opened = useRef<string | null>(null)
    const completed = useRef(false)
    useEffect(() => { if (!completed.current) drafts.save(fields) }, [drafts, fields])
    const open = async (row: SourceCreationState): Promise<void> => {
        if (row.status !== 'ready' || !row.sessionId || completed.current) return
        opened.current = row.requestId
        if (row.requestId === state.request?.requestId) {
            if (!await initial.task.ready(row.sessionId, row.requestId)) return
            if (completed.current) return
            try { await initial.task.completed() } catch (reason) { setError(errorMessage(reason)); return }
            completed.current = true; drafts.completed(requestFields(row.request))
        }
        creation.acknowledgeOpened(row.requestId)
        void controller.refresh(); controller.openCreatedSession(row.sessionId); close()
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
        void creation.refresh()
        const timer = setInterval(() => { void creation.refresh() }, 3000)
        return () => { clearInterval(timer) }
    }, [creation])
    useEffect(() => {
        const current = state.rows.find(row => row.requestId === state.request?.requestId)
        if (current?.status === 'ready' && current.sessionId && opened.current !== current.requestId) void open(current)
        if (!state.request && initial.state.draft.creationRequestId && !initial.state.draft.sessionId) void initial.task.releaseRejectedCreation()
    }, [state.rows, state.request?.requestId])
    const catalogUsesDirectory = ['opencode', 'grok', 'kimi', 'copilot'].includes(fields.agent)
    const catalogDirectory = catalogUsesDirectory ? fields.directory.trim() : undefined
    useEffect(() => {
        setOptions(null)
        if (!fields.machineId) { setOptionsLoading(false); return }
        let active = true
        setOptionsLoading(true)
        // Directory-dependent source catalogs (notably OpenCode) must never
        // reuse another Runner's or project's model IDs.
        const timer = setTimeout(() => {
            void api.sourceMachineOptions({ machineId: fields.machineId, agent: fields.agent,
                ...(catalogDirectory ? { cwd: catalogDirectory } : {}), refresh: optionsRevision > 0,
            }).then(remoteValue).then(value => { if (active) setOptions(value) }, reason => {
                if (active) setError(errorMessage(reason))
            }).finally(() => { if (active) setOptionsLoading(false) })
        }, 180)
        return () => { active = false; clearTimeout(timer) }
    }, [api, fields.machineId, fields.agent, catalogDirectory, optionsRevision])
    const update = <K extends keyof SourceLaunchFields>(key: K, value: SourceLaunchFields[K]): void => setFields(current => ({ ...current, [key]: value }))
    const changeAgent = (agent: SourceCreationFlavor): void => {
        setFields(current => ({ ...current, agent, model: '', effort: '', reasoning: '', cursorBase: undefined, permission: '', copilotMode: '', startingMode: 'remote' }))
        setCustomModel(false); setError(null)
    }
    const changeDirectory = (directory: string): void => setFields(current => ({ ...current, directory,
        ...(catalogUsesDirectory && !customModel ? { model: '', reasoning: '' } : {}),
    }))
    const directions = [...new Set(catalog?.sessions.filter(session => session.machineId === fields.machineId).map(session => session.cwd) ?? [])]
    const pending = Boolean(state.request && creation.current()?.status !== 'ready')
    const directoryCheck = useLaunchDirectoryCheck(api, fields.machineId, fields.directory, fields.worktree, t)
    const blocked = state.busy || pending || directoryCheck.checking || initial.state.busy || Boolean(initial.state.draft.creationRequestId)
    const supportsPty = !['agy', 'dsh', 'qoder'].includes(fields.agent)
    const supportsEffort = ['claude', 'grok', 'pi', 'agy', 'dsh', 'qoder'].includes(fields.agent)
    const supportsReasoning = ['opencode', 'dsh'].includes(fields.agent)
    const selectedModel = options?.models.find(option => option.id === fields.model)
    const effortOptions = options?.efforts ?? []
    const reasoningOptions = selectedModel?.reasoningEfforts ?? []
    const cursorPicker = useMemo(() => cursorLaunchPicker(options, fields.model, fields.cursorBase), [options, fields.model, fields.cursorBase])
    const cursorCatalogPending = fields.agent === 'cursor' && !customModel && (!options || optionsLoading)
    const cursorSelectionError = fields.agent === 'cursor' && !customModel && options && !optionsLoading
        ? cursorPicker.unavailable ? t('sourceCursorSelectionUnavailable')
            : cursorPicker.pendingVariant ? t('sourceCursorSelectionRequired') : null
        : null
    return <form className="hapi-native-create" onSubmit={async event => {
        event.preventDefault()
        if (directoryCheck.checking || initial.state.busy || initial.state.draft.sessionId
            || !pending && (cursorCatalogPending || cursorSelectionError)) return
        try {
            if (pending && state.request) { await initial.task.prepare(state.request.requestId); void creation.recover() }
            else if (await directoryCheck.check()) void creation.start(fields, request => initial.task.prepare(request.requestId))
        } catch (reason) { setError(errorMessage(reason)) }
    }}>
        <p>{t('sourceCreateHelp')}</p>
        <label>{t('engine')}<select value={fields.agent} disabled={blocked} onChange={event => changeAgent(event.currentTarget.value as SourceCreationFlavor)}>
            {SOURCE_CREATION_FLAVORS.map(agent => <option key={agent} value={agent}>{labels[agent]}</option>)}
        </select></label>
        <label>{t('machine')}<select required value={fields.machineId} disabled={blocked} onChange={event => {
            const machineId = event.currentTarget.value
            setFields(current => ({ ...current, machineId, model: '', effort: '', reasoning: '', cursorBase: undefined })); setCustomModel(false)
        }}><option value="">{catalog ? t('noMachines') : t('loading')}</option>
            {catalog?.machines.map(machine => <option key={machine.id} value={machine.id} disabled={!machine.online}>{machine.label}{machine.online ? '' : ` · ${t('machineOffline')}`}</option>)}
        </select></label>
        <label>{t('directory')}<input required value={fields.directory} list={directoriesId} placeholder="/path/to/project" disabled={blocked} onChange={event => {
            changeDirectory(event.currentTarget.value)
        }}/></label>
        <datalist id={directoriesId}>{directions.map(path => <option key={path} value={path}/>)}</datalist>
        <SourceDirectoryPicker api={api} machine={catalog?.machines.find(row => row.id === fields.machineId)} value={fields.directory} recent={directions} disabled={blocked} onChoose={changeDirectory} t={t}/>
        {directoryCheck.message && <p role="status">{directoryCheck.message}</p>}{directoryCheck.error && <p role="alert" className="hapi-error">{directoryCheck.error}</p>}
        <div className="hapi-button-row"><label className="hapi-create-checkbox"><input type="checkbox" checked={customModel} disabled={blocked} onChange={event => setCustomModel(event.currentTarget.checked)}/>{t('sourceCustomModel')}</label>
            <button type="button" disabled={blocked || optionsLoading || !fields.machineId} onClick={() => setOptionsRevision(value => value + 1)}>{t('refresh')}</button></div>
        <label>{t('model')}{customModel ? <input value={fields.model} placeholder={t('defaultOption')} disabled={blocked} onChange={event => {
            const model = event.currentTarget.value; setFields(current => ({ ...current, model, reasoning: '', cursorBase: undefined }))
        }}/>
            : fields.agent === 'cursor' ? <select value={cursorPicker.modelValue} disabled={blocked || cursorCatalogPending} onChange={event => {
                const selection = chooseCursorLaunchModel(cursorPicker, event.currentTarget.value)
                setFields(current => ({ ...current, ...selection, reasoning: '', effort: '' }))
            }}>
                {!cursorPicker.modelOptions.some(row => row.value === cursorPicker.modelValue) && <option value={cursorPicker.modelValue} disabled>{cursorPicker.modelValue}</option>}
                {cursorPicker.modelOptions.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}
            </select>
            : <select value={fields.model} disabled={blocked || optionsLoading} onChange={event => { update('model', event.currentTarget.value); update('reasoning', '') }}>
                <option value="">{t('defaultOption')}</option>
                {fields.model && !selectedModel && <option value={fields.model}>{fields.model}</option>}
                {options?.models.map(model => <option key={model.id} value={model.id}>{model.name}{model.origin === 'hapi-presets' ? ` · ${t('sourceModelPreset')}` : ''}</option>)}
            </select>}</label>
        {fields.agent === 'cursor' && !customModel && cursorPicker.mode === 'dual' && cursorPicker.base !== 'auto' && <label>{t('sourceModelVariant')}
            <select value={cursorPicker.variantValue} disabled={blocked || cursorCatalogPending} onChange={event => update('model', event.currentTarget.value)}>
                <option value="" disabled>{t('sourceCursorChooseVariant')}</option>
                {cursorPicker.variants.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}
            </select>
        </label>}
        {cursorSelectionError && <p role="status">{cursorSelectionError}</p>}
        {supportsEffort && <label>{t('reasoning')}{effortOptions.length ? <select value={fields.effort} disabled={blocked} onChange={event => update('effort', event.currentTarget.value)}>
            <option value="">{t('defaultOption')}</option>{fields.effort && !effortOptions.includes(fields.effort) && <option value={fields.effort}>{fields.effort}</option>}{effortOptions.map(value => <option key={value} value={value}>{value}</option>)}
        </select> : <input value={fields.effort} disabled={blocked} placeholder={t('defaultOption')} onChange={event => update('effort', event.currentTarget.value)}/>}</label>}
        {supportsReasoning && <label>{t('sourceModelVariant')}{reasoningOptions.length ? <select value={fields.reasoning} disabled={blocked} onChange={event => update('reasoning', event.currentTarget.value)}>
            <option value="">{t('defaultOption')}</option>{reasoningOptions.map(value => <option key={value} value={value}>{value}</option>)}
        </select> : <input value={fields.reasoning} disabled={blocked} placeholder={t('defaultOption')} onChange={event => update('reasoning', event.currentTarget.value)}/>}</label>}
        {SOURCE_LAUNCH_PERMISSION_MODES[fields.agent].length > 0 && <label>{t('permission')}<select value={fields.permission} disabled={blocked} onChange={event => update('permission', event.currentTarget.value)}>
            <option value="">{t('defaultOption')}</option>{SOURCE_LAUNCH_PERMISSION_MODES[fields.agent].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>}
        {fields.agent === 'copilot' && <label>{t('sourceCopilotMode')}<select value={fields.copilotMode} disabled={blocked} onChange={event => update('copilotMode', event.currentTarget.value)}>
            <option value="">{t('defaultOption')}</option>{['interactive', 'plan', 'autopilot'].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>}
        <label>{t('sourceStartingMode')}<select value={fields.startingMode} disabled={blocked || !supportsPty} onChange={event => update('startingMode', event.currentTarget.value as 'remote' | 'pty')}>
            <option value="remote">{t('sourceStartRemote')}</option>{supportsPty && <option value="pty">{t('sourceStartPty')}</option>}
        </select></label>
        <label className="hapi-create-checkbox"><input type="checkbox" checked={fields.worktree} disabled={blocked} onChange={event => update('worktree', event.currentTarget.checked)}/>{t('workingTree')}</label>
        {fields.worktree && <label>{t('worktreeName')}<input maxLength={200} value={fields.worktreeName} placeholder={t('defaultOption')} disabled={blocked} onChange={event => update('worktreeName', event.currentTarget.value)}/></label>}
        <InitialTaskEditor task={initial.task} disabled={state.busy || pending} t={t} open={id => { void controller.refresh(); controller.openCreatedSession(id); close() }} confirmed={() => {
            const row = creation.current(); if (row) void open(row)
        }}/>
        {options?.availability.available === false && <p role="status">{options.availability.reason ?? t('sourceEngineUnavailable')}</p>}
        {options?.warnings.map((warning, index) => <p key={index} role="status">{warning}</p>)}
        {pending && <p role="status">{t('sourceCreationUnknown')}</p>}
        {(state.error || error) && <p className="hapi-error" role="alert">{state.error || error}</p>}
        <div className="hapi-button-row"><button type="button" onClick={close}>{t('cancel')}</button>
            <button type="submit" disabled={state.busy || initial.state.busy || !initial.state.loaded || Boolean(initial.state.draft.sessionId) || directoryCheck.checking || !fields.machineId || !fields.directory.trim() || (!pending && (options?.availability.available === false || cursorCatalogPending || Boolean(cursorSelectionError)))}>{state.busy || directoryCheck.checking ? t('loading') : pending ? t('reconcileCreation') : t('create')}</button></div>
        {state.rows.length > 0 && <details className="hapi-native-creations" open={state.rows.some(row => !['ready', 'rejected'].includes(row.status))}>
            <summary>{t('sourceCreationHistory')}</summary>
            {state.rows.slice().sort((a, b) => b.createdAt - a.createdAt).map(row => <article key={row.requestId} className="hapi-fork-receipt" data-source-creation-request={row.requestId}>
                <header><strong>{row.status}</strong> · {labels[row.request.agent]} · {row.request.machineId}</header><p>{row.request.directory}</p><code>{row.requestId}</code>
                {row.message && <p>{row.message}</p>}
                <div className="hapi-button-row">{row.status === 'ready' && row.sessionId ? <button type="button" onClick={() => open(row)}>{t('openCreatedSession')}</button> : row.status !== 'rejected' && <>
                    <button type="button" disabled={state.busy} onClick={() => { void creation.inspect(row.requestId, 'read') }}>{t('sourceSettingCheck')}</button>
                    <button type="button" disabled={state.busy} onClick={() => { void creation.inspect(row.requestId, 'reconcile') }}>{t('reconcileCreation')}</button>
                </>}</div>
            </article>)}
        </details>}
    </form>
}
