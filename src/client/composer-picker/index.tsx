import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { NativeControlLedger } from '../native-control-state.ts'
import type { ObservedControlLedger } from '../observed-controls.tsx'
import { useWorkspacePane } from '../surface/pane-context.tsx'
import { modelKey, modelLabel, nativePickerChange, nativePickerData, nativePickerPending, observedPickerChange, observedPickerData,
    permissionPickerAvailable, type PickerAction, type PickerData, type PickerPending } from './data.ts'
import { EffortChoices, Glyph, PendingNote, SourceControlRow, permissionLabel, type PickerMode, type SourceControlSummary, type Translate } from './presentation.tsx'
import { positionPicker, type PickerPosition } from './position.ts'
import type { SourceInputProps } from './slots.ts'
import { composerPickerStyles } from './styles.ts'

type InputProps = SourceInputProps & PropsRenderSlots<'hapi.source.composer-actions'>
const fallbackPane = { focused: true, visible: true }
const emptySubscribe = (): (() => void) => () => {}
const fallbackPaneSnapshot = () => fallbackPane

interface ControlsProps {
    ctx: Context
    props: InputProps
    initial: Omit<SourceControlSummary, 'permissionAvailable'>
    permissionCapable: boolean
    data: PickerData | null
    loading: boolean
    busy: boolean
    pending: PickerPending | null
    error: string | null
    sourceLocked: boolean
    refresh(): Promise<void>
    apply(action: PickerAction): Promise<boolean>
}

/** A single session occurrence owns the three controls and their callbacks.
 * Portals preserve its React/session context; global focused-session state is
 * never used to route a setting or an action. */
