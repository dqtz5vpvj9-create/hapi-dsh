import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NativeControlLedger } from '../native-control-state.ts'
import type { ObservedControlLedger } from '../observed-controls.tsx'
import { useWorkspacePane } from '../surface/pane-context.tsx'
import { modelKey, modelLabel, nativePickerChange, nativePickerData, observedPickerChange, observedPickerData,
    type PickerAction, type PickerChoice, type PickerData } from './data.ts'
import { composerPickerStyles } from './styles.ts'

type Mode = 'model' | 'permission'
type InputProps = PropsRuntime<'conversation.input.left'>
type Translate = (english: string, chinese: string) => string
const fallbackPane = { focused: true, visible: true }
const emptySubscribe = (): (() => void) => () => {}
const fallbackPaneSnapshot = () => fallbackPane

function Glyph({ kind }: { kind: 'model' | 'permission' | 'check' | 'down' | 'back' | 'close' }) {
    const path = {
        model: 'M4 3h8v8H4z M1 6h3 M12 6h3 M1 9h3 M12 9h3 M6 0v3 M9 0v3 M6 11v3 M9 11v3',
        permission: 'M7.5 1 13 3v4c0 3-3 5-5.5 7C5 12 2 10 2 7V3z M5 7l2 2 3-4',
        check: 'm3 7 3 3 6-6', down: 'm4 6 3.5 3.5L11 6', back: 'm9 3-5 4.5L9 12', close: 'm4 4 7 7 M11 4l-7 7',
    }[kind]
    return <svg viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>
}
function effortLabel(choice: PickerChoice<string | null>, tr: Translate): string {
    if (choice.value === null) return tr('Default', '默认')
    const known: Record<string, [string, string]> = { minimal: ['Minimal', '最低'], low: ['Low', '低'], medium: ['Medium', '中'], high: ['High', '高'], xhigh: ['XHigh', '超高'], max: ['Max', '最高'] }
    const label = known[choice.value]
    return label ? tr(...label) : choice.label
}
function permissionLabel(value: string | null, tr: Translate): string {
    if (value === 'default') return tr('Request approval', '请求批准')
    if (value === 'read-only') return tr('Read only', '只读')
    if (value === 'yolo' || value === 'bypassPermissions') return tr('Full access', '完全访问')
    return value ?? tr('Permissions', '权限')
}

function EffortSlider({ data, disabled, select, tr }: { data: PickerData; disabled: boolean; select: (action: PickerAction) => void; tr: Translate }) {
    const selected = data.efforts.findIndex(row => row.value === data.effort)
    const [draft, setDraft] = useState(Math.max(0, selected))
    const dirty = useRef(false)
    useEffect(() => { setDraft(Math.max(0, selected)); dirty.current = false }, [selected, data.efforts.length, disabled])
    const commit = (index: number, explicit = false): void => {
        if (!explicit && !dirty.current) return
        dirty.current = false
        const choice = data.efforts[index]
        if (!disabled && choice && choice.value !== data.effort) select({ kind: 'effort', value: choice.value })
    }
    const label = selected < 0 ? data.effort ?? tr('Not reported', '未报告') : effortLabel(data.efforts[draft] ?? data.efforts[selected]!, tr)
    return <section className="hapi-picker-effort">
        <div><strong>{tr('Reasoning effort', '推理强度')}</strong><output>{label}</output></div>
        <input type="range" aria-label={tr('Reasoning effort', '推理强度')} min={0} max={data.efforts.length - 1} step={1}
            value={draft} aria-valuetext={label} disabled={disabled || data.efforts.length < 2}
            onChange={event => { dirty.current = true; setDraft(Number(event.currentTarget.value)) }}
            onPointerUp={event => commit(Number(event.currentTarget.value))}
            onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commit(Number(event.currentTarget.value)) }}
            onBlur={event => commit(Number(event.currentTarget.value))}/>
        <div className="hapi-picker-stops">{data.efforts.map((choice, index) => <button type="button" key={choice.value ?? 'default'}
            disabled={disabled} aria-pressed={selected === index} onClick={() => { setDraft(index); commit(index, true) }}>{effortLabel(choice, tr)}</button>)}</div>
    </section>
}

