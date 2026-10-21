import { randomId } from '../random-id.ts'
// SPDX-License-Identifier: AGPL-3.0-only
// Browser port of Haven toolbar configuration. See HAVEN.md.
import { useEffect, useRef, useState } from 'react'
import { TerminalDialog, Button } from './dialog.tsx'
import type { TerminalTranslate } from './locales.ts'
import { BASE_KEY_OPTIONS, decodeCombo, encodeCombo, type Modifiers } from './keyCombo.ts'
import type { TouchBarKey } from './types.ts'
import { DEFAULT_TOUCHBAR_KEYS } from './defaultKeys.ts'
import { DEFAULT_TOOLBAR_SETTINGS, toolbarRows, placeKey, type ToolbarSettings } from './havenLayout.ts'
import { BUILTIN_KEYS, MACRO_PRESETS, parseSendSequence, displaySequence, importLayout, exportLayout } from './keyCatalog.ts'
import { KeyFace } from './TouchBar.tsx'
import styles from './styles.ts'

type KeyKind = 'snippets' | 'raw' | 'key' | 'ctrl' | 'shift' | 'alt' | 'copy' | 'paste' | 'keyboard'
const EMPTY_MODIFIERS: Modifiers = { ctrl: false, shift: false, alt: false, meta: false }
const FIELD_CLASS = 'h-10 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-base'