function SourceControls({ ctx, props, initial, permissionCapable, data, loading, busy, pending, error, sourceLocked, refresh, apply }: ControlsProps) {
    const locale = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
    const tr: Translate = (en, zh) => locale.startsWith('zh') ? zh : en
    const pane = useWorkspacePane(ctx)
    const paneState = useSyncExternalStore(pane?.state.subscribe ?? emptySubscribe, pane?.state.getSnapshot ?? fallbackPaneSnapshot)
    const [open, setOpen] = useState<PickerMode | null>(null), [page, setPage] = useState<'options' | 'models'>('options')
    const [attention, setAttention] = useState(false)
    const triggers = useRef<Partial<Record<PickerMode, HTMLButtonElement | null>>>({})
    const settingsPopup = useRef<HTMLDivElement>(null), actionsPopup = useRef<HTMLDivElement>(null)
    const id = useId(), [position, setPosition] = useState<PickerPosition>({ left: 8, top: 8, width: 320, maxHeight: 520, layout: 'popover' })
    const permissionAvailable = permissionPickerAvailable(permissionCapable, data)
    const visible = paneState.visible ? open : null
    const disabled = busy || Boolean(pending) || sourceLocked || !data
    const summary: SourceControlSummary = {
        model: data ? modelLabel(data.model, data.models) : initial.model,
        effort: data ? data.effort : initial.effort,
        permission: data ? data.permission : initial.permission,
        serviceTier: data ? data.serviceTier : initial.serviceTier,
        permissionAvailable, collaboration: initial.collaboration ?? null,
    }
    const close = useCallback((restoreFocus = false): void => {
        setOpen(null)
        if (restoreFocus && paneState.visible && open) triggers.current[open]?.focus({ preventScroll: true })
    }, [open, paneState.visible])
    const closeActions = useCallback(() => setOpen(current => current === 'actions' ? null : current), [])
    const toggle = (mode: PickerMode): void => { setPage('options'); setOpen(current => current === mode ? null : mode) }
    const panelElement = (): HTMLDivElement | null => visible === 'actions' ? actionsPopup.current : settingsPopup.current

    useEffect(() => { if (!paneState.visible || open === 'permission' && !permissionAvailable) setOpen(null) }, [paneState.visible, open, permissionAvailable])
    // Warm settings while the pane is visible, before the first click. A
    // mounted hidden pane must not start another source/model request.
    useEffect(() => { if (paneState.visible && !data) void refresh() }, [paneState.visible, refresh])
    useEffect(() => { if (visible && visible !== 'actions') void refresh() }, [visible, refresh])
    // One reconciliation timer per occurrence, including a closed pending
    // picker. The durable ledger never resubmits an uncertain operation.
    useEffect(() => {
        if (!paneState.visible || !(visible && visible !== 'actions' || pending)) return
        const timer = setInterval(() => { void refresh() }, 3000)
        return () => { clearInterval(timer) }
    }, [visible, paneState.visible, pending?.operationId, refresh])
    useLayoutEffect(() => {
        if (!visible) return
        const button = triggers.current[visible], panel = panelElement()
        if (!button || !panel) return
        const positionPopup = (): void => {
            const view = window.visualViewport
            const next = positionPicker(button.getBoundingClientRect(), {
                left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0,
                width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight,
            }, Math.max(panel.offsetHeight, panel.scrollHeight + 2), button.closest('.hapi-pane')?.getBoundingClientRect())
            setPosition(current => Object.keys(next).every(key => current[key as keyof PickerPosition] === next[key as keyof PickerPosition]) ? current : next)
        }
        positionPopup()
        const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(positionPopup)
        observer?.observe(panel); observer?.observe(button)
        window.addEventListener('resize', positionPopup)
        window.addEventListener('scroll', positionPopup, true)
        window.visualViewport?.addEventListener('resize', positionPopup)
        window.visualViewport?.addEventListener('scroll', positionPopup)
        return () => {
            observer?.disconnect(); window.removeEventListener('resize', positionPopup); window.removeEventListener('scroll', positionPopup, true)
            window.visualViewport?.removeEventListener('resize', positionPopup); window.visualViewport?.removeEventListener('scroll', positionPopup)
        }
    }, [visible, page, data, loading, error, pending, locale])
    useEffect(() => {
        if (!visible) return
        const outside = (event: Event): void => {
            const target = event.target
            if (target instanceof Node && !Object.values(triggers.current).some(button => button?.contains(target)) && !panelElement()?.contains(target)) close()
        }
        const escape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(true) }
        }
        document.addEventListener('pointerdown', outside, true)
        document.addEventListener('focusin', outside, true)
        document.addEventListener('keydown', escape, true)
        panelElement()?.querySelector<HTMLElement>('input:checked:not(:disabled),button:not(:disabled),input:not(:disabled)')?.focus({ preventScroll: true })
        return () => {
            document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true)
            document.removeEventListener('keydown', escape, true)
        }
    }, [visible, close])

    const select = (action: PickerAction): void => {
        if (disabled || action.kind === 'permission' && !permissionAvailable) return
        void apply(action).then(confirmed => { if (confirmed && action.kind === 'model') setPage('options') })
    }
    const heading = visible === 'permission' ? tr('Permissions', '权限') : page === 'models' ? tr('Choose model', '选择模型') : tr('Model settings', '模型设置')
    const panelStyle = { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }
    const settings = visible && visible !== 'actions' && <div ref={settingsPopup} id={`${id}-settings`} className="hapi-picker-popover" role="dialog" aria-modal="false"
        aria-label={visible === 'model' ? tr('Model settings', '模型设置') : tr('Permissions', '权限')}
        data-hapi-picker-popup={visible} data-picker-layout={position.layout} data-picker-session={props.sessionId} data-picker-pane={pane?.paneId} style={panelStyle}>
        <header>{visible === 'model' && page === 'models' && <button type="button" aria-label={tr('Back to model settings', '返回模型设置')} onClick={() => setPage('options')}><Glyph kind="back"/></button>}
            <strong>{heading}</strong><button type="button" aria-label={tr('Close picker', '关闭选择器')} onClick={() => close(true)}><Glyph kind="close"/></button></header>
        {visible === 'model' && page === 'options' && <>
            <div className="hapi-picker-model-page"><button type="button" disabled={!data?.models.length} onClick={() => setPage('models')} aria-label={tr('Choose model', '选择模型')}>
                <Glyph kind="model"/><span>{summary.model ?? tr('Model', '模型')}<small>{tr('Choose a model', '选择模型')}</small></span><Glyph kind="down"/></button></div>
            {data && data.efforts.length > 0 && <EffortChoices data={data} disabled={disabled || !data.editable.effort} select={select} tr={tr} name={`${id}-effort`}/>}
            {data && (data.fastAvailable || data.fast) && <div className="hapi-picker-fast"><span>Fast</span>
                <button className="hapi-picker-switch" type="button" role="switch" aria-label={tr('Fast mode', '快速模式')} aria-checked={data.fast}
                    disabled={disabled || !data.editable.fast} onClick={() => select({ kind: 'fast', value: !data.fast })}><span/></button></div>}
        </>}
        {visible === 'model' && page === 'models' && <div className="hapi-picker-options" role="radiogroup" aria-label={tr('Models', '模型')}>
            {data?.models.map(choice => <label key={modelKey(choice.value)}>
                <input type="radio" name={`${id}-model`} value={modelKey(choice.value)} checked={modelKey(data.model) === modelKey(choice.value)}
                    disabled={disabled || !data.editable.model} onChange={() => select({ kind: 'model', value: choice.value })}/>
                <span>{choice.label}{choice.detail && <small>{choice.detail}</small>}</span>{modelKey(data.model) === modelKey(choice.value) && <Glyph kind="check"/>}
            </label>)}
        </div>}
        {visible === 'permission' && <div className="hapi-picker-options" role="radiogroup" aria-label={tr('Permission modes', '权限模式')}>
            {data?.permissions.map(value => <label key={value}>
                <input type="radio" name={`${id}-permission`} value={value} checked={data.permission === value}
                    disabled={disabled || !data.editable.permission} onChange={() => select({ kind: 'permission', value })}/>
                <span>{permissionLabel(value, tr)}</span>{data.permission === value && <Glyph kind="check"/>}
            </label>)}
        </div>}
        {!data && loading && <p className="hapi-picker-note" role="status">{tr('Loading settings…', '正在读取设置…')}</p>}
        {data && (visible === 'permission' ? !data.editable.permission : !data.editable.model && !data.editable.effort && !data.editable.fast)
            && <p className="hapi-picker-note">{tr('These settings are unavailable in the current source snapshot. Refresh to check again.', '当前源快照中的设置暂不可用，请刷新重查。')}</p>}
        {pending && <PendingNote pending={pending} data={data} tr={tr}/>}
        {data?.warnings.map((message, index) => <p key={index} className="hapi-picker-note">{message}</p>)}
        {error && <p className="hapi-picker-note" role="alert">{error}</p>}
        {(error || pending || data?.readOnly) && <button className="hapi-picker-refresh" type="button" disabled={loading || busy} onClick={() => { void refresh() }}>{tr('Check source result', '检查源会话结果')}</button>}
    </div>
    // Keep our own action subtree mounted while closed: parking may hold an
    // unresolved save and original attachment bytes. Hidden panes hide this
    // portal too, without replacing its controller with a new occurrence.
    const actions = <div ref={actionsPopup} id={`${id}-actions`} className="hapi-picker-popover hapi-picker-actions" hidden={visible !== 'actions'} role="dialog" aria-modal="false"
        aria-label={tr('More input controls', '更多输入控件')} data-hapi-picker-popup="actions" data-picker-layout={position.layout}
        data-picker-session={props.sessionId} data-picker-pane={pane?.paneId} style={panelStyle}>
        <header><strong>{tr('More input controls', '更多输入控件')}</strong><button type="button" aria-label={tr('Close picker', '关闭选择器')} onClick={() => close(true)}><Glyph kind="close"/></button></header>
        <div role="group" aria-label={tr('More input controls', '更多输入控件')}>
            {props.renderSlot('hapi.source.composer-actions', { source: props, onAttention: setAttention, onClose: closeActions })}
        </div>
    </div>
    return <><SourceControlRow summary={summary} sessionId={props.sessionId} open={visible} panelId={id} pending={Boolean(pending)} attention={attention} tr={tr} onToggle={toggle}
        refs={{ model: node => { triggers.current.model = node }, permission: node => { triggers.current.permission = node }, actions: node => { triggers.current.actions = node } }}/>
        {createPortal(<>{settings}{actions}</>, document.body)}</>
}

