/** Real Event dispatch with explicit fake pane boundaries; browser drop is covered in e2e. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPaneInputRouter } from '../src/client/pane-input.ts'

test('one file drop reaches only the owning visible pane, regardless of another mounted composer', () => {
    const first = Object.assign(new EventTarget(), { contains: () => false })
    const second = Object.assign(new EventTarget(), { contains: () => false })
    let visible = true, resetFirst = 0, resetSecond = 0
    const a = createPaneInputRouter({ surface: first, visible: () => visible, activeElement: () => null, resetDrag: () => { resetFirst++ } })
    const b = createPaneInputRouter({ surface: second, visible: () => true, activeElement: () => null, resetDrag: () => { resetSecond++ } })
    const gesture = (type: string, target: EventTarget) => { const event = new Event(type); Object.defineProperty(event, 'composedPath', { value: () => [target] }); return event }
    const enter = gesture('dragenter', first)
    assert.equal(a.accepts(enter), true); assert.equal(b.accepts(enter), false)
    const move = gesture('dragover', second)
    assert.equal(a.accepts(move), false); assert.equal(b.accepts(move), true)
    assert.equal(resetFirst, 1)
    const drop = gesture('drop', second)
    assert.equal(a.accepts(drop), false); assert.equal(b.accepts(drop), true)
    visible = false
    assert.equal(a.accepts(gesture('drop', first)), false)
    assert.equal(resetSecond, 0)
})

test('upload isolation leaves outside-click dismissal intact and resets drag state on hide/blur', () => {
    const surface = Object.assign(new EventTarget(), { contains: () => false })
    let resets = 0
    const router = createPaneInputRouter({ surface, visible: () => true, activeElement: () => null, resetDrag: () => { resets++ } })
    assert.equal(router.accepts(new Event('pointerdown')), true)
    assert.equal(router.accepts(new Event('click')), true)
    assert.equal(router.accepts(new Event('paste')), false)
    const enter = new Event('dragenter'); Object.defineProperty(enter, 'composedPath', { value: () => [surface] })
    assert.equal(router.accepts(enter), true)
    router.reset(); router.reset()
    assert.equal(resets, 1)
})
