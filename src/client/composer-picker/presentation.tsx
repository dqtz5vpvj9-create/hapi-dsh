import { useState, type Ref } from 'react'
import { explicitEffort, modelLabel, visibleServiceTier, type PickerAction, type PickerChoice, type PickerData, type PickerPending } from './data.ts'

export type PickerMode = 'model' | 'permission' | 'actions'
export type Translate = (english: string, chinese: string) => string

export function Glyph({ kind }: { kind: 'model' | 'permission' | 'check' | 'down' | 'back' | 'close' | 'more' }) {
    const path = {
        model: 'M4 3h8v8H4z M1 6h3 M12 6h3 M1 9h3 M12 9h3 M6 0v3 M9 0v3 M6 11v3 M9 11v3',
        permission: 'M7.5 1 13 3v4c0 3-3 5-5.5 7C5 12 2 10 2 7V3z M5 7l2 2 3-4',
        check: 'm3 7 3 3 6-6', down: 'm4 6 3.5 3.5L11 6', back: 'm9 3-5 4.5L9 12', close: 'm4 4 7 7 M11 4l-7 7',
        more: 'M3 7.5h.1 M7.5 7.5h.1 M12 7.5h.1',
    }[kind]
    return <svg viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth={kind === 'more' ? 2.4 : 1.35}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>
}

export function effortLabel(choice: PickerChoice<string | null>, tr: Translate): string {
    if (choice.value === null || choice.value === 'default') return tr('Default', '默认')
    const known: Record<string, [string, string]> = { minimal: ['Minimal', '最低'], low: ['Low', '低'], medium: ['Medium', '中'], high: ['High', '高'], xhigh: ['XHigh', '超高'], max: ['Max', '最高'] }
    return known[choice.value] ? tr(...known[choice.value]!) : choice.label
}

export function permissionLabel(value: string | null, tr: Translate): string {
    if (value === 'default') return tr('Request approval', '请求批准')
    if (value === 'read-only') return tr('Read only', '只读')
    if (value === 'yolo' || value === 'bypassPermissions') return tr('Full access', '完全访问')
    return value ?? tr('Permissions not reported', '权限未报告')
}

export interface SourceControlSummary {
    model: string | null
    effort: string | null
    permission: string | null
    permissionAvailable: boolean
    readOnly: boolean
    serviceTier: string | null
    collaboration?: string | null
}

/** This is the only source toolbar group. Permission support is independent
 * of the current lock, and Standard never hides permission/read-only state. */
export function SourceControlRow({ summary, sessionId, open, panelId, pending, attention, refs = {}, onToggle, tr }: {
    summary: SourceControlSummary; sessionId: string; open: PickerMode | null; panelId: string
    pending: boolean; attention: boolean; refs?: Partial<Record<PickerMode, Ref<HTMLButtonElement>>>
    onToggle(mode: PickerMode): void; tr: Translate
}) {
    const effort = explicitEffort(summary.effort), tier = visibleServiceTier(summary.serviceTier)
    const model = summary.model ?? tr('Model', '模型')
    const effortText = effort ? effortLabel({ value: effort, label: effort }, tr) : null
    const tierText = tier === 'fast' ? '⚡' : tier
    const shared = (mode: PickerMode) => ({ 'aria-haspopup': 'dialog' as const, 'aria-expanded': open === mode,
        'aria-controls': open === mode ? `${panelId}-${mode === 'actions' ? 'actions' : 'settings'}` : undefined })
    return <div className="hapi-source-controls" data-picker-session={sessionId}>
        <span className="hapi-picker-anchor" data-hapi-composer-picker="model">
            <button ref={refs.model} type="button" className="hapi-picker-capsule hapi-model-trigger" {...shared('model')}
                data-pending={pending ? '' : undefined} title={[tr('Model and reasoning effort', '模型与推理强度'), model, effortText, tierText].filter(Boolean).join(' · ')}
                onClick={() => onToggle('model')}>
                <Glyph kind="model"/><span data-picker-label>{model}</span>
                {effortText && <span className="hapi-picker-badge" data-picker-effort title={effortText}>{effortText}</span>}
                {tierText && <span className="hapi-picker-badge" data-picker-service-tier title={tierText}>{tierText}</span>}
                <Glyph kind="down"/>
            </button>
        </span>
        {summary.permissionAvailable ? <span className="hapi-picker-anchor" data-hapi-composer-picker="permission">
            <button ref={refs.permission} type="button" className="hapi-picker-capsule hapi-permission-trigger" {...shared('permission')}
                title={`${tr('Session permissions', '会话权限')} · ${permissionLabel(summary.permission, tr)}`} onClick={() => onToggle('permission')}>
                <Glyph kind="permission"/><span data-picker-label>{permissionLabel(summary.permission, tr)}</span><Glyph kind="down"/>
            </button>
        </span> : summary.permission !== null && <span className="hapi-source-permission" data-hapi-source-permission>{permissionLabel(summary.permission, tr)}</span>}
        {summary.collaboration && <span className="hapi-source-collaboration" data-hapi-source-collaboration>{summary.collaboration === 'plan' ? tr('Plan', '规划') : summary.collaboration}</span>}
        {summary.readOnly && summary.permission !== 'read-only' && <span className="hapi-source-readonly" data-hapi-source-readonly>{tr('Read only', '只读')}</span>}
        <button ref={refs.actions} type="button" className="hapi-picker-overflow hapi-overflow-trigger" data-hapi-composer-overflow="" {...shared('actions')}
            aria-label={tr('More input controls', '更多输入控件')} title={tr('More input controls', '更多输入控件')} onClick={() => onToggle('actions')}>
            <Glyph kind="more"/>{attention && <span className="hapi-picker-attention" aria-label={tr('Parked draft needs attention', '暂存草稿需要处理')}/>}
        </button>
    </div>
}

