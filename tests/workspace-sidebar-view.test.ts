/** Original HAPI recency/scroll rules; DOM geometry below is an explicit unit fixture. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SidebarRecency, localDayKey, matchesSidebarTime, selectSidebarDate, sidebarDayLabel, sidebarTimeRange } from '../src/workspace/sidebar-time.ts'
import { captureSidebarBookmark, resolveSidebarBookmark, SidebarBookmarks } from '../src/workspace/sidebar-bookmarks.ts'

test('live output keeps its original date and order; new historical rows insert by their true date', () => {
    const recency = new SidebarRecency(), first = [{ id: 'recent', updatedAt: 30 }, { id: 'older', updatedAt: 10 }]
    assert.deepEqual(recency.reconcile(first), ['recent', 'older'])
    const changed = [{ id: 'older', updatedAt: 50 }, { id: 'imported', updatedAt: 5 }, first[0]!]
    assert.deepEqual(recency.reconcile(changed), ['recent', 'older', 'imported'])
    assert.equal(recency.timeFor(changed[0]!), 10)
    assert.deepEqual(recency.reconcile(changed, true), ['older', 'recent', 'imported'])
    assert.equal(recency.timeFor(changed[0]!), 50)
})

test('day headings use local calendar dates; a range includes its whole final day and rejects invalid dates', () => {
    const now = new Date(2026, 9, 20, 12).getTime(), yesterday = new Date(2026, 9, 19, 23, 59).getTime()
    const labels = { today: 'today', yesterday: 'yesterday' }
    assert.equal(sidebarDayLabel(now, undefined, labels, 'en', now), 'today')
    assert.equal(sidebarDayLabel(now, now - 3600_000, labels, 'en', now), null)
    assert.equal(sidebarDayLabel(yesterday, now, labels, 'en', now), 'yesterday')
    assert.equal(sidebarDayLabel(new Date(2026, 9, 1).getTime(), yesterday, labels, 'en', now), 'Oct 1')
    const range = sidebarTimeRange('2026-10-19', '2026-10-20')!
    assert.equal(localDayKey(range.start), '2026-10-19')
    assert.equal(localDayKey(range.end), '2026-10-21')
    assert.equal(matchesSidebarTime(range.start - 1, range), false)
    assert.equal(matchesSidebarTime(range.end - 1, range), true)
    assert.equal(matchesSidebarTime(range.end, range), false)
    for (const dates of [['2026-02-29', '2026-03-01'], ['2026-10-20', '2026-10-19'], ['', '2026-10-20']]) assert.equal(sidebarTimeRange(dates[0]!, dates[1]!), null)
})

test('calendar selection waits for both endpoints, reverses a backwards range, and starts afresh after completion', () => {
    const first = selectSidebarDate('', '', '2026-10-20')
    assert.deepEqual(first, { start: '2026-10-20', end: '', complete: false })
    assert.equal(sidebarTimeRange(first.start, first.end), null)
    assert.deepEqual(selectSidebarDate(first.start, first.end, '2026-10-10'), { start: '2026-10-10', end: '2026-10-20', complete: true })
    assert.deepEqual(selectSidebarDate(first.start, first.end, first.start), { start: first.start, end: first.start, complete: true })
    assert.deepEqual(selectSidebarDate('2026-10-10', '2026-10-20', '2026-11-01'), { start: '2026-11-01', end: '', complete: false })
    assert.deepEqual(selectSidebarDate(first.start, '', '2026-02-29'), { ...first, complete: false })
})

function geometry(items: Array<{ id: string; top: number; height: number; hidden?: boolean }>, scrollTop = 250) {
    const container = { scrollTop, getBoundingClientRect: () => ({ top: 100, bottom: 260, height: 160 }) } as HTMLElement
    const elements = items.map(item => ({ dataset: { sessionViewAnchor: item.id }, hasAttribute: () => true,
        closest: () => item.hidden ? {} : null, getBoundingClientRect: () => ({ top: 100 + item.top, bottom: 100 + item.top + item.height, height: item.height }),
    }))
    const content = { querySelectorAll: () => elements } as unknown as HTMLElement
    return { content, container }
}

test('bookmarks preserve a semantic survivor across insertions, hidden rows, deletion and mobile row height changes', () => {
    const old = geometry([{ id: 'a', top: -30, height: 70 }, { id: 'b', top: 40, height: 70 }])
    const bookmark = captureSidebarBookmark(old.content, old.container)
    assert.deepEqual(bookmark, { scrollTop: 250, anchors: [{ id: 'a', top: -30 }, { id: 'b', top: 40 }] })
    const inserted = geometry([{ id: 'new', top: -50, height: 30 }, { id: 'a', top: 0, height: 70 }, { id: 'b', top: 70, height: 70 }])
    assert.equal(resolveSidebarBookmark(inserted.content, inserted.container, bookmark), 280)
    const hidden = geometry([{ id: 'a', top: -30, height: 70, hidden: true }, { id: 'b', top: 70, height: 70 }])
    assert.equal(resolveSidebarBookmark(hidden.content, hidden.container, bookmark), 280)
    const smaller = geometry([{ id: 'a', top: -30, height: 20 }, { id: 'b', top: -10, height: 20 }])
    assert.equal(resolveSidebarBookmark(smaller.content, smaller.container, bookmark), 239)
    const none = geometry([{ id: 'unrelated', top: 0, height: 70 }])
    assert.equal(resolveSidebarBookmark(none.content, none.container, bookmark), 0)
    assert.equal(resolveSidebarBookmark(none.content, none.container, { scrollTop: 42, anchors: [] }), 42)
})

test('recent and folder bookmarks remain separate; a changed query/machine filter invalidates both', () => {
    const cache = new SidebarBookmarks(), recent = { scrollTop: 100, anchors: [{ id: 'a', top: 0 }] }, folders = { scrollTop: 200, anchors: [{ id: 'folder', top: 3 }] }
    cache.useScope('machine-a'); cache.save('recent', recent); cache.save('folders', folders)
    assert.equal(cache.useScope('machine-a'), false)
    assert.deepEqual(cache.get('recent'), recent); assert.deepEqual(cache.get('folders'), folders)
    assert.equal(cache.useScope('machine-b'), true)
    assert.equal(cache.get('recent'), undefined); assert.equal(cache.get('folders'), undefined)
    const many = geometry(Array.from({ length: 15 }, (_, index) => ({ id: `row-${index}`, top: index * 10, height: 10 })))
    assert.equal(captureSidebarBookmark(many.content, many.container).anchors.length, 8)
})
