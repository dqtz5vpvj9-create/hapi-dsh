import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SidebarPress, sidebarMenuPosition, type MenuPoint } from '../workspace/sidebar-actions.ts'

type RowHandlers = Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onPointerLeave' | 'onContextMenu' | 'onKeyDown' | 'onClickCapture' | 'onDragStartCapture'>

/** Own row chrome only. The retained details element also informs the existing
 * virtualizer that this row owns an open menu outside its scroll container. */
export function SidebarActionSurface({ rowId, title, label, icon, children, actions }: {
    rowId: string; title: string; label: string; icon: ReactNode
    children(handlers: RowHandlers): ReactNode; actions: ReactNode
}) {
    const id = `hapi-session-menu-${useId()}`
    const details = useRef<HTMLDetailsElement>(null), menu = useRef<HTMLDivElement>(null), trigger = useRef<HTMLElement | null>(null)
    const [anchor, setAnchor] = useState<MenuPoint | null>(null), [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
    const latestOpen = useRef<(point: MenuPoint) => void>(() => {})
    latestOpen.current = point => setAnchor(point)
    const press = useMemo(() => new SidebarPress(point => latestOpen.current(point)), [])
    const close = (restore = false): void => {
        setAnchor(null); press.cancel()
        if (restore && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
    }
    const closeRef = useRef(close); closeRef.current = close
    useEffect(() => () => press.dispose(), [press])
    useLayoutEffect(() => {
        if (!anchor || !menu.current) return
        const measure = (): void => {
            const node = menu.current
            if (!node) return
            const viewport = window.visualViewport
            setPosition(sidebarMenuPosition(anchor, { width: node.offsetWidth, height: node.offsetHeight }, {
                left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
                width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
            }))
        }
        measure()
        const resize = new ResizeObserver(measure); resize.observe(menu.current)
        window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true); window.visualViewport?.addEventListener('resize', measure); window.visualViewport?.addEventListener('scroll', measure)
        return () => { resize.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); window.visualViewport?.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('scroll', measure) }
    }, [anchor])
    useLayoutEffect(() => {
        // The first occurrence is hidden until its measured position commits.
        // A focus() during that hidden render is ignored by the browser.
        if (!anchor || position.visibility === 'hidden') return
        const first = menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])')
        first?.focus({ preventScroll: true })
    }, [Boolean(anchor), position.visibility])
    useEffect(() => {
        if (!anchor) return
        const outside = (event: PointerEvent): void => {
            press.nextGesture()
            if (!(event.target instanceof Node) || !menu.current?.contains(event.target) && !details.current?.contains(event.target)) closeRef.current()
        }
        // The menu is a portal: the compatibility click after a long touch can
        // land on it instead of the original row. Consume only that gesture;
        // a fresh physical pointerdown and keyboard activation remain native.
        const compatibilityClick = (event: MouseEvent): void => {
            if (!press.suppressClick(event.detail)) return
            event.preventDefault(); event.stopPropagation()
        }
        const visibility = (): void => { if (document.visibilityState === 'hidden') closeRef.current() }
        document.addEventListener('pointerdown', outside); document.addEventListener('click', compatibilityClick, true); document.addEventListener('visibilitychange', visibility)
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('click', compatibilityClick, true); document.removeEventListener('visibilitychange', visibility) }
    }, [Boolean(anchor)])
    const handlers: RowHandlers = {
        onPointerDown(event) { if (event.isPrimary && event.button === 0) { trigger.current = event.currentTarget; press.begin(event.pointerId, { x: event.clientX, y: event.clientY }, event.pointerType) } },
        onPointerMove(event) { press.move(event.pointerId, { x: event.clientX, y: event.clientY }) },
        onPointerUp(event) { press.end(event.pointerId) },
        onPointerCancel() { press.cancel() },
        onPointerLeave(event) { if (event.pointerType === 'mouse') press.cancel() },
        onDragStartCapture() { press.cancel() },
        onContextMenu(event) {
            event.preventDefault(); event.stopPropagation(); trigger.current = event.currentTarget
            const bounds = event.currentTarget.getBoundingClientRect()
            press.context(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: bounds.left, y: bounds.bottom })
        },
        onKeyDown(event) {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
            event.preventDefault(); event.stopPropagation(); trigger.current = event.currentTarget
            const bounds = event.currentTarget.getBoundingClientRect(); press.context({ x: bounds.left, y: bounds.bottom })
        },
        onClickCapture(event) { if (press.suppressClick(event.detail)) { event.preventDefault(); event.stopPropagation() } },
    }
    return <>
        {children(handlers)}
        <details id={id} ref={details} className="hapi-menu hapi-session-menu" open={anchor !== null} onToggle={event => { if (!event.currentTarget.open && anchor) close() }}>
            <summary aria-label={label} aria-haspopup="menu" aria-expanded={anchor !== null} aria-controls={`${id}-items`} title={label} onClick={event => {
                event.preventDefault(); trigger.current = event.currentTarget
                if (anchor) { close(); return }
                const rect = event.currentTarget.getBoundingClientRect(); setAnchor({ x: rect.left, y: rect.bottom })
            }}>{icon}</summary>
        </details>
        {anchor && createPortal(<div ref={menu} id={`${id}-items`} role="menu" aria-label={`${title} · ${label}`} className="hapi-menu-content hapi-sidebar-context" style={position}
            data-hapi-menu-owner={id} data-hapi-menu-session={rowId}
            onClick={event => { const target = event.target; if (target instanceof Element && target.closest('button:not(:disabled)')) close(true) }}
            onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
                if (event.key === 'Tab') { close(); return }
                const elements = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])') ?? [])]
                const index = elements.indexOf(document.activeElement as HTMLElement)
                const next = event.key === 'ArrowDown' ? (index + 1) % elements.length : event.key === 'ArrowUp' ? (index - 1 + elements.length) % elements.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? elements.length - 1 : -1
                if (next >= 0 && elements[next]) { event.preventDefault(); event.stopPropagation(); elements[next].focus() }
            }}>
            <div className="hapi-session-menu-heading" role="presentation">{title}</div>{actions}
        </div>, document.body)}
    </>
}
