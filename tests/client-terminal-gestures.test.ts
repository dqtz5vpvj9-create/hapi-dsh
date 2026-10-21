/** Gesture clock and wheel sinks are explicit fixtures; real xterm is exercised by Playwright. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TerminalGestures, type TerminalGestureClock, type TerminalGestureMode } from '../src/client/source-terminal/gestures.ts'

function fixture() {
  let now = 0, font = 13, visible = true, mode: TerminalGestureMode = 'normal', focused = 0
  const events: Array<{ time: number; run(): void }> = [], wheels: number[] = [], sizes: number[] = []
  const enqueue = (run: () => void, ms: number): (() => void) => {
    const event = { time: now + ms, run }; events.push(event)
    return () => { const index = events.indexOf(event); if (index >= 0) events.splice(index, 1) }
  }
  const clock: TerminalGestureClock = { now: () => now, frame: run => enqueue(run, 16), delay: (run, ms) => enqueue(run, ms) }
  const gestures = new TerminalGestures({ visible: () => visible, fontSize: () => font, setFontSize: value => { font = value; sizes.push(value) }, mode: () => mode,
    wheel: value => { wheels.push(value); return true }, focus: () => { focused++ } }, clock)
  return { gestures, wheels, sizes, focused: () => focused, mode(value: TerminalGestureMode) { mode = value }, visible(value: boolean) { visible = value },
    advance(ms: number) { const until = now + ms; for (;;) {
      events.sort((a, b) => a.time - b.time); const next = events[0]
      if (!next || next.time > until) break
      events.shift(); now = next.time; next.run()
    } now = until }, pending: () => events.length }
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y })

test('terminal pinch debounces the local font, clamps 9–32px and does not send wheel or focus actions', () => {
  const f = fixture()
  f.gestures.start([at(0, 0), at(100, 0)])
  assert.equal(f.gestures.move([at(0, 0), at(200, 0)]), true)
  f.advance(30); assert.deepEqual(f.sizes, [])
  f.gestures.move([at(0, 0), at(400, 0)]); f.advance(49); assert.deepEqual(f.sizes, [])
  f.gestures.end([at(0, 0)]); f.advance(1); assert.deepEqual(f.sizes, [32])
  f.gestures.start([at(0, 0), at(100, 0)]); f.gestures.move([at(0, 0), at(1, 0)]); f.advance(50)
  assert.deepEqual(f.sizes, [32, 9]); assert.deepEqual(f.wheels, []); assert.equal(f.focused(), 0)
})

test('terminal taps remain native; only moved drags acquire normal-history inertia', () => {
  const f = fixture()
  f.gestures.start([at(50, 100)]); assert.equal(f.gestures.move([at(50, 102)]), false); f.gestures.end([at(50, 102)])
  assert.equal(f.focused(), 1); assert.deepEqual(f.wheels, [])
  f.gestures.start([at(50, 100)]); f.advance(20)
  assert.equal(f.gestures.move([at(50, 80)]), true); f.gestures.end([at(50, 80)])
  assert.deepEqual(f.wheels, [20]); f.advance(32)
  assert.equal(f.wheels.length, 3); assert.ok(f.wheels[1]! > f.wheels[2]!)
  f.gestures.start([at(50, 100)]); const count = f.wheels.length; f.advance(100)
  assert.equal(f.wheels.length, count, 'a new touch stops existing momentum')
  f.gestures.cancel(); assert.equal(f.pending(), 0)
})

test('alternate-screen drag has no inertia and a mode transition immediately stops a normal coast', () => {
  const f = fixture(); f.mode('alternate')
  f.gestures.start([at(10, 100)]); f.advance(20); f.gestures.move([at(10, 60)]); f.gestures.end([at(10, 60)])
  f.advance(100); assert.deepEqual(f.wheels, [40]); assert.equal(f.pending(), 0)
  f.mode('normal'); f.gestures.start([at(10, 100)]); f.advance(20); f.gestures.move([at(10, 60)]); f.gestures.end([at(10, 60)])
  f.mode('alternate'); f.advance(100); assert.deepEqual(f.wheels, [40, 40])
  f.mode('blocked'); f.gestures.start([at(10, 100)]); f.advance(20); assert.equal(f.gestures.move([at(10, 60)]), true)
  f.mode('alternate'); assert.equal(f.gestures.move([at(10, 40)]), true, 'a newly acknowledged mode must not revive a blocked drag')
  f.gestures.end([at(10, 60)]); f.advance(100); assert.deepEqual(f.wheels, [40, 40])
})

test('hidden and disposed occurrences cancel both pending pinch updates and momentum', () => {
  const f = fixture()
  f.gestures.start([at(0, 0), at(100, 0)]); f.gestures.move([at(0, 0), at(200, 0)])
  f.visible(false); f.advance(100); assert.deepEqual(f.sizes, [])
  f.visible(true); f.gestures.start([at(10, 100)]); f.advance(20); f.gestures.move([at(10, 60)]); f.gestures.end([at(10, 60)])
  f.visible(false); f.advance(100); assert.deepEqual(f.wheels, [40]); assert.equal(f.pending(), 0)
  f.visible(true); f.gestures.start([at(0, 0), at(100, 0)]); f.gestures.move([at(0, 0), at(200, 0)])
  f.gestures.cancel(); f.advance(100); assert.deepEqual(f.sizes, []); assert.equal(f.pending(), 0)
})