interface PickerProps {
    ctx: Context
    mode: Mode
    sessionId: string
    initialModel: string | null
    initialEffort: string | null
    initialPermission: string | null
    data: PickerData | null
    loading: boolean
    busy: boolean
    pending: boolean
    error: string | null
    sourceLocked: boolean
    refresh(): Promise<void>
    apply(action: PickerAction): Promise<boolean>
}

/** The popup is our own portal, so a narrow official toolbar's overflow cannot
 * clip it. Session ids and controllers are captured by the originating view. */
function Picker({ ctx, mode, sessionId, initialModel, initialEffort, initialPermission, data, loading, busy, pending, error, sourceLocked, refresh, apply }: PickerProps) {
    const locale = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
    const tr: Translate = (en, zh) => locale.startsWith('zh') ? zh : en
    const pane = useWorkspacePane(ctx)
    const paneState = useSyncExternalStore(pane?.state.subscribe ?? emptySubscribe, pane?.state.getSnapshot ?? fallbackPaneSnapshot)
    const [open, setOpen] = useState(false), [page, setPage] = useState<'options' | 'models'>('options')
    const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
    const id = useId(), [position, setPosition] = useState({ left: 8, top: 8 })
    const visible = open && paneState.visible && paneState.focused
    const disabled = busy || pending || loading || sourceLocked
    const currentModel = data ? modelLabel(data.model, data.models) : initialModel
    const currentEffort = data ? data.effort : initialEffort
    const currentPermission = data ? data.permission : initialPermission
    const caption = mode === 'model' ? currentModel ?? tr('Model', '模型') : permissionLabel(currentPermission, tr)
    const close = (restoreFocus = false): void => { setOpen(false); if (restoreFocus && paneState.visible) anchor.current?.focus({ preventScroll: true }) }

    useEffect(() => { if (!paneState.visible || !paneState.focused) setOpen(false) }, [paneState.visible, paneState.focused])
    useEffect(() => { if (visible) void refresh() }, [visible, refresh])
    // Both capsules share one ledger. The model occurrence owns pending read
    // reconciliation even while its popover is closed; writes are never replayed.
    useEffect(() => {
        if (!paneState.visible || !(visible || mode === 'model' && pending)) return
        const timer = setInterval(() => { void refresh() }, 3000)
        return () => { clearInterval(timer) }
    }, [visible, paneState.visible, mode, pending, refresh])
    useLayoutEffect(() => {
        if (!visible) return
        const positionPopup = (): void => {
            const button = anchor.current, panel = popup.current
            if (!button || !panel) return
            const box = button.getBoundingClientRect(), view = window.visualViewport
            const left = view?.offsetLeft ?? 0, top = view?.offsetTop ?? 0
            const width = view?.width ?? window.innerWidth, height = view?.height ?? window.innerHeight
            const x = Math.max(left + 8, Math.min(box.right - panel.offsetWidth, left + width - panel.offsetWidth - 8))
            const above = box.top - panel.offsetHeight - 7
            const y = above >= top + 8 ? above : Math.min(box.bottom + 7, top + height - panel.offsetHeight - 8)
            setPosition(current => current.left === x && current.top === Math.max(top + 8, y) ? current : { left: x, top: Math.max(top + 8, y) })
        }
        positionPopup()
        window.addEventListener('resize', positionPopup)
        window.addEventListener('scroll', positionPopup, true)
        window.visualViewport?.addEventListener('resize', positionPopup)
        return () => { window.removeEventListener('resize', positionPopup); window.removeEventListener('scroll', positionPopup, true); window.visualViewport?.removeEventListener('resize', positionPopup) }
    }, [visible, page, data, loading, error, pending])
    useEffect(() => {
        if (!visible) return
        const outside = (event: PointerEvent): void => {
            const target = event.target
            if (target instanceof Node && !anchor.current?.contains(target) && !popup.current?.contains(target)) close()
        }
        const escape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(true) }
        }
        document.addEventListener('pointerdown', outside, true)
        document.addEventListener('keydown', escape, true)
        popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
        return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true) }
    }, [visible])

    const select = (action: PickerAction): void => {
        if (disabled) return
        void apply(action).then(confirmed => { if (confirmed && action.kind === 'model') setPage('options') })
    }
    const panel = visible && <div ref={popup} id={id} className="hapi-picker-popover" role="dialog" aria-modal="false"
        aria-label={mode === 'model' ? tr('Model settings', '模型设置') : tr('Permissions', '权限')}
        data-hapi-picker-popup={mode} data-picker-session={sessionId} style={position}>
        <header>{mode === 'model' && page === 'models' && <button type="button" aria-label={tr('Back to model settings', '返回模型设置')} onClick={() => setPage('options')}><Glyph kind="back"/></button>}
            <strong>{mode === 'permission' ? tr('Permissions', '权限') : page === 'models' ? tr('Choose model', '选择模型') : tr('Model settings', '模型设置')}</strong>
            <button type="button" aria-label={tr('Close picker', '关闭选择器')} onClick={() => close(true)}><Glyph kind="close"/></button></header>
        {mode === 'model' && page === 'options' && <>
            <div className="hapi-picker-model-page"><button type="button" disabled={!data?.models.length} onClick={() => setPage('models')} aria-label={tr('Choose model', '选择模型')}>
                <Glyph kind="model"/><span>{caption}<small>{tr('Choose a model', '选择模型')}</small></span><Glyph kind="down"/></button></div>
            {data && data.efforts.length > 0 && <EffortSlider data={data} disabled={disabled || !data.editable.effort} select={select} tr={tr}/>}
            {data && (data.fastAvailable || data.fast) && <div className="hapi-picker-fast"><span>Fast</span>
                <button className="hapi-picker-switch" type="button" role="switch" aria-label={tr('Fast mode', '快速模式')} aria-checked={data.fast}
                    disabled={disabled || !data.editable.fast} onClick={() => select({ kind: 'fast', value: !data.fast })}><span/></button></div>}
        </>}
        {mode === 'model' && page === 'models' && <div className="hapi-picker-options" role="group" aria-label={tr('Models', '模型')}>
            {data?.models.map(choice => <button type="button" role="radio" key={modelKey(choice.value)} aria-checked={modelKey(data.model) === modelKey(choice.value)}
                disabled={disabled || !data.editable.model} onClick={() => select({ kind: 'model', value: choice.value })}>
                <span>{choice.label}{choice.detail && <small>{choice.detail}</small>}</span>{modelKey(data.model) === modelKey(choice.value) && <Glyph kind="check"/>}</button>)}
        </div>}
        {mode === 'permission' && <div className="hapi-picker-options" role="group" aria-label={tr('Permission modes', '权限模式')}>
            {data?.permissions.map(value => <button type="button" role="radio" key={value} aria-checked={data.permission === value}
                disabled={disabled || !data.editable.permission} onClick={() => select({ kind: 'permission', value })}>
                <span>{permissionLabel(value, tr)}</span>{data.permission === value && <Glyph kind="check"/>}</button>)}
        </div>}
        {!data && loading && <p className="hapi-picker-note" role="status">{tr('Loading settings…', '正在读取设置…')}</p>}
        {data && (mode === 'permission' ? !data.editable.permission : !data.editable.model && !data.editable.effort && !data.editable.fast) && <p className="hapi-picker-note">{tr('Settings are controlled by the source session.', '设置由源会话控制。')}</p>}
        {pending && <p className="hapi-picker-note" role="status">{tr('Waiting for the source to confirm…', '等待源会话确认…')}</p>}
        {data?.warnings.map((message, index) => <p key={index} className="hapi-picker-note">{message}</p>)}
        {error && <p className="hapi-picker-note" role="alert">{error}</p>}
        {(error || pending) && <button className="hapi-picker-refresh" type="button" disabled={loading || busy} onClick={() => { void refresh() }}>{tr('Check source result', '检查源会话结果')}</button>}
    </div>
    return <span className="hapi-picker-anchor" data-hapi-composer-picker={mode}>
        <button ref={anchor} type="button" className="hapi-picker-capsule" aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? id : undefined}
            data-pending={pending ? '' : undefined} title={mode === 'model' ? tr('Model and reasoning effort', '模型与推理强度') : tr('Session permissions', '会话权限')}
            onClick={() => { setPage('options'); setOpen(current => !current) }}>
            <Glyph kind={mode}/><span data-picker-label>{caption}</span>{mode === 'model' && currentEffort && <small>{currentEffort}</small>}<Glyph kind="down"/>
        </button>{panel && createPortal(panel, document.body)}
    </span>
}

