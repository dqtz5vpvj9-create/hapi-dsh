// SPDX-License-Identifier: AGPL-3.0-only
// Haven layout and keycaps; TermBeam pointer repeat. See HAVEN.md and UPSTREAM.md.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { TerminalDialog } from './dialog.tsx'
import type { TerminalTranslate } from './locales.ts'
import type { TerminalModifier } from './types.ts'
import { alignedColumns, toolbarRows, DEFAULT_TOOLBAR_SETTINGS, type ToolbarSettings } from './havenLayout.ts'
import type { TouchBarKey } from './types.ts'
import styles from './styles.ts'

const SWIPE_THRESHOLD = 10

export function KeyFace({ keyInfo }: { keyInfo: TouchBarKey }) {
    const paths = keyInfo.action === 'keyboard' ? ['M3 5h18v14H3z', 'M6 9h1m3 0h1m3 0h1m3 0h1M6 12h1m3 0h1m3 0h1m3 0h1M7 16h10']
        : keyInfo.action === 'copy' ? ['M8 8h12v13H8z', 'M16 8V3H3v13h5']
        : keyInfo.send === '\x1b[H' ? ['M5 5v14', 'm18 5-7 7 7 7']
        : keyInfo.send === '\x1b[F' ? ['M19 5v14', 'm6 5 7 7-7 7'] : null
    if (keyInfo.action === 'snippets') return <span aria-hidden="true">✂︎</span>
    return paths ? <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths.map(path => <path key={path} d={path} />)}</svg> : <span className={keyInfo.label.length === 1 || ['enter', 'up', 'down', 'left', 'right'].includes(keyInfo.id) ? styles.glyph : undefined}>{keyInfo.label}</span>
}

