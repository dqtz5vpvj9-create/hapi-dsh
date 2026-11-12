import type { HhpiRemoteApi } from '../../hhpi-api.ts'
import { DirectCodexControls } from '../remote-codex-controls.tsx'
import { isSourceSessionId } from '../../remote/protocol.ts'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { useWorkspacePane } from '../surface/pane-context.tsx'
import { modelKey, modelLabel,
    permissionPickerAvailable, type PickerAction, type PickerData, type PickerPending } from './data.ts'
import { EffortChoices, Glyph, PendingNote, SourceControlRow, approvalPolicyLabel, pendingTarget, permissionLabel, type PickerMode, type SourceControlSummary, type Translate } from './presentation.tsx'
import { usePickerPopover } from './popover.ts'
import type { SourceInputProps } from './slots.ts'
import { composerPickerStyles } from './styles.ts'
import { installComposerDetails } from '../composer-details.tsx'
import { CompactComposerTools, ComposerSteerAction } from '../compact-composer.tsx'

export type InputProps = SourceInputProps & PropsRenderSlots<'hapi.source.composer-actions' | 'hapi.source.composer-details' | 'hapi.source.composer-navigation' | 'hapi.source.composer-tools'>
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
    applied?: PickerPending | null
    error: string | null
    sourceLocked: boolean
    refresh(): Promise<void>
    resume?(): Promise<void>
    actionsContent?: ReactNode
    apply(action: PickerAction): Promise<boolean>
}

/** A single session occurrence owns the three controls and their callbacks.
 * Portals preserve its React/session context; global focused-session state is
 * never used to route a setting or an action. */
