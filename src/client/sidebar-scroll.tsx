/**
 * Adapted from HAPI 0f8ef697 SessionListScrollAnchor.tsx.
 * Copyright HAPI contributors. AGPL-3.0-only; see NOTICE.
 * This owns our sidebar scroll only, never an official Conversation scroller.
 */
import { Component, createContext, createRef, type ReactNode } from 'react'
import { captureSidebarBookmark, resolveSidebarBookmark, SIDEBAR_ANCHORS, sidebarAnchorHidden, type SidebarBookmark, type SidebarBookmarks, type SidebarView } from '../workspace/sidebar-bookmarks.ts'

type Props = { children: ReactNode; view: SidebarView; scope: string; bookmarks: SidebarBookmarks; hasSessions: boolean; sessions: readonly { id: string }[]; onScrollRestored?: (offset: number) => void }
type Snapshot = { kind: 'view'; bookmark?: SidebarBookmark } | { kind: 'content'; scrollTop: number; anchors: { element: HTMLElement; top: number }[]; bookmark: SidebarBookmark }
export const SidebarViewRestoration = createContext<{ bookmark: SidebarBookmark; onLayout: (stable: boolean) => void } | null>(null)

/** The sole scroll writer. Virtual rows only observe its actual DOM landing. */
export class SidebarScrollAnchor extends Component<Props, object, Snapshot | null> {
    private readonly contentRef = createRef<HTMLDivElement>()
    private committedView = this.props.view
    private committedSessions = this.props.sessions
    private bookmarkScope = this.props.scope
    private pending: { bookmark: SidebarBookmark; stable: boolean } | undefined
    private frame: number | undefined
    private stopInput: (() => void) | undefined
    private resize: ResizeObserver | undefined

