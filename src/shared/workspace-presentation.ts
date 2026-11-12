/** Presentation changes visibility, never the saved windows, splits or drafts. */
export const COMPACT_WORKSPACE_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 640px)'

export function workspaceFocusesSinglePane(compact: boolean, zoomed: boolean | undefined): boolean {
    return compact || Boolean(zoomed)
}

export interface WorkspaceViewportPolicy {
    getSnapshot(): boolean
    subscribe(listener: () => void): () => void
}

/** Read the layout media result before acquiring any restored Session. */
export function workspaceViewportPolicy(media: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>): WorkspaceViewportPolicy {
    return {
        getSnapshot: () => media.matches,
        subscribe(listener) {
            const changed = (): void => { listener() }
            media.addEventListener('change', changed)
            return () => { media.removeEventListener('change', changed) }
        },
    }
}
