import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourceQueueFixture } from './fixtures/source-event-queue.js'

for (const kind of ['native', 'observed'] as const) {
  test(`${kind} display lease retires only after the final browser reference and reopens as a new generation`, async () => {
    const fixture = await sourceQueueFixture(kind)
    try {
      const sourceId = fixture.source.id
      const first = fixture.service.byHapiSession(sourceId)
      assert.ok(first)
      await fixture.service.acquireDisplayLease(sourceId, 'pane-a')
      await fixture.service.acquireDisplayLease(sourceId, 'warm-a')
      assert.equal(fixture.service.byHapiSession(sourceId), first)
      assert.equal(await fixture.service.releaseDisplayLease(sourceId, 'pane-a'), false)
      await fixture.service.releaseDisplay(sourceId)
      assert.equal(fixture.service.byHapiSession(sourceId), first, 'one live reference must keep the display')
      assert.equal(await fixture.service.releaseDisplayLease(sourceId, 'warm-a'), false)
      assert.equal(await fixture.service.releaseDisplay(sourceId), true)
      assert.equal(fixture.service.byHapiSession(sourceId), undefined)
      assert.equal(fixture.service.list().length, 0)

      // Reopening must re-read the source as a fresh display generation; the
      // old Session/event namespace is never reused.
      const reopened = await fixture.service.openSource(sourceId)
      assert.ok(reopened)
      assert.notEqual(reopened.id, first.id)
      assert.equal(fixture.service.byHapiSession(sourceId), reopened)
    } finally { await fixture.close() }
  })

  test(`${kind} expired browser lease releases a vanished page without touching source execution`, async () => {
    const fixture = await sourceQueueFixture(kind)
    try {
      const sourceId = fixture.source.id
      await fixture.service.acquireDisplayLease(sourceId, 'vanished', 1_000)
      await fixture.service.expireDisplayLeases()
      assert.ok(fixture.service.byHapiSession(sourceId), 'ttl has not elapsed')
      await new Promise(resolve => setTimeout(resolve, 1_050))
      assert.deepEqual(await fixture.service.expireDisplayLeases(), [sourceId])
      assert.equal(await fixture.service.releaseDisplay(sourceId), true)
      assert.equal(fixture.service.byHapiSession(sourceId), undefined)
    } finally { await fixture.close() }
  })
}
