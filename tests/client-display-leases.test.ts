import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDisplayLeaseRegistry } from '../src/client/surface/display-leases.ts'

test('display lease keeps one Host lease until every pane and warm reference releases it', async () => {
  const actions: string[] = []
  const registry = createDisplayLeaseRegistry({
    async sourceDisplayLease(request) {
      actions.push(`${request.action}:${request.sourceSessionId}:${request.leaseId}`)
      return { ok: true, value: { released: false } } as never
    },
  })
  try {
    registry.remember('display-1', { hubId: 'hub', sourceSessionId: 'source-1' })
    registry.retain('display-1')
    registry.retain('display-1')
    await registry.flush()
    assert.equal(actions.length, 1)
    assert.match(actions[0]!, /^acquire:source-1:/)
    registry.release('display-1')
    await registry.flush()
    assert.equal(actions.length, 1, 'one reader remains; the Host lease must stay live')
    registry.release('display-1')
    await registry.flush()
    assert.equal(actions.length, 2)
    assert.match(actions[1]!, /^release:source-1:/)
    assert.equal(actions[0]!.split(':')[2], actions[1]!.split(':')[2], 'the release names the acquired lease')
  } finally { registry.dispose() }
})

test('a late acquire failure is reported once and never leaves an unhandled rejection', async () => {
  const errors: unknown[] = []
  const registry = createDisplayLeaseRegistry({
    async sourceDisplayLease() { return { ok: false, error: new Error('offline') } as never },
  }, error => errors.push(error))
  registry.remember('display-2', { hubId: 'hub', sourceSessionId: 'source-2' })
  registry.retain('display-2')
  await registry.flush()
  assert.equal(errors.length, 1)
  registry.dispose()
})
