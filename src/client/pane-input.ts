/** Document-level file intake is scoped to the pane owning the actual gesture. */
const intake = new Set(['dragenter', 'dragover', 'dragleave', 'drop', 'paste'])
type Target = { contains(node: Node | null): boolean }

export function createPaneInputRouter(options: {
    surface: EventTarget & Target
    visible(): boolean
    activeElement(): Element | null
    resetDrag(): void
    focus?(): void
}): { accepts(event: Event): boolean; reset(): void } {
    let dragging = false
    const reset = (): void => { if (dragging) { dragging = false; options.resetDrag() } }
    return {
        reset,
        accepts(event) {
            if (!intake.has(event.type)) return true
            const path = event.composedPath()
            const target = event.target
            const inPane = path.includes(options.surface)
                || (typeof Node !== 'undefined' && target instanceof Node && options.surface.contains(target))
                || (event.type === 'paste' && (target === null || typeof Document !== 'undefined' && target instanceof Document) && options.surface.contains(options.activeElement()))
            const accepted = options.visible() && inPane
            if (!accepted) { if (event.type !== 'paste') reset(); return false }
            if (event.type === 'dragenter' || event.type === 'dragover') dragging = true
            if (event.type === 'drop') { options.focus?.(); dragging = false }
            return true
        },
    }
}