/** Drag previews a supported stop; release commits once. Source confirmation stays separate. */
export function EffortChoices({ data, disabled, select, tr, name }: {
    data: PickerData; disabled: boolean; select(action: PickerAction): void; tr: Translate; name: string
}) {
    const [preview, setPreview] = useState<number | null>(null)
    const confirmed = data.efforts.findIndex(choice => choice.value === data.effort)
    const index = Math.min(preview ?? Math.max(confirmed, 0), Math.max(data.efforts.length - 1, 0))
    const current = data.efforts[index]
    const commit = (index: number): void => {
        setPreview(null)
        const choice = data.efforts[index]
        if (!disabled && choice && choice.value !== data.effort) select({ kind: 'effort', value: choice.value })
    }
    return <fieldset className="hapi-picker-effort">
        <legend id={`${name}-label`}>{tr('Reasoning effort', '推理强度')}</legend>
        <div className="hapi-picker-effort-value">{current ? effortLabel(current, tr) : data.effort}
            {index === confirmed && <Glyph kind="check"/>}</div>
        <input className="hapi-picker-effort-slider" type="range" name={name} min={0} max={Math.max(data.efforts.length - 1, 0)} step={1}
            value={index} disabled={disabled || data.efforts.length < 2} aria-labelledby={`${name}-label`}
            aria-valuetext={current ? effortLabel(current, tr) : undefined}
            onChange={event => setPreview(Number(event.currentTarget.value))}
            onPointerUp={event => commit(Number(event.currentTarget.value))} onPointerCancel={() => setPreview(null)}
            onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commit(Number(event.currentTarget.value)) }}
            onBlur={event => { if (preview !== null) commit(Number(event.currentTarget.value)) }}/>
        <div className="hapi-picker-effort-stops">{data.efforts.map((choice, stop) => <button type="button" key={choice.value ?? 'default'}
            disabled={disabled} aria-pressed={choice.value === data.effort} onClick={() => commit(stop)}>{effortLabel(choice, tr)}</button>)}</div>
        {!data.efforts.some(choice => choice.value === data.effort) && <p className="hapi-picker-note">{tr('Current source value', '源会话当前值')}: {data.effort ?? tr('Not reported', '未报告')}</p>}
    </fieldset>
}

export function pendingTarget(pending: PickerPending, data: PickerData | null, tr: Translate): string {
    const { change } = pending
    if (change.kind === 'model') return `${tr('Model', '模型')}: ${modelLabel(change.value, data?.models ?? []) ?? tr('Default', '默认')}`
    if (change.kind === 'effort') return `${tr('Reasoning effort', '推理强度')}: ${effortLabel({ value: change.value, label: change.value ?? 'Default' }, tr)}`
    if (change.kind === 'permission') return `${tr('Permissions', '权限')}: ${permissionLabel(change.value, tr)}`
    if (change.kind === 'serviceTier') return `${tr('Service tier', '服务档位')}: ${change.value === 'fast' ? 'Fast' : 'Standard'}`
    if (change.kind === 'control') return tr('Control: remote', '控制权：远程')
    if (change.kind === 'collaboration') return `${tr('Collaboration', '协作模式')}: ${change.value}`
    return `Copilot: ${change.value}`
}

export function PendingNote({ pending, data, tr }: { pending: PickerPending; data: PickerData | null; tr: Translate }) {
    return <p className="hapi-picker-pending" role="status" data-picker-pending-target={pending.change.kind}>
        <strong>{tr('Confirming', '正在确认')}</strong><span>{pendingTarget(pending, data, tr)}</span>
    </p>
}