export function SourceControls({ ctx, props, initial, permissionCapable, data, loading, busy, pending, applied, error, sourceLocked, refresh, resume, apply, actionsContent }: ControlsProps) {
    const locale = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
    const tr: Translate = (en, zh) => locale.startsWith('zh') ? zh : en
    const pane = useWorkspacePane(ctx)
    const paneState = useSyncExternalStore(pane?.state.subscribe ?? emptySubscribe, pane?.state.getSnapshot ?? fallbackPaneSnapshot)
    const [open, setOpen] = useState<PickerMode | null>(null)
    const [attention, setAttention] = useState(false)
    const triggers = useRef<Partial<Record<PickerMode, HTMLButtonElement | null>>>({})
    const settingsPopup = useRef<HTMLDivElement>(null), actionsPopup = useRef<HTMLDivElement>(null)
    const [overflowTools, setOverflowTools] = useState<HTMLDivElement | null>(null)
    const id = useId()
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
    const toggle = (mode: PickerMode): void => { setOpen(current => current === mode ? null : mode) }
    const panelElement = (): HTMLDivElement | null => visible === 'actions' ? actionsPopup.current : settingsPopup.current
    const dismiss = useCallback(() => setOpen(null), [])
    const popup = usePickerPopover({ visible, id, triggers, settingsPopup, actionsPopup, close: dismiss })
    const { position } = popup

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
    useLayoutEffect(() => { popup.remeasure.current?.() }, [data, loading, error, pending, applied, locale])
    useEffect(() => {
        if (!visible) return
        const outside = (event: Event): void => {
            const target = event.target
            if (target instanceof Node && !Object.values(triggers.current).some(button => button?.contains(target)) && !panelElement()?.contains(target)) close()
        }
        const escape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); event.preventDefault(); close(true) }
        }
        if (!popup.native) document.addEventListener('pointerdown', outside, true)
        document.addEventListener('focusin', outside, true)
        document.addEventListener('keydown', escape, true)
        const panel = panelElement()
        ;(panel?.querySelector<HTMLElement>('input:checked:not(:disabled)') ?? panel?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled)'))?.focus({ preventScroll: true })
        return () => {
            document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true)
            document.removeEventListener('keydown', escape, true)
        }
    }, [visible, close, popup.native])

    const select = (action: PickerAction): void => {
        if (disabled || action.kind === 'permission' && !permissionAvailable) return
        void apply(action).then(confirmed => { if (confirmed && action.kind === 'model') close(true) })
    }
    const heading = visible === 'permission' ? tr('Permissions', '权限') : visible === 'effort' ? tr('Reasoning effort', '推理强度') : tr('Choose model', '选择模型')
    const panelStyle = popup.anchored ? { positionAnchor: popup.anchorName, '--hhpi-picker-pane-anchor': popup.paneAnchor } as CSSProperties
        : { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }
    const nativePopover = popup.native ? { popover: 'auto' as const } : {}
    const settings = visible && visible !== 'actions' && <div ref={settingsPopup} id={`${id}-settings`} className="hapi-picker-popover" role="dialog" aria-modal="false"
        aria-label={heading} {...nativePopover} data-picker-positioning={popup.anchored ? 'anchor' : 'geometry'}
        data-hapi-picker-popup={visible} data-picker-layout={position.layout} data-picker-session={props.sessionId} data-picker-pane={pane?.paneId} style={panelStyle}>
        <header><strong>{heading}</strong><button type="button" aria-label={tr('Close picker', '关闭选择器')} onClick={() => close(true)}><Glyph kind="close"/></button></header>
        {visible === 'effort' && <>
            {data && data.efforts.length > 0 && <EffortChoices data={data} disabled={disabled || !data.editable.effort} select={select} tr={tr} name={`${id}-effort`}/>}
            {data && (data.fastAvailable || data.fast) && <div className="hapi-picker-fast"><span>Fast</span>
                <button className="hapi-picker-switch" type="button" role="switch" aria-label={tr('Fast mode', '快速模式')} aria-checked={data.fast}
                    disabled={disabled || !data.editable.fast} onClick={() => select({ kind: 'fast', value: !data.fast })}><span/></button></div>}
        </>}
        {visible === 'model' && <div className="hapi-picker-options" role="radiogroup" aria-label={tr('Models', '模型')}>
            {data?.models.map(choice => <label key={modelKey(choice.value)}>
                <input type="radio" name={`${id}-model`} value={modelKey(choice.value)} checked={modelKey(data.model) === modelKey(choice.value)}
                    disabled={disabled || !data.editable.model} onChange={() => select({ kind: 'model', value: choice.value })}/>
                <span>{choice.label}{choice.detail && <small>{choice.detail}</small>}</span>{modelKey(data.model) === modelKey(choice.value) && <Glyph kind="check"/>}
            </label>)}
        </div>}
        {visible === 'permission' && <>
            {!!data?.permissions.length && <div className="hapi-picker-options" role="radiogroup" aria-label={tr('Permission modes', '权限模式')}>
                {!!data.approvalPolicies?.length && <p className="hapi-picker-note">{tr('Resource access', '资源访问')}</p>}
                {summary.permission === null && <p className="hapi-picker-note">{tr('The source has not reported the current permissions.', '源端尚未报告当前权限。')}</p>}
                {data.permissions.map(value => <label key={value}>
                    <input type="radio" name={`${id}-permission`} value={value} checked={data.permission === value}
                        disabled={disabled || !data.editable.permission} onChange={() => select({ kind: 'permission', value })}/>
                    <span>{permissionLabel(value, tr)}</span>{data.permission === value && <Glyph kind="check"/>}
                </label>)}
            </div>}
            {!!data?.approvalPolicies?.length && <div className="hapi-picker-options" role="radiogroup" aria-label={tr('Approval requests', '审批请求')}>
                <p className="hapi-picker-note">{tr('Approval requests', '审批请求')}</p>
                {data.approvalPolicy == null && <p className="hapi-picker-note">{tr('The source has not reported the current approval policy.', '源端尚未报告当前审批策略。')}</p>}
                {data.approvalPolicy != null && !data.approvalPolicies.includes(data.approvalPolicy) && <p className="hapi-picker-note">{approvalPolicyLabel(data.approvalPolicy, tr)}</p>}
                {data.approvalPolicies.map(value => <label key={value}>
                    <input type="radio" name={`${id}-approval`} value={value} checked={data.approvalPolicy === value}
                        disabled={disabled || !data.editable.approvalPolicy} onChange={() => select({ kind: 'approvalPolicy', value })}/>
                    <span>{approvalPolicyLabel(value, tr)}</span>{data.approvalPolicy === value && <Glyph kind="check"/>}
                </label>)}
            </div>}
        </>}
        {!data && loading && <p className="hapi-picker-note" role="status">{tr('Loading settings…', '正在读取设置…')}</p>}
        {data && (visible === 'permission' ? !data.editable.permission && !data.editable.approvalPolicy : !data.editable.model && !data.editable.effort && !data.editable.fast)
            && <p className="hapi-picker-note">{tr('These settings are unavailable in the current source snapshot. Refresh to check again.', '当前源快照中的设置暂不可用，请刷新重查。')}</p>}
        {pending && <PendingNote pending={pending} data={data} tr={tr}/>}
        {applied && (visible === 'permission' ? ['permission', 'approvalPolicy'].includes(applied.change.kind) : visible === 'model' ? applied.change.kind === 'model' : ['effort', 'serviceTier'].includes(applied.change.kind))
            && <p className="hapi-picker-note" role="status" data-picker-applied-target={applied.change.kind}>{tr('Applied', '已应用')}: {pendingTarget(applied, data, tr)}</p>}
        {data?.warnings.map((message, index) => <p key={index} className="hapi-picker-note">{message}</p>)}
        {error && <p className="hapi-picker-note" role="alert">{error}</p>}
        {pending && resume && <button className="hapi-picker-refresh" type="button" disabled={loading || busy || sourceLocked} onClick={() => { void resume() }}>{tr('Continue original request', '继续原请求')}</button>}
        {(error || pending || data?.readOnly) && <button className="hapi-picker-refresh" type="button" disabled={loading || busy} onClick={() => { void refresh() }}>{tr('Check source result', '检查源会话结果')}</button>}
    </div>
    // Keep our own action subtree mounted while closed: parking may hold an
    // unresolved save and original attachment bytes. Hidden panes hide this
    // portal too, without replacing its controller with a new occurrence.
    const actions = <div ref={actionsPopup} id={`${id}-actions`} className="hapi-picker-popover hapi-picker-actions" hidden={visible !== 'actions'} role="dialog" aria-modal="false"
        {...nativePopover} data-picker-positioning={popup.anchored ? 'anchor' : 'geometry'}
        aria-label={tr('More input controls', '更多输入控件')} data-hapi-picker-popup="actions" data-picker-layout={position.layout}
        data-picker-session={props.sessionId} data-picker-pane={pane?.paneId} style={panelStyle}>
        <header><strong>{tr('More input controls', '更多输入控件')}</strong><button type="button" aria-label={tr('Close picker', '关闭选择器')} onClick={() => close(true)}><Glyph kind="close"/></button></header>
        <div role="group" aria-label={tr('More input controls', '更多输入控件')}>
            <ComposerSteerAction ctx={ctx} props={props} zh={locale.startsWith('zh')} close={closeActions}/>
            {actionsContent}
            {props.renderSlot('hapi.source.composer-navigation', { source: props, onClose: closeActions })}
            {props.renderSlot('hapi.source.composer-actions', { source: props, onAttention: setAttention, onClose: closeActions })}
            <div className="hapi-composer-overflow-section" ref={setOverflowTools}/>
            <div className="hapi-composer-details">{props.renderSlot('hapi.source.composer-details', {})}</div>
        </div>
    </div>
    return <><SourceControlRow summary={summary} sessionId={props.sessionId} open={visible} panelId={id} pending={Boolean(pending)} attention={attention} tr={tr} onToggle={toggle}
        utilities={<>{props.renderSlot('hapi.source.composer-tools', { source: props })}<CompactComposerTools ctx={ctx} props={props} zh={locale.startsWith('zh')} overflow={overflowTools}/></>}
        refs={{ effort: node => { triggers.current.effort = node }, model: node => { triggers.current.model = node }, permission: node => { triggers.current.permission = node }, actions: node => { triggers.current.actions = node } }}/>
        {createPortal(<>{settings}{actions}</>, document.body)}</>
}