function NativeControls({ ctx, native, props }: { ctx: Context; native: NativeControlLedger; props: InputProps }) {
    const source = props.useProjection('hapi')
    const locked = props.useInput(value => value.phase === 'adjudicating' || value.phase === 'submitting')
    const controller = useMemo(() => native.settings(props.sessionId), [native, props.sessionId])
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const data = useMemo(() => state.data ? nativePickerData(state.data) : null, [state.data])
    useEffect(() => { if (controller.getSnapshot().data) void controller.refresh() }, [controller, source?.model, source?.reasoningEffort, source?.permissionMode, source?.serviceTier, source?.collaborationMode, source?.nativeConnection, source?.readOnly])
    if (!source) return null
    return <SourceControls ctx={ctx} props={props} initial={{ model: source.model, effort: source.reasoningEffort, permission: source.permissionMode ?? null, serviceTier: source.serviceTier ?? null, collaboration: source.collaborationMode ?? null }}
        permissionCapable data={data} loading={state.loading} busy={state.busy} pending={nativePickerPending(state.pending)}
        error={state.error ?? (state.receipt?.status === 'rejected' ? state.receipt.message : null)} sourceLocked={locked}
        refresh={controller.refresh} apply={async action => {
            if (locked) return false
            const latest = controller.getSnapshot().data
            const change = latest ? nativePickerChange(nativePickerData(latest), action) : undefined
            return change ? controller.apply(change) : false
        }}/>
}

