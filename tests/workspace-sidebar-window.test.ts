/** Pure tree/viewport regressions with explicit catalog and observer fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'
import { projectSidebarRows, sidebarTree } from '../src/workspace/sidebar-tree.ts'
import { sidebarBranchFacts } from '../src/workspace/sidebar-sections.ts'
import { sidebarWindowRange } from '../src/workspace/sidebar-range.ts'
import { createProgrammaticScrollObserver } from '../src/workspace/programmatic-scroll.ts'
import type { VirtualizerOptions } from '@tanstack/react-virtual'

const row = (id: string, parentId?: string): WorkspaceCatalogRow => ({ id: id as WorkspaceCatalogRow['id'], displayTitle: id,
    updatedAt: 1, running: false, retainedBy: {}, blank: false, hostId: 'local', hostLabel: 'DSH', hostOnline: true,
    sourceSessionId: id, archived: false, pinned: false, ...(parentId ? { parentId: parentId as WorkspaceCatalogRow['id'] } : {}) })

test('ten-thousand-level SDK tree projects without recursion and expands only actual selected ancestry', () => {
    const all = Array.from({ length: 10_000 }, (_, index) => row(`s${index}`, index ? `s${index - 1}` : undefined))
    const roots = sidebarTree(all), facts = sidebarBranchFacts(roots, 's9999')
    assert.equal(roots.length, 1)
    assert.equal(projectSidebarRows(roots, () => false).length, 1)
    const selected = projectSidebarRows(roots, branch => facts.get(branch.row.id)?.selected === true)
    assert.equal(selected.length, 10_000); assert.equal(selected.at(-1)?.depth, 9999)
    assert.equal(selected.at(-1)?.rootId, 's0')
    assert.equal(selected.at(-1)?.expanded, false)
    assert.deepEqual(projectSidebarRows(roots, branch => branch.row.id === 's0').map(item => item.id), ['s0', 's1'])
})

test('cyclic or orphan source parents cannot hide any identity and do not steal a different Host parent', () => {
    const roots = sidebarTree([row('a', 'b'), row('b', 'a'), row('child', 'b'), row('orphan', 'missing'),
        { ...row('remote-child', 'a'), hostId: 'remote' }])
    assert.deepEqual(roots.map(branch => branch.row.id), ['a', 'b', 'child', 'orphan', 'remote-child'])
    assert.equal(projectSidebarRows(roots, () => true).length, 5)
})

test('virtual DOM budget is independent of total catalog size and retains only explicit row pins', () => {
    const range = { startIndex: 100, endIndex: 109, overscan: 20, count: 1_000 }
    const small = sidebarWindowRange(range), large = sidebarWindowRange({ ...range, count: 100_000 })
    assert.deepEqual(large, small); assert.equal(large.length, 50)
    const start = sidebarWindowRange({ ...range, startIndex: 0, endIndex: 9 })
    const end = sidebarWindowRange({ ...range, startIndex: 990, endIndex: 999 })
    assert.equal(start.length, 50); assert.deepEqual(start.slice(0, 2), [0, 1]); assert.equal(end.length, 50); assert.equal(end.at(-1), 999)
    const pinned = sidebarWindowRange(range, [0, 999, 999, -1, 1000, 1.2])
    assert.equal(pinned.length, 52); assert.equal(pinned[0], 0); assert.equal(pinned.at(-1), 999)
    assert.deepEqual(sidebarWindowRange({ startIndex: 0, endIndex: -1, overscan: 0, count: 0 }), [])
})

test('programmatic landing observes the real scroll and stale observer cleanup cannot detach the next view', () => {
    type Offset = VirtualizerOptions<HTMLDivElement, HTMLDivElement>['observeElementOffset']
    type Rect = VirtualizerOptions<HTMLDivElement, HTMLDivElement>['observeElementRect']
    let emitRect: Parameters<Rect>[1] | undefined, emitOffset: Parameters<Offset>[1] | undefined
    const observer = createProgrammaticScrollObserver((_instance, callback) => { emitOffset = callback; return () => {} }, (_instance, callback) => { emitRect = callback; return () => {} })
    const element = { scrollTop: 125 } as HTMLDivElement
    const instance = { scrollElement: element } as Parameters<Offset>[0]
    const offsets: number[] = []
    const stopFirst = observer.observeOffset(instance, offset => offsets.push(offset))
    const stopSize = observer.observeRect(instance, () => {})
    emitOffset!(100, true); observer.observeLanding(100); observer.observeLanding(125)
    assert.deepEqual(offsets, [100, 125]); assert.equal(element.scrollTop, 125)
    emitRect!({ width: 0, height: 0 }); element.scrollTop = 400; emitRect!({ width: 320, height: 680 })
    assert.deepEqual(offsets, [100, 125, 400])
    const next: number[] = []
    const stopNext = observer.observeOffset(instance, offset => next.push(offset))
    stopFirst?.(); observer.observeLanding(500)
    assert.deepEqual(next, [500]); assert.equal(element.scrollTop, 400) // The observer never writes.
    stopNext?.(); stopSize?.(); observer.observeLanding(600)
    assert.deepEqual(next, [500]); assert.equal(observer.getOffset(), undefined)
})