/** Ordinary DSH keeps its official controls; HHPI uses its source capability. */
export function SourceComposerControls({ ctx, hhpi, props }: { ctx: Context; hhpi: HhpiRemoteApi; props: InputProps }) {
    return isSourceSessionId(props.sessionId) ? <DirectCodexControls key={props.sessionId} ctx={ctx} api={hhpi} props={props}/> : null
}

export function installComposerPicker(ctx: Context): () => void {
    // One public list contribution declares one private-to-our-plugin child
    // slot. Neither official single model/permission slot is registered over.
    const hhpi = ctx.remote.hhpi
    const stop = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'hapi.source-controls', order: 90,
        children: { 'hapi.source.composer-actions': { kind: 'single', scope: 'session' }, 'hapi.source.composer-details': { kind: 'list', scope: 'session' },
            'hapi.source.composer-navigation': { kind: 'list', scope: 'session' },
            'hapi.source.composer-tools': { kind: 'list', scope: 'session' } },
    }, (props: InputProps) => <SourceComposerControls ctx={ctx} hhpi={hhpi} props={props}/>))
    const stopDetails = installComposerDetails(ctx)
    const style = document.createElement('style'); style.textContent = composerPickerStyles; document.head.append(style)
    return () => { stopDetails(); stop(); style.remove() }
}
