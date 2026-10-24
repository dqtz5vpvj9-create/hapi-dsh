/** Independent GC process: generated fixture text only; no application state or user data. */
import assert from 'node:assert/strict'
import { streamProjector } from './source-stream-projector.js'

const mode = process.argv[2], snapshots = Number(process.argv[3]), width = 128
assert.ok(mode === 'sliced-control' || mode === 'native' || mode === 'observed')
assert.ok(Number.isSafeInteger(snapshots) && snapshots > 0)
assert.ok(global.gc, 'Run this fixture with --expose-gc')
function retainedHeap(): number { global.gc!(); global.gc!(); return process.memoryUsage().heapUsed }
// Warm both protocol parsing and Session append without retaining that fixture.
if (mode !== 'sliced-control') {
  const warm = streamProjector(mode)
  for (let index = 1; index <= 8; index++) warm.apply('x'.repeat(index * width), index === 8)
}
const baseline = retainedHeap()
const fixture = mode === 'sliced-control' ? undefined : streamProjector(mode), sliced: string[] = []
function appendSnapshot(index: number): void {
  // Network JSON gives each cumulative source update its own flat backing string.
  const text: string = JSON.parse(JSON.stringify('x'.repeat(index * width)))
  if (fixture) fixture.apply(text)
  else sliced.push(text.slice((index - 1) * width))
}
for (let index = 1; index <= snapshots; index++) appendSnapshot(index)
const liveGrowthBytes = retainedHeap() - baseline
if (fixture) fixture.apply('x'.repeat(snapshots * width), true)
const committedGrowthBytes = retainedHeap() - baseline
// Observe the holder after GC so the fixture's retained stream remains reachable.
if (fixture) assert.equal(fixture.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
else assert.equal(sliced.reduce((length, delta) => length + delta.length, 0), snapshots * width)
console.log(JSON.stringify({ mode, snapshots, finalTextBytes: snapshots * width,
  cumulativeTextBytes: snapshots * (snapshots + 1) / 2 * width, liveGrowthBytes, committedGrowthBytes }))
