/**
 * Adapted from HAPI 0f8ef697 sessionListViewBookmark.ts.
 * Copyright HAPI contributors. AGPL-3.0-only; see NOTICE.
 */
export type SidebarView = 'recent' | 'folders'
export type SidebarBookmark = { scrollTop: number; anchors: { id: string; rootId?: string; top: number }[] }
export const SIDEBAR_ANCHORS = '[data-session-scroll-anchor], [data-session-view-anchor]'
export const sidebarAnchorId = (element: HTMLElement): string | undefined => element.dataset.sessionViewAnchor || element.dataset.sessionScrollAnchor
export const sidebarAnchorHidden = (element: HTMLElement): boolean => Boolean(element.closest('[hidden], [aria-hidden="true"]'))

/** Only eight semantic survivors are retained, not a snapshot of the whole tree. */
export function captureSidebarBookmark(content: HTMLElement, container: HTMLElement): SidebarBookmark {
    const bookmark: SidebarBookmark = { scrollTop: container.scrollTop, anchors: [] }
    if (container.scrollTop <= 0) return bookmark
    const viewport = container.getBoundingClientRect()
    for (const element of content.querySelectorAll<HTMLElement>(SIDEBAR_ANCHORS)) {
        const id = sidebarAnchorId(element)
        if (!id || sidebarAnchorHidden(element)) continue
        const rect = element.getBoundingClientRect()
        if (rect.top >= viewport.bottom) break
        const row = element.hasAttribute('data-session-view-anchor')
        if (rect.height > 0 && rect.bottom > viewport.top && (row || rect.top >= viewport.top)) {
            const rootId = element.closest<HTMLElement>('[data-recent-root]')?.dataset.recentRoot
            bookmark.anchors.push({ id, ...(rootId ? { rootId } : {}), top: rect.top - viewport.top })
            if (bookmark.anchors.length === 8) break
        }
    }
    return bookmark
}

export function resolveSidebarBookmark(content: HTMLElement, container: HTMLElement, bookmark: SidebarBookmark): number {
    if (bookmark.scrollTop <= 0) return 0
    const elements = new Map(Array.from(content.querySelectorAll<HTMLElement>(SIDEBAR_ANCHORS)).map(element => [sidebarAnchorId(element), element]))
    for (const anchor of bookmark.anchors) {
        const element = elements.get(anchor.id)
        if (!element || sidebarAnchorHidden(element)) continue
        const rect = element.getBoundingClientRect()
        if (rect.height > 0) {
            // At a mobile/desktop breakpoint, retain at least a slice of the
            // same row even when that row is now shorter than its old offset.
            const top = Math.max(anchor.top, 1 - rect.height)
            return container.scrollTop + rect.top - container.getBoundingClientRect().top - top
        }
    }
    return bookmark.anchors.length ? 0 : bookmark.scrollTop
}

/** The original two views share one filter scope; changing filters clears both. */
export class SidebarBookmarks {
    private scope: string | undefined
    private readonly values = new Map<SidebarView, SidebarBookmark>()
    useScope(scope: string): boolean {
        if (this.scope === scope) return false
        this.scope = scope; this.values.clear(); return true
    }
    get(view: SidebarView): SidebarBookmark | undefined { return this.values.get(view) }
    save(view: SidebarView, bookmark: SidebarBookmark): void { this.values.set(view, bookmark) }
    clear(): void { this.values.clear() }
}