export function TouchBar(props: {
    t: TerminalTranslate
    keys: TouchBarKey[]
    disabled: boolean
    readOnlyActionsAvailable?: boolean
    lockedModifiers?: Record<TerminalModifier, boolean>
    onLockModifier?: (modifier: TerminalModifier) => void
    modifiers: Record<TerminalModifier, boolean>
    onToggleModifier: (modifier: TerminalModifier) => void
    onPress: (data: string) => void
    resolveSequence: (data: string) => string
    onRepeat: (data: string) => void
    onResetModifiers: () => void
    onSnippets?: () => void
    onCopy: () => void
    onPaste: () => void
    onKeyboard: () => void
    onCommand?: () => void
    commandMode?: boolean
    onMoreKeys?: () => void
    onCustomize?: () => void
    settings?: ToolbarSettings
}) {
    const { t } = props
    const [collapsed, setCollapsed] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const menuAction = (action: () => void) => {
        setMenuOpen(false)
        action()
    }
    const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const pressRef = useRef<{ x: number; y: number; repeated: boolean; cancelled: boolean } | null>(null)
    const suppressClickRef = useRef(false)
    const settings = props.settings ?? DEFAULT_TOOLBAR_SETTINGS
    const rows = useMemo(() => toolbarRows(props.keys), [props.keys])
    const columns = useMemo(() => alignedColumns(props.keys), [props.keys])

    const clearRepeat = useCallback(() => {
        if (repeatTimerRef.current) clearTimeout(repeatTimerRef.current)
        if (repeatIntervalRef.current) clearInterval(repeatIntervalRef.current)
        repeatTimerRef.current = null
        repeatIntervalRef.current = null
    }, [])
    useEffect(() => clearRepeat, [clearRepeat])
    useEffect(() => {
        const stop = () => { if (pressRef.current) pressRef.current.cancelled = true; clearRepeat() }
        window.addEventListener('blur', stop)
        document.addEventListener('visibilitychange', stop)
        return () => { window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', stop) }
    }, [clearRepeat])
    useEffect(() => {
        if (props.disabled || collapsed) clearRepeat()
    }, [props.disabled, collapsed, clearRepeat])

    const keyDisabled = (key: TouchBarKey): boolean => props.disabled && !(props.readOnlyActionsAvailable && (key.action === 'copy' || key.action === 'keyboard'))
    const handlePress = (key: TouchBarKey) => {
        if (keyDisabled(key)) return
        if (key.action === 'snippets') props.onSnippets?.()
        else if (key.action === 'copy') props.onCopy()
        else if (key.action === 'paste') props.onPaste()
        else if (key.action === 'keyboard') props.onKeyboard()
        else if (key.modifier && key.modifier !== 'meta') props.onToggleModifier(key.modifier)
        else props.onPress(key.send)
    }

    const handlePointerDown = (key: TouchBarKey, event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || keyDisabled(key)) return
        event.preventDefault() // Keep focus on the terminal and its phone keyboard.
        clearRepeat()
        suppressClickRef.current = false
        pressRef.current = { x: event.clientX, y: event.clientY, repeated: false, cancelled: false }
        event.currentTarget.setPointerCapture(event.pointerId)
        if (key.modifier === 'ctrl' || key.modifier === 'alt') {
            const modifier = key.modifier
            repeatTimerRef.current = setTimeout(() => {
                if (pressRef.current) pressRef.current.repeated = true
                props.onLockModifier?.(modifier)
            }, 500)
            return
        }
        if (key.action === 'keyboard') {
            repeatTimerRef.current = setTimeout(() => {
                if (pressRef.current) pressRef.current.repeated = true
                setMenuOpen(true)
            }, 500)
            return
        }
        if (!key.send || key.action || key.modifier) return
        const sequence = props.resolveSequence(key.send)
        repeatTimerRef.current = setTimeout(() => {
            if (!pressRef.current) return
            pressRef.current.repeated = true
            props.onRepeat(sequence)
            props.onResetModifiers()
            repeatIntervalRef.current = setInterval(() => props.onRepeat(sequence), 80)
        }, 400)
    }

    const label = (key: TouchBarKey) => key.action === 'copy'
        ? t('button.copy')
        : key.action === 'paste' ? t('button.paste') : key.label
    const accessibleLabel = (key: TouchBarKey) => key.action === 'snippets' ? t('terminal.keys.snippets') : key.action === 'keyboard'
        ? t('terminal.keys.keyboard')
        : key.modifier === 'ctrl' ? 'Control'
        : key.id === 'ctrl-c' ? 'Interrupt process'
        : key.id === 'enter' ? 'Enter'
        : key.id === 'left' ? 'Arrow left'
        : key.id === 'right' ? 'Arrow right'
        : key.id === 'up' ? 'Arrow up'
        : key.id === 'down' ? 'Arrow down'
        : key.id === 'esc' ? 'Escape'
        : label(key)

    const renderKey = (key: TouchBarKey | undefined) => {
        if (!key) return <span className={styles.placeholder} aria-hidden="true" />
        const active = key.modifier && key.modifier !== 'meta' && props.modifiers[key.modifier]
        const glyph = !key.action && !key.modifier && (key.label.length === 1 || ['enter', 'up', 'down', 'left', 'right'].includes(key.id))
        return <button
            key={key.id} type="button"
            className={`${styles.keyBtn} ${glyph ? styles.glyph : ''} ${active ? styles.active : ''} ${key.modifier && key.modifier !== 'meta' && props.lockedModifiers?.[key.modifier] ? styles.locked : ''}`}
            style={{ background: key.bg, color: key.color }}
            disabled={keyDisabled(key)} aria-label={accessibleLabel(key)} aria-pressed={key.modifier ? Boolean(active) : undefined}
            onPointerDown={event => handlePointerDown(key, event)}
            onPointerMove={event => {
                const press = pressRef.current
                if (press && (Math.abs(event.clientX - press.x) > SWIPE_THRESHOLD || Math.abs(event.clientY - press.y) > SWIPE_THRESHOLD)) {
                    press.cancelled = true
                    clearRepeat()
                }
            }}
            onPointerUp={() => {
                suppressClickRef.current = Boolean(pressRef.current?.repeated || pressRef.current?.cancelled)
                pressRef.current = null
                clearRepeat()
            }}
            onPointerCancel={() => { pressRef.current = null; clearRepeat() }}
            onLostPointerCapture={clearRepeat}
            onClick={event => {
                if (event.detail > 0 && suppressClickRef.current) {
                    suppressClickRef.current = false
                    return
                }
                handlePress(key)
            }}
        ><KeyFace keyInfo={key} /></button>
    }
    const options = <TerminalDialog open={menuOpen} onClose={() => setMenuOpen(false)} title={t('terminal.keys.options')} closeLabel={t('button.close')}>
        <div className={styles.menuActions}>
            <button type="button" disabled={props.disabled && !props.readOnlyActionsAvailable} onClick={() => menuAction(props.onCopy)}>{t('button.copy')}</button>
            <button type="button" onClick={() => menuAction(() => props.onSnippets?.())}>{t('terminal.keys.snippets')}</button>
            <button type="button" disabled={props.disabled} onClick={() => menuAction(props.onPaste)}>{t('button.paste')}</button>
            <button type="button" onClick={() => menuAction(() => props.onCommand?.())}>{t(props.commandMode ? 'terminal.inputMode.direct' : 'terminal.inputMode.command')}</button>
            <button type="button" onClick={() => menuAction(() => props.onMoreKeys?.())}>{t('terminal.keys.more')}</button>
            <button type="button" onClick={() => menuAction(() => props.onCustomize?.())}>{t('terminal.keys.edit')}</button>
            <button type="button" onClick={() => menuAction(() => { clearRepeat(); setCollapsed(true) })}>{t('terminal.keys.collapse')}</button>
        </div>
    </TerminalDialog>
    return <div className={styles.touchBarWrapper} data-collapsed={collapsed} data-testid="termbeam-touchbar"
        style={{ '--key-min-width': `${settings.minKeyWidth}px` } as CSSProperties}
        onContextMenu={event => { event.preventDefault(); setMenuOpen(true) }}
        onKeyDown={event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault()
                setMenuOpen(true)
            }
        }}>
        {collapsed ? <button type="button" className={styles.collapseHandle} aria-label={t('terminal.keys.expand')} aria-expanded={false} onClick={() => setCollapsed(false)}>⌃</button> :
        <div className={styles.toolbar} data-testid="compact-terminal-quick-keys">
            <div className={styles.scroller}>
                {settings.uniformGrid ? <div className={styles.rows}>
                    {rows.map((row, index) => <div key={index} className={styles.gridRow} style={{ gridTemplateColumns: `repeat(${Math.max(1, ...rows.map(items => items.length))}, minmax(0, 1fr))` }}>{row.map(renderKey)}</div>)}
                </div> : settings.navMode === 'aligned' ? <div className={styles.columns}>
                    {columns.map((column, index) => <div key={index} className={styles.column}>{renderKey(column[0])}{renderKey(column[1])}</div>)}
                </div> : <div className={styles.rows}>{rows.map((row, index) => <div key={index} className={styles.inlineRow}>{row.map(renderKey)}</div>)}</div>}
            </div>
        </div>}
        {options}
    </div>
}