    private cancel = (rerender = true): void => {
        if (this.frame !== undefined) cancelAnimationFrame(this.frame)
        this.frame = undefined
        this.stopInput?.(); this.stopInput = undefined
        this.resize?.disconnect(); this.resize = undefined
        const pending = this.pending !== undefined
        this.pending = undefined
        if (pending && rerender) this.forceUpdate()
    }
    private restore = (): void => {
        const content = this.contentRef.current, container = content?.parentElement, pending = this.pending
        if (!content || !container || !pending?.stable || container.getBoundingClientRect().height <= 0) return
        const before = container.scrollTop
        const target = resolveSidebarBookmark(content, container, pending.bookmark)
        if (Math.abs(target - before) > .5) container.scrollTop = target
        this.props.onScrollRestored?.(container.scrollTop)
        if (Math.abs(container.scrollTop - before) <= .5) { this.cancel(); return }
        if (this.frame !== undefined) cancelAnimationFrame(this.frame)
        this.frame = requestAnimationFrame(() => { this.frame = undefined; if (this.pending === pending) this.restore() })
    }
    private onLayout = (stable: boolean): void => {
        if (!this.pending) return
        this.pending.stable = stable
        if (stable) this.restore()
    }
    private start = (bookmark: SidebarBookmark, stable: boolean): void => {
        this.cancel(false); this.pending = { bookmark, stable }
        const container = this.contentRef.current?.parentElement
        if (!container) return
        const cancel = (): void => this.cancel()
        const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
        for (const event of events) container.addEventListener(event, cancel, { capture: true, passive: true })
        this.stopInput = () => { for (const event of events) container.removeEventListener(event, cancel, true) }
        const ResizeObserverClass = container.ownerDocument.defaultView?.ResizeObserver
        if (ResizeObserverClass) {
            const pending = this.pending
            this.resize = new ResizeObserverClass(() => {
                if (this.pending !== pending) return
                if (!pending.stable && container.getBoundingClientRect().height > 0) this.forceUpdate()
                else this.restore()
            })
            this.resize.observe(container)
        }
    }
    componentDidMount(): void {
        this.props.bookmarks.useScope(this.props.scope)
        const bookmark = this.props.bookmarks.get(this.props.view)
        if (bookmark) { this.start(bookmark, this.props.view !== 'recent'); this.forceUpdate(); if (this.props.view !== 'recent') this.restore() }
    }
    componentWillUnmount(): void {
        const content = this.contentRef.current, container = content?.parentElement
        if (content && container && this.props.hasSessions && container.getBoundingClientRect().height > 0) {
            this.props.bookmarks.save(this.props.view, this.pending?.bookmark ?? captureSidebarBookmark(content, container))
        }
        this.cancel(false)
    }
    getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
        const content = this.contentRef.current, container = content?.parentElement
        const changedScope = this.props.bookmarks.useScope(this.props.scope)
        if (changedScope || !this.props.hasSessions) {
            if (!this.props.hasSessions) this.props.bookmarks.clear()
            this.bookmarkScope = this.props.scope
            this.cancel(false)
        }
        if (previous.view !== this.props.view) {
            this.cancel(false)
            if (!changedScope && previous.hasSessions && this.props.hasSessions && content && container) this.props.bookmarks.save(previous.view, captureSidebarBookmark(content, container))
            const bookmark = this.props.bookmarks.get(this.props.view)
            if (bookmark) this.start(bookmark, this.props.view !== 'recent')
            return { kind: 'view', ...(bookmark ? { bookmark } : {}) }
        }
        if (previous.sessions === this.props.sessions) return null
        this.cancel(false)
        if (!content || !container || container.scrollTop <= 0) return null
        const viewport = container.getBoundingClientRect(), anchors: Array<{ element: HTMLElement; top: number }> = []
        for (const element of content.querySelectorAll<HTMLElement>(SIDEBAR_ANCHORS)) {
            if (sidebarAnchorHidden(element)) continue
            const rect = element.getBoundingClientRect()
            if (rect.top >= viewport.bottom) break
            const row = element.hasAttribute('data-session-view-anchor')
            if (rect.height > 0 && rect.bottom > viewport.top && (row || rect.top >= viewport.top)) anchors.push({ element, top: rect.top - viewport.top })
        }
        return { kind: 'content', scrollTop: container.scrollTop, anchors, bookmark: changedScope ? { scrollTop: container.scrollTop, anchors: [] } : captureSidebarBookmark(content, container) }
    }
    componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null): void {
        this.committedView = this.props.view; this.committedSessions = this.props.sessions
        const content = this.contentRef.current, container = content?.parentElement
        if (!content || !container || !snapshot) return
        if (snapshot.kind === 'view') {
            if (snapshot.bookmark) { if (this.props.view !== 'recent') this.restore() }
            else { container.scrollTop = 0; this.props.onScrollRestored?.(container.scrollTop) }
            return
        }
        const top = container.getBoundingClientRect().top
        const candidates = snapshot.anchors.filter(({ element }) => content.contains(element) && !sidebarAnchorHidden(element))
            .map(anchor => ({ ...anchor, rect: anchor.element.getBoundingClientRect() })).filter(anchor => anchor.rect.height > 0)
            .map(anchor => ({ ...anchor, shift: anchor.rect.top - top + container.scrollTop - anchor.top - snapshot.scrollTop }))
        const anchor = this.props.view === 'recent' ? candidates[0] : candidates.sort((left, right) => Math.abs(left.shift) - Math.abs(right.shift))[0]
        if (!anchor && this.props.view === 'recent' && snapshot.bookmark.anchors.length) {
            const ids = new Set(this.props.sessions.map(session => session.id))
            const surviving = snapshot.bookmark.anchors.filter(item => item.rootId && ids.has(item.rootId))
            if (surviving.length) { this.start({ ...snapshot.bookmark, anchors: surviving }, false); this.forceUpdate(); return }
        }
        const target = anchor ? snapshot.scrollTop + anchor.shift : snapshot.scrollTop
        if (Math.abs(container.scrollTop - target) > .5) container.scrollTop = target
        this.props.onScrollRestored?.(container.scrollTop)
    }
    render(): ReactNode {
        const bookmark = this.bookmarkScope === this.props.scope && this.props.hasSessions
            ? this.committedView !== this.props.view ? this.props.bookmarks.get(this.props.view)
                : this.committedSessions === this.props.sessions ? this.pending?.bookmark : undefined
            : undefined
        return <SidebarViewRestoration.Provider value={bookmark ? { bookmark, onLayout: this.onLayout } : null}>
            <div ref={this.contentRef} className="hapi-session-list-content">{this.props.children}</div>
        </SidebarViewRestoration.Provider>
    }
}