export function KeyEditor(props: { t: TerminalTranslate; error?: string | null; open: boolean; keys: TouchBarKey[]; onChange: (keys: TouchBarKey[]) => void; onClose: () => void; settings: ToolbarSettings; onSettingsChange: (settings: ToolbarSettings) => void }) {
    const { t } = props
    const [selectedId, setSelectedId] = useState(props.keys[0]?.id ?? '')
    const [label, setLabel] = useState('')
    const [kind, setKind] = useState<KeyKind>('key')
    const [baseKey, setBaseKey] = useState('Escape')
    const [modifiers, setModifiers] = useState<Modifiers>(EMPTY_MODIFIERS)
    const [rawSend, setRawSend] = useState('')
    const [jsonOpen, setJsonOpen] = useState(false)
    const [jsonText, setJsonText] = useState('')
    const [jsonError, setJsonError] = useState('')
    const suppressDragClickRef = useRef(false)
    const dragRef = useRef<{ id: string; target?: string | undefined; row: 1 | 2; x: number; y: number; moved: boolean } | null>(null)
    const selected = props.keys.find(key => key.id === selectedId)
    useEffect(() => {
        if (!selected) { setLabel(''); setKind('raw'); setRawSend(''); setModifiers(EMPTY_MODIFIERS); return }
        setLabel(selected.label)
        setRawSend(displaySequence(selected.send))
        setKind(selected.action ?? (selected.modifier === 'meta' ? 'key' : selected.modifier) ?? 'key')
        const combo = decodeCombo(selected.send)
        if (!combo && selected.send && !selected.action && !selected.modifier) setKind('raw')
        setBaseKey(combo?.baseKey ?? 'Escape')
        setModifiers(combo?.modifiers ?? EMPTY_MODIFIERS)
    }, [selected])

    const configuredKey = (): Partial<TouchBarKey> => ({
        label: label.trim(),
        send: kind === 'raw' ? (rawSend === 'PASTE' ? '' : parseSendSequence(rawSend)) : kind === 'key' ? encodeCombo(baseKey, modifiers) : '',
        ...(kind === 'raw' && rawSend === 'PASTE' ? { action: 'paste' as const } : kind === 'snippets' || kind === 'copy' || kind === 'paste' || kind === 'keyboard' ? { action: kind } : {}),
        ...(kind === 'ctrl' || kind === 'shift' || kind === 'alt' ? { modifier: kind } : {}),
    })
    const rowKeys = toolbarRows(props.keys)
    const destination = selected?.row ?? 1
    const updateSettings = (next: Partial<ToolbarSettings>) => props.onSettingsChange({ ...props.settings, ...next })

    return (
        <TerminalDialog open={props.open} onClose={props.onClose} title={t('terminal.keys.edit')} description={t('terminal.keys.editDescription')} closeLabel={t('button.close')}>
                {props.error && <p role="alert">{props.error}</p>}
                <div className="mt-4 space-y-3">
                    <p className="text-xs text-[var(--app-hint)]">{t('terminal.keys.dragHint')}</p>
                    <div className="space-y-1" data-testid="keyboard-layout-preview">
                        {rowKeys.map((row, rowIndex) => <div key={rowIndex} className="flex min-h-9 flex-wrap gap-1" data-edit-row={rowIndex + 1}>
                            {row.map(key => <button key={key.id} type="button" data-edit-key={key.id}
                                className={`${styles.keyBtn} ${key.id === selectedId ? styles.active : ''}`} style={{ touchAction: 'none' }} aria-label={`${t('terminal.keys.choose')}: ${key.label}`}
                                onClick={event => {
                                    if (event.detail > 0 && suppressDragClickRef.current) { suppressDragClickRef.current = false; return }
                                    setSelectedId(key.id)
                                }}
                                onPointerDown={event => {
                                    if (event.button !== 0) return
                                    event.preventDefault()
                                    event.currentTarget.setPointerCapture(event.pointerId)
                                    suppressDragClickRef.current = false
                                    dragRef.current = { id: key.id, row: (rowIndex + 1) as 1 | 2, x: event.clientX, y: event.clientY, moved: false }
                                }}
                                onPointerMove={event => {
                                    const drag = dragRef.current
                                    if (!drag) return
                                    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return
                                    drag.moved = true
                                    const target = document.elementFromPoint(event.clientX, event.clientY)
                                    const targetRow = target?.closest('[data-edit-row]')?.getAttribute('data-edit-row')
                                    if (targetRow) {
                                        drag.row = Number(targetRow) as 1 | 2
                                        drag.target = target?.closest('[data-edit-key]')?.getAttribute('data-edit-key') ?? undefined
                                    }
                                }}
                                onPointerUp={() => {
                                    const drag = dragRef.current
                                    if (drag?.moved) props.onChange(placeKey(props.keys, drag.id, drag.row, drag.target))
                                    else setSelectedId(key.id)
                                    suppressDragClickRef.current = Boolean(drag?.moved)
                                    dragRef.current = null
                                }}
                                onPointerCancel={() => { dragRef.current = null }}
                            ><KeyFace keyInfo={key} /></button>)}
                        </div>)}
                    </div>
                    <div className="grid grid-cols-2 gap-3 border-y border-[var(--app-border)] py-3">
                        <label className="text-sm">{t('terminal.keys.navMode')}<select aria-label={t('terminal.keys.navMode')} className={FIELD_CLASS} value={props.settings.navMode} onChange={event => updateSettings({ navMode: event.target.value as 'aligned' | 'inline' })}><option value="aligned">{t('terminal.keys.aligned')}</option><option value="inline">{t('terminal.keys.inline')}</option></select></label>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={props.settings.uniformGrid} onChange={event => updateSettings({ uniformGrid: event.target.checked })}/>{t('terminal.keys.uniform')}</label>
                        <label className="text-sm">{t('terminal.keys.minWidth')}: {props.settings.minKeyWidth}<input aria-label={t('terminal.keys.minWidth')} className="block w-full" type="range" min="0" max="64" value={props.settings.minKeyWidth} onChange={event => updateSettings({ minKeyWidth: Number(event.target.value) })}/></label>
                    </div>
                    <details><summary className="cursor-pointer text-sm">{t('terminal.keys.builtins')}</summary><div className="mt-2 grid grid-cols-2 gap-2">
                        {BUILTIN_KEYS.map(builtin => {
                            const current = props.keys.find(key => key.id === builtin.id)
                            return <label key={builtin.id} className="flex items-center justify-between gap-1 text-xs">{builtin.label}<select aria-label={`${builtin.label}: ${t('terminal.keys.row')}`} className="h-8 rounded border border-[var(--app-border)] bg-[var(--app-bg)]" value={current?.row ?? 0} onChange={event => {
                                const keys = current ? props.keys : [...props.keys, { ...builtin, row: 0 as const }]
                                props.onChange(placeKey(keys, builtin.id, Number(event.target.value) as 0 | 1 | 2))
                            }}><option value="0">{t('terminal.keys.off')}</option><option value="1">{t('terminal.keys.row1')}</option><option value="2">{t('terminal.keys.row2')}</option></select></label>
                        })}
                    </div></details>

                    <label className="block text-sm">{t('terminal.keys.choose')}
                        <select aria-label={t('terminal.keys.choose')} className={FIELD_CLASS} value={selectedId} onChange={event => setSelectedId(event.target.value)}>
                            <option value="">{t('terminal.keys.newCustom')}</option>
                            {props.keys.map(key => <option key={key.id} value={key.id}>{key.label}</option>)}
                        </select>
                    </label>
                    <label className="block text-sm">{t('terminal.keys.label')}
                        <input className={FIELD_CLASS} value={label} onChange={event => setLabel(event.target.value)} maxLength={20} />
                    </label>
                    <label className="block text-sm">{t('terminal.keys.action')}
                        <select aria-label={t('terminal.keys.action')} className={FIELD_CLASS} value={kind} onChange={event => setKind(event.target.value as KeyKind)}>
                            <option value="raw">{t('terminal.keys.raw')}</option>
                            <option value="key">{t('terminal.keys.sendKey')}</option>
                            <option value="ctrl">Ctrl</option><option value="shift">Shift</option><option value="alt">Alt</option>
                            <option value="copy">{t('button.copy')}</option><option value="paste">{t('button.paste')}</option>
                            <option value="snippets">{t('terminal.keys.snippets')}</option>
                            <option value="keyboard">{t('terminal.keys.keyboard')}</option>
                        </select>
                    </label>
                    <label className="block text-sm">{t('terminal.keys.row')}<select aria-label={t('terminal.keys.row')} className={FIELD_CLASS} value={destination} disabled={!selected} onChange={event => props.onChange(placeKey(props.keys, selectedId, Number(event.target.value) as 0 | 1 | 2))}><option value="0">{t('terminal.keys.off')}</option><option value="1">{t('terminal.keys.row1')}</option><option value="2">{t('terminal.keys.row2')}</option></select></label>
                    <div className="flex gap-2"><Button variant="secondary" disabled={!selected || !destination} onClick={() => {
                        const row = rowKeys[destination - 1] ?? []
                        const index = row.findIndex(key => key.id === selectedId)
                        if (index > 0) props.onChange(placeKey(props.keys, selectedId, destination as 1 | 2, row[index - 1]!.id))
                    }}>{t('terminal.keys.moveLeft')}</Button><Button variant="secondary" disabled={!selected || !destination} onClick={() => {
                        const row = rowKeys[destination - 1] ?? []
                        const index = row.findIndex(key => key.id === selectedId)
                        if (index >= 0 && index < row.length - 1) props.onChange(placeKey(props.keys, selectedId, destination as 1 | 2, row[index + 2]?.id))
                    }}>{t('terminal.keys.moveRight')}</Button></div>
                    {kind === 'raw' ? <>
                        <label className="block text-sm">{t('terminal.keys.presets')}<select aria-label={t('terminal.keys.presets')} className={FIELD_CLASS} value="" onChange={event => {
                            const preset = MACRO_PRESETS[Number(event.target.value)]
                            if (preset) { setLabel(preset.label); setRawSend(displaySequence(preset.send)) }
                        }}><option value="">{t('terminal.keys.choosePreset')}</option>{MACRO_PRESETS.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}</select></label>
                        <label className="block text-sm">{t('terminal.keys.sequence')}<textarea aria-label={t('terminal.keys.sequence')} className={`${FIELD_CLASS} h-20 font-mono`} value={rawSend} onChange={event => setRawSend(event.target.value)}/></label><p className="text-xs text-[var(--app-hint)]">{t('terminal.keys.escapeHint')}</p>
                    </> : null}
                    {kind === 'key' ? <>
                        <label className="block text-sm">{t('terminal.keys.baseKey')}
                            <select aria-label={t('terminal.keys.baseKey')} className={FIELD_CLASS} value={baseKey} onChange={event => setBaseKey(event.target.value)}>
                                {BASE_KEY_OPTIONS.map(key => <option key={key.id} value={key.id}>{key.label}</option>)}
                            </select>
                        </label>
                        <div className="flex gap-5">
                            {(['ctrl', 'shift', 'alt'] as const).map(modifier => <label key={modifier} className="flex items-center gap-2 text-sm">
                                <input type="checkbox" checked={modifiers[modifier]} onChange={event => setModifiers(value => ({ ...value, [modifier]: event.target.checked }))} />
                                {modifier === 'ctrl' ? 'Ctrl' : modifier === 'shift' ? 'Shift' : 'Alt'}
                            </label>)}
                        </div>
                    </> : null}
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={!selected || !label.trim()} onClick={() => props.onChange(props.keys.map(key => { if (key.id !== selectedId) return key; const { action: oldAction, modifier: oldModifier, ...position } = key; return { ...position, ...configuredKey() } }))}>{t('button.save')}</Button>
                        <Button variant="secondary" disabled={!label.trim()} onClick={() => {
                            const key: TouchBarKey = {
                                id: `custom-${randomId()}`, label: label.trim(), send: '',
                                row: 2, col: rowKeys[1]!.length + 1,
                                ...configuredKey(),
                            }
                            props.onChange([...props.keys, key])
                            setSelectedId(key.id)
                        }}>{t('terminal.keys.add')}</Button>
                        <Button variant="secondary" disabled={!selected} onClick={() => {
                            const keys = props.keys.filter(key => key.id !== selectedId)
                            props.onChange(keys)
                            setSelectedId(keys[0]?.id ?? '')
                        }}>{t('terminal.keys.remove')}</Button>
                        <Button variant="secondary" onClick={() => {
                            props.onChange([...DEFAULT_TOUCHBAR_KEYS, ...props.keys.filter(key => key.id.startsWith('custom-') || (key.row === 0 && !DEFAULT_TOUCHBAR_KEYS.some(defaultKey => defaultKey.id === key.id))).map(key => ({ ...key, row: 0 as const }))])
                            props.onSettingsChange(DEFAULT_TOOLBAR_SETTINGS)
                            setSelectedId(DEFAULT_TOUCHBAR_KEYS[0]!.id)
                        }}>{t('terminal.keys.reset')}</Button>
                    </div>
                    <Button variant="secondary" onClick={() => { setJsonText(exportLayout(props.keys)); setJsonOpen(value => !value); setJsonError('') }}>{t('terminal.keys.json')}</Button>
                    {jsonOpen ? <div className="space-y-2"><textarea aria-label={t('terminal.keys.json')} className={`${FIELD_CLASS} h-48 font-mono text-xs`} value={jsonText} onChange={event => setJsonText(event.target.value)}/><Button onClick={() => {
                        try { props.onChange([...importLayout(jsonText), ...props.keys.filter(key => key.row === 0)]); setJsonError('') } catch (error) { setJsonError(error instanceof Error ? error.message : String(error)) }
                    }}>{t('terminal.keys.applyJson')}</Button>{jsonError ? <p role="alert" className="text-sm text-[var(--app-badge-error-text)]">{jsonError}</p> : null}</div> : null}
                </div>
        </TerminalDialog>
    )
}