export function installComposerPicker(ctx: Context, native: NativeControlLedger, observed: ObservedControlLedger): () => void {
    const Native = ({ props, mode }: { props: InputProps; mode: Mode }) => {
        const source = props.useProjection('hapi')
        const locked = props.useInput(value => value.phase === 'adjudicating' || value.phase === 'submitting')
        const controller = useMemo(() => native.settings(props.sessionId), [props.sessionId])
        const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
        const data = useMemo(() => state.data ? nativePickerData(state.data) : null, [state.data])
        // No cold-open settings fetch. Once inspected, follow source-owned
        // model changes so a closed capsule does not retain a stale label.
        useEffect(() => { if (controller.getSnapshot().data) void controller.refresh() }, [controller, source?.model, source?.reasoningEffort])
        if (!source) return null
        return <Picker ctx={ctx} mode={mode} sessionId={props.sessionId} initialModel={source.model} initialEffort={source.reasoningEffort} initialPermission={null}
            data={data} loading={state.loading} busy={state.busy} pending={Boolean(state.pending)} error={state.error ?? (state.receipt?.status === 'rejected' ? state.receipt.message : null)}
            sourceLocked={locked || source.readOnly} refresh={controller.refresh} apply={async action => {
                const latest = controller.getSnapshot().data
                const change = latest ? nativePickerChange(nativePickerData(latest), action) : undefined
                return change ? controller.apply(change) : false
            }}/>
    }
    const Observed = ({ props, mode }: { props: InputProps; mode: Mode }) => {
        const source = props.useProjection('hapiObserved')
        const locked = props.useInput(value => value.phase === 'adjudicating' || value.phase === 'submitting')
        const controller = useMemo(() => observed.settings(props.sessionId), [props.sessionId])
        const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
        const data = useMemo(() => state.data ? observedPickerData(state.data) : null, [state.data])
        useEffect(() => { if (controller.getSnapshot().data) void controller.refresh() }, [controller, source?.model, source?.effort, source?.permissionMode])
        if (!source) return null
        return <Picker ctx={ctx} mode={mode} sessionId={props.sessionId} initialModel={source.model} initialEffort={source.effort} initialPermission={source.permissionMode}
            data={data} loading={state.loading} busy={state.busy} pending={Boolean(state.pending)} error={state.error ?? (state.receipt?.status === 'rejected' ? state.receipt.message : null)}
            sourceLocked={locked || source.readOnly} refresh={controller.refresh} apply={async action => {
                const latest = controller.getSnapshot().data
                const change = latest ? observedPickerChange(observedPickerData(latest), action) : undefined
                return change ? controller.apply(change) : false
            }}/>
    }
    const Source = ({ props, mode }: { props: InputProps; mode: Mode }) => {
        const nativeSource = props.useProjection('hapi'), observedSource = props.useProjection('hapiObserved')
        if (observedSource?.sidechain || observedSource?.dshChild) return null
        if (nativeSource) return <Native key={props.sessionId} props={props} mode={mode}/>
        if (observedSource) return <Observed key={props.sessionId} props={props} mode={mode}/>
        return null
    }
    const stops = [
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'hapi.permission-picker', order: -90 },
            (props: InputProps) => <Source props={props} mode="permission"/>)),
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'hapi.model-picker', order: 90 },
            (props: InputProps) => <Source props={props} mode="model"/>)),
    ]
    const style = document.createElement('style'); style.textContent = composerPickerStyles; document.head.append(style)
    return () => { for (const stop of stops.reverse()) stop(); style.remove() }
}
