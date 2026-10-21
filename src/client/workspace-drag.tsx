import { useEffect, useState, type DragEvent } from 'react'
import type { WorkspaceController } from './controller.ts'
import type { PaneNode } from './model.ts'
import { acceptsWorkspaceDrag, readWorkspaceDrag, workspaceDockPosition, type DockPosition } from '../workspace/drag.ts'

/** Consume only our layout MIME types; file/plugin drags continue unchanged. */
export function useWorkspacePaneDrop(controller: WorkspaceController, pane: PaneNode, hidden: boolean) {
    const [position, setPosition] = useState<DockPosition | null>(null)
    useEffect(() => {
        const clear = (): void => setPosition(null)
        document.addEventListener('dragend', clear); document.addEventListener('drop', clear)
        return () => { document.removeEventListener('dragend', clear); document.removeEventListener('drop', clear) }
    }, [])
    useEffect(() => { if (hidden) setPosition(null) }, [hidden])
    const locate = (event: DragEvent<HTMLElement>): DockPosition | null => {
        const rectangle = event.currentTarget.getBoundingClientRect()
        return workspaceDockPosition(event.clientX - rectangle.left, event.clientY - rectangle.top, rectangle.width, rectangle.height, pane.resource.kind === 'empty')
    }
    return {
        position,
        handlers: {
            onDragOverCapture(event: DragEvent<HTMLElement>) {
                if (hidden || !acceptsWorkspaceDrag(event.dataTransfer)) return
                const next = locate(event); setPosition(next)
                if (next) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-hapi-dsh-pane') ? 'move' : 'copy' }
            },
            onDragLeave(event: DragEvent<HTMLElement>) {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPosition(null)
            },
            onDropCapture(event: DragEvent<HTMLElement>) {
                setPosition(null)
                if (hidden || !acceptsWorkspaceDrag(event.dataTransfer)) return
                event.preventDefault(); event.stopPropagation()
                const payload = readWorkspaceDrag(event.dataTransfer), next = locate(event)
                if (!payload || !next) return
                try {
                    if (payload.kind === 'pane') controller.store.dockPane(payload.paneId, pane.id, next)
                    else controller.dockSession(payload.sessionId, pane.id, next)
                } catch (error) { controller.report(error) }
            },
        },
    }
}

/** A window tab accepts an intentional drop without closing either view. */
export function dropOnWorkspaceWindow(controller: WorkspaceController, windowId: string, event: DragEvent<HTMLElement>): void {
    if (!acceptsWorkspaceDrag(event.dataTransfer)) return
    event.preventDefault(); event.stopPropagation()
    const payload = readWorkspaceDrag(event.dataTransfer)
    if (!payload) return
    try {
        if (payload.kind === 'pane') controller.store.movePane(payload.paneId, windowId)
        else { controller.store.selectWindow(windowId); const pane = controller.store.focusedPane(); controller.dockSession(payload.sessionId, pane.id, pane.resource.kind === 'empty' ? 'center' : 'right') }
    } catch (error) { controller.report(error) }
}