function ObservedControls({ ctx, observed, props }: { ctx: Context; observed: ObservedControlLedger; props: InputProps }) {
    const source = props.useProjection('hapiObserved')
    const locked = props.useInput(value => value.phase === 'adjudicating' || value.phase === 'submitting')
    const controller = useMemo(() => observed.settings(props.sessionId), [observed, props.sessionId])
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const data = useMemo(() => {
        if (!state.data) return null
        const result = observedPickerData(state.data)
        return { ...result, editable: { ...result.editable,
            model: result.editable.model && Boolean(source?.capabilities.model), effort: result.editable.effort && Boolean(source?.capabilities.effort),
            permission: result.editable.permission && Boolean(source?.capabilities.permissions) } }
    }, [state.data, source?.capabilities.model, source?.capabilities.effort, source?.capabilities.permissions])
    useEffect(() => { if (controller.getSnapshot().data) void controller.refresh() }, [controller, source?.model, source?.effort, source?.permissionMode, source?.serviceTier, source?.collaborationMode, source?.connection, source?.readOnly])
    if (!source) return null
    return <SourceControls ctx={ctx} props={props} initial={{ model: source.model, effort: source.effort, permission: source.permissionMode, serviceTier: source.serviceTier ?? null, collaboration: source.collaborationMode ?? null }}
        permissionCapable={source.capabilities.permissions} data={data} loading={state.loading} busy={state.busy} pending={state.pending}
        error={state.error ?? (state.receipt?.status === 'rejected' ? state.receipt.message : null)} sourceLocked={locked}
        refresh={controller.refresh} apply={async action => {
            if (locked || action.kind === 'permission' && !source.capabilities.permissions
                || action.kind === 'model' && !source.capabilities.model || action.kind === 'effort' && !source.capabilities.effort) return false
            const latest = controller.getSnapshot().data
            const change = latest ? observedPickerChange(observedPickerData(latest), action) : undefined
            return change ? controller.apply(change) : false
        }}/>
}

/** Ordinary DSH and source child-history trees have no replacement controls. */
export function SourceComposerControls({ ctx, native, observed, props }: { ctx: Context; native: NativeControlLedger; observed: ObservedControlLedger; props: InputProps }) {
    const nativeSource = props.useProjection('hapi'), observedSource = props.useProjection('hapiObserved')
    if (observedSource?.sidechain || observedSource?.dshChild) return null
    if (nativeSource) return <NativeControls key={props.sessionId} ctx={ctx} native={native} props={props}/>
    if (observedSource) return <ObservedControls key={props.sessionId} ctx={ctx} observed={observed} props={props}/>
    return null
}

export function installComposerPicker(ctx: Context, native: NativeControlLedger, observed: ObservedControlLedger): () => void {
    // One public list contribution declares one private-to-our-plugin child
    // slot. Neither official single model/permission slot is registered over.
    const stop = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'hapi.source-controls', order: 90,
        children: { 'hapi.source.composer-actions': { kind: 'single', scope: 'session' } },
    }, (props: InputProps) => <SourceComposerControls ctx={ctx} native={native} observed={observed} props={props}/>))
    const style = document.createElement('style'); style.textContent = composerPickerStyles; document.head.append(style)
    return () => { stop(); style.remove() }
}
