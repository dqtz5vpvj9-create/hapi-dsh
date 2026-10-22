import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceTranslate } from './locales.ts'
import { openDiagnostics, translate } from './diagnostics/index.ts'

/** Source notices belong to the originating pane's title bar, outside the input. */
export function PaneSourceStatus({ target, error, children, t }: {
    target: HTMLElement | null; error: boolean; children: ReactNode; t: WorkspaceTranslate
}) {
    const details = useRef<HTMLDetailsElement>(null)
    useEffect(() => {
        if (!target) return
        const outside = (event: PointerEvent): void => {
            if (details.current?.open && event.target instanceof Node && !details.current.contains(event.target)) details.current.open = false
        }
        const escape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' || event.isComposing || !details.current?.open) return
            event.stopPropagation(); details.current.open = false; details.current.querySelector('summary')?.focus()
        }
        target.ownerDocument.addEventListener('pointerdown', outside)
        target.ownerDocument.addEventListener('keydown', escape)
        return () => { target.ownerDocument.removeEventListener('pointerdown', outside); target.ownerDocument.removeEventListener('keydown', escape) }
    }, [target])
    if (!target) return null
    const label = translate(t, 'Source status and errors', '会话状态与错误')
    return createPortal(<details ref={details} className="hapi-menu hapi-pane-source-status" data-hapi-status-error={error}>
        <summary title={label} aria-label={label}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <circle cx="12" cy="12" r="9"/><path d="M12 6v8m0 3v1"/>
            </svg>
        </summary>
        <div className="hapi-menu-content hapi-pane-source-details">
            {children}
            <button type="button" onClick={openDiagnostics}>{translate(t, 'Open diagnostics', '打开诊断')}</button>
        </div>
    </details>, target)
}
