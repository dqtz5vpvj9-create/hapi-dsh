/**
 * Adapted from HAPI 0f8ef697 RecentSessionList.tsx.
 * Copyright HAPI contributors. AGPL-3.0-only; see NOTICE.
 * Uses the official DSH-provided TanStack package, not another scroll engine.
 */
import { Fragment, memo, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { observeElementOffset, observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { createProgrammaticScrollObserver } from '../workspace/programmatic-scroll.ts'
import { sidebarWindowRange } from '../workspace/sidebar-range.ts'
import { SidebarViewRestoration } from './sidebar-scroll.tsx'

const observeRecentRect: typeof observeElementRect<HTMLDivElement> = (instance, callback) => observeElementRect(instance, rect => { if (rect.height > 0) callback(rect) })
export const observeRecentOffset: typeof observeElementOffset<HTMLDivElement> = (instance, callback) => {
    const element = instance.scrollElement
    if (!element) return
    let active = true
    const observeActual = (): void => { if (active && element.scrollTop !== instance.scrollOffset) callback(element.scrollTop, false) }
    observeActual()
    const stop = observeElementOffset(instance, callback)
    const ResizeObserverClass = element.ownerDocument.defaultView?.ResizeObserver
    const observer = ResizeObserverClass ? new ResizeObserverClass(observeActual) : null
    observer?.observe(element)
    return () => { active = false; stop?.(); observer?.disconnect() }
}

const RowContent = memo(function RowContent<T extends { id: string }>({ item, renderItem }: { item: T; renderItem: (item: T) => ReactNode }) {
    return renderItem(item)
}) as <T extends { id: string }>(props: { item: T; renderItem: (item: T) => ReactNode }) => ReactNode

const rowId = (target: EventTarget | null): string | null => target instanceof Element ? target.closest<HTMLElement>('[data-recent-root]')?.dataset.recentRoot ?? null : null

export type SidebarScrollObserver = { observeScroll(offset: number): void }
export function SidebarWindow<T extends { id: string }>({ items, scrollElement, scrollObserverRef, selectedId, narrow, renderItem, estimateSize }: {
    items: readonly T[]
    scrollElement: HTMLDivElement | null
    scrollObserverRef?: Ref<SidebarScrollObserver>
    selectedId?: string | undefined
    narrow: boolean
    renderItem: (item: T) => ReactNode
    estimateSize?: (item: T, base: number) => number
}) {
    const listRef = useRef<HTMLDivElement>(null)
    const restoration = useContext(SidebarViewRestoration)
    const [observer] = useState(() => createProgrammaticScrollObserver(observeRecentOffset, observeRecentRect))
    useImperativeHandle(scrollObserverRef, () => ({ observeScroll: observer.observeLanding }), [observer])
    const [focused, setFocused] = useState<string | null>(null), [pressed, setPressed] = useState<string | null>(null), [dragged, setDragged] = useState<string | null>(null)
    const [openMenus, setOpenMenus] = useState<ReadonlySet<string>>(() => new Set())
    const [scrollMargin, setScrollMargin] = useState(0)
    const indexes = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items])
    const pins = [...new Set([selectedId, focused, pressed, dragged, ...openMenus, ...(restoration?.bookmark.anchors.map(anchor => anchor.rootId) ?? [])])]
        .flatMap(id => id && indexes.has(id) ? [indexes.get(id)!] : [])
    const pinKey = pins.join(',')
    const previousRange = useRef<number[]>([])
    const rangeExtractor = useCallback((range: Parameters<typeof sidebarWindowRange>[0]) => {
        const next = sidebarWindowRange(range, pins), previous = previousRange.current
        if (next.length === previous.length && next.every((index, offset) => index === previous[offset])) return previous
        previousRange.current = next
        return next
    }, [pinKey])
    const estimate = narrow ? 68 : 57
    const overscan = Math.ceil((scrollElement?.clientHeight || 680) * 2 / estimate)
    const getItemKey = useCallback((index: number) => items[index]!.id, [items])
    const virtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => scrollElement,
        getItemKey,
        estimateSize: index => estimateSize?.(items[index]!, estimate) ?? estimate,
        initialRect: { width: 320, height: 680 },
        observeElementRect: observer.observeRect,
        observeElementOffset: observer.observeOffset,
        overscan,
        scrollMargin,
        rangeExtractor,
        anchorTo: 'start',
        followOnAppend: false,
        scrollToFn: () => {},
        measureElement: (element, entry, instance) => {
            if (element.getClientRects().length === 0) {
                const index = instance.indexFromElement(element)
                return instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? instance.options.estimateSize(index)
            }
            return entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height
        },
    })
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
    const measureMargin = useCallback(() => {
        const viewport = scrollElement, list = listRef.current
        if (!viewport || !list || list.getClientRects().length === 0) return
        const margin = list.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
        setScrollMargin(previous => Math.abs(margin - previous) > .5 ? margin : previous)
    }, [scrollElement])
    useLayoutEffect(measureMargin, [measureMargin, items, narrow, renderItem])
    useLayoutEffect(() => {
        const ResizeObserverClass = scrollElement?.ownerDocument.defaultView?.ResizeObserver
        if (!scrollElement || !ResizeObserverClass) return
        let active = true
        const resize = new ResizeObserverClass(() => { if (active) measureMargin() })
        resize.observe(scrollElement)
        return () => { active = false; resize.disconnect() }
    }, [scrollElement, measureMargin])
    useEffect(() => {
        if (!pressed) return
        const release = (): void => setPressed(null)
        window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release); window.addEventListener('dragend', release)
        return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); window.removeEventListener('dragend', release) }
    }, [pressed])
    useLayoutEffect(() => {
        const list = listRef.current
        if (!list) return
        const toggle = (event: Event): void => {
            if (!(event.target instanceof HTMLDetailsElement)) return
            const id = rowId(event.target), open = event.target.open
            if (id) setOpenMenus(previous => { if (previous.has(id) === open) return previous; const next = new Set(previous); if (open) next.add(id); else next.delete(id); return next })
        }
        list.addEventListener('toggle', toggle, true)
        return () => { list.removeEventListener('toggle', toggle, true) }
    }, [])
    const rows = virtualizer.getVirtualItems()
    useLayoutEffect(() => {
        if (!restoration) return
        const measured = virtualizer.getVirtualItems()
        const stable = listRef.current?.getClientRects().length !== 0 && (rows === measured || rows.length === measured.length && rows.every((row, index) => {
            const next = measured[index]!
            return row.key === next.key && row.start === next.start && row.size === next.size
        }))
        restoration.onLayout(stable)
    })
    const renderedRows = useMemo(() => rows.map((row, index) => {
        const previous = rows[index - 1], space = previous ? row.start - previous.end : row.start - scrollMargin
        const item = items[row.index]!
        return <Fragment key={row.key}>
            <div aria-hidden="true" data-recent-spacer style={{ height: Math.max(0, space), overflowAnchor: 'none' }}/>
            <div data-index={row.index} data-recent-root={item.id} ref={virtualizer.measureElement} className="hapi-recent-row">
                <RowContent item={item} renderItem={renderItem}/>
            </div>
        </Fragment>
    }), [rows, items, scrollMargin, renderItem, virtualizer])
    return <div ref={listRef} className="hapi-recent-window" data-recent-total={items.length} style={{ height: virtualizer.getTotalSize() }}
        onFocusCapture={event => setFocused(rowId(event.target))} onBlurCapture={event => setFocused(rowId(event.relatedTarget))}
        onPointerDownCapture={event => setPressed(rowId(event.target))} onDragStartCapture={event => setDragged(rowId(event.target))} onDragEndCapture={() => setDragged(null)}>
        {renderedRows}
    </div>
}
