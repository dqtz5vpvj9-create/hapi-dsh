import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry, { type ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { hapiProjectionDefinition } from '../src/codex/projection-state.ts'
import { hapiProjectionSchema, hapiProjectionViewSchema, type HapiProjection, type HapiProjectionState } from '../src/codex/projection-types.ts'

function fixture(): NonNullable<HapiProjectionState> {
  return hapiProjectionSchema.parse({
    engine: 'codex', hubId: 'fixture-hub', hapiSessionId: 'fixture-source', logicalSessionId: 'fixture-display', displayRevision: 0,
    machineId: null, machineName: null, nativeId: 'fixture-thread', nativeHome: null, nativeConnection: 'attached', readOnly: false,
    model: 'fixture-model', reasoningEffort: 'high', error: null,
    execution: { owner: 'codex', generation: 'fixture-generation', sequence: 1, status: 'idle', waitingOn: [], turnId: null, startedAt: null, completedAt: null },
    notices: [{ id: 'fixture-notice', kind: 'message', createdAt: 1, text: 'Synthetic notice', details: 'notice '.repeat(1000), turnId: null }],
    pendingRequests: [{ requestId: 'fixture-approval', tool: 'fixture', toolCallId: null, arguments: { command: 'command '.repeat(2000) },
      blocking: true, createdAt: 1, stage: 'pending', error: null }], resolvedRequests: [],
    delivery: [{ localId: 'fixture-delivery', messageId: 'fixture-message', text: 'queued '.repeat(2000), mode: 'queue', state: 'queued', createdAt: 1, error: null }],
  })!
}

/** Protocol inputs are synthetic; Session, projection drive and publication
 * gates below are the actual pinned official packages, without browser mocks. */
async function harness(definition: ProjectionDefinition<'hapi'> & { wire: NonNullable<ProjectionDefinition<'hapi'>['wire']> }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(definition)
  const session = ctx.sessions.create(SessionId('projection-wire-fixture'))
  const notifications: HapiProjection[] = []
  const stop = ctx.sessionProjections.onChanged((target, key, value) => {
    if (target === session && key === 'hapi') notifications.push(value as HapiProjection)
  })
  return { ctx, session, notifications, async close() { stop(); await ctx.fiber.dispose() } }
}

test('official registry suppresses only Host execution sequence churn: old and new wire publication benchmark', async t => {
  const source = fixture()
  const definitions = {
    before: { ...hapiProjectionDefinition, wire: { viewSchema: hapiProjectionSchema, view: (state: HapiProjectionState) => state } },
    after: hapiProjectionDefinition,
  }
  const results: Record<string, { notifications: number; decodedBytes: number; retainedExecutionEvents: number }> = {}
  for (const [name, definition] of Object.entries(definitions)) {
    const app = await harness(definition)
    try {
      appendPluginRecord(app.session, 'plugin:hapi-dsh/state', source)
      app.notifications.length = 0
      const start = app.session.seq
      for (let sequence = 2; sequence <= 101; sequence++) {
        appendPluginRecord(app.session, 'plugin:hapi-dsh/execution', { ...source.execution!, sequence })
      }
      const state = app.ctx.sessionProjections.stateOf(app.session, 'hapi')
      assert.equal(state?.execution?.sequence, 101, 'the Host retains the latest exact source sequence')
      assert.deepEqual(state?.delivery, source.delivery)
      assert.deepEqual(state?.pendingRequests, source.pendingRequests)
      assert.deepEqual(state?.notices, source.notices)
      const snapshot = app.ctx.sessionProjections.snapshot(app.session)
      assert.equal(snapshot.asOfSeq, app.session.seq - 1, 'the official watermark still advances')
      if (name === 'after') assert.equal(Object.hasOwn(snapshot.values.hapi!.execution!, 'sequence'), false)
      results[name] = { notifications: app.notifications.length,
        decodedBytes: app.notifications.reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0),
        retainedExecutionEvents: app.session.snapshotEvents().filter(event => event.seq >= start && pluginRecordOf(event)?.type === 'plugin:hapi-dsh/execution').length }
    } finally { await app.close() }
  }
  assert.equal(results.before!.notifications, 100)
  assert.ok(results.before!.decodedBytes > 3_000_000)
  assert.deepEqual(results.after, { notifications: 0, decodedBytes: 0, retainedExecutionEvents: 100 })
  t.diagnostic(`Decoded projection payload only, excludes unchanged event frames and transport compression: ${JSON.stringify(results)}`)
})

