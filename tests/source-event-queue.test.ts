import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceEventQueue, replacesCumulativeSnapshot, type QueuedSourceEvent } from '../src/codex/event-queue.js'
import type { HapiEvent } from '../src/codex/contracts.js'
import { cumulativeEvent, deferred, sourceQueueFixture } from './fixtures/source-event-queue.js'

const queued = (event: HapiEvent, version = 1, generation = 1): QueuedSourceEvent<never> => ({ event, version, checkpoint: { sequence: 1, generation } })

test('only same native item provisional prefixes with identical metadata can coalesce', () => {
  const first = cumulativeEvent(1), next = cumulativeEvent(2)
  assert.equal(replacesCumulativeSnapshot(queued(first), queued(next)), true)
  for (const update of [
    (event: typeof next) => { event.message.localId = 'item' },
    (event: typeof next) => { event.sessionId = 'another-source' },
    (event: typeof next) => { event.message.deliveryState = 'dispatching' },
    (event: typeof next) => { event.message.content = { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'item', message: 'different' } } } },
    (event: typeof next) => { const body = event.message.content as any; body.content.data.nativeExecution.turn = { status: 'completed', started: true, ended: true } },
    (event: typeof next) => { const body = event.message.content as any; body.content.data.nativeExecution.turnId = 'another-turn' },
    (event: typeof next) => { const body = event.message.content as any; body.content.data.type = 'reasoning' },
  ]) {
    const changed = structuredClone(next); update(changed)
    assert.equal(replacesCumulativeSnapshot(queued(first), queued(changed)), false)
  }
  assert.equal(replacesCumulativeSnapshot(queued(first), queued(next, 2)), false)
  assert.equal(replacesCumulativeSnapshot(queued(first), queued(next, 1, 2)), false)
  assert.equal(replacesCumulativeSnapshot(queued(next), queued(first)), false)
})

test('single consumer counts active work, pauses at budget, and never bypasses controls', async () => {
  const gate = deferred(), started = deferred(), seen: string[] = [], failures: unknown[] = []
  let resync = 0
  const queue = new SourceEventQueue<string>(async value => { seen.push(value); if (value === 'first') { started.resolve(); await gate.promise } },
    () => false, error => failures.push(error), () => { resync++ }, { maxItems: 3, maxBytes: 12 })
  queue.enqueue('first', 4); await started.promise
  queue.enqueue('receipt', 4)
  let released = false
  const pressure = queue.enqueue('terminal', 4)!.then(() => { released = true })
  assert.deepEqual(queue.pending, { items: 3, bytes: 12 })
  await Promise.resolve(); assert.equal(released, false)
  const operation = queue.run(async () => { seen.push('reconcile'); return 42 })
  gate.resolve(); await pressure; assert.equal(await operation, 42); await queue.settled()
  assert.deepEqual(seen, ['first', 'receipt', 'terminal', 'reconcile']); assert.deepEqual(failures, [])
  assert.equal(resync, 1); assert.deepEqual(queue.pending, { items: 0, bytes: 0 })
  await queue.dispose()
})

test('one oversized event runs alone and disposal releases a blocked producer', async () => {
  const gate = deferred(), started = deferred(), seen: number[] = []
  const queue = new SourceEventQueue<number>(async value => { seen.push(value); started.resolve(); await gate.promise }, () => false, () => {}, () => {}, { maxItems: 2, maxBytes: 10 })
  const oversized = queue.enqueue(1, 50)!
  await started.promise
  const admission = queue.enqueue(2, 1)!
  assert.deepEqual(queue.pending, { items: 1, bytes: 50 })
  const disposed = queue.dispose()
  await oversized; await admission; gate.resolve(); await disposed
  assert.deepEqual(seen, [1]); assert.deepEqual(queue.pending, { items: 0, bytes: 0 })
})

test('byte capacity pauses admission before the item limit and preserves the waiting event ahead of controls', async () => {
  const gate = deferred(), started = deferred(), seen: string[] = []
  const queue = new SourceEventQueue<string>(async value => { seen.push(value); if (value === 'first') { started.resolve(); await gate.promise } },
    () => false, error => { throw error }, () => {}, { maxItems: 128, maxBytes: 10 })
  queue.enqueue('first', 6); await started.promise
  let admitted = false
  const next = queue.enqueue('second', 6)!.then(() => { admitted = true })
  const operation = queue.run(async () => { seen.push('control') })
  await Promise.resolve()
  assert.equal(admitted, false); assert.deepEqual(queue.pending, { items: 1, bytes: 6 })
  gate.resolve(); await next; await operation; await queue.settled()
  assert.deepEqual(seen, ['first', 'second', 'control']); await queue.dispose()
})

