import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceTranslate } from './locales.ts'
import { openDiagnostics, translate } from './diagnostics/index.ts'

/** Receipts remain queryable in the pane menu without a permanent warning icon. */
export function PaneSourceStatus({ target, children, t }: {
    target: HTMLElement | null; children: ReactNode; t: WorkspaceTranslate
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
    const label = translate(t, 'Source status and receipts', '会话状态与回执')
    return createPortal(<details ref={details} className="hapi-pane-source-status">
        <summary title={label} aria-label={label}>
            {label}
        </summary>
        <div className="hapi-pane-source-details">
            {children}
            <button type="button" onClick={openDiagnostics}>{translate(t, 'Open diagnostics', '打开诊断')}</button>
        </div>
    </details>, target)
}
