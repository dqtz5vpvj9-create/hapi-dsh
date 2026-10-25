/** Isolated synthetic native source: no production connection or private content. */
import assert from 'node:assert/strict'
import { cumulativeEvent, deferred, sourceQueueFixture } from './source-event-queue.js'
const mode = process.argv[2], snapshots = Number(process.argv[3])
assert.ok(mode === 'chain-control' || mode === 'native' || mode === 'observed')
assert.ok(global.gc)
const fixture = await sourceQueueFixture(mode === 'observed' ? 'observed' : 'native')
const gate = deferred(), started = deferred(); let handled = 0, lastLength = 0
fixture.agent.handleEvent = async event => {
  if (event.type === 'message-received') lastLength = ((event.message.content as any).content.data.message as string).length
  handled++
  if (handled === 1) { started.resolve(); await gate.promise }
}
function heap() { global.gc!(); global.gc!(); return process.memoryUsage().heapUsed }
try {
  fixture.emit(cumulativeEvent(1)); await started.promise
  const baseline = heap()
  let work = gate.promise
  for (let index = 2; index <= snapshots; index++) {
    const event = cumulativeEvent(index)
    if (mode === 'chain-control') work = work.then(() => fixture.emit(event))
    else await fixture.emit(event)
  }
  const growthBytes = heap() - baseline
  gate.resolve(); await work; await fixture.service.settled()
  assert.equal(lastLength, snapshots * 512)
  if (mode !== 'chain-control') assert.equal(handled, 2)
  console.log(JSON.stringify({ mode, snapshots, finalTextBytes: snapshots * 512, cumulativeTextBytes: snapshots * (snapshots + 1) / 2 * 512, growthBytes, handled }))
} finally { gate.resolve(); await fixture.close() }