test('real execution, queue, approval and notice changes still publish complete current values', async () => {
  const app = await harness(hapiProjectionDefinition), source = fixture()
  try {
    appendPluginRecord(app.session, 'plugin:hapi-dsh/state', source)
    app.notifications.length = 0
    const execution = { ...source.execution!, sequence: 2, status: 'active' as const, turnId: 'next-turn', startedAt: 10 }
    appendPluginRecord(app.session, 'plugin:hapi-dsh/execution', execution)
    assert.equal(app.notifications.length, 1)
    assert.equal(app.notifications.at(-1)?.execution?.status, 'active')
    assert.equal(app.notifications.at(-1)?.execution?.turnId, 'next-turn')
    assert.deepEqual(app.notifications.at(-1)?.delivery, source.delivery)
    appendPluginRecord(app.session, 'plugin:hapi-dsh/execution', { ...execution, sequence: 3, waitingOn: ['approval'] })
    assert.equal(app.notifications.length, 2)
    assert.deepEqual(app.notifications.at(-1)?.execution?.waitingOn, ['approval'])
    appendPluginRecord(app.session, 'plugin:hapi-dsh/execution', { ...execution, sequence: 4, waitingOn: ['approval'], turnId: 'third-turn' })
    assert.equal(app.notifications.length, 3)
    assert.equal(app.notifications.at(-1)?.execution?.turnId, 'third-turn')
    appendPluginRecord(app.session, 'plugin:hapi-dsh/execution', { ...execution, sequence: 5, waitingOn: ['approval'], turnId: 'third-turn', status: 'idle' })
    assert.equal(app.notifications.length, 4)
    assert.equal(app.notifications.at(-1)?.execution?.status, 'idle')
    const { execution: _execution, notices: _notices, ...sessionState } = source
    appendPluginRecord(app.session, 'plugin:hapi-dsh/session-state', { ...sessionState, delivery: [] })
    assert.equal(app.notifications.length, 5)
    assert.deepEqual(app.notifications.at(-1)?.delivery, [])
    assert.equal(app.notifications.at(-1)?.pendingRequests.length, 1)
    appendPluginRecord(app.session, 'plugin:hapi-dsh/session-state', { ...sessionState, delivery: [], pendingRequests: [],
      resolvedRequests: [{ requestId: 'fixture-approval', status: 'approved', completedAt: 20 }] })
    assert.equal(app.notifications.length, 6)
    assert.deepEqual(app.notifications.at(-1)?.pendingRequests, [])
    assert.equal(app.notifications.at(-1)?.resolvedRequests[0]?.status, 'approved')
    appendPluginRecord(app.session, 'plugin:hapi-dsh/notices', [])
    assert.equal(app.notifications.length, 7)
    assert.deepEqual(app.notifications.at(-1)?.notices, [])
    appendPluginRecord(app.session, 'plugin:hapi-dsh/execution', null)
    assert.equal(app.notifications.length, 8)
    assert.equal(app.notifications.at(-1)?.execution, null)
    assert.equal(app.ctx.sessionProjections.stateOf(app.session, 'hapi')?.execution, null)
    assert.deepEqual(app.notifications.at(-1), app.ctx.sessionProjections.snapshot(app.session).values.hapi)
  } finally { await app.close() }
})

test('new client view accepts old Host sequence while Host log validation remains strict', () => {
  const source = fixture(), view = hapiProjectionDefinition.wire.view(source)
  assert.equal(hapiProjectionViewSchema.parse(source)?.execution?.sequence, 1)
  assert.equal(Object.hasOwn(view!.execution!, 'sequence'), false)
  assert.equal(hapiProjectionSchema.safeParse(view).success, false)
  assert.equal(source.execution?.sequence, 1)
})
