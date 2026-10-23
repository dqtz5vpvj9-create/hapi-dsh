import test from 'node:test'
import assert from 'node:assert/strict'
import { ForegroundActivity } from '../src/client/foreground-activity.ts'

test('background work waits through a held pointer and its inertial scroll, then resumes', () => {
    let now = 0
    const activity = new ForegroundActivity(() => now)
    const outer = new EventTarget()
    activity.press(1); now = 5_000
    assert.equal(activity.busy(), true)
    activity.scrollIntent()
    activity.release(1)
    now += 400; activity.scroll(outer)
    now += 400; activity.scroll(outer)
    now += 5_000; assert.equal(activity.busy(), true, 'native inertia remains owned until its scrollend')
    activity.scrollend(outer)
    now += 599; assert.equal(activity.busy(), true)
    now++; assert.equal(activity.busy(), false)
    // Live follow/anchor scrolls after idle do not indefinitely starve plugins.
    activity.scroll(outer); assert.equal(activity.busy(), false)
})

test('native pan pointercancel does not release a finger resting on the screen', () => {
    let now = 0
    const activity = new ForegroundActivity(() => now)
    activity.press(1); activity.touch(1)
    activity.release(1) // Chrome transfers pointer ownership to native panning.
    now = 5_000
    assert.equal(activity.busy(), true)
    activity.touch(0)
    activity.scrollIntent()
    const outer = new EventTarget()
    now += 400; activity.scroll(outer)
    activity.scrollend(outer)
    now += 599; assert.equal(activity.busy(), true)
    now++; assert.equal(activity.busy(), false)
})

test('one typing input followed by sixty seconds of automatic live follow cannot starve background work', () => {
    let now = 0
    const activity = new ForegroundActivity(() => now), outer = new EventTarget()
    activity.defer()
    now = 500; activity.scroll(outer)
    now = 600; assert.equal(activity.busy(), false, 'program scrolling does not renew the typing quiet interval')
    for (now = 1_000; now <= 60_000; now += 500) {
        activity.scroll(outer)
        assert.equal(activity.busy(), false)
    }
})

test('only the gesture scrollport can continue and finish native inertial ownership', () => {
    let now = 0
    const activity = new ForegroundActivity(() => now), outer = new EventTarget(), inner = new EventTarget()
    activity.scrollIntent(); activity.scroll(outer)
    now = 1_000
    activity.scroll(inner)
    assert.equal(activity.scrollend(inner), false)
    assert.equal(activity.busy(), true, 'an inner tool scrollend cannot release outer inertia')
    assert.equal(activity.scrollend(outer), true)
    now += 600; assert.equal(activity.busy(), false)
    activity.scroll(outer); assert.equal(activity.busy(), false, 'follow after the true end does not restart ownership')
})

test('an unused gesture and browsers without native scrollend retain bounded quiet fallback', () => {
    let now = 0
    const activity = new ForegroundActivity(() => now), outer = new EventTarget()
    activity.scrollIntent()
    now = 600; assert.equal(activity.busy(), false, 'a wheel at the boundary must not wait forever for scrollend')
    activity.scroll(outer); assert.equal(activity.busy(), false)
    activity.scrollIntent(); activity.scroll(outer, false)
    now += 500; activity.scroll(outer, false)
    now += 599; assert.equal(activity.busy(), true)
    now++; assert.equal(activity.busy(), false)
    activity.scroll(outer, false); assert.equal(activity.busy(), false, 'expired fallback cannot be revived by later follow')
})

test('one lifted finger cannot release another held pointer; typing renews the pause', () => {
    let now = 0
    const activity = new ForegroundActivity(() => now)
    activity.press(1); activity.press(2); activity.release(1)
    now = 1_000; assert.equal(activity.busy(), true)
    activity.release(2); now = 1_500; activity.defer()
    now = 2_099; assert.equal(activity.busy(), true)
    now++; assert.equal(activity.busy(), false)
})

test('removing a moving pane releases its missing scrollend without limiting connected inertia', () => {
    let now = 0
    const activity = new ForegroundActivity(() => now), outer = Object.assign(new EventTarget(), { isConnected: true })
    activity.scrollIntent(); activity.scroll(outer)
    now = 60_000; assert.equal(activity.busy(), true, 'connected native inertia has no arbitrary deadline')
    outer.isConnected = false
    assert.equal(activity.busy(), false, 'a removed pane cannot deliver the scrollend needed by its old motion')
})

test('a new pointer navigation interrupts old inertia even if the old target never emits scrollend', () => {
    let now = 0
    const activity = new ForegroundActivity(() => now), outer = new EventTarget()
    activity.scrollIntent(); activity.scroll(outer)
    now = 1_000; activity.press(2); activity.release(2)
    now += 600; assert.equal(activity.busy(), false, 'the new interaction supersedes the previous motion owner')
})
