/** Identity and gesture tests use explicit catalog/clock fakes. Browser tests
 * exercise the real native button, portal and official DSH workspace together. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'
import { SidebarPress, sidebarActionFacts, sidebarMenuPosition, type MenuPoint, type PressClock } from '../src/workspace/sidebar-actions.ts'

const row = (patch: Partial<WorkspaceCatalogRow> = {}): WorkspaceCatalogRow => ({ id: 'local-display' as WorkspaceCatalogRow['id'], sourceSessionId: 'serving-dsh-id',
    displayTitle: 'A source title', updatedAt: 1, running: false, retainedBy: {}, blank: false, hostId: 'local', hostLabel: 'Hub', hostOnline: true,
    archived: false, pinned: false, ...patch })
const native = { hapi: { engine: 'codex', hubId: 'original-hub', hapiSessionId: 'original-hapi-id', nativeId: 'original-cli-thread',
    nativeHome: '/home/source/.codex', nativeConnection: 'attached' } } as never

test('source actions distinguish all three identities and never mutate another Hub or a child as its parent', () => {
    assert.deepEqual(sidebarActionFacts(row({ projectionValues: native })), { child: false,
        source: { sessionId: 'original-hapi-id', hubId: 'original-hub' }, localSource: true, sourceActive: true,
        sourceId: 'original-hapi-id', nativeId: 'original-cli-thread', displayId: 'serving-dsh-id', canMigrate: true })
    const foreign = sidebarActionFacts(row({ id: 'host%remote%serving-dsh-id' as never, hostId: 'remote', projectionValues: native }))
    assert.equal(foreign.localSource, false); assert.equal(foreign.canMigrate, false)
    assert.equal(foreign.displayId, 'serving-dsh-id')
    const child = sidebarActionFacts(row({ projectionValues: { hapiObserved: { hapiSessionId: 'original-hapi-id', hubId: 'original-hub', nativeId: 'original-cli-thread',
        sidechain: { scopeId: 'original-child', parentSessionId: 'parent-display' } } } as never }))
    assert.equal(child.child, true); assert.equal(child.source, null); assert.equal(child.localSource, false)
    assert.equal(child.nativeId, null); assert.equal(child.sourceId, null); assert.equal(child.canMigrate, false)
})

test('source lifecycle uses its source active fact and never guesses from model execution or serving Host availability', () => {
    assert.equal(sidebarActionFacts(row({ projectionValues: native, sourceActive: false, running: true })).sourceActive, false)
    assert.equal(sidebarActionFacts(row({ projectionValues: { hapi: { engine: 'codex', hapiSessionId: 'source', nativeConnection: 'disconnected' } } as never,
        hostOnline: true, running: true })).sourceActive, null)
    assert.equal(sidebarActionFacts(row({ sourceActive: true })).sourceActive, null)
    const noOriginal = sidebarActionFacts(row({ projectionValues: { hapiObserved: { ownership: 'hapi-runner', hapiSessionId: 'source', nativeId: null, active: false } } as never }))
    assert.equal(noOriginal.nativeId, null); assert.equal(noOriginal.sourceActive, false)
})

function fakeClock() {
    let now = 0, next = 0
    const timers = new Map<number, { at: number; callback: () => void }>()
    const clock: PressClock = { now: () => now, schedule(callback, milliseconds) { const id = ++next; timers.set(id, { at: now + milliseconds, callback }); return () => { timers.delete(id) } } }
    return { clock, advance(milliseconds: number) { now += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() } } }
}

test('the original 500 ms press opens once and consumes only the bounded compatibility click', () => {
    const time = fakeClock(), opened: MenuPoint[] = [], press = new SidebarPress(point => opened.push(point), time.clock)
    press.begin(1, { x: 10, y: 20 }, 'touch'); time.advance(499); assert.equal(opened.length, 0)
    time.advance(1); assert.deepEqual(opened, [{ x: 10, y: 20 }])
    press.end(1); assert.equal(press.suppressClick(0), false); assert.equal(press.suppressClick(1), true); assert.equal(press.suppressClick(1), false)
    press.begin(2, { x: 30, y: 40 }, 'touch'); time.advance(500); press.end(2); time.advance(700)
    assert.equal(press.suppressClick(1), false)
    press.begin(3, { x: 30, y: 40 }, 'touch'); time.advance(500); press.end(3)
    press.nextGesture(); assert.equal(press.suppressClick(1), false, 'a fresh physical press in the portaled menu is not a compatibility click')
    press.dispose()
})

test('movement, pointer cancellation, native context menus and a later genuine click keep their separate lifetimes', () => {
    const time = fakeClock(), opened: MenuPoint[] = [], press = new SidebarPress(point => opened.push(point), time.clock)
    press.begin(1, { x: 0, y: 0 }, 'touch'); press.move(1, { x: 0, y: 1 }); time.advance(600); assert.equal(opened.length, 0)
    press.begin(2, { x: 0, y: 0 }, 'mouse'); press.cancel(); time.advance(600); assert.equal(opened.length, 0)
    press.begin(3, { x: 10, y: 15 }, 'touch'); press.context({ x: 10, y: 15 }); time.advance(500); assert.equal(opened.length, 1)
    press.cancel(); assert.equal(press.suppressClick(1), true)
    press.begin(4, { x: 1, y: 2 }, 'touch'); time.advance(500); press.cancel()
    press.begin(5, { x: 1, y: 2 }, 'mouse'); press.end(5); assert.equal(press.suppressClick(1), false)
    press.begin(6, { x: 1, y: 2 }, 'touch'); press.dispose(); time.advance(500); assert.equal(opened.length, 2)
})

test('a long menu fits the visible viewport with an open mobile keyboard and right edge', () => {
    const position = sidebarMenuPosition({ x: 410, y: 350 }, { width: 280, height: 700 }, { left: 0, top: 80, width: 420, height: 350 })
    assert.deepEqual(position, { left: 132, top: 88, maxWidth: 404, maxHeight: 334 })
    const above = sidebarMenuPosition({ x: 20, y: 750 }, { width: 200, height: 150 }, { left: 0, top: 0, width: 1000, height: 800 })
    assert.equal(above.top, 594); assert.equal(above.left, 20)
})