for (const kind of ['native', 'observed'] as const) {
  test(`${kind} explicit reconciliation is an ordered barrier and a later running-operation request remains distinct`, async () => {
    const fixture = await sourceQueueFixture(kind), eventGate = deferred(), eventStarted = deferred(), reconcileGate = deferred(), reconcileStarted = deferred()
    const seen: string[] = []
    fixture.agent.handleEvent = async event => {
      if (event.type !== 'message-received') return
      seen.push(event.message.id)
      if (seen.length === 1) { eventStarted.resolve(); await eventGate.promise }
    }
    let checks = 0
    fixture.agent.refresh = async () => {
      checks++; seen.push(`reconcile-${checks}`)
      if (checks === 1) { reconcileStarted.resolve(); await reconcileGate.promise }
    }
    try {
      fixture.emit(cumulativeEvent(1)); await eventStarted.promise
      fixture.emit(cumulativeEvent(2))
      const first = fixture.service.reconcileSource(fixture.source.id)
      assert.equal(fixture.service.reconcileSource(fixture.source.id), first)
      fixture.emit(cumulativeEvent(3))
      eventGate.resolve(); await reconcileStarted.promise
      const second = fixture.service.reconcileSource(fixture.source.id)
      assert.notEqual(second, first)
      reconcileGate.resolve(); await first; await second; await fixture.service.settled()
      assert.deepEqual(seen, ['transport-item-1', 'transport-item-2', 'reconcile-1', 'transport-item-3', 'reconcile-2'])
    } finally { eventGate.resolve(); reconcileGate.resolve(); await fixture.close() }
  })

  test(`${kind} real service retains item order and durable/receipt/lifecycle barriers during coalescing`, async () => {
    const fixture = await sourceQueueFixture(kind), gate = deferred(), started = deferred(), seen: HapiEvent[] = []
    fixture.agent.handleEvent = async event => { seen.push(event); if (seen.length === 1) { started.resolve(); await gate.promise } }
    try {
      fixture.emit(cumulativeEvent(1)); await started.promise
      fixture.emit(cumulativeEvent(2)); fixture.emit(cumulativeEvent(3))
      fixture.emit(cumulativeEvent(1, 4, 'other'))
      fixture.emit(cumulativeEvent(4))
      const final = cumulativeEvent(5); final.message.localId = 'item'; fixture.emit(final)
      for (const event of [
        { type: 'messages-consumed', sessionId: fixture.source.id, localIds: ['input'], invokedAt: 10 },
        { type: 'message-cancelled', sessionId: fixture.source.id, messageId: 'cancelled', localId: 'cancelled' },
        { type: 'session-ended', sessionId: fixture.source.id },
      ] satisfies HapiEvent[]) fixture.emit(event)
      gate.resolve(); await fixture.service.settled()
      assert.deepEqual(seen.map(event => event.type === 'message-received' ? event.message.id : event.type),
        ['transport-item-1', 'transport-item-3', 'transport-other-1', 'transport-item-4', 'transport-item-5', 'messages-consumed', 'message-cancelled', 'session-ended'])
    } finally { gate.resolve(); await fixture.close() }
  })

  test(`${kind} real service pauses noncoalescible events and requests one authoritative recovery after drain`, async () => {
    const fixture = await sourceQueueFixture(kind), gate = deferred(), started = deferred()
    const received: string[] = []; let recovery = 0, produced = 0
    fixture.agent.requestHistorySync = () => { recovery++ }
    fixture.agent.handleEvent = async event => {
      received.push(event.type === 'message-cancelled' ? event.messageId : event.type)
      if (received.length === 1) { started.resolve(); await gate.promise }
    }
    try {
      const producer = (async () => {
        for (let index = 0; index < 256; index++) {
          produced++
          await fixture.emit({ type: 'message-cancelled', sessionId: fixture.source.id, messageId: String(index) })
        }
      })()
      await started.promise
      // Let the producer reach backpressure without advancing the consumer.
      for (let turn = 0; turn < 300; turn++) await Promise.resolve()
      assert.equal(produced, 128)
      gate.resolve(); await producer; await fixture.service.settled()
      assert.deepEqual(received, Array.from({ length: 256 }, (_, index) => String(index)))
      assert.equal(recovery, 1)
    } finally { gate.resolve(); await fixture.close() }
  })
}
